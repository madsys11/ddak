# Windows에서 claude 작업 중 표시 (계획)

대상: 이 문서 (계획). 기준 `7059b0a`, 코드 변경 없음.

## 문제

사용자: 폰 채팅의 참여자 칩에 "작업 중"이 나오지 않아 누가 작업하는지 알 수 없다 (Windows PC).

## 원인 (실험으로 확인)

- 작업 중 표시는 claude가 보내는 OSC 7501 `state=working`에서 온다 (`Terminal.tsx` → `pty_working` → `pty.rs statuses`,
  잠자기 막기). claude는 시작할 때 `ESC]7501;?`로 묻고, 답이 없으면 상태를 보내지 않는다 (claude 2.1.316 본문:
  `u.answer("programStatus",!1,"probe: no reply to OSC 7501 ; ?")`, 끄거나 켜는 환경 변수 없음).
- Windows에서 그 물음은 ddak에 온다. 답은 ConPTY 입력에서 버려진다. 임시 단계(커밋 안 함)로 ddak 터미널에서 콘솔 입력을
  날것으로 읽는 프로그램을 돌려 확인:
  - 물음: 프론트의 OSC 7501 처리기가 `?`를 받았고 답을 썼는데, 프로그램이 받은 것은 ConPTY가 직접 답한 DA1뿐이었다.
  - 직접 쓰기: `pty_write`로 OSC 답, CSI(`ESC[?1;2c`), DCS(`ESCP>|xterm ESC\`), `abc`를 썼더니 OSC만 사라지고
    나머지는 그대로 왔다.
- 그래서 Windows의 claude는 상태를 보내지 않는다. 작업 중(폰 칩, PC 창 이름표, 잠자기 막기)과 OSC의 기다림(blocked)이
  모두 없다. 권한 확인 대기는 화면의 선택 창 읽기(`dialogOnScreen`)와 Notification 훅으로 따로 잡혀 동작한다.
- 맥은 영향 없음. 기존 `programStatus` 단계를 Windows에서 돌리면 "OSC 7501 물음에 답함"이 실패한다 (같은 원인).

## 사용자 결정 (2026-11-04)

화면 읽기를 쓰고 claude 훅으로 보완한다 (둘 다).

## claude 화면 (실험, Windows ConPTY, claude 2.1.316)

ddak 시험 창에서 claude를 띄워 맨 아래 화면을 기록했다 (임시 단계, 커밋 안 함):

```
41:· Doing… (5s · thinking with high effort)
43:──
44:❯
45:──
46:  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt     ← 작업 중
...
41:✻ Baked for 18s · done 7:35 AM
46:  ⏵⏵ auto mode on (shift+tab to cycle)                       ← 끝남
```

- 작업 중에는 맨 아래 모드 줄(권한 모드를 읽는 그 줄, `readMode`) 끝에 ` · esc to interrupt`가 붙는다. 첫 응답 전
  (생각 중)부터 끝날 때까지 이어진다.
- Esc를 누르면 바로 빠진다 (중단, 프롬프트가 입력란으로 돌아옴).
- 회전 기호 줄(`✻ Incubating… (3s · …`)은 동사가 매번 바뀌고 줄 위치도 바뀌어 쓰지 않는다.

## 설계

### 1. 화면에서 읽기 (`src/programStatus.ts` readBusy, `Terminal.tsx`)

- `readBusy(lines)`: claude 입력란과 그 아래 footer의 모양이 화면 맨 아래에 있을 때만 작업 중 (리뷰 R1). 빈 줄을 뺀
  맨 아래 4줄이 차례로
  1. 가로줄 (`─`만, 20자 이상): 입력란 위 테두리
  2. 입력 줄 (`❯`로 시작)
  3. 가로줄: 입력란 아래 테두리
  4. footer: `esc to interrupt`로 끝나고 그 앞이 줄 처음(공백 뒤)이거나 `·`
  이고, 4가 화면의 비어 있지 않은 마지막 줄이어야 한다. 입력란이 여러 줄이면 2가 여러 줄일 수 있다: 맨 아래에서 footer,
  가로줄, 그 위로 가로줄이 나올 때까지(입력 줄 최대 몇 줄, 구현 때 정함)의 첫 줄이 `❯`로 시작.
- 그래서 일반 셸·로그 출력의 마지막 줄이 같은 문구여도 (셸은 그 뒤에 프롬프트가 마지막 줄, `cat`한 로그는 위 구조가 아님)
  작업 중이 아니다. claude가 끝나면 셸 프롬프트가 마지막 줄이 되어 풀린다.
- 모드가 없는 claude의 기본 모드는 footer가 모드 없이 `esc to interrupt`일 것으로 본다 (위 4의 "줄 처음"). 구현 때 실제
  화면으로 확인하고 다르면 그 모습을 넣는다.
- 읽는 때: 권한 모드와 같이 출력이 처리된 뒤 100ms 모아서 (`checkDialog` → `reportMode` 옆).

### 2. claude 훅 (`groups.rs` CLAUDE_SETTINGS, `chat.rs`, `pty.rs`)

- 기본 claude `--settings`에 `UserPromptSubmit`(차례 시작)과 `Stop`·`StopFailure`(차례 끝)를 더한다. 훅 입력(JSON)을
  `{turn}`(새 자리표시자, `/turn/<토큰>`)로 보낸다: `curl -s -m 2 --data-binary @- {turn} >/dev/null 2>&1 || true`.
  `async`가 아니다 (SessionStart와 같은 이유: 짧은 차례의 시작·끝이 순서가 바뀌어 도착하지 않게).
- `chat.rs`: `/turn/<토큰>` POST. `hook_event_name`이 `UserPromptSubmit`이면 시작, `Stop`·`StopFailure`면 끝, 그 밖·잘못된
  본문은 400. 모르는 토큰 404, GET 405, 다른 Host 403 (다른 훅 주소와 같은 검사).
- 받은 것은 그 토큰의 터미널에 `pty-turn` 이벤트 `{pty, working, seq}`로 알린다 (프론트가 합친다, 아래 3). seq는 터미널마다
  늘어나는 번호이고 프론트는 더 오래된 것을 버린다.
- 프론트는 `chat-wake`와 같은 순서를 따른다 (리뷰 확인 질문 2): 리스너 등록이 끝난 뒤 `pty_spawn`, 생성 응답(id)보다 먼저 온
  이벤트는 PTY 번호별로 가장 새 것만 모아 두었다가 id를 받으면 반영한다.
- 채팅 깨우기가 넣은 글도 프롬프트 제출이라 시작으로 온다.

### 3. 합치기 (`Terminal.tsx`, 판단은 순수 함수 `programStatus.ts` 로 단위 시험)

터미널마다:

- 그 터미널에서 프로그램이 OSC 7501 보고를 보냈으면 (맥) 지금처럼 OSC만 쓴다. 화면·훅은 보지 않는다. 이 우선권은 OSC
  지움(`clear`, 프로그램이 상태를 거둠)을 받으면 풀린다 (리뷰 확인 질문 1): 같은 PTY에서 OSC를 보내던 프로그램이 끝나고 OSC
  없는 claude를 다시 띄우면 그때부터 화면·훅을 쓴다. claude는 끝날 때 터미널 모드를 되돌리면서 상태를 보낸 적이 있으면
  `ESC]7501;state=clear ST`를 쓴다 (claude 2.1.316 본문 restoreTerminalModes: `TC().now("programStatus")?lZn:""`,
  `lZn=…7501;state=clear…`). 지움 없이 끝난 프로그램(강제 종료 등) 뒤의 claude는 화면·훅을 쓰지 않는다 (한계).
- 아니면:
  - 화면 작업 중이면 작업 중.
  - 훅이 시작을 알렸고 이번 차례에 화면 작업 중을 아직 한 번도 못 봤으면 작업 중 (화면 읽기가 깨진 경우의 보완).
  - 이번 차례에 화면 작업 중을 봤으면 화면을 따른다: 꼬리가 빠지면 (끝남이든 Esc 중단이든) 바로 풀린다.
  - 훅의 끝이 오면 훅 쪽은 풀린다.
- "이번 차례": 훅의 시작마다 새로 센다.
- 결과는 지금의 `status`가 `working`인 것과 같게 다룬다: PC 창 이름표 "작업 중", `pty_working`(폰 칩, 잠자기 막기).
  사용자를 기다리는 동안(선택 창, blocked)은 지금처럼 기다림이 앞선다.
- 둘 다 깨지는 경우: 화면 문구가 바뀐 채 Esc로 중단하면 훅의 끝이 오지 않아 (Esc에서 Stop이 오는지는 구현 때 실제로 확인)
  다음 차례 시작·끝까지 작업 중으로 남는다. 받아들인다.

### 4. 이전 기본 설정 바꾸기 (`groups.rs` upgrade)

- 이전 기본은 두 가지다: v1(Notification만, 사용자의 groups.json이 지금 이것), v2(+SessionStart). 둘 중 하나와 **정확히
  같은** claude 인자만 새 기본으로 바꾼다 (메모리에서만, 저장된 창도 `upgrade_saved`로). 고친 것은 그대로라 훅이 없고 화면
  읽기만 쓴다.
- 훅은 세션을 다시 띄울 때부터 (↻, 앱 재시작). 화면 읽기는 ddak을 업데이트하면 열린 세션에도 바로.

### 바꾸지 않는 것

- 맥 동작 (OSC를 보내는 터미널은 그대로).
- codex (훅·모드 줄이 없다. Windows에서 codex의 상태도 같은 원인으로 오지 않을 수 있으나 이번 범위 밖).
- OSC의 blocked(권한·질문·인증 기다림)를 Windows에서 되살리는 것 (선택 창 읽기와 Notification 훅이 이미 있다).

## 시험

- 단위 (`programStatusUnit`에 더함): readBusy (실험의 줄들: 작업 중·끝남·Esc 뒤, 기본 모드, 여러 줄 입력란), 음성 사례
  (리뷰 R1: 셸이 같은 문구를 출력하고 프롬프트로 돌아옴, 대화 본문·로그의 마지막 줄이 같은 문구, footer 아래에 다른 줄),
  합치기 함수 (화면만, 훅만, 훅 시작 → 화면 봄 → 화면 빠짐 = 풀림, 훅 끝, OSC 본 터미널은 무시, OSC 지움 뒤 다시 화면).
- 앱 단계 (새 `screenBusy`): 가짜 프로그램이 입력란·footer를 그렸다 꼬리를 붙였다 떼어 이름표 "작업 중"과 `pty_working`이
  따라오는지, 셸에서 `printf 'esc to interrupt\n'` 뒤 작업 중이 아닌지, `/turn/` POST로 훅 시작·끝, 화면을 본 차례에서 꼬리가
  빠지면 훅이 시작 상태여도 풀리는지, OSC 보고를 한 터미널은 화면을 무시하고 지움 뒤에는 다시 보는지, 생성 응답보다 먼저 온
  훅 이벤트가 반영되는지 (devHooks.spawnDelay).
- Rust: `/turn/` 경로 (204·400·404·405·403), upgrade (v1·v2 → 새 기본, 고친 것 그대로, 저장된 창).
- 각 새 시험은 수정을 끄고 실패하는지 본다.
- Windows에서 실제 claude로 (임시 단계, 커밋 안 함): 작업 중 → 끝남, Esc 중단, 기본 모드의 화면, 훅이 Windows(Git Bash curl)에서
  오는지, Esc에서 Stop이 오는지. 결과를 이 문서에 적는다.
- 전체 selftest는 맥 전용 도구가 있어 Windows에서 고른 단계만 돈다 (지금까지와 같은 한계).

## 스펙

`docs/spec.md`의 프로그램 상태·잠자기 막기·사용자 알림 훅 절에 Windows의 화면 읽기·훅 보완과 `/turn/` 주소를 적는다.

## 계획 리뷰 (기준 7059b0a + 이 문서)

### R1 [P2] 맨 아래 두 줄의 꼬리만 보면 일반 셸 출력도 작업 중 — 타당

- 근거: 처음 계획의 조건은 "빈 줄을 뺀 맨 아래 2줄 중 하나가 `esc to interrupt`로 끝남"이었다. 셸에서
  `printf 'esc to interrupt\n'`이 끝나면 맨 아래 두 줄이 그 문구와 프롬프트라 참이 된다. `checkDialog`는 모든 터미널에서
  돌고 claude가 끝나도 같은 PTY에 셸이 남으므로 띄운 명령으로 거를 수 없다.
- 수정: 설계 1을 입력란(가로줄·`❯` 줄·가로줄)과 footer가 화면 맨 아래에 차례로 있고 footer가 마지막 줄일 때만으로 바꿨다.
  시험에 셸 출력·로그 마지막 줄·footer 아래 다른 줄 음성 사례를 넣었다.

### 확인 질문 1: OSC 우선권의 수명 — 반영

- 지움(`state=clear`)을 받으면 우선권을 푼다. claude가 끝날 때 지움을 보내는 것을 본문에서 확인해 설계 3에 적었다. 지움 뒤 다시
  화면을 보는 시험을 넣었다.

### 확인 질문 2: 생성 응답 전 훅 이벤트 — 반영

- `chat-wake`와 같은 순서(등록 뒤 spawn, 이른 이벤트 모으기)와 seq를 설계 2에 적고, `devHooks.spawnDelay`로 이른 이벤트 시험을
  넣었다.

## 구현 (커밋 안 함, 기준 7059b0a)

- `src/programStatus.ts` readBusy·ScreenTurn, `src/Terminal.tsx` (합치기, `pty-turn` 리스너와 이른 이벤트), `src-tauri/src/chat.rs`
  `/turn/`·`Change::Turn`, `src-tauri/src/pty.rs` `{turn}`·`emit_turn`·`selftest_pty_turn`, `src-tauri/src/groups.rs` 차례 훅과 이전
  기본 v1·v2, `docs/spec.md`.

### 실제 claude로 확인한 것 (Windows, claude 2.1.316, 임시 단계·커밋 안 함)

ddak 시험 창의 세션 창(이름표 있음)에서 claude를 띄우고 이름표와 footer, 훅 기록(`cat >>` 훅)을 0.25초마다 남겼다:

- 작업 중 이름표 "working", 끝나면 사라짐. 수동 모드 footer도 `⏸ manual mode on · esc to interrupt`.
- **계획과 다름 1**: footer 뒤에 다른 안내가 붙기도 한다 (`… · esc to interrupt · ← for agents`, 짧게 보임). 줄 끝 대신 `·`로 나눈
  항목 중 하나가 `esc to interrupt`인지로 바꿨다 (단위 시험에 그 모양과 끝난 모양 `… · ← for agents`를 넣음).
- **계획과 다름 2 (한계로 둠)**: 작업 중에 입력란에 글을 쓰면 footer에서 `esc to interrupt`가 빠진다. Esc로 중단한 뒤에도 입력란에
  질문이 돌아오므로 입력란 글로 둘을 가를 수 없다. 그동안은 작업 중으로 보이지 않는다 (PC 앞에서 쓰는 동안. 폰에서 보는 경우는
  PC 입력이 없다). 스펙 한계에 적었다.
- Esc로 중단하면 `Stop` 훅이 오지 않는다 (UserPromptSubmit만 기록됨). 화면이 풀어 준다 (이름표 바로 사라짐).
- 훅은 Windows(Git Bash)에서 돈다. 모드가 없는 기본 모드는 이 계정에서 Shift+Tab으로 갈 수 없어 확인하지 못했다 (단위 시험의
  모양은 추정).

### 시험

- 단위 (`programStatusUnit`): readBusy 양성 6·음성 12 (리뷰 R1의 셸 출력·로그 마지막 줄·footer 아래 다른 줄 포함), 합치기 6.
- 앱 (`screenBusy`, 새 단계): 가짜 claude 화면(frame.py)으로 화면만, 출력이 마지막 줄에 남은 동안과 프롬프트로 돌아온 뒤의 같은
  글, 훅만, 본 차례의 화면 빠짐(Esc), 다음 차례, OSC 우선과 지움, PTY 번호 전 훅(spawnDelay). Windows에서 통과.
- 수정을 끄고 실패 확인: 구조 검사 없이 꼬리만 → 단위·앱(R1) 실패, seen 없이 `busy || hook` → 합치기·훅 차례 실패, OSC 우선 없이
  → OSC 시험 실패, 이른 이벤트 반영 없이 → 이른 차례 실패.
- Rust: `cargo test` 94 통과 (`/turn/` 204·400·404·405·403, 기본 설정의 차례 훅, v1·v2 → 새 기본, 저장된 창).
- Windows에서 함께 돌린 `programStatus`·`tabsAndSplits`의 실패 4건(OSC 물음에 답함, 링크 경로, 새 탭 루트, ⌘1)은 변경 전에도 같다
  (OSC 물음은 이번 원인 그 자체). 전체 selftest.sh와 맥은 돌리지 못했다 (맥 전용 도구).

## 코드 리뷰 (기준 7059b0a + 위 구현)

### R1 [P2] OSC 지움이 이전 프로그램의 훅 차례를 지우지 않음 — 타당

- 근거: 지움은 `status`만 비웠다. 상태를 보내는 동안에도 `pty-turn`은 ScreenTurn에 hook=true를 남기므로, 화면 작업 중을 못 본
  차례가 Stop 없이 끝나고(차례 중간에 claude를 끝냄) 지움이 오면 `current()`가 이전 hook=true로 셸을 작업 중으로 보였다. 맥도
  새 훅이 들어가므로 같은 일이 생긴다. 고치기 전 단위 순서 `S i C i S E`가 `WWWWW-`였다.
- 수정: `ScreenTurn.reset()`(훅·관측을 지움)을 OSC 지움에서 부른다 (`Terminal.tsx`). 화면은 다음 읽기가 정한다.
- 확인: 단위 "Stop 없이 지움" `WW--W-`, 앱 `screenBusy`에 "훅 시작 → 화면 작업 중 아님 → 상태 보고 → Stop 없이 지움 → 셸은 작업
  중 아님 → 다음 차례 훅은 다시"를 더함. Windows에서 통과, reset을 비우면 둘 다 실패 (`clearedOff:false`).

### 재리뷰 1회: R1 해소. R2 [P3] 종료 검사가 약해짐 — 타당, 반영

- 근거: R1 시험을 더한 뒤 `key("q")` 앞이 이미 작업 중이 아니라 `quitOff`가 작업 중 → 끝 전환을 보지 않았다.
- 수정: `q` 전에 `b`로 작업 중을 그리고 `beforeQuit`(작업 중)을 확인한 뒤 끝낸다. Windows에서 통과.
