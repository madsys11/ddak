# 폰에 보일 컴퓨터 이름을 맥 창에서 바꾸기 (2026-10-30)

**요청** (사용자): Tailscale 기기 이름을 바꾸고 다시 페어링했는데 폰 앱의 컴퓨터 이름이 그대로다.
세 가지 안(맥 창에서 이름 정하기 / Tailscale 이름 쓰기 / 폰에서 별명) 가운데 1번 "맥 창에서 이름 정하기"를 골랐다.

**원인**: 폰에 보일 이름은 모바일 연결을 처음 켤 때 macOS ComputerName을 `mobile/config.json`에 저장한 값이고, 바꿀 곳이 없다.
Tailscale 기기 이름(주소)과는 관계가 없다. 폰은 페어링 때 받은 이름을 저장하고 다시 받지 않는다.

**수정**
- `src-tauri/src/mobile.rs`: `Mobile::set_name`·`mobile_set_name` 명령. 앞뒤 공백·제어 문자를 빼고 64자(`NAME_MAX`)까지,
  비우면 이 컴퓨터 이름(`host_name`)으로. `lib.rs`에 등록.
- `src/MobileDialog.tsx`: "폰에 보일 이름" 칸 (`mobile.name`, en·ko). 칸을 벗어나거나 Enter(한글 조합 중 제외)면 저장하고,
  Rust가 다듬은 이름으로 칸을 되돌린다. Esc로 창을 닫으면 저장하지 않는다.
- `src/mobile/MobileApp.tsx`: 컴퓨터 목록·프로젝트 목록이 `/api/info`를 받으면 `rename`으로 저장한 이름을 맞춘다. 여러 컴퓨터가
  잇달아 답해도 서로 덮어쓰지 않게 저장소에서 다시 읽어 고친다. 이름이 같으면 아무것도 하지 않는다 (다시 그리기 반복 없음).
  컴퓨터 목록의 업데이트 안내도 받은 이름을 쓴다. 시험을 위해 `ProjectList`를 내보낸다.
- 알림 제목은 원래 `config.name`을 써서 그대로 따라온다.
- spec "모바일 연결"의 설정·폰 화면 항목에 적음.

**확인**
- tsc, `npm run build:mobile` 통과. cargo test 전체 136개 통과. 다만 처음 한 번은 1개가 실패했다(20초 걸린 실행).
  어느 시험인지 출력을 남기지 못했고, 그 뒤 8번 다시 돌려 한 번도 재현되지 않았다.
- Rust `renaming_trims_limits_and_falls_back_to_host_name`: 공백·줄바꿈 정리 후 저장 파일, 64자 자르기, 비우면 이 컴퓨터 이름.
- 자체 테스트 `mobile`: 실제 창의 칸에서 "  Selftest Studio  "로 바꾸고 칸을 벗어나면 `/api/info` 이름이 "Selftest Studio",
  칸도 그 값. 비우면 원래 이름으로 돌아가고 칸도 되돌아간다.
- 자체 테스트 `mobileThemeUnit`: 저장한 이름이 "Old Mac"인 컴퓨터를 `ComputerList`와 `ProjectList`로 그리면 둘 다 `/api/info`의
  "Mac"으로 이름을 맞춘다.
- 대조: `host_name` 되돌림을 빼면 Rust 시험이, `onBlur` 저장을 빼면 `mobile` 검사가, `onRename` 호출을 빼면 폰 검사가 실패한다.
- 전체 `scripts/selftest.sh`: 다섯 시나리오 모두 통과, PASS 531, FAIL 0.

## 리뷰 1회 (origin/reviewer-2, #437)

대상: HEAD e87be86 + 미커밋 변경 전체.

**R1 · P2 · 타당 → 수정**: 이름 저장 응답이 그 사이 다시 고친 이름을 지운다.
- 근거: `saveName`은 `await run("mobile_set_name")` 뒤에 무조건 `setName(null)`을 부른다. 저장은 Tailscale 상태를 다시 읽은
  뒤에 응답하므로(실제 앱에서 CLI 두 번) 그동안 칸을 다시 눌러 고칠 수 있었다. 고친 값은 응답이 오면 저장 요청 없이 사라진다.
  코드로 확인했고, 리뷰어가 실제 `MobileDialog.tsx`를 모의 invoke로 돌려 재현했다.
- 수정: 저장하는 동안(`busy`) 칸을 잠근다(`disabled={busy}`). 저장이 하나씩만 진행되어 응답 순서 문제도 생기지 않는다.
  다른 동작(켜기, Serve, 연결 끊기)은 칸 밖을 눌러야 하므로 칸이 먼저 저장을 시작한다.
- 확인: `mobile` 검사에 "칸을 벗어나 저장을 시작하면 응답까지 칸이 잠기고, 끝나면 풀린다"를 추가했다. 수정 후 통과하고,
  `disabled={busy}`를 빼면 실패한다(`잠김=false`).
- 전체 `scripts/selftest.sh` (R1 수정 후): 첫 실행에서 `terminalSearch`의 "검색: 다시 열면 빈 입력, ×로 닫힘" 1건이 실패했다
  (×로 닫은 뒤 포커스가 터미널에 없음, 다시 focus하면 됨). 이번 변경이 닿지 않는 터미널 검색이다. 그 단계만 두 번 돌리면
  통과하고, 전체를 다시 돌리면 다섯 시나리오 모두 통과, PASS 531, FAIL 0.

## 재리뷰 1회 (origin/reviewer-2, #439)

R1 해소, 차단 지적 없음. 처음 cargo test의 실패 1건은 원인을 모르는 채로 남는다 (위 확인 항목).
