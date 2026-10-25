import { useCallback, useEffect, useMemo, useState } from "react";
import { AddRepoDialog } from "./AddRepoDialog";
import { SetupDialog } from "./SetupDialog";
import { ContextMenu, type MenuItem, type MenuState } from "./ContextMenu";
import { Children, TreeContext, Twisty, indent, useFolderMenu, useOpenWhenCreating, useTree } from "./FileTree";
import { ProjectIcon } from "./icons";
import { PANEL_SIZES, usePrefs, useT } from "./prefs";
import { Resizer } from "./Resizer";
import { baseName, type Project } from "./useProjects";

type Props = {
  projects: Project[];
  active: string | null;
  // 프로젝트 → 파일 트리가 보여 줄 폴더 (보고 있는 탭이 작업그룹이면 그 worktree 폴더). 없으면 프로젝트 폴더
  treeRoots: Record<string, { cwd: string; worktree: string | null }>;
  // 프로젝트 → 세션이 사용자에게 보낸 안 읽은 메시지 수 (배지)
  unread: Record<string, number>;
  // 목록 파일·작업그룹 설정 오류 등. 비어 있는 것은 건너뛴다.
  errors: (string | null)[];
  onAdd: () => void;
  onActivate: (path: string) => void;
  onRemove: (path: string) => void;
};

// 프로젝트 목록. 프로젝트를 펼치면 그 폴더의 파일 트리가 보인다.
export function Sidebar({ projects, active, treeRoots, unread, errors, onAdd, onActivate, onRemove }: Props) {
  const t = useT();
  const { panels, setPanelWidth } = usePrefs();
  const [addingTo, setAddingTo] = useState<string | null>(null);
  // 작업그룹 준비 창을 연 프로젝트
  const [settingUp, setSettingUp] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [creating, setCreating] = useState<{ dir: string; kind: "file" | "dir" } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);
  // 트리 루트가 바뀌면 (작업그룹 탭 ↔ 원본) 이전 폴더 경로로 만든 메뉴·입력란을 닫는다 (리뷰 지적 2).
  // 입력란은 탭을 바꿀 때 터미널이 포커스를 가져가 blur로 먼저 닫히지만, 메뉴는 열린 채 남았다.
  const rootsKey = JSON.stringify(treeRoots);
  useEffect(() => {
    setCreating(null);
    setRenaming(null);
    setMenu(null);
  }, [rootsKey]);
  const tree = useMemo(
    () => ({
      creating,
      startCreate: (dir: string, kind: "file" | "dir") => setCreating({ dir, kind }),
      endCreate: () => setCreating(null),
      renaming,
      startRename: (path: string) => setRenaming(path),
      endRename: () => setRenaming(null),
      openMenu: (e: React.MouseEvent, items: MenuItem[]) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY, items });
      },
    }),
    [creating, renaming],
  );

  return (
    // 숨겨도 그리기는 한다 (펼친 폴더 등 트리 상태를 잃지 않게). 보기 메뉴 "파일 트리 보이기"(⌘B, src/prefs.tsx)
    <aside className="sidebar" style={{ width: panels.sidebarWidth, display: panels.sidebar ? undefined : "none" }}>
      <Resizer edge="right" width={panels.sidebarWidth} {...PANEL_SIZES.sidebar} onWidth={(w) => setPanelWidth("sidebar", w)} onReset={() => setPanelWidth("sidebar", null)} />
      <div className="sidebar-header">
        <span>{t("sidebar.projects")}</span>
        <button className="icon-btn" title={t("sidebar.addProject")} onClick={onAdd}>
          +
        </button>
      </div>
      {errors.filter(Boolean).map((e) => (
        <div key={e} className="sidebar-error">
          {e}
        </div>
      ))}
      <TreeContext.Provider value={tree}>
        <div className="tree">
          {projects.map((p) => (
            <ProjectNode
              key={p.path}
              project={p}
              active={p.path === active}
              treeRoot={treeRoots[p.path]}
              unread={unread[p.path] ?? 0}
              onActivate={() => onActivate(p.path)}
              onRemove={() => onRemove(p.path)}
              onAddRepo={() => setAddingTo(p.path)}
              onSetup={() => setSettingUp(p.path)}
            />
          ))}
        </div>
      </TreeContext.Provider>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      {addingTo && <AddRepoDialog project={addingTo} onClose={() => setAddingTo(null)} />}
      {settingUp && <SetupDialog project={settingUp} onClose={() => setSettingUp(null)} />}
    </aside>
  );
}

type NodeProps = {
  project: Project;
  active: boolean;
  treeRoot?: { cwd: string; worktree: string | null };
  unread: number;
  onActivate: () => void;
  onRemove: () => void;
  onAddRepo: () => void;
  onSetup: () => void;
};

function ProjectNode({ project, active, treeRoot, unread, onActivate, onRemove, onAddRepo, onSetup }: NodeProps) {
  const t = useT();
  const tree = useTree();
  const folderMenu = useFolderMenu();
  const [open, setOpen] = useState(active);
  // 프로젝트로 옮겨 가면 (추가 직후 포함) 그 트리를 펼친다.
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  const { path, missing } = project;
  // 트리가 보여 줄 폴더. 작업그룹 탭을 보고 있으면 그 worktree 폴더 (새 파일도 거기에 만든다)
  const shown = treeRoot?.cwd ?? path;
  useOpenWhenCreating(shown, setOpen);

  // + 버튼: 프로젝트에 넣을 것들. 오른쪽 클릭 메뉴는 여기에 "목록에서 제거"까지.
  const addItems: MenuItem[] = [
    ...folderMenu(shown),
    "separator",
    {
      label: t("repo.addMenu"),
      action: () => {
        setOpen(true);
        onAddRepo();
      },
    },
  ];
  const removeItem: MenuItem = { label: t("sidebar.removeProject"), action: onRemove };
  // 새 작업그룹에 복제할 항목과 준비 스크립트 (SetupDialog, src-tauri/src/setup.rs)
  const setupItem: MenuItem = { label: t("sidebar.setup"), action: onSetup };

  return (
    <>
      <div
        className={`tree-row project-row${active ? " active" : ""}${missing ? " missing" : ""}`}
        style={{ paddingLeft: indent(0) }}
        data-project={path}
        title={missing ? t("sidebar.notFound", { path }) : path}
        onClick={() => !missing && onActivate()}
        onContextMenu={(e) => tree.openMenu(e, missing ? [removeItem] : [...addItems, "separator", setupItem, "separator", removeItem])}
      >
        {/* 화살표만 누르면 옮겨 가지 않고 접고 펼치기만 한다. */}
        <Twisty
          open={missing ? null : open}
          onClick={(e) => {
            e.stopPropagation();
            if (!missing) setOpen(!open);
          }}
        />
        <ProjectIcon />
        <span className="tree-name">{baseName(path)}</span>
        {unread > 0 && (
          <span className="project-unread" data-unread={unread} title={t("sidebar.unread", { n: unread })}>
            {unread}
          </span>
        )}
        {treeRoot?.worktree && (
          <span className="project-worktree" title={treeRoot.cwd}>
            {treeRoot.worktree}
          </span>
        )}
        {!missing && (
          <span className="row-action" data-action="add" title={t("sidebar.addTo")} onClick={(e) => tree.openMenu(e, addItems)}>
            +
          </span>
        )}
        <span
          className="row-action"
          data-action="remove"
          title={t("sidebar.removeProject")}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ×
        </span>
      </div>
      {/* key: 루트가 바뀌면 새로 그린다. 같은 컴포넌트를 쓰면 새 목록이 올 때까지 이전 폴더의 항목이 남아서,
          작업그룹으로 바꾼 뒤에도 그 항목으로 원본 파일을 바꿀 수 있었다 (리뷰 지적 2). */}
      {open && !missing && <Children key={shown} path={shown} depth={1} />}
    </>
  );
}
