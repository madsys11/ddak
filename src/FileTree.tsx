import { createContext, useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MenuItem } from "./ContextMenu";
import { devHooks } from "./devHooks";
import { isDocPath, requestOpenDoc } from "./docs";
import { setDraggedPath } from "./dragPath";
import { codeError } from "./errors";
import { refreshGitStatus, useGitStatus, useGitSummary, type GitCode } from "./gitStatus";
import { ChevronIcon, RepoIcon, WorktreeIcon } from "./icons";
import type { MessageKey } from "./i18n";
import { useT } from "./prefs";
import { openLink } from "./terminalLinks";
import { watchDir } from "./watchDir";

type Entry = { name: string; path: string; is_dir: boolean; git: "repo" | "worktree" | null; link: string | null };
type Kind = "file" | "dir";

// 트리 전체가 함께 쓰는 상태: 새 항목 입력란이 열린 폴더, 이름을 바꾸는 항목, 오른쪽 클릭 메뉴 (Sidebar가 제공)
type Tree = {
  creating: { dir: string; kind: Kind } | null;
  startCreate: (dir: string, kind: Kind) => void;
  endCreate: () => void;
  renaming: string | null;
  startRename: (path: string) => void;
  endRename: () => void;
  openMenu: (e: React.MouseEvent, items: MenuItem[]) => void;
};
export const TreeContext = createContext<Tree | null>(null);
export const useTree = () => useContext(TreeContext)!;
// 이 트리가 든 프로젝트 (문서 탭을 그 프로젝트에서 연다, Sidebar가 프로젝트마다 둔다)
export const ProjectContext = createContext("");

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

// 펼쳐져 있는 동안 폴더를 감시하고 바뀌면 다시 읽는다.
function useEntries(path: string) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      invoke<Entry[]>("list_dir", { path }).then(
        (e) => alive && (setEntries(e), setError(null)),
        (e) => alive && setError(String(e)),
      );
    load();
    const unwatch = watchDir(path, () => {
      load();
      refreshGitStatus(path);
    });
    return () => {
      alive = false;
      unwatch();
    };
  }, [path]);
  return { entries, error };
}

// 폴더 하나의 내용. 프로젝트 목록(Sidebar)이 프로젝트 아래에 이것을 놓는다. root: 트리 루트 (끌어 놓을 때 상대 경로의 기준).
export function Children({ path, depth, root = path }: { path: string; depth: number; root?: string }) {
  const { entries, error } = useEntries(path);
  const gitStatus = useGitStatus(path);
  const { creating } = useTree();
  if (error) return <div className="tree-error" style={{ paddingLeft: indent(depth) }}>{error}</div>;
  if (!entries) return null;
  return (
    <>
      {creating?.dir === path && <NewEntry dir={path} kind={creating.kind} depth={depth} />}
      {entries.map((e) => (
        // 안에 든 저장소·worktree는 자기 저장소의 표시를 보이므로 (Node) 바깥 저장소의 "추적 안 함"을 붙이지 않는다
        <Node key={e.path} entry={e} dir={path} depth={depth} root={root} git={e.git ? undefined : gitStatus(e.name)} />
      ))}
    </>
  );
}

// 트리 안의 이름 입력란 (새 파일·폴더, 이름 바꾸기). Enter로 확정, Esc나 다른 곳을 누르면 취소.
// 확정이 실패하면 입력란을 그대로 두고 오류를 보여 준다. 변경된 목록은 폴더 감시로 들어온다.
function useNameInput(initial: string, save: (name: string) => Promise<unknown>, close: () => void) {
  const t = useT();
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) return close();
    try {
      await save(name);
      close();
    } catch (raw) {
      const { code, detail } = codeError(raw);
      setError(code === "exists" ? t("tree.error.exists", { name: detail }) : code === "badName" ? t("tree.error.badName") : detail);
    }
  }

  const inputProps = {
    className: `tree-input${error ? " invalid" : ""}`,
    autoFocus: true,
    spellCheck: false,
    value: name,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      setName(e.target.value);
      setError(null);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      // 한글 조합을 확정하는 Enter는 확정이 아니다. WebKit은 조합 중 키에 keyCode 229를 준다.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") close();
    },
    onBlur: close,
    onClick: (e: React.MouseEvent) => e.stopPropagation(), // 행을 누른 것으로 치지 않게 (폴더 접고 펴기)
  };
  return { inputProps, error };
}

const nameError = (error: string | null, depth: number) =>
  error && (
    <div className="tree-error" style={{ paddingLeft: indent(depth) + 14 }}>
      {error}
    </div>
  );

function NewEntry({ dir, kind, depth }: { dir: string; kind: Kind; depth: number }) {
  const t = useT();
  const { endCreate } = useTree();
  const { inputProps, error } = useNameInput("", (name) => invoke("fs_create", { dir, name, kind }), endCreate);
  return (
    <>
      <div className="tree-row tree-input-row" style={{ paddingLeft: indent(depth) }}>
        <Twisty open={kind === "dir" ? false : null} />
        <input {...inputProps} data-kind={kind} placeholder={t(kind === "dir" ? "tree.newFolder" : "tree.newFile")} />
      </div>
      {nameError(error, depth)}
    </>
  );
}

// 이름 바꾸기 입력란 (행 안의 이름 자리). 파일은 확장자 앞까지만 선택해 둔다 (VS Code와 같음).
// 오류는 입력란 바로 아래에 띄운다.
function RenameInput({ entry }: { entry: Entry }) {
  const { endRename } = useTree();
  const ref = useRef<HTMLInputElement>(null);
  const { inputProps, error } = useNameInput(entry.name, (name) => invoke("fs_rename", { path: entry.path, name }), endRename);
  // 처음 열 때 한 번만 선택한다. entry는 목록을 다시 읽을 때마다 새 객체라서 의존성으로 두면
  // 입력하던 중에 선택이 초기화된다 (리뷰 지적 6).
  useEffect(() => {
    const dot = entry.is_dir ? -1 : entry.name.lastIndexOf(".");
    ref.current?.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }, []);
  return (
    <span className="tree-input-wrap">
      <input {...inputProps} ref={ref} data-rename={entry.path} />
      {error && <span className="tree-input-error">{error}</span>}
    </span>
  );
}

// git 표시의 색 묶음 (App.css .git-*)과 설명 문구
const GIT_KIND: Record<GitCode, string> = { M: "modified", R: "modified", D: "modified", A: "added", U: "added", "!": "conflict" };
const GIT_TITLE: Record<GitCode, MessageKey> = {
  M: "tree.git.modified",
  A: "tree.git.added",
  U: "tree.git.untracked",
  D: "tree.git.deleted",
  R: "tree.git.renamed",
  "!": "tree.git.conflict",
};

function Node({ entry, dir, depth, root, git: outer }: { entry: Entry; dir: string; depth: number; root: string; git?: GitCode }) {
  const t = useT();
  // 저장소·worktree 행은 자기 저장소 전체에 바뀐 것이 있으면 폴더처럼 점
  const own = useGitSummary(entry.git && entry.is_dir ? entry.path : null);
  const git = outer ?? own;
  const tree = useTree();
  const folderMenu = useFolderMenu();
  const project = useContext(ProjectContext);
  const [open, setOpen] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  // 마크다운 파일은 앱 안 문서 탭으로 (더블클릭·메뉴), 파일은 기본 앱으로도 열 수 있다
  const doc = !entry.is_dir && isDocPath(entry.path);
  const openDoc = () => requestOpenDoc({ path: entry.path, project });
  const fileItems: MenuItem[] = entry.is_dir ? [] : [...(doc ? [{ label: t("doc.open"), action: openDoc }] : []), { label: t("doc.openDefault"), action: () => openLink(entry.path) }, "separator"];
  useOpenWhenCreating(entry.path, setOpen);
  // 휴지통으로 (확인을 받고. 되살릴 수 있다). 목록은 폴더 감시로 바뀐다.
  async function trash() {
    const ok = await devHooks.confirm(t("tree.trashConfirm", { name: entry.name }), { okLabel: t("tree.trash"), cancelLabel: t("common.cancel") });
    if (!ok) return;
    invoke("fs_trash", { path: entry.path }).then(
      () => setTrashError(null),
      (e) => setTrashError(t("tree.trashFailed", { detail: codeError(e).detail })),
    );
  }
  return (
    <>
      <div
        className="tree-row"
        style={{ paddingLeft: indent(depth) }}
        onClick={() => entry.is_dir && setOpen(!open)}
        onDoubleClick={() => doc && openDoc()}
        // 터미널이나 채팅 입력란에 끌어다 놓으면 경로가 들어간다 (Terminal.tsx, ChatPanel.tsx)
        draggable={tree.renaming !== entry.path}
        onDragStart={(e) => setDraggedPath(e.dataTransfer, entry.path, root)}
        onContextMenu={(e) =>
          tree.openMenu(e, [
            ...fileItems,
            ...folderMenu(entry.is_dir ? entry.path : dir),
            "separator",
            { label: t("tree.rename"), action: () => tree.startRename(entry.path) },
            { label: t("tree.trash"), action: trash },
          ])
        }
        title={entry.link ? t("tree.link", { path: entry.path, target: entry.link }) : entry.path}
        data-git={entry.git ?? undefined}
        data-git-status={git}
        data-link={entry.link ?? undefined}
      >
        <Twisty open={entry.is_dir ? open : null} />
        {entry.git === "repo" && <RepoIcon title={t("tree.repo")} />}
        {entry.git === "worktree" && <WorktreeIcon title={t("tree.worktree")} />}
        {tree.renaming === entry.path ? <RenameInput entry={entry} /> : <span className={`tree-name${git ? ` git-${GIT_KIND[git]}` : ""}`}>{entry.name}</span>}
        {entry.link && <span className="tree-link">↗</span>}
        {/* VS Code처럼 파일은 글자, 폴더는 안에 바뀐 것이 있다는 점 */}
        {git && (
          <span className={`tree-git git-${GIT_KIND[git]}`} title={entry.is_dir && git !== "U" ? t("tree.git.folder") : t(GIT_TITLE[git])}>
            {entry.is_dir ? "•" : git}
          </span>
        )}
      </div>
      {nameError(trashError, depth)}
      {/* 펼칠 때 처음으로 읽는다. 큰 폴더(node_modules 등)를 미리 읽지 않기 위해서다. */}
      {open && <Children path={entry.path} depth={depth + 1} root={root} />}
    </>
  );
}

export const indent = (depth: number) => 8 + depth * 12;

// 펼치기/접기 화살표. open이 null이면 (파일) 자리만 차지한다. 같은 요소의 클래스만 바뀌어서 회전이 애니메이션된다.
export function Twisty({ open, onClick }: { open: boolean | null; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <span className={`tree-twisty${open ? " open" : ""}`} data-open={open ?? undefined} onClick={onClick}>
      {open !== null && <ChevronIcon />}
    </span>
  );
}
