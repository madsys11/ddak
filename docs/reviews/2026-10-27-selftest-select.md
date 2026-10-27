# 자체 테스트: 바뀐 파일에 맞는 단계만 고르기 (2026-10-27)

**요청** (사용자): 테스트가 너무 오래 걸리고 관계없어 보이는 것까지 돈다. 영향이 있는 쪽만 골라 돌릴 수 없나.
리뷰어와 설계를 상의했다 (#231 제안, #232 의견: 기본 준비 분리 + 손으로 관리하는 표 + 리뷰 전 전체. 커버리지로 표 자동
만들기는 이번엔 하지 않음 — 실행된 파일만으로는 상태 의존과 Rust 경로를 알 수 없고 준비 분리가 바로 효과가 있다).

**원인**: 단계를 사람이 골라야 해서 전체를 돌리기 쉬웠다. 그리고 골라도 기본 단계 `terminal`(첫 터미널 + 터미널 검사 40여
개)이 늘 돌았다.
바로잡기: 상의 때(#231) `terminal`이 66초라고 했지만, 그것은 맥 화면이 꺼진(잠긴) 때의 값이다. 같은 날 전체 실행 넷의 시각을
`pmset -g log`의 화면 켜짐·꺼짐과 맞춰 보면, 화면이 꺼진 실행(20:33, 22:09)은 terminal 66초·main 합계 약 380초, 켜진 실행
(21:47, 23:25)은 terminal 2.1초·main 합계 약 150초다. 화면이 켜져 있으면 기본 단계 분리로 줄어드는 것은 2초 남짓이고, 줄어드는
것은 주로 고르기 덕이다. 화면이 꺼진 때 두 배 넘게 느린 원인(어느 기다림이 길어지는지)은 따로 볼 일이다.

**구현**:
- `src/selftest.ts`: `terminalReady` 단계(`openFirstTerminal`: 첫 터미널, 프롬프트, `echo READY-$((40+2))`가 42로 돌아옴)를
  만들고 기본 단계를 `projectStart`·`terminalReady`로. 터미널 검사는 고를 수 있는 `terminal` 단계로 남김. 첫 터미널 없음
  SKIP 기준도 `terminalReady`로.
- 앞 단계 표를 `scripts/selftest-plan.json`의 `deps`로 옮기고 `expandSteps`가 끝까지 펼친다 (예전에는 한 단계만 펼쳤다).
  표에 없는 단계·앞 단계가 뒤에 있음·순환은 FAIL. 도는 순서는 단계 목록 순서. 고르기 표의 단계 이름도 실제 단계와 맞는지 본다.
  `stepPlanUnit` 단계가 펼치기와 오류를 검사.
- `scripts/selftest-plan.json`: `ignore`(문서·아이콘·설치 스크립트 등, 이유 적음), `full`(여러 단계가 쓰는 바탕과 고르기
  자체), `rules`(파일 → 단계·시나리오). 리뷰어 의견대로 별도 JSON 한 곳.
- `scripts/selftest-changed.mjs` (Node):
  - 바뀐 파일: 비교 기준(기본 HEAD, `--base`) 대비 `git diff --name-status -z -M`(스테이징+작업 트리, 이름 바꾸기는 두 경로)과
    추적하지 않는 새 파일. 실제 비교한 SHA를 찍는다. git 실패·모르는 인자·표의 잘못은 종료 코드 2.
  - 파일마다 ignore → full → `src/selftest.ts` → rules 순. 표에 없는 파일이 하나라도 있으면 전체.
  - `src/selftest.ts`는 `git diff -U0`의 바뀐 줄이 속한 맨 위 이름(함수·상수, 바로 위 주석 포함)을 찾고, 그 이름을 (부르는
    관계를 따라) 쓰는 단계·시나리오(`restart: testRestart` 같은 줄)를 고른다. 단계 목록의 한 줄이면 그 단계. runSelftest와
    그것이 단계 목록 밖에서 쓰는 이름(check, expandSteps 등), 가져오기 줄이면 전체. 테스트를 고칠 때마다 전체가 돌지 않게.
  - 앞 단계를 끝까지 펼치고, 시나리오는 `SELFTEST_SCENARIOS`로 (main은 고른 단계가 있을 때만, resume은 save·check 한 쌍).
    고른 것이 없으면 자체 테스트는 건너뛴다고 밝힌다 (빈 `SELFTEST_ONLY`는 main 전체라서).
  - TS가 바뀌면 tsc, `src-tauri`가 바뀌면 cargo test. 끝에 각 결과와 걸린 시간.
  - `--plan`(고른 결과와 이유만), `--files a,b`(이 파일을 바꾸면 무엇이 도나), `--check`(규칙 검사 14개: 표에 없는 파일은
    전체, 문서만은 아무것도, 규칙·Rust·시나리오 고르기, full 섞이면 전체, 앞 단계 끝까지, selftest.ts의 함수·단계 목록 줄·
    시나리오 함수·바탕·runSelftest·가져오기, 추적하는 파일이 모두 표에 있음).
- CLAUDE.md: 고치는 동안 `node scripts/selftest-changed.mjs`, 리뷰 전 전체, 새 단계·새 파일은 표에 넣고 `--check`.
  spec "자체 테스트" 갱신.

**표를 정한 근거**: 단계마다 테스트 함수(와 그것이 부르는 테스트 함수)가 직접 부르는 Rust 명령과 화면 요소를 뽑아 보고
(selftest.ts 읽기), 컴포넌트가 쓰는 Rust 명령을 더해 정했다. 여러 단계가 쓰는 파일(App, Workspace, Terminal, 탭 상태,
ContextMenu, 문구·테마·스타일, lib.rs·pty.rs·menu.rs·workspace.rs 등)은 보수적으로 full. 표에 이름이 있다는 것은 오타·누락만
잡고 영향 범위가 맞다는 증거는 아니다 (리뷰어) → 리뷰 전 전체 실행은 그대로.

**확인**:
- `--check` 14개 통과. 펼치기를 한 단계만으로 바꾸면 "앞 단계를 끝까지 펼침", 표에 없는 파일을 건너뛰게 하면 "표에 없는 파일은
  전체"가 실패.
- 단계 하나만(trashDrag, 화면 켜짐): 24초 (projectStart 0.2, terminalReady 0.2, trashDrag 8.0초, 나머지는 앱 빌드·실행).
  같은 조건의 전체 실행은 184초 (main 155초 + 다른 시나리오 넷). 화면이 꺼지면 전체는 약 7분.
- `terminal`을 뺀 모든 단계(47개)를 한 번에: 모두 통과 (PASS 414). 터미널 검사가 만든 상태에 기대는 단계는 없다.
  (단계를 하나씩 따로 돌려 보지는 않았다. 앞 단계 표의 묶음은 2026-10-25에 혼자 돌려 정한 것 그대로.)
- 전체 `selftest.sh` (화면 켜짐): 다섯 시나리오 모두 통과 (PASS 466, 184초). `stepPlanUnit` 2개 포함. tsc 통과.

## 리뷰 1차 (#238)

**R1 [P2] 서비스 워커를 ignore로 건너뜀 — 타당.** `src/mobile/public/**`를 통째로 ignore에 넣었는데 `mobilePushUnit`이
`/src/mobile/public/sw.js`를 가져와 가짜 self로 실행한다 (selftest.ts testMobilePushUnit). 수정: ignore는 아이콘
(`icon-*.png`)·`manifest.webmanifest`만, `sw.js`는 `src/mobile/**` 규칙(모바일 단계들)으로. 확인: `--check` "서비스 워커는
그것을 실행하는 단계".

**R2 [P2] 사이드바 규칙이 작업그룹 트리·배지 검사를 빠뜨림 — 타당.** Sidebar는 작업그룹 worktree를 트리 루트로 쓰고 안 읽은 수
배지를 그린다. 그것을 보는 단계는 groupWorktree(worktree 경로·이름·전환)와 addSession 안의 testChatPanel(사이드바 배지).
수정: FileTree·Sidebar 규칙에 groupWorktree, addSession 추가 (groupWorktree는 앞 단계 repos와 함께). 확인: `--check` "사이드바는
작업그룹 트리·안 읽은 수 배지를 보는 단계까지".

**R3 [P2] 줄 모양으로 맨 위 이름을 찾아 들여 쓴 선언 등을 앞 함수로 봄 — 타당.** 수정: TypeScript 구문 트리
(`ts.createSourceFile`, 저장소의 typescript)로 맨 위 문장마다 범위를 잡는다. 문장 사이의 빈 줄·주석은 다음 문장에 붙인다.
이름은 함수·클래스·타입·하나만 선언한 const/let만, 가져오기와 그 밖의 문장(식, 여러 개 선언 등)은 이름 없음 → 바뀌면 전체.
파일 끝(문장 뒤)도 전체. 분석을 `analyze(text)`로 묶어 `--check`가 고친 소스로 시험한다.
확인: `--check` "들여 쓴 선언 안을 고쳐도 그 함수의 단계"(리뷰 재현: testTrashAndDrag 선언을 들여 쓰고 첫 줄에 throw),
"이름 없는 맨 위 문장이면 전체". 줄 모양 분석으로 되돌리면 두 검사가 실패하고 리뷰와 같이 imeUnit을 고른다.

**R4 [P2] `--files`로 selftest.ts를 주면 고른 것 없음 — 타당.** 바뀐 줄을 모르면 빈 집합으로 고르고 있었다. 수정: 줄을 모르면
전체. 확인: `--check` "바뀐 줄을 모르면(--files) 전체".

`--check` 19개 통과. 이번 수정은 고르기 스크립트와 표만 바꿨다 (selftest.ts·앱 코드 그대로라 앱 실행 결과는 위와 같다).
리뷰어 지적대로 "terminal을 뺀 47단계를 한 번에 통과"는 터미널 검사 없이 전체 순서가 돈다는 근거이고, 각 단계가 기본 준비만으로
혼자 돈다는 근거는 아니다.

## 재리뷰 1회 (#240)

R1·R2·R4 해결 확인. **R3 남음 — 타당.** 다음 문장의 범위를 앞 문장의 끝 줄+1부터 잡아서, 앞 함수의 닫는 괄호와 같은 줄에
다음 선언이 오면(`} async function testTrashAndDrag(…) { throw …`) 그 줄이 앞 함수(testImeUnit)로만 간다.
수정: 맨 위 문장의 시작 줄이 앞 문장의 끝 줄과 같으면 그 줄을 "함께 있는 줄"로 두고, 그 줄이 바뀌면 전체 (리뷰가 충분하다고 한 쪽).
확인: `--check` "맨 위 문장 둘이 한 줄에 있으면 전체" (리뷰 재현과 같은 소스를 메모리에서). 이 처리를 빼면 리뷰와 같이 imeUnit을
골라 실패. `--check` 20개 통과.

## 재리뷰 2회 (#242)

R1–R4 해결 확인, 수정으로 생긴 새 차단 문제 없음. 남는 제한 (사용자에게 알림): 각 단계가 기본 준비만으로 혼자 도는지는 하나씩
확인하지 않았다. 화면이 꺼진 때는 모든 실행이 두 배 넘게 느리다.
