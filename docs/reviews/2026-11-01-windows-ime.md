# Windows 한글 입력이 두 번씩 들어감 (2026-11-01)

## 문제

사용자 보고: ddak 터미널에서 한글이 음절마다 두 번씩 들어간다 ("한한글글입입력력"). 스페이스는 한 번. 그 창의 다른 곳(다른
터미널)을 눌렀다 돌아오면 풀린다. 사용자 관찰: 한글을 치는 도중 다른 창(자체 테스트로 뜬 ddak)이 포커스를 가져가 그 창에서
조합하다가 그 창이 닫히고, 원래 터미널을 마우스로 눌러 돌아오면 생긴다.

## 실험

자체 테스트 앱에 임시 기록 단계(키·composition·input 이벤트와 xterm onData)를 넣고, Python SendInput으로 실제 키를 보내
Microsoft 한국어 입력기를 거치게 했다 (기록 단계·드라이버는 커밋하지 않음). 매 키 전에 앞 창을 확인해서 다른 창에는 치지 않았다.

| 경우 | 이벤트 | 결과 (보정 켬, 고치기 전) |
| --- | --- | --- |
| 보통 속도, 빠르게(키 겹침), 유니코드 키(VK_PACKET) | 음절마다 compositionstart → update → compositionend | 한 번씩 |
| 조합 중 같은 창 안에서 포커스 뺐다 돌림, 메모장·새 Edge 창으로 갔다 돌아옴, Edge 창이 조합 중에 닫힘 | 같음 | 한 번씩 (조합 중이던 글자는 사라짐: 별개) |
| 두 번째 ddak(WebView2) 창에서 조합 중에 그 창을 강제 종료 | 같음 | 한 번씩 |
| 두 번째 ddak 창에서 조합 중에 그 창을 정상 종료(WM_CLOSE), A를 눌러 돌아와 침 | composition 이벤트가 없음. keydown 229·keyup만 오고, 끝낸 음절은 다음 키 직전에 keypress(그 글자) + insertText | **두 번씩** ("난" "난", "실" "실") |

원인: 그 상태에서 xterm은 keypress로 음절을 보내고 뒤따르는 insertText는 버린다 (`_keyPressHandled`). 한글 보정(hangul.ts)은
insertText를 받아 "이번 키를 xterm이 이미 보냈는지"를 keydown 구간 안의 onKey로만 보는데, 이 keypress는 키 구간 밖이라
xterm이 보낸 줄 모르고 또 보낸다. 보정은 macOS WebKit(조합 이벤트 없이 바꾸기로 조합)을 위한 것이고, `docs/windows-plan.md`도
Windows는 xterm 기본 처리로 정해 두었지만 플랫폼을 가리지 않고 붙어 있었다.

## 수정

- `hangul.ts` `IME_FIX = !IS_WINDOWS`. `Terminal.tsx`는 이때만 `fixImeInput`을 붙이고 `passesImeKey`로 키를 거른다.
- 고친 뒤 같은 재현(두 번째 ddak 정상 종료): 같은 상태(keypress + insertText)에서 "난 실 한글"이 한 번씩. 보통·빠르게 입력도
  고치기 전과 같은 결과.
- spec.md 터미널 한글 입력, windows-plan.md 한글 입력 행.

## 시험

- 새 단계 `imeTerminal` (실제 터미널, Terminal.tsx 연결): 기록한 composition 순서면 한 번. Windows에서는 기록한 "조합 이벤트 없이
  keypress + insertText" 순서도 한 번. 보정을 Windows에도 붙이면 `["난","난"]`으로 실패 (확인 뒤 되돌림).
- `terminal` 단계의 WebKit 합성 이벤트 한글 검사 4개는 보정을 쓰는 곳(IME_FIX)에서만 돈다. Windows에서 남는 실패 3개(작업 폴더
  경로, ⌘⌫, ⇧↩)는 고치기 전 코드에서도 같았다 (맥 기준 검사).
- tsc, selftest-changed --check 통과. 못 한 것: 맥 selftest.sh (맥은 IME_FIX가 참이라 동작은 그대로).

## 남은 것

- 그 상태(조합 이벤트 없음)에서는 조합 중인 글자가 화면에 보이지 않고 음절이 끝나야 나타난다. 그 창의 다른 곳을 눌렀다 오면
  풀린다. 입력기·WebView2 쪽 상태라 고치지 않았다.
- 조합 중에 창이 포커스를 잃으면 조합 중이던 글자가 사라진다 (고치기 전에도 같음). 이번 범위가 아니다.
