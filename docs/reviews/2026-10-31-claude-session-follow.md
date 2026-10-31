# 계획: claude 창을 다시 시작하면 마지막 대화를 이어 가기 (2026-10-31)

## 문제

rustlords의 dev 창(claude)을 다시 시작하면(↻ 또는 앱 재시작) 마지막 대화가 아니라 예전 대화가 열렸다.

- ddak은 창을 만들 때 정한 세션 ID(`PaneSession.sid`)로 `--session-id {session}`을 써서 시작한다. 이어서 하기는
  `--resume {session}`이다. claude 안에서 대화 ID가 바뀌어도 ddak은 그 사실을 모른다.
- rustlords의 기록: 4028a2a1 → `/clear` → 06ab1b30 → `/background` → ba07d2a2.
  - `~/.claude/daemon.log`에 `bg spawned ba07d2a2 (slash)`가 남아 있다.
  - 06ab1b30 transcript의 끝은 `continued-in`이다.
- 작업 공간 파일의 sid는 4028a2a1에 머물렀다.

## 실험 (Windows, claude 2.1.316, ConPTY에서 대화형으로 띄움)

`--settings`로 SessionStart·SessionEnd 훅을 걸고, 훅 입력(stdin JSON)을 파일에 붙였다.

| 동작 | 훅 기록 |
|---|---|
| `--session-id A`로 시작 | SessionStart `startup` A |
| `/clear` | SessionEnd `clear` A → SessionStart **`clear` B** (같은 프로세스) |
| 대화 1번 뒤 `/background` | SessionEnd `prompt_input_exit` A → 데몬 아래의 새 세션이 SessionStart **`fork` C** (같은 `--settings` 훅이 그대로 돈다) |
| `--resume A` (A가 쉬고 있음) | SessionStart `resume` A (ID 그대로) |
| `--resume C` (C가 백그라운드에서 돎) | 종료 코드 1. "That session is running in the background (C). Run `claude attach C` … or `claude stop C` first …" |
| `claude stop C` 뒤 `--resume C` (C가 대화 없이 넘어감) | 종료 코드 1. "No conversation found with session ID: C" (C transcript에는 메타 줄 두 개뿐) |
| `--session-id A` (A transcript가 있음) | 종료 코드 1. "Session ID A is already in use." |

- 빈 대화에서는 `/background`가 아무 일도 하지 않았다.
- 훅은 Git Bash에서 돈다. 기존 권한 확인 훅과 같다.

결론:

1. `/clear`: 새 ID가 SessionStart(`clear`)로 온다.
2. `/background`: 새 ID가 SessionStart(`fork`)로 온다. 데몬 쪽 세션이 ddak이 준 인자(같은 훅·같은 주소)를 그대로 쓰기 때문이다.
3. 지금의 "Start a new one? [y/N]"에서 y를 누르면 같은 sid로 `--session-id`를 하게 된다. 그 대화가 디스크에 있으면 "already in use"로
   실패한다 (별개의 기존 결함).

## 계획

### 1. SessionStart 훅으로 대화 ID 따라가기

- 새 자리표시자 `{sessionStart}`: 그 창의 `http://127.0.0.1:<포트>/session/<토큰>` (채팅 서버, `{attention}`과 같은 토큰).
- 기본 설정 claude의 `--settings`(args·resume 둘 다)에 SessionStart 훅을 더한다. matcher는 두지 않는다 (모든 source).
  - 명령: `curl -s -m 2 --data-binary @- {sessionStart} >/dev/null 2>&1 || true`
  - async로 하지 않는다. 연달아 온 두 SessionStart(`/clear` 두 번 등)의 순서가 바뀌지 않게 하기 위해서다. 로컬 요청이라 시작이
    늦어지는 정도는 작고, ddak이 없으면(앱 재시작 뒤 데몬 세션) 연결 거부로 바로 끝난다.
- 채팅 서버 `POST /session/<토큰>`: 검사는 `/attention/`과 같다 (Host·Origin 403, 모르는 토큰 404, POST만 405).
  - 본문 JSON의 `session_id`가 UUID 모양이 아니면 400. 맞으면 204.
  - 그 참여자의 (프로젝트, 창 키)와 새 ID·source를 프론트에 `session-id` 이벤트로 보낸다.
- 프론트: `PaneSession`에 `cur`(CLI가 지금 쓰는 대화 ID)를 더한다.
  - 이벤트의 창 키(= `sid`)로 창을 찾아 `cur`를 바꾸고 저장한다.
  - **`sid`는 바꾸지 않는다.** 채팅 이름(`.names.json`)의 키이고, 바꾸면 창 이름이 `-2`로 바뀐다.
- 띄울 때(`commandOf`):
  - 이어서 하기의 `{session}`은 `cur ?? sid`.
  - fallback(처음 인자로 새로 시작)의 `{session}`:
    - 그 창의 처음 인자에 `{sessionStart}`가 있으면(= ID를 알려 오는 창) 새 UUID를 쓴다. "already in use"를 피하기 위해서다.
      새로 시작하면 훅이 그 ID를 `startup`으로 알려 `cur`가 된다.
    - 없으면 지금처럼 `cur ?? sid`를 쓴다 (리뷰 R1). 알려 오지 않는 창에 새 UUID를 쓰면 저장할 길이 없다. 그러면 다음 재시작에
      다시 앞 ID로 이어 가려다 실패한다.
  - 처음 띄울 때는 지금처럼 `sid`.
  - Rust `pty_spawn`에 `fallbackVars`(fallback에만 덮어쓸 값)를 더한다. 자리표시자는 지금처럼 Rust가 한 번에 바꾼다.
- 따라가는 source: 모두. `resume`·`compact`는 같은 ID라 바뀌는 것이 없다. claude 안의 `/resume <다른 대화>`도 그 창이 지금
  쓰는 대화이므로 따라간다.

### 2. 이어서 하기가 실패할 때 (백그라운드 등)

- ddak은 CLI 출력을 해석하지 않으므로 "running in the background"를 따로 알아보지 않는다.
- claude가 이미 `claude attach C` / `claude stop C`를 안내하므로, 묻는 문구를 바꾼다:
  `[ddak] Could not continue the previous session (exit N). See the message above; after fixing it, restart with ↻. Start a new conversation instead? [y/N]`
  (기존처럼 터미널 문구, Rust 상수. 앱 화면 문구가 아니라 i18n 대상이 아니다).
- 훅이 있는 창은 y를 누르면 1번의 새 UUID로 시작하므로 "already in use"로 실패하지 않는다 (훅이 없는 창은 지금과 같다).
- 사용자가 터미널에서 `claude stop C`를 한 뒤 ↻를 누르면 `--resume C`로 이어 간다. 다만 C가 백그라운드에서 대화 없이
  넘어갔으면 "No conversation found"가 된다. 이 경우는 한계로 적는다 (그 앞 대화는 `claude --resume <앞 ID>`로 손으로
  열 수 있지만 ddak 인자는 빠진다).

### 3. 이미 있는 설정과 열린 창

- 이미 있는 `groups.json`과 저장된 탭은 만들 때의 인자를 그대로 쓴다. 그대로 두면 새 훅이 어디에도 걸리지 않는다
  (지금 사용자의 `groups.json`도 이전 기본값 그대로다).
- **이전 기본값과 똑같은 것만 새 기본값으로 바꾼다** (사용자가 고친 것은 건드리지 않는다).
  - Rust에 이전 기본 claude 인자(args·resume 한 쌍)를 상수로 둔다.
  - `groups.json`: 읽을 때(`groups_load`) 세션의 (args, resume)이 이전 기본과 정확히 같으면 **메모리에서만** 새 기본으로
    바꾼다. 파일은 다시 쓰지 않는다 (리뷰 질문).
    - 그래서 읽기·저장이 겹치거나 백업·교체가 실패하는 경우가 생기지 않는다.
    - 사용자가 고친 형식·다른 키도 그대로다.
    - 매번 읽을 때 같은 규칙으로 바뀐다.
    - 대가: 파일에는 이전 인자가 보인다. 그 세션 인자를 고치면 정확히 같지 않게 되어 훅이 빠진다. spec에 "고칠 때는 새 기본
      인자(훅 포함)를 넣는다"고 적는다.
  - 저장된 창: 그룹 설정과 함께 이 (이전 → 새) 대응을 프론트에 넘긴다. 작업 공간을 읽을 때 `PaneSession`의 (args, resume)이
    이전 기본과 같으면 바꾼다 (다음 저장 때 파일에 남는다). `sid`·`prompt`는 그대로다.
  - 고친 설정·창은 그대로 둔다. spec에 "새 기본 인자를 직접 넣거나 창을 새로 만든다"고 적는다.
- 이미 떠 있는 claude 프로세스에는 새 훅이 없다. 다음 ↻나 앱 재시작부터 적용된다.

### 하지 않는 것

- transcript의 `continued-in`을 따라가는 대안은 쓰지 않는다.
  - `/clear`는 앞 transcript에 다음 ID를 남기지 않는다.
  - claude 내부 파일 형식에 기대게 된다.
- codex는 그대로다 (`resume --last`). 세션 ID를 알리는 훅이 없다.

## 시험

- Rust `chat.rs`: `/session/<토큰>` 204와 이벤트(창 키·ID·source). UUID가 아니면 400, 모르는 토큰 404, GET 405, 다른 Host 403.
- Rust `groups.rs`: 기본 설정의 SessionStart 훅에 `{sessionStart}`가 있다. 이전 기본 인자인 세션은 읽은 결과에서 새 기본으로
  바뀌고 파일 내용은 그대로다. 고친 세션은 그대로다.
- Rust `pty.rs`: `fallbackVars`가 fallback에만 들어간다. `{sessionStart}`가 그 창 주소로 바뀐다.
- 자체 테스트 (가짜 명령으로 인자를 찍는 세션):
  - 그 창 주소로 SessionStart 본문을 POST하면 `cur`가 바뀌고 저장된다.
  - ↻ 뒤 명령이 `--resume <cur>`이고, 채팅 이름은 그대로다.
  - `resume-save`→`resume-check`: 앱 재시작 뒤에도 `cur`로 이어 간다.
  - 훅이 없는 사용자 정의 인자 창 (리뷰 R1): 이어서 하기 실패 → y → fallback이 `sid`로 시작한다. 저장 뒤 복원하면 `sid`로
    이어 간다. 훅이 있는 창은 fallback이 새 UUID다.
  - 이전 기본 인자의 저장된 창이 새 인자로 바뀐다.
- 수정을 끄고 새 시험이 실패하는지 본다 (CLAUDE.md).
- 실제 claude로 한 번: ddak 창에서 `/clear` 뒤 ↻ → 새 대화로 이어진다.

## 리뷰 대응

| ID | 판단 | 근거 | 계획 수정 |
|---|---|---|---|
| R1 (P2) | 타당 | `commandOf`(workspaceState.ts:162-167)는 모든 세션 구성이 함께 쓴다. 고친 인자는 바꾸지 않으므로 훅이 없다. 그 창에서 fallback이 새 UUID B로 시작하면 B를 저장할 길이 없다. 다음 재시작은 다시 A로 이어 가려다 실패한다 (지금은 A로 새로 만들어 다음에 A로 이어 간다). | 처음 인자에 `{sessionStart}`가 있는 창만 fallback에 새 UUID. 그 밖에는 `cur ?? sid`. 시험 추가. |
| 질문 (groups.json 다시 쓰기) | 반영 | 파일을 다시 쓰면 감시로 읽기가 겹치고, 백업·교체 실패를 따로 정해야 한다. | 파일을 쓰지 않고 읽을 때 메모리에서만 바꾼다. |

## 구현 (사용자 승인 뒤)

- `groups.rs`
  - claude `--settings`를 상수 `CLAUDE_SETTINGS`(Notification + SessionStart)로 뺐다. TEMPLATE의 `@CLAUDE_SETTINGS@` 자리에 넣는다.
  - 이전 값은 `OLD_CLAUDE_SETTINGS`로 둔다. `claude_upgrade`가 두 값으로 만든 기본 dev 인자 쌍(이전 → 새)을 한 번 만든다.
  - `upgrade_args`는 이 쌍과 정확히 같은 (args, resume)만 바꾼다.
  - `groups_load`는 읽은 뒤 메모리에서 바꾼다. `upgrade_saved`는 작업 공간 JSON의 `sessions.*`를 바꾼다.
- `workspace.rs` `load`: 읽은 JSON에 `upgrade_saved`를 적용한다 (바꾼 것이 있으면 그 내용). 파일은 다음 저장 때 바뀐다.
- `chat.rs`
  - `POST /session/<토큰>`: 검사는 `/attention/`과 같다. 본문의 `session_id`가 UUID 모양이 아니면 400.
  - `Change::Session { key, id, source }`를 앱이 `session-id` 이벤트(`{ project, key, id, source }`)로 보낸다.
- `pty.rs`
  - `{sessionStart}` 자리표시자를 더했다.
  - `pty_spawn`에 `fallbackVars`를 더했다 (fallback에만 덮어쓴다).
  - 묻는 문구를 바꿨다 (ASCII만 쓴다. 셸 인자로 넘어가므로 ↻ 대신 "Restart Session").
- 프론트
  - `workspaceState.ts`: `PaneSession.cur`, `commandOf`(`{session}` = `cur ?? sid`, 알려 오는 창만 `fallbackVars`의 새 UUID),
    `followSession`.
  - `Terminal.tsx`: `fallbackVars`를 넘긴다.
  - `Workspace.tsx`: `session-id`를 받아 창 키로 창을 찾고 `cur`를 바꾼다. 떠 있는 터미널은 띄울 때만 명령을 읽어서 다시 뜨지
    않는다.
- 시험
  - Rust: `groups::upgrades_only_untouched_old_default`, `default_is_valid`(훅), `chat::mcp_over_http`(`/session/`),
    `pty::chat_url_fills_args_and_leaves_on_close`(`{sessionStart}`, `fallbackVars`).
  - 자체 테스트: `workspaceStateUnit`(cur 읽기, `commandOf`, `followSession`), 새 단계 `sessionFollow`.
    - 알려 오는 창: POST → `cur` 저장 → ↻ → cur로 이어서 하기 → 실패 → y → 새 UUID. 채팅 이름은 그대로.
    - 알려 오지 않는 창: y → 같은 sid.
  - 복원 시나리오의 묻는 문구 검사를 새 문구로 고쳤다 (접힌 줄을 이어 붙여 본다).

## 확인 (Windows 11, 이 PC)

- tsc, `selftest-changed --check` 통과.
- `cargo test`: 94개 중 83개 통과, 11개 실패.
  - 실패 11개(worktrees 9, repos 1, claude_trust 1)는 모두 심볼릭 링크를 만들지 못한 것(`os error 1314`)이다. 이 PC는
    Windows 개발자 모드가 꺼져 있다. 이번 변경과 상관없는 파일이다.
  - 바꾼 곳의 시험(`groups::*`, `chat::tests::mcp_over_http`)은 통과한다.
  - 수정을 끄면(`upgrade_args`가 늘 바꿈, `/session/` 처리 끔) 두 시험이 실패한다.
- `pty.rs` 시험은 `cfg(all(test, unix))`라 이 PC에서는 돌지 않는다. 고친 단언문(`fallbackVars`, `{sessionStart}`)은 같은 모양을
  떼어 따로 컴파일·실행했다. 맥에서 `cargo test`로 확인해야 한다.
- 자체 테스트: `selftest.sh`는 맥 전용이라 main 시나리오 준비만 따라 한 스크립트로 앱을 띄웠다.
  - `workspaceStateUnit`·`sessionFollow` 통과.
  - 수정을 끄면 `sessionFollow`가 실패한다. 이어서 하기에 `cur`를 안 쓰면 "cur로 이어서 하기" 검사가, 모든 창에 새 ID를 쓰면
    "같은 ID로 시작 (R1)" 검사가 실패한다.
  - 복원 시나리오(`resume-save`→`resume-check`, 묻는 문구 검사)와 전체 `selftest.sh`는 맥에서 돌려야 한다 (여기서는 못 돌림).
- 실제 claude로 ddak 창에서 `/clear` 뒤 ↻ 하는 확인은, 이 변경을 담은 앱을 설치한 뒤에 한다.

## 코드 리뷰 대응

| ID | 판단 | 근거 | 수정 |
|---|---|---|---|
| R1 (계획 리뷰) | 해소 확인 | 리뷰어가 구현에서도 확인했다. | — |
| R2 (P3) | 타당, 수정 | 가짜 follower가 fallback으로 새로 시작한 뒤 startup을 알리지 않았다. 그래서 새 ID가 `cur`로 저장되고 다음 ↻가 그 ID를 쓰는 연결을 시험하지 않았다. | follower가 시작할 때마다 받은 `{session}`을 startup으로 POST한다. 검사를 더했다: y로 새로 시작 → 그 ID가 `cur`로 저장 → 다시 ↻ → 그 ID로 이어서 하기. Windows에서 통과한다. `session-id`를 무시하게 바꾸면 이 검사와 앞의 두 검사가 실패한다. 앱 재시작 시나리오(`resume-check`)에 cur ≠ sid 복원을 넣는 것은 하지 않았다. 맥 `selftest.sh`로만 돌고 여기서 검증할 수 없어서, 검증하지 못한 시험 코드를 더하지 않는다. 복원 경로는 `fromSaved`가 `cur`를 읽는 검사와 `commandOf`가 `cur`를 쓰는 검사(workspaceStateUnit)가 나눠 본다. |

## spec.md에 고칠 곳

- "세션은 이어서 하기로 띄운다" (`cur`, fallback의 새 ID, 문구)
- 자리표시자 `{sessionStart}`
- 기본 설정 (훅)
- 기존 설정 바꾸기
- 한계 (백그라운드로 넘어간 뒤 대화가 없는 경우)
