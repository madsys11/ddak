# Dock으로 켠 ddak에서 폰이 맥에 붙지 못함 (2026-10-30)

**증상** (사용자): 폰에서 이 맥에 연결이 안 된다. 맥 ddak의 "모바일 연결…" 창은 "Tailscale이 연결되어 있지 않습니다"를
보이는데, Tailscale은 연결되어 있다.

**원인**
- 맥의 Tailscale은 정상이다: `tailscale status`는 Running, 이 이름의 인증서와 `tailscale serve`(`/ → 127.0.0.1:47320`)도 그대로.
- ddak 서버에 이 맥의 `*.ts.net` 이름을 Host로 보내면 421, 루프백 Host는 403. ddak이 아는 이 맥의 이름(`Identity.host`)이
  비어 있어 폰의 모든 요청이 Host 검사에서 거절된다 (폰은 "Can't reach"로 보인다).
- 이름은 `tailscale status --json`으로 읽는다 (`mobile.rs` `tailscale_json`, CLI는 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`).
  이 실행 파일은 환경에 TERM이나 SHLVL이 없으면 GUI로 켜지려 하고, stdout에 "The Tailscale GUI failed to start: …
  (Tailscale.CLIError error 3.)"를 내고 종료 코드 0으로 끝난다. JSON이 아니라서 상태를 못 읽은 것으로 처리된다.
- 실행 중인 ddak의 환경(`ps eww`)에는 TERM·SHLVL이 없다 (launchd가 켬: `XPC_SERVICE_NAME=application.…`). 전에는
  `scripts/install.sh`가 터미널에서 `open`으로 켜서 그 환경을 물려받아 됐다.
- 실험: `env -i HOME USER PATH`만 주면 위 오류 문구, 여기에 `TERM`이나 `SHLVL` 하나만 더하면 JSON, `TAILSCALE_BE_CLI=1`만 더해도 JSON.

**수정** (`mobile.rs`): `tailscale_command`가 Tailscale 명령에 `TAILSCALE_BE_CLI=1`을 붙이고, `tailscale_json`(상태 읽기)과
`mobile_serve`(`tailscale serve --bg`)가 이것을 쓴다. Windows의 `tailscale.exe`는 이 변수를 쓰지 않는다 (모르는 환경 변수).
spec "모바일 연결"에 적음.

**확인**
- Rust `reads_tailscale_status_without_term` (`#[ignore]`, 설치된 Tailscale 필요): 환경을 HOME·USER·PATH만 남기고
  `tailscale_command`로 `status --json`을 부르면 JSON이 온다. 수정을 빼면 "The Tailscale GUI failed to start…"로 실패한다.
  처음에는 TERM만 지웠는데, 테스트를 돌린 셸의 SHLVL 때문에 수정 없이도 통과해서 환경을 비우도록 바꿨다.
- Rust 전체 `cargo test`: 135 통과 (ignored 4). 전체 `scripts/selftest.sh`: 다섯 시나리오 모두 통과, PASS 527, FAIL 0.
- 자체 테스트는 Tailscale 없이 정한 신원(`DDAK_MOBILE_IDENTITY`)을 써서 이 경로를 지나지 않는다.
- 실제 확인은 재설치 뒤 Dock으로 켠 ddak에서 창 상태와 폰 연결로 한다.

**별개**: Windows 기기(m16)는 Tailscale 연결(peerapi 200)은 되지만 443이 TCP 단계에서 시간 초과다. Windows 쪽 확인이 필요하다.

## 리뷰 1회 (origin/reviewer-2, #428)

통과, 차단 지적 없음. 리뷰어가 `reads_tailscale_status_without_term`을 샌드박스 밖에서 직접 돌려 통과 (샌드박스 안에서는
Tailscale이 "Failed to load preferences"로 실패). Dock으로 켠 ddak에서 폰 연결 복구는 재설치 후 확인한다.
