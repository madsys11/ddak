# Windows 메뉴 단축키

대상: 기준 23bf140, 커밋하지 않은 변경 (`src-tauri/src/winkeys.rs` 새 파일, `menu.rs`, `lib.rs`, `Cargo.toml`,
`scripts/selftest-plan.json`, `docs/spec.md`, `docs/windows-plan.md`).

## 문제와 원인

Windows에서 메뉴 단축키(Ctrl+T, Ctrl+=, Ctrl+B 등)가 하나도 동작하지 않았다. 사용자 확인: 메뉴 막대는 보이고 메뉴 클릭은
되는데 단축키만 안 된다.

Tauri는 Windows 메뉴 단축키를 앱 메시지 루프의 훅에서 `TranslateAcceleratorW`로 처리한다 (tauri 2.12.5 `app.rs` msg_hook).
웹뷰에 포커스가 있으면 키 입력은 WebView2로 가서 이 루프를 거치지 않는다.

## 수정

- `winkeys.rs`: WebView2 controller의 AcceleratorKeyPressed(KEY_DOWN)에서 메뉴 단축키 표(`menu::shortcuts`)와 맞춰 보고,
  같으면 `SetHandled(true)`로 페이지에 넘기지 않고 `menu::run(id)`을 실행한다. 표에 없는 키는 그대로 페이지로.
- `menu.rs`: 메뉴 이벤트 처리를 `run()`으로 떼고, 단축키 상수를 메뉴와 표가 같이 쓴다. 단축키 문자열 판정 `shortcut_matches`와
  그 테스트 (표의 모든 단축키를 알아보는지 포함).

확인: `cargo test` 새 테스트 통과. 사용자가 개발 빌드에서 실제 키로 확인. 다른 실패 9개(repos·worktrees·claude_trust)는 이 PC에
symlink 권한이 없어서다 (os error 1314, 개발자 모드 꺼짐). 실제 키 입력을 자체 테스트로 만들지는 못했다. 맥 selftest는 돌리지 못했다.

## 리뷰 지적

### R2 (P3) 주석이 실제 보장과 다름

지적: `winkeys.rs`의 "메인 스레드 큐로 미룬다"는 틀리다. 메인 스레드에서 부르면 바로 실행한다.

판단: 타당. tauri-runtime-wry 2.12.3 `lib.rs` `send_user_message`는 지금 스레드가 메인 스레드면 그 자리에서 처리한다.
창 닫기는 `close()`가 `proxy.send_event`로 이벤트 루프에 미룬다 (같은 파일 `fn close`).

수정: `run_on_main_thread`를 빼고 `menu::run`을 바로 부른다. 주석을 실제 동작(창 닫기는 Tauri가 미룸, 나머지는 이벤트 전송)에 맞췄다.
