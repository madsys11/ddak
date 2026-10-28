# 세션 창: 다시 시작(↻)과 닫기(×) 단추 (2026-10-28)

**요청** (사용자): 재발 방지 1번 "세션 다시 시작" 창 메뉴를 진행. 그리고 세션 창은 `exit`로만 닫을 수 있는 것 같다 (× 같은 단추가
안 보인다). 실제로는 ⌘W(터미널 메뉴 "창 닫기")로 닫히지만 화면에 단추가 없었다.

**배경**: codex가 업데이트 안내로 끝나 셸만 남은 창에서 손으로 `codex resume`을 띄우면 ddak 인자(채팅 주소 등)가 빠져 채팅
도구 없이 떴다 (`2026-10-28-codex-update-off.md`). 그 창을 설정대로 되살릴 방법이 없었다.

**구현** (`Workspace.tsx`, `App.css`, i18n `pane.*`):
- 세션 창 이름 줄 오른쪽 끝에 단추 둘.
  - ↻ 세션 다시 시작: 명령이 있는 세션만 (준비 창·준비를 기다리는 창 제외). 확인을 받고 (`devHooks.confirm`) `restartPane`으로
    그 세션을 `resumed: true`로 두고 창마다의 횟수 `paneRuns`를 늘린다. 터미널 key(`term-<탭 횟수>-<창 횟수>`)가 바뀌어 그 창의
    터미널만 새로 만든다: 옛 터미널은 내려가며 PTY를 끝내고(`pty_kill`, 내려간 뒤에는 onExit을 부르지 않아 창이 닫히지 않는다,
    Terminal.tsx `!disposed`), 새 터미널은 `commandOf`의 이어서 하기 인자(없거나 실패하면 처음 인자)로 띄운다. 채팅 참여 키가
    세션 ID(sid)라 이름도 그대로다 (chat.rs join: 키로 이름을 기억).
  - × 창 닫기: 묻지 않고 `closePane` (탭의 ×, ⌘W와 같음).
- spec "탭·창" 이름 줄 항목.

**확인** (`addSession` 단계, prompter 창):
- "세션 다시 시작": 확인에서 취소하면 같은 터미널 그대로, 확인 문구에 세션 이름. 확인하면 같은 창에 새 터미널이 뜨고 prompter가
  다시 출력, 창은 그대로, 채팅에 `origin/prompter`가 있고 `origin/prompter-2` 같은 새 이름이 없다.
- "창 닫기": 이름 줄 ×로 묻지 않고 그 창이 닫힌다.
- 수정을 끄고 (창 횟수를 늘리지 않음, ×가 아무것도 안 함): 두 검사 실패.
- `addSession`을 돌리는 중 기존 검사 "알림: 채팅을 열어 둬도 … 보게 되면 지움"이 한 번 실패(다른 프로젝트에서 돌아온 뒤 배지가
  3초 안에 안 지워짐)했고, 바로 두 번 다시 돌리니 통과했다. 이번 변경과 무관한 시간 흔들림으로 본다.

**한계**: 진짜 claude·codex로 다시 시작해 보지는 않았다. codex는 옛 프로세스를 끝내자마자 새로 띄우므로, 이전에 본
"thread-store conflict: already has an active writer"(이어 갈 대화를 아직 다른 프로세스가 쥠)가 다시 날 수 있다. 그러면 codex가
새 대화로 시작할 수 있다 (채팅 연결은 된다). 맥에서 써 보며 확인한다.
- 전체 `selftest.sh`: main·corrupt·resume-save 통과. restart·resume-check는 이름 줄 글(`textContent`)에 새 단추 글자 `↻×`가
  붙어 이름 비교 두 검사가 실패 → 단추를 뺀 이름을 읽는 `paneLabel`로 고침 (검사 쪽). 두 시나리오를 다시 돌려 통과.

## 리뷰 1차 (reviewer-2 #346)

**R1 [P2] 옛 프로세스가 다 끝나기 전에 같은 세션을 띄움 — 타당.** key를 바꾸면 옛 Terminal 정리(pty_kill, 기다리지 않음) 바로
뒤에 새 Terminal이 뜬다. pty_kill도 끝내기를 따로 돌리고 바로 돌아온다 (pty.rs close). 늦게 끝나는 프로세스가 세션(파일 잠금,
codex의 대화)을 쥐고 있으면 새 세션이 실패한다.
수정:
- Rust `wait_closed`/`pty_wait_closed(id, timeout_ms)`: 그 터미널이 열린 목록과 닫는 중 목록(close의 terminate가 끝나야 빠짐)에서
  모두 빠질 때까지 기다린다. 끝내지 못하면 닫는 중에 남으므로 시간이 지나 false. async 명령 + spawn_blocking (메인 스레드를 막지 않게).
- `Workspace.tsx` restartPane: 확인 → 그 창을 "기다리는 중" 안내로 바꿔 옛 Terminal을 내린다(Terminal이 PTY를 닫음) →
  `pty_wait_closed` → 끝났으면 resumed + 창 횟수를 늘려 새 Terminal, 아니면 "끝나지 않아 띄우지 않음" 안내 (↻로 다시). 창마다의
  PTY 번호는 Terminal의 새 `onPty`로 받는다.
확인:
- Rust `wait_closed_returns_after_the_session_ends`: HUP을 받고 0.2초 정리하는 프로세스를 닫으면 닫는 중에 들어가고, 기다림은
  프로세스가 끝난 뒤에 true (그 뒤 kill(pid,0) 실패). 열린 터미널은 시간 안에 false. 닫는 중을 보지 않게 되돌리면 실패.
- 자체 테스트(testChatPrompt 끝, picker): `devHooks.paneWaitClosed`로 기다림을 붙잡아 두는 동안 그 창에는 안내만(터미널 없음, ↻
  없음), false를 돌려주면 "끝나지 않음" 안내이고 터미널을 띄우지 않음, 다시 누르면(진짜 기다림) 새로 띄움. 기다리지 않게 되돌리면 실패.

**R2 [P2] 다시 시작한 창에 옛 상태 배지와 옛 PTY를 깨우는 단추가 남음 — 타당.** 새 Terminal은 상태가 바뀌기 전에는 알리지 않는다.
수정: restartPane 처음에 그 창의 statuses·waking을 지운다. 확인: 위 검사에서 다시 띄운 picker가 선택 창으로 대기 배지를 세운 채
다시 시작하면 기다리는 동안 배지가 없다. 지우지 않게 되돌리면 실패 (noBadge false).

**R3 [P2] 재시작으로 사라진 선택 창이 채팅에 열린 단추로 남음 — 타당.** 열린 목록(chat_prompts)은 살아 있는 터미널만 보이지만,
PTY가 없어질 때 채팅 패널이 다시 읽을 알림이 없었다.
수정: `pty_kill`이 `prompts::pty_gone`을 불러 그 터미널의 열린 선택 창을 닫고 `chat-prompts`를 알린다 (다시 시작뿐 아니라 창
닫기·탭 닫기 모두). 확인: 위 검사에서 다시 시작하면 `chat-prompts` 알림이 오고 열린 목록에서 빠지며 채팅 패널의 그 카드 단추가
눌리지 않게 바뀐다. pty_gone을 빼면 실패 (promptClosed·cardClosed false).

이름 줄이 좁은 창(탭에 창 6개)에서는 선택 창 글이 여러 줄로 감겨 선택 창으로 읽히지 않아서, 이 검사는 picker가 혼자 있는 탭에서 한다.

전체 `selftest.sh` (리뷰 1차 반영 뒤): restart·corrupt·resume 통과, main은 `terminalLinks`의 "없는 파일은 링크 아님" 1건만 실패
(PASS 497). 그 단계만 두 번 다시 돌리니 둘 다 통과 — 이번 변경(창 단추·다시 시작·pty_kill의 선택 창 닫기)과 닿지 않는 간헐 실패로
본다. Rust 129개, tsc, `selftest-changed --check` 통과.

## 재리뷰 1회 (reviewer-2 #350)

R2·R3 해결 확인. **R1 남음 — 타당 (두 조건).**
1. PTY 번호가 아직 오지 않은 것(생성 응답 대기)을 "옛 프로세스 없음"으로 보고 기다림을 건너뛰었다. pty_spawn은 응답 전에 이미
   프로세스를 띄우므로, 그때 ↻를 누르면 옛 프로세스가 도는 채로 새 세션이 떴다.
2. 확인 요청 둘이 겹치면 두 번째가 (첫 번째가 지운) 번호 없음 경로로 기다림을 건너뛰었다.
수정 (`Workspace.tsx`):
- 창마다 PTY 번호를 상태 `ptys`로 둔다: 키 없음 = 만드는 중, 숫자 = 그 터미널, null = 만들지 못함(onSpawnError, 세션 창도).
  만드는 중에는 ↻를 보이지 않고 restartPane도 돌아간다. 만들지 못했으면 기다릴 것 없이 다시 띄운다.
- 창마다 다시 시작 하나만 (`restartBusy`, 확인을 묻는 동안 포함). 번호는 다시 띄울 때(기다림이 끝난 뒤)만 지운다.
확인 (testChatPrompt 끝, picker): `devHooks.spawnDelay`로 새 터미널의 번호를 2초 늦추는 동안 ↻가 없고 번호가 오면 생긴다.
`devHooks.paneWaitClosed`를 붙잡은 채 ↻를 두 번 누르면 기다림은 한 번이고, 풀면 새 터미널이 한 번 뜬다. 겹침 막기만 빼면
기다림 2번으로 실패, 둘 다 빼면 ↻가 보여 실패.
전체 `selftest.sh` 다섯 시나리오 통과 (PASS 499), tsc 통과.

## 재리뷰 2회 (reviewer-2 #352) — R4, 후속 수정 (사용자 결정: 고치고 후속 리뷰 한 번, 설치는 따로)

R1(앞 두 조건)·R2·R3 해결 확인. **R4 [P2, 새 범위] ↻가 아닌 길로 터미널을 다시 만들면 옛 PTY 번호가 남음 — 타당.** `ptys`는 ↻의
성공 경로에서만 지웠다. 작업그룹 끝내기 실패 뒤 다시 띄우기(runs 증가)는 터미널을 새로 만들지만 번호는 그대로라, 새 터미널의
번호가 오기 전에도 ↻가 보였고 누르면 이미 끝난 옛 번호를 기다린 뒤 새 터미널을 띄웠다 (새 프로세스와 겹칠 수 있음).
수정: PTY 번호를 그 터미널의 key(`term-<탭 횟수>-<창 횟수>`, 준비 창은 `setup-<차례>`)와 함께 둔다. 렌더 때 창마다 지금
key(`keyOf`)를 적고, 지금 key의 번호만 쓴다 (`ptyNow`: 아니면 만드는 중). 터미널을 바꾸는 모든 길에 한 번에 맞는다. ↻ 성공
경로에서 번호를 지우던 것은 필요 없어 뺐다. 작업그룹 끝내기 실패 뒤 다시 띄우기를 `relaunchTabs`로 묶고, 자체 테스트가 같은 길을
부르게 `devHooks.relaunchActiveTab`(개발 빌드)을 뒀다.
확인 (picker): `spawnDelay` 2초를 건 채 `relaunchActiveTab` → 새 터미널이 떴는데 번호 전이라 ↻ 없음 → 번호가 오면 ↻ → 누르면
기다림이 새 터미널의 번호(dataset.pty)로 불림. key를 보지 않게 되돌리면 ↻가 보이고 옛 번호(28)를 기다려 실패.
전체 `selftest.sh` 다섯 시나리오 통과 (PASS 499), tsc 통과.
