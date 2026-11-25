# 설치판에서 codex 0.172 터미널이 멈춤: 빌드 목표 es2021 (2026-11-25)

## 요청 (사용자, 채팅 #483)

설치판(release) ddak에서 codex 0.172를 띄우면 커서만 있고 아무것도 그려지지 않는다 (일반 터미널 탭도). 개발판·자체 테스트에서는
재현되지 않는다. 사용자가 원인을 찾아 왔다:

- codex 0.172는 시작할 때 DECRQM `ESC[?1007$p`를 묻는다 (0.169는 안 물음).
- xterm.js 6.0.0 requestMode의 `let r;(…)(r||={})`를 vite 6.4.5 기본 빌드 목표(es2020 포함)가 낮추면서 esbuild 0.25.12
  minifySyntax가 `let r`를 지워 `void 0||(s={})`(선언 안 된 변수에 대입)가 된다. ReferenceError로 xterm 쓰기가 멈춘다.

고치는 방법 셋 중 추천을 물었고(#485), 1번(빌드 목표 es2021) + 맥 최소 버전 11.0을 추천해(#486) 진행하기로 했다(#487).

## 확인한 것 (수정 전)

- 설치판 번들 `dist/assets/index-*.js`에 `…="PERMANENTLY_RESET"))(void 0||(s={}));`가 있다.
- 최소 예 `let s=1;class A{m(){let r;(P=>P[P.X=0]="X")(r||={})}}`를 esbuild 0.25.12 `--minify --target=es2020`로 돌리면
  `(void 0||(e={}))`, es2021·safari14면 `let s;…(s||={})` 그대로. 0.27.0도 깨지고 0.28.2는 `l||(l={})`로 바르게 낮춘다.
- 실제 동작: 앱과 같은 vite 6·esbuild 압축으로 xterm만 묶어 Node에서 `Terminal.write("\x1b[?1007$p")`:
  es2020이면 `ReferenceError i is not defined`(쓰기 콜백이 오지 않음), es2021이면 응답 `ESC[?1007;0$y`과 쓰기 완료.
- 폰 화면 번들(`vite.mobile.config.ts`, 기본 목표)에는 깨진 모양도 `||=`도 없다 (xterm을 쓰지 않음).

## 판단

- 방법: 데스크톱 빌드 목표를 es2021로. es2020과 달라지는 것은 es2021 문법(`||=` `??=` `&&=`, 숫자 구분자)을 낮추지 않는 것뿐이라
  번들 모양이 가장 적게 바뀐다. minifySyntax 끄기는 이 버그만 피하고 압축 전체가 바뀐다. esbuild 0.28 강제는 Vite 6이 받지
  않는 조합이다 (Vite 7은 Node 20.19+가 필요하고 이 맥은 20.10).
- `["es2021", "safari14", …]`처럼 브라우저를 섞지 않는다: `||=`를 모르는 브라우저(firefox78 등)가 끼면 다시 낮춘다.
- 맥 최소 버전 11.0: macOS 11은 처음부터 Safari 14(`||=` 앎). 그보다 낮은 맥은 Safari 업데이트에 따라 터미널이 말없이 멈출 수
  있으니 실행을 막는 편이 분명하다. Safari 15로 올린 10.15도 막히지만 개인용이고 지금 맥은 15.
- 검사: 자체 테스트는 압축하지 않는 개발판이라 못 잡는다. `npm run build` 끝에 번들 검사를 붙여 모든 릴리스 빌드(맥 install.sh,
  Windows CI의 tauri build)가 깨진 번들이면 실패하게 한다.

## 수정

- `vite.config.ts`: `build.target: "es2021"`.
- `src-tauri/tauri.conf.json`: `bundle.macOS.minimumSystemVersion: "11.0"`.
- `scripts/check-bundle.mjs` (새 파일): `dist/assets/*.js`에서 (1) 깨진 모양 `[(,] void 0 || (`가 없고 (2) xterm requestMode의
  `="PERMANENTLY_RESET"))(x||={})`가 남아 있는지 본다 (공백 무시). requestMode 자리를 못 찾아도 실패 (검사가 낡았다는 뜻).
- `package.json` `build`: `tsc && vite build && node scripts/check-bundle.mjs`.
- `scripts/selftest-plan.json`: 새 스크립트는 ignore (빌드가 돌린다).
- spec "기술 스택": 빌드 목표·지원 범위·검사.

## 확인

- 수정 전 번들에 검사: 실패 (두 가지 모두 잡음).
- 대조: `build.target`을 es2020으로 바꾸면 `npm run build`가 검사에서 실패(종료 1), es2021로 되돌리면 통과(종료 0). 실제로 돌림.
- 위 Node 실험의 두 번들(압축했지만 공백이 남는 lib 모드)에도 검사를 돌려 es2020은 실패, es2021은 통과.
- 릴리스 빌드(`tauri build --bundles app`): 검사 통과, `Info.plist` `LSMinimumSystemVersion` 11.0, 실행 파일 `minos 11.0`.
- 직접 확인할 것: 설치한 뒤 실제 터미널에서 `printf '\033[?1007$p'; echo after`의 출력과 codex 0.172 화면. 화면 캡처가 안 되는
  환경이라 위 Node 실험으로 대신했다. Windows는 같은 번들이지만 실기기로 보지 않았다.
- 전체 `scripts/selftest.sh`: `main` 말고 모든 시나리오 통과. `main`은 트리 화살표 회전, 폰 읽음 3개, 배율 4개 뒤
  `terminalContrast` 시간 초과(300초)로 멈췄다. 돌린 뒤 맥 화면이 꺼져 있었다(`pmset` UserIsActive 0). 앞 기록(2026-11-06-chat-links, 2026-11-17-chat-reset-limits)에서 맥 화면이
  꺼졌거나 같은 때 HEAD에서도 난 실패와 같은 모양이다. 이번 변경은 개발판(자체 테스트)에 쓰이지 않는다: `build.target`과
  `minimumSystemVersion`은 릴리스 빌드에만, `check-bundle.mjs`는 `npm run build`에만 쓰인다.

## 리뷰 1회 (origin/reviewer-2, #489)

통과, 차단 지적 없음. 리뷰어가 현재 dist의 실제 requestMode를 꺼내 실행해 1007 질의에 `ESC[?1007;0$y`를 답하는 것과, 같은 코드를
es2020으로 압축하면 ReferenceError가 나는 것을 따로 확인했다. 한계: 전체 npm·tauri 빌드와 자체 테스트는 개발자 보고이고 전체
자체 테스트 통과가 아니다 (main 중단). 실제 설치판의 printf·codex 화면과 Windows 실기기는 직접 확인해야 한다.
