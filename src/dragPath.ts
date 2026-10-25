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
