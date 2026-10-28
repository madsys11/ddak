# ddak 안의 codex 업데이트 안내 끄기 (2026-10-28)

**문제** (사용자): 리뷰어(codex)가 "ddak 채팅 도구가 연결되지 않았다"며 멈췄다.
**원인** (프로세스 확인): codex 업데이트 안내에서 업데이트(0.164 → 0.165)하면 codex가 끝나고 창에는 셸이 남는다 (pty.rs
shell_command: 명령 뒤 `exec 셸 -l`). 거기서 손으로 `codex resume`을 띄우면 ddak이 준 인자(`mcp_servers.ddak.url="{chat}"` 등)가
빠져 채팅 도구가 없다. dev-review-9 리뷰어(21:35 `codex resume`, 부모 `zsh -l`)와 realbilliards-battle 리뷰어가 그 상태였다.
그 자리에서 ddak을 다시 설치해(다시 켜기) 저장된 인자로 이어서 띄워 풀었다.

**수정** (사용자 승인: 재발 방지 2번):
- `groups.rs` 기본 설정의 codex(리뷰어) 처음·복원 인자에 `-c check_for_update_on_startup=false`. spec "작업그룹 구성" 기본 설정.
- 사용자의 `groups.json`에도 같은 인자를 넣었다 (앱 데이터, 백업 `groups.json.bak-20261028-before-codex-update-off`). 저장소
  밖의 사용자 데이터라 커밋에는 없다.

**설정 키 확인** (codex 0.165.0):
- 바이너리 문자열에 `check_for_update_on_startup`이 있다.
- `codex -c check_for_update_on_startup=false mcp list`는 정상, `="notabool"`이면 "failed to load bootstrap configuration"
  (키를 읽고 형을 검사한다). 모르는 키(`no_such_key_xyz`)는 오류 없이 넘어가므로, 형 오류가 나는 것이 키가 쓰인다는 근거다.
- 안내가 실제로 안 뜨는지는 지금 최신이라 볼 수 없다 (다음 codex 버전이 나온 뒤 확인).

**확인**: Rust `default_is_valid`에 리뷰어의 처음·복원 인자 모두 `-c check_for_update_on_startup=false`를 갖는지 추가. 기본
설정에서 빼면 실패. Rust groups 테스트 통과.

**한계**: 이미 열린 탭은 저장할 때의 인자로 복원돼서 (spec) 이 인자가 없다. 새 작업그룹·새로 추가한 세션부터 적용된다.

## 리뷰 1차 (reviewer-2 #339)

차단 지적 없음. 리뷰어가 기본 설정의 처음·복원 인자를 독립 검사했고, 키의 형(boolean)과 의미(시작할 때 업데이트 확인)를 공식
설정 문서와 대조했다. 이미 저장된 탭에 적용되지 않는 한계도 기록과 코드가 맞다고 확인.
