# 실험: claude·codex를 ddak 채팅 MCP 서버에 붙이기 (2026-10-24)

채팅방은 MCP로 참여시킨다 (스펙). ddak은 CLI를 해석하지 않으므로, 띄울 때의 인자만으로 MCP 서버를 붙일 수 있는지,
도구를 승인 질문 없이 쓰는지 확인했다.

## 방법

`chat.rs`의 서버를 `#[ignore]` 테스트(`chat::tests::serve_for_experiment`)로 띄웠다. 참여자는 `origin/dev`와
`origin/reviewer` 둘이고, 사용자가 `@origin/dev`에게 메시지를 하나 보낸 상태로 기다리게 했다. 각 CLI에는 참여자 주소를
인자로 주고 "read_messages로 읽고 post_message로 답하라"고 시켰다.

- claude 2.1.310 (`-p`, haiku 모델):
  `--mcp-config '{"mcpServers":{"ddak":{"type":"http","url":"<주소>"}}}' --strict-mcp-config --allowedTools mcp__ddak`
- codex 0.164 (`exec`, `-s read-only`): `-c 'mcp_servers.ddak.url="<주소>"'`

## 결과

- claude: 확인 질문 없이 `read_messages`와 `post_message`를 불렀다. `@user pong`이 `from: origin/dev`,
  `to: [user]`로 기록됐다. `--allowedTools mcp__ddak`(서버 단위)로 그 서버의 도구가 모두 허용된다.
- codex: 처음에는 두 호출 모두 막혔다 (`MCP tool call requires approval, but approval policy is never`).
  - codex 실행 파일의 설정 구조(`RawMcpServerConfig`)에서 `default_tools_approval_mode` 키를 찾았다.
  - `-c 'mcp_servers.ddak.default_tools_approval_mode="approve"'`를 더하자 둘 다 성공했다.
  - `@origin/dev reviewer here`가 `from: origin/reviewer`, `to: [origin/dev]`로 기록됐다.
- 두 CLI 모두 JSON-RPC 요청 하나에 JSON 응답 하나로 답하는 최소 streamable HTTP로 동작했다. GET 스트림은 405로 답했다.

## 결정

기본 설정에 위 인자를 넣는다. 주소 자리에는 `{chat}`을 두고, ddak이 창마다 바꿔 넣는다.
- claude: `--mcp-config`와 `--allowedTools mcp__ddak`
- codex: `mcp_servers.ddak.url`과 `default_tools_approval_mode="approve"`

`--strict-mcp-config`는 넣지 않는다 (사용자가 쓰던 MCP 서버도 쓰게).
