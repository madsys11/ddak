# 폰에도 제한 초기화, 누른 뒤 알림 (2026-11-24)

## 요청 (사용자)

- 제한 초기화(2026-11-17-chat-reset-limits)를 폰에서도 쓰게 해 달라.
- 눌러도 성공했는지 알 수 없어서 몇 번씩 누르게 된다.

## 판단

- 알 수 없는 이유: 멈춘 그룹이 없으면 셈만 지워지고 화면에 바뀌는 것이 없다. 단추가 응답을 기다리지도 않아 겹쳐 누를 수 있었다.
- 맥과 폰이 같은 단추를 쓴다 (`src/ResetLimitsButton.tsx`). 상태 셋:
  - 보내는 동안: 꺼짐.
  - 성공: 2초 동안 "초기화됨 ✓"(Limits Reset ✓), 꺼진 채로 강조색 테두리. 그 뒤 원래대로.
  - 실패: 바로 원래대로 하고, 그 화면의 오류 줄(맥 패널 오류, 폰 빨간 안내)에 보인다.
- 폰 API: `POST /api/projects/<id>/reset-limits`. API 버전은 그대로 두고, `GET …/members`에 `resetLimits: true`를 더해
  받는 ddak인지 알린다 (`wakeLimit`과 같은 방식). 예전 ddak이면 폰은 단추를 숨긴다 (누르면 404가 나는 단추를 보이지 않게).
- 폰 단추 자리: 채팅 머리(제목 오른쪽, 홈 단추 왼쪽). 성공하면 참여자를 다시 읽어 멈춤 안내가 바로 사라진다.

## 수정

- `src/ResetLimitsButton.tsx` (새 파일): 위 상태. 화면이 사라진 뒤 온 응답은 버린다.
- `src/ChatPanel.tsx`: 머리 단추를 이것으로. `src/App.css`: `.chat-clear.done`.
- `src-tauri/src/mobile.rs`: `POST …/reset-limits` (`Chats::reset_limits`), members에 `resetLimits: true`.
- `src/mobile/api.ts`: `Members.resetLimits`, `api.resetLimits`. `src/mobile/MobileApp.tsx`: 채팅 머리 단추.
  `src/mobile/mobile.css`: `.bar-text` (머리의 글자 단추).
- 문구: `chat.resetLimitsDone` "Limits Reset ✓" / "초기화됨 ✓".
- spec: 자동 깨우기 제한의 제한 초기화, 협업 제한의 폰 항목, 폰 API·화면 목록.
- `scripts/selftest-plan.json`: 새 파일 규칙 (`addSession`, `mobileChatFilterUnit`).

## 확인

- `cargo test reset_limits_from_phone`: members가 `paused: ["origin"]`·`resetLimits: true`, POST 뒤 멈춤이 비고 다음 메시지는
  보류되지 않음. 전체 `cargo test` 143개 통과. tsc, `selftest-changed.mjs --check` 통과.
- 자체 테스트:
  - `mobileChatFilterUnit` (폰, 가짜 API): 보내는 동안 꺼짐(그때 다시 눌러도 보내지 않음), 성공하면 멈춤 안내가 사라지고
    "초기화됨 ✓"·꺼짐, 그때 눌러도 보내지 않음(보낸 수 1), 2초 뒤 원래대로, 실패하면 오류 안내와 바로 원래대로, members에
    `resetLimits`가 없으면(예전 ddak) 단추 없음.
  - `addSession` (맥): 앞 검사에 더해 누르면 "초기화됨"·꺼짐, 그 뒤 원래대로.
  - 대조: 성공 뒤 "초기화됨" 대신 바로 원래대로 하게 바꾸면 두 검사가 모두 실패하고 (`done=false`, `shown=false`), 되돌리면 통과
    (실제로 돌림).
- 전체 `scripts/selftest.sh` (화면 켜짐): `main` 말고 모든 시나리오 통과. `main`은 이번에 끝까지 돌았고,
  새 검사 둘과 메뉴·채팅 단축키 검사는 통과했다. 실패한 것:
  - 앞 기록의 기존 실패: `addSession` 첫 메시지 검사(`projectStatus`가 남긴 "@user narrow"), `sessionFollow` 예외(훅 curl
    `CODE404`)와 그 뒤 `gitGraph`·`projects`·`groupPick`·`groupErrorClear`·`lastExit`.
  - `chatFilter`의 "탭이 넘치면 다음 줄로" (`h=80/25`, 세 줄 높이 76 초과): 이 검사를 넣은 커밋 25ea0af(다른 세션)를 그대로
    꺼내 `chatFilter`만 돌려도 같은 값으로 실패한다. 이번 변경과 무관, 고치지 않음.
  - 실행마다 달라지는 것: `zoom` 배율 검사, `terminalSearch` 검색 검사, `addSession` 안의 권한 모드·세션 다시 시작·알림 배지 검사.
    `panels zoom terminalSearch addSession chatFilter`만 돌리면 변경을 넣은 쪽은 배율 4개·세션 다시 시작·알림 배지가, HEAD
    (135e16e, 변경을 stash)는 검색 1개가 실패했고, 전체 실행의 실패 목록과도 다르다. 이번 변경이 쓰지 않는 단계·검사라
    흔들림으로 보지만 원인은 찾지 않았다.

## 리뷰 1회 (origin/reviewer-2, #473)

첫 요청(#470)은 리뷰 세션이 도구 오류(`codex-code-mode-host` 없음)로 읽지 못해 다시 요청했다(#472).

### R1 · P2 · 타당 → 수정: 실패 뒤 다시 눌러 성공해도 이전 실패 오류가 남는다

- 판단: 타당. `ResetLimitsButton`은 실패 때만 `onError`를 부르고, 두 호출부(맥 `setError(String(e))`, 폰
  `setError(errorText(…))`)는 성공해도 그 오류를 지우지 않는다. 폰 `loadMembers`도 `setMembers`만 한다. 아래 대조 실험으로
  두 화면 모두 "초기화됨 ✓"과 실패 안내가 함께 남는 것을 확인했다.
- 수정: 단추가 오류를 직접 다룬다. props를 `onError` 대신 `setError`(그 화면의 오류 상태, 함수 갱신)와 `errorText`로 바꿨다.
  실패하면 보인 문구를 기억하고, 다시 성공하면 오류 줄이 아직 그 문구일 때만 지운다. 그사이 다른 오류(보내기 실패 등)로
  바뀌었으면 남긴다.
  - 맥은 실패를 만들 수 없어 `devHooks.resetLimitsFail`을 더했다 (`gitGraphFail`과 같은 방식, 자체 테스트만 켠다).
- 확인 (실패 → 성공 순서 검사 추가):
  - `mobileChatFilterUnit`: 실패해 오류 안내가 뜬 뒤 다시 눌러 성공하면 "초기화됨"이고 오류 안내가 없다 (보낸 수 3).
  - `addSession`: `resetLimitsFail`로 실패시켜 패널 오류 줄을 띄운 뒤 끄고 다시 누르면 "초기화됨"이고 그 오류가 없다.
  - 대조: 성공 때 지우는 줄을 빼면 두 검사가 실패하고 (`retried=false`, `true false`), 되돌리면 통과 (실제로 돌림).
  - tsc 통과.

## 재리뷰 1회 (origin/reviewer-2, #475)

통과, R1 해소. 한계: 새 앱 검사 통과와 대조 실패는 개발자 보고이고, 전체 main의 남은 실패(위 "확인")는 그대로다.
