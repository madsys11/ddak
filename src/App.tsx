import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Sidebar } from "./Sidebar";
import { Workspace } from "./Workspace";
import { StoreBroken, baseName, useProjects } from "./useProjects";
import { useGroups } from "./useGroups";
import type { MessageKey } from "./i18n";
import { devHooks } from "./devHooks";
import { useT } from "./prefs";
import "./App.css";

// Rust(groups.rs)가 돌려주는 오류 코드 → 문구. "io" 등 나머지는 원문을 그대로 보인다.
const GROUP_ERRORS: Record<string, MessageKey> = {
  badJson: "groups.error.badJson",
  noGroups: "groups.error.noGroups",
  emptyId: "groups.error.emptyId",
  duplicateGroup: "groups.error.duplicateGroup",
  emptyGroup: "groups.error.emptyGroup",
  emptyName: "groups.error.emptyName",
  unknownDefault: "groups.error.unknownDefault",
};

function App() {
  const t = useT();
  const { projects, active, error, loadError, setError, add, remove, activate } = useProjects();
  // 목록 파일 읽기 실패는 다른 오류로 지워지지 않게 따로 계속 보여 준다.
  const shownError = loadError ? t("sidebar.loadFailed", { error: loadError }) : error;
  const { groups, error: groupsError } = useGroups();
  const groupsMessage =
    groupsError &&
    t("groups.invalid", {
      message: GROUP_ERRORS[groupsError.code] ? t(GROUP_ERRORS[groupsError.code], { detail: groupsError.detail }) : groupsError.detail,
    });
  if (import.meta.env.DEV) devHooks.groups = groups;
  const groupsReady = groups !== null || groupsError !== null;
  const defaultGroup = groups?.groups.find((g) => g.id === groups.default) ?? null;
  // 한 번이라도 연 프로젝트의 터미널은 다른 프로젝트로 옮겨 가도 살려 둔다 (숨기기만 한다).
  // 앱을 켤 때 모든 프로젝트의 터미널을 띄우지 않도록, 처음 열 때 만든다.
  const [opened, setOpened] = useState<string[]>([]);
  // 프로젝트마다 지금 보고 있는 탭의 폴더 (파일 트리가 보여 줄 폴더). 작업그룹 탭이면 worktree 폴더
  const [treeRoots, setTreeRoots] = useState<Record<string, { cwd: string; worktree: string | null }>>({});
  useEffect(() => {
    if (active) setOpened((o) => (o.includes(active) ? o : [...o, active]));
  }, [active]);

  async function addProject(path: string) {
    try {
      await add(path);
      setError(null);
    } catch (e) {
      if (e instanceof StoreBroken) return;
      setError(t("sidebar.addFailed", { path: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function pickProject() {
    const picked = await open({ directory: true });
    if (typeof picked === "string") await addProject(picked);
  }

  async function removeProject(path: string) {
    if (opened.includes(path)) {
      const ok = await devHooks.confirm(t("sidebar.confirmRemove", { name: baseName(path) }), {
        okLabel: t("sidebar.remove"),
        cancelLabel: t("common.cancel"),
      });
      if (!ok) return;
    }
    setOpened((o) => o.filter((p) => p !== path));
    remove(path);
  }

  if (import.meta.env.DEV) devHooks.addProject = addProject;

  if (!projects) return null;

  if (projects.length === 0) {
    return (
      <main className="empty">
        <div className="empty-box">
          <p>{t("app.noProjects")}</p>
          {[shownError, groupsMessage].filter(Boolean).map((e) => (
            <p key={e} className="sidebar-error">
              {e}
            </p>
          ))}
          <button onClick={pickProject} disabled={!!loadError}>
            {t("app.addProject")}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="layout">
      <Sidebar projects={projects} active={active} treeRoots={treeRoots} errors={[shownError, groupsMessage]} onAdd={pickProject} onActivate={activate} onRemove={removeProject} />
      <section className="panel">
        {/* 작업그룹 설정을 읽은 뒤에 연다 (처음 띄울 세션을 알아야 해서). 못 읽었으면 셸 하나로 */}
        {groupsReady &&
          opened.map((path) => (
            <div key={path} className="project-workspace" data-project={path} style={{ display: path === active ? undefined : "none" }}>
              <Workspace
                cwd={path}
                visible={path === active}
                group={defaultGroup}
                groups={groups?.groups ?? null}
                onTreeRoot={(cwd, worktree) =>
                  setTreeRoots((r) => (r[path]?.cwd === cwd && r[path]?.worktree === worktree ? r : { ...r, [path]: { cwd, worktree } }))
                }
                onError={setError}
              />
            </div>
          ))}
        {!active && <div className="workspace-empty">{t("app.selectProject")}</div>}
      </section>
    </main>
  );
}

export default App;
