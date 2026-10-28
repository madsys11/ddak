# codex 권한 확인을 폰에서 답하지 못함 (2026-10-28)

사용자 보고: codex 세션(origin/reviewer)의 권한 확인이 폰에서 "질문이 화면보다 길어 맥에서 답해야 합니다"로 나와 고를 수 없었다.

## 원인 (채팅 기록의 저장값으로 확인)

`readDialog`는 1번 선택지에서 위로 올라가며 가로줄이나 빈 줄 셋을 찾고, 그 아래를 질문으로 본다.
화면 맨 위까지 가도 경계가 없으면 질문이 잘렸을 수 있어 `complete: false`로 둔다. 그러면 채팅·폰에서 답할 수 없다.

같은 프로젝트 채팅 기록의 선택 창을 확인했다.

| 시각 | 답할 수 있음 | 질문 줄 수 | 질문 첫 줄 |
|---|---|---|---|
| 17:17:48 | 아니오 | 17 | Would you like to run the following command? |
| 19:50:42 | 아니오 | 44 | › [ddak] New chat message … (이전 대화 기록) |
| 19:50:52 | 아니오 | 39 | › [ddak] New chat message … |
| 19:50:56 | 예 | 19 | Would you like to run the following command? |
| 19:51:01 | 예 | 22 | Would you like to run the following command? |

- 17:17은 선택 창이 터미널 화면 맨 윗줄부터 차 있어서, 제목 위에 경계가 화면 안에 없었다.
- 19:50의 두 건은 codex 선택 창 위에 가로줄이나 빈 줄 없이 대화 기록이 붙어 있었다. 그래서 기록까지 질문으로 읽다가
  화면 맨 위에 닿았다.
- 폰의 문구("질문이 화면보다 길어")는 첫 경우에만 맞는다.

## 수정

codex 선택 창의 첫 줄은 정해진 제목이다. 그 제목 줄을 질문의 처음(경계)으로 본다 (`programStatus.ts` `DIALOG_TITLE`).

- 제목
  - `Would you like to run the following command?`: 실제 화면에서 본 것이다.
  - `Would you like to send input to terminal`, `Do you want to approve network access to `: codex 0.164 바이너리의 문자열에 있다.
  - `Would you like to make the following edits?`: codex 원본의 편집 승인 제목이다. 바이너리에서는 확인하지 못했다.
- claude의 `Do you want to proceed?`는 넣지 않았다. 명령 아래 마지막 줄이라 경계로 보면 위의 명령이 질문에서 빠진다.
  claude 선택 창은 위에 가로줄이 있어 이미 경계를 찾는다.
- 제목이 없는 모양은 예전처럼 화면 맨 위까지 경계가 없으면 답하지 않는다.
- codex가 스스로 줄인 명령(`[… 43 lines] ⌃a view all`)은 맥 화면에서도 줄여 보이는 그대로다.
  채팅에서 고르는 것은 맥에서 키를 누르는 것과 같으므로 따로 막지 않는다.

## 확인

- `programStatusUnit`에 세 경우를 넣었다. 화면 맨 윗줄부터 찬 codex 선택 창, 경계 없이 대화 기록 아래에 붙은 codex 선택 창,
  네트워크 승인은 질문이 제목부터이고 답할 수 있다. 위가 잘린 claude 모양("Do you want to proceed?")은 여전히 답할 수 없다.
- 제목 경계를 끄면 이 검사가 실패한다.
- 기존 선택 창 읽기 검사(claude 모양, 상자, 줄 수 자르지 않음)와 `promptAnswerUnit`은 그대로 통과한다.
- 바뀐 파일로 고른 자체 테스트(statusContrastUnit, programStatusUnit, promptAnswerUnit, programStatus, addSession)가 모두 통과했다.

## 리뷰 1차 (리뷰어 #326)

### R1 [P2] 명령 본문의 제목 문구에서 멈춰 위의 명령이 질문에서 빠짐 — 타당, 수정

확인: 위로 올라가다 처음 만나는 제목 줄에서 멈췄다. 그래서 heredoc 본문에 `Would you like to run the following command?`가
독립 줄로 있으면, 그 위의 `$ cat …`(또는 `$ rm -rf project; cat …`)가 질문에서 빠졌다. 그 결과 그 위 명령만 다른 두 창이
같은 창(`sameDialog`)으로 보였다. codex는 `$ `를 명령 첫 줄에만 붙이므로 본문 줄이 제목처럼 보일 수 있다.

수정 근거 (codex 원본 `list_selection_view.rs` render): 선택 창 머리(제목·Environment·Reason·명령)는 위에서부터 그린다.
머리가 공간보다 길면 아래를 잘라 `[… N lines] ⌃a view all` 한 줄로 바꾼다. 그래서 진짜 제목은 늘 화면 안에 있고,
본문에 나오는 같은 글은 그 아래다.

수정:
- 가로줄이나 빈 줄 셋 같은 경계를 찾으면 예전 그대로다.
- 경계 없이 화면 맨 위에 닿았을 때만 제목 규칙을 쓴다. 선택지 아래에 codex 안내(`… to confirm … to cancel`)가 있으면,
  모은 질문 가운데 **가장 위의** 제목 줄부터를 질문으로 보고 답할 수 있게 한다.
  - 진짜 제목보다 위에 같은 글이 있으면(대화 기록 등) 질문이 더 길어질 뿐, 명령이 빠지지는 않는다.
- codex 안내가 없으면(claude 모양 등) 제목 줄이 있어도 예전처럼 답하지 않는다.
- 제목은 원본 `approval_overlay.rs`의 것으로 맞췄다.
  - 명령 실행
  - 편집
  - 권한 부여
  - 터미널 입력 (기존 터미널, 번호)
  - 네트워크 승인
  - 줄 전체가 맞아야 한다.

확인 (`programStatusUnit`):
- 화면 맨 위의 codex 창, 대화 기록 아래에 붙은 codex 창, 네트워크 승인은 답할 수 있다.
- 본문에 제목 줄이 있는 heredoc 창은 진짜 제목부터 `$ cat <<'TXT'`까지 질문에 들어 있다.
- 본문의 제목이 있어도 그 위 명령만 다른 두 창(`cat` / `rm -rf project; cat`)은 다르다.
- codex 안내가 없는 창은 제목 줄이 있어도 답하지 않는다. 위가 잘린 claude 모양도 마찬가지다.

수정을 하나씩 끄고 돌린 결과:
- 가장 아래 제목을 쓰면 두 검사가 실패한다.
- 안내 조건을 빼면 한 검사가 실패한다.
- 제목 규칙을 끄면 한 검사가 실패한다.
- 수정 뒤 바뀐 파일로 고른 단계(programStatusUnit, promptAnswerUnit, programStatus, addSession 등)가 모두 통과했다.

## 재리뷰 1회차 (리뷰어 #328)

### R1 남은 조건: claude 안내도 codex 안내로 봄 — 타당, 수정

확인: 안내 검사 `/\bto confirm\b.*\bto cancel\b/`가 claude의 `Enter to confirm · Esc to cancel`도 통과한다.
그래서 위가 잘린 claude 창의 본문에 codex 제목 글이 있으면, 그 줄부터를 질문으로 보아 위의 명령이 빠졌다.

수정: codex 안내 모양만 받는다.
- codex 원본 `bottom_pane/popup_consts.rs` `accept_cancel_hint_line`이 만드는 안내는 `Press <키> to confirm or <키> to cancel`이다.
- 검사는 줄 앞뒤 공백을 빼고 `/^Press \S.* to confirm or \S.* to cancel\b/`로 한다.
- claude 안내는 `Press`로 시작하지 않고 `·`로 나뉘어 있어서 통과하지 않는다.

확인 (`programStatusUnit`):
- claude 안내를 단 위가 잘린 창은 본문에 codex 제목 글이 있어도 incomplete다.
- 그 위 명령만 다른 두 claude 창(`ls` / `rm -rf project`)은 다른 창으로 본다.
- 예전 안내 검사로 되돌리면 두 검사가 실패한다.

재리뷰 2회차(#330): 남은 조건까지 해결 확인, 새 차단 문제 없음.

전체 `scripts/selftest.sh` (화면 잠금이 풀린 뒤):
- restart·corrupt 등 다른 시나리오는 통과했다.
- main은 마지막 단계 `lastExit`(모든 터미널을 닫으면 빈 화면, 10초 시간 초과)만 실패했다.
  남은 창은 없었고 탭은 0이었다. 알려진 간헐 실패다(spec "알려진 문제").
- `lastExit`은 그 단계만 돌리면 통과한다.
- 화면 잠금 때 실패하던 트리 화살표, 배율, WebGL, 폰 채팅, 검색은 모두 통과했다.
