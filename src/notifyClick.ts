// 알림을 누르면 갈 프로젝트 (src/App.tsx, src-tauri/src/notify.rs "notification-click"). 알림의 프로젝트는 채팅방이 쓰는
// 실제 경로라서 (pty.rs join_chat canonicalize) 링크 경로로 등록한 프로젝트와 글자가 다를 수 있다 (리뷰 R1: /tmp ↔ /private/tmp).
// 등록 경로와 같으면 그것, 아니면 등록 경로들의 실제 경로(real)로 찾아 등록 경로를 돌려준다. 없으면 null
export async function projectForClick(paths: string[], target: string, real: (path: string) => Promise<string>): Promise<string | null> {
  if (paths.includes(target)) return target;
  for (const path of paths) {
    if ((await real(path).catch(() => path)) === target) return path;
  }
  return null;
}
