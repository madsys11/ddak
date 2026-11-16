# 채팅 패널 여닫기 단축키 (2026-11-17)

## 요청 (사용자)

채팅창 열기/닫기에도 단축키가 필요하다.

## 정한 것

- 보기 메뉴에 "채팅 열기/닫기"("Open/Close Chat"), 단축키 ⌥⌘B (Windows Ctrl+Alt+B). 파일 트리 보이기 바로 아래.
  - 키: 파일 트리(왼쪽 패널)가 ⌘B라서 오른쪽 패널을 그 짝으로 했다 (VS Code의 보조 사이드바도 ⌥⌘B).
    다른 메뉴 단축키와 겹치지 않는다 (cargo test가 표의 중복을 본다).
  - 사용자가 다른 키를 원하면 `menu.rs`의 `TOGGLE_CHAT_KEY` 하나만 바꾸면 된다.
- 보이는 프로젝트의 채팅 패널을 여닫는다. 탭 바의 채팅 버튼과 같은 상태(`App.tsx` chatOpen)를 바꾼다. 열린 프로젝트가 없으면
  아무것도 하지 않는다.
- 체크 표시 항목으로 하지 않았다: 열림은 프로젝트마다라 프로젝트를 바꿀 때마다 메뉴를 다시 만들어야 한다.

## 수정

- `src-tauri/src/menu.rs`: `TOGGLE_CHAT`·`TOGGLE_CHAT_KEY`, 보기 메뉴 항목, `shortcuts()` 표(Windows `winkeys.rs`가 쓴다),
  `run`이 "menu" 이벤트로 보냄.
- `src/App.tsx`: "menu" 이벤트 `toggle_chat`이면 보이는 프로젝트(`activeRef`)의 `chatOpen`을 뒤집는다.
- 문구: `menu.toggle_chat` "Open/Close Chat" / "채팅 열기/닫기".
- spec: 채팅방 설계 화면 항목, 보기 메뉴의 패널 항목.

## 확인

- `cargo test menu::`: ⌥⌘B가 맞고 ⌘B·⌥⌘B가 서로 갈림, 단축키 표에 들어 있음, 표에 같은 단축키가 둘 없음.
  모든 단축키를 알아보는 기존 검사가 Alt를 몰라 실패해서, 단축키 문자열의 Alt를 읽게 고쳤다.
- 자체 테스트 `addSession` (testChatPanel 끝): `clickMenu("View", "Open/Close Chat")`로 실제 메뉴를 눌러 닫히고(탭 바 버튼도 꺼짐)
  다시 누르면 열림.
  - 대조: `App.tsx`가 이 메뉴를 무시하게 바꾸면 실패하고 (`false true`), 되돌리면 통과 (실제로 돌림).
- 전체 `cargo test` 통과. 자체 테스트는 제한 초기화(2026-11-17-chat-reset-limits)와 함께 돌렸다: `nativeMenu`(메뉴 목록에
  "채팅 열기/닫기"가 보임) 통과, 나머지 결과와 기존 실패는 그 문서.
- 직접 확인할 것: 실제 키 입력 ⌥⌘B (메뉴 단축키는 자체 테스트가 키를 누르지 못한다. 터미널에 포커스가 있을 때도 메뉴가 먼저 받는지).

## 리뷰 1회 (origin/reviewer-2, #465)

두 변경(제한 초기화, 채팅 단축키) 함께 통과, 차단 지적 없음. 한계: 전체 main은 폰 읽음·배율 실패와 terminalContrast 시간 초과로
중단됐고, HEAD의 화면 켜진 전체 main 대조가 없어 그 실패가 모두 이번 변경과 무관하다고 확정하지 못한다. 실제 ⌥⌘B와 Windows
Ctrl+Alt+B 입력(터미널 포커스 포함)은 직접 확인해야 한다.
