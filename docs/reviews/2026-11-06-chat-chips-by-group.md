# 작업그룹 탭을 고르면 참여자 칩도 그 그룹만 (2026-11-06)

## 요청 (사용자, 채팅 #455·#457)

채팅창에서 워크트리(작업그룹 탭)를 고르면 입력창의 태그(참여자 칩)도 그 워크트리 것만 나오면 좋겠다.
제안(#456)대로 진행하기로 했다.

## 정한 것

- 그룹 탭을 고르면 입력란 위 참여자 칩에 그 그룹 세션만 보인다 (`groupOf`가 그 그룹인 참여자, 사용자 빼고). 전체 탭이면 지금처럼 모두.
- "모두" 칩:
  - 전체 탭이면 지금처럼 `@all`.
  - 그룹 탭이면 "이 그룹 모두"로 바꾸고, 그 그룹 세션 이름을 한꺼번에 넣는다 (`@g/a @g/b `).
    `@all`은 서버(`chat.rs` mentions)에서 보낸 사람 말고 모두이므로 다른 워크트리 세션까지 깨운다.
  - 그 그룹 세션이 하나뿐이면 그 칩과 같아서 보이지 않는다. 없어도 보이지 않는다.
- 그 그룹 세션이 지금 하나도 없으면 (고른 그룹이 나갔음) "이 작업그룹의 세션이 지금 채팅방에 없습니다"를 보인다.
- 입력란에 이미 쓴 멘션은 건드리지 않는다. 서버·API는 바꾸지 않는다.
- 맥 패널의 깨우기 대기 단추, 폰의 상태·권한 모드 칩은 각 참여자 칩을 따라 함께 걸러진다.

## 수정

- `src/chatFilter.ts`: `chipMembers(members, group)`, `everyoneMention(chips, group)` (전체면 `"all"`, 그룹이면 세션이
  둘 이상일 때 `"g/a @g/b"`, 아니면 null). 두 화면이 같이 쓴다.
- `src/ChatPanel.tsx`, `src/mobile/MobileApp.tsx`: 칩 목록을 `chipMembers`로, "모두" 칩은 `everyoneMention`으로
  (`data-mention`에 넣을 멘션). 폰 참여자 칩에 `data-member`를 붙인다 (검사용).
- 문구: `chat.allInGroup` "Whole group" / "이 그룹 모두", `chat.noGroupMembers`.
- spec "채팅방 설계" 필터 항목에 한 줄.

## 확인

- tsc 통과.
- 자체 테스트:
  - `chatFilterUnit`: 전체·origin(둘)·web(하나)·없어진 그룹의 칩과 모두 멘션.
  - `chatFilter` (맥 패널): origin 탭이면 칩이 origin 세션만, "이 그룹 모두"를 누르면 입력란이 `@origin/fa @origin/fb `,
    web 탭이면 `web/fa`만(모두 칩 없음), 전체 탭이면 `all`과 모든 세션.
  - `mobileChatFilterUnit` (폰): web 탭 `web/x`, origin 탭 `all,origin/dev,origin/rev`와 멘션 `origin/dev @origin/rev`,
    전체 탭이면 모두.
  - 대조: `chipMembers`가 그룹을 무시하게 바꾸면 세 검사가 모두 실패하고, 되돌리면 통과한다 (실제로 돌림).
- 폰 읽음 검사 3개(`mobileChatUnit` 1, `mobileChatFilterUnit` 2)는 이번에도 실패했다. 맥 화면이 꺼져 있었고(`pmset`
  UserIsActive 0), 앞 작업(2026-11-06-chat-links)에서 변경 없이 HEAD로 돌려도 똑같이 실패한 것이다.
- `restart`·`corrupt`·`resume` 시나리오는 모두 통과.
- 전체 main 시나리오는 화면이 꺼져 있어 돌리지 않았다 (앞 작업에서 그리기 검사로 중간에 멈춤). 화면이 켜졌을 때 돌려야 한다.

## 리뷰 1회 (origin/reviewer-2, #459)

통과, 차단 지적 없음. 한계: 전체 main 시나리오와 폰 읽음 검사는 화면이 켜졌을 때 다시 확인해야 하고, 실제 폰에서는 보지 않았다.
