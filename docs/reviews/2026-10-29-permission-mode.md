# 권한 모드 바꾸기 (폰) — 2026-10-29

## 배경

자동 모드의 claude 세션이 운영 조회 명령을 자동 권한에 막혀, 사용자에게 `!`를 붙여 직접 실행해 달라고 했다. 폰에서는 터미널에
명령을 넣을 수 없고, 자동 모드에서 막힌 명령은 선택 창 없이 거절되어 "선택 창 답하기"로 올라오지도 않는다.
사용자 결정: 그 세션을 수동(기본) 모드로 바꿔 권한 확인 창이 뜨게 하고, 모드 바꾸기를 폰에서 할 수 있게 한다.

## 사전 확인

- claude 2.1.312를 PTY로 띄워 Shift+Tab(`ESC [ Z`)을 보냈다: 자동 → 수동 → 편집 허용 → 계획 → 자동으로 돌고, 지금 모드는
  맨 아래 줄 `⏵⏵ auto mode on (shift+tab to cycle)`, `⏸ manual mode on · ? for shortcuts`, `⏵⏵ accept edits on …`,
  `⏸ plan mode on …`에 나온다.
- 그 출력을 @xterm/headless 6.0.0에 다시 그려 `readMode`와 같은 정규식으로 읽었다: 다섯 화면 모두 맞게 읽음
  (빈 줄을 뺀 맨 아래 두 줄 중 마지막이 모드 줄, 그 위는 경고 줄).

## 설계

- 프론트가 모드 줄을 읽어 `pty_mode`로 알린다. 선택 창이 떠 있는 동안은 모드 줄이 가려지므로 지난 모드를 둔다.
- 바꾸기는 "선택 창 답하기"와 같은 틀이다: 요청 번호, 한 터미널에 하나(`AnswerRuns`), 키는 Rust가 지금 요청인지 다시 보고
  쓰고(`mode_write`), 결과는 사용자 이름의 기록(`mode`)으로 남긴다.
- 키마다 쓰는 차례에 선택 창이 없고 기다리지 않고 모드 줄이 그대로인지 본다. Rust도 사용자를 기다리는 터미널에는 받지 않는다.
- 처음에는 최대 4번 누르고 bypass는 고르는 목록에서만 뺐다 (아래 리뷰 1차 R1·R2로 바꿈).
- codex는 하지 않는다 (`/approvals` 창으로 바꾼다).

## 확인

- Rust: `modes::tests::begins_only_for_one_idle_terminal` (모드 이름, 터미널 없음·둘·기다림, 바꾸는 중, 10초 뒤 새 번호,
  앞 요청의 키·결과 버림), `mobile::members_carry_session_status`에 `modes`와 `POST …/mode`(200·409·400, 기기 이름).
  Rust 133개 통과. 전체 `selftest.sh` 다섯 시나리오 통과 (PASS 513).
- `permissionModeUnit`: 모드 줄 읽기 8가지, `driveMode` 11가지 (한 번·세 번, 이미 그 모드, 안 바뀜, 지난 모드로 돌아옴,
  줄이 사라짐, 쓰는 차례에 바뀜, 쓰기 실패, 모드 다섯이면 4번, 여섯이면 실패).
- `addSession`의 `testChatMode`: claude 모드 줄 흉내(moder.py)를 채팅 참여자로 띄워 모드를 알림, 수동(1번)·계획(2번)으로
  바꾸고 기록, bypass 거절, 선택 창이 떠 있으면 `awaiting`으로 거절하고 키를 보내지 않으며 모드는 그대로, 모드 줄이 따라오지
  않으면 한 번만 누르고 `failed` 기록.
- `mobileChatUnit`: 모드를 아는 참여자만 모드 칩, 누르면 고르는 창(지금 모드는 못 누름), 거절 이유 표시 뒤 다시 고르면
  보내고 닫힘.
- 수정을 끈 대조:
  - Rust의 기다림 거절과 프론트의 "선택 창 동안 지난 모드 두기"를 함께 끔 → 선택 창 검사 실패 (모드가 사라져 `none`).
  - Rust의 기다림 거절만 끔 → 선택 창 검사 실패 (프론트가 키를 막아 `changed` 기록이 남음, 키는 나가지 않음), 다음 검사도
    기록 순서가 어긋나 실패.

## 리뷰 1차 (reviewer-2 #391)

**R1 [P2] 고르지 않은 bypass를 지나가고, 실패하면 거기 남음 — 타당.** 5모드 순서(manual → acceptEdits → plan → bypass → auto)를
지원하려던 설계에서는 auto로 가는 길에 bypass가 켜진다. 목록에서 빼는 것만으로는 "폰에서 권한 확인을 모두 끄지 않는다"를
지키지 못한다.
- bypass가 도는 순서의 어디에 끼는지 확인하려 했다: `claude --allow-dangerously-skip-permissions`는 시작하자마자 bypass 동의
  창을 띄우고, 동의하면 사용자의 claude 설정에 남는다. 사용자 설정을 바꾸지 않으려고 동의하지 않았고, 순서는 알 수 없다.
- 수정: bypass를 켤 수 있는 세션은 아예 바꾸지 않는다 (`modes.rs` `bypass_possible`, Rust가 `bypass`로 거절). 띄운 인자
  (`pty.rs` Session `argv`: 명령과 이어서 하기 실패 때 쓸 것까지), 지금 앞에서 도는 프로세스의 인자 (맥 `ps -o args=`, 읽지
  못하면 켤 수 있다고 봄), 작업 폴더와 그 위 폴더들의 `.claude/settings(.local).json`, 사용자 설정 폴더, 관리 설정에
  `skip-permissions`·`bypassPermissions`가 있거나 있는 파일을 읽지 못하면 켤 수 있다고 본다. 지금 bypass인 세션도 거절.
  이 맥의 `~/.claude/settings.json`에는 없다 (확인함).
- 순서는 2.1.312에서 본 네 모드로 정하고 (R2), 많아야 3번 누른다.
- 확인: Rust `sees_bypass_in_args_and_settings` (세 가지 인자, `--permission-mode=bypassPermissions`, 설정의 defaultMode, 폴더라
  읽지 못하는 설정, `disableBypassPermissionsMode`는 아님, 살피는 파일 목록), `begins_only_for_one_idle_terminal`에 bypass 가능·
  지금 bypass 거절. `testChatMode`: 작업 폴더에 `.claude/settings.local.json`(defaultMode bypassPermissions)을 두면 `bypass`로
  거절. 거절을 끄면 Rust 테스트 실패.

**R2 [P2] 예상과 다른 모드나 화면 소실 뒤에도 키를 보냄 — 타당.** `from`과 다르기만 하면 한 단계로 받았고, 모드 줄이 사라져도
기다리다 다시 보이면 이어 갔다. 승인한 설계("예상과 다르면 멈춤")와 스펙("사라지면 changed")과 다르다.
- 수정 (`programStatus.ts` driveMode): 키마다 순서(`MODE_CYCLE`: 자동 → 수동 → 편집 허용 → 계획)의 바로 다음 모드만 받는다.
  다른 모드로 바뀌면 `failed`, 읽기가 한 번이라도 null이면 바로 `changed`. 순서에 없는 모드에서 시작하면 키 없이 `failed`.
  Terminal.tsx의 읽기는 사용자를 기다리거나 화면에 선택 창이 있으면 null이다 (선택 창이 뜨면 멈춘다).
- 확인: `permissionModeUnit`의 바꾸기 11가지를 새 규칙으로 (다음이 아닌 모드로 바뀜 → `failed:1`, 한 번 사라졌다 돌아옴 →
  `changed:1`, bypass에서 시작 → 키 없이 `failed`). `testChatMode`: moder.py에 "다음 Shift+Tab에 선택 창도 띄움"(p)을 더해, 계획
  → 수동(2번 필요)이 첫 키 뒤 선택 창에서 멈추고 `changed` 기록, 키는 하나. 예전 규칙으로 되돌리면 단위 검사 실패.
- Rust 134개 통과. 전체 `selftest.sh`: restart·corrupt·resume·resume-save 통과, main은 PASS 513에 `검색: 터미널 메뉴 찾기(⌘F)로
  막대가 열리고 입력란에 포커스` 하나가 실패했다 (상세 없음, 포커스 검사). 이번 변경은 검색과 닿지 않고, 그 단계만 다시 돌리면
  통과한다 (바로 앞 전체 실행도 통과). 바뀐 범위의 단계(permissionModeUnit, mobileChatUnit, addSession)는 통과.

## 재리뷰 1회 (reviewer-2 #394)

R2 해결 확인 (최대 3번도). **R1 남음 [P2] — 타당.**
- ① `--settings <파일>`로 준 설정 파일을 보지 않았다: 인자에도 표준 설정 파일에도 그 글이 없어 통과한다 (claude 2.1.312
  `--help`: `--settings <file-or-json>`).
- ② 앞 프로세스를 찾지 못하거나 Windows면 빈 인자로 보고 통과했다. "모르면 거절"이라는 목적과 다르다.
- 실행 뒤 관측(다음 모드 검사)으로는 이미 bypass가 켜진 뒤라 막을 수 없다는 점도 맞다.

수정 (`modes.rs` `bypass_possible(argv, cwd, fg, standard)`):
- 앞 프로세스는 `Foreground::Args`(ps 출력을 빈칸으로 나눔) 또는 `Unknown`(Windows, 프로세스를 찾지 못함, ps 실패·빈 출력).
  `Unknown`이면 켤 수 있다고 본다. Windows에서는 모드 바꾸기가 늘 `bypass`로 거절된다 (스펙 한계에 적음).
- `settings_args`: `--settings <값>`·`--settings=<값>`에서 `{`로 시작하면 JSON(이미 글로 봄), 아니면 파일. 띄운 인자의 상대 경로는
  작업 폴더 기준, 앞 프로세스 인자의 상대 경로는 그 프로세스의 폴더를 몰라 켤 수 있다고 본다. 값이 없어도 켤 수 있음. 이 파일들은
  없거나 읽지 못하면 켤 수 있음 (claude가 그 파일을 읽는다고 한 것이라).
- ddak의 기본 claude 인자는 `--settings`에 JSON(`{"hooks":…}`)을 주므로 막히지 않는다 (ps로 나뉜 JSON 조각은 `--settings` 바로
  뒤가 아니면 글로만 본다).
- 폰 문구 `mode.err.bypass` 추가 (전에는 코드만 보였다).

확인: Rust `sees_bypass_in_args_and_settings`에 ddak 기본 인자는 통과, `--settings` 상대 경로·`=` 형식·절대 경로(bypass 설정)는
거절, 문제없는 파일은 통과, 없는 파일·값 없음은 거절, 앞 프로세스의 상대 경로는 거절·절대 경로는 읽어서 판단, `Unknown`은 거절.
대조: `--settings` 파일 읽기를 빼면 실패, `Unknown`을 빈 인자로 보면 실패. `mobileChatUnit`에 `bypass` 거절 문구. Rust 134개 통과.
전체 `selftest.sh` 다섯 시나리오 통과 (PASS 514).

## 재리뷰 2회 (reviewer-2 #397) — 리뷰 횟수 끝, 사용자 결정: 고치고 후속 리뷰 1회 (#400)

R2 해결 유지. **R1 남음 [P2] — 타당.** 설정을 원문 글로만 찾아서, 유효한 JSON 이스케이프
(`{"permissions":{"defaultMode":"bypassPermissions"}}`)로 쓴 bypass 설정을 놓친다 (`--settings` JSON 값과 설정 파일 모두).
해석하지 못하는 설정을 허용 근거로 삼으면 안 된다는 점도 맞다.
고친 것: 설정(인라인 JSON, `--settings` 파일, 표준 설정 파일)을 serde_json으로 해석해 키·문자열 값을
이스케이프를 푼 뒤 보고, 해석하지 못하면 켤 수 있다고 본다. 앞 프로세스의 인자는 ps 출력을 빈칸으로 나눠서는 JSON을 되살릴 수
없으므로 정확한 인자 목록(맥 sysctl `KERN_PROCARGS2`)으로 읽고, 읽지 못하면 켤 수 있다고 본다.

- `risky_settings`: serde_json으로 해석해 키·문자열 값(배열·객체 안까지)을 본다. 해석하지 못하면 켤 수 있음, 빈칸뿐이면 설정
  없음. `--settings` JSON 값, `--settings` 파일, 표준 설정 파일에 모두 쓴다. 인자 자체의 글 검사는 그대로 둔다.
- `process_args`: 맥은 sysctl `KERN_PROCARGS2`(argc, 실행 파일 경로, NUL 채움, NUL로 나뉜 인자), 리눅스는 `/proc/<pid>/cmdline`.
  읽지 못하면 `Unknown`(켤 수 있음). ps는 쓰지 않는다.
- 이 저장소 코드 중 ddak 기본 세션 인자(`--append-system-prompt` 프롬프트 포함)에는 그 글이 없다 (확인함).

확인: Rust `sees_bypass_in_args_and_settings`에 이스케이프한 bypass(`--settings` JSON 값, `--settings=` JSON, 앞 프로세스의
`--settings` JSON, `--settings` 파일, 표준 설정 파일), 해석하지 못하는 인라인 JSON·파일, 빈 설정 파일은 괜찮음, 배열 안 객체의
키. `reads_exact_process_args`: 이 테스트 프로세스의 인자가 `std::env::args()`와 같고, 빈칸이 든 인자와 JSON이 한 인자로 남고,
없는 pid는 None. 대조: 해석 대신 원문 검사로 되돌리면 실패. Rust 135개 통과.
전체 `selftest.sh` 다섯 시나리오 통과 (PASS 514).

## 후속 리뷰 1회 (reviewer-2 #405, 사용자 승인 #400)

R1 해결 확인 (JSON 해석, 정확한 프로세스 인자), 새 P0–P2 없음. 리뷰어가 Rust 테스트 3개(`sees_bypass_in_args_and_settings`,
`reads_exact_process_args`, `begins_only_for_one_idle_terminal`)를 직접 돌려 통과. 코드 리뷰 통과.
