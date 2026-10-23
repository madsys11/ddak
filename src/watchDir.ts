import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// 폴더를 감시하다가 그 폴더 안이 바뀌면 onChange를 부른다 (src-tauri/src/watch.rs).
// contents: 파일 내용만 바뀐 것도 알린다 (설정 파일). 아니면 항목이 생기거나 없어질 때만 (파일 트리).
// 한꺼번에 많이 바뀌면 이벤트가 몰려 오므로 잠깐 모았다가 한 번 부른다. 돌려준 함수로 감시를 푼다.
export function watchDir(path: string, onChange: () => void, { contents = false, delay = 100 } = {}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // invoke는 호출마다 따로 fetch로 가서 도착 순서가 보장되지 않는다 (tauri scripts/ipc-protocol.js).
  // 해제가 등록보다 먼저 처리되면 감시가 남으므로, 등록이 끝난 뒤에만 해제를 보낸다.
  const watched = invoke("fs_watch", { path }).then(
    () => true,
    (e) => (console.error("폴더 감시 실패", path, e), false),
  );
  const unlisten = listen<{ path: string; entries: boolean }>("fs-changed", ({ payload }) => {
    if (payload.path !== path || (!payload.entries && !contents)) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, delay);
  });
  return () => {
    clearTimeout(timer);
    unlisten.then((f) => f());
    watched.then((ok) => ok && invoke("fs_unwatch", { path }));
  };
}
