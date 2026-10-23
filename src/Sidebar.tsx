import { useCallback, useEffect, useMemo, useState } from "react";
import { AddRepoDialog } from "./AddRepoDialog";
import { ContextMenu, type MenuItem, type MenuState } from "./ContextMenu";
import { Children, TreeContext, indent, useFolderMenu, useOpenWhenCreating, useTree } from "./FileTree";
import { ProjectIcon } from "./icons";
import { useT } from "./prefs";
import { baseName, type Project } from "./useProjects";

type Props = {
  projects: Project[];
  active: string | null;
  // 목록 파일·작업그룹 설정 오류 등. 비어 있는 것은 건너뛴다.
  errors: (string | null)[];
  onAdd: () => void;
  onActivate: (path: string) => void;
  onRemove: (path: string) => void;
};

// 프로젝트 목록. 프로젝트를 펼치면 그 폴더의 파일 트리가 보인다.
export function Sidebar({ projects, active, errors, onAdd, onActivate, onRemove }: Props) {
  const t = useT();
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [creating, setCreating] = useState<{ dir: string; kind: "file" | "dir" } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);
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
    <aside className="sidebar">
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
              onActivate={() => onActivate(p.path)}
              onRemove={() => onRemove(p.path)}
              onAddRepo={() => setAddingTo(p.path)}
            />
          ))}
        </div>
      </TreeContext.Provider>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      {addingTo && <AddRepoDialog project={addingTo} onClose={() => setAddingTo(null)} />}
    </aside>
  );
}

type NodeProps = { project: Project; active: boolean; onActivate: () => void; onRemove: () => void; onAddRepo: () => void };

function ProjectNode({ project, active, onActivate, onRemove, onAddRepo }: NodeProps) {
  const t = useT();
  const tree = useTree();
  const folderMenu = useFolderMenu();
  const [open, setOpen] = useState(active);
  // 프로젝트로 옮겨 가면 (추가 직후 포함) 그 트리를 펼친다.
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  const { path, missing } = project;
  useOpenWhenCreating(path, setOpen);

  // + 버튼: 프로젝트에 넣을 것들. 오른쪽 클릭 메뉴는 여기에 "목록에서 제거"까지.
  const addItems: MenuItem[] = [
    ...folderMenu(path),
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

  return (
    <>
      <div
        className={`tree-row project-row${active ? " active" : ""}${missing ? " missing" : ""}`}
        style={{ paddingLeft: indent(0) }}
        data-project={path}
        title={missing ? t("sidebar.notFound", { path }) : path}
        onClick={() => !missing && onActivate()}
        onContextMenu={(e) => tree.openMenu(e, missing ? [removeItem] : [...addItems, "separator", removeItem])}
      >
        {/* 화살표만 누르면 옮겨 가지 않고 접고 펼치기만 한다. */}
        <span
          className="tree-twisty"
          onClick={(e) => {
            e.stopPropagation();
            if (!missing) setOpen(!open);
          }}
        >
          {missing ? "" : open ? "▾" : "▸"}
        </span>
        <ProjectIcon />
        <span className="tree-name">{baseName(path)}</span>
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
      {open && !missing && <Children path={path} depth={1} />}
    </>
  );
}
