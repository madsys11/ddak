// 폰에 보내는 Web Push (docs/mobile-plan.md "푸시 알림"). 우리 서버 없이 맥이 폰의 푸시 서비스(FCM 등)로 바로 보낸다.
//
// - 구독(푸시 서비스 주소 + 폰의 암호화 키)과 VAPID 키 쌍은 폰이 만들어 페어링한 맥마다 넘긴다 (mobile.rs /api/push).
//   VAPID 키는 폰마다 하나라 여러 맥이 같은 키로 보낸다 (RFC 8292와 충돌하지 않는다). 저장소·번들에 키가 없다.
// - 본문은 폰의 키로 암호화한다 (RFC 8291 aes128gcm): 푸시 서비스는 내용을 읽지 못한다.
// - 서명(RFC 8292): aud = 푸시 서비스 주소의 출처, sub = 폰 화면 주소, 12시간짜리 ES256 JWT.

use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use sha2::Sha256;

// 레코드 크기 (한 레코드에 다 담는다)
const RECORD: usize = 4096;
// 평문 상한: 푸시 서비스가 받는 본문 4096바이트 = 머리 86 + 평문 + 구분 1 + 태그 16 (RFC 8291 4절, 리뷰 R5)
const MAX_PLAINTEXT: usize = 3993;
// 폰이 꺼져 있으면 푸시 서비스가 이만큼 들고 있다가 준다
const TTL: Duration = Duration::from_secs(24 * 3600);

// 폰이 넘긴 구독. 키는 모두 base64url (패딩 없음).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub endpoint: String,
    // 폰의 암호화 공개 키 (P-256, 비압축 65바이트)와 인증 비밀 (16바이트)
    pub p256dh: String,
    pub auth: String,
    // VAPID 키 쌍 (공개 키 65바이트, 개인 키 32바이트)
    pub public_key: String,
    pub private_key: String,
}

impl Subscription {
    // 받은 값이 쓸 수 있는지 (키 모양, 주소). 주소는 HTTPS만 (시험용으로 루프백 HTTP는 받는다)
    pub fn check(&self) -> Result<(), String> {
        let u = url::Url::parse(&self.endpoint).map_err(|_| "endpoint")?;
        let loopback = u.scheme() == "http" && u.host_str() == Some("127.0.0.1");
        if u.scheme() != "https" && !loopback {
            return Err("endpoint".into());
        }
        PublicKey::from_sec1_bytes(&decode(&self.p256dh)?).map_err(|_| "p256dh")?;
        if decode(&self.auth)?.len() != 16 {
            return Err("auth".into());
        }
        let key = SigningKey::from_slice(&decode(&self.private_key)?).map_err(|_| "privateKey")?;
        // 공개 키가 개인 키의 짝이어야 푸시 서비스가 받는다
        if key.verifying_key().to_encoded_point(false).as_bytes() != decode(&self.public_key)?.as_slice() {
            return Err("publicKey".into());
        }
        Ok(())
    }
}

fn decode(s: &str) -> Result<Vec<u8>, String> {
    B64.decode(s.trim_end_matches('=')).map_err(|_| "base64".to_string())
}

fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    unsafe { libc::arc4random_buf(bytes.as_mut_ptr().cast(), N) };
    bytes
}

// 한 번 쓰고 버리는 키 (32바이트 난수가 P-256 범위 밖이면 다시)
fn ephemeral() -> SecretKey {
    loop {
        if let Ok(key) = SecretKey::from_slice(&random::<32>()) {
            return key;
        }
    }
}

// RFC 8291: 폰의 공개 키(ua_public)와 인증 비밀(auth)로 본문을 암호화한 aes128gcm 본문
pub fn encrypt(ua_public: &[u8], auth: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    encrypt_with(ua_public, auth, plaintext, &ephemeral(), &random::<16>())
}

fn encrypt_with(ua_public: &[u8], auth: &[u8], plaintext: &[u8], as_secret: &SecretKey, salt: &[u8; 16]) -> Result<Vec<u8>, String> {
    if plaintext.len() > MAX_PLAINTEXT {
        return Err("payload too large".into());
    }
    let ua = PublicKey::from_sec1_bytes(ua_public).map_err(|_| "p256dh")?;
    let as_public = as_secret.public_key().to_encoded_point(false);
    let shared = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua.as_affine());
    let expand = |salt: &[u8], ikm: &[u8], info: &[u8], out: &mut [u8]| Hkdf::<Sha256>::new(Some(salt), ikm).expand(info, out).map_err(|e| e.to_string());
    // 키 정보 = "WebPush: info" 0 || 폰 공개 키 || 맥 공개 키
    let mut info = b"WebPush: info\0".to_vec();
    info.extend_from_slice(ua_public);
    info.extend_from_slice(as_public.as_bytes());
    let mut ikm = [0u8; 32];
    expand(auth, shared.raw_secret_bytes(), &info, &mut ikm)?;
    let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
    expand(salt, &ikm, b"Content-Encoding: aes128gcm\0", &mut cek)?;
    expand(salt, &ikm, b"Content-Encoding: nonce\0", &mut nonce)?;
    // 마지막 레코드 표시 (0x02), 채움 없음
    let mut record = plaintext.to_vec();
    record.push(2);
    let sealed = Aes128Gcm::new_from_slice(&cek).map_err(|e| e.to_string())?.encrypt(Nonce::from_slice(&nonce), record.as_slice()).map_err(|e| e.to_string())?;
    // 머리: salt || 레코드 크기 || 키 id 길이 || 키 id(맥 공개 키)
    let mut out = salt.to_vec();
    out.extend_from_slice(&(RECORD as u32).to_be_bytes());
    out.push(as_public.as_bytes().len() as u8);
    out.extend_from_slice(as_public.as_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

// RFC 8292 Authorization 헤더: "vapid t=<JWT>, k=<공개 키>". now: 초
pub fn vapid(endpoint: &str, public_key: &str, private_key: &str, subject: &str, now: u64) -> Result<String, String> {
    let u = url::Url::parse(endpoint).map_err(|_| "endpoint")?;
    let aud = u.origin().ascii_serialization();
    let key = SigningKey::from_slice(&decode(private_key)?).map_err(|_| "privateKey")?;
    let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = B64.encode(serde_json::json!({ "aud": aud, "exp": now + 12 * 3600, "sub": subject }).to_string());
    let input = format!("{header}.{claims}");
    let signature: Signature = key.sign(input.as_bytes());
    Ok(format!("vapid t={input}.{}, k={public_key}", B64.encode(signature.to_bytes())))
}

pub enum Sent {
    Ok,
    // 구독이 없어짐 (404·410): 지운다
    Gone,
    Failed(String),
}

// 보낸다 (기다린다. 부르는 쪽이 스레드를 따로 둔다). subject: VAPID sub (폰 화면 주소)
pub fn send(sub: &Subscription, payload: &[u8], subject: &str) -> Sent {
    let run = || -> Result<Sent, String> {
        let body = encrypt(&decode(&sub.p256dh)?, &decode(&sub.auth)?, payload)?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let auth = vapid(&sub.endpoint, &sub.public_key, &sub.private_key, subject, now)?;
        let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
        let r = client
            .post(&sub.endpoint)
            .header("TTL", TTL.as_secs().to_string())
            .header("Urgency", "high")
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .header("Authorization", auth)
            .body(body)
            .send()
            .map_err(|e| e.to_string())?;
        let status = r.status().as_u16();
        Ok(match status {
            200..=299 => Sent::Ok,
            404 | 410 => Sent::Gone,
            _ => Sent::Failed(format!("{status} {}", r.text().unwrap_or_default().chars().take(200).collect::<String>())),
        })
    };
    run().unwrap_or_else(Sent::Failed)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use p256::ecdsa::VerifyingKey;
    use p256::ecdsa::signature::Verifier;

    // 폰 쪽: 받은 aes128gcm 본문을 푼다 (시험에서 맥이 보낸 것을 확인하려고)
    pub fn decrypt(ua_secret: &SecretKey, auth: &[u8], body: &[u8]) -> Vec<u8> {
        let salt = &body[..16];
        let idlen = body[20] as usize;
        let as_public = PublicKey::from_sec1_bytes(&body[21..21 + idlen]).unwrap();
        let shared = p256::ecdh::diffie_hellman(ua_secret.to_nonzero_scalar(), as_public.as_affine());
        let mut info = b"WebPush: info\0".to_vec();
        info.extend_from_slice(ua_secret.public_key().to_encoded_point(false).as_bytes());
        info.extend_from_slice(&body[21..21 + idlen]);
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes()).expand(&info, &mut ikm).unwrap();
        let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
        Hkdf::<Sha256>::new(Some(salt), &ikm).expand(b"Content-Encoding: aes128gcm\0", &mut cek).unwrap();
        Hkdf::<Sha256>::new(Some(salt), &ikm).expand(b"Content-Encoding: nonce\0", &mut nonce).unwrap();
        let mut plain = Aes128Gcm::new_from_slice(&cek).unwrap().decrypt(Nonce::from_slice(&nonce), &body[21 + idlen..]).unwrap();
        assert_eq!(plain.pop(), Some(2));
        plain
    }

    // VAPID JWT를 공개 키로 확인하고 클레임을 돌려준다
    pub fn verify_vapid(header: &str, public_key: &str) -> serde_json::Value {
        let rest = header.strip_prefix("vapid t=").unwrap();
        let (jwt, k) = rest.split_once(", k=").unwrap();
        assert_eq!(k, public_key);
        let (input, sig) = jwt.rsplit_once('.').unwrap();
        let key = VerifyingKey::from_sec1_bytes(&decode(public_key).unwrap()).unwrap();
        key.verify(input.as_bytes(), &Signature::from_slice(&decode(sig).unwrap()).unwrap()).unwrap();
        serde_json::from_slice(&decode(input.split_once('.').unwrap().1).unwrap()).unwrap()
    }

    // 시험용 구독 (폰의 암호화 비밀 키와 함께)
    pub fn subscription(endpoint: &str) -> (Subscription, SecretKey, Vec<u8>) {
        let ua = ephemeral();
        let auth = random::<16>().to_vec();
        let vapid = ephemeral();
        let sub = Subscription {
            endpoint: endpoint.into(),
            p256dh: B64.encode(ua.public_key().to_encoded_point(false).as_bytes()),
            auth: B64.encode(&auth),
            public_key: B64.encode(vapid.public_key().to_encoded_point(false).as_bytes()),
            private_key: B64.encode(vapid.to_bytes()),
        };
        (sub, ua, auth)
    }

    // RFC 8291 부록 A의 예와 같은 결과
    #[test]
    fn encrypts_like_rfc8291() {
        let d = |s: &str| decode(s).unwrap();
        let as_secret = SecretKey::from_slice(&d("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let salt: [u8; 16] = d("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let ua_public = d("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        let auth = d("BTBZMqHH6r4Tts7J_aSIgg");
        let body = encrypt_with(&ua_public, &auth, b"When I grow up, I want to be a watermelon", &as_secret, &salt).unwrap();
        assert_eq!(
            B64.encode(&body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
        // 폰의 비밀 키로 풀린다
        let ua_secret = SecretKey::from_slice(&d("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")).unwrap();
        assert_eq!(decrypt(&ua_secret, &auth, &body), b"When I grow up, I want to be a watermelon");
        // 전체 본문이 4096바이트를 넘지 않는 평문까지만
        assert_eq!(encrypt(&ua_public, &auth, &[b'x'; MAX_PLAINTEXT]).unwrap().len(), 4096);
        assert!(encrypt(&ua_public, &auth, &[b'x'; MAX_PLAINTEXT + 1]).is_err());
    }

    #[test]
    fn signs_vapid_and_checks_subscription() {
        let (sub, _, _) = subscription("https://fcm.googleapis.com/fcm/send/abc");
        sub.check().unwrap();
        let header = vapid(&sub.endpoint, &sub.public_key, &sub.private_key, "https://screen.example/app/", 1000).unwrap();
        let claims = verify_vapid(&header, &sub.public_key);
        assert_eq!(claims, serde_json::json!({ "aud": "https://fcm.googleapis.com", "exp": 1000 + 12 * 3600, "sub": "https://screen.example/app/" }));
        // 짝이 아닌 공개 키, 이상한 주소, 잘못된 키는 받지 않는다
        let (other, _, _) = subscription("https://x.example/");
        assert_eq!(Subscription { public_key: other.public_key, ..sub.clone() }.check().unwrap_err(), "publicKey");
        assert!(Subscription { endpoint: "http://evil.example/".into(), ..sub.clone() }.check().is_err());
        assert!(Subscription { endpoint: "http://127.0.0.1:9/".into(), ..sub.clone() }.check().is_ok());
        assert!(Subscription { p256dh: "AAAA".into(), ..sub.clone() }.check().is_err());
        assert!(Subscription { auth: B64.encode([0u8; 8]), ..sub }.check().is_err());
    }
}
