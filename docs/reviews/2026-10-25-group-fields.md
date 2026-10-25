# 작업 기록: 역할·규약을 groups.json 필드로 (2026-10-25)

작업그룹 협업 규약 설계(`docs/reviews/2026-10-25-group-protocol-design.md`)의 3단계. 설계 리뷰 지적 2(`{prompt}` 문자열 문맥)와
7(복원)을 반영한다. 리뷰 대응은 아래에 덧붙인다.

## 바뀐 것

- `groups.json`: 그룹에 `rules`, 세션에 `role` (둘 다 없어도 된다. 예전 파일도 읽힌다).
- 자리표시자: `pty.rs` fill_placeholders가 `{chat}`, `{session}`, `{prompt}`와 `{이름:toml}`을 한 번에 바꾼다. 넣은 값은 다시 보지
  않는다 (전에는 프론트가 `{session}`, Rust가 `{chat}`을 차례로 바꿔서 값 안의 `{chat}`이 바뀔 수 있었다). `:toml`은 TOML 문자열
  리터럴 (따옴표, `"`, `\`, 줄바꿈 등 이스케이프). 모르는 이름과 JSON 중괄호는 그대로.
- 프롬프트 = 역할 + 빈 줄 + 그 세션이 든 그룹의 규약. 세션을 만들 때 정해 `PaneSession.prompt`로 저장하고 처음·복원·fallback에
  같은 값을 쓴다. 다른 그룹의 세션을 지금 탭에 더하면 그 세션이 든 그룹의 규약 (지금 탭의 그룹이 아니라: 역할 문구가 그 그룹의
  규약을 전제로 쓰였다).
- 프론트는 자리표시자를 바꾸지 않고 값(`vars`)을 `pty_spawn`에 넘긴다.
- 기본 설정: 규약·역할을 필드로 옮기고 인자는 `{prompt}`(claude)·`developer_instructions={prompt:toml}`(codex). 규약 문구에
  줄바꿈을 쓸 수 있게 되어 규칙마다 줄을 나눴다.

## 확인

- Rust: placeholders_fill_once (값 안의 `{chat}`·따옴표·역슬래시·줄바꿈, 모르는 이름, JSON), rules_and_role_are_optional,
  default_is_valid (필드와 자리표시자). 75개 통과.
- selftest addSession: 역할 `R {chat}` + 그룹 규약 `S2` 세션이 `A:R {chat}` / `B:v="R {chat}\n\nS2"`를 찍는다.
- selftest resume: 저장한 뒤 설정의 역할을 KP1 → KP2로 바꿔도 복원은 저장한 KP1을 쓴다. corrupt: 기본 설정의 필드와 자리표시자.
- 수정을 끄면 (차례로 바꾸기, 프롬프트 저장 안 함) 위 Rust·selftest 검사가 실패한다 (역할 안의 `{chat}`이 실제 주소로 바뀜).

## 사용자 groups.json

이 버전을 설치하기 전에는 바꾸지 않는다: 설치된 앱은 모르는 키(`rules`, `role`)를 오류로 보고 `{prompt}`를 바꾸지 않는다.
(한 번 바꿨다가 이를 알아채고 바로 되돌렸다.) 설치한 뒤 새 형식으로 바꾼다.
