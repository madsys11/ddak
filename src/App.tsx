import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { ChatPanel } from "./ChatPanel";
import { MobileDialog } from "./MobileDialog";
import { Sidebar } from "./Sidebar";
import { Workspace } from "./Workspace";
import { StoreBroken, baseName, useProjects } from "./useProjects";
import { useGroups } from "./useGroups";
import type { MessageKey } from "./i18n";
import { devHooks } from "./devHooks";
import { projectForClick } from "./notifyClick";
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
  // 프로젝트 → 채팅 패널을 열었는지, 닫혀 있는 동안 나에게 온 메시지가 있는지
  const [chatOpen, setChatOpen] = useState<Record<string, boolean>>({});
  // 프로젝트 → 채팅 패널을 닫아 둔 동안 세션이 사용자에게 보낸 메시지 수 (사이드바 배지, Dock 배지)
  const [chatUnread, setChatUnread] = useState<Record<string, number>>({});
  const unreadTotal = Object.entries(chatUnread).reduce((n, [p, c]) => n + (opened.includes(p) ? c : 0), 0);
  useEffect(() => {
    invoke("set_badge", { count: unreadTotal }).catch(() => {});
  }, [unreadTotal]);
  // 알림을 보낼지 정하려고 보고 있는 프로젝트와 그 채팅 패널이 열렸는지 Rust에 알린다 (src-tauri/src/notify.rs)
  const viewingChat = !!active && !!chatOpen[active];
  // 창이 앞에 있는지 (채팅을 실제로 보고 있을 때만 읽은 것으로 친다, ChatPanel watching)
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setWindowFocused(true);
    const off = () => setWindowFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  useEffect(() => {
    invoke("set_view", { active: active ?? null, chatOpen: viewingChat }).catch(() => {});
  }, [active, viewingChat]);
  useEffect(() => {
    if (active) setOpened((o) => (o.includes(active) ? o : [...o, active]));
  }, [active]);
  // 알림을 누름 (src-tauri/src/notify.rs): 그 프로젝트로 간다. 터미널이 낸 알림이면 그 창은 Terminal이 보이고 (onReveal),
  // 아니면 (세션이 사용자에게 보낸 메시지 등) 채팅 패널을 연다
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  useEffect(() => {
    const unlisten = listen<{ project: string; pty: number | null }>("notification-click", async ({ payload }) => {
      const paths = (projectsRef.current ?? []).map((p) => p.path);
      const project = await projectForClick(paths, payload.project, (path) => invoke<string>("real_path", { path }));
      if (!project) return;
      activate(project);
      if (payload.pty === null) setChatOpen((o) => ({ ...o, [project]: true }));
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [activate]);

  // 앱 메뉴 "모바일 연결…" (src-tauri/src/menu.rs)
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    const unlisten = listen<string>("menu", ({ payload }) => payload === "mobile" && setMobileOpen(true));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);
  const mobileDialog = mobileOpen && <MobileDialog onClose={() => setMobileOpen(false)} />;

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
        {mobileDialog}
      </main>
    );
  }

  return (
    <main className="layout">
      <Sidebar projects={projects} active={active} treeRoots={treeRoots} unread={chatUnread} errors={[shownError, groupsMessage]} onAdd={pickProject} onActivate={activate} onRemove={removeProject} />
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
                shiftEnterFor={groups?.shiftEnterFor ?? {}}
                onTreeRoot={(cwd, worktree) =>
                  setTreeRoots((r) => (r[path]?.cwd === cwd && r[path]?.worktree === worktree ? r : { ...r, [path]: { cwd, worktree } }))
                }
                onError={setError}
                chatOpen={!!chatOpen[path]}
                chatUnread={!!chatUnread[path]}
                onToggleChat={() => setChatOpen((o) => ({ ...o, [path]: !o[path] }))}
              />
              <ChatPanel
                project={path}
                open={!!chatOpen[path]}
                watching={!!chatOpen[path] && path === active && windowFocused}
                onClose={() => setChatOpen((o) => ({ ...o, [path]: false }))}
                onUnread={(u) => setChatUnread((r) => ((r[path] ?? 0) === u ? r : { ...r, [path]: u }))}
              />
            </div>
          ))}
        {!active && <div className="workspace-empty">{t("app.selectProject")}</div>}
      </section>
      {mobileDialog}
    </main>
  );
}

export default App;
