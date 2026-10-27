# Windows 지원 계획

> 작성: 2026-10-27
> 상태: 계획. 결정 W1~W3은 사용자가 정함 (2026-10-27). 문서 리뷰 통과 (2026-10-28, 재리뷰 2회,
> `docs/reviews/2026-10-28-windows-plan.md`). 0단계와 1단계 코드 작성 (2026-10-28, 맥에서 Windows 타입 검사만 함. 진행은
> 아래 "진행"). Windows CI와 실기기 확인 전.
> 결정이 나면 확정된 내용만 `docs/spec.md`로 옮긴다.

## 목표

맥에서 쓰는 ddak을 Windows(x64)에서도 쓴다. 맥 동작은 바꾸지 않는다. 같은 소스에서 플랫폼마다 다른 부분만 나눈다.

## 출발점

2026-10-27 맥에서 `cargo check --target x86_64-pc-windows-msvc`로 본 결과 (리소스 컴파일러는 가짜로 대신):
첫 단계에서만 오류 65개 (이름을 못 찾는 것들. 고치면 다음 단계 오류가 나온다).

| 파일 | 오류 | 원인 |
|---|---|---|
| `clone.rs` | 20 | `clonefile`·`renamex_np`, 유닉스 권한(`mode`), `OsStr::as_bytes` |
| `pty.rs` | 19 | 세션 끝내기(setsid·SIGHUP·SIGKILL·`waitid`), 포그라운드 프로세스 |
| `fs.rs` | 5 | `renamex_np(RENAME_EXCL)` |
| `prepare.rs` | 5 | `/bin/sh` exec, `dev`·`ino` |
| `mobile.rs` | 4 | `libc`(호스트 이름 등), 0600 권한 |
| `claude_trust.rs` | 4 | 권한 유지(`mode`) |
| `links.rs` | 3 | 실행 권한 판정, `proc_pidinfo` |
| `chat.rs`·`prompts.rs`·`push.rs`·`repos.rs`·`worktrees.rs` | 1씩 | `libc`, 심볼릭 링크 |

프론트는 거의 그대로다. 경로를 `/`로 가정한 곳(`docs.ts`, `DocView.tsx`, `useProjects.ts` baseName, `dragPath.ts`)과
⌘ 키(`metaKey`: `Terminal.tsx`, `Workspace.tsx`, `terminalLinks.ts`)만 고친다.

## 결정

- **W1 시험 환경**: 사용자의 x64 Windows PC에서 설치 파일로 실제 확인. 자동 검사(cargo test, 빌드)는 GitHub Actions의
  Windows 러너에서 돈다. 이 맥에서는 `cargo check --target x86_64-pc-windows-msvc`로 컴파일만 본다.
- **W2 셸**: Git Bash (Git for Windows). 세션 실행(`bash -l -i -c '<명령>; exec bash -l'`), 준비 스크립트(`.sh`), 설치 명령이
  지금과 같은 sh 규칙으로 돈다. 인자 인용도 지금 그대로. Git for Windows가 없으면 앱이 설치하라고 안내한다.
- **W3 단축키**: ⌘를 Ctrl로 그대로 바꾼다 (`CmdOrCtrl`). 메뉴에 걸린 키(`menu.rs`: Ctrl+T, Ctrl+Shift+T, Ctrl+D,
  Ctrl+Shift+D, Ctrl+W, Ctrl+Shift+W, Ctrl+F, Ctrl+B, Ctrl+=, Ctrl+-, Ctrl+0)와 프론트가 받는 Ctrl+1~9·Ctrl+Shift+[ ]는
  터미널 프로그램에 가지 않는다 (셸의 줄 편집, claude·codex의 Ctrl 단축키 포함. 예: Ctrl+D EOF, Ctrl+W 단어 지우기).
  - Ctrl+C는 터미널에 선택이 있을 때만 복사, 없으면 터미널로 (인터럽트). Ctrl+V는 붙여넣기.
  - 링크 열기는 Ctrl+클릭. ⌘⌫ → Ctrl+⌫ (Ctrl+U).
  - 1단계 실제 키 검사 목록: Ctrl+C (선택 있음·없음), Ctrl+V가 한 번만 붙여넣는지, 채팅·검색 입력란에서
    Ctrl+A/C/V/X/Z/Y, Ctrl+1~9·Ctrl+Shift+[ ], 메뉴의 기본 편집 항목과 터미널 키 처리가 겹치지 않는지.

## 플랫폼마다 다른 것

| 기능 | 맥 (지금) | Windows | 단계 |
|---|---|---|---|
| 터미널 | portable-pty (PTY) | portable-pty (ConPTY) | 1 |
| 앱 화면 출처 (`lib.rs` `stay_in_app`) | `tauri://` | `http://tauri.localhost` (설치판). 플랫폼마다 허용 | 0 |
| 터미널 닫기 = 세션 전체 끝내기 | setsid 세션에 SIGHUP·SIGCONT → SIGKILL | Job Object (아래 "세션 끝내기") | 1 |
| 파일 이름 검사 (`fs.rs` check_name·child_path) | `/`, `.`, `..` | 아래 "파일 이름" | 1 |
| 종료 코드 | `waitid WNOWAIT` | 프로세스 핸들의 종료 코드 | 1 |
| 앞 프로그램 이름 (⇧↩) | `proc_name`·argv[0] | 우선 세션 구성의 `shiftEnter`만. 그냥 셸 탭에서 띄운 claude는 Enter (한계로 둔다) | 1 |
| 링크의 상대 경로 기준 | 앞 프로그램의 현재 폴더 (`proc_pidinfo`) | 터미널을 띄운 폴더 + 그 아래 저장소들 | 1 |
| 링크 열기의 실행 파일 차단 | 실행 권한, `.app`·`.command`·`.sh` | 아래 "링크 열기" | 1 |
| 기본 앱·탐색기에서 보이기 | `open`, Finder | `ShellExecute`, `explorer /select,` | 1 |
| 파일 이름 바꾸기 (덮어쓰지 않음) | `renamex_np(RENAME_EXCL)` | `MoveFileExW` (REPLACE_EXISTING 없이) | 1 |
| 휴지통 | NSFileManager | 셸 파일 작업 (`FOF_ALLOWUNDO`) | 1 |
| 잠자기 막기 | `caffeinate -i -w` | `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)`. 스레드마다 걸리는 상태라 전용 스레드가 쥐고, 작업이 없어지면 `ES_CONTINUOUS`만으로 풀고, 앱이 끝나면 함께 풀린다 | 1 |
| 작업그룹의 공유 항목 링크, 로컬 저장소 연결 | 심볼릭 링크 | 심볼릭 링크. 일반 사용자는 개발자 모드가 필요하다 (관리자·심볼릭 링크 권한이면 없어도 된다). 못 만들면 이유와 함께 알리고, 이번에 만든 worktree·브랜치는 지금의 실패 처리대로 지운다 (반쯤 남지 않는지 시험) | 1 |
| 설정 파일 열기 (`open -t`) | 기본 텍스트 편집기 | `.json`·`.sh`를 메모장으로 | 1 |
| 앱 데이터 | `~/Library/Application Support/<식별자>` | `%APPDATA%\<식별자>` (Tauri 기본) | 1 |
| 알림 | 알림 센터 + 시스템 소리 | 토스트 (누르면 그 프로젝트로) | 2 |
| 안 읽은 수 | Dock 배지 | 작업 표시줄 오버레이 아이콘 | 2 |
| node_modules·target 복제 | APFS `clonefile` | 처음엔 후보에서 뺌 (설치 명령만). Dev Drive(ReFS) 블록 복제는 나중 | 2 |
| 준비 도우미 | `/bin/sh` exec | Git Bash의 `sh`를 띄우고 종료 코드를 넘김 (exec 없음) | 2 |
| 파이썬 가상 환경 | `bin/python` | `Scripts\python.exe` | 2 |
| 앱 밖 파일 끌어 놓기 | 맥 끌기 대지 | 따로 정함 (WebView2의 drop도 이름만 준다) | 2 |
| 모바일 연결 | Tailscale.app CLI | `C:\Program Files\Tailscale\tailscale.exe`, 컴퓨터 이름 | 2 |
| 한글 입력 | WebKit 보정 (`hangul.ts`) | WebView2(Chromium)는 composition 이벤트를 쓰므로 xterm 기본 처리. 실제 입력기로 확인 | 1 |
| 설치 | `install.sh` (.app 교체) | NSIS 설치 파일 (서명 없음: SmartScreen 경고) | 0 |
| 자체 테스트 | `selftest.sh` (zsh) | Windows용 실행 스크립트 (node), 시나리오는 Git Bash 셸 기준 | 2 |

### 경로

- Windows의 `std::fs::canonicalize`는 짧은 경로도 `\\?\C:\…`(확장 길이 형식)로 돌려준다. 지금 Rust 여러 곳(`workspace.rs`,
  `links.rs`, `chat.rs`, `worktrees.rs` 등)이 canonicalize 결과를 비교·저장·프론트 전달에 쓴다.
- 경로를 둘로 나눈다:
  - 내부 비교·식별용: canonicalize 결과 (같은 파일인지, 프로젝트 해시 등). 바깥에 내보내지 않는다.
  - 바깥용 (프론트, 저장 파일, Git Bash·git·탐색기에 넘기는 인자, 채팅 프로젝트 경로): 일반 형식 `C:\…`. 확장 형식을 일반
    형식으로 바꿀 수 있을 때만 바꾸고 (드라이브 경로, `\\?\UNC\서버\…` → `\\서버\…`), 바꾸면 뜻이 달라지는 경로(260자 넘음,
    끝이 점·공백인 이름, 예약 장치명)는 지원하지 않음 오류로 둔다. 한 함수(`platform::display_path` 같은)로만 바꾼다.
- 프론트는 `\`와 `/`를 모두 구분자로 받는다 (`docs.ts`, `DocView.tsx`, `useProjects.ts` baseName, `dragPath.ts`).
  절대 경로는 드라이브 문자(`C:\`)와 UNC(`\\서버\공유`)도 친다.
- 지원 범위: 드라이브 경로, UNC 공유 폴더(프로젝트 폴더로는 시험만 해 보고 안 되면 등록 때 거절). 긴 경로(260자 넘음)는
  처음엔 지원하지 않는다: `core.longpaths`는 git만 해결하고 Rust·Git Bash·탐색기는 아니다. 넘으면 그 작업을 하기 전에
  알리고 멈추며, 이미 시작한 작업그룹 만들기는 지금의 실패 처리대로 이번에 만든 것만 지운다. 저장된 상태(`workspaces/`,
  `projects.json`)는 건드리지 않는다.
- 1단계 시험: 공백·한글이 든 경로, 드라이브 루트(`C:\`), 링크로 등록한 프로젝트, 260자 근처 경로에서 실패와 정리.

### 파일 이름

`fs.rs` check_name은 `/`만 막고 `Path::join`에 넣는다. Windows에서는 `..\밖`·`C:\밖`·`\밖`이 통과해 폴더 밖이 된다
(`fs_create`·`fs_rename`·`repos.rs`가 `child_path`를 쓴다). Windows에서는 다음을 거절한다:
`\`와 `/`, `:`(드라이브 접두사·대체 데이터 스트림), `< > " | ? *`, 제어 문자, 끝의 점·공백, 예약 장치명
(`CON PRN AUX NUL COM1~9 LPT1~9`, 확장자가 붙어도). 그리고 만든 경로의 부모가 정확히 그 폴더인지 다시 본다
(`Path::join` 결과의 `parent() == dir`, 구성 요소가 하나 늘었는지). 1단계 Windows 테스트(cargo test)로 위 이름마다 폴더 밖에
아무것도 생기거나 옮겨지지 않음을 확인한다.

### 세션 끝내기 (Job Object)

portable-pty 0.9의 ConPTY는 `CreateProcessW`를 `CREATE_SUSPENDED` 없이 부른다 (`win/psuedocon.rs`). 띄운 뒤에 Job에
넣으면 그 사이에 생긴 자식은 Job 밖에 남을 수 있다. 그래서:

- 처음부터 Job 안에서 시작하게 한다. 후보 2(`JOB_LIST`)로 정했다 (`conpty.rs`가 ConPTY를 직접 띄운다): 후보 1의 도우미는
  ddak.exe인데 릴리스는 GUI 서브시스템(`windows_subsystem = "windows"`)이라 ConPTY 콘솔에 붙는다는 보장이 없고, 후보 2는
  portable-pty를 고치지 않고 같은 일을 windows-sys로 할 수 있었다. 실기기·CI에서 동작은 아직 확인 전이다. 두 후보:
  1. 도우미 거치기: ConPTY로 `ddak --ddak-job <Job 이름> -- bash …`를 띄우고, 도우미가 먼저 자기를 그 Job에 넣은 뒤(실패하면
     아무것도 띄우지 않고 오류로 끝남) bash를 띄워 끝날 때까지 기다리고 종료 코드를 넘긴다. 자식은 Job을 물려받는다.
  2. `PROC_THREAD_ATTRIBUTE_JOB_LIST`로 만들 때 Job을 지정한다 (portable-pty의 띄우기를 고쳐 써야 한다).
- Job에 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`를 건다. ddak이 핸들을 쥐고 있다가 앱이 끝나면 (비정상 종료 포함) OS가 Job 안을
  모두 끝낸다. Job 핸들은 ddak만 쥔다 (Job 안의 프로세스가 쥐고 있으면 마지막 핸들이 닫히지 않아 앱이 끝나도 남는다).
- 후보 1(도우미)의 등록 규칙:
  - Job은 터미널마다 추측할 수 없는 이름으로 만든다. 도우미는 이름으로 열어(`JOB_OBJECT_ASSIGN_PROCESS`만) 자기를 넣고 바로
    핸들을 닫은 뒤에만 bash를 띄운다. 열거나 넣지 못하면 (ddak이 이미 끝나 Job이 없음 등) bash를 띄우지 않고 끝난다.
  - 도우미 자신은 Job 밖에서 시작하므로 ddak이 도우미의 프로세스 핸들(portable-pty의 자식)도 쥔다. 끝내기는 이 핸들까지 본다.
  - 끝낸 뒤 Job에 새로 들어올 수 있는 것은 Job 안 프로세스의 자식과, 아직 등록 전인 도우미뿐이다. 그래서 도우미가 끝난 것을
    확인한 뒤의 0만 믿는다 (도우미가 등록 전이면 0이라도 뒤늦게 등록해 bash를 띄울 수 있다).
  - 후보 2(`JOB_LIST`)는 만들 때 이미 Job 안이라 이 틈이 없다.
- 끝내기 (한 터미널):
  1. 그 터미널을 "닫는 중"으로 표시한다 (새로 띄우지 않음).
  2. `TerminateJobObject`, 그리고 도우미 프로세스에 `TerminateProcess`.
  3. 끝난 것의 판정 = 도우미 프로세스가 끝났고(핸들이 신호됨) `JobObjectBasicAccountingInformation`의 `ActiveProcesses`가 0.
     50ms마다 다시 본다. 완료 포트의 `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO`는 전달이 보장되지 않아 일찍 깨우는 데만 쓰고
     판정에는 쓰지 않는다. 다시 볼 때 0이 아니면 `TerminateJobObject`를 다시 부른다 (종료 사이에 Job 안에서 생긴 자식).
  4. `TerminateJobObject`·`TerminateProcess`의 반환만으로 끝난 것으로 보지 않는다. 3초 안에 판정이 안 되면 지금처럼
     "닫는 중"으로 남고 계속 다시 보며, 작업그룹 끝내기는 판정이 난 뒤에만 지운다.
  5. 판정이 나면 Job 핸들을 닫는다.
- Job에서 스스로 빠지는 프로세스(`CREATE_BREAKAWAY_FROM_JOB`이 허용된 경우)는 막지 못한다 (맥의 setsid와 같은 한계).
  `JOB_OBJECT_LIMIT_BREAKAWAY_OK`는 켜지 않는다.
- 1단계 시험 (CI): 끝내기 직전에 만든 자식, 부모가 먼저 끝난 손자, 백그라운드 자식(`cmd &`)이 모두 끝나는지, 다른 터미널의
  프로세스는 남는지, 끝난 뒤 그 폴더를 지울 수 있는지. 후보 1이면 도우미를 Job 등록 직전에 멈춰 둔 채 (시험용 대기) 터미널
  닫기와 작업그룹 끝내기를 해서 bash가 뜨지 않고 끝내기가 판정되는지, 그 상태에서 ddak을 끝내면 도우미가 bash를 띄우지 않는지.

### 링크 열기

예시 확장자 목록만으로 판정하지 않는다. 열기 전에 적힌 경로와 실제 대상(링크·`..`를 따라간 것) 둘 다에 대해:
- 알려진 실행·설치·바로 가기 형식(`.exe .com .bat .cmd .ps1 .vbs .vbe .js .jse .wsf .wsh .msi .msp .lnk .url .scr .cpl .hta
  .pif .reg .sh` 등)이거나 `AssocIsDangerous`가 위험하다고 하면 열지 않고 탐색기에서 보이기만 한다.
- 판정하지 못하면 (오류, 연결 정보 없음) 열지 않고 보이기만 한다.
- 1단계 시험: 위 형식과 그것을 가리키는 링크를 열었을 때 실행되지 않고 탐색기에만 보이는지 (자체 테스트는 지금처럼 기록으로).

## 단계

### 0단계: Windows에서 빌드

- 유닉스·맥 전용 코드를 `cfg(unix)`·`cfg(target_os = "macos")`·`cfg(windows)`로 나눈다. 맥 동작은 그대로 (맥 `cargo test`,
  자체 테스트 전체 통과).
- Windows 쪽 아직 없는 기능은 "지원하지 않음" 오류로 둔다 (조용히 다르게 동작하지 않게).
- `stay_in_app`의 앱 화면 출처를 플랫폼마다: 맥 `tauri://`, Windows `http://tauri.localhost` (Tauri 2의 Windows 앱 주소.
  `useHttpsScheme`을 켜면 https). 개발 서버·`about:`은 지금처럼. Rust 테스트로 두 플랫폼의 허용·거절(`file:`, 바깥 http·https,
  다른 포트의 localhost)을 확인한다.
- GitHub Actions `windows-latest`: `cargo test` (유닉스 전용 테스트는 `cfg(unix)`), `tauri build`로 NSIS 설치 파일을 산출물로 올림.
  main과 수동 실행에서만.
- 끝: 설치 파일이 Windows PC에서 켜지고 앱 화면이 뜨며, 새로 고침(F5)해도 앱 화면이 남는다. 맥은 `cargo test`와 자체
  테스트 전체가 통과한다.

### 1단계: 핵심 작업 흐름

위 표의 1단계 항목. 끝: 프로젝트 등록 → 기본 작업그룹(claude·codex)이 Git Bash로 뜸 → 채팅·깨우기 → 새 작업그룹(worktree)
→ 끝내기 → 앱을 다시 켜면 복원, 을 Windows PC에서 사용자가 확인.

### 2단계: 나머지

위 표의 2단계 항목. 끝:
- Windows에서 자체 테스트의 모든 시나리오(`main`, `restart`, `corrupt`, `resume-save`→`resume-check`)가 통과한다.
- 자체 테스트가 흉내만 내는 것은 Windows PC에서 직접 확인한다: 토스트를 눌러 그 프로젝트·창으로 가기, 작업 표시줄 배지,
  탐색기에서 끌어 놓기, Tailscale 연결과 폰 페어링·푸시, 작업그룹 준비(설치 명령·스크립트).

### 3단계: 배포

기존 "배포 계획 2단계"(updater, GitHub Releases)에 Windows 설치 파일을 더한다. 코드 서명은 그때 정한다.

## 진행 (2026-10-28)

맥에서 한 것 (Windows 실행은 아직 없음: 맥 `cargo test`·자체 테스트 전체, `cargo check --target x86_64-pc-windows-msvc
--all-targets`만):
- 0단계: 유닉스·맥 전용 코드를 나눔 (`platform.rs`, cfg), `stay_in_app`의 Windows 출처, Windows CI(`.github/workflows/windows.yml`:
  cargo test, NSIS 설치 파일). CI는 main에 올라가야 돈다.
- 1단계 Rust: ConPTY + Job(`conpty.rs`)과 끝내기 판정(`pty.rs` terminate), Git Bash 찾기(`DDAK_BASH`, PATH의 git.exe 옆, 기본 설치
  위치), 잠자기 막기(`platform::KeepAwake`), 이름 바꾸기(`MoveFileExW`), 휴지통(`SHFileOperationW`), 파일 이름 검사(`fs.rs`),
  확장 길이 경로 바꾸기(`platform::plain_path`: 링크 열기·claude 신뢰 키), 링크 열기 차단(`links.rs` WINDOWS_RUNNABLE +
  `AssocIsDangerous`), Git Bash 경로(`/c/…`) 링크, 심볼릭 링크, 메모장으로 설정 열기, 컴퓨터 이름, HOME 대신 USERPROFILE,
  claude 신뢰 키에 `/` 꼴도.
- 1단계 화면: Ctrl 단축키(`platform.ts` cmdKey), 문구의 키 표시(⌘ → Ctrl), 터미널 Ctrl+C(선택 있을 때 복사)·Ctrl+V, Ctrl+클릭 링크,
  `\`·드라이브·UNC 경로(문서 탭, 끌기의 상대 경로, 탭 폴더), Windows 메뉴(편집 메뉴 없음: 메뉴 단축키가 웹뷰보다 먼저 잡혀 Ctrl+C를
  가로챈다. 맥 전용 항목 없음).
- 2단계 일부: 준비 도우미(Git Bash로 스크립트·설치 명령, `Scripts\python.exe`), 폴더 복제 후보는 Windows에서 내지 않음.

- 코드 리뷰 통과 (`docs/reviews/2026-10-28-windows-code.md`). 그 뒤:
  - 실제 경로는 모두 `platform::canonical` (canonicalize + 일반 형식, 맥은 그대로).
  - 뒤에서 돌리는 git·tailscale은 콘솔 창 없이 (`platform::background`, CREATE_NO_WINDOW). Git Graph가 3초마다 git을 부른다.
  - Tailscale은 Program Files의 tailscale.exe.
  - 알림은 WinRT 토스트 (`notify.rs` win: 앱 ID = 앱 식별자, 누르면 clicked), 배지는 작업 표시줄 단추의 빨간 점 (수는 없음).
  - 탐색기에서 끌어 놓기 (`windrop.rs`): 화면이 놓은 File을 `postMessageWithAdditionalObjects`로 보내고, Rust가 ICoreWebView2File의
    경로를 토큰별로 둔다. 화면은 `drop_paths`로 가져간다.

남은 것:
- Windows 자체 테스트: `selftest.sh`는 zsh와 맥 도구(caffeinate, mktemp -t)를 쓰고, 시나리오는 셸의 `pwd` 등을 프로젝트 경로와
  비교한다 (Git Bash는 `/c/…`). Windows PC에서 돌리며 고쳐야 한다.
- 실기기 확인이 필요한 가정:
  - 토스트의 앱 ID가 설치 프로그램의 바로 가기와 같은지 (다르면 토스트가 보이지 않는다). 떠 있는 토스트를 누를 때와 알림
    센터에서 나중에 누를 때 각각 그 프로젝트로 가는지.
  - Tauri IPC 처리기가 끌어 놓기 메시지("ddak-drop:…")를 받아도 문제없는지.
  - claude가 신뢰 키를 어느 꼴로 적는지.
  - claude·codex의 Windows판 상태 알림(OSC 7501)과 깨우기.
- 확인: Windows CI 통과, 사용자의 PC에서 1·2단계 끝 조건.
- 3단계 (배포): 코드 서명, updater. 사용자 결정이 필요하다.

## 위험

- ConPTY는 출력 순서·크기 바꾸기·Ctrl+C 전달이 유닉스 PTY와 다르다. 깨우기(알림 문구 뒤 Enter)와 선택 창 읽기가 화면에
  기대므로 1단계에서 claude·codex로 직접 확인한다.
- claude·codex의 Windows판 동작(OSC 7501 상태, 세션 ID 인자, MCP)이 맥과 같은지 모른다. 1단계에서 확인한다.
- 일반 사용자는 개발자 모드가 없으면 심볼릭 링크를 만들 수 없다. 작업그룹 만들기가 이것 때문에 실패할 수 있다.
- Job Object 두 후보 모두 실험 전이다. 둘 다 안 되면 1단계 설계를 다시 정한다.
