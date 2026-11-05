# 채팅 글 속 웹 주소를 링크로 (2026-11-06)

## 요청 (사용자, 채팅 #450)

채팅창에 claude 시안처럼 아티팩트 url이 나와도 클릭해서 열 수가 없다.

## 지금 동작

- 맥 채팅 패널(`ChatPanel.tsx`)과 폰 채팅(`mobile/MobileApp.tsx`)은 글을 `{m.text}` 그대로 그린다. 주소도 글자일 뿐이다.
- 터미널은 ⌘+클릭으로 주소·경로를 연다 (`terminalLinks.ts`, `links.rs` open_link).

## 수정

- `src/urls.ts` (새 파일): 웹 주소 정규식 `URL_RE`와 끝 문장 부호 `TRAIL_RE`를 `terminalLinks.ts`에서 옮기고, 글을 주소와
  나머지로 나누는 `splitUrls`를 둔다. 폰 화면도 쓰므로 Tauri API를 들이지 않는다. 터미널 링크 판정은 그대로 (같은 정규식).
- `src/ChatText.tsx` (새 파일): 주소는 `<a>`, 나머지는 글 그대로.
  - 맥(`onOpen` 있음): 클릭하면 기본 동작(웹뷰 이동)을 막고 `openLink`(`open_link`)로 기본 브라우저에서 연다.
    터미널과 달리 그냥 클릭이다. 채팅 글은 선택·창 고르기에 클릭을 쓰지 않는다.
  - 폰(`onOpen` 없음): `target="_blank" rel="noopener noreferrer"`.
- 일반 메시지 글에만 쓴다. 선택 창 질문(고정폭 터미널 글)과 답·모드 기록 문구는 그대로다.
- 파일 경로는 링크로 만들지 않는다. 채팅 글의 상대 경로는 어느 폴더 기준인지 알 수 없고, 폰에서는 열 수 없다.
- CSS: `.chat-text a`(맥), `.text a`(폰). 강조색, 긴 주소는 아무 데서나 줄을 바꾼다.
- spec "채팅방 설계"에 한 항목.

## 확인

- tsc 통과, `selftest-changed.mjs --check` 통과 (새 파일 두 개를 `rules`에 넣음).
- 자체 테스트:
  - `chatLinksUnit` (새 단계): `splitUrls`가 주소만 나누고 끝의 `.`·`)`는 글로 남기는지, 빈 주소·빈 글. 폰 모양으로 그리면
    글은 그대로이고 a가 하나, `href`·`_blank`·`noopener noreferrer`인지.
  - `chatLinks` (새 단계, 실제 맥 패널): 세션이 보낸 "@user L1 <주소>."에서 주소 링크를 누르면 `open_link`로 그 주소
    (마침표 뺌)만 열리고 웹뷰 주소는 그대로인지.
  - 대조: `ChatPanel`에서 `ChatText` 대신 예전처럼 `{m.text}`로 두면 `chatLinks`가 실패한다 (링크 없음).
  - `terminalLinksUnit`·`terminalLinks` 통과 (정규식을 옮긴 뒤에도 같음).
- 폰 읽음 검사 세 개(`mobileChatUnit` 1, `mobileChatFilterUnit` 2)가 이번 실행에서 실패했다. 변경을 빼고(HEAD 9060d4c) 같은 두 단계만
  돌려도 똑같이 실패한다. 그때 맥 화면이 꺼져 있었고(`pmset` UserIsActive 0), 폰 화면은 보일 때만 읽음을 보낸다. 이번 변경과 무관.
- 대조는 실제로 돌렸다: `{m.text}`로 두면 `chatLinks`가 `false undefined []`로 실패하고, 되돌리면 통과한다.
- 전체 `scripts/selftest.sh`: 다른 네 시나리오는 통과. main은 맥 화면이 꺼진 동안 돌아 앞쪽의 그리기·애니메이션 검사
  (트리 화살표 회전, 배율 캔버스 맞춤)가 실패하고 `terminalContrast`가 300초 시간 초과로 멈춰 뒤 단계는 돌지 않았다.
  화면이 켜진 때 전체를 다시 돌려야 한다. 이번 변경이 닿는 단계(`chatLinksUnit`·`chatLinks`·`chatFilter`·`terminalLinksUnit`·
  `terminalLinks`)는 따로 돌려 통과했다.

## 리뷰 1회 (origin/reviewer-2, #452)

통과, 차단 지적 없음. 대상 파일은 수정 8개(요청에는 7개로 잘못 적음)와 새 파일 3개. 한계: 전체 main은 화면이 켜진 때 다시
돌려야 하고, 실제 폰·외부 브라우저로 여는 것은 확인하지 않았다.
