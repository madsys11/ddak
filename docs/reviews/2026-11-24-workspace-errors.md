# 프로젝트 화면의 오류를 탭 바 아래로, 저장소가 없을 때 할 일 (2026-11-24)

## 요청 (사용자)

새 프로젝트에 저장소가 없는 채로 새 작업그룹을 추가하면 "작업그룹을 만들지 못했습니다: …"가 파일 트리 창 위에 뜬다. 왜
파일 트리에 보이나. 제안한 두 가지(오류를 그 프로젝트 화면에, 저장소가 없을 때 할 일 알리기)를 모두 하기로 했다.

## 판단

- 원인: 앱 전체에 오류 줄이 사이드바 위 하나뿐이고, `Workspace`는 자기 오류를 App의 `onError`로 넘겨 거기 띄웠다
  (작업그룹 만들기 실패, 저장한 탭 읽기 실패, 탭 저장 실패). 탭 바·⇧⌘T에서 한 일의 오류가 파일 트리 오류처럼 보였다.
- 그 프로젝트 화면의 오류는 그 화면(탭 바 바로 아래)에 둔다. 사이드바 오류 줄에는 앱 전체 오류(프로젝트 목록 읽기·추가,
  작업그룹 설정 파일)만 남긴다.
  - 종류마다 하나: 읽기(`load`), 만들기(`group`), 저장(`save`). ×로 닫는다.
  - 만들기 오류는 다음 만들기가 성공하면, 저장 오류는 다음 저장이 성공하면 지운다. 읽기 오류는 그 프로젝트가 다시 켤 때까지
    저장하지 않는다는 안내라 닫을 때까지 둔다.
  - 프로젝트마다 따로라, 예전 App의 "자기가 띄운 오류만 지우기"(리뷰 R1, 다른 프로젝트의 같은 문구) 장치가 필요 없어졌다.
- 저장소가 없을 때(`noRepos`) 할 일: 사이드바 프로젝트 줄의 +(저장소 추가, 이미 있는 기능)나 ⌘T(원본 폴더 셸 탭).
  저장소가 없을 때 새 작업그룹 메뉴를 끄는 것은 저장소 유무를 계속 알아야 해서 하지 않았다 (제안에서 말함).
- 탭 저장 실패는 예전에 원문(`detail`)만 보였다. 화면에 따로 뜨므로 "탭을 저장하지 못했습니다: …"를 붙였다.

## 수정

- `src/Workspace.tsx`: `errors` 상태와 탭 바 아래 `.workspace-errors`(줄마다 `data-error`, 닫기 ×). props `onError`·
  `onClearError`를 뺐다.
- `src/App.tsx`: `showError`·`clearError`(`workspaceError`)와 Workspace에 넘기던 props를 뺐다.
- `src/App.css`: `.workspace-errors`·`.workspace-error`·`.workspace-error-close` (기존 토큰).
- 문구: `group.noRepos`(할 일), 새 `workspace.saveFailed`.
- spec: 작업그룹 · worktree의 실패 오류, 프로젝트 · 저장소에 "프로젝트 화면의 오류".
- 자체 테스트: 사이드바(`.sidebar-error`)에서 찾던 검사를 그 프로젝트의 `.workspace-error`로 (`projects`의 읽기 실패,
  `groupWorktree`의 만들기 실패). `groupErrorClear`를 새 동작으로 다시 썼다:
  - 실패하면 그 프로젝트 화면의 탭 바 바로 아래에 보이고 사이드바에는 없음, 문구에 할 일(⌘T 등).
  - A를 고쳐 성공하면 A의 오류만 사라지고, B의 같은 문구 오류와 사이드바 오류(없는 폴더 추가)는 남음.
  - ×로 닫고, 다시 실패하면 다시 보임.

## 확인

- tsc 통과.
- `SELFTEST_ONLY="projects groupWorktree groupErrorClear"`: 모두 통과.
- 대조: 오류 줄을 탭 바 위로 옮기고 성공 때 지우기를 빼면 `groupErrorClear`의 앞 두 검사가 실패하고, 되돌리면 통과 (실제로 돌림).
- 전체 `scripts/selftest.sh`: `main` 말고 모든 시나리오 통과. `main`은 끝까지 돌았고 바꾼 검사(`projects`의 읽기 실패,
  `groupWorktree`, `groupErrorClear` 셋)는 통과. 실패:
  - 앞 기록의 기존 실패: `addSession` 첫 메시지, `sessionFollow` 예외와 그 뒤 `projects`·`groupPick`·`groupErrorClear`(정리의
    "첫 프로젝트로")·`lastExit`, `chatFilter` 탭 줄바꿈(25ea0af부터).
  - 이번에 처음 본 것: `addSession`이 `testChatPrompt` 첫 줄의 "채팅 패널"(채팅 버튼을 눌러 3초 안에 열림)에서 시간 초과로 끝났다.
    그래서 채팅이 열린 채 남아 `gitGraph`의 "채팅 패널과 함께 보임"(누르니 닫힘, `none`)과 `tabMove` 끌기가 실패했다.
    `addSession gitGraph tabMove`만 돌리면 모두 통과하고, 앞 전체 실행(2026-11-24-phone-reset-limits, 같은 검사 순서)에서는 나지
    않았다. 이번 변경은 채팅 버튼·패널을 건드리지 않는다. 다만 이 실행에서 프로젝트 화면 오류 줄이 떠서 화면 배치를 밀었는지는
    로그로 알 수 없다 (검사 출력에 그 줄이 나오지 않는다).
    `main`을 한 번 더 돌려 다시 나는지 본다 (결과는 아래에 덧붙임).

## 리뷰 1회 (origin/reviewer-2, #479)

통과, 차단 지적 없음. 한계: 전체 `main`의 실패와 `testChatPrompt` 시간 초과·뒤 연쇄 실패는 원인 불명이다. 이번 변경은 화면 배치를
바꾸므로(탭 바 아래 오류 줄) 단계를 따로 돌려 통과한 것만으로 영향을 배제할 수 없다. `main` 재실행 결과를 문서와 보고에 넣는다.

### `main` 재실행 (리뷰 뒤, 같은 코드)

`addSession`의 `testChatPrompt` 시간 초과와 뒤 `gitGraph` "채팅 패널과 함께 보임"·`tabMove` 실패는 다시 나지 않았다. 실패는 앞 기록의
기존 실패와 같은 목록이다 (`addSession` 첫 메시지, `sessionFollow`와 뒤 연쇄, `chatFilter` 탭 줄바꿈). 바꾼 검사 셋은 통과.
한 번 나고 다시 나지 않아 흔들림으로 보지만, 원인은 찾지 않았다.
