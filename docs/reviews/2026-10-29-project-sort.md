# 사이드바 프로젝트 목록을 이름순으로 (2026-10-29)

**요청** (사용자): 파일 트리의 프로젝트가 추가한 순서로 고정된다. 정렬 방식 세 가지(이름순 자동 / 끌어서 직접 / 둘 다)
가운데 이름순 자동 정렬로.

**원인**: `useProjects.ts` add가 새 프로젝트를 목록 끝에 붙이고(`[...list, 새 항목]`), 불러올 때도 `projects.json`의
순서를 그대로 쓴다. 사이드바(`Sidebar.tsx`)는 그 배열 순서대로 그린다. 폰 목록(`mobile.rs` `/api/projects`)도
`projects.json`의 순서다.

**수정**: `useProjects.ts`에 `sorted`를 두고 불러올 때와 추가할 때 정렬한다.
- 키는 폴더 이름(`baseName`)을 NFC로 맞춘 뒤 소문자로. 파일 트리(`fs.rs` list_dir)처럼 대소문자를 무시한다. 맥 폴더
  이름은 한글이 NFD일 수 있어, NFC 이름과 섞여도 같은 자리에 오게 맞춘다. 이름이 같으면 전체 경로순.
- 정렬한 목록을 저장하므로 `projects.json`, 곧 폰 목록도 같은 순서다. Rust는 그대로 (내용은 프론트가 정한다는 기존 방식).
- 불러올 때 저장된 활성 프로젝트가 없거나 사라졌으면 정렬한 목록의 첫 프로젝트로 간다 (전에는 추가 순서의 첫 프로젝트).
- spec "프로젝트 · 저장소"에 순서를 적음.

**확인**
- tsc 통과, `git diff --check` 통과.
- 자체 테스트 (`SELFTEST_SCENARIOS="main restart" SELFTEST_ONLY=projects`)
  - main projects: 나중에 넣은 `other`가 `proj` 앞 ("이름순 목록", 저장된 목록도 `other,proj`). 대문자 `Zeta`를 넣으면
    `other,proj,Zeta` ("이름순은 대소문자 무시". 글자 코드 순이면 맨 앞). 확인 후 뺀다.
  - restart: `proj, gone` 순서로 저장된 목록이 `gone, proj`로 보이고 그 순서로 다시 저장된다.
- 대조: `sorted`를 정렬 없이 두면 위 네 검사가 모두 실패, 소문자 변환만 빼면 "대소문자 무시"만 실패.
- NFD/NFC 섞임은 자체 테스트에 넣지 않았다 (`String.prototype.normalize`에 기댐).
- 전체 `scripts/selftest.sh`: PASS 515, FAIL 1 — main의 "검색: 터미널 메뉴 찾기(⌘F)로 막대가 열리고 입력란에 포커스".
  그 단계(`terminalSearch`)만 다시 돌리면 검색 검사가 모두 통과한다. 프로젝트 목록과 닿지 않고, 앞선 작업
  (권한 모드)의 전체 실행에서도 같은 검사만 한 번 실패했다가 다시 돌려 통과했다.
