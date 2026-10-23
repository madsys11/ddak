import { useEffect, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ContextMenu, type MenuState } from "./ContextMenu";
import { codeError } from "./errors";
import { SplitIcon, TerminalIcon, WorktreeIcon } from "./icons";
import { Layout, Path, measure, paneIds, remove, row, setRatio, split } from "./layout";
import { Terminal } from "./Terminal";
import { useT } from "./prefs";
import type { Group, Session } from "./useGroups";

// cwd: 이 탭의 터미널들이 뜨는 폴더 (원본 프로젝트 폴더 또는 작업그룹의 worktree 폴더).
// group: 작업그룹으로 연 탭이면 그 그룹 이름. worktree: 새 worktree로 만든 작업그룹이면 그 이름 (탭 제목).
// 둘 다 없으면 터미널 제목을 쓴다. name: 사용자가 바꾼 탭 이름 (탭 제목만 바뀌고 worktree·브랜치 이름은 그대로).
type Tab = { id: number; layout: Layout; focus: number; cwd: string; group?: string; worktree?: string; name?: string };
// root: 프로젝트 폴더. sessions: 작업그룹 세션으로 띄운 터미널 → 그 세션. 없으면 그냥 셸.
type State = { root: string; tabs: Tab[]; active: number; titles: Record<number, string>; sessions: Record<number, Session>; nextId: number };

type Action =
  | { type: "newTab" }
  | { type: "newGroupTab"; group: Group | null; cwd: string; worktree?: string }
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
  | { type: "moveTab"; id: number; index: number };

// 작업그룹 탭을 하나 더한다: 그룹의 세션들을 나란히 띄운다. 그룹이 없으면 (설정을 못 읽음) 셸 하나.
function addGroupTab(s: State, group: Group | null, cwd: string, worktree?: string): State {
  const id = s.nextId;
  const sessions = group?.sessions ?? [];
  const panes = sessions.length ? sessions.map((_, i) => id + 1 + i) : [id + 1];
  const tab: Tab = { id, layout: row(panes), focus: panes[0], cwd, group: group?.name, worktree };
  return {
    ...s,
    tabs: [...s.tabs, tab],
    active: id,
    sessions: { ...s.sessions, ...Object.fromEntries(sessions.map((x, i) => [panes[i], x])) },
    nextId: id + 1 + panes.length,
  };
}

// 첫 탭 = 원본 폴더에서 작업하는 작업그룹 (기본 그룹).
function initial({ group, root }: { group: Group | null; root: string }): State {
  return addGroupTab({ root, tabs: [], active: 0, titles: {}, sessions: {}, nextId: 1 }, group, root);
}

const commandOf = (s: Session | undefined) => (s?.command ? [s.command, ...s.args] : undefined);

function closeTab(s: State, id: number): State {
  const i = s.tabs.findIndex((t) => t.id === id);
  const tabs = s.tabs.filter((t) => t.id !== id);
  // 닫은 탭이 활성 탭이면 그 오른쪽, 없으면 왼쪽 탭으로
  const active = s.active === id ? (tabs[i] ?? tabs[i - 1])?.id ?? 0 : s.active;
  return { ...s, tabs, active };
}

function reducer(s: State, a: Action): State {
  const tab = s.tabs.find((t) => t.id === s.active);
  const update = (id: number, f: (t: Tab) => Tab) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? f(t) : t)) });

  switch (a.type) {
    case "newTab": {
      // 셸 탭은 원본 프로젝트 폴더에서 연다
      const pane = s.nextId + 1;
      return { ...s, tabs: [...s.tabs, { id: s.nextId, layout: { pane }, focus: pane, cwd: s.root }], active: s.nextId, nextId: s.nextId + 2 };
    }
    case "newGroupTab":
      return addGroupTab(s, a.group, a.cwd, a.worktree);
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
      if (!tab) return s;
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
      return update(owner.id, (t) => ({ ...t, layout, focus }));
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
const tabShown = (box: HTMLElement, el: HTMLElement) =>
  el.offsetLeft >= box.scrollLeft && el.offsetLeft + el.offsetWidth <= box.scrollLeft + box.clientWidth;
function revealActiveTab(box: HTMLElement) {
  const el = box.querySelector<HTMLElement>(".tab.active");
  if (!el) return;
  if (el.offsetLeft < box.scrollLeft) box.scrollLeft = el.offsetLeft;
  else if (!tabShown(box, el)) box.scrollLeft = el.offsetLeft + el.offsetWidth - box.clientWidth;
}

type Props = {
  cwd: string;
  visible: boolean;
  // 기본 작업그룹. 처음 열 때와 새 작업그룹을 만들 때 쓴다. 이미 뜬 세션은 설정이 바뀌어도 그대로 둔다.
  group: Group | null;
  // 보고 있는 탭의 폴더가 바뀌면 알린다 (파일 트리가 그 폴더를 보여 준다). worktree: 작업그룹 이름 또는 null(원본)
  onTreeRoot: (cwd: string, worktree: string | null) => void;
  onError: (message: string) => void;
};

// 프로젝트마다 Workspace가 하나씩 떠 있다. 보이는(visible) 것만 단축키를 받는다.
export function Workspace({ cwd, visible, group, onTreeRoot, onError }: Props) {
  const t = useT();
  const [s, dispatch] = useReducer(reducer, { group, root: cwd }, initial);
  const latest = useRef({ group, onError, onTreeRoot, t });
  latest.current = { group, onError, onTreeRoot, t };
  const creating = useRef(false);
  const bodies = useRef<Record<number, HTMLDivElement | null>>({});
  const root = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const titleOf = (tab: Tab, i: number) => tab.name ?? tab.worktree ?? tab.group ?? (s.titles[tab.focus] || t("workspace.tabTitle", { n: i + 1 }));

  // 터미널 번호는 Workspace마다 따로 매기므로 자기 영역 안에서만 찾는다.
  const focusPane = (pane: number) =>
    root.current?.querySelector<HTMLElement>(`.pane[data-pane="${pane}"] .xterm-helper-textarea`)?.focus();

  // 새 작업그룹: 저장소마다 worktree를 만들고 (src-tauri/src/worktrees.rs) 그 폴더에서 기본 그룹을 띄운다.
  // git이 몇 초 걸릴 수 있어 끝나면 탭을 연다. 만드는 중에 또 누르면 무시한다.
  async function createGroup() {
    if (creating.current) return;
    creating.current = true;
    const { group, onError, t } = latest.current;
    try {
      const made = await invoke<{ name: string; path: string }>("group_create", { project: cwd, prefix: group?.id ?? "shell" });
      dispatch({ type: "newGroupTab", group, cwd: made.path, worktree: made.name });
    } catch (raw) {
      const { code, detail } = codeError(raw);
      onError(t("group.createFailed", { detail: code === "noRepos" ? t("group.noRepos") : detail }));
    } finally {
      creating.current = false;
    }
  }
  const createGroupRef = useRef(createGroup);
  createGroupRef.current = createGroup;

  // 단축키 대부분은 네이티브 메뉴(src-tauri/src/menu.rs)가 받아서 "menu" 이벤트로 보낸다.
  useEffect(() => {
    const unlisten = listen<string>("menu", (e) => {
      if (!visibleRef.current) return;
      if (e.payload === "new_group") createGroupRef.current();
      else if (MENU[e.payload]) dispatch(MENU[e.payload]);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

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

  // 끌기(탭·구분선)는 포인터가 요소 밖으로 나가도 따라가도록 window에서 받는다 (끄는 중에 탭 요소가 DOM에서
  // 옮겨져서 포인터 캡처도 못 쓴다). 끝나는 경우를 모두 같은 정리로 모은다 (리뷰 지적 5): pointerup, pointercancel,
  // 버튼이 눌려 있지 않은 움직임 (창 밖에서 떼면 pointerup이 오지 않는다), 언마운트, 새 끌기 시작.
  const endPointer = useRef<(() => void) | null>(null);
  useEffect(() => () => endPointer.current?.(), []);
  function trackPointer(onMove: (ev: PointerEvent, end: () => void) => void, onEnd?: () => void) {
    endPointer.current?.();
    const move = (ev: PointerEvent) => (ev.buttons === 0 ? end() : onMove(ev, end));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (endPointer.current === end) endPointer.current = null;
      onEnd?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    endPointer.current = end;
  }

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
                setMenu({ x: e.clientX, y: e.clientY, items: [{ label: t("workspace.renameTab"), action: () => setRenaming(tab.id) }] });
              }}
            >
              {tab.worktree && <WorktreeIcon title={tab.cwd} />}
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
        <button className="tabbar-btn" disabled={!activeTab} title={t("workspace.splitRight")} onClick={() => dispatch({ type: "split", dir: "row" })}>
          <SplitIcon dir="row" />
        </button>
        <button className="tabbar-btn" disabled={!activeTab} title={t("workspace.splitDown")} onClick={() => dispatch({ type: "split", dir: "col" })}>
          <SplitIcon dir="col" />
        </button>
      </div>
      {/* 탭이 하나도 없으면: 탭 바는 그대로 두고, 열 수 있는 것을 모두 보여 준다 */}
      {s.tabs.length === 0 && (
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
        return (
          <div
            key={tab.id}
            ref={(el) => {
              bodies.current[tab.id] = el;
            }}
            className="tab-body"
            style={{ display: active ? undefined : "none" }}
          >
            {panes.map(({ id, rect }) => (
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
                {s.sessions[id] && (
                  <div className="pane-label">
                    {s.sessions[id].name}
                    {s.sessions[id].readOnly && <span className="pane-badge">{t("session.readOnly")}</span>}
                  </div>
                )}
                <Terminal
                  cwd={tab.cwd}
                  command={commandOf(s.sessions[id])}
                  shiftEnter={s.sessions[id]?.shiftEnter}
                  focused={visible && active && tab.focus === id}
                  onFocus={() => dispatch({ type: "focus", pane: id })}
                  onTitle={(title) => dispatch({ type: "title", pane: id, title })}
                  onExit={() => dispatch({ type: "closePane", pane: id })}
                />
              </div>
            ))}
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
