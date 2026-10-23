import { createContext, useContext, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MenuItem } from "./ContextMenu";
import { codeError } from "./errors";
import { RepoIcon, WorktreeIcon } from "./icons";
import { useT } from "./prefs";

type Entry = { name: string; path: string; is_dir: boolean; git: "repo" | "worktree" | null; link: string | null };
type Kind = "file" | "dir";

// 트리 전체가 함께 쓰는 상태: 새 항목 입력란이 열린 폴더, 오른쪽 클릭 메뉴 (Sidebar가 제공)
type Tree = {
  creating: { dir: string; kind: Kind } | null;
  startCreate: (dir: string, kind: Kind) => void;
  endCreate: () => void;
  openMenu: (e: React.MouseEvent, items: MenuItem[]) => void;
};
export const TreeContext = createContext<Tree | null>(null);
export const useTree = () => useContext(TreeContext)!;

// 폴더에 대한 메뉴 항목. 파일을 오른쪽 클릭하면 그 파일이 든 폴더에 만든다 (VS Code와 같음).
export function useFolderMenu() {
  const t = useT();
  const tree = useTree();
  return (dir: string): MenuItem[] => [
    { label: t("tree.newFile"), action: () => tree.startCreate(dir, "file") },
    { label: t("tree.newFolder"), action: () => tree.startCreate(dir, "dir") },
  ];
}

// 이 폴더에 새 항목을 만드는 중이면 펼친다.
export function useOpenWhenCreating(dir: string, setOpen: (open: boolean) => void) {
  const { creating } = useTree();
  useEffect(() => {
    if (creating?.dir === dir) setOpen(true);
  }, [creating, dir, setOpen]);
}

// 펼쳐져 있는 동안 폴더를 감시하고 바뀌면 다시 읽는다 (src-tauri/src/watch.rs).
// npm install처럼 한꺼번에 많이 바뀌면 이벤트가 몰려 오므로 잠깐 모았다가 한 번 읽는다.
function useEntries(path: string) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      invoke<Entry[]>("list_dir", { path }).then(
        (e) => alive && (setEntries(e), setError(null)),
        (e) => alive && setError(String(e)),
      );
    load();
    // invoke는 호출마다 따로 fetch로 가서 도착 순서가 보장되지 않는다 (tauri scripts/ipc-protocol.js).
    // 해제가 등록보다 먼저 처리되면 감시가 남으므로, 등록이 끝난 뒤에만 해제를 보낸다.
    const watched = invoke("fs_watch", { path }).then(
      () => true,
      (e) => (console.error("폴더 감시 실패", path, e), false),
    );
    const unlisten = listen<string>("fs-changed", ({ payload }) => {
      if (payload !== path) return;
      clearTimeout(timer);
      timer = setTimeout(load, 100);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      unlisten.then((f) => f());
      watched.then((ok) => ok && invoke("fs_unwatch", { path }));
    };
  }, [path]);
  return { entries, error };
}

// 폴더 하나의 내용. 프로젝트 목록(Sidebar)이 프로젝트 아래에 이것을 놓는다.
export function Children({ path, depth }: { path: string; depth: number }) {
  const { entries, error } = useEntries(path);
  const { creating } = useTree();
  if (error) return <div className="tree-error" style={{ paddingLeft: indent(depth) }}>{error}</div>;
  if (!entries) return null;
  return (
    <>
      {creating?.dir === path && <NewEntry dir={path} kind={creating.kind} depth={depth} />}
      {entries.map((e) => (
        <Node key={e.path} entry={e} dir={path} depth={depth} />
      ))}
    </>
  );
}

// 새 파일·폴더 이름 입력란. Enter로 만들고 Esc나 다른 곳을 누르면 취소.
function NewEntry({ dir, kind, depth }: { dir: string; kind: Kind; depth: number }) {
  const t = useT();
  const { endCreate } = useTree();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) return endCreate();
    try {
      await invoke("fs_create", { dir, name, kind });
      endCreate(); // 새 항목은 폴더 감시로 목록에 들어온다
    } catch (raw) {
      const { code, detail } = codeError(raw);
      setError(code === "exists" ? t("tree.error.exists", { name: detail }) : code === "badName" ? t("tree.error.badName") : detail);
    }
  }

  return (
    <>
      <div className="tree-row tree-input-row" style={{ paddingLeft: indent(depth) }}>
        <span className="tree-twisty">{kind === "dir" ? "▸" : ""}</span>
        <input
          className={`tree-input${error ? " invalid" : ""}`}
          data-kind={kind}
          autoFocus
          spellCheck={false}
          value={name}
          placeholder={t(kind === "dir" ? "tree.newFolder" : "tree.newFile")}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            // 한글 조합을 확정하는 Enter는 만들기가 아니다. WebKit은 조합 중 키에 keyCode 229를 준다.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") endCreate();
          }}
          onBlur={endCreate}
        />
      </div>
      {error && (
        <div className="tree-error" style={{ paddingLeft: indent(depth) + 14 }}>
          {error}
        </div>
      )}
    </>
  );
}

function Node({ entry, dir, depth }: { entry: Entry; dir: string; depth: number }) {
  const t = useT();
  const tree = useTree();
  const folderMenu = useFolderMenu();
  const [open, setOpen] = useState(false);
  useOpenWhenCreating(entry.path, setOpen);
  return (
    <>
      <div
        className="tree-row"
        style={{ paddingLeft: indent(depth) }}
        onClick={() => entry.is_dir && setOpen(!open)}
        onContextMenu={(e) => tree.openMenu(e, folderMenu(entry.is_dir ? entry.path : dir))}
        title={entry.link ? t("tree.link", { path: entry.path, target: entry.link }) : entry.path}
        data-git={entry.git ?? undefined}
        data-link={entry.link ?? undefined}
      >
        <span className="tree-twisty">{entry.is_dir ? (open ? "▾" : "▸") : ""}</span>
        {entry.git === "repo" && <RepoIcon title={t("tree.repo")} />}
        {entry.git === "worktree" && <WorktreeIcon title={t("tree.worktree")} />}
        <span className="tree-name">{entry.name}</span>
        {entry.link && <span className="tree-link">↗</span>}
      </div>
      {/* 펼칠 때 처음으로 읽는다. 큰 폴더(node_modules 등)를 미리 읽지 않기 위해서다. */}
      {open && <Children path={entry.path} depth={depth + 1} />}
    </>
  );
}

export const indent = (depth: number) => 8 + depth * 12;
