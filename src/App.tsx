import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { ChatPanel } from "./ChatPanel";
import { MobileDialog } from "./MobileDialog";
import { LimitsDialog } from "./LimitsDialog";
import { currentLimits, loadLimits } from "./limits";
import { Sidebar } from "./Sidebar";
import { Workspace } from "./Workspace";
import { StoreBroken, baseName, normalize, useProjects } from "./useProjects";
import { groupChoices, useGroups } from "./useGroups";
import { GroupPickDialog } from "./GroupPickDialog";
import type { MessageKey } from "./i18n";
import { devHooks } from "./devHooks";
import { onOpenDoc } from "./docs";
import { projectForClick } from "./notifyClick";
import { useT } from "./prefs";
import { EMPTY_PROJECT_STATUS, type ProjectStatus, sameStatus, topState } from "./projectStatus";
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
  // Workspace가 띄운 오류와 그것을 띄운 호출 (작업그룹 만들기가 성공하면 자기가 띄운 오류만 지운다. 문구만 보면 다른 프로젝트가
  // 띄운 같은 문구의 오류까지 지웠다: 리뷰 R1). 그 뒤 다른 곳이 띄운 오류는 문구가 달라서 지우지 않는다
  const workspaceError = useRef<{ id: object; message: string } | null>(null);
  const showError = (message: string) => {
    const id = {};
    workspaceError.current = { id, message };
    setError(message);
    return id;
  };
  const clearError = (id: object) => {
    const shown = workspaceError.current;
    if (shown?.id !== id) return;
    workspaceError.current = null;
    setError((e) => (e === shown.message ? null : e));
  };
  const { groups, error: groupsError } = useGroups();
  const groupsMessage =
    groupsError &&
    t("groups.invalid", {
      message: GROUP_ERRORS[groupsError.code] ? t(GROUP_ERRORS[groupsError.code], { detail: groupsError.detail }) : groupsError.detail,
    });
  if (import.meta.env.DEV) devHooks.groups = groups;
  // 협업 제한(재리뷰 횟수)도 읽은 뒤에 Workspace를 연다: 처음 만드는 세션의 규약에 기본 횟수가 들어가지 않게 (src/limits.ts)
  const [limitsReady, setLimitsReady] = useState(false);
  useEffect(() => {
    loadLimits().then(() => setLimitsReady(true));
  }, []);
  const groupsReady = (groups !== null || groupsError !== null) && limitsReady;
  if (import.meta.env.DEV && groupsReady && devHooks.limitsAtFirstWorkspace === undefined) devHooks.limitsAtFirstWorkspace = currentLimits().reReviews;
  const defaultGroup = groups?.groups.find((g) => g.id === groups.default) ?? null;
  const choices = groupChoices(defaultGroup, groups?.groups ?? null);
  // 프로젝트를 추가할 때 고른 작업그룹 id (그 Workspace의 첫 탭, 저장된 상태가 없을 때만). 저장하지 않는다: 다음부터는 저장된
  // 탭을 복원한다. 지우면 함께 지워서 다시 추가할 때 이전 선택을 쓰지 않는다
  const [firstGroups, setFirstGroups] = useState<Record<string, string>>({});
  // 폴더를 골랐고 작업그룹을 고르는 중인 경로 (설정을 다 읽은 뒤에 창을 띄운다)
  const [picking, setPicking] = useState<string | null>(null);
  // 한 번이라도 연 프로젝트의 터미널은 다른 프로젝트로 옮겨 가도 살려 둔다 (숨기기만 한다).
  // 앱을 켤 때 모든 프로젝트의 터미널을 띄우지 않도록, 처음 열 때 만든다.
  const [opened, setOpened] = useState<string[]>([]);
  // 프로젝트마다 지금 보고 있는 탭의 폴더 (파일 트리가 보여 줄 폴더). 작업그룹 탭이면 worktree 폴더
  const [treeRoots, setTreeRoots] = useState<Record<string, { cwd: string; worktree: string | null }>>({});
  // 프로젝트 → 채팅 패널을 열었는지, 닫혀 있는 동안 나에게 온 메시지가 있는지
  const [chatOpen, setChatOpen] = useState<Record<string, boolean>>({});
  // 프로젝트 → 채팅 패널을 닫아 둔 동안 세션이 사용자에게 보낸 메시지 수 (사이드바 배지, Dock 배지)
  const [chatUnread, setChatUnread] = useState<Record<string, number>>({});
  // 프로젝트 → 세션 창들의 상태 수 (Workspace onSummary)와 자동 깨우기가 멈춘 작업그룹 수 (ChatPanel onPaused).
  // 사이드바 프로젝트 줄의 점·칩 (src/projectStatus.ts). 열린 프로젝트 것만 보인다 (지운 뒤 다시 넣으면 새로 알린다)
  const [summaries, setSummaries] = useState<Record<string, ProjectStatus>>({});
  const [pausedGroups, setPausedGroups] = useState<Record<string, number>>({});
  const projectStatus: Record<string, ProjectStatus> = {};
  for (const p of opened) {
    const s = { ...(summaries[p] ?? EMPTY_PROJECT_STATUS), paused: pausedGroups[p] ?? 0 };
    if (topState(s)) projectStatus[p] = s;
  }
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
  // 연 프로젝트를 Rust에 알린다: 폰 목록이 맥에서 열렸는지 보인다 (src-tauri/src/mobile.rs)
  useEffect(() => {
    invoke("set_opened", { projects: opened }).catch(() => {});
  }, [opened]);
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

  // 폰의 "맥에서 열기" (mobile.rs): 보고 있는 프로젝트는 그대로 두고 그 프로젝트를 연다. 세션은 처음 열 때처럼 이어서 하기로 복원된다
  useEffect(() => {
    const unlisten = listen<string>("mobile-open", ({ payload }) => {
      if ((projectsRef.current ?? []).some((p) => p.path === payload)) setOpened((o) => (o.includes(payload) ? o : [...o, payload]));
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // 문서 탭 열기 (src/docs.ts requestOpenDoc): 그 프로젝트로 가서 (없으면 보고 있는 프로젝트) 그 Workspace가 연다
  const [docRequest, setDocRequest] = useState<{ project: string; path: string; anchor?: string; n: number } | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(
    () =>
      onOpenDoc(({ path, project, anchor }) => {
        const target = project || activeRef.current;
        if (!target) return;
        activate(target);
        setDocRequest((r) => ({ project: target, path, anchor, n: (r?.n ?? 0) + 1 }));
      }),
    [activate],
  );

  // 앱 메뉴 "모바일 연결…" (src-tauri/src/menu.rs)
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    const unlisten = listen<string>("menu", ({ payload }) => payload === "mobile" && setMobileOpen(true));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);
  // 앱 메뉴 "협업 제한…" (src-tauri/src/menu.rs, src/LimitsDialog.tsx)
  const [limitsOpen, setLimitsOpen] = useState(false);
  useEffect(() => {
    const unlisten = listen<string>("menu", ({ payload }) => payload === "limits" && setLimitsOpen(true));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);
  const mobileDialog = (
    <>
      {mobileOpen && <MobileDialog onClose={() => setMobileOpen(false)} />}
      {limitsOpen && <LimitsDialog groups={groups?.groups ?? null} onClose={() => setLimitsOpen(false)} />}
      {picking && groupsReady && choices.length > 1 && (
        <GroupPickDialog
          name={baseName(picking)}
          groups={choices}
          onPick={(g) => {
            setPicking(null);
            addProject(picking, true, g.id);
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );

  // group: 첫 탭으로 열 작업그룹 id. 없으면 기본 그룹. 이미 있는 프로젝트면 옮겨 가기만 하고 고른 그룹은 건드리지 않는다
  // (그 Workspace가 아직 상태를 읽는 중이면 앞서 고른 그룹이 지워져 기본 그룹으로 열렸다, 리뷰 R11)
  async function addProject(path: string, activate = true, group?: string) {
    const key = normalize(path);
    const isNew = !(projectsRef.current ?? []).some((p) => p.path === key);
    // Workspace가 뜨기 전에 정해 둔다 (첫 탭을 정하는 것은 그 Workspace가 상태를 읽은 뒤)
    if (isNew) setFirstGroups(({ [key]: _, ...rest }) => (group ? { ...rest, [key]: group } : rest));
    try {
      await add(path, activate);
      setError(null);
    } catch (e) {
      if (isNew) setFirstGroups(({ [key]: _, ...rest }) => rest);
      if (e instanceof StoreBroken) return;
      setError(t("sidebar.addFailed", { path: e instanceof Error ? e.message : String(e) }));
    }
  }

  // 새 프로젝트도 여기서: 폴더 선택 창의 "새 폴더" 버튼으로 만든다. 플러그인(desktop.rs)·rfd 폴더 선택의 기본값도 켜짐이지만
  // 이 창이 그 버튼에 기대므로 밝혀 둔다
  async function pickProject() {
    const picked = await (import.meta.env.DEV && devHooks.pickFolder ? devHooks.pickFolder() : open({ directory: true, canCreateDirectories: true }));
    if (typeof picked !== "string") return;
    // 이미 있는 프로젝트면 그리로 옮겨 가기만 한다 (그룹을 고르게 하면 고른 그룹이 적용되는 것처럼 보인다)
    if (projectsRef.current?.some((p) => p.path === normalize(picked))) return addProject(picked);
    setPicking(picked);
  }
  // 고를 작업그룹이 하나 이하면 (설정을 못 읽은 경우 포함) 묻지 않고 기본으로 추가한다
  useEffect(() => {
    if (!picking || !groupsReady || choices.length > 1) return;
    setPicking(null);
    addProject(picking);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking, groupsReady, choices.length]);

  async function removeProject(path: string) {
    if (opened.includes(path)) {
      const ok = await devHooks.confirm(t("sidebar.confirmRemove", { name: baseName(path) }), {
        okLabel: t("sidebar.remove"),
        cancelLabel: t("common.cancel"),
      });
      if (!ok) return;
    }
    setOpened((o) => o.filter((p) => p !== path));
    setPausedGroups(({ [path]: _, ...rest }) => rest);
    setFirstGroups(({ [path]: _, ...rest }) => rest);
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
      <Sidebar projects={projects} active={active} treeRoots={treeRoots} unread={chatUnread} status={projectStatus} errors={[shownError, groupsMessage]} onAdd={pickProject} onActivate={activate} onRemove={removeProject} />
      <section className="panel">
        {/* 작업그룹 설정을 읽은 뒤에 연다 (처음 띄울 세션을 알아야 해서). 못 읽었으면 셸 하나로 */}
        {groupsReady &&
          opened.map((path) => (
            <div key={path} className="project-workspace" data-project={path} style={{ display: path === active ? undefined : "none" }}>
              <Workspace
                cwd={path}
                visible={path === active}
                group={defaultGroup}
                firstGroup={groups?.groups.find((g) => g.id === firstGroups[path]) ?? null}
                groups={groups?.groups ?? null}
                shiftEnterFor={groups?.shiftEnterFor ?? {}}
                onTreeRoot={(cwd, worktree) =>
                  setTreeRoots((r) => (r[path]?.cwd === cwd && r[path]?.worktree === worktree ? r : { ...r, [path]: { cwd, worktree } }))
                }
                onError={showError}
                onClearError={clearError}
                chatOpen={!!chatOpen[path]}
                chatUnread={!!chatUnread[path]}
                onToggleChat={() => setChatOpen((o) => ({ ...o, [path]: !o[path] }))}
                docRequest={docRequest?.project === path ? docRequest : null}
                onSummary={(sum) =>
                  setSummaries((all) => {
                    if (sum) return sameStatus(all[path], sum) ? all : { ...all, [path]: sum };
                    const { [path]: _, ...rest } = all;
                    return rest;
                  })
                }
              />
              <ChatPanel
                project={path}
                open={!!chatOpen[path]}
                watching={!!chatOpen[path] && path === active && windowFocused}
                onClose={() => setChatOpen((o) => ({ ...o, [path]: false }))}
                onUnread={(u) => setChatUnread((r) => ((r[path] ?? 0) === u ? r : { ...r, [path]: u }))}
                onPaused={(n) => setPausedGroups((r) => ((r[path] ?? 0) === n ? r : { ...r, [path]: n }))}
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
