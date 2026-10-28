# 프로젝트 추가: 폴더 선택 창에 "새 폴더" 버튼 (2026-10-28)

**요청** (사용자): 프로젝트 추가에 폴더 선택만 있고 새 프로젝트를 만드는 길이 없다. 제안 두 가지(선택 창에 "새 폴더" 켜기 /
앱 안 "새 프로젝트" 입력) 가운데 1번(선택 창)으로.

**원인**: `App.tsx` pickProject가 `open({ directory: true })`만 준다. tauri-plugin-dialog 2.8.3의 open 명령은
`canCreateDirectories`를 줄 때만 rfd `set_can_create_directories`(NSOpenPanel `setCanCreateDirectories`)를 부른다
(`commands.rs` 138행). macOS 열기 창의 기본값은 꺼짐이다: Swift로 `NSOpenPanel().canCreateDirectories`는 false,
`NSSavePanel()`은 true로 나왔다.

**수정**: `open({ directory: true, canCreateDirectories: true })`. spec "프로젝트 · 저장소"에 추가 방법을 적음.

**확인**: tsc 통과. 네이티브 창이라 자체 테스트로 버튼을 볼 수 없다 (합성 이벤트로 열 수 없고 화면 캡처도 안 된다).
옵션이 rfd까지 가는 길은 위 소스로 확인. 버튼이 보이는지는 설치 후 맥 앞에서 확인해야 한다.

## 리뷰 1차 (reviewer-2 #339)

**R3 [P3] 원인 기록이 의존성 코드와 다름 — 타당.** 옵션을 생략해도 tauri-plugin-dialog 2.8.3 `desktop.rs` 104행이
`d.can_create_directories.unwrap_or(true)`를 rfd로 넘기고, rfd 0.16.0 macOS 폴더 선택(`panel_ffi.rs` build_pick_folder)도
`unwrap_or(true)`다. `commands.rs` 138행은 옵션이 있을 때 덮어쓰는 것일 뿐이다. 그래서 원래 `open({ directory: true })`도 "새 폴더"
버튼이 켜진 창이었다. NSOpenPanel 자체의 기본값이 false인 것은 맞지만 rfd가 늘 켠다. 위 "원인"은 틀렸다.
결론: 이번 변경은 동작을 바꾸지 않는다 (`canCreateDirectories: true`를 밝혀 둔 것). 주석을 고쳤다. 사용자가 본 "프로젝트
추가는 없다"는 앱 안에 새 프로젝트를 만드는 입력이 없다는 뜻이었을 수 있어, 선택 창 왼쪽 아래 "새 폴더" 버튼을 알리고 앱 안 입력
(앞서 제안한 2번)이 필요한지 다시 묻는다.
