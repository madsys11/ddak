# 모바일 연결 M0 실험 결과

대상: `docs/mobile-plan.md`의 M0. 코드 반영 없음. 실험 코드는 별도 공개 저장소 `madsys11/ddak-mobile-spike`
(GitHub Pages의 정적 PWA + 맥의 127.0.0.1 실험 서버, `tailscale serve`로 tailnet HTTPS에 노출).

## 환경 (2026-10-26)

- 폰: Galaxy Z Fold7, Android 17, Chrome 151 → 156 (실험 중 업데이트)
- 맥 A: macOS 15.7, Tailscale 1.104.2 (Intel). 맥 B는 아직 없음
- Tailscale: MagicDNS, HTTPS 인증서, Tailnet Lock(서명 키는 맥 A), 기기 키 만료. ACL은 "폰 → 맥 A 443"만 허용
- 출처: `https://madsys11.github.io` (실험 페이지 `/ddak-mobile-spike/`)

## 결과

| # | 항목 | 결과 | 근거 |
|---|---|---|---|
| 1 | 고정 출처 → 맥 API (CORS) | 됨 | 페어링·정보·SSE·구독·푸시 요청 모두 미리 보내기 204, 본 요청 200/202. 탭과 설치한 PWA 둘 다 |
| 1 | Chrome LNA / Android 로컬 네트워크 권한 | 권한 창 없음 | 미리 보내기에 `Access-Control-Request-Private-Network`·`-Local-Network` 헤더 없음. `permissions.query`는 `local-network-access`·`local-network` 모두 `granted`. Chrome 156으로 올린 뒤에도 같음 (정보 요청 200, 권한 창 없음) |
| 3 | 폰이 만든 VAPID 키로 Web Push | 됨 | 맥 A가 FCM에 보낸 푸시 201, 도착까지 2.5~2.8초. 화면 꺼짐, Chrome 완전 종료(최근 앱에서 닫음) 상태에서도 옴 |
| 3 | 알림 키 바꾸기 → 예전 키 거절 | 됨 | 새 구독 뒤 예전 구독·키로 보낸 푸시가 FCM 410 "push subscription has unsubscribed or expired" |
| 3 | PWA 설치 뒤 푸시 | **설치하면 끊김** | 탭에서 `granted`였던 알림 권한이 설치한 PWA에서는 `default`. 폰에는 예전 구독이 남아 있지만 FCM은 410. PWA에서 권한을 다시 받고 키를 바꾸자 201, 알림을 누르면 PWA가 열림 |
| 4 | `Tailscale-User-Login` | 붙음 | 맥 자신과 폰의 요청 모두. `tailscale serve`를 거쳐도 `Host`는 `*.ts.net` 이름 그대로 |
| 5 | SSE (fetch 스트림) 재연결 | 됨 | 화면이 꺼지거나 앱을 떠나면 몇 초 안에 끊김. 돌아오면 `Last-Event-ID`로 이어 받음 (266~294ms). 화면을 켠 직후 첫 시도가 한 번 실패한 경우가 있었음 |
| - | 페어링 코드 1회용 | 됨 | 같은 코드 재사용 401 |
| - | 설치한 PWA의 저장소 | 탭과 공유 | 설치 뒤에도 컴퓨터 목록·토큰 유지 |

## 설계에 반영할 것

- **설치 후 알림 권한 다시 받기**: PWA는 첫 실행 때 알림 권한과 구독을 확인하고, 없거나 바뀌었으면 권한을 받고 다시
  구독해 모든 컴퓨터에 넘긴다. 열 때마다 지금 구독의 endpoint를 컴퓨터가 가진 것과 비교한다.
- **410 처리**: 맥은 푸시가 404/410이면 그 구독을 지우고 폰 목록에 "알림 끊김"으로 보인다.
- **숨겨진 동안 재연결 멈춤**: 실험 페이지는 화면이 꺼진 동안 3초마다 다시 연결을 시도해 계속 실패했다. 실제 앱은
  `visibilityState`가 `hidden`이면 재시도를 멈추고, `visible`이 되면 바로 연결하고 실패하면 짧게 한두 번 더 시도한다.
- **출처 공유**: `madsys11.github.io`는 madsys11의 모든 Pages 저장소가 같은 출처다. 실험 페이지와 나중 앱이 저장소(토큰)와
  CORS 허용을 함께 쓴다. 실제 앱은 전용 출처(별도 조직의 Pages나 사용자 도메인)를 두는 것을 D7과 함께 다시 정한다.
- **Tailnet Lock과 새 기기 승인은 함께 켤 수 없다** (계획서 인증·보안 8번에 반영).

## 남은 실험

- 2번: 맥 A를 끈 상태에서 맥 B 사용 (맥 B 필요)
- 3번: 맥 A·B가 같은 키로 각각 보낸 푸시
- 4번: 맥 재시동 뒤 `tailscale serve` 설정 유지
- 6번: QR → 설치한 PWA로 이어지는 페어링
- 7번: (참고) 서비스 워커 범위를 나눈 구독 여러 개
