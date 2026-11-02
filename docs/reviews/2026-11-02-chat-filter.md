# 채팅 필터 (2026-11-02, 계획)

## 요청

사용자: 채팅창에 글이 많아지면 보기 어렵다. 필터가 있으면 좋겠다. 정한 것 (채팅으로 물어 답을 받음):

- 넣을 곳: 맥/PC 채팅 패널(`src/ChatPanel.tsx`)과 폰 채팅(`src/mobile/MobileApp.tsx` `Chat`) 둘 다.
- 필터: A "나와 관련된 것만", C "작업그룹별". (B 참여자별, D 글자 검색은 하지 않음)

## 필터의 뜻

메시지 모양은 그대로다 (`chat.rs` Message: `from`, `to`는 실제로 받은 참여자 목록, `@all`이면 사용자 포함 모두).

- A 나와 관련된 것만: `from === "user"` 또는 `to`에 `"user"`가 있음. 세션끼리 주고받은 리뷰 요청·결과는 숨는다. 세션이 띄운
  선택 창·답 기록·권한 모드 기록(`prompt`·`answer`·`mode`)도 같은 규칙 (사용자에게 온 것은 `to`에 user가 있다).
- C 작업그룹: 고른 작업그룹 G의 메시지만. 메시지에 관계된 참여자 중 하나라도 G에 속하면 (`G/역할`, 앞부분은 `chat.rs`
  `group_of`와 같은 규칙: 첫 `/` 앞). 관계된 참여자 = `from`, `to`, 그리고 기록의 대상 세션 `answer.member`·`mode.member`
  (선택 창 답·권한 모드 기록은 `from: "user"`, `to: []`로 저장되고 대상은 member에만 있다: `prompts.rs` prompt_result,
  `modes.rs` mode_result. 리뷰 R1). 사용자가 G의 세션에게 보낸 것, G의 세션이 다른 그룹에 보낸 것도 들어간다.
  고를 수 있는 그룹: 지금 참여자의 그룹 + 받은 메시지 전체(필터 전)에 나온 그룹 (같은 관계 기준, 이름순). "모든 작업그룹"이 기본.
- 둘 다 켜면 둘 다 맞는 것만 (AND).
- 판정은 순수 함수 하나 (`src/chatFilter.ts`: `groupOf`, `involved`, `groupsIn`, `matches`)로 두고 두 화면이 같이 쓴다.
- 선택 창의 상태(마지막 답, `PromptChoices` `lastAnswers`)는 필터 전 받은 메시지 전체로 계산한다 (필터로 답 기록이 숨어도
  질문의 상태 표시는 그대로).

## 화면

- 맥 패널: 머리줄 아래 필터 줄. "나와 관련된 것만" 토글 단추 (켜짐 표시) + 작업그룹 선택 (`<select>`).
  필터가 켜져 있으면 줄 끝에 "숨김 N개" (그중 나에게 온 것이 있으면 "나에게 온 것 M개 포함"). 숨김 수는 받은 메시지 전체
  (필터 전) 기준이다 (폰은 지금까지 받은 페이지들). 맞는 메시지가 없으면
  "필터에 맞는 메시지가 없습니다". 필터를 바꾸면 맨 아래로 (최신).
- 폰: 대화 머리줄 아래 같은 필터 줄 (칩 모양 토글 + select). 숨김 수도 같게. "이전 메시지" 단추는 필터 결과가 0개여도
  더 받을 것이 있으면 그대로 보인다.
- 문구는 i18n 키 (`src/i18n/en.ts`·`ko.ts`. 폰도 같은 사전을 쓴다: `src/mobile/i18n.ts`).

## 기억

- 프로젝트마다 기억한다 (앱을 다시 켜도). 맥: `localStorage` `ddak.chatFilter` (프로젝트 경로 → {mine, group}),
  다른 화면 설정(`ddak.chatWidth` 등)과 같은 방식. 폰: `localStorage` `ddak.phone.chatFilter` (컴퓨터 id/프로젝트 → 같은 값).
  읽지 못하거나 모양이 틀리면 필터 없음.
- 고른 작업그룹이 지금 목록에 없어도 (세션이 다 나감) 그대로 두고 select에 그 이름을 보인다 (메시지는 남아 있을 수 있다).

## 안 바꾸는 것 (정한 이유)

- 읽음 처리·안 읽은 수: 지금 동작 그대로 둔다 (리뷰 R2: 두 화면이 다르다).
  - 맥 패널: 보고 있으면 (패널 열림·프로젝트 보임·창이 앞) 스크롤 위치와 관계없이 마지막 메시지까지 읽음 (`chat_seen`).
  - 폰: 화면이 보이고, 맨 아래(최신)를 보고 있고, 서버와 맞춘 상태일 때만 읽음 (`sync.ts` readTarget).
  - 그래서 필터로 숨긴 나에게 온 메시지도 위 조건이면 읽은 것이 된다. 대신 "나에게 온 것 M개 포함"으로 숨겨진 것을 알린다.
    필터별 읽음을 따로 세는 것은 이번 범위가 아니다.
- 폰의 페이지 나누기(`MessageView`, "이전 메시지"): 필터는 받은 메시지에만 건다. 받은 것 중 맞는 것이 적으면 "이전 메시지"를
  눌러 더 받는다 (서버 쪽 필터는 하지 않음: API 버전이 바뀐다).
- 서버(Rust)와 API: 바꾸지 않는다.
- 알림·배지·깨우기: 바꾸지 않는다 (보이는 것만 거른다).

## 시험

- `chatFilterUnit` (새 단계, 순수 함수): A·C·AND, `@all`, 사용자 메시지, 그룹 사이 메시지, `user`·그룹 없는 이름,
  선택 창 질문(`to: [user]`)과 실제 저장 모양의 답·모드 기록 (`{from: "user", to: [], answer: {member: "origin/dev", …}}`,
  `mode` 같음)이 고른 그룹에는 들고 다른 그룹에는 빠지는지, `groupsIn`이 member의 그룹도 내는지.
- 맥 패널 (새 단계 `chatFilter`, 실제 패널): `selftest_chat_join`으로 가짜 참여자(두 작업그룹)를 넣고 `chat_post`로 메시지를
  보낸 뒤, 토글·select를 눌러 보이는 메시지 id와 숨김 수, 맞는 것이 없을 때 문구, 다시 켠 뒤 기억(`localStorage`)을 본다.
  clickMenu를 쓰지 않아 Windows에서도 돈다.
- 폰 (`mobileChatUnit`에 더함): 가짜 API로 Chat을 그려 같은 것을 본다. 최신 페이지에 맞는 것이 없으면 안내와 "이전 메시지"가
  보이고, 눌러 받은 이전 페이지에서 맞는 것이 나타남. 필터가 컴퓨터/프로젝트마다 따로 복원됨. 숨긴 나에게 온 메시지가 있어도
  읽음 알림(`api.read`)은 지금 조건 그대로.
- 수정을 끄고 (필터를 늘 참으로) 새 검사가 실패하는지 본다.
- spec.md "채팅방 설계"에 필터를 적는다.

## 계획 리뷰 대응

| ID | 지적 | 판단 | 근거 | 수정 |
| --- | --- | --- | --- | --- |
| R1 (P2) | C가 from/to만 봐서 선택 창 답·모드 기록의 그룹을 못 찾음 | 타당 | `prompts.rs` prompt_result·`modes.rs` mode_result가 `post_note(..., USER, ..., Vec::new(), ...)`로 저장. 대상은 `answer.member`·`mode.member`에만 있음 | 관계된 참여자에 member를 넣음 (C·groupsIn). lastAnswers는 필터 전 전체로. 시험에 실제 저장 모양 추가 |
| R2 (P3) | "맨 아래를 보면 읽음"이 맥 구현과 다름 | 타당 | `ChatPanel.tsx` loadMessages·watching 효과가 스크롤과 관계없이 `chat_seen(last)` | 두 화면의 읽음 조건을 나눠 적음 (동작은 그대로) |
| 권고 | 폰 "이전 메시지" 유지, 그룹·숨김 수는 필터 전 기준, 시험 경계 | 반영 | — | 화면·시험 절에 적음 |

## 구현 (사용자 승인 뒤)

- `src/chatFilter.ts`: `groupOf`, `involved`(from·to·answer.member·mode.member), `matches`, `groupsIn`, `applyFilter`(보일 것·숨긴
  수·그중 나에게 온 수), `loadFilter`·`saveFilter`(켠 것만 저장, 깨졌으면 필터 없음).
- `src/ChatFilterBar.tsx`: 토글·작업그룹 select·숨긴 수. 맥 `ChatPanel`(머리줄 아래)과 폰 `Chat`(막대 아래)이 같이 쓴다.
  모양은 각자의 CSS(`App.css`, `mobile.css`, 테마 토큰). 폰의 select는 iOS 확대를 피하려고 16px 아래로 내리지 않는다.
- 필터를 바꾸면 맨 아래로. `lastAnswers`는 필터 전 전체. 문구는 i18n 키(`chat.filter*`). 자체 테스트는 시작할 때
  `ddak.chatFilter`를 지운다(`main.tsx`).
- spec.md "채팅방 설계"에 필터.

## 확인

- 새 단계 `chatFilterUnit`(순수 함수), `chatFilter`(맥 패널, 가짜 참여자 4명·메시지 5개, clickMenu 없음),
  `mobileChatFilterUnit`(폰 Chat을 가짜 API로: 계획의 `mobileChatUnit`에 더하는 대신 따로 둠). Windows에서 모두 통과,
  `mobileChatUnit`도 통과. tsc, selftest-changed --check 통과.
- 수정을 끄고 확인: `matches`를 늘 참으로 하면 필터 판정·숨긴 수·맥 패널·폰 첫 페이지 검사가 실패. `involved`에서 member를 빼면
  (R1 전) 판정·숨긴 수·고를 그룹 검사가 실패 (고를 그룹 검사는 답·모드 기록에만 나오는 그룹을 더해 실패하게 고침).
- 못 한 것: 맥 selftest.sh, 실제 폰 화면 (폰 화면은 iframe에 폰 CSS로 그린 것만 봄).

## 코드 리뷰 대응

| ID | 지적 | 판단 | 근거 | 수정 |
| --- | --- | --- | --- | --- |
| R1 (P2) | 폰에서 위쪽을 보다가 필터를 바꿔 맨 아래로 가도 읽음을 알리지 않음 | 타당 | `setFilter`가 `atBottom.current = true`만 하고, 뒤따른 스크롤의 onScroll은 `was`가 이미 참이라 `markRead`를 건너뜀. 시험으로 재현 (`60 → 60`) | `setFilter`를 `markRead` 뒤로 옮기고 마지막에 `markRead()` (send와 같음). `mobileChatFilterUnit`에 위쪽에서 새 메시지(61, 나에게 옴) → 결과 0개인 필터로 바꿈 → `api.read(61)` 검사. 수정을 빼면 실패, 넣으면 `60 → 60,61`. 맥 패널은 읽음이 스크롤과 관계없어 해당 없음 |
