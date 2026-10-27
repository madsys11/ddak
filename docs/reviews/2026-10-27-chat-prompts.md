# 선택 창 답하기: 채팅·폰에서 고르기 (2026-10-27)

**요청** (사용자가 폰으로만 일하는 중): 권한 대기·답변 대기일 때 무엇을 묻는지 채팅에서 모른다. 푸시에 내용을 넣으면 읽기 어려우니
채팅에 보내고, 사용자가 명시적으로 고를 수 있어야 폰으로도 일할 수 있다. dev-review-10 세션이 답변 대기에서 막혀 있었다
(선택 창이 떠 있는 동안은 채팅 알림도 미뤄져 폰만으로는 풀 방법이 없음). 승인일 수 있는 선택지는 확인을 한 번 더 받기로 함.

**확인**: 계획서(`docs/mobile-plan.md`)는 D3에서 "폰에서 답하기"를 범위 밖으로 두었고, 2단계는 기다림의 종류만 보냈다.
D3을 사용자 결정으로 바꿨다.

**구현** (spec "선택 창 답하기"):
- `src/programStatus.ts` readDialog: 화면 아래쪽 40줄에서 번호 선택지(1부터, 둘 이상, 커서 정확히 하나)와 질문을 읽는다.
  `driveAnswer`: 알린 선택 창과 같은지 보고 화살표를 하나씩 보내 커서가 따라온 뒤에만 Enter.
- `Terminal.tsx`: 기다리는 동안 읽은 선택 창이 바뀔 때마다 `pty_dialog`(차례 seq). `prompt-answer`를 받으면 차례·내용을 본 뒤
  driveAnswer, 결과를 `prompt_result`로.
- `src-tauri/src/prompts.rs`: 열린 선택 창 (커서만 움직이면 같은 것, 바뀌면 닫고 새로, 5초 안에 같은 것이 다시 보이면 다시 엶),
  채팅에 올리기(`post_note`, 받는 사람 user, 세션은 안 깨움), 답하기(한 번에 하나, 10초), 결과 기록. 승인일 수 있는지(confirm).
- `chat.rs`: `Message.prompt`·`answer`, `post_note`, `member_of`. 선택 창 메시지는 채팅 알림을 내지 않는다 (기다림 알림이 알림).
- `mobile.rs`: `members`에 `prompts`, `POST …/answer`.
- 화면: `src/PromptChoices.tsx` (맥 채팅 패널·폰 같이), 확인 줄, 닫힘·보내는 중·오류, 답 기록 문구 (i18n).

**확인**:
- Rust 113개 통과. 새 테스트: 확인 규칙, 화면 따라가기(새로·같음·닫힘·다시 엶·바뀜·참여자 아님·선택지 없음), 답하기(프로젝트·선택지·
  보내는 중·다시·보내면 닫힘), Enter 뒤 다음 선택 창이 먼저 알려져도 답 기록 (처음엔 기록이 빠져 실패, 고침), 폰 API(prompts,
  answer 200·409·400, 기기 이름).
- 프론트 단위 (readDialog, driveAnswer): selftest `programStatusUnit`·`promptAnswerUnit`에 넣고, 화면이 잠겨 앱 자체 테스트를
  돌릴 수 없어 같은 검사를 Node로 돌려 통과 (esbuild로 `programStatus.ts`를 묶음). driveAnswer의 커서 확인을 끄면 실패.
- 자체 테스트 `testChatPrompt`(addSession 단계): picker.py(선택 창 흉내)로 채팅에 올라옴·확인 줄·취소·확인하고 보냄·화면이 바뀌면
  안 보냄·거절은 바로 보냄. **아직 돌리지 못함**: 2026-10-27 08:55부터 맥 화면이 잠겨 있어 WebKit이 타이머를 멈추고
  앱 자체 테스트가 진행되지 않는다 (두 번 시도, 앱 메인 스레드는 대기 상태, `CGSSessionScreenIsLocked` true).
- 실제 claude·codex 선택 창에서의 동작(화살표로 커서가 옮겨지는지)은 확인하지 않았다.

## 리뷰 1차 (#164)

화면이 잠긴 상태 확인: 설치한 ddak의 `caffeinate -i -w <ddak pid>`가 09:15에 떠 있다 (화면은 08:55에 꺼지고 잠김). 작업 중 상태는
프론트가 OSC 7501을 처리해 `pty_working`으로 알려야 생기므로, 설치한 앱의 화면은 잠긴 동안에도 터미널 출력을 처리하고 Rust를
부른다. 자체 테스트 앱이 멈춘 것은 잠긴 뒤 새로 띄운 창이라서로 보인다 (설치본의 선택 창·답하기 자체는 잠긴 상태에서 아직 확인 못 함).

**R1 [P1] 확인 뒤 쓰는 차례를 기다리는 사이에 선택 창이 바뀌어도 Enter가 나감 — 타당.** `write`는 `sending` 뒤에 예약만 하고,
확인은 예약 전에 했다. 수정: `driveAnswer`가 키마다 `send(data, ok)`를 부르고, 프론트는 쓰는 차례가 온 때 그때의 화면으로
`ok`(같은 선택 창, 기대한 커서, 취소 안 됨)를 본 뒤에만 쓴다. 확인: `promptAnswerUnit`의 "쓰는 차례를 기다리는 동안 질문이 바뀜"
(`changed`, Enter 없음). 이 확인을 끄면 Enter를 보내 실패 (Node로).

**R2 [P1] 질문 8줄 제한으로 다른 명령이 같은 선택 창으로 판정 — 타당.** 수정: 질문은 줄 수를 자르지 않고 전부 비교한다. 위 경계
(가로줄·빈 줄 셋)를 화면 안에서 못 찾으면 `complete: false` → 채팅에 올리되 답하지 않는다 (`answerable`, Rust `begin`이
`incomplete`로 거절). 확인: 위쪽 명령만 다른 긴 질문 둘이 다름, 경계 없는 화면은 `complete: false`, 잘린 선택 창은 Enter 없음
(Node), Rust `no_answer_when_question_is_cut`. 8줄 제한을 되돌리면 실패.

**R3 [P1] 시간 초과 재시도·다시 열기가 진행 중인 답을 취소하지 않음 — 타당.** 수정: 답마다 요청 번호. Rust `finish`는 지금 요청의
결과만 받는다 (앞 요청의 늦은 결과는 버림). 다시 열기는 보내던 답을 지우지 않는다. 프론트는 터미널마다 하나만 돌리고 새 답이 오면
앞의 것을 취소한다 (취소된 것은 더 쓰지 않음). 확인: Rust `answers_once`(10초 뒤 새 요청, 앞 요청 결과 버림, 버린 결과로 닫지 않음,
via는 새 요청의 것), `retry_after_failure_and_flicker`, `records_answer_after_screen_moved_on`(다른 요청 번호는 버림). 요청 번호를
보지 않게 하면 두 테스트 실패. 프론트 취소는 `promptAnswerUnit`의 "첫 키 뒤 취소" (Enter 없음).

**R4 [P2] 쓰기 실패를 보냄으로 기록 — 타당.** 수정: `send`가 쓰기 실패를 `error`로 돌려주고 `driveAnswer`는 `failed`. 큐 자체는
실패해도 이어 간다. 확인: `promptAnswerUnit`의 "Enter 쓰기 실패" → `failed`.

**R5 [P2] 실패한 답 뒤 다시 고를 수 없음 — 타당.** 수정: 화면은 선택 창마다 마지막 답 기록(`lastAnswers`)을 받아, 새 기록이 오면
보내는 중을 끝내고 바뀜·실패면 이유를 보이며 다시 누를 수 있게 한다. 결과가 12초 안에 오지 않아도 풀린다 (맥은 10초 뒤 다시 받는다).
Rust는 실패 뒤 다시 받는다 (`retry_after_failure_and_flicker`). 화면 동작은 앱 자체 테스트로만 볼 수 있어 아직 확인하지 못함.

## 재리뷰 1회 (#166)

R1·R2·R4·R5 해결 확인. **R3 남음 — 타당.** 프론트가 요청 번호의 선후를 보지 않고 도착한 이벤트로 지금 처리를 취소해서, 2→1 순서로
오면 새 요청(No)이 취소되고 앞 요청(Yes)이 Enter를 보냈다 (리뷰 세션이 실제 함수로 순서 역전을 주입해 재현).
수정: (1) 프론트 `AnswerRuns`: 터미널마다 본 가장 큰 번호를 기억해, 그 이하(늦게 온 앞 요청, 끝난 요청의 재전달)는 지금 처리를
건드리지 않고 버리고, 더 새 요청만 지금 것을 취소한다. (2) 키는 `prompt_write`로 쓰고, Rust `Prompts::guarded`가 잠금을 쥔 채
그 터미널의 그 선택 창에 지금 보내는 요청인지 본 뒤에만 쓴다 (확인과 쓰기 사이에 새 요청이 끼지 않게). 프론트가 어떤 순서로 받아도
앞 요청의 키는 Rust에서 막힌다.
확인: Rust `writes_only_for_the_current_request`(새 요청 뒤 앞 요청·다른 터미널·끝난 요청은 쓰지 않음, Enter 뒤 닫힌 것은 그 요청이면
씀), `promptAnswerUnit`의 2→1→2 재전달→3 (Node). 번호 비교를 빼면 각각 실패.

## 재리뷰 2회 (#168, 마지막)

R3의 순서 역전·재전달 차단은 해결 확인. **R6 [P1, 새 범위] 닫힌 선택 창의 요청으로 키를 쓸 수 있음 — 타당.** `guarded`가 닫힌
선택 창의 지금 요청도 허용해서, A가 닫히고 같은 터미널에 B가 열린 뒤에도 A의 키가 B에 들어갈 수 있었다. 테스트도 그 동작을
기대값으로 담고 있었다. 닫힌 선택 창에 키를 쓸 이유는 없다 (Enter가 마지막 키). 수정: 쓰기는 지금 열린 그 선택 창의 지금 요청만.
닫힌 것은 결과 기록(`finish`)만 받는다. 테스트를 "B로 바뀐 뒤 A의 키 0회", "B에 새 요청이 생긴 뒤 A의 키 0회", "B의 요청은 씀",
"닫힌 A의 결과 기록은 받음"으로 바꿈. 닫힌 것도 허용하던 동작으로 되돌리면 실패.
재리뷰 2회 한도라 이 수정은 리뷰를 받지 못했다. 사용자에게 남은 상태와 선택지를 보고했다.

## R6 추가 리뷰 (사용자 승인 #170, #174)

R6 해결 확인, 이번 수정 범위에서 새 차단 문제 없음. 리뷰 중 테스트 바이너리가 실패 확인용(수정을 끈) 빌드로 남아 있어
`writes_only_for_the_current_request`가 실패로 보였다. 지금 소스로 다시 빌드한 뒤 Rust 116개 통과, 리뷰 세션도 같은 바이너리로
`prompts::tests` 7개 통과를 확인했다. 실패를 확인한 뒤에는 수정을 되돌린 소스로 다시 빌드해 둔다.
남은 확인 (사용자가 맥에 돌아온 뒤, 커밋·설치 전): picker 자체 테스트(`testChatPrompt`·`promptAnswerUnit`를 포함한 전체 selftest),
실제 claude·codex 선택 창에서 고르기, 잠긴 맥에 폰으로 답하는 흐름.

## 자체 테스트·실제 CLI 확인 (사용자 #175 "테스트 진행해", 맥 화면 잠김 상태)

- 잠긴 맥에서 자체 테스트가 멈추던 것: 잠긴 뒤 새로 띄운 창은 WebKit이 타이머를 멈춘다. `selftest.sh`가 앱 설정의 창에
  `backgroundThrottling: disabled`를 더해 띄우게 해서 진행된다 (spec "자체 테스트").
- `testChatPrompt` 처음 실패: picker 창이 앞 검사들이 남긴 창 사이에서 폭 2칸이 되어 선택 창 줄이 접혀 화면을 넘쳤다
  (테스트 환경 문제. 프론트 디버그로 cols=2 확인). picker를 새 탭에 띄우게 고침 → 5개 통과. 수정을 끄고 확인:
  `needs_confirm`을 늘 거짓으로 하면 확인 줄·보냄·거절 검사 실패, 알린 선택 창과 비교하지 않게 하면 "바뀜" 검사 실패.
- 전체 `selftest.sh`: addSession(선택 창 검사 포함)·promptAnswerUnit·programStatusUnit 통과, restart·corrupt·resume 통과.
  main의 실패는 트리 화살표 회전·검색 닫기 포커스·WebGL·탭 폭 복원·groupEnd `late-there`·lastExit 빈 화면. 같은 단계를
  변경 전 코드(7ebfe1d, 같은 selftest.sh)로 돌려도 트리·검색·WebGL이 같게 실패한다 (잠긴 화면이라 화면 갱신 rAF가 멈춤,
  `vis=hidden raf=>3000ms`). 탭 폭·lastExit은 그 단계만 돌리면 지금 코드에서도 통과. `late-there`는 알려진 문제.
  화면을 푼 상태의 전체 실행은 사용자가 맥에 돌아온 뒤 한 번 더 돌린다.
- 실제 CLI (임시 단계, 커밋하지 않음): 세션으로 띄우고 채팅 답하기(`chat_answer`)로 둘째 선택지를 골라 화살표 이동을 봤다.
  - claude v2.1.311 (`--permission-mode default`, `touch probe.txt`): "Do you want to proceed?" 선택지 4개가 올라옴,
    "Yes, and always allow …"를 골라 보냄 기록, 파일 생김. 폴더 신뢰 창은 번호가 없어(`❯ No, exit` / `Yes, I trust this folder`)
    채팅에 오지 않았다 (작업그룹 폴더는 ddak이 미리 신뢰로 적어 보통 뜨지 않음, spec 한계에 적음). 긴 선택지가 줄을 넘으면
    공백으로 이어 붙여 경로 중간에 공백이 생긴다 (표시만).
  - codex v0.164.0 (`-a on-request -s read-only`, `touch probe2.txt`): "Would you like to run the following command?"과 이유·명령이
    질문으로, 선택지 3개, "Yes, and don't ask again …"을 골라 보냄 기록, 파일 생김.
- 남은 확인: 설치한 앱에서 맥이 잠긴 동안 폰으로 답하기 (설치본 창은 잠기기 전에 떠 있어 타이머가 멈추지는 않는 것으로 보이나,
  확인하지 않음).
