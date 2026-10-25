# 작업 기록: 휴지통·끌어 놓기·대화 지우기 (2026-10-25)

사용자 요청: 채팅의 이전 대화 지우기, 파일 트리의 파일 삭제와 터미널·채팅 입력란으로 끌어다 놓기.
사용자 결정: 대화는 전체 지우기 (보관), 끌어 놓기는 터미널에 절대 경로·채팅에 트리 루트 기준 상대 경로.
리뷰 대응은 아래에 덧붙인다.

## 판단

- 삭제는 휴지통으로 (되살릴 수 있게). NSFileManager trashItemAtURL은 이미 쓰는 objc2-foundation의 기능만 켜면 된다.
  자체 테스트는 사용자 휴지통이 쌓이지 않게 `DDAK_DATA_DIR/trash`로 옮기고, 실제 휴지통은 `#[ignore]` 테스트로 본다
  (`cargo test -- --ignored trash`, 사용자 휴지통에 시험 파일 하나가 남는다).
- 대화 지우기는 번호를 이어서 매긴다. 세션의 read_messages는 읽은 위치를 번호로 기억하므로 1부터 다시 쓰면 지운 뒤의
  새 메시지를 "이미 읽음"으로 건너뛴다. 지운 지점을 새 파일의 첫 줄에 남겨 앱을 다시 켜도 이어진다.
- 채팅의 상대 경로 기준은 트리 루트 (프로젝트나 지금 탭의 작업그룹 worktree): 세션마다 worktree가 달라도 같은 파일.

## 확인

- Rust: clear_archives_and_keeps_numbering (빈 방, 보관 파일, 이어지는 번호, 다시 켠 뒤), trash_moves_to_macos_trash(ignore).
- selftest trashDrag (혼자 돈다): 취소하면 그대로, 확인하면 트리·디스크에서 사라져 trash로. 합성 DragEvent로 터미널에
  `'<루트>/d d'\''s.txt' `, 채팅 입력란에 `keep.txt `. addSession(채팅 패널): 지우기 취소·확인, 버튼 끔, 번호 16→17.
- 수정을 끄면 (휴지통 무시, 놓기 무시, 지운 지점 무시) 위 검사가 실패한다.
- 한계: 실제 마우스 끌기는 합성 이벤트라 직접 확인해야 한다.

## 설치 뒤: 실제로 끌어 놓아도 들어가지 않음 — 원인, 수정

**보고**: 사용자가 설치한 앱에서 파일·폴더를 터미널이나 채팅 입력란에 끌어다 놓아도 아무것도 들어가지 않았다.

**원인** (소스): Tauri는 창마다 네이티브 끌어 놓기 처리기를 켜 둔다 (`dragDropEnabled` 기본 true). 그 처리기는 끌기 이벤트마다
늘 `true`를 돌려주고 (`tauri-runtime-wry` lib.rs `with_drag_drop_handler`), wry는 true면 WKWebView의 기본 처리를 부르지 않는다
(`wry` src/wkwebview/drag_drop.rs `dragging_entered`·`perform_drag_operation`). 그래서 웹뷰 안의 HTML 끌어 놓기도 dragover·drop이
페이지에 오지 않는다. 자체 테스트는 페이지 안에서 합성 DragEvent를 보내서 이 단계를 거치지 않았다.

**수정**: `tauri.conf.json` 창 설정에 `"dragDropEnabled": false`. 앱은 Tauri의 파일 끌어 놓기 이벤트를 쓰지 않는다.
**확인**: Rust `native_drag_drop_is_off` (설정을 true로 바꾸면 실패). selftest trashDrag 통과. 실제 마우스 끌기는 설치 뒤 직접 확인.
