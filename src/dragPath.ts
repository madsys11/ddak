import { invoke } from "@tauri-apps/api/core";

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

// 앱 밖(Finder 등)에서 끌어 온 파일인지 (dragover에서도 종류는 보인다)
export const isFileDrag = (dt: DataTransfer | null) => !isPathDrag(dt) && !!dt?.types.includes("Files");

// 끌기 중에 받은 끌기 대지 번호 (Rust fs.rs drag_count. 새 끌기마다 바뀐다). 받는 쪽의 dragover마다 묻는다 (묻는 중이면 두다).
// 놓을 때 이미 받아 둔 번호만 쓴다: 그 답은 놓기 전에, 곧 이 끌기 중에 읽은 대지의 번호다. 아직 묻는 중인 답은 Rust에서
// 늦게 읽혀 다음 끌기의 번호일 수 있다 (리뷰 재리뷰 R1).
let seenCount: number | null = null;
let asking = false;
export function noteFileDrag() {
  if (asking) return;
  asking = true;
  invoke<number>("drag_count").then(
    (c) => ((asking = false), (seenCount = c)),
    () => (asking = false),
  );
}

// 앱 밖에서 놓은 파일의 경로. 웹뷰는 File(이름)만 주므로 Rust가 끌기 대지에서 경로를 읽는다 (fs.rs drag_files).
// 대지는 놓은 뒤에도 마지막 끌기를 들고 있어서, 끌기 중에 받은 대지 번호(noteFileDrag)와 놓은 뒤 읽은 번호가 같고
// (그 사이 새 끌기가 없었다) 놓은 파일 이름들과 대지의 이름들이 개수까지 똑같을 때만 쓴다. 아니면 빈 목록.
// 이름과 번호는 drop 처리 중에 바로 읽는다 (이름은 그때만 읽을 수 있다).
export function droppedFiles(dt: DataTransfer | null): Promise<string[]> {
  const nfc = (s: string) => s.normalize("NFC");
  const names = [...(dt?.files ?? [])].map((f) => nfc(f.name)).sort();
  const seen = seenCount;
  if (!names.length || seen === null) return Promise.resolve([]);
  return invoke<{ count: number; paths: string[] }>("drag_files").then(
    (got) => {
      const have = got.paths.map((p) => nfc(p.slice(p.lastIndexOf("/") + 1))).sort();
      const same = seen === got.count && have.length === names.length && have.every((n, i) => n === names[i]);
      return same ? got.paths : [];
    },
    () => [],
  );
}

// 입력란 글 before의 start..end를 text로 바꾸는 초안 갱신. 적용할 때 초안이 before가 아니면(그 사이 고침·보내기로 비움)
// 그대로 둔다. React가 여러 갱신을 한 번에 적용해도 늦은 삽입이 새 초안에 들어가지 않는다 (리뷰 재리뷰 R2)
export const insertAt = (before: string, start: number, end: number, text: string) => (d: string) =>
  d === before ? before.slice(0, start) + text + before.slice(end) : d;

// 터미널·채팅 입력란 밖에 앱 밖 파일을 놓으면 받지 않는다: 놓을 수 없게 표시하고 놓아도 무시한다.
// 그냥 두면 WKWebView가 놓은 파일로 이동해 작업 화면이 모두 사라졌다 (Rust의 lib.rs stay_in_app이 이동도 막는다).
// 받는 쪽(Terminal.tsx, ChatPanel.tsx)이 먼저 처리하면 건드리지 않는다. 파일 트리에서 끈 경로·글자 끌기도 그대로 둔다.
export function refuseOutsideDrops(target: Window = window) {
  const refuse = (e: DragEvent) => {
    if (e.defaultPrevented || !isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "none";
  };
  target.addEventListener("dragover", refuse);
  target.addEventListener("drop", refuse);
  return () => {
    target.removeEventListener("dragover", refuse);
    target.removeEventListener("drop", refuse);
  };
}
