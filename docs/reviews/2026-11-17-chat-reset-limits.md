# 채팅 머리에 협업 제한 초기화 단추 (2026-11-17)

## 요청 (사용자)

채팅창의 대화 지우기 옆에 협업 제한(Collaboration Limits)을 초기화하는 단추가 필요하다.
"초기화"가 무엇인지 물었고, 사용자가 "주고받은 셈 초기화"를 골랐다 (설정값을 기본값으로 되돌리는 것이 아님).

## 정한 것

- 채팅 패널 머리, 대화 지우기 왼쪽에 "제한 초기화"("Reset Limits") 단추. 늘 누를 수 있다.
- 누르면 이 프로젝트의 모든 작업그룹 자동 깨우기 셈을 지운다.
  - 멈춘 그룹은 재개 단추와 같이 풀린다: 보류된 알림은 (받는 사람, 보낸 사람)마다 한 번 깨운다.
  - 아직 멈추지 않은 그룹도 처음부터 다시 센다 (재개 단추는 멈춘 그룹에만 나온다).
  - 다른 프로젝트, 협업 제한 설정값(`wakeLimit`·`reReviews`)은 그대로.
- 확인은 받지 않는다: 지우는 것이 메모리의 셈뿐이고 (앱을 다시 켜도 지워진다), 대화나 설정은 건드리지 않는다.
- 폰에는 넣지 않았다 (요청은 맥 채팅창).

## 수정

- `src-tauri/src/chat.rs`: `Chats::reset_limits(project)` (그 프로젝트의 셈을 모두 지우고 보류분을 `Released`로 한 번,
  `Limits` 알림. 셈이 없으면 아무것도 하지 않음), 명령 `chat_reset_limits` (`lib.rs`에 등록).
- `src/ChatPanel.tsx`: 머리의 단추 (`data-action="chat-reset-limits"`, 실패하면 패널 오류 줄).
- `src/App.css`: 머리 단추는 한 줄로(`nowrap`, `flex: none`), 제목은 좁으면 말줄임 (패널 최소 폭 240).
- 문구: `chat.resetLimits` "Reset Limits" / "제한 초기화", `chat.resetLimitsHint`.
- spec: 자동 깨우기 제한의 풀기 항목, 채팅 패널 머리.

## 확인

- `cargo test reset_limits_clears_every_group_of_the_project`: 멈춘 g1 풀림과 보류분 한 번, 멈추기 전 g2의 셈도 처음부터,
  다른 프로젝트 그대로, 셈 없는 프로젝트는 알림 없음.
  - 대조: 멈춘 그룹만 지우게 바꾸면 g2 검사("g2의 앞 셈이 남음")에서 실패하고, 되돌리면 통과 (실제로 돌림).
- 자체 테스트 `addSession` (testChatPanel): chatter를 세 번째로 띄워 멈춘 뒤 머리의 단추를 누르면 멈춤 표시가 사라지고,
  listener가 보류된 알림을 한 번 받고, `chat_paused`가 빔. 단추가 대화 지우기 바로 앞인지도 본다.
  - 대조: 단추가 아무것도 하지 않게 바꾸면 이 검사가 실패하고 (`3→3 bar=true backend=origin`), 되돌리면 통과 (실제로 돌림).
- tsc 통과, 전체 `cargo test` 통과 (142개, 두 변경을 넣고).
- 전체 `scripts/selftest.sh` (화면 켜짐): `restart`·`corrupt`·`resume`·나머지 시나리오 통과. `main`은 아래 실패로 멈췄다.
  - 폰 읽음 검사 3개 (`mobileChatUnit` 1, `mobileChatFilterUnit` 2): 앞 작업들에서 HEAD로도 실패한 것.
  - `zoom` 배율 검사 4개와 `terminalContrast` 시간 초과(300초)로 main이 `addSession` 전에 멈춤. `panels zoom zoomIme terminalContrast`만
    돌리면 HEAD(70b2c03, 변경을 stash)에서도, 변경을 넣고도 모두 통과한다. 이번 변경은 이 단계들이 쓰는 파일을 건드리지 않는다.
    전체 실행에서만 나는 이유는 찾지 않았다 (HEAD의 전체 main은 화면이 켜진 채로 다시 돌리지 않았다).
  - 그래서 `terminalContrast` 뒤 단계를 따로 돌렸다 (채팅 단축키 변경과 함께): 새 검사는 통과. 실패는 앞 기록
    (2026-11-05-chat-filter-tabs)의 기존 실패와 같다: `addSession`의 첫 메시지 검사(`projectStatus`가 남긴 "@user narrow"),
    `sessionFollow` 예외(훅 curl `CODE404`)와 그 뒤 `gitGraph`·`projects`·`groupPick`·`groupErrorClear`·`lastExit`.

## 리뷰 1회 (origin/reviewer-2, #465)

두 변경(제한 초기화, 채팅 단축키) 함께 통과, 차단 지적 없음. 한계: 전체 main은 폰 읽음·배율 실패와 terminalContrast 시간 초과로
중단됐고, HEAD의 화면 켜진 전체 main 대조가 없어 그 실패가 모두 이번 변경과 무관하다고 확정하지 못한다. 실제 ⌥⌘B와 Windows
Ctrl+Alt+B 입력(터미널 포커스 포함)은 직접 확인해야 한다.
