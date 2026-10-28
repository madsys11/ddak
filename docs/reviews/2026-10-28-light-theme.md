# 라이트 테마 추가 리뷰 (2026-10-28)

사용자 요청으로 VS Code Light Modern을 옮긴 `light` 테마를 넣었다 (`src/themes.ts`).
Light Modern 파일에 없는 색은 VS Code 라이트 기본값(워크벤치 번들의 색 등록, git 확장 `package.json`)에서 가져왔다.

## 리뷰 결과

차단 문제(P0–P2) 없음. P3 하나.

### R1 [P3] 오류·git 추가 글자의 대비를 검사하지 않음 — 타당, 수정

지적: 라이트의 `--error`(#F85149)는 이름표 배경 위 3.16:1이다. Git Graph 파일 목록의 추가(A) 글자는 `--graph-3`(#00D90A, 레인 색)을
쓰는데 흰 바탕 위 1.92:1이다. 상태 대비 검사는 작업 중·완료·기다림만 본다.

확인: `App.css`의 `.pane-badge.status.error`와 `.git-status.s-A`가 실제로 이 색을 작은 글자색으로 쓴다.
같은 기준으로 세 테마를 계산해 보니 기존 Solarized Light도 4.5:1에 못 미쳤다.
Solarized는 `--error` #DC322F가 3.77~4.29, 추가 글자(#859900)가 2.62~2.97이다. 다크는 모두 4.8 이상이다.

수정:
- 라이트 `--error`는 #A1260D(VS Code 라이트 `errorForeground` 기본값, Light Modern이 덮어쓴 값보다 진함)로 바꿨다.
- Solarized `--error`는 #B02825로 진하게 했다.
- 추가 글자는 레인 색 대신 새 토큰 `--git-added`를 쓴다. 다크 #81B88B와 라이트 #587C0C는 VS Code `gitDecoration.addedResourceForeground`이고,
  Solarized #566300은 `--status-done`과 같다.
  다크의 추가 글자는 #00D90A에서 #81B88B로 바뀐다.
- `statusContrastUnit`에 오류·추가 글자의 대비 검사를 더했다. 바탕은 `--bg`와 `--sidebar-bg` 둘이다.

확인 방법:
- 수정 전 값으로 되돌려 `SELFTEST_ONLY="statusContrastUnit"`를 돌리면 실패한다:
  `light error on --bg 3.35 | light error on --sidebar-bg 3.16 | solarized-light error on --bg 4.29 | solarized-light git-added on --bg 2.97 | …`
- 수정 후에는 `statusContrastUnit`, `mobileThemeUnit`, `prefs`가 모두 통과한다.

## 테스트

- `prefs`에 영어 메뉴로 Light를 고르고 화면·사이드바·터미널 배경과 메뉴 체크를 보는 검사를 넣었다.
  `light`를 `THEMES`에서 빼면 "메뉴 항목 없음: View/Theme/Light"로 실패한다.
- 전체 자체 테스트에서 main 시나리오의 트리 화살표, 폰 채팅 스크롤, 배율 픽셀 맞춤, WebGL 전환 후 그리기는 실패했다.
  그때 Mac 화면이 잠겨 있었다(`CGSSessionScreenIsLocked`). 그래서 창이 hidden이고 requestAnimationFrame이 멈췄다.
  이 실패는 테마와 관계없지만 전체 통과로 치지 않는다. 화면 잠금이 풀린 뒤 다시 돌려야 한다.
