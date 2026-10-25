# 상태 신호로 기다림 알림, 터미널 검색 (2026-10-25)

**요청**: orca 비교 보고서에서 다음으로 꼭 가져올 것 — (1) 상태 신호(OSC 7501)로 "사용자 필요" 알림, (2) 터미널 검색 ⌘F.
스크롤백 저장은 채팅방 기록과 CLI의 이어 가기로 충분하다고 보고 보류 (사용자와 합의).

## 1. 기다림 알림

- 전에는 권한 확인 알림이 claude 훅(`permission_prompt`, 약 6초 뒤)으로만 왔고 codex는 알림이 없었다.
- 수정: `pty_awaiting`이 기다림이 켜지는 순간(꺼짐→켜짐) 그 터미널의 채팅 토큰으로 `Chats::attention(token, kind, hook=false)`을
  부른다. 프론트가 무엇을 기다리는지 보낸다 (blocked의 kind, 종류가 없으면 blocked, 화면 선택 창이면 dialog). 문구는
  `notify.*`. 보고 있으면 생략은 그대로 (notify::send).
- 겹침: 처음엔 claude 훅이 그 터미널이 이미 기다림이면 건너뛰게 했다 (리뷰 R3에서 바꿈, 아래).
- 확인: Rust — set_awaiting은 기다리게 될 때만 토큰을 준다, token_awaiting; chat 서버 테스트에 attention(kind, hook) 경로.
  selftest addSession — 세션 asker가 OSC 7501 blocked(question)를 내고 1초 뒤 훅도 보내면 알림은 한 번,
  "is waiting for your answer". 겹침 막기를 끄면 두 번 (answer + permission), 상태 알림을 끄면 0개 (훅도 기다림이라 건너뜀)로
  실패했다.

## 2. 터미널 검색

- `@xterm/addon-search` 0.16.0 (xterm 6.0.0과 같은 날 나온 판). 터미널 메뉴 "찾기…"(⌘F) → 포커스가 있는 Terminal이 막대를 연다.
- 애드온 버그 우회: findNext가 새 옵션을 `lastSearchOptions`에 먼저 넣고 `didOptionsChange`로 비교해서, 검색어가 같으면 옵션을
  바꿔도 일치 목록을 다시 만들지 않는다 (대소문자 구분을 켜도 "3 of 3"). 검색어·옵션이 바뀔 때마다 `clearDecorations` 뒤에 찾는다.
  고치기 전 같은 검사가 "3 of 3"으로 실패했다.
- 색: 새 테마 토큰 `--search-match`, `--search-match-active` (두 테마 모두, #RRGGBB만 받는다).
- 확인: selftest terminalSearch — 메뉴로 열면 입력란 포커스, 대소문자 무시 3개, ↩ 다음·⇧↩ 이전, 선택이 지금 결과,
  대소문자 구분 2개, 정규식 2개, 결과 없음, Esc·×로 닫으면 터미널 포커스, 다시 열면 빈 입력. prefs 단계의 "번역 안 된 메뉴 없음".

## 리뷰 1차 (#108)

**R1 [P2] 잘못된 정규식에서 이전 결과 수가 남음 — 타당.** 애드온은 RegExp 예외를 던지고 결과 이벤트를 보내지 않는다. catch가
결과를 바꾸지 않았다. 수정: catch에서 강조를 지우고 결과를 "없음"(index -1, count 0)으로. 확인: terminalSearch에 정규식 켠 채
`xq-[` → "No results". 수정을 끄면 "1 of 2"가 남아 실패.

**R2 [P2] 다른 분할 창의 검색 입력란을 눌러도 고른 창이 바뀌지 않음 — 타당.** 막대가 mousedown 전파를 막고 입력란 focus에서
onFocus를 부르지 않았다. 수정: 입력란 onFocus → 그 Terminal의 onFocus (Workspace의 focus). 고른 창이 되면 Terminal이 터미널로
포커스를 옮기는데, 이 창의 검색 입력란에 포커스가 있으면 그대로 둔다. 확인: terminalSearch에 분할 창 A·B — A 검색을 연 채 B로 옮겼다가
A 입력란에 포커스 → A가 고른 창, 포커스는 입력란, 그 상태의 ⌘F는 A 입력란(B에 막대 없음). onFocus를 빼면 (false false),
포커스 유지를 빼면 (false true)로 실패.

**R3 [P2] 중복 방지가 상태→훅 순서에만 동작 — 타당.** 수정: 두 경로를 하나로 — 모든 Attention이 `Ptys::claim_attention`을
거친다. 같은 채팅 토큰의 터미널에 ATTENTION_GAP(10초, claude 훅은 약 6초 뒤) 안에 이미 알렸으면 건너뛴다. 터미널이 없는
토큰은 막지 않는다. 같은 터미널의 서로 다른 확인이 10초 안에 연달아 뜨면 두 번째는 알리지 않는다 (사용자는 이미 알림을
받았다). Change::Attention의 hook 구분은 필요 없어져 뺐다. 확인: Rust (claim_attention 시간 창, 모르는 토큰),
selftest addSession — asker(상태→훅)와 hookfirst(훅→상태) 모두 알림 한 번. 막기를 끄면 둘 다 두 번으로 실패.

## 리뷰 2차 (#110)

**R4 [P2] 10초 안의 별도 대기 요청도 버림 — 타당.** R3 수정(시간 창)은 답한 뒤 새로 뜬 확인도 버렸고, 시간을 notify의
"보고 있음" 검사보다 먼저 적어서 첫 알림이 생략됐어도 다음 것까지 막았다.
수정: 시간 창 대신 대기 한 번 단위로 합친다.
- 상태: set_awaiting이 꺼짐→켜짐마다 알릴 토큰을 준다. 다만 훅이 ATTENTION_GAP(10초) 안에 먼저 알렸고(hook_attention) 그 뒤
  기다림이 끝난 적이 없으면(훅 시각 > 직전 변경 시각) 같은 확인이라 주지 않는다. hook_attention은 한 번 쓰고 지운다.
- 훅: claim_hook_attention — 그 터미널이 지금 기다리는 중이면 상태로 이미 알린 확인이라 false, 아니면 시각을 적고 true.
- "보고 있음"으로 생략된 알림은 다음 대기를 막지 않는다 (대기마다 다시 판단).
확인: Rust — 새 대기는 또 알림, 대기 중 훅은 막음, 훅→상태는 하나, 그 대기가 끝난 뒤 새 대기는 알림, 끝난 대기 전의 훅은 새 대기를
막지 않음. selftest addSession twice — 답변 대기 → 작업 중 → 1초 뒤 권한 확인 대기에서 알림 두 번 (answer, permission).
asker·hookfirst는 계속 한 번. 직전 대기가 10초 안에 끝났으면 막게 바꾸면 twice가 한 번으로 실패했다.

전체 selftest 첫 실행에서 검색 "다시 열면 빈 입력, ×로 닫힘"이 한 번 실패했다 (× 뒤 activeElement가 body). 단계만, main만, 전체를
다시 돌리면 통과했고 재현하지 못했다. 실패 때 창 포커스·다시 포커스 결과·숨김을 남기게 하고 spec 알려진 문제에 적었다.
최종 확인: cargo test 86개, 전체 selftest 382개 통과.

## 설치 후 확인 (2026-10-25, 8ac2d6c)

- 사용자가 다른 창을 보는 동안 dev 세션(claude)이 질문 창(AskUserQuestion)을 띄우자 "답변을 기다립니다" 알림이 한 번 왔다
  (사용자 확인).
- 권한 확인 알림은 확인하지 못했다: 샌드박스 밖 명령이 지금 설정에서 자동 허용되어 권한 확인이 뜨지 않았다.
