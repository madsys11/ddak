# WebView 기본 오른쪽 클릭 메뉴 막기 (2026-10-29)

**요청** (사용자): 앱에서 오른쪽 클릭하면 Look Up "", Translate "", Search with Google, Copy, Share…, Speech 메뉴가 뜬다.
의도한 것인지 → 아니라면 기본 메뉴를 막는다. 글 입력란은 기본 메뉴를 남긴다 (사용자 선택).

**원인**: 앱이 그리는 메뉴(`ContextMenu.tsx`)는 파일 트리·사이드바·탭에서만 연다. 그 밖(터미널, 탭 바 빈 곳, 패널 등)의
contextmenu는 아무도 막지 않아 WKWebView가 Safari와 같은 기본 메뉴를 띄운다. Tauri 2는 이 메뉴를 끄지 않는다.

**수정**: `ContextMenu.tsx`에 `refuseNativeMenu`를 두고 `main.tsx`에서 `refuseOutsideDrops`처럼 한 번 건다.
- window 캡처 단계에서 contextmenu의 기본 동작을 막는다. 아래 요소(xterm 등)가 전파를 멈춰도 빠지지 않는다.
- 예외: 글 입력란(textarea, checkbox가 아닌 input). 잘라내기·붙여넣기·맞춤법을 쓰도록. 터미널의 숨은 입력란
  (`xterm-helper-textarea`)은 입력란으로 보지 않고 막는다.
- 앱 메뉴를 여는 핸들러(FileTree, Sidebar, Workspace 탭)는 `defaultPrevented`를 보지 않으므로 그대로 열린다.
- 폰 화면(`src/mobile`)은 다른 진입점이라 건드리지 않는다.
- spec "사이드바 · 파일 트리"의 오른쪽 클릭 메뉴 항목과 "자체 테스트"의 직접 확인 목록에 적음.

**확인**
- tsc 통과.
- 자체 테스트 새 단계 `nativeMenu` (`SELFTEST_SCENARIOS=main SELFTEST_ONLY=nativeMenu`): 파일 트리·터미널 화면·터미널 숨은
  입력란·빈 곳(body)·체크 상자에서 막고, 글 입력란(input, textarea)은 그대로, 막아도 탭의 앱 메뉴가 열린다.
- 대조: `refuseNativeMenu()` 호출을 빼면 터미널 화면·숨은 입력란·빈 곳·체크 상자 검사가 실패한다
  (파일 트리는 원래 앱 메뉴가 막고 있어 통과).
- 전체 `scripts/selftest.sh`: 다섯 시나리오 모두 통과, PASS 525, FAIL 0.
- 합성 이벤트로는 기본 동작이 막혔는지만 본다. 실제 오른쪽 클릭에서 기본 메뉴가 안 뜨는지는 앱을 다시 설치해 직접 확인한다.

## 리뷰 1회 (origin/reviewer-2, #421)

대상: HEAD 171b940 + 미커밋 변경 전체.

**R1 · P2 · 타당 → 수정**: 실제 이름 바꾸기 입력란에서는 입력란 예외가 적용되지 않는다.
- 근거: 탭 이름 입력란(`TabNameInput`)은 `.tab` 안에, 파일 이름 입력란(`RenameInput`)은 `.tree-row` 안에 있다.
  `refuseNativeMenu`가 입력란에서 기본 동작을 막지 않아도 이벤트가 그 행의 `onContextMenu`(Workspace.tsx 탭,
  FileTree.tsx → Sidebar.tsx `openMenu`)로 올라가 `preventDefault`하고 앱 메뉴를 연다. 앞의 검사는 부모가 없는 body에
  임시 입력란을 붙여서 이 경로를 보지 못했다.
- 실험: 아래 새 검사가 수정 없이 실패한다 — 탭 이름 "기본 메뉴 막힘, 앱 메뉴 Rename Tab…,Add Session…",
  파일 이름 "기본 메뉴 막힘, 앱 메뉴 New File…,New Folder…,-,Rename…,Move to Trash".
- 수정: 글 입력란이면 캡처 단계에서 `stopPropagation`해 행의 앱 메뉴 핸들러까지 가지 않게 한다 (행마다 입력란을
  거르는 것보다 한 곳에서 끝난다). `src`에서 contextmenu를 듣는 곳은 이 리스너와 React `onContextMenu` 네 곳뿐이고,
  xterm의 리스너는 숨은 입력란(막는 쪽, 전파는 그대로)이라 영향이 없다. spec에 "글 입력란에서는 앱 메뉴도 열지 않는다"를 넣음.
- 확인: `nativeMenu`에 실제 입력란 검사 2개 — 탭 메뉴 "Rename Tab…"과 파일 메뉴 "Rename…"으로 연 입력란을 오른쪽
  클릭하면 기본 동작이 남고 앱 메뉴가 열리지 않는다. 수정 후 통과, `stopPropagation`을 빼면 두 검사 모두 실패.
- 전체 `scripts/selftest.sh` (R1 수정 후): 다섯 시나리오 모두 통과, PASS 527, FAIL 0.

## 재리뷰 1회 (origin/reviewer-2, #423)

R1 해소, 차단 지적 없음. 실제 macOS 오른쪽 클릭은 재설치 후 직접 확인한다.
