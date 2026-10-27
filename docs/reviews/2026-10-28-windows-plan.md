# Windows 지원 계획 문서 리뷰

대상: `docs/windows-plan.md`(새 파일), `docs/spec.md` 배포 계획의 Windows 줄. 기준 `e5d49b8` + 커밋 안 한 변경. 코드 변경 없음.
사용자 결정 W1(x64 PC + CI)·W2(Git Bash)·W3(⌘→Ctrl 그대로)는 리뷰 범위 밖.

## 리뷰 1차

### R1 [P2] Windows 앱 화면 출처가 빠짐 — 타당

- 근거: `lib.rs` `app_page`는 `tauri:`·`about:`·개발 서버 출처만 허용한다. Tauri 2.12.5 `manager/mod.rs:335,790,798`은
  Windows 앱 주소를 `http://tauri.localhost`(또는 https)로 쓴다. 설치판에서는 첫 화면 이동부터 막혀 0단계 끝 조건("창이 뜬다")을
  확인할 수 없다.
- 수정: 0단계에 플랫폼별 출처 허용과 Rust 테스트(허용·거절)를 넣고, 끝 조건을 "앱 화면이 뜨고 새로 고침해도 남음"으로 바꿈.

### R2 [P2] 파일 이름 검사에 Windows 분기가 필요 — 타당

- 근거: `fs.rs` check_name은 빈 이름·`.`·`..`·`/`만 막는다. Windows의 `Path::join`은 `C:\밖`이면 경로를 바꾸고 `..\밖`은 부모로
  나간다. `child_path`를 `fs_create`·`fs_rename`·`repos.rs`가 쓴다.
- 수정: 계획에 "파일 이름" 절 (거절할 이름, 결과 경로의 부모가 그 폴더인지 다시 보기, Windows cargo test).

### R3 [P2] Job Object에 넣는 시점과 끝난 것의 판정이 빠짐 — 타당

- 근거: portable-pty 0.9 `win/psuedocon.rs:139-145`의 `CreateProcessW` 플래그는 `EXTENDED_STARTUPINFO_PRESENT |
  CREATE_UNICODE_ENVIRONMENT`이고 `CREATE_SUSPENDED`가 없다. 띄운 뒤 Job에 넣으면 그 사이 자식이 빠질 수 있다.
- 수정: "세션 끝내기" 절. 처음부터 Job 안에서 시작하는 두 후보(도우미 거치기, `PROC_THREAD_ATTRIBUTE_JOB_LIST`)를 1단계 처음에
  실험해 고름, KILL_ON_JOB_CLOSE로 앱 종료 때 정리, 프로세스 수 0을 기다림, 시험 목록.

### R4 [P2] 확장 길이 경로(`\\?\`)의 경계가 정해지지 않음 — 타당

- 근거: Rust 문서상 Windows `canonicalize`는 `\\?\` 형식을 돌려준다. canonicalize를 쓰는 Rust 파일이 16개다.
- 수정: "경로" 절. 내부 비교용과 바깥용을 나누고 바꾸는 함수를 하나로, 지원 범위(드라이브·UNC), 긴 경로는 처음엔 미지원이며
  실패 때 정리와 저장 상태 보존, 시험 목록.

### 비차단 [P3] — 모두 반영

- 링크 차단: 예시 목록이 아닌 정책으로 ("링크 열기" 절: 형식 목록 + `AssocIsDangerous`, 두 경로 모두, 판정 못하면 보이기만, 시험).
- W3: `menu.rs`에 Ctrl+G가 없다 (확인함, 잘못 적었음). 실제 예약 키 목록으로 고치고 1단계 실제 키 검사 목록을 넣음.
- 개발자 모드: 일반 사용자 조건으로 고치고, 실패 때 worktree·브랜치가 반쯤 남지 않는지 시험.
- 2단계 끝 조건: 모든 자체 테스트 시나리오 + 흉내만 내는 네이티브 기능의 직접 확인 목록.
- SetThreadExecutionState: 스레드에 걸리는 상태라 전용 스레드가 쥐고 푸는 것을 표에 적음.

## 재리뷰 1회

R1·R2·R4·P3 해결 확인. R3 남은 두 가지:

### R3-a 완료 포트 알림만으로 판정하면 영구히 "닫는 중" — 타당

- 근거: `JOBOBJECT_ASSOCIATE_COMPLETION_PORT` 문서가 알림 전달을 보장하지 않는다고 적는다.
- 수정: 판정은 `ActiveProcesses` 조회(50ms마다 다시)로만 하고, 완료 포트는 일찍 깨우기에만 쓴다.

### R3-b 도우미 후보에서 등록 전 종료와 뒤늦은 등록이 엇갈림 — 타당

- 근거: 도우미는 Job 밖에서 시작해 스스로 등록한다. 등록 전에 끝내기가 오면 빈 Job의 0을 보고 끝냈다고 한 뒤 도우미가 등록하고
  bash를 띄울 수 있다. 0이라는 관측은 이후 등록을 막지 않는다.
- 수정: ddak이 도우미의 프로세스 핸들도 쥐고 끝내기에서 함께 끝내며, 판정은 "도우미가 끝남 + 0". 도우미는 등록에 성공한
  뒤에만 bash를 띄우고 Job 핸들을 바로 닫는다 (KILL_ON_JOB_CLOSE가 ddak 종료로 동작하게). Job 이름은 추측할 수 없게.
  시험: 도우미를 등록 직전에 멈춘 채 닫기·작업그룹 끝내기·ddak 종료.

## 재리뷰 2회

R1~R4 모두 계획 수준에서 해결, 새 차단 문제 없음. 리뷰는 문서·API 계약의 정적 대조다. Job 후보의 성공 여부와 Windows 실제
동작은 1단계 실험과 단계별 끝 조건(CI·실기기)으로 확인한다.
