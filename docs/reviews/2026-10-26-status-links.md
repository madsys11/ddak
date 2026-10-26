# 상태 표시 가독성 · 터미널 링크 열기 (2026-10-26)

**요청** (하루 써 본 불편):
1. 세션 창 이름표의 상태가 모두 같은 칩 모양이라 잘 안 읽힌다.
2. claude 출력의 링크를 눌러도 .html·.md 파일이 열리지 않는다.

**원인 확인**:
- 1: 상태(작업 중·완료·기다림)와 깨우기·준비 배지가 모두 같은 테두리 칩(`.pane-badge`)이었다. 기다림만 강조색 테두리였다.
- 2: ddak 터미널에는 링크 처리가 없었다. claude 2.1.310을 pty로 띄워 출력 바이트를 받아 보니 ddak 안에서는 경로·URL을 OSC 8 없이
  평문으로 그린다 (`\x1b[8Gddak/docs/spec.md\x1b[26Gand…`). xterm 6의 OSC 8 기본 처리는 http·https만 받고 `confirm` 뒤
  `window.open`이라 앱(WKWebView)에서 열리지 않는다 (`xterm.mjs` OscLinkProvider·`Ol`).

**구현**:
- 상태: 색 점 + 글자 (작업 중 파랑·점 깜빡임, 완료 초록, 오류 빨강). 기다림만 색을 채운 칩. 새 토큰 `--status-working`·
  `--status-done`·`--status-awaiting-bg`·`--status-awaiting-fg` (두 테마).
- 링크: `src/terminalLinks.ts` (xterm 링크 제공자, OSC 8 linkHandler) + `src-tauri/src/links.rs` (`link_targets`, `open_link`).
  ⌘+클릭만 연다. 경로는 실제로 있는 것만, 상대 경로는 포그라운드 프로세스의 현재 폴더(`proc_pidinfo`) → 창의 폴더.
  실행될 수 있는 것은 Finder에서 보이기만.

**확인**: cargo test (상대 경로 기준 순서, 열기 규칙, 실행 가능 파일, 프로세스 cwd). selftest terminalLinksUnit·terminalLinks
(실제 화면 mousemove·mousedown/up: 안내, 그냥 클릭은 안 열림, ⌘ 클릭, cd 한 폴더 기준, 조사·`:12`·마침표, run.sh는 보이기,
없는 파일은 링크 아님), programStatus의 계산된 색·배경·테두리. 제공자 등록·CSS·포그라운드 cwd·meta 조건·실행 가능 판정·
조사 처리를 하나씩 끄면 해당 검사가 실패.

## 리뷰 1차 (#127)

**R1 [P2] 넓은 글자가 줄 끝에서 넘어가면 링크가 끊김 — 타당.** xterm은 두 칸 글자가 마지막 한 칸에 못 들어가면 그 칸을 비우고
다음(wrapped) 줄에 쓴다. `logicalLine`이 빈 칸을 모두 `" "`로 붙여 URL이 `/`에서 잘렸다. 수정을 끄고 돌린 새 검사에서 80열
`https://example.com/a…a/한글`이 `…/`까지만, 3열 `a/한.md`가 `a/`로 끊기는 것을 재현했다.
수정: 다음 줄이 이어진 줄이면 이 줄 끝의 내용 없는 칸(`getChars()` 빈 문자열)은 건너뛴다. 쓴 공백은 `" "`가 있어 구분된다.
줄 중간의 빈 칸(claude가 커서 이동으로 띄운 칸)은 그대로 공백. 확인: selftest terminalLinkWrap — 화면 밖 xterm(80열, 3열)에 써서
모든 줄에서 링크가 하나이고 범위가 (1,1)–(마지막 줄 끝)인지. 수정을 끄면 실패.

**R2 [P2] 실행 방지가 적힌 이름에만 의존 — 타당.** `X.app/Contents/..`는 확장자 없는 폴더라 열기로 갔고, 다른 이름의 링크로
.app·.command를 가리킬 수도 있었다. 수정: `canonicalize`한 실제 대상과 적힌 이름 모두로 판정하고, 여는(보이는) 것은 실제 대상.
확인: Rust runnable_files_are_only_revealed에 `X.app/Contents/..`, .command를 가리키는 `notes.txt` 링크, .app을 가리키는
`folder` 링크 추가. 실제 대상 판정을 끄면 실패.

**R3 [P2] 밝은 테마의 상태 글자 대비가 낮음 — 타당.** 이름표 배경 #EEE8D5 위 작업 중 3.00, 완료 2.62, 기다림 칩 글자 4.27:1
(작은 글자 기준 4.5:1). 수정: 솔라라이즈드 색을 진하게 — 작업 중 #1B659A(5.08), 완료 #566300(5.39), 기다림 칩 배경 #B5420F(5.19).
확인: selftest statusContrastUnit — 모든 테마의 상태 글자/이름표 배경, 칩 글자/칩 배경이 4.5:1 이상. 이전 값으로 되돌리면 세 쌍이
실패. 기존 오류색(`--error`, 3.77)은 이번 범위 밖으로 둔다 (리뷰도 제외).

## 재리뷰 1회 (#129)

R1·R2·R3 모두 해결, 새 차단 회귀 없음. 리뷰 세션이 실제 xterm 6 버퍼로 80열 한글 URL·3열 `a/한.md`·10열 넓은 글자 줄바꿈의
범위와 ⌘ 활성화 대상을, 밝은·어두운 테마의 대비를 따로 다시 계산했다. 남은 확인: 설치한 앱에서 기본 앱으로 실제 열리는지.
