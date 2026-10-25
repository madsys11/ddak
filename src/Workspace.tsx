import { useEffect, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AddSessionDialog, type PickedSession, isWriter } from "./AddSessionDialog";
import { ContextMenu, type MenuState } from "./ContextMenu";
import { EndGroupDialog } from "./EndGroupDialog";
import { devHooks } from "./devHooks";
import { codeError } from "./errors";
import { GitGraph } from "./GitGraph";
import { ChatIcon, GitIcon, SplitIcon, TerminalIcon, WorktreeIcon } from "./icons";
import { Layout, Path, measure, paneIds, remove, row, setRatio, split } from "./layout";
import { usePointerTrack } from "./pointerTrack";
import { Terminal } from "./Terminal";
import { useT } from "./prefs";
import { type Group, promptOf } from "./useGroups";
import { type PaneSession, type Setup, type State, type Tab, commandOf, fromSaved, toSaved } from "./workspaceState";

// 새로 만든 worktree 작업그룹 (src-tauri/src/worktrees.rs Created). setup: 준비 창에서 돌릴 명령 (복제 + 준비 스크립트)
type Created = { name: string; path: string; setup: string[] | null };

type Action =
  | { type: "loaded"; saved: State | null; group: Group | null; blocked: boolean }
  | { type: "newTab" }
  | { type: "newGroupTab"; group: Group | null; cwd: string; made?: Created }
  | { type: "selectTab"; id: number }
  | { type: "selectTabAt"; index: number }
  | { type: "cycleTab"; delta: number }
  | { type: "closeTab"; id: number }
  | { type: "split"; dir: "row" | "col" }
  | { type: "closePane"; pane?: number }
  | { type: "focus"; pane: number }
  | { type: "ratio"; tab: number; path: Path; ratio: number }
  | { type: "title"; pane: number; title: string }
  | { type: "renameTab"; id: number; name: string }
  | { type: "moveTab"; id: number; index: number }
  | { type: "setupExit"; tab: number; run: number; code: number | null; spawnFailed?: boolean }
  | { type: "setupRetry"; tab: number }
  | { type: "setupStart"; tab: number }
  | { type: "resumeTabs"; ids: number[] }
  | { type: "addSession"; tab: number; session: PickedSession }
  | { type: "openGit" }
  | { type: "gitRepo"; tab: number; repo: string };

// 작업그룹 탭을 하나 더한다: 그룹의 세션들을 나란히 띄운다. 그룹이 없으면 (설정을 못 읽음) 셸 하나.
// 새 worktree에 준비 스크립트가 있으면 세션 아래에 setup 창을 하나 더 두고 거기서 돌린다.
// 세션은 준비가 성공한 뒤에 뜬다 (의존성이 없는 폴더에서 CLI가 먼저 일을 시작하지 않게). 그동안 포커스는 준비 창.
function addGroupTab(s: State, group: Group | null, cwd: string, made?: Created): State {
  const id = s.nextId;
  const sessions: PaneSession[] = group?.sessions ?? [];
  const panes = sessions.length ? sessions.map((_, i) => id + 1 + i) : [id + 1];
  let layout = row(panes);
  // 창마다 세션 ID를 정한다 (인자의 {session}, 복원할 때 같은 대화를 이어 가게). 프롬프트({prompt})도 지금 정해 저장한다.
  const added: [number, PaneSession][] = sessions.map((x, i) => [panes[i], { ...x, sid: crypto.randomUUID(), prompt: promptOf(group!, x) }]);
  let nextId = id + 1 + panes.length;
  let setup: Setup | undefined;
  if (made?.setup) {
    const setupPane = nextId++;
    layout = withSetupPane(layout, setupPane);
    const [command, ...args] = made.setup;
    const session: PaneSession = { name: "setup", command, args, resume: null, readOnly: false, shiftEnter: null, setup: true };
    added.push([setupPane, session]);
    setup = { pane: setupPane, run: 0, status: "running", code: null, started: false, session };
  }
  const tab: Tab = { id, layout, focus: setup?.pane ?? panes[0], cwd, group: group?.name, worktree: made?.name, setup };
  return { ...s, tabs: [...s.tabs, tab], active: id, sessions: { ...s.sessions, ...Object.fromEntries(added) }, nextId };
}

// 준비 창은 탭 아래쪽에 둔다
const withSetupPane = (layout: Layout, pane: number): Layout => ({ dir: "col", ratio: 0.7, a: layout, b: { pane } });

// 프로젝트마다 상태 파일 읽기·치우기·저장을 한 줄로 세운다 (모듈 전역: Workspace 인스턴스와 상관없이). Workspace가
// 사라졌다 다시 생겨도 (StrictMode, 프로젝트를 뺐다 다시 넣음) 이전 인스턴스의 남은 저장이 끝난 뒤에 읽고, 읽은 뒤의
// 저장이 이전 인스턴스의 늦은 저장에 덮이지 않는다 (리뷰 P2: 컴포넌트마다 있던 줄이 언마운트 뒤에도 이어져 덮었다).
const fileQueues = new Map<string, Promise<unknown>>();
function inOrder<T>(project: string, task: () => Promise<T>): Promise<T> {
  const run = (fileQueues.get(project) ?? Promise.resolve()).then(task);
  fileQueues.set(project, run.catch(() => {}));
  return run;
}

// 저장한 상태를 읽기 전. 읽으면 그것으로, 없으면 첫 탭 = 원본 폴더에서 작업하는 작업그룹 (기본 그룹).
const initial = (root: string): State => ({ root, tabs: [], active: 0, titles: {}, sessions: {}, nextId: 1, loaded: false });

function closeTab(s: State, id: number): State {
  const i = s.tabs.findIndex((t) => t.id === id);
  const tabs = s.tabs.filter((t) => t.id !== id);
  // 닫은 탭이 활성 탭이면 그 오른쪽, 없으면 왼쪽 탭으로
  const active = s.active === id ? (tabs[i] ?? tabs[i - 1])?.id ?? 0 : s.active;
  return { ...s, tabs, active };
}

// 구분선 끌기처럼 잦은 변화는 모았다가 저장하고, 나머지(탭·분할·이름 등)는 바로 저장한다 (종료 직전 변화를 덜 잃게)
function reducer(s: State, a: Action): State {
  const next = step(s, a);
  return next === s ? s : { ...next, slowSave: a.type === "ratio" };
}

function step(s: State, a: Action): State {
  const tab = s.tabs.find((t) => t.id === s.active);
  const update = (id: number, f: (t: Tab) => Tab) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? f(t) : t)) });

  // 저장한 상태를 읽기 전에 온 동작(단축키 등)은 무시한다 (읽은 상태로 바뀌며 사라진다)
  if (!s.loaded && a.type !== "loaded") return s;
  switch (a.type) {
    case "loaded": {
      if (s.loaded) return s;
      const opened = a.saved ?? addGroupTab({ ...s, loaded: true }, a.group, s.root);
      return { ...opened, saveBlocked: a.blocked };
    }
    // Git Graph 탭: 프로젝트마다 하나. 있으면 그 탭으로. 터미널은 없고 layout은 자리용 창 하나 (닫기·순서·저장을 그대로 쓴다)
    case "openGit": {
      const open = s.tabs.find((t) => t.git);
      if (open) return { ...s, active: open.id };
      const pane = s.nextId + 1;
      return { ...s, tabs: [...s.tabs, { id: s.nextId, layout: { pane }, focus: pane, cwd: s.root, git: {} }], active: s.nextId, nextId: s.nextId + 2 };
    }
    case "gitRepo":
      return update(a.tab, (t) => ({ ...t, git: { ...t.git, repo: a.repo } }));
    case "newTab": {
      // 셸 탭은 원본 프로젝트 폴더에서 연다
      const pane = s.nextId + 1;
      return { ...s, tabs: [...s.tabs, { id: s.nextId, layout: { pane }, focus: pane, cwd: s.root }], active: s.nextId, nextId: s.nextId + 2 };
    }
    case "newGroupTab":
      return addGroupTab(s, a.group, a.cwd, a.made);
    case "selectTab":
      return { ...s, active: a.id };
    case "selectTabAt":
      return s.tabs[a.index] ? { ...s, active: s.tabs[a.index].id } : s;
    case "cycleTab": {
      if (s.tabs.length === 0) return s;
      const i = s.tabs.findIndex((t) => t.id === s.active);
      return { ...s, active: s.tabs[(i + a.delta + s.tabs.length) % s.tabs.length].id };
    }
    case "closeTab":
      return closeTab(s, a.id);
    case "split": {
      if (!tab || tab.git) return s;
      const pane = s.nextId;
      return { ...update(tab.id, (t) => ({ ...t, layout: split(t.layout, t.focus, a.dir, pane), focus: pane })), nextId: s.nextId + 1 };
    }
    case "closePane": {
      const pane = a.pane ?? tab?.focus;
      const owner = s.tabs.find((t) => paneIds(t.layout).includes(pane!));
      if (!owner) return s;
      const layout = remove(owner.layout, pane!);
      if (!layout) return closeTab(s, owner.id);
      const focus = owner.focus === pane ? paneIds(layout)[0] : owner.focus;
      // 돌던 준비 창을 닫으면 준비가 중단된 것으로 본다 (세션은 계속 기다리고, 다시 준비 / 그래도 시작을 고른다)
      let setup = owner.setup;
      if (setup && setup.pane === pane) {
        setup = setup.status === "running" ? { ...setup, pane: null, status: "failed", code: null } : { ...setup, pane: null };
      }
      return update(owner.id, (t) => ({ ...t, layout, focus, setup }));
    }
    // 세션 추가: 그 탭의 포커스된 창 오른쪽에 새 창을 두고 그 세션을 띄운다 (창마다 새 세션 ID)
    case "addSession": {
      const owner = s.tabs.find((t) => t.id === a.tab);
      if (!owner || owner.git) return s;
      const pane = s.nextId;
      return {
        ...update(owner.id, (t) => ({ ...t, layout: split(t.layout, t.focus, "row", pane), focus: pane })),
        active: owner.id,
        sessions: { ...s.sessions, [pane]: { ...a.session, sid: crypto.randomUUID() } },
        nextId: s.nextId + 1,
      };
    }
    // 작업그룹을 끝내다가 멈춰 그 탭들의 세션을 다시 띄운다: 이어서 하기(resume)로. 준비를 기다리던 세션은 뜬 적이 없다.
    case "resumeTabs": {
      const sessions = { ...s.sessions };
      for (const tab of s.tabs.filter((t) => a.ids.includes(t.id) && (!t.setup || t.setup.started))) {
        for (const p of paneIds(tab.layout)) if (sessions[p] && !sessions[p].setup) sessions[p] = { ...sessions[p], resumed: true };
      }
      return { ...s, sessions };
    }
    case "focus": {
      const owner = s.tabs.find((t) => paneIds(t.layout).includes(a.pane));
      return owner && owner.focus !== a.pane ? update(owner.id, (t) => ({ ...t, focus: a.pane })) : s;
    }
    case "ratio":
      return update(a.tab, (t) => ({ ...t, layout: setRatio(t.layout, a.path, a.ratio) }));
    case "title":
      return s.titles[a.pane] === a.title ? s : { ...s, titles: { ...s.titles, [a.pane]: a.title } };
    case "renameTab": {
      // 비우면 원래 제목으로 돌아간다
      const name = a.name.trim() || undefined;
      return update(a.id, (t) => ({ ...t, name }));
    }
    case "setupExit": {
      const owner = s.tabs.find((t) => t.id === a.tab);
      const setup = owner?.setup;
      if (!owner || !setup || setup.run !== a.run || setup.status !== "running") return s;
      const ok = a.code === 0;
      // 성공하면 세션을 띄우고 포커스를 첫 세션으로 옮긴다 (준비 창에 있었으면)
      const first = paneIds(owner.layout).find((p) => !s.sessions[p]?.setup) ?? owner.focus;
      const focus = ok && owner.focus === setup.pane ? first : owner.focus;
      return update(owner.id, (t) => ({
        ...t,
        focus,
        setup: { ...setup, status: ok ? "ok" : "failed", code: ok ? null : a.code, spawnFailed: a.spawnFailed, started: setup.started || ok },
      }));
    }
    case "setupRetry": {
      const owner = s.tabs.find((t) => t.id === a.tab);
      const setup = owner?.setup;
      if (!owner || !setup || setup.status === "running") return s;
      const run = { ...setup, run: setup.run + 1, status: "running" as const, code: null, spawnFailed: undefined };
      if (setup.pane !== null) return update(owner.id, (t) => ({ ...t, focus: setup.pane!, setup: run }));
      // 준비 창을 닫았으면 다시 연다
      const pane = s.nextId;
      return {
        ...update(owner.id, (t) => ({ ...t, layout: withSetupPane(t.layout, pane), focus: pane, setup: { ...run, pane } })),
        sessions: { ...s.sessions, [pane]: setup.session },
        nextId: s.nextId + 1,
      };
    }
    case "setupStart":
      return update(a.tab, (t) => (t.setup ? { ...t, setup: { ...t.setup, started: true } } : t));
    case "moveTab": {
      const from = s.tabs.findIndex((t) => t.id === a.id);
      if (from < 0 || from === a.index) return s;
      const tabs = s.tabs.filter((t) => t.id !== a.id);
      tabs.splice(a.index, 0, s.tabs[from]);
      return { ...s, tabs };
    }
  }
}

const MENU: Record<string, Action> = {
  new_tab: { type: "newTab" },
  split_right: { type: "split", dir: "row" },
  split_down: { type: "split", dir: "col" },
  close_pane: { type: "closePane" },
};

const pct = (v: number) => `${v * 100}%`;

// 탭 영역(box) 안에서 탭(el)이 다 보이는지, 활성 탭이 보이게 스크롤하기.
// scrollIntoView는 넘친 내용을 숨긴 바깥 요소까지 스크롤할 수 있어 탭 영역만 직접 옮긴다.
// 탭 너비는 글자 폭 때문에 소수 픽셀이라 실제 위치(getBoundingClientRect)로 재고 모자란 쪽으로 올림한다.
// offsetLeft·offsetWidth는 반올림된 정수라 1px 안쪽이 가려진 채 남았다 (자체 테스트 간헐 실패).
const tabShown = (box: HTMLElement, el: HTMLElement) => {
  const [r, b] = [el.getBoundingClientRect(), box.getBoundingClientRect()];
  return r.left >= b.left - 0.5 && r.right <= b.right + 0.5;
};
function revealActiveTab(box: HTMLElement) {
  const el = box.querySelector<HTMLElement>(".tab.active");
  if (!el) return;
  const [r, b] = [el.getBoundingClientRect(), box.getBoundingClientRect()];
  if (r.left < b.left) box.scrollLeft += Math.floor(r.left - b.left);
  else if (r.right > b.right) box.scrollLeft += Math.ceil(r.right - b.right);
}

type Props = {
  cwd: string;
  visible: boolean;
  // 기본 작업그룹. 처음 열 때와 새 작업그룹을 만들 때 쓴다. 이미 뜬 세션은 설정이 바뀌어도 그대로 둔다.
  group: Group | null;
  // 작업그룹 설정 전체 (세션 추가에서 고른다). 못 읽었으면 null.
  groups: Group[] | null;
  // 보고 있는 탭의 폴더가 바뀌면 알린다 (파일 트리가 그 폴더를 보여 준다). worktree: 작업그룹 이름 또는 null(원본)
  onTreeRoot: (cwd: string, worktree: string | null) => void;
  onError: (message: string) => void;
  // 채팅 패널 (src/ChatPanel.tsx, App이 둔다): 열렸는지, 닫혀 있는 동안 나에게 온 메시지가 있는지, 여닫기
  chatOpen: boolean;
  chatUnread: boolean;
  onToggleChat: () => void;
};

// 프로젝트마다 Workspace가 하나씩 떠 있다. 보이는(visible) 것만 단축키를 받는다.
export function Workspace({ cwd, visible, group, groups, onTreeRoot, onError, chatOpen, chatUnread, onToggleChat }: Props) {
  const t = useT();
  const setupProblem = (setup: Setup) =>
    setup.spawnFailed ? t("setup.spawnFailed") : setup.code === null ? t("setup.stopped") : t("setup.failed", { code: setup.code });
  const [s, dispatch] = useReducer(reducer, cwd, initial);
  const latest = useRef({ group, onError, onTreeRoot, t, loaded: s.loaded });
  latest.current = { group, onError, onTreeRoot, t, loaded: s.loaded };
  const creating = useRef(false);
  const bodies = useRef<Record<number, HTMLDivElement | null>>({});
  const root = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // 끝내기 창을 연 작업그룹 탭
  const [ending, setEnding] = useState<Tab | null>(null);
  // 세션 추가 창을 연 탭
  const [adding, setAdding] = useState<number | null>(null);
  // 채팅 깨우기를 기다리는 창 → 바로 깨우기 (src-tauri/src/pty.rs wake)
  const [waking, setWaking] = useState<Record<number, () => void>>({});
  const activeRef = useRef(s.active);
  activeRef.current = s.tabs.some((tab) => tab.id === s.active) ? s.active : -1;
  // 탭마다 터미널을 다시 띄운 횟수. 터미널 key에 넣어서, 늘면 그 탭의 터미널을 새로 띄운다.
  const [runs, setRuns] = useState<Record<number, number>>({});
  // 작업그룹을 끝내느라 세션을 끝내는(끝낸) 터미널 ("탭:횟수"). 그 터미널은 끝나도 창을 닫지 않는다.
  const stopping = useRef(new Set<string>());
  // 그 폴더(작업그룹 폴더)에서 띄운 탭. group_end가 그 폴더의 터미널을 모두 끝낸다.
  const tabsIn = (dir: string) => s.tabs.filter((t) => t.cwd === dir || t.cwd.startsWith(`${dir}/`)).map((t) => t.id);
  const runKey = (tab: number) => `${tab}:${runs[tab] ?? 0}`;
  const tabsRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const titleOf = (tab: Tab, i: number) =>
    tab.name ?? (tab.git ? t("git.title") : undefined) ?? tab.worktree ?? tab.group ?? (s.titles[tab.focus] || t("workspace.tabTitle", { n: i + 1 }));

  // 터미널 번호는 Workspace마다 따로 매기므로 자기 영역 안에서만 찾는다.
  const focusPane = (pane: number) =>
    root.current?.querySelector<HTMLElement>(`.pane[data-pane="${pane}"] .xterm-helper-textarea`)?.focus();

  // 새 작업그룹: 저장소마다 worktree를 만들고 (src-tauri/src/worktrees.rs) 그 폴더에서 기본 그룹을 띄운다.
  // git이 몇 초 걸릴 수 있어 끝나면 탭을 연다. 만드는 중에 또 누르면 무시한다.
  async function createGroup() {
    // 저장한 상태를 읽기 전에는 만들지 않는다: 만들어도 그 결과를 읽은 상태가 덮어 탭이 생기지 않는다 (리뷰 P2)
    if (creating.current || !latest.current.loaded) return;
    creating.current = true;
    const { group, onError, t } = latest.current;
    try {
      const made = await invoke<Created>("group_create", { project: cwd, prefix: group?.id ?? "shell" });
      dispatch({ type: "newGroupTab", group, cwd: made.path, made });
    } catch (raw) {
      const { code, detail } = codeError(raw);
      onError(t("group.createFailed", { detail: code === "noRepos" ? t("group.noRepos") : detail }));
    } finally {
      creating.current = false;
    }
  }
  const createGroupRef = useRef(createGroup);
  createGroupRef.current = createGroup;

  // 마지막 상태 (src-tauri/src/workspace.rs). 없으면 처음처럼 기본 작업그룹으로 연다. 모양이 틀리면 옆으로 치운 뒤
  // 기본으로 연다. 읽지 못하면 (또는 치우지 못하면) 기본으로 열되 저장하지 않는다: 그 상태를 덮어쓰지 않게 (리뷰 P1).
  // 정리된 Workspace(alive가 아님)는 읽지도, 파일을 치우지도, 알리지도 않는다 (리뷰 P2: 취소된 읽기가 늦게 와서 새로
  // 저장한 파일까지 치웠다).
  useEffect(() => {
    let alive = true;
    const load = (import.meta.env.DEV && devHooks.workspaceLoad) || ((project: string) => invoke<string | null>("workspace_load", { project }));
    inOrder(cwd, async () => {
      if (!alive) return null;
      try {
        const text = await load(cwd);
        if (!alive) return null;
        const saved = text ? fromSaved(text, cwd) : null;
        if (text && !saved) await invoke("workspace_set_aside", { project: cwd });
        return { saved, blocked: false };
      } catch (e) {
        if (!alive) return null;
        latest.current.onError(latest.current.t("workspace.loadFailed", { detail: codeError(e).detail }));
        return { saved: null, blocked: true };
      }
    }).then((r) => r && alive && dispatch({ type: "loaded", saved: r.saved, blocked: r.blocked, group: latest.current.group }));
    return () => {
      alive = false;
    };
  }, [cwd]);

  // 바뀌면 저장한다 (터미널 제목은 저장하지 않으므로 보지 않는다). 프로젝트의 줄(inOrder)에서 앞 저장이 끝난 뒤에
  // 보낸다: 요청은 따로 가서 도착 순서가 보장되지 않아, 늦게 도착한 이전 상태가 새 상태를 덮을 수 있었다 (리뷰 P2).
  useEffect(() => {
    if (!s.loaded || s.saveBlocked) return;
    const state = toSaved(s);
    const save = () => {
      const delay = import.meta.env.DEV ? (devHooks.workspaceSaveDelay?.() ?? 0) : 0;
      inOrder(cwd, async () => {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        await invoke("workspace_save", { project: cwd, state });
      }).catch((e) => latest.current.onError(String(codeError(e).detail)));
    };
    if (!s.slowSave) return save();
    const timer = setTimeout(save, 300);
    return () => clearTimeout(timer);
  }, [s.loaded, s.saveBlocked, s.tabs, s.active, s.sessions]);

  // 단축키 대부분은 네이티브 메뉴(src-tauri/src/menu.rs)가 받아서 "menu" 이벤트로 보낸다.
  useEffect(() => {
    const unlisten = listen<string>("menu", (e) => {
      if (!visibleRef.current) return;
      if (e.payload === "new_group") createGroupRef.current();
      else if (e.payload === "add_session") activeRef.current >= 0 && setAdding(activeRef.current);
      else if (e.payload === "git_graph") dispatch({ type: "openGit" });
      else if (MENU[e.payload]) dispatch(MENU[e.payload]);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // 채팅 패널을 닫으면 (× 또는 버튼) 선택된 터미널로 포커스를 돌린다. 터미널의 focused 값은 그대로라 터미널이 스스로
  // 돌아오지 않는다 (리뷰 P2: 숨은 채팅 입력란에 남았다).
  const chatWasOpen = useRef(chatOpen);
  useEffect(() => {
    const tab = s.tabs.find((x) => x.id === s.active);
    if (chatWasOpen.current && !chatOpen && visibleRef.current && tab) focusPane(tab.focus);
    chatWasOpen.current = chatOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpen]);

  // 보고 있는 탭의 폴더를 알린다 (탭이 없으면 원본)
  const activeTab = s.tabs.find((tab) => tab.id === s.active);
  const treeCwd = activeTab?.cwd ?? cwd;
  const treeWorktree = activeTab?.worktree ?? null;
  useEffect(() => {
    latest.current.onTreeRoot(treeCwd, treeWorktree);
  }, [treeCwd, treeWorktree]);

  // 활성 탭을 탭 영역에서 보이게 스크롤한다 (새 탭, ⌘1~9 등으로 바뀔 때).
  // 탭 너비는 나중에도 바뀐다 (셸이 보내는 터미널 제목, 탭 추가·닫기). 그때도 다시 맞추되, 사용자가 휠로 넘겨 활성 탭이
  // 화면 밖에 있으면 그대로 둔다 (claude는 일하는 동안 제목을 계속 바꿔서 되돌아오면 넘겨 볼 수 없다).
  // follow: 따라가는 중인지. 활성 탭이 바뀔 때만 다시 켠다. 탭 수가 바뀔 때 관찰 대상만 다시 잡고 이 값은 그대로
  // 둔다 (리뷰 지적 6: 다른 탭을 닫으면 넘겨 둔 자리가 되돌아왔다).
  const follow = useRef(true);
  useEffect(() => {
    follow.current = true;
    if (tabsRef.current) revealActiveTab(tabsRef.current);
  }, [s.active]);
  useEffect(() => {
    const box = tabsRef.current;
    if (!box) return;
    // 휠로 생긴 스크롤일 때만 판단한다. 여기서 맞춘 스크롤의 scroll 이벤트는 다음 화면 갱신에 오는데,
    // 그 사이 제목이 와서 탭이 넓어지면 활성 탭이 밖에 있는 것으로 보여 따라가기를 멈췄다 (자체 테스트에서 재현).
    let wheeled = false;
    const onWheel = () => (wheeled = true);
    const onScroll = () => {
      const el = box.querySelector<HTMLElement>(".tab.active");
      if (wheeled && el) follow.current = tabShown(box, el);
      wheeled = false;
    };
    const resized = new ResizeObserver(() => follow.current && revealActiveTab(box));
    resized.observe(box);
    for (const tab of box.querySelectorAll(".tab")) resized.observe(tab);
    box.addEventListener("wheel", onWheel);
    box.addEventListener("scroll", onScroll);
    return () => {
      resized.disconnect();
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("scroll", onScroll);
    };
  }, [s.tabs.length]);

  // 메뉴에 넣기 애매한 탭 이동 단축키. 터미널보다 먼저 받도록 capture 단계에서 처리한다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!visibleRef.current || !e.metaKey || e.altKey || e.ctrlKey) return;
      let action: Action | undefined;
      if (!e.shiftKey && e.key >= "1" && e.key <= "9") {
        action = e.key === "9" ? { type: "selectTabAt", index: s.tabs.length - 1 } : { type: "selectTabAt", index: Number(e.key) - 1 };
      } else if (e.shiftKey && e.code === "BracketLeft") action = { type: "cycleTab", delta: -1 };
      else if (e.shiftKey && e.code === "BracketRight") action = { type: "cycleTab", delta: 1 };
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      dispatch(action);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [s.tabs.length]);

  // 끌기(탭·구분선)의 시작·끝 정리 (src/pointerTrack.ts)
  const trackPointer = usePointerTrack();

  // 탭을 끌어서 순서 바꾸기. 4px 넘게 움직여야 끌기로 본다 (그냥 누르기·더블클릭과 구분).
  // 끄는 동안 포인터가 지나간 자리로 바로 옮기고, 탭 영역 끝에 가면 그쪽으로 스크롤한다.
  function startTabDrag(e: React.PointerEvent, id: number) {
    if (e.button !== 0 || (e.target as Element).closest(".tab-close, .tab-input")) return;
    const box = tabsRef.current!;
    const startX = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent, end: () => void) => {
      if (!box.querySelector(`.tab[data-tab="${id}"]`)) return end(); // 끄는 중에 탭이 닫힘
      if (!moved) {
        if (Math.abs(ev.clientX - startX) < 4) return;
        moved = true;
        setDragging(id);
      }
      const b = box.getBoundingClientRect();
      if (ev.clientX < b.left + 24) box.scrollLeft -= 12;
      else if (ev.clientX > b.right - 24) box.scrollLeft += 12;
      // 끄는 탭을 뺀 나머지 중 가운데가 포인터 왼쪽에 있는 탭 수 = 새 자리
      const others = [...box.querySelectorAll<HTMLElement>(".tab")].filter((el) => el.dataset.tab !== String(id));
      const index = others.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2 < ev.clientX;
      }).length;
      dispatch({ type: "moveTab", id, index });
    };
    trackPointer(move, () => setDragging(null));
  }

  function startDrag(e: React.PointerEvent, tab: number, d: ReturnType<typeof measure>["dividers"][number]) {
    e.preventDefault();
    const body = bodies.current[tab]!.getBoundingClientRect();
    trackPointer((ev) => {
      const ratio =
        d.dir === "row"
          ? (ev.clientX - body.left - d.parent.x * body.width) / (d.parent.w * body.width)
          : (ev.clientY - body.top - d.parent.y * body.height) / (d.parent.h * body.height);
      dispatch({ type: "ratio", tab, path: d.path, ratio: Math.min(0.9, Math.max(0.1, ratio)) });
    });
  }

  return (
    <div className="workspace" ref={root}>
      {/* 탭 바를 눌러도 터미널이 포커스를 잃지 않게 한다. Terminal의 포커스 효과는
          focused 값이 바뀔 때만 돌아서, 활성 탭을 다시 누르거나 다른 탭의 ×를 누르면 복원되지 않는다.
          탭 이름 입력란은 예외 (눌러서 커서를 옮길 수 있게). */}
      <div className="tabbar" onMouseDownCapture={(e) => !(e.target instanceof HTMLInputElement) && e.preventDefault()}>
        {/* 탭이 많으면 탭 영역만 가로로 스크롤한다. 버튼은 늘 보이게 둔다. 스크롤바는 숨기고 휠로 넘긴다. */}
        <div
          className="tabs"
          ref={tabsRef}
          onWheel={(e) => {
            // 마우스 휠(세로)을 가로 스크롤로. 트랙패드의 가로 움직임은 그대로 스크롤된다.
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
          }}
        >
          {s.tabs.map((tab, i) => (
            <div
              key={tab.id}
              data-tab={tab.id}
              className={`tab${tab.id === s.active ? " active" : ""}${tab.id === dragging ? " dragging" : ""}`}
              onPointerDown={(e) => startTabDrag(e, tab.id)}
              onMouseDown={() => {
                // 활성 탭을 누르면 다른 곳(파일 트리 등)에 있던 포커스를 터미널로 가져온다.
                if (tab.id === s.active) focusPane(tab.focus);
                else dispatch({ type: "selectTab", id: tab.id });
              }}
              onDoubleClick={() => setRenaming(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                const items = [{ label: t("workspace.renameTab"), action: () => setRenaming(tab.id) }];
                if (!tab.git) items.push({ label: t("addSession.menu"), action: () => setAdding(tab.id) });
                // 새 worktree로 만든 작업그룹이면 끝내기 (원본 그룹·셸 탭은 지울 것이 없다)
                if (tab.worktree) items.push({ label: t("endGroup.menu"), action: () => setEnding(tab) });
                setMenu({ x: e.clientX, y: e.clientY, items });
              }}
            >
              {tab.worktree && <WorktreeIcon title={tab.cwd} />}
              {tab.git && <GitIcon />}
              {tab.setup?.status === "failed" && (
                <span className="tab-warn" title={setupProblem(tab.setup)}>
                  !
                </span>
              )}
              {renaming === tab.id ? (
                <TabNameInput
                  initial={titleOf(tab, i)}
                  onDone={(name, refocus) => {
                    if (name !== null) dispatch({ type: "renameTab", id: tab.id, name });
                    setRenaming(null);
                    if (refocus) focusPane(tab.focus);
                  }}
                />
              ) : (
                <span className="tab-title" title={tab.cwd}>
                  {titleOf(tab, i)}
                </span>
              )}
              <span
                className="tab-close"
                title={t("workspace.closeTab")}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => dispatch({ type: "closeTab", id: tab.id })}
              >
                ×
              </span>
            </div>
          ))}
        </div>
        <button className="tabbar-btn" title={t("workspace.newTab")} onClick={() => dispatch({ type: "newTab" })}>
          <TerminalIcon />
        </button>
        <button className="tabbar-btn" data-action="new-group" title={t("workspace.newGroup")} onClick={() => createGroup()}>
          <WorktreeIcon />
        </button>
        <div className="tabbar-spacer" />
        <button className="tabbar-btn" disabled={!activeTab || !!activeTab.git} title={t("workspace.splitRight")} onClick={() => dispatch({ type: "split", dir: "row" })}>
          <SplitIcon dir="row" />
        </button>
        <button className="tabbar-btn" disabled={!activeTab || !!activeTab.git} title={t("workspace.splitDown")} onClick={() => dispatch({ type: "split", dir: "col" })}>
          <SplitIcon dir="col" />
        </button>
        {/* 만드는 버튼(터미널, 작업그룹)은 왼쪽, 프로젝트를 보는 버튼(Git Graph, 채팅)은 오른쪽 끝에 나란히.
            Git Graph는 탭을 열고 채팅은 오른쪽 패널을 여닫아서 둘 사이를 구분선으로 나눈다 */}
        <button className="tabbar-btn" data-action="git" title={t("git.open")} onClick={() => dispatch({ type: "openGit" })}>
          <GitIcon />
        </button>
        <div className="tabbar-sep" />
        <button
          className={`tabbar-btn${chatOpen ? " active" : ""}${chatUnread && !chatOpen ? " unread" : ""}`}
          data-action="chat"
          title={chatUnread && !chatOpen ? t("chat.unread") : t("chat.toggle")}
          onClick={onToggleChat}
        >
          <ChatIcon />
        </button>
      </div>
      {/* 탭이 하나도 없으면: 탭 바는 그대로 두고, 열 수 있는 것을 모두 보여 준다 */}
      {s.loaded && s.tabs.length === 0 && (
        <div className="workspace-empty">
          <div className="workspace-empty-actions">
            {group && (
              <button data-action="origin-group" onClick={() => dispatch({ type: "newGroupTab", group, cwd: s.root })}>
                {t("workspace.openGroup", { name: group.name })}
              </button>
            )}
            <button className="secondary" onClick={() => createGroup()}>
              {t("workspace.newGroup")}
            </button>
            <button className="secondary" onClick={() => dispatch({ type: "newTab" })}>
              {t("workspace.newTerminal")}
            </button>
          </div>
        </div>
      )}
      {/* 분할이나 탭 전환 때 터미널이 다시 만들어지면 셸이 죽는다.
          그래서 탭 안의 터미널은 모두 형제로 두고 위치만 바꾼다. */}
      {s.tabs.map((tab) => {
        const { panes, dividers } = measure(tab.layout);
        const active = tab.id === s.active;
        if (tab.git) {
          // 작업그룹 표시: 터미널 탭마다 폴더, 이름, 세션 이름 (그 폴더의 worktree가 있는 커밋에 붙인다)
          const places = s.tabs
            .filter((x) => !x.git)
            .map((x) => ({
              cwd: x.cwd,
              label: titleOf(x, s.tabs.indexOf(x)),
              sessions: paneIds(x.layout).flatMap((p) => (s.sessions[p] && !s.sessions[p].setup ? [s.sessions[p].name] : [])),
            }));
          return (
            <div key={tab.id} className="tab-body" style={{ display: active ? undefined : "none" }}>
              <GitGraph project={s.root} repo={tab.git.repo} visible={visible && active} places={places} onRepo={(repo) => dispatch({ type: "gitRepo", tab: tab.id, repo })} />
            </div>
          );
        }
        return (
          <div
            key={tab.id}
            ref={(el) => {
              bodies.current[tab.id] = el;
            }}
            className="tab-body"
            style={{ display: active ? undefined : "none" }}
          >
            {panes.map(({ id, rect }) => {
              const session = s.sessions[id];
              const setup = tab.setup;
              // 준비를 기다리는 세션 창: 터미널 대신 안내 (터미널을 만들면 CLI가 바로 뜬다)
              const waiting = session && !session.setup && setup && !setup.started;
              return (
              <div
                key={id}
                className={`pane${panes.length > 1 && tab.focus === id ? " focused" : ""}${s.sessions[id] ? " session" : ""}`}
                data-pane={id}
                style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
                onMouseDown={(e) => {
                  // 터미널 둘레의 여백을 눌러도 그 터미널로 포커스
                  if ((e.target as Element).closest(".xterm")) return;
                  e.preventDefault();
                  focusPane(id);
                }}
              >
                {/* 작업그룹 세션이면 역할 이름. 같은 탭에 CLI가 여럿이라 어느 창이 누구인지 보이게 */}
                {session && (
                  <div className="pane-label">
                    {session.setup ? t("session.setup") : session.name}
                    {session.readOnly && <span className="pane-badge">{t("session.readOnly")}</span>}
                    {waking[id] && (
                      <button className="pane-badge wake" data-wake title={t("chat.wakeHint")} onClick={waking[id]}>
                        {t("chat.wakePending")}
                      </button>
                    )}
                    {session.setup && setup && (
                      <span className={`pane-badge${setup.status === "failed" ? " error" : ""}`} data-setup-status={setup.status}>
                        {setup.status === "running" ? t("setup.running") : setup.status === "ok" ? t("setup.done") : setupProblem(setup)}
                      </span>
                    )}
                  </div>
                )}
                {waiting ? (
                  <div className="setup-wait">
                    {setup.status === "failed" ? (
                      <>
                        <div className="setup-wait-error">{setupProblem(setup)}</div>
                        <div className="setup-wait-actions">
                          <button data-action="setup-retry" onClick={() => dispatch({ type: "setupRetry", tab: tab.id })}>
                            {t("setup.retry")}
                          </button>
                          <button className="secondary" data-action="setup-start" onClick={() => dispatch({ type: "setupStart", tab: tab.id })}>
                            {t("setup.startAnyway")}
                          </button>
                        </div>
                      </>
                    ) : (
                      <div>{t("setup.waiting")}</div>
                    )}
                  </div>
                ) : (
                  <Terminal
                    // 다시 준비하면 새 터미널에서 다시 돌린다
                    key={session?.setup ? `setup-${setup?.run}` : `term-${runs[tab.id] ?? 0}`}
                    cwd={tab.cwd}
                    {...commandOf(session)}
                    shiftEnter={session?.shiftEnter}
                    shellAfter={session?.setup ? false : undefined}
                    onWake={(pending, wakeNow) =>
                      setWaking((w) => {
                        if (!pending) {
                          const { [id]: _, ...rest } = w;
                          return rest;
                        }
                        return { ...w, [id]: wakeNow };
                      })
                    }
                    // 작업그룹 세션(명령이 있는 것)은 채팅방에 "작업그룹/역할"로 참여한다 (원본 작업그룹은 origin)
                    chat={session?.command && !session.setup ? { project: s.root, name: `${tab.worktree ?? "origin"}/${session.name}`, key: session.sid ?? String(id) } : undefined}
                    focused={visible && active && tab.focus === id}
                    onFocus={() => dispatch({ type: "focus", pane: id })}
                    onTitle={(title) => dispatch({ type: "title", pane: id, title })}
                    // 준비 창은 끝나도 출력을 볼 수 있게 남긴다 (닫기는 ⌘W)
                    onExit={(code) =>
                      session?.setup && setup
                        ? dispatch({ type: "setupExit", tab: tab.id, run: setup.run, code })
                        : !stopping.current.has(runKey(tab.id)) && dispatch({ type: "closePane", pane: id })
                    }
                    // 준비 창을 띄우지 못하면 준비 실패로 (세션이 계속 기다리지 않게)
                    onSpawnError={
                      session?.setup && setup ? () => dispatch({ type: "setupExit", tab: tab.id, run: setup.run, code: null, spawnFailed: true }) : undefined
                    }
                  />
                )}
              </div>
              );
            })}
            {dividers.map((d) => {
              const pos = d.dir === "row" ? d.parent.x + d.parent.w * d.ratio : d.parent.y + d.parent.h * d.ratio;
              const style =
                d.dir === "row"
                  ? { left: pct(pos), top: pct(d.parent.y), height: pct(d.parent.h) }
                  : { top: pct(pos), left: pct(d.parent.x), width: pct(d.parent.w) };
              return (
                <div
                  key={d.path.join("")}
                  className={`divider ${d.dir}`}
                  style={style}
                  onPointerDown={(e) => startDrag(e, tab.id, d)}
                  onMouseDown={(e) => e.preventDefault()}
                />
              );
            })}
          </div>
        );
      })}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {adding !== null && s.tabs.some((tab) => tab.id === adding) && (
        <AddSessionDialog
          groups={groups}
          writers={paneIds(s.tabs.find((tab) => tab.id === adding)!.layout).flatMap((p) => (s.sessions[p] && isWriter(s.sessions[p]) ? [s.sessions[p].name] : []))}
          onAdd={(session) => dispatch({ type: "addSession", tab: adding, session })}
          onNewGroup={() => createGroupRef.current()}
          onClose={() => setAdding(null)}
        />
      )}
      {ending?.worktree && (
        <EndGroupDialog
          project={s.root}
          group={ending.cwd}
          name={ending.worktree}
          onClose={() => setEnding(null)}
          onStopping={() => tabsIn(ending.cwd).forEach((id) => stopping.current.add(runKey(id)))}
          onFailed={(stopped) => {
            const ids = tabsIn(ending.cwd);
            if (!stopped) return ids.forEach((id) => stopping.current.delete(runKey(id)));
            // 세션을 끝낸 뒤라 다시 띄운다 (끝낸 터미널의 늦은 종료는 이전 key의 것이라 창을 닫지 않는다)
            dispatch({ type: "resumeTabs", ids });
            setRuns((r) => ({ ...r, ...Object.fromEntries(ids.map((id) => [id, (r[id] ?? 0) + 1])) }));
          }}
          // 끝났으면 그 폴더의 탭을 닫는다 (세션은 이미 끝났다)
          onEnded={() => tabsIn(ending.cwd).forEach((id) => dispatch({ type: "closeTab", id }))}
        />
      )}
    </div>
  );
}

// 탭 이름 입력란. Enter나 다른 곳을 누르면 확정, Esc는 취소 (onDone(null)).
// 파일 트리의 이름 입력란과 달리 다른 곳을 눌러도 확정한다: 디스크를 바꾸지 않아 실수해도 다시 바꾸면 된다.
// refocus: 키보드로 끝냈으면 터미널로 포커스를 돌려준다 (다른 곳을 눌렀으면 그곳에 둔다).
function TabNameInput({ initial, onDone }: { initial: string; onDone: (name: string | null, refocus: boolean) => void }) {
  const [name, setName] = useState(initial);
  const done = useRef(false);
  const finish = (value: string | null, refocus: boolean) => {
    if (done.current) return; // Enter·Esc 뒤 입력란이 사라지며 blur가 한 번 더 온다
    done.current = true;
    onDone(value, refocus);
  };
  return (
    <input
      className="tab-input"
      autoFocus
      spellCheck={false}
      value={name}
      size={Math.max(8, name.length)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        // 한글 조합을 확정하는 Enter는 확정이 아니다. WebKit은 조합 중 키에 keyCode 229를 준다.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") finish(name, true);
        else if (e.key === "Escape") finish(null, true);
      }}
      onBlur={() => finish(name, false)}
      onMouseDown={(e) => e.stopPropagation()} // 탭을 누른 것으로 치지 않게 (터미널로 포커스 이동)
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}
