# 실험: 대화형 claude·codex를 터미널 입력으로 깨우기 (2026-10-24)

깨우기는 멘션된 세션의 터미널에 알림 문구와 Enter를 입력한다 (스펙). 대화형 화면이 그 입력을 제출로 받는지, 작업 중일
때는 어떻게 되는지 확인했다.

## 방법

`#[ignore]` 실험 테스트(커밋하지 않음)로 채팅 서버를 띄우고 참여자 `origin/dev`를 만들었다. 실제 CLI를 PTY에 대화형으로
띄우고 그 주소를 인자로 붙였다. 화면이 뜨기를 12초 기다린 뒤 다음을 했다.
1. 사용자가 `@origin/dev Reply exactly 'pong' to @user with post_message.`를 보낸다.
2. 터미널에 알림 문구를 쓰고, 잠시 뒤 Enter(`\r`)를 따로 쓴다.
3. 그 참여자의 답이 올 때까지 기다린다.

- claude 2.1.310 (haiku): `--mcp-config … --allowedTools mcp__ddak`
- codex 0.164: `-c mcp_servers.ddak.url=… -c mcp_servers.ddak.default_tools_approval_mode="approve"`
- 폴더는 두 CLI가 이미 신뢰한 폴더 (새 폴더의 신뢰 질문을 피하려고)

## 결과

| CLI | 문구와 Enter 사이 | 결과 |
|---|---|---|
| claude | 200ms | 13초 만에 `read_messages`로 읽고 `@user pong`으로 답함 |
| claude | 0ms (한 번에) | 120초 동안 답 없음. 한 번에 들어온 입력을 붙여넣기로 봐서 Enter가 제출이 아니었다 |
| codex | 200ms | 11초 만에 읽고 답함 |

작업 중: 첫 알림으로 일하는 동안 (3초 뒤) 두 번째 메시지와 알림을 보냈다. 둘 다 처리됐다 (claude 6.5초, codex 22초).
codex는 답에 `@user`를 붙이지 않아서, 메시지는 남았지만 사용자에게 알림(`to`)이 가지 않았다.

## 결정

- 알림 문구를 쓰고 300ms 뒤에 Enter를 따로 보낸다 (200ms로 됐고, 0ms는 안 됐다. 여유를 둔다).
- 작업 중이어도 그대로 보낸다 (두 CLI 모두 처리했다).
- 문구에 보낸 사람과 "post_message로 답하고, 받을 사람을 @멘션하라"를 넣는다.
