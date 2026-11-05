# 채팅 필터를 작업그룹 탭으로, 대화 제한 기본 12 (2026-11-05)

## 요청 (사용자)

- 협업 제한(Collaboration Limits)의 기본값을 12로 올린다.
- 채팅 필터가 쓰기 불편하다. 필터는 "나에게 보낸 글만" 하나면 되고, 전체 / 워크트리1 / 워크트리2처럼 워크트리별로 볼 수 있으면
  좋겠다. 워크트리를 여럿 쓰면 보기 힘들다.

## 판단

- "12"는 대화 제한(`wakeLimit`, 지금 기본 10, 범위 1–100)이다. 재리뷰 횟수는 범위가 0–5라 12가 될 수 없다.
  - Rust `chat.rs` `DEFAULT_WAKE_LIMIT`와 프론트 `src/limits.ts` `DEFAULT_LIMITS.wakeLimit`를 12로 바꾼다.
  - `limits.json`에 값을 저장한 적이 없는 앱만 바뀐다. 창에서 저장한 값은 그대로다 (지금 이 맥에는 `limits.json`이 없다).
  - 폰의 `DEFAULT_WAKE_LIMIT`(맥이 `wakeLimit`을 알려 주지 않는 예전 ddak용)는 10 그대로 둔다. 그 ddak의 실제 값이 10이다.
    그래서 "폰 기본 = 데스크톱 기본" 검사는 "폰 기본은 예전 고정값 10, 데스크톱 기본은 12"로 바꾼다.
- "워크트리"는 작업그룹이다. 작업그룹을 추가하면 새 worktree 세트를 만들고, 참여자 이름의 앞부분(`그룹/역할`)이 그 작업그룹이다.
  지금 필터의 작업그룹 판정(`groupOf`, 관계된 참여자)을 그대로 쓰고 모양만 바꾼다.
- "나에게 보낸 글만"은 말 그대로 받은 사람에 user가 있는 메시지(`@user`, `@all`)로 한다. 지금의 "나와 관련된 것만"은
  사용자가 보낸 것도 보였는데, 이것은 빠진다.
  - 저장 키(`mine`)는 그대로 둔다. 예전에 켜 둔 필터는 새 뜻으로 켜진 채 열린다.

## 수정

- `src/chatFilter.ts` `matches`: `mine`이면 `to`에 user가 있어야 한다 (보낸 사람 조건 뺌).
- `src/ChatFilterBar.tsx`: 작업그룹 `<select>`를 탭 줄로 바꾼다. 탭은 "전체", 그다음 그룹 이름순(`groupsIn` 그대로, 고른 그룹은
  없어져도 탭으로 남음). 고른 탭은 `aria-pressed`와 강조색 밑줄. 탭이 넘치면 가로로 밀린다 (스크롤바는 숨김).
  "나에게 온 것만" 토글은 탭 줄 오른쪽. 숨긴 수는 그대로.
- CSS: `App.css`·`mobile.css`의 `.chat-filter-group`(select)을 `.chat-filter-tabs`·`.chat-filter-tab`으로. 색은 기존 토큰.
- 문구: `chat.filterMine` "To me" / "나에게 온 것만", `chat.filterMineHint`, `chat.filterAllGroups` "All" / "전체".
- spec "채팅방 설계" 필터 항목, "협업 제한"의 기본값 고침.

## 확인

- tsc 통과, `cargo test` 141개 통과.
- 자체 테스트:
  - `chatFilterUnit`: 기대값을 새 뜻으로 바꿨다 (나에게 온 것만 `3,4,9`, web과 함께면 `4`, 숨김 6). 예전 판정이면 실패한다.
  - `chatFilter`(맥 패널): select 대신 탭을 누른다. 탭은 "전체"가 먼저이고 처음에 눌려 있는지, 나에게 온 것만이면 `F3,F5`
    (사용자가 보낸 F1 빠짐)인지 본다.
  - `mobileChatFilterUnit`(폰): 기억한 그룹이 눌린 탭인지, 탭을 눌러 바꾸면 맨 아래로 가며 읽음을 알리는지 본다.
  - 위 셋을 단독으로 돌려 모두 통과했다.
- 전체 `scripts/selftest.sh`: 다른 네 시나리오는 통과. main 시나리오는 아래 기존 실패가 있다 (이번 변경과 무관, 이번에 고치지 않음).
  - `addSession`의 "채팅 패널: … 세션이 보낸 메시지(나에게)…": 앞 단계 `projectStatus`가 남긴 `w/a`의 "@user narrow"가 첫 메시지가
    된다 (2e887e2에서 들어온 검사). 변경을 빼고(HEAD 692bc5c) `projectStatus addSession`만 돌려도 똑같이 실패한다.
  - `sessionFollow` 예외 (훅 curl이 `CODE404`): 변경을 빼고 `sessionFollow`만 돌려도 똑같이 실패한다. 뒤의 `gitGraph`·`projects`·
    `groupPick`·`groupErrorClear`·`lastExit` 실패는 이 단계가 남긴 창·탭 때문이다 (변경을 넣고 그 단계들만 돌려도 같은 실패).
  - 깨우기 제한 검사들(`addSession` 안)은 통과했다. 폰 기본 수 검사 "예전 ddak의 고정값" 통과 (10 12).

## 리뷰 1회 (origin/reviewer-2, #448)

통과, 차단 지적 없음. 한계: main 시나리오의 기존 실패는 개발자 재현이고 리뷰에서 다시 돌리지 않았다. 탭의 실제 가로 넘침·배치는
맥·폰 화면에서 직접 확인한다.
