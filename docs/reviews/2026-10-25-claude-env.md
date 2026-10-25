# 작업 기록: 터미널에 claude 세션 표시를 넘기지 않기 (2026-10-25)

스펙의 미결정 사항 "ddak 터미널에 `CLAUDE_CODE_*` 환경변수를 넘길지"를 정한다.

## 실제로 생긴 일

claude 세션 안에서 `scripts/install.sh`를 돌려 앱을 바꿨더니, 다시 열린 앱(`/Applications/ddak.app`)이 그 claude의
`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET` 등을 물려받았다
(`ps -E`로 확인). 앱이 PTY에 환경을 그대로 넘겨서, 이어서 하기로 다시 뜬 claude들도 이 값을 가졌다. 이전 기록
(`2026-10-24-claude-worktree-hook.md`)대로 이 상태의 claude는 하위 세션으로 보고 대화 기록을 저장하지 않는다.
`open`은 부른 쪽의 환경을 앱에 넘긴다 (Finder·Dock에서 연 앱은 해당 없음).

## 결정

- 터미널(PTY) 환경에서 claude 세션 표시를 뺀다 (`pty.rs` strip_claude_session_vars). 처음에는 `CLAUDE_CODE_*` 전체를
  지웠으나 리뷰 R1로 이름 목록으로 바꿨다 (아래).
- `install.sh`는 앱을 다시 열 때 같은 표시를 뺀다 (앱 자체에도 남기지 않게).

## 확인

- Rust `claude_session_vars_are_not_inherited`: 표시는 빠지고 `CLAUDE_CONFIG_DIR`, `PATH`는 남는다.
- selftest `terminal` 단계: `selftest.sh`가 앱 환경에 `CLAUDECODE=1`, `CLAUDE_CODE_CHILD_SESSION=selftest`,
  넘기는 쪽 예를 넣고, 터미널에서 `ENV:[][][keep]`를 확인한다 (지금 예는 R1의 `CLAUDE_CODE_DDAK_SELFTEST`).
  처음에는 넘기는 쪽 예로 `CLAUDE_CONFIG_DIR=/nonexistent/…`를 썼다가, 그것이 실제로 넘어가 claude 검사의 claude가 첫 실행
  화면을 띄워 전체 테스트가 실패했다 (넘기기가 동작한다는 증거이기도 하다). 아무도 읽지 않는 이름으로 바꿨다. 빼는 줄을 끄면 `ENV:[1][selftest][…]`로 실패한다.
- `test-install.sh`: 가짜 open이 받은 환경에 표시가 없고 `CLAUDE_CONFIG_DIR`는 있다. 빼는 줄을 끄면 실패한다.
- 기타: 되돌린 직후 cargo test가 한 번 실패했다 (자체 테스트 직후, 평소 4초인 실행이 7초. 어느 테스트인지 기록하지 못함).
  이어서 다섯 번 돌려 모두 통과했다.

## 지금 떠 있는 앱

이 수정 전 버전이 claude 표시를 가진 채 떠 있다. 이 버전을 설치하면 (표시를 뺀 환경으로 다시 열어) 풀린다.

## 리뷰 (채팅 #56)

### R1 `CLAUDE_CODE_*` 전체를 지우면 사용자 설정도 지운다 (P2) — 타당, 수정

**검증**: 공식 문서의 환경변수 목록에 `CLAUDE_CODE_USE_BEDROCK`(Bedrock 사용), `CLAUDE_CODE_MAX_OUTPUT_TOKENS`(출력 토큰 한도)
같은 사용자 설정이 같은 접두사로 있다. 처음 결정의 "로그인 셸이 다시 넣는다"는 셸 설정 파일에 둔 값에만 맞고, 앱을 연 환경으로
준 값은 사라진다.

**수정**: 접두사 대신 이름 목록(`pty.rs` CLAUDE_SESSION_VARS, claude 안에서 띄운 앱의 환경에서 본 세션 표시)을 지운다.
`CLAUDE_EFFORT`도 그 환경에 있었지만 사용자 설정일 수 있어 남긴다. `install.sh`는 같은 목록을 지우고, Rust 테스트가 두 목록이
같은지 본다.

**확인**
- Rust: 목록은 빠지고 `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_EFFORT`, `CLAUDE_CONFIG_DIR`,
  `PATH`는 남는다. install.sh 목록이 같다.
- test-install 1-1: `CLAUDE_CODE_USE_BEDROCK=1`은 넘어간다.
- selftest terminal: 넘기는 쪽 예를 같은 접두사의 `CLAUDE_CODE_DDAK_SELFTEST=keep`으로 바꿨다.
- 접두사로 지우던 것을 되살리면 셋 다 실패한다.
