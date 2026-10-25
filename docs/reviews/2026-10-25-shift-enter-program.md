# 작업 기록: 그냥 셸 터미널의 ⇧↩ (2026-10-25)

사용자 보고: 작업그룹 세션의 터미널에서는 ⇧↩(줄바꿈)이 되는데, 새 터미널을 열어 그 안에서 띄운 세션에서는 되지 않는다.
리뷰 대응은 아래에 덧붙인다.

## 원인

⇧↩의 ESC CR은 groups.json 세션 구성의 `shiftEnter`로만 걸렸다. 그냥 셸 탭은 구성이 없어 xterm 기본(Enter)을 보낸다.
모든 창에 걸지 않은 것은 Vim 삽입 모드가 ESC로 끝나서다 (이전 리뷰 지적 7). claude는 시작할 때 kitty 키보드 프로토콜을 묻지만
(`CSI ? u`, 실험의 가상 터미널 기록) xterm.js는 답하지 않아 ⇧↩을 구분할 방법이 없다.

## 판단 (사용자가 A를 골랐다)

- A: 누를 때 터미널 앞의 프로그램(포그라운드 프로세스 이름)을 보고 고른다. claude·codex의 프로세스 이름은 `claude`, `codex`
  (ps comm으로 확인). 다른 프로그램(Vim 등)에는 영향이 없다.
- B (안 함): kitty 키보드 프로토콜을 지원하면 Esc·Ctrl 조합 등 다른 키의 인코딩까지 바뀌어 위험이 크다.

## 바뀐 것

- `pty.rs` `pty_foreground`: `MasterPty::process_group_leader` → `libc::proc_name`.
- `groups.rs`: 맨 위 `shiftEnterFor` (프로그램 이름 → 입력). 파일에 없으면 기본 claude·codex = ESC CR. 기본 설정에도 적는다.
- `Terminal.tsx`: 세션 구성의 shiftEnter가 없을 때 ⇧↩을 막고, 다른 입력과 같은 차례(`sending`)에서 프로그램을 물어 보낸다.

## 확인

- Rust: foreground_names_the_running_program (`exec cat` → "cat", 없는 터미널 None), rules_and_role_are_optional
  (shiftEnterFor 기본값). 80개 통과.
- selftest `shiftEnterProgram` (혼자 돈다, 테스트 설정 `shiftEnterFor: {cat: ESC CR}`): 셸이 앞이면 Enter로 실행, `cat -v`가 앞이면
  `^[`. 새 처리를 끄면 실패한다.
- 기존 검사 "탭: 세션이 아닌 창의 ⇧↩는 그냥 Enter"는 xterm이 바로 보내는 값("\r")을 봤다. 이제는 막고 따로 보내므로 xterm이
  바로 보내는 것이 없음("")을 보도록 바꿨다. 실제로 가는 값은 shiftEnterProgram이 셸·cat에서 본다.

## 리뷰 (채팅 #81)

### R1 입력기 조합 중의 ⇧↩도 Enter로 보냄 (P2) — 타당, 수정

**검증**: 소스. 새 분기가 `passesImeKey`보다 먼저 돌고 keyCode 229·isComposing을 보지 않는다. 같은 빈틈이 기존 세션 경로
(`terminalKey`의 shiftEnter)에도 있었다 (개발 측이 함께 찾음): 조합 중 ⇧↩에 ESC CR을 보냈다.

**수정**: `isShiftEnter`(조합이 끝난 ⇧↩: isComposing 아님, keyCode 229 아님)를 두 경로가 함께 쓴다. 조합 중이면 입력기
경로(passesImeKey, xterm CompositionHelper)로 넘긴다.

**확인**: selftest shiftEnterProgram — 그냥 셸 탭에서 keyCode 229·isComposing인 ⇧↩은 명령을 실행하지 않고, 조합이 끝난 ⇧↩은
실행한다. 세션 구성이 있는 첫 터미널에서 keyCode 229인 ⇧↩은 아무것도 보내지 않는다. 검사를 끄면 둘 다 실패한다 (명령 실행,
ESC CR 전송). 실제 한글 입력기로는 확인하지 않았다.
