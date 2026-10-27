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

## Windows CI 결과 (main push 뒤)

첫 실행에서 Rust 시험 20개가 실패했다. 실제 동작 문제는 하나, 나머지는 시험이 유닉스를 가정한 것이었다. 고친 것은 작업 브랜치에서
CI를 다시 돌려 확인했다.

- 동작 문제: Windows에서 같은 파일의 하드 링크 이름으로 바꾸기(`fs_rename`)가 성공하고 원래 이름이 사라졌다. MoveFileExW는
  대상이 같은 파일이면 "있음"으로 실패하지 않는다. 처음 고친 방식(대소문자만 다른 이름이 아니면 대상이 있는지 미리 보기)은
  아래 후속 리뷰 R1·R2로 바꿨다.
- 시험만 고친 것:
  - `/bin/sh`: setup·worktrees 시험은 `platform::sh()`(Git Bash)로 돌린다.
  - 경로 형식: 링크 대상 비교는 `platform::canonical`(`\\?\` 없는 꼴)로. claude_trust 시험의 설정 JSON은 serde_json으로 적는다
    (`\`가 이스케이프되게).
  - Windows에서 안 되는 것: 탭이 든 파일 이름(git 시험에서 뺌), 맥 시스템 소리 폴더(맥에서만), node_modules·target 복제 후보
    (CAN_CLONE일 때만 기대).
  - 유닉스에서만: `.sh` git 래퍼로 순서를 정하는 worktrees 시험 2개(Windows는 .sh를 바로 실행하지 못함), chmod 000으로 읽기를
    막는 시험 1개(NTFS에서는 막히지 않음). 시험하는 판단은 플랫폼과 무관해 맥에서 확인한다.
  - conpty job_holds_children: Job의 프로세스 수가 0이 된 뒤 프로세스 핸들이 신호를 받기까지 틈이 있었다. 시험이 그 신호를
    기다린다. `pty.rs` terminate는 수가 0이 되면 `wait`로 기다리므로 그대로다.

## CI 후속 리뷰 (리뷰 범위: 740008b 뒤 커밋과 위 절)

### R1 [P2] 미리 확인한 뒤 같은 파일의 링크가 생기면 원래 이름이 여전히 사라짐 — 타당

- 근거: 확인(symlink_metadata)과 MoveFileExW 사이에 hard_link(src, dest)가 생기면 MoveFileExW에 들어가는 상태가 CI에서 본 실패
  상태와 같다. "확인 뒤에 생긴 대상은 MoveFileExW가 막는다"는 다른 파일일 때만 맞다.
- 수정: 일반 파일은 새 이름으로 하드 링크를 만들고(CreateHardLinkW: 이름이 있으면 같은 파일이어도 OS가 원자적으로 거절)
  원래 이름을 지운다(FileDispositionInfoEx, POSIX 방식·읽기 전용 무시). 확인 단계가 없어 틈이 없다. 원래 이름을 지울 수
  있는지는 링크 전에 DELETE로 열어 보고, 지우기가 실패하면 만든 링크를 지운다. 폴더·심볼릭 링크와 하드 링크를 지원하지 않는
  파일 시스템은 같은 파일의 다른 이름이 있을 수 없어 MoveFileExW 그대로.
- 확인: fs windows_rename_keeps_every_name (Windows CI). 틈이 없으므로 경합의 가장 나쁜 입력인 "같은 파일의 다른 이름이 이미
  있음"으로 시험하고, 두 이름이 다 남는지 본다. 읽기 전용 파일 바꾸기, 지우기를 막고 연 파일(새 이름이 남지 않음)도 시험한다.

### R2 [P2] 소문자로 같은 이름이면 같은 항목으로 본 것 — 타당

- 근거: 폴더별 대소문자 구분이 켜진 폴더에서는 a.txt와 A.txt가 따로 있을 수 있다. Rust의 to_lowercase는 Windows의 이름 비교
  규칙도 아니다.
- 수정: 이름 글자를 비교하지 않는다. 링크가 "있음"으로 거절됐을 때 그 이름으로 찾은 항목의 저장된 이름(FindFirstFileW)이 원래
  이름과 똑같을 때만 같은 항목(대소문자를 구분하지 않는 폴더의 대소문자 바꾸기)으로 보고 MoveFileExW로 바꾼다.
- 확인: windows_rename_keeps_every_name: fsutil로 대소문자 구분을 켠 폴더에서 a.txt와 그 링크 A.txt면 "있음"이고 둘 다 남음,
  A.txt가 없으면 a.txt→A.txt가 됨. 구분하지 않는 폴더의 대소문자 바꾸기. CI에서 fsutil이 실패하면 시험이 실패한다.

### R3 [P3] 유닉스에서만 도는 worktrees 시험 3개 — 타당, 남은 일로

- 지키는 동작은 Windows에도 필요하다. `docs/windows-plan.md` "남은 것"에 Windows에서 끼어드는 방법으로 보완할 일로 적었다.
