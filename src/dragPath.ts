// 파일 트리에서 끌어 온 경로 (터미널·채팅 입력란에 놓는다). path: 절대 경로, rel: 트리 루트(프로젝트나 작업그룹 worktree)
// 기준 상대 경로 (루트 밖이면 없음). 작업그룹마다 worktree가 달라도 상대 경로는 같은 파일을 가리킨다.
export type DraggedPath = { path: string; rel?: string };

export const PATH_DRAG = "application/x-ddak-path";

export function setDraggedPath(dt: DataTransfer, path: string, root: string) {
  const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
  dt.setData(PATH_DRAG, JSON.stringify({ path, rel } satisfies DraggedPath));
  dt.setData("text/plain", path);
  dt.effectAllowed = "copy";
}

// 파일 트리에서 끈 것인지 (dragover에서는 값을 읽을 수 없고 종류만 보인다)
export const isPathDrag = (dt: DataTransfer | null) => !!dt?.types.includes(PATH_DRAG);

export function draggedPath(dt: DataTransfer | null): DraggedPath | null {
  try {
    const v = JSON.parse(dt?.getData(PATH_DRAG) || "null");
    return v && typeof v.path === "string" ? { path: v.path, rel: typeof v.rel === "string" ? v.rel : undefined } : null;
  } catch {
    return null;
  }
}

// 셸에 그대로 넣을 수 있게 감싼다: 안전한 글자만 있으면 그대로, 아니면 작은따옴표로 (안의 '는 '\'')
export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// 앱 밖(Finder 등)에서 끌어 온 파일은 받지 않는다: 아무도 받지 않은 파일 끌기는 놓을 수 없게 표시하고 놓아도 무시한다.
// 그냥 두면 WKWebView가 놓은 파일로 이동해 작업 화면이 모두 사라졌다 (Rust의 lib.rs stay_in_app이 이동도 막는다).
// 파일 트리에서 끈 경로·글자 끌기는 건드리지 않는다 (받는 쪽이 먼저 처리한다).
export function refuseOutsideDrops(target: Window = window) {
  const refuse = (e: DragEvent) => {
    if (e.defaultPrevented || !e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "none";
  };
  target.addEventListener("dragover", refuse);
  target.addEventListener("drop", refuse);
  return () => {
    target.removeEventListener("dragover", refuse);
    target.removeEventListener("drop", refuse);
  };
}
