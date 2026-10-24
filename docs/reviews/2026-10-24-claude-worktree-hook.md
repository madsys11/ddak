# 실험: Claude Code worktree 훅 연결 (2026-10-24)

목적: claude가 스스로(또는 요청받아) worktree를 만들 때 ddak의 작업그룹 생성으로 이어 붙일 수 있는지,
그때 위험한 동작이 없는지 확인한다. 리뷰어와 합의한 1단계 실험이다. ddak 코드는 바꾸지 않았다.

## 환경

- Claude Code 2.1.310, 모델 haiku (동작 확인용).
- `<실험>/single`: 저장소 하나. `<실험>/multi`: git이 아닌 폴더 안에 저장소 `web`, `api`와 `notes.md`.
- 훅은 `claude --settings <실험>/settings.json`으로만 넣었다. 사용자 설정이 섞이지 않게 `--setting-sources project`.
  - `create.sh` (WorktreeCreate): 입력 JSON과 시각을 기록한다. cwd가 git 저장소면 `git worktree add`, 아니면 그 아래
    저장소마다 worktree를 만든 세트 폴더를 `<실험>/sets/` 아래에 만들고 경로를 출력한다.
    `EXP_FAIL`이면 실패, `EXP_SLEEP`이면 그만큼 기다린다.
  - `remove.sh` (WorktreeRemove): 입력만 기록하고 아무것도 지우지 않고 0으로 끝난다.
  - `subagent.sh` (SubagentStart): 시각과 `agent_id`·`agent_type`·`cwd`를 기록한다.
- print 모드(`-p --permission-prompts none --output-format stream-json`)로 도구 결과를 기록했다.
  종료 시 동작은 `expect`로 대화형 세션을 띄워 화면을 기록했다.

## 결과

| # | 실험 | 결과 |
|---|---|---|
| 1 | 메인 세션 `EnterWorktree` (저장소 하나) | 훅이 돌려준 경로로 이동. 권한 모드 default·manual 모두 승인 질문 없음 (`permission_denials` 비어 있음). 같은 프로세스라 대화는 그대로 이어짐 |
| 2 | 메인 세션 `EnterWorktree` (git이 아닌 여러 저장소 폴더) | 훅 입력 `cwd`가 그 루트 폴더. 세트 폴더로 이동, `ls`에 `api`, `web` |
| 3 | 메인 세션 훅 입력 | `session_id`, `transcript_path`, `cwd`, `prompt_id`, `hook_event_name`, `name`만. `agent_id`·`agent_type` 없음 |
| 4 | 서브에이전트 `isolation: "worktree"` | 같은 WorktreeCreate 훅이 불림. 입력에 `agent_id`·`agent_type` **없음** (문서와 다름). 이름이 `agent-<agent_id>`. 순서는 WorktreeCreate 시작 → 끝 → SubagentStart(`agent_id`, `agent_type: "iso"`, `cwd`=세트 폴더) |
| 5 | 서브에이전트 훅 실패 | Agent 도구가 그 오류로 실패. 격리 없이 실행하는 대체 동작 없음 |
| 6 | 훅 실패 (`exit 1`) | `WorktreeCreate hook failed: … exp: forced failure`. 세션은 원래 폴더에 남음. 만들어진 것 없음 |
| 7 | 훅 시간 초과 (`timeout` 3·5초, 훅은 8·12초) | `Hook cancelled`로 실패, 원래 폴더에 남음. claude가 20초 더 살아 있는 동안에도 훅의 나머지(만들기)가 실행되지 않음 → 시간 초과 때 훅 프로세스가 끝내진다 |
| 8 | `ExitWorktree` keep | 원래 폴더로 돌아감. Remove 훅 안 불림, 폴더 남음 |
| 9 | `ExitWorktree` remove | `Could not verify worktree state … Refusing to remove without explicit confirmation`으로 거부 |
| 10 | `ExitWorktree` remove + `discard_changes: true` | 승인 없이 Remove 훅 호출 (`worktree_path`, `cwd`=그 폴더). 훅이 지우지 않고 0으로 끝나도 claude는 "Exited and removed"라고 함. 폴더는 남음 |
| 11 | 대화형 종료: 여러 저장소 세트, 세션 이름 없음, `web/new.txt` 미커밋 | **묻지 않고** `Cleaning up worktree (no pending changes)…` → Remove 훅 호출. 루트가 git이 아니라 변경을 못 찾음 |
| 12 | 대화형 종료: 여러 저장소 세트, `-n named-b` | "This session was named … Keep the worktree to resume it later, or remove it" 선택지. 기본값 Keep |
| 13 | 대화형 종료: 저장소 하나, 이름 없음, `new.txt` 미커밋 | "You have 1 uncommitted file … A WorktreeCreate hook made this worktree, so Claude Code can't tell whether …" 선택지. 기본값 Keep |
| 14 | `claude -w <이름>` (신뢰 전 폴더) | `Workspace trust not yet accepted …`로 만들기 실패. 신뢰 질문의 기본 선택은 "No, exit" |

리뷰어 표의 항목별 판단:
- **경로 반환·승인 질문·대화 유지**: 문제없음 (1, 2).
- **새 탭 소속**: Claude 쪽에서 막는 것은 없다. ddak 쪽 문제다 (아래 "ddak 쪽 제약").
- **서브에이전트 입력 차이**: 문서의 `agent_id`·`agent_type`은 WorktreeCreate에 오지 않는다. 만드는 시점의 단서는 이름
  `agent-<id>` 하나다. 문서에 없는 관찰이라 버전마다 바뀔 수 있다 (4).
- **실패·취소·재시도**: 실패하면 이동하지 않고 claude 쪽에는 남는 것이 없다 (6, 7). 남는 것이 있다면 훅이 만들다 만 것이다.
- **종료·ExitWorktree**: 리뷰어가 사용하는 그룹을 지키려면 Remove 훅이 절대 지우지 않아야 한다. 11번이 실제로 확인한 위험이다.

## 설계에 주는 결론 (제안)

1. **Remove 훅은 지우지 않는다.** "claude 세션이 그 그룹을 떠났다"만 ddak에 알리고 0으로 끝낸다. 삭제는 ddak의 작업그룹
   끝내기(6단계)에서만 한다. 사용자가 claude의 종료 선택지에서 Remove를 골랐다면 ddak이 "작업그룹을 끝낼까요?"를
   따로 묻는 정도로 연결한다.
2. **ddak이 띄우는 claude에 세션 이름(`-n`)을 붙인다.** 이름이 있으면 11번(묻지 않는 정리) 대신 12번(기본값 Keep)이
   된다. 1번이 있어서 데이터는 안전하지만, claude가 "정리했다"고 잘못 말하는 일을 줄인다.
3. **훅은 ddak과 연결이 끊기면 취소로 본다.** 시간 초과 때 훅 프로세스가 끝내지므로 (7), ddak이 만들던 세트는 그 시점에
   되돌린다 (지금의 Undo). 그렇지 않으면 claude는 원래 폴더에 있는데 세트만 남는다.
4. **준비(setup)는 훅 안에서 기다린다.** 기다리는 동안 claude 화면에 `running WorktreeCreate hook · Ns`가 보인다.
   ddak이 넣는 훅의 `timeout`은 기본 600초보다 넉넉히 잡고, 준비 진행은 ddak의 준비 창에 보인다. 준비가 실패하면 훅이
   실패해 claude는 원래 폴더에 남는다 (6). "그래도 시작"을 고르면 그때 경로를 돌려준다.
5. **서브에이전트(`agent-<id>`)에는 작업그룹을 만들지 않는다.** 실패시키면 서브에이전트 자체가 실패하므로 (5),
   탭·리뷰어·준비 없이 worktree만 만든 가벼운 세트를 준다. claude는 이것을 정리하지 않으므로 (문서) ddak이
   SubagentStop(`agent_id`)을 받아 기록해 두고 작업그룹 끝내기 때 함께 정리한다. 이름 규칙은 문서에 없는 관찰이므로
   자체 테스트로 버전마다 확인한다.
6. **`-w`는 쓰지 않는다.** 신뢰 전 폴더에서 실패한다 (14). ddak은 지금처럼 cwd로 그룹 폴더에서 claude를 시작한다.

## ddak 쪽 제약 (소스 확인)

- 터미널은 탭 본문(`key={tab.id}`) 아래에 있다 (`src/Workspace.tsx`의 탭 본문 렌더링). 창을 다른 탭으로 옮기면
  React가 지웠다 다시 만들고, 그때 `pty_kill`이 불린다 (`src/Terminal.tsx`). claude를 새 그룹 탭으로 "옮기려면"
  터미널을 탭 밖 공통 층으로 빼는 구조 변경이 먼저 필요하다.
- 대안은 탭 자체를 새 작업그룹으로 바꾸는 것이다 (claude 창은 그대로, 리뷰어만 새 폴더에서 다시 시작, 원본 그룹 탭은
  다시 열기 규칙 필요). 두 방식의 선택이 2단계의 결정 사항이다.

## 부수 발견

- 실험 세션 화면에 `Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`가 떴다. claude 안에서 띄운
  프로세스는 `CLAUDE_CODE_*` 환경변수를 물려받는다. ddak을 claude 세션 안에서 띄우면 (`npm run tauri dev`) ddak 터미널의
  claude도 이것을 물려받아 대화 기록을 저장하지 않는다. `pty.rs`는 지금 환경을 그대로 넘긴다. Finder에서 띄운 ddak은
  해당 없다. PTY를 만들 때 이 변수들을 뺄지는 따로 정한다.
