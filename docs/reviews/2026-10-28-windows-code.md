# Windows 지원 코드 리뷰 (0단계 + 1단계 대부분 + 2단계 일부)

대상: 기준 `a3d27cb`(계획 문서) + 커밋 안 한 변경. 무엇을 했는지는 `docs/windows-plan.md` "진행".
Windows 실행은 없다 (맥 `cargo test`·자체 테스트, `cargo check --target x86_64-pc-windows-msvc --all-targets`만).

## 리뷰 1차

### R1 [P2] Windows CI에서 앱 출처 테스트가 실패 — 타당

- 근거: `lib.rs` 테스트의 첫 목록이 `tauri://localhost`를 플랫폼 값을 따르는 `app_page`로 본다. Windows에서는 거절이 맞아서
  `cargo test`가 실패하고 설치 파일 빌드까지 가지 못한다. `--all-targets` 검사는 컴파일만 하므로 잡지 못했다.
- 수정: 개발 서버·빈 화면·거절 목록은 두 플랫폼 모두 `app_page_on`으로, `tauri://`는 맥 값으로, 지금 플랫폼의 설치판 주소만
  `app_page`로 본다.

### R2 [P2] 맥에서 이름 안의 `\`를 구분자로 봄 — 타당

- 근거: `platform.ts` baseName과 `useProjects.ts` normalize가 플랫폼과 상관없이 `\`로 나누고 지웠다. Finder에서 끈 `a\b.png`의
  이름이 `b.png`가 되어 끌어 놓기가 빈 목록이 되고(회귀), `project\` 폴더는 다른 폴더로 등록된다.
- 수정: 구분자는 Windows에서만 `\`도 (`baseName`·`dirName`·`relativeTo`·`trimTrailingSep`가 `windows` 값을 받는다,
  기본은 지금 플랫폼). `normalizePath`는 `/`로 시작하는 경로의 `\`를 이름으로 둔다. 문서 탭의 폴더는 드라이브·UNC로 시작하는
  경로만 Windows 경로로 본다.
- 확인: platformUnit에 맥 `\` 이름 검사 6개. 구분자를 늘 `\`도로 되돌리면 이 검사가 `b.png`로 실패한다.

### R3 [P2] Windows의 file 주소가 `/C:/…`로 남음 — 타당

- 근거: `terminalLinks.ts` docPathOf가 `URL.pathname`을 그대로 썼다.
- 수정: `platform.ts` fileUrlPath: Windows는 `file:///C:/…`·`file://localhost/C:/…` → `C:\…`, 다른 호스트는 UNC. 맥은 그대로
  (localhost·빈 호스트만).
- 확인: platformUnit "file 주소" (Windows 3개, 맥 3개).

### R4 [P2] 읽기가 멈춘 뒤 ClosePseudoConsole이 끝나지 않을 수 있음 — 타당

- 근거: `pty.rs`의 읽기 스레드는 화면 채널이 끊기면 멈춘다. 공식 문서상 Windows 11 24H2 전의 ClosePseudoConsole은 남은 출력이
  읽힐 때까지 기다린다. (실기기 관측이 아니라 코드 경로와 API 계약의 대조)
- 수정: `conpty.rs` Inner::drop이 닫기 전에 출력 파이프를 따로 끝까지 읽어 버리는 스레드를 띄운다 (콘솔 호스트가 닫히면 끝남).
  pty.rs는 맥 동작을 바꾸지 않으려고 그대로 둔다.
- 확인: `conpty.rs` closing_unread_console_returns (읽지 않은 채 큰 출력 뒤 닫기가 10초 안에 돌아옴). Windows CI에서만 돈다.

## 재리뷰 1회

R1~R4 해결, 새 차단 문제 없음. R4는 소스·API 계약 검토다: windows-latest는 새 Windows라 ClosePseudoConsole이 기다리지 않을 수
있어서, CI 통과가 예전 Windows의 대기 경로까지 확인한 것은 아니다.

## 새 범위 리뷰 (재리뷰 1회 뒤 추가분)

대상: `platform::canonical`·`background`, Tailscale 경로, 토스트·작업 표시줄 점, 탐색기 끌어 놓기(`windrop.rs`, `drop_paths`,
`dragPath.ts` windowsDropped). 차단 문제 없음. 맥 동작은 그대로임을 확인받았다. 리뷰어가 dragPath.ts의 Windows 분기를 11가지
경우로 메모리에서 돌려 보았다. 토스트는 떠 있는 동안 누르기와 알림 센터에서 나중에 누르기를 실기기에서 따로 확인한다.
