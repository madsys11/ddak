import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Sidebar } from "./Sidebar";
import { Workspace } from "./Workspace";
import { StoreBroken, baseName, useProjects } from "./useProjects";
import { devHooks } from "./devHooks";
import { useT } from "./prefs";
import "./App.css";

function App() {
  const t = useT();
  const { projects, active, error, loadError, setError, add, remove, activate } = useProjects();
  // 목록 파일 읽기 실패는 다른 오류로 지워지지 않게 따로 계속 보여 준다.
  const shownError = loadError ? t("sidebar.loadFailed", { error: loadError }) : error;
  // 한 번이라도 연 프로젝트의 터미널은 다른 프로젝트로 옮겨 가도 살려 둔다 (숨기기만 한다).
  // 앱을 켤 때 모든 프로젝트의 터미널을 띄우지 않도록, 처음 열 때 만든다.
  const [opened, setOpened] = useState<string[]>([]);
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
          {shownError && <p className="sidebar-error">{shownError}</p>}
          <button onClick={pickProject} disabled={!!loadError}>
            {t("app.addProject")}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="layout">
      <Sidebar projects={projects} active={active} error={shownError} onAdd={pickProject} onActivate={activate} onRemove={removeProject} />
      <section className="panel">
        {opened.map((path) => (
          <div key={path} className="project-workspace" data-project={path} style={{ display: path === active ? undefined : "none" }}>
            <Workspace cwd={path} visible={path === active} />
          </div>
        ))}
        {!active && <div className="workspace-empty">{t("app.selectProject")}</div>}
      </section>
    </main>
  );
}

export default App;
