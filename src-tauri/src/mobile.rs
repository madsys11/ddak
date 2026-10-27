// 모바일 연결 (docs/mobile-plan.md, docs/spec.md "모바일"). 폰의 화면(고정 주소의 PWA)이 이 맥의 채팅을 읽고 보낸다.
//
// - 127.0.0.1의 고정 포트에만 묶는다. 밖에서는 `tailscale serve`(HTTPS, 신원 헤더 Tailscale-User-Login)를 거쳐서만 들어온다.
//   MCP 서버(chat.rs)와 인증 모델이 달라서 리스너를 따로 둔다. 기본은 꺼짐 ("모바일 연결…" 창에서 켠다).
// - 요청 검사 순서: 모든 요청에 Host (이 맥의 *.ts.net 이름, 127.0.0.1·localhost:포트). OPTIONS(CORS 미리 보내기)는
//   Origin·메서드·헤더만 보고 데이터 없이 답한다. 나머지는 Origin(화면 주소) + Tailscale 신원(이 맥의 로그인과 같음)이
//   맞아야 하고, /api/pair는 1회용 페어링 코드, 그 밖에는 기기 토큰(Bearer)으로 인증한다.
// - 기기 토큰은 해시만 앱 데이터 mobile/devices.json에 둔다. 실패(코드·토큰)가 1분에 FAIL_LIMIT번을 넘으면 그 1분 동안 막는다.
// - 새 메시지·참여자 변화는 /api/events(SSE)로 보낸다. 폰은 이벤트를 받으면 보고 있는 것을 다시 읽는다 (재생은 하지 않는다).
// - 맥이 사용자에게 알릴 때(notify.rs) 푸시 구독이 있는 기기마다 Web Push도 보낸다 (push.rs). 폰이 그 채팅을 보고 있으면
//   폰의 서비스 워커가 알림을 띄우지 않는다 (docs/mobile-plan.md "2단계 세부").

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::chat::{Chats, USER};
use crate::push::{self, Subscription};

// 폰 화면이 아는 API 버전 (모르는 버전이면 화면이 "ddak 업데이트 필요"로 보인다)
pub const API_VERSION: u32 = 1;
const DEFAULT_PORT: u16 = 47320;
// 폰 화면의 공식 주소 (D7). CORS 허용 출처는 여기서 정한다.
pub const DEFAULT_SCREEN: &str = "https://madsys11.github.io/ddak/";
const CODE_TTL: Duration = Duration::from_secs(5 * 60);
// 1분에 이만큼 실패하면 그 1분이 끝날 때까지 페어링·토큰 인증을 받지 않는다
const FAIL_LIMIT: u32 = 10;
const FAIL_WINDOW: Duration = Duration::from_secs(60);
// SSE 연결 수 (폰 1~2대. 넘으면 가장 오래된 것을 끊는다)
const MAX_STREAMS: usize = 8;
// SSE 한 연결에 쌓아 둘 이벤트 수. 넘으면 (폰이 받지 못하고 있음) 그 연결을 끊는다: 폰은 다시 이을 때 다시 읽는다.
const STREAM_QUEUE: usize = 64;
// SSE가 살아 있는지 보려고 이 간격으로 주석 줄을 보낸다
const PING: Duration = Duration::from_secs(25);
const ALLOW_HEADERS: [&str; 2] = ["authorization", "content-type"];
const TAILSCALE_CLI: [&str; 3] = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"];

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub enabled: bool,
    pub port: u16,
    // 폰 화면 주소 (QR 링크, CORS 허용 출처)
    pub screen: String,
    // 폰에 보일 이 컴퓨터의 이름
    pub name: String,
    // 설치마다 한 번 만드는 컴퓨터 id (이름이 바뀌어도 같은 컴퓨터로 본다)
    pub id: String,
}

impl Default for Config {
    fn default() -> Self {
        Config { enabled: false, port: DEFAULT_PORT, screen: DEFAULT_SCREEN.into(), name: String::new(), id: String::new() }
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    name: String,
    // 토큰의 SHA-256 (hex)
    hash: String,
    // 페어링한 Tailscale 로그인 (요청마다 같아야 한다)
    login: String,
    created: u64,
    // 마지막 사용 (메모리에서 갱신하고 기기 목록을 저장할 때 같이 쓴다)
    used: u64,
    // Web Push 구독 (폰이 넘긴다, /api/push)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    push: Option<Subscription>,
    // 푸시 서비스가 없어졌다고 답한 구독 주소 (폰이 같은 구독을 다시 보내지 않고 다시 켜기를 보인다)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    push_gone: Option<String>,
}

// 이 맥의 Tailscale 신원: *.ts.net 이름과 로그인
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Identity {
    pub host: Option<String>,
    pub login: Option<String>,
}

// 이 서버가 읽는 앱의 나머지 (테스트에서 바꿔 끼운다)
pub struct Ctx {
    pub chats: Arc<Chats>,
    // 등록된 프로젝트 경로 (projects.json의 순서)
    pub projects: Box<dyn Fn() -> Vec<PathBuf> + Send + Sync>,
    // 그 프로젝트에서 깨우기를 기다리는 참여자
    pub waiting: Box<dyn Fn(&Path) -> Vec<String> + Send + Sync>,
    // 그 프로젝트 참여자의 상태: (이름, 사용자를 기다리는 종류 또는 "working") (pty.rs statuses)
    pub status: Box<dyn Fn(&Path) -> Vec<(String, String)> + Send + Sync>,
    // 그 프로젝트에 열린 선택 창 id (prompts.rs)
    pub prompts: Box<dyn Fn(&Path) -> Vec<String> + Send + Sync>,
    // 선택 창에 답한다: (프로젝트, 선택 창 id, 선택지, 기기 이름) (prompts.rs answer)
    pub answer: Box<dyn Fn(&Path, &str, usize, &str) -> Result<(), String> + Send + Sync>,
    // 앱 데이터 mobile 폴더
    pub dir: PathBuf,
}

#[derive(Default)]
struct State {
    config: Config,
    devices: Vec<Device>,
    // 지금 쓸 수 있는 페어링 코드와 만든 때
    code: Option<(String, Instant)>,
    // 실패 셈: (창이 시작된 때, 횟수)
    fails: Option<(Instant, u32)>,
    identity: Identity,
    server: Option<Arc<tiny_http::Server>>,
    // SSE 연결: (기기 id, 보낼 곳). 기기 연결을 끊으면 그 기기의 것도 닫는다.
    streams: Vec<(String, mpsc::SyncSender<String>)>,
    // 서버를 띄우지 못한 이유 (포트 사용 중, funnel 켜짐 등)
    error: Option<String>,
    // 자체 테스트: 보내지 않고 모은 푸시 (기기 이름, 내용)
    pushes: Vec<(String, Value)>,
}

pub struct Mobile {
    ctx: Ctx,
    state: Mutex<State>,
}

// 앱 상태 (채팅 서버가 없으면 None)
pub struct MobileState(pub Option<Arc<Mobile>>);

fn selftest() -> bool {
    std::env::var_os("DDAK_SELFTEST").is_some()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn random_hex(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    unsafe { libc::arc4random_buf(bytes.as_mut_ptr().cast(), bytes.len()) };
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

// 데스크톱 기기 목록에 보일 알림 상태: on, gone (푸시 서비스가 없앰), off
fn push_state(d: &Device) -> &'static str {
    if d.push.is_some() {
        "on"
    } else if d.push_gone.is_some() {
        "gone"
    } else {
        "off"
    }
}

// 6자리 숫자 코드 (폰에서 치기 쉽게. 5분 1회용 + 실패 제한)
fn new_code() -> String {
    format!("{:06}", unsafe { libc::arc4random_uniform(1_000_000) })
}

// 화면 주소의 출처 (scheme://host[:port])
pub fn origin_of(screen: &str) -> Option<String> {
    let u = url::Url::parse(screen).ok()?;
    let origin = u.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

// 프로젝트 id: 채팅 파일 이름과 같은 <이름>-<경로 해시> (URL에 경로를 싣지 않는다)
fn project_id(real: &Path) -> String {
    crate::worktrees::project_slug(real)
}

fn real(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            eprintln!("모바일 설정 파일이 깨짐 ({}): {e}", path.display());
            T::default()
        }),
        Err(_) => T::default(),
    }
}

// 임시 파일에 쓴 뒤 바꿔치기한다. 토큰 해시가 있으므로 나만 읽게 (0600).
fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).map_err(|e| e.to_string())?;
    f.write_all(&json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// 이 맥 이름 (폰에 보일 기본 이름)
fn host_name() -> String {
    let out = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => "Mac".into(),
    }
}

type Reply = tiny_http::Response<std::io::Cursor<Vec<u8>>>;

impl Mobile {
    pub fn new(ctx: Ctx) -> Arc<Mobile> {
        let mut config: Config = read_json(&ctx.dir.join("config.json"));
        let devices: Vec<Device> = read_json(&ctx.dir.join("devices.json"));
        let mut changed = false;
        if config.id.is_empty() {
            config.id = random_hex(8);
            changed = true;
        }
        if config.name.trim().is_empty() {
            config.name = host_name();
            changed = true;
        }
        if config.port == 0 {
            config.port = DEFAULT_PORT;
        }
        if changed {
            if let Err(e) = write_json(&ctx.dir.join("config.json"), &config) {
                eprintln!("모바일 설정을 쓰지 못함: {e}");
            }
        }
        Arc::new(Mobile { ctx, state: Mutex::new(State { config, devices, ..State::default() }) })
    }

    pub fn config(&self) -> Config {
        self.state.lock().unwrap().config.clone()
    }

    // 설정·기기 목록은 상태 잠금을 쥔 채 저장한다: 바꾼 순서와 디스크에 쓴 순서가 같아야 한다 (리뷰 R4: 늦은 저장이
    // 끊은 기기를 되살렸다). 같은 임시 파일을 동시에 쓰지도 않는다.
    fn save_config(&self, st: &State) -> Result<(), String> {
        write_json(&self.ctx.dir.join("config.json"), &st.config)
    }

    fn save_devices(&self, st: &State) -> Result<(), String> {
        write_json(&self.ctx.dir.join("devices.json"), &st.devices)
    }

    pub fn set_identity(&self, identity: Identity) {
        self.state.lock().unwrap().identity = identity;
    }

    pub fn running(&self) -> bool {
        self.state.lock().unwrap().server.is_some()
    }

    // 서버를 띄운다 (이미 떠 있으면 그대로). 실패하면 이유를 남기고 돌려준다.
    pub fn start(self: &Arc<Self>) -> Result<(), String> {
        let port = {
            let st = self.state.lock().unwrap();
            if st.server.is_some() {
                return Ok(());
            }
            st.config.port
        };
        let server = match tiny_http::Server::http(("127.0.0.1", port)) {
            Ok(s) => Arc::new(s),
            Err(e) => {
                let e = format!("127.0.0.1:{port}: {e}");
                self.state.lock().unwrap().error = Some(e.clone());
                return Err(e);
            }
        };
        {
            let mut st = self.state.lock().unwrap();
            st.server = Some(server.clone());
            st.error = None;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let me = me.clone();
                // 요청마다 따로 (SSE가 연결을 붙잡는다)
                std::thread::spawn(move || me.respond(request));
            }
        });
        Ok(())
    }

    // 서버를 멈춘다. SSE도 모두 끊는다 (보낼 곳이 사라지면 그 연결의 스레드가 끝난다).
    pub fn stop(&self) {
        let mut st = self.state.lock().unwrap();
        if let Some(server) = st.server.take() {
            server.unblock();
        }
        st.streams.clear();
    }

    // 실제 포트 (설정이 0이면 OS가 고른 것. 테스트용)
    pub fn port(&self) -> Option<u16> {
        let st = self.state.lock().unwrap();
        st.server.as_ref().and_then(|s| s.server_addr().to_ip()).map(|a| a.port())
    }

    // 켜고 끈다. 설정을 저장하지 못하면 오류. 서버를 띄우지 못한 이유는 상태(error)에 남긴다 (창이 설정과 같이 보이게).
    pub fn set_enabled(self: &Arc<Self>, enabled: bool) -> Result<(), String> {
        {
            let mut st = self.state.lock().unwrap();
            st.config.enabled = enabled;
            self.save_config(&st)?;
        }
        if enabled {
            let _ = self.start();
        } else {
            self.stop();
            self.state.lock().unwrap().error = None;
        }
        Ok(())
    }

    pub fn set_error(&self, error: Option<String>) {
        self.state.lock().unwrap().error = error;
    }

    pub fn error(&self) -> Option<String> {
        self.state.lock().unwrap().error.clone()
    }

    // 새 페어링 코드 (이전 코드는 버린다)
    pub fn pair_code(&self) -> String {
        let code = new_code();
        self.state.lock().unwrap().code = Some((code.clone(), Instant::now()));
        code
    }

    pub fn devices(&self) -> Vec<Value> {
        let st = self.state.lock().unwrap();
        st.devices.iter().map(|d| json!({ "id": d.id, "name": d.name, "created": d.created, "used": d.used, "push": push_state(d) })).collect()
    }

    // 기기 연결을 끊는다: 그 토큰은 더 쓰지 못하고, 열려 있는 SSE도 닫는다 (리뷰 R1)
    pub fn forget(&self, id: &str) -> Result<(), String> {
        let mut st = self.state.lock().unwrap();
        st.devices.retain(|d| d.id != id);
        st.streams.retain(|(device, _)| device != id);
        self.save_devices(&st)
    }

    // 이 기기의 푸시 구독을 바꾼다 (None: 지움). 저장하지 못하면 오류
    fn set_push(&self, device: &str, sub: Option<Subscription>) -> Result<(), String> {
        let mut st = self.state.lock().unwrap();
        let d = st.devices.iter_mut().find(|d| d.id == device).ok_or("token")?;
        d.push = sub;
        d.push_gone = None;
        self.save_devices(&st)
    }

    // 푸시 서비스가 그 구독이 없어졌다고 답했다: 아직 같은 구독이면 지우고 끊김으로 남긴다
    fn push_gone(&self, device: &str, endpoint: &str) {
        let mut st = self.state.lock().unwrap();
        let Some(d) = st.devices.iter_mut().find(|d| d.id == device && d.push.as_ref().is_some_and(|p| p.endpoint == endpoint)) else { return };
        d.push = None;
        d.push_gone = Some(endpoint.to_string());
        if let Err(e) = self.save_devices(&st) {
            eprintln!("모바일 기기 목록을 쓰지 못함: {e}");
        }
    }

    // 사용자에게 알린다 (notify.rs가 맥 배너와 같은 생략 조건을 본 뒤). 구독이 있는 기기마다 따로 보낸다 (기다리지 않는다).
    // 제목: <컴퓨터 이름> · <프로젝트>. 누르면 그 채팅을 연다 (폰 서비스 워커가 computer·project로 주소를 만든다).
    // kind: message·paused·attention (그 채팅을 보고 있는 폰이 무엇을 보인 뒤 알림을 닫을지 정한다)
    pub fn notify(self: &Arc<Self>, project: &Path, kind: &str, body: &str) {
        let (config, targets) = {
            let st = self.state.lock().unwrap();
            let targets: Vec<(String, String, Subscription)> = st.devices.iter().filter_map(|d| Some((d.id.clone(), d.name.clone(), d.push.clone()?))).collect();
            (st.config.clone(), targets)
        };
        if !config.enabled || targets.is_empty() {
            return;
        }
        let r = real(project);
        let id = project_id(&r);
        let name = self.projects().into_iter().find(|(p, _, _)| *p == id).map(|(_, n, _)| n).unwrap_or_else(|| r.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        let payload = json!({ "title": format!("{} · {name}", config.name), "body": body, "kind": kind, "computer": config.id, "project": id });
        for (device, device_name, sub) in targets {
            if selftest() {
                self.state.lock().unwrap().pushes.push((device_name, payload.clone()));
                continue;
            }
            let (me, payload, screen) = (self.clone(), payload.to_string(), config.screen.clone());
            std::thread::spawn(move || match push::send(&sub, payload.as_bytes(), &screen) {
                push::Sent::Ok => {}
                push::Sent::Gone => me.push_gone(&device, &sub.endpoint),
                push::Sent::Failed(e) => eprintln!("푸시 실패 ({device_name}): {e}"),
            });
        }
    }

    // 방에 생긴 일을 SSE로 보낸다. project: 채팅의 실제 경로 (없으면 모든 프로젝트에 해당)
    pub fn publish(&self, project: Option<&Path>, kind: &str, data: Value) {
        let mut data = data;
        if let (Some(p), Some(obj)) = (project, data.as_object_mut()) {
            obj.insert("project".into(), json!(project_id(p)));
        }
        let line = format!("event: {kind}\ndata: {data}\n\n");
        // 가득 찼거나 닫힌 연결은 뺀다 (보낼 곳이 사라지면 그 연결의 스레드가 끝난다)
        self.state.lock().unwrap().streams.retain(|(_, tx)| tx.try_send(line.clone()).is_ok());
    }

    // 실패를 센다 (FAIL_WINDOW 안에서)
    fn fail(&self) {
        let mut st = self.state.lock().unwrap();
        let now = Instant::now();
        let (start, n) = match st.fails {
            Some((start, n)) if now.duration_since(start) < FAIL_WINDOW => (start, n + 1),
            _ => (now, 1),
        };
        st.fails = Some((start, n));
    }

    fn blocked(&self) -> bool {
        let st = self.state.lock().unwrap();
        st.fails.is_some_and(|(start, n)| n >= FAIL_LIMIT && start.elapsed() < FAIL_WINDOW)
    }

    fn respond(&self, mut request: tiny_http::Request) {
        let header = |name: &str| request.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str().to_string());
        let (host, origin, login, auth) = (header("Host"), header("Origin"), header("Tailscale-User-Login"), header("Authorization"));
        let (config, identity) = {
            let st = self.state.lock().unwrap();
            (st.config.clone(), st.identity.clone())
        };
        let port = self.port().unwrap_or(config.port);
        let allowed = origin_of(&config.screen).unwrap_or_default();
        let cors = |r: Reply| {
            r.with_header(tiny_http::Header::from_bytes("Access-Control-Allow-Origin", allowed.as_bytes()).unwrap())
                .with_header("Vary: Origin".parse::<tiny_http::Header>().unwrap())
        };
        let reply = |code: u16, body: Value| {
            cors(tiny_http::Response::from_data(body.to_string().into_bytes()).with_status_code(code))
                .with_header("Content-Type: application/json".parse::<tiny_http::Header>().unwrap())
                .with_header("Cache-Control: no-store".parse::<tiny_http::Header>().unwrap())
        };

        // 1. Host: 이 맥의 tailnet 이름이나 루프백 (DNS 리바인딩)
        let host_ok = host.as_deref().is_some_and(|h| {
            identity.host.as_deref() == Some(h) || h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}")
        });
        if !host_ok {
            let _ = request.respond(tiny_http::Response::empty(421));
            return;
        }
        // 2. CORS 미리 보내기: 토큰이 실리지 않는다. 허용 출처·메서드·헤더만 보고 데이터 없이 답한다.
        if *request.method() == tiny_http::Method::Options {
            let method_ok = header("Access-Control-Request-Method").is_some_and(|m| m == "GET" || m == "POST" || m == "DELETE");
            let headers_ok = header("Access-Control-Request-Headers").unwrap_or_default().split(',').map(|h| h.trim().to_ascii_lowercase()).filter(|h| !h.is_empty()).all(|h| ALLOW_HEADERS.contains(&h.as_str()));
            if origin.as_deref() != Some(allowed.as_str()) || !method_ok || !headers_ok {
                let _ = request.respond(tiny_http::Response::empty(403));
                return;
            }
            let r = cors(tiny_http::Response::from_data(Vec::new()).with_status_code(204))
                .with_header("Access-Control-Allow-Methods: GET, POST, DELETE".parse::<tiny_http::Header>().unwrap())
                .with_header(tiny_http::Header::from_bytes("Access-Control-Allow-Headers", ALLOW_HEADERS.join(", ")).unwrap())
                .with_header("Access-Control-Max-Age: 600".parse::<tiny_http::Header>().unwrap());
            let _ = request.respond(r);
            return;
        }
        // 3. Origin + Tailscale 신원 (tailscale serve가 붙인다. 이 맥의 로그인과 같아야 한다)
        if origin.as_deref() != Some(allowed.as_str()) {
            let _ = request.respond(reply(403, json!({ "error": "origin" })));
            return;
        }
        let Some(my_login) = identity.login.clone() else {
            let _ = request.respond(reply(503, json!({ "error": "tailscale" })));
            return;
        };
        if login.as_deref() != Some(my_login.as_str()) {
            let _ = request.respond(reply(403, json!({ "error": "identity" })));
            return;
        }
        if self.blocked() {
            let _ = request.respond(reply(429, json!({ "error": "too many attempts" })));
            return;
        }

        let method = request.method().clone();
        let url = request.url().to_string();
        let (path, query) = url.split_once('?').unwrap_or((&url, ""));
        let path = path.to_string();
        let query = query.to_string();
        let mut body = String::new();
        if method == tiny_http::Method::Post && request.as_reader().take(64 * 1024).read_to_string(&mut body).is_err() {
            let _ = request.respond(reply(400, json!({ "error": "body" })));
            return;
        }
        let body: Value = if body.is_empty() { json!({}) } else { serde_json::from_str(&body).unwrap_or(Value::Null) };

        // 4. 페어링: 1회용 코드 → 기기 토큰
        if method == tiny_http::Method::Post && path == "/api/pair" {
            let (code, device) = (body.get("code").and_then(Value::as_str).unwrap_or(""), body.get("device").and_then(Value::as_str).unwrap_or(""));
            let token = self.pair(code, device, &my_login);
            let _ = request.respond(match token {
                Some((token, id)) => reply(200, json!({ "token": token, "device": id, "id": config.id, "name": config.name })),
                None => {
                    self.fail();
                    reply(401, json!({ "error": "code" }))
                }
            });
            return;
        }

        // 5. 그 밖에는 기기 토큰
        let device = auth.as_deref().and_then(|a| a.strip_prefix("Bearer ")).and_then(|t| self.device(t, &my_login));
        let Some(device) = device else {
            self.fail();
            let _ = request.respond(reply(401, json!({ "error": "token" })));
            return;
        };

        if method == tiny_http::Method::Get && path == "/api/events" {
            self.stream(request, &allowed, &device.id);
            return;
        }
        let (code, value) = self.route(&method, &path, &query, &body, &device, &config);
        let _ = request.respond(reply(code, value));
    }

    // 코드가 맞으면 새 기기를 만들고 (토큰, 기기 id). 코드는 맞든 틀리든 시간이 지났으면 버리고, 맞으면 버린다.
    fn pair(&self, code: &str, device: &str, login: &str) -> Option<(String, String)> {
        let mut st = self.state.lock().unwrap();
        let (expected, made) = st.code.clone()?;
        if made.elapsed() > CODE_TTL {
            st.code = None;
            return None;
        }
        if code.is_empty() || code != expected {
            return None;
        }
        st.code = None;
        let token = random_hex(32);
        let id = random_hex(6);
        let name: String = device.trim().chars().take(60).collect();
        let now = now_ms();
        st.devices.push(Device { id: id.clone(), name: if name.is_empty() { "phone".into() } else { name }, hash: hash(&token), login: login.to_string(), created: now, used: now, push: None, push_gone: None });
        if let Err(e) = self.save_devices(&st) {
            eprintln!("모바일 기기 목록을 쓰지 못함: {e}");
            // 저장하지 못한 토큰은 앱을 다시 켜면 사라진다. 그래도 이번 실행에서는 쓴다.
        }
        Some((token, id))
    }

    // 토큰의 기기 (로그인이 페어링 때와 같을 때만)
    fn device(&self, token: &str, login: &str) -> Option<Device> {
        let h = hash(token);
        let mut st = self.state.lock().unwrap();
        let d = st.devices.iter_mut().find(|d| d.hash == h && d.login == login)?;
        d.used = now_ms();
        Some(d.clone())
    }

    // 등록된 프로젝트: (id, 이름, 실제 경로)
    fn projects(&self) -> Vec<(String, String, PathBuf)> {
        let mut seen = std::collections::HashSet::new();
        (self.ctx.projects)()
            .into_iter()
            .filter_map(|p| {
                let r = real(&p);
                let id = project_id(&r);
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string());
                seen.insert(id.clone()).then_some((id, name, r))
            })
            .collect()
    }

    fn route(&self, method: &tiny_http::Method, path: &str, query: &str, body: &Value, device: &Device, config: &Config) -> (u16, Value) {
        use tiny_http::Method::{Delete, Get, Post};
        let chats = &self.ctx.chats;
        if *method == Get && path == "/api/info" {
            // push: 이 기기의 구독 주소와 끊긴 구독 주소 (폰이 자기 구독과 비교한다)
            let push = json!({ "endpoint": device.push.as_ref().map(|p| &p.endpoint), "gone": device.push_gone });
            return (200, json!({ "id": config.id, "name": config.name, "version": env!("CARGO_PKG_VERSION"), "api": API_VERSION, "push": push }));
        }
        if path == "/api/push" && (*method == Post || *method == Delete) {
            let sub = if *method == Post {
                match serde_json::from_value::<Subscription>(body.clone()).map_err(|_| "body".to_string()).and_then(|s| s.check().map(|()| s)) {
                    Ok(s) => Some(s),
                    Err(e) => return (400, json!({ "error": e })),
                }
            } else {
                None
            };
            return match self.set_push(&device.id, sub) {
                Ok(()) => (200, json!({})),
                Err(e) if e == "token" => (401, json!({ "error": e })),
                Err(e) => (500, json!({ "error": e })),
            };
        }
        if *method == Get && path == "/api/projects" {
            let list: Vec<Value> = self
                .projects()
                .into_iter()
                .map(|(id, name, r)| {
                    let sessions = chats.members(&r).len().saturating_sub(1);
                    // 사용자를 기다리는 세션 수 (권한 확인 등)
                    let awaiting = (self.ctx.status)(&r).iter().filter(|(_, s)| s != "working").count();
                    json!({ "id": id, "name": name, "sessions": sessions, "awaiting": awaiting, "paused": chats.paused(&r) })
                })
                .collect();
            return (200, json!({ "projects": list }));
        }
        // /api/projects/<id>/<무엇>
        let Some(rest) = path.strip_prefix("/api/projects/") else { return (404, json!({ "error": "not found" })) };
        let Some((id, what)) = rest.split_once('/') else { return (404, json!({ "error": "not found" })) };
        let Some((_, name, project)) = self.projects().into_iter().find(|(p, _, _)| p == id) else {
            return (404, json!({ "error": "project" }));
        };
        let param = |key: &str| query.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == key).and_then(|(_, v)| v.parse::<u64>().ok());
        match (method, what) {
            (Get, "messages") => match chats.messages(&project) {
                Ok(all) => {
                    let limit = param("limit").unwrap_or(50).clamp(1, 200) as usize;
                    let before: Vec<_> = all.into_iter().filter(|m| param("before").is_none_or(|b| m.id < b)).collect();
                    let start = before.len().saturating_sub(limit);
                    (200, json!({ "name": name, "messages": &before[start..], "more": start > 0 }))
                }
                Err(e) => (500, json!({ "error": e })),
            },
            (Get, "members") => {
                // 이름마다 상태 하나 (같은 이름의 터미널이 여럿이면 기다리는 쪽)
                let mut status = serde_json::Map::new();
                for (name, s) in (self.ctx.status)(&project) {
                    if s != "working" || !status.contains_key(&name) {
                        status.insert(name, json!(s));
                    }
                }
                let prompts = (self.ctx.prompts)(&project);
                (200, json!({ "members": chats.members(&project), "waiting": (self.ctx.waiting)(&project), "status": status, "paused": chats.paused(&project), "prompts": prompts }))
            }
            (Post, "messages") => match body.get("text").and_then(Value::as_str) {
                Some(text) => match chats.post_via(&project, USER, text, Some(&device.name)) {
                    Ok(m) => (200, json!(m)),
                    Err(e) => (400, json!({ "error": e })),
                },
                None => (400, json!({ "error": "text" })),
            },
            // 선택 창에 답한다 (화면이 확인을 받은 뒤). 넣은 결과는 채팅 기록으로 온다
            (Post, "answer") => match (body.get("prompt").and_then(Value::as_str), body.get("option").and_then(Value::as_u64)) {
                (Some(prompt), Some(option)) => match (self.ctx.answer)(&project, prompt, option as usize, &device.name) {
                    Ok(()) => (200, json!({})),
                    Err(e) => (409, json!({ "error": e })),
                },
                _ => (400, json!({ "error": "body" })),
            },
            (Post, "resume") => match body.get("group").and_then(Value::as_str) {
                Some(group) => {
                    chats.resume(&project, group);
                    (200, json!({}))
                }
                None => (400, json!({ "error": "group" })),
            },
            _ => (404, json!({ "error": "not found" })),
        }
    }

    // SSE: 응답을 직접 쓴다 (tiny_http의 응답 본문은 버퍼에 모였다 나가서 이벤트가 늦는다). chunked로 이벤트마다 내보낸다.
    fn stream(&self, request: tiny_http::Request, allowed: &str, device: &str) {
        let (tx, rx) = mpsc::sync_channel::<String>(STREAM_QUEUE);
        {
            // 토큰을 확인한 뒤 여기까지 오는 사이에 그 기기를 끊었으면 열지 않는다 (forget과 같은 잠금 안에서 본다)
            let mut st = self.state.lock().unwrap();
            if !st.devices.iter().any(|d| d.id == device) {
                drop(st);
                let _ = request.respond(tiny_http::Response::from_data(b"{\"error\":\"token\"}".to_vec()).with_status_code(401));
                return;
            }
            if st.streams.len() >= MAX_STREAMS {
                st.streams.remove(0);
            }
            st.streams.push((device.to_string(), tx));
        }
        let mut w = request.into_writer();
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: {allowed}\r\nVary: Origin\r\nTransfer-Encoding: chunked\r\n\r\n"
        );
        let chunk = |w: &mut Box<dyn Write + Send>, s: &str| -> std::io::Result<()> {
            write!(w, "{:x}\r\n{s}\r\n", s.len())?;
            w.flush()
        };
        if w.write_all(head.as_bytes()).is_err() || chunk(&mut w, "event: hello\ndata: {}\n\n").is_err() {
            return;
        }
        loop {
            let line = match rx.recv_timeout(PING) {
                Ok(line) => line,
                Err(mpsc::RecvTimeoutError::Timeout) => ": ping\n\n".to_string(),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            if chunk(&mut w, &line).is_err() {
                break;
            }
        }
        let _ = w.write_all(b"0\r\n\r\n").and_then(|()| w.flush());
    }
}

// --- Tailscale ---

fn tailscale_cli() -> Option<PathBuf> {
    TAILSCALE_CLI.iter().map(PathBuf::from).find(|p| p.exists())
}

fn tailscale_json(args: &[&str]) -> Result<Value, String> {
    let cli = tailscale_cli().ok_or("tailscale not installed")?;
    let out = std::process::Command::new(cli).args(args).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

// 화면에 보일 Tailscale 상태
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tailscale {
    installed: bool,
    running: bool,
    host: Option<String>,
    login: Option<String>,
    // 이 이름의 HTTPS 인증서를 받을 수 있다 (관리 콘솔에서 HTTPS를 켰다)
    cert: bool,
    // tailscale serve: off (443에 없음), ours (이 포트로), other (다른 곳으로)
    serve: String,
    // tailscale funnel이 켜져 있다 (공개 노출: 모바일 서버를 띄우지 않는다)
    funnel: bool,
}

// `tailscale status --json`의 이름·로그인·인증서
fn parse_status(v: &Value) -> (bool, Option<String>, Option<String>, bool) {
    let running = v["BackendState"] == "Running";
    let host = v["Self"]["DNSName"].as_str().map(|s| s.trim_end_matches('.').to_string()).filter(|s| !s.is_empty());
    let uid = v["Self"]["UserID"].as_u64().map(|u| u.to_string()).unwrap_or_default();
    let login = v["User"][uid.as_str()]["LoginName"].as_str().map(str::to_string);
    let cert = host.as_ref().is_some_and(|h| v["CertDomains"].as_array().is_some_and(|d| d.iter().any(|x| x.as_str() == Some(h))));
    (running, host, login, cert)
}

// `tailscale serve status --json`: 이 이름의 443 "/"가 어디로 가는지, funnel이 켜졌는지
fn parse_serve(v: &Value, host: &str, port: u16) -> (String, bool) {
    let key = format!("{host}:443");
    let proxy = v["Web"][key.as_str()]["Handlers"]["/"]["Proxy"].as_str();
    let serve = match proxy {
        Some(p) if p == format!("http://127.0.0.1:{port}") || p == format!("http://localhost:{port}") => "ours",
        Some(_) => "other",
        None if v["Web"][key.as_str()].is_object() => "other",
        None => "off",
    };
    let funnel = v["AllowFunnel"][key.as_str()].as_bool().unwrap_or(false);
    (serve.to_string(), funnel)
}

pub fn tailscale(port: u16) -> Tailscale {
    // 자체 테스트는 Tailscale 없이 정한 이름·로그인을 쓴다 ("<이름>|<로그인>")
    if let Ok(fake) = std::env::var("DDAK_MOBILE_IDENTITY") {
        let (host, login) = fake.split_once('|').unwrap_or((&fake, ""));
        return Tailscale { installed: true, running: true, host: Some(host.into()), login: Some(login.into()), cert: true, serve: "ours".into(), funnel: false };
    }
    let mut ts = Tailscale { installed: tailscale_cli().is_some(), serve: "off".into(), ..Tailscale::default() };
    let Ok(status) = tailscale_json(&["status", "--json"]) else { return ts };
    (ts.running, ts.host, ts.login, ts.cert) = parse_status(&status);
    if let (Some(host), Ok(serve)) = (ts.host.as_deref(), tailscale_json(&["serve", "status", "--json"])) {
        (ts.serve, ts.funnel) = parse_serve(&serve, host, port);
    }
    ts
}

// Tailscale 상태를 읽어 신원을 맞추고, funnel이 켜져 있으면 서버를 멈춘다
fn refresh(mobile: &Arc<Mobile>) -> Tailscale {
    let config = mobile.config();
    let ts = tailscale(config.port);
    mobile.set_identity(Identity { host: ts.host.clone(), login: ts.login.clone() });
    if ts.funnel {
        mobile.stop();
        mobile.set_error(Some("funnel".into()));
    } else if config.enabled && !mobile.running() {
        let _ = mobile.start();
    }
    ts
}

// --- 앱 연결 ---

pub fn install(app: &tauri::AppHandle, chats: Option<Arc<Chats>>) -> MobileState {
    use tauri::Manager;
    let Some(chats) = chats else { return MobileState(None) };
    let dir = match crate::projects::data_dir(app) {
        Ok(d) => d.join("mobile"),
        Err(e) => {
            eprintln!("모바일 폴더 실패: {e}");
            return MobileState(None);
        }
    };
    let (a, b, c, d, e) = (app.clone(), app.clone(), app.clone(), app.clone(), app.clone());
    let members = chats.clone();
    let ctx = Ctx {
        chats: chats.clone(),
        projects: Box::new(move || crate::projects::paths(&a).unwrap_or_default().into_iter().map(PathBuf::from).collect()),
        waiting: Box::new(move |project| {
            let members = chats.member_tokens(project);
            let waiting = b.state::<crate::pty::Ptys>().waiting_tokens();
            let mut names: Vec<String> = members.into_iter().filter(|(t, _)| waiting.contains(t)).map(|(_, n)| n).collect();
            names.sort();
            names.dedup();
            names
        }),
        status: Box::new(move |project| {
            let statuses = c.state::<crate::pty::Ptys>().statuses();
            members.member_tokens(project).into_iter().filter_map(|(t, n)| statuses.iter().find(|(s, _)| *s == t).map(|(_, s)| (n, s.clone()))).collect()
        }),
        prompts: Box::new(move |project| {
            let ptys = d.state::<crate::pty::Ptys>();
            d.state::<crate::prompts::Prompts>().open_in(project, |pty| ptys.exists(pty))
        }),
        answer: Box::new(move |project, prompt, option, device| crate::prompts::answer(&e, project, prompt, option, Some(device))),
        dir,
    };
    let mobile = Mobile::new(ctx);
    // 자체 테스트는 실제 앱과 겹치지 않게 포트·화면 주소를 바꾼다
    if let Ok(port) = std::env::var("DDAK_MOBILE_PORT") {
        mobile.state.lock().unwrap().config.port = port.parse().unwrap_or(0);
    }
    if let Ok(screen) = std::env::var("DDAK_MOBILE_SCREEN") {
        mobile.state.lock().unwrap().config.screen = screen;
    }
    if mobile.config().enabled {
        // tailscale CLI는 느릴 수 있어서 앱이 뜨는 것을 막지 않게
        let m = mobile.clone();
        std::thread::spawn(move || {
            refresh(&m);
        });
    }
    MobileState(Some(mobile))
}

// 사용자에게 알릴 것을 폰에도 (notify.rs send. 맥 배너와 같은 생략 조건을 본 뒤)
pub fn push(app: &tauri::AppHandle, project: &Path, kind: &str, body: &str) {
    use tauri::Manager;
    if let Some(Some(m)) = app.try_state::<MobileState>().map(|s| s.0.clone()) {
        m.notify(project, kind, body);
    }
}

// 채팅방에 생긴 일을 폰에 (chat.rs install). waiting: 깨우기 대기가 바뀜 (pty.rs, 프로젝트를 모른다)
pub fn publish(app: &tauri::AppHandle, project: Option<&Path>, kind: &str, data: Value) {
    use tauri::Manager;
    if let Some(Some(m)) = app.try_state::<MobileState>().map(|s| s.0.clone()) {
        m.publish(project, kind, data);
    }
}

fn mobile_of(state: &tauri::State<'_, MobileState>) -> Result<Arc<Mobile>, String> {
    state.0.clone().ok_or_else(|| "mobile is not available".to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    config: Config,
    running: bool,
    // 실제 포트 (설정이 0이면 OS가 고른 것)
    port: Option<u16>,
    error: Option<String>,
    tailscale: Tailscale,
    devices: Vec<Value>,
}

fn status(mobile: &Arc<Mobile>, ts: Tailscale) -> Status {
    Status { config: mobile.config(), running: mobile.running(), port: mobile.port(), error: mobile.error(), tailscale: ts, devices: mobile.devices() }
}

#[tauri::command(async)]
pub fn mobile_status(state: tauri::State<'_, MobileState>) -> Result<Status, String> {
    let mobile = mobile_of(&state)?;
    let ts = refresh(&mobile);
    Ok(status(&mobile, ts))
}

#[tauri::command(async)]
pub fn mobile_set_enabled(state: tauri::State<'_, MobileState>, enabled: bool) -> Result<Status, String> {
    let mobile = mobile_of(&state)?;
    mobile.set_enabled(enabled)?;
    let ts = refresh(&mobile);
    Ok(status(&mobile, ts))
}

// `tailscale serve --bg <포트>`: 이 맥의 https://<이름>.ts.net/ 을 모바일 서버로 (D5: 사용자가 창에서 누를 때만)
#[tauri::command(async)]
pub fn mobile_serve(state: tauri::State<'_, MobileState>) -> Result<Status, String> {
    let mobile = mobile_of(&state)?;
    let port = mobile.port().unwrap_or(mobile.config().port);
    let cli = tailscale_cli().ok_or("tailscale not installed")?;
    let out = std::process::Command::new(cli).args(["serve", "--bg", &port.to_string()]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let ts = refresh(&mobile);
    Ok(status(&mobile, ts))
}

// 새 페어링 코드와 폰에서 열 링크 (QR). 링크: <화면 주소>#pair=<API 주소>&code=<코드>
#[tauri::command(async)]
pub fn mobile_pair_code(state: tauri::State<'_, MobileState>) -> Result<Value, String> {
    let mobile = mobile_of(&state)?;
    let ts = refresh(&mobile);
    let host = ts.host.ok_or("tailscale")?;
    let code = mobile.pair_code();
    let api = format!("https://{host}");
    let link = format!("{}#pair={}&code={code}", mobile.config().screen, url::form_urlencoded::byte_serialize(api.as_bytes()).collect::<String>());
    Ok(json!({ "code": code, "api": api, "link": link, "expires": now_ms() + CODE_TTL.as_millis() as u64 }))
}

#[tauri::command(async)]
pub fn mobile_forget(state: tauri::State<'_, MobileState>, id: String) -> Result<Status, String> {
    let mobile = mobile_of(&state)?;
    mobile.forget(&id)?;
    let ts = refresh(&mobile);
    Ok(status(&mobile, ts))
}

// HTTP 요청 하나 (Connection: close). Host가 없으면 127.0.0.1:<포트>. (상태, 본문)
fn raw_http(port: u16, method: &str, path: &str, headers: &[(String, String)], body: &str) -> Result<(u16, String), String> {
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
    let mut req = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("Host")) {
        req.push_str(&format!("Host: 127.0.0.1:{port}\r\n"));
    }
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(body);
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut out = String::new();
    s.read_to_string(&mut out).map_err(|e| e.to_string())?;
    let code = out.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let body = out.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
    Ok((code, body))
}

// 자체 테스트: 보내지 않고 모은 푸시 (가져가면 비운다)
#[tauri::command]
pub fn selftest_mobile_pushes(state: tauri::State<'_, MobileState>) -> Result<Vec<(String, Value)>, String> {
    Ok(std::mem::take(&mut mobile_of(&state)?.state.lock().unwrap().pushes))
}

// 자체 테스트: 모바일 서버에 요청 하나 (Origin·신원 헤더를 마음대로 넣으려고 웹뷰가 아니라 Rust에서 보낸다)
#[tauri::command(async)]
pub fn selftest_mobile_http(state: tauri::State<'_, MobileState>, method: String, path: String, headers: Vec<(String, String)>, body: String) -> Result<(u16, String), String> {
    if std::env::var_os("DDAK_SELFTEST").is_none() {
        return Err("selftest only".into());
    }
    let port = mobile_of(&state)?.port().ok_or("not running")?;
    raw_http(port, &method, &path, &headers, &body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;

    const ORIGIN: &str = "https://screen.example";
    const LOGIN: &str = "me@example.com";
    const HOST: &str = "mac.tail0.ts.net";

    struct Fixture {
        mobile: Arc<Mobile>,
        port: u16,
        project: PathBuf,
        dir: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.mobile.stop();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn fixture(name: &str) -> Fixture {
        fixture_with(name, Box::new(|_| vec![]))
    }

    // 선택 창 답하기 대역: "p1"만 열려 있다. 받은 것을 남긴다
    static ANSWERS: Mutex<Vec<(String, usize, String)>> = Mutex::new(Vec::new());
    fn answer_stub(_: &Path, prompt: &str, option: usize, device: &str) -> Result<(), String> {
        if prompt != "p1" {
            return Err("closed".into());
        }
        ANSWERS.lock().unwrap().push((prompt.to_string(), option, device.to_string()));
        Ok(())
    }

    fn fixture_with(name: &str, status: Box<dyn Fn(&Path) -> Vec<(String, String)> + Send + Sync>) -> Fixture {
        let dir = std::env::temp_dir().join(format!("ddak-mobile-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let project = dir.join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let project = real(&project);
        let chats = Chats::new(dir.join("chats"), Box::new(|_, _| {}), 0);
        let p = project.clone();
        let ctx = Ctx { chats, projects: Box::new(move || vec![p.clone()]), waiting: Box::new(|_| vec![]), status, prompts: Box::new(|_| vec!["p1".into()]), answer: Box::new(answer_stub), dir: dir.join("mobile") };
        let mobile = Mobile::new(ctx);
        {
            let mut st = mobile.state.lock().unwrap();
            st.config.port = 0;
            st.config.screen = format!("{ORIGIN}/app/");
            st.identity = Identity { host: Some(HOST.into()), login: Some(LOGIN.into()) };
        }
        mobile.start().unwrap();
        let port = mobile.port().unwrap();
        Fixture { mobile, port, project, dir }
    }

    fn http(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> (u16, String) {
        let headers: Vec<(String, String)> = headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        raw_http(port, method, path, &headers, body).unwrap()
    }

    fn base<'a>() -> Vec<(&'a str, &'a str)> {
        vec![("Host", HOST), ("Origin", ORIGIN), ("Tailscale-User-Login", LOGIN)]
    }

    fn pair(f: &Fixture) -> String {
        let code = f.mobile.pair_code();
        let (status, body) = http(f.port, "POST", "/api/pair", &base(), &format!(r#"{{"code":"{code}","device":"phone"}}"#));
        assert_eq!(status, 200, "{body}");
        serde_json::from_str::<Value>(&body).unwrap()["token"].as_str().unwrap().to_string()
    }

    #[test]
    fn checks_in_order() {
        let f = fixture("order");
        // Host가 다르면 421 (DNS 리바인딩)
        assert_eq!(http(f.port, "GET", "/api/info", &[("Host", "evil.example"), ("Origin", ORIGIN), ("Tailscale-User-Login", LOGIN)], "").0, 421);
        // 미리 보내기: 허용 출처·메서드·헤더면 204, 아니면 403
        let pre = |origin: &str, headers: &str| {
            http(f.port, "OPTIONS", "/api/info", &[("Host", HOST), ("Origin", origin), ("Access-Control-Request-Method", "GET"), ("Access-Control-Request-Headers", headers)], "").0
        };
        assert_eq!(pre(ORIGIN, "authorization"), 204);
        assert_eq!(pre("https://evil.example", "authorization"), 403);
        assert_eq!(pre(ORIGIN, "authorization, x-other"), 403);
        // Origin, Tailscale 신원, 토큰
        assert_eq!(http(f.port, "GET", "/api/info", &[("Host", HOST), ("Origin", "https://evil.example"), ("Tailscale-User-Login", LOGIN)], "").0, 403);
        assert_eq!(http(f.port, "GET", "/api/info", &[("Host", HOST), ("Origin", ORIGIN)], "").0, 403);
        assert_eq!(http(f.port, "GET", "/api/info", &[("Host", HOST), ("Origin", ORIGIN), ("Tailscale-User-Login", "other@example.com")], "").0, 403);
        assert_eq!(http(f.port, "GET", "/api/info", &base(), "").0, 401);
        let token = pair(&f);
        let auth = format!("Bearer {token}");
        let mut h = base();
        h.push(("Authorization", &auth));
        let (status, body) = http(f.port, "GET", "/api/info", &h, "");
        assert_eq!(status, 200, "{body}");
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["api"], API_VERSION);
        // 루프백 Host도 받는다 (tailscale serve 없이 같은 맥에서. 그래도 Origin·신원·토큰은 필요)
        let loop_host = format!("127.0.0.1:{}", f.port);
        let mut h2 = h.clone();
        h2[0] = ("Host", &loop_host);
        assert_eq!(http(f.port, "GET", "/api/info", &h2, "").0, 200);
    }

    #[test]
    fn pair_code_is_single_use_and_devices_are_saved() {
        let f = fixture("pair");
        let code = f.mobile.pair_code();
        let body = format!(r#"{{"code":"{code}","device":"phone"}}"#);
        let (status, answer) = http(f.port, "POST", "/api/pair", &base(), &body);
        assert_eq!(status, 200);
        let token = serde_json::from_str::<Value>(&answer).unwrap()["token"].as_str().unwrap().to_string();
        // 같은 코드는 다시 쓰지 못한다
        assert_eq!(http(f.port, "POST", "/api/pair", &base(), &body).0, 401);
        // 새 코드를 만들면 이전 코드는 버린다
        let old = f.mobile.pair_code();
        let _new = f.mobile.pair_code();
        assert_eq!(http(f.port, "POST", "/api/pair", &base(), &format!(r#"{{"code":"{old}"}}"#)).0, 401);
        // 기기 목록은 해시만 저장한다 (다시 켜면 이것을 읽는다)
        let saved = std::fs::read_to_string(f.dir.join("mobile/devices.json")).unwrap();
        assert!(!saved.contains(&token), "{saved}");
        let devices: Vec<Device> = read_json(&f.dir.join("mobile/devices.json"));
        assert_eq!((devices.len(), devices[0].hash.as_str(), devices[0].login.as_str()), (1, hash(&token).as_str(), LOGIN));
    }

    #[test]
    fn expired_code_is_refused() {
        let f = fixture("expired");
        let code = f.mobile.pair_code();
        f.mobile.state.lock().unwrap().code = Some((code.clone(), Instant::now() - CODE_TTL - Duration::from_secs(1)));
        assert_eq!(http(f.port, "POST", "/api/pair", &base(), &format!(r#"{{"code":"{code}"}}"#)).0, 401);
    }

    #[test]
    fn too_many_failures_block_for_a_while() {
        let f = fixture("fails");
        for _ in 0..FAIL_LIMIT {
            assert_eq!(http(f.port, "POST", "/api/pair", &base(), r#"{"code":"000000x"}"#).0, 401);
        }
        // 한도를 채우면 맞는 코드도 받지 않는다
        let code = f.mobile.pair_code();
        assert_eq!(http(f.port, "POST", "/api/pair", &base(), &format!(r#"{{"code":"{code}"}}"#)).0, 429);
    }

    #[test]
    fn forgotten_device_is_refused() {
        let f = fixture("forget");
        let token = pair(&f);
        let auth = format!("Bearer {token}");
        let mut h = base();
        h.push(("Authorization", &auth));
        assert_eq!(http(f.port, "GET", "/api/info", &h, "").0, 200);
        let id = f.mobile.devices()[0]["id"].as_str().unwrap().to_string();
        f.mobile.forget(&id).unwrap();
        assert_eq!(http(f.port, "GET", "/api/info", &h, "").0, 401);
    }

    #[test]
    fn projects_messages_and_post() {
        let f = fixture("chat");
        let token = pair(&f);
        let auth = format!("Bearer {token}");
        let mut h = base();
        h.push(("Authorization", &auth));
        let (status, body) = http(f.port, "GET", "/api/projects", &h, "");
        assert_eq!(status, 200, "{body}");
        let projects: Value = serde_json::from_str(&body).unwrap();
        let id = projects["projects"][0]["id"].as_str().unwrap().to_string();
        assert_eq!(id, project_id(&f.project));
        for i in 1..=5 {
            f.mobile.ctx.chats.post(&f.project, USER, &format!("m{i}")).unwrap();
        }
        // 최신부터 limit개, 더 있으면 more. before로 이전 페이지
        let (_, body) = http(f.port, "GET", &format!("/api/projects/{id}/messages?limit=2"), &h, "");
        let page: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(page["messages"].as_array().unwrap().iter().map(|m| m["text"].as_str().unwrap()).collect::<Vec<_>>(), ["m4", "m5"]);
        assert_eq!(page["more"], true);
        let (_, body) = http(f.port, "GET", &format!("/api/projects/{id}/messages?limit=10&before=4"), &h, "");
        let page: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(page["messages"].as_array().unwrap().len(), 3);
        assert_eq!(page["more"], false);
        // 보내기: 사용자로, 보낸 기기를 남긴다
        let (status, body) = http(f.port, "POST", &format!("/api/projects/{id}/messages"), &h, r#"{"text":"hello from phone"}"#);
        assert_eq!(status, 200, "{body}");
        let last = f.mobile.ctx.chats.messages(&f.project).unwrap().pop().unwrap();
        assert_eq!((last.from.as_str(), last.text.as_str(), last.via.as_deref()), (USER, "hello from phone", Some("phone")));
        // 모르는 프로젝트
        assert_eq!(http(f.port, "GET", "/api/projects/nope-000000/messages", &h, "").0, 404);
    }

    #[test]
    fn events_stream_sends_changes() {
        let f = fixture("events");
        let token = pair(&f);
        let mut s = std::net::TcpStream::connect(("127.0.0.1", f.port)).unwrap();
        write!(s, "GET /api/events HTTP/1.1\r\nHost: {HOST}\r\nOrigin: {ORIGIN}\r\nTailscale-User-Login: {LOGIN}\r\nAuthorization: Bearer {token}\r\n\r\n").unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut r = std::io::BufReader::new(s);
        let mut seen = String::new();
        let mut line = String::new();
        // hello까지 읽은 뒤 이벤트를 보낸다 (그 전에는 등록이 안 됐을 수 있다)
        while !seen.contains("event: hello") {
            line.clear();
            r.read_line(&mut line).unwrap();
            seen.push_str(&line);
        }
        assert!(seen.starts_with("HTTP/1.1 200") && seen.contains("text/event-stream") && seen.contains(&format!("Access-Control-Allow-Origin: {ORIGIN}")), "{seen}");
        f.mobile.publish(Some(&f.project), "message", json!({ "id": 7 }));
        seen.clear();
        while !seen.contains("\"id\":7") {
            line.clear();
            r.read_line(&mut line).unwrap();
            seen.push_str(&line);
        }
        assert!(seen.contains("event: message") && seen.contains(&project_id(&f.project)), "{seen}");
    }

    // 기기 연결을 끊으면 열려 있던 SSE도 닫히고, 그 뒤의 이벤트는 받지 못한다 (리뷰 R1)
    #[test]
    fn forgetting_a_device_closes_its_stream() {
        let f = fixture("forget-stream");
        let token = pair(&f);
        let mut s = std::net::TcpStream::connect(("127.0.0.1", f.port)).unwrap();
        write!(s, "GET /api/events HTTP/1.1\r\nHost: {HOST}\r\nOrigin: {ORIGIN}\r\nTailscale-User-Login: {LOGIN}\r\nAuthorization: Bearer {token}\r\n\r\n").unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut r = std::io::BufReader::new(s);
        let mut line = String::new();
        while !line.contains("event: hello") {
            line.clear();
            r.read_line(&mut line).unwrap();
        }
        let id = f.mobile.devices()[0]["id"].as_str().unwrap().to_string();
        f.mobile.forget(&id).unwrap();
        f.mobile.publish(Some(&f.project), "message", json!({ "secret": true }));
        // 스트림은 끝 조각(0)으로 닫히고 끊은 뒤의 이벤트는 오지 않는다
        let mut rest = String::new();
        while !rest.ends_with("0\r\n\r\n") {
            line.clear();
            if r.read_line(&mut line).unwrap_or(0) == 0 {
                break;
            }
            rest.push_str(&line);
        }
        assert!(rest.ends_with("0\r\n\r\n") && !rest.contains("secret"), "{rest:?}");
        assert!(f.mobile.state.lock().unwrap().streams.is_empty());
    }

    // 끊은 기기는 앱을 다시 켜도 거절한다 (기기 목록은 바꾼 순서대로 저장. 리뷰 R4)
    #[test]
    fn forgotten_device_stays_forgotten_after_restart() {
        let f = fixture("restart");
        let a = pair(&f);
        let b = pair(&f);
        let id_a = f.mobile.devices()[0]["id"].as_str().unwrap().to_string();
        f.mobile.forget(&id_a).unwrap();
        let p = f.project.clone();
        let chats = Chats::new(f.dir.join("chats"), Box::new(|_, _| {}), 0);
        let again = Mobile::new(Ctx { chats, projects: Box::new(move || vec![p.clone()]), waiting: Box::new(|_| vec![]), status: Box::new(|_| vec![]), prompts: Box::new(|_| vec![]), answer: Box::new(answer_stub), dir: f.dir.join("mobile") });
        assert!(again.device(&a, LOGIN).is_none());
        assert!(again.device(&b, LOGIN).is_some());
    }

    // 쌓인 이벤트가 한도를 넘으면 (받지 못하는 연결) 그 연결을 뺀다 (리뷰 R5)
    #[test]
    fn stalled_stream_is_dropped() {
        let f = fixture("stalled");
        let (tx, _rx) = mpsc::sync_channel(STREAM_QUEUE);
        f.mobile.state.lock().unwrap().streams.push(("dev".into(), tx));
        for i in 0..STREAM_QUEUE {
            f.mobile.publish(None, "waiting", json!({ "i": i }));
        }
        assert_eq!(f.mobile.state.lock().unwrap().streams.len(), 1);
        f.mobile.publish(None, "waiting", json!({}));
        assert!(f.mobile.state.lock().unwrap().streams.is_empty());
    }

    fn authed(token: &str) -> String {
        format!("Bearer {token}")
    }

    // 구독을 받아 두고, 알릴 때 푸시 서비스에 암호화한 내용과 VAPID 서명을 보낸다. 410이면 구독을 지우고 끊김으로 남긴다.
    #[test]
    fn sends_push_and_remembers_gone_subscription() {
        let f = fixture("push");
        f.mobile.state.lock().unwrap().config.enabled = true;
        let token = pair(&f);
        let auth = authed(&token);
        let mut h = base();
        h.push(("Authorization", &auth));
        // CORS 미리 보내기에 DELETE도 받는다
        let pre = [("Host", HOST), ("Origin", ORIGIN), ("Access-Control-Request-Method", "DELETE"), ("Access-Control-Request-Headers", "authorization")];
        assert_eq!(http(f.port, "OPTIONS", "/api/push", &pre, "").0, 204);
        let service = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let endpoint = format!("http://127.0.0.1:{}/push/abc", service.server_addr().to_ip().unwrap().port());
        let (sub, ua, ua_auth) = push::tests::subscription(&endpoint);
        assert_eq!(http(f.port, "POST", "/api/push", &h, r#"{"endpoint":"https://x.example/"}"#).0, 400);
        let (status, body) = http(f.port, "POST", "/api/push", &h, &serde_json::to_string(&sub).unwrap());
        assert_eq!(status, 200, "{body}");
        let info = |h: &[(&str, &str)]| serde_json::from_str::<Value>(&http(f.port, "GET", "/api/info", h, "").1).unwrap()["push"].clone();
        assert_eq!(info(&h), json!({ "endpoint": endpoint, "gone": null }));
        assert_eq!(f.mobile.devices()[0]["push"], "on");

        f.mobile.notify(&f.project, "message", "dev: done");
        let mut req = service.recv_timeout(Duration::from_secs(10)).unwrap().expect("push request");
        let header = |r: &tiny_http::Request, n: &'static str| r.headers().iter().find(|x| x.field.equiv(n)).map(|x| x.value.as_str().to_string()).unwrap_or_default();
        assert_eq!((header(&req, "Content-Encoding").as_str(), header(&req, "TTL").as_str()), ("aes128gcm", "86400"));
        let claims = push::tests::verify_vapid(&header(&req, "Authorization"), &sub.public_key);
        assert_eq!((claims["aud"].as_str(), claims["sub"].as_str()), (Some(endpoint.trim_end_matches("/push/abc")), Some(format!("{ORIGIN}/app/").as_str())));
        let mut sealed = Vec::new();
        req.as_reader().read_to_end(&mut sealed).unwrap();
        let payload: Value = serde_json::from_slice(&push::tests::decrypt(&ua, &ua_auth, &sealed)).unwrap();
        let config = f.mobile.config();
        assert_eq!(payload, json!({ "title": format!("{} · proj", config.name), "body": "dev: done", "kind": "message", "computer": config.id, "project": project_id(&f.project) }));
        req.respond(tiny_http::Response::empty(201)).unwrap();

        // 푸시 서비스가 410: 구독을 지우고 끊김으로 (폰이 같은 구독을 다시 보내지 않게)
        f.mobile.notify(&f.project, "message", "again");
        let req = service.recv_timeout(Duration::from_secs(10)).unwrap().expect("second push");
        req.respond(tiny_http::Response::empty(410)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while f.mobile.devices()[0]["push"] != "gone" && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(info(&h), json!({ "endpoint": null, "gone": endpoint }));
        let saved: Vec<Device> = read_json(&f.dir.join("mobile/devices.json"));
        assert_eq!((saved[0].push.is_none(), saved[0].push_gone.as_deref()), (true, Some(endpoint.as_str())));
        // 구독이 없으면 보내지 않는다
        f.mobile.notify(&f.project, "message", "nobody");
        assert!(service.recv_timeout(Duration::from_millis(300)).unwrap().is_none());

        // 다시 켜면 끊김이 풀리고, DELETE로 지운다
        assert_eq!(http(f.port, "POST", "/api/push", &h, &serde_json::to_string(&sub).unwrap()).0, 200);
        assert_eq!(info(&h), json!({ "endpoint": endpoint, "gone": null }));
        assert_eq!(http(f.port, "DELETE", "/api/push", &h, "").0, 200);
        assert_eq!(info(&h), json!({ "endpoint": null, "gone": null }));
    }

    // 모바일 연결을 끄면 구독이 있어도 보내지 않는다
    #[test]
    fn no_push_while_disabled() {
        let f = fixture("push-off");
        let token = pair(&f);
        let service = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let (sub, _, _) = push::tests::subscription(&format!("http://127.0.0.1:{}/p", service.server_addr().to_ip().unwrap().port()));
        f.mobile.set_push(f.mobile.device(&token, LOGIN).unwrap().id.as_str(), Some(sub)).unwrap();
        f.mobile.notify(&f.project, "message", "x");
        assert!(service.recv_timeout(Duration::from_millis(300)).unwrap().is_none());
    }

    // 참여자 상태: 이름마다 하나 (기다리는 쪽 우선). 프로젝트 목록에는 기다리는 세션 수
    #[test]
    fn members_carry_session_status() {
        let f = fixture_with("status", Box::new(|_| vec![("dev".into(), "working".into()), ("dev".into(), "permission".into()), ("rev".into(), "working".into()), ("qa".into(), "question".into())]));
        let token = pair(&f);
        let auth = authed(&token);
        let mut h = base();
        h.push(("Authorization", &auth));
        let id = project_id(&f.project);
        let (_, body) = http(f.port, "GET", &format!("/api/projects/{id}/members"), &h, "");
        let members: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(members["status"], json!({ "dev": "permission", "rev": "working", "qa": "question" }));
        // 열린 선택 창과 답하기 (기기 이름이 넘어간다)
        assert_eq!(members["prompts"], json!(["p1"]));
        assert_eq!(http(f.port, "POST", &format!("/api/projects/{id}/answer"), &h, r#"{"prompt":"p1","option":1}"#).0, 200);
        assert_eq!(http(f.port, "POST", &format!("/api/projects/{id}/answer"), &h, r#"{"prompt":"p2","option":0}"#).0, 409);
        assert_eq!(http(f.port, "POST", &format!("/api/projects/{id}/answer"), &h, r#"{"prompt":"p1"}"#).0, 400);
        let got = ANSWERS.lock().unwrap().clone();
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].0.as_str(), got[0].1), ("p1", 1));
        assert!(!got[0].2.is_empty(), "기기 이름");
        let (_, body) = http(f.port, "GET", "/api/projects", &h, "");
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["projects"][0]["awaiting"], 2);
    }

    #[test]
    fn origin_of_screen() {
        assert_eq!(origin_of("https://madsys11.github.io/ddak/").as_deref(), Some("https://madsys11.github.io"));
        assert_eq!(origin_of("http://localhost:5173/").as_deref(), Some("http://localhost:5173"));
        assert_eq!(origin_of("not a url"), None);
    }

    #[test]
    fn parses_tailscale_status_and_serve() {
        let status = json!({
            "BackendState": "Running",
            "Self": { "DNSName": "mac.tail0.ts.net.", "UserID": 42 },
            "User": { "42": { "LoginName": LOGIN } },
            "CertDomains": ["mac.tail0.ts.net"],
        });
        assert_eq!(parse_status(&status), (true, Some(HOST.into()), Some(LOGIN.into()), true));
        let serve = |proxy: &str, funnel: bool| {
            json!({ "Web": { "mac.tail0.ts.net:443": { "Handlers": { "/": { "Proxy": proxy } } } }, "AllowFunnel": { "mac.tail0.ts.net:443": funnel } })
        };
        assert_eq!(parse_serve(&serve("http://127.0.0.1:47320", false), HOST, 47320), ("ours".into(), false));
        assert_eq!(parse_serve(&serve("http://127.0.0.1:3000", true), HOST, 47320), ("other".into(), true));
        assert_eq!(parse_serve(&json!({}), HOST, 47320), ("off".into(), false));
    }
}
