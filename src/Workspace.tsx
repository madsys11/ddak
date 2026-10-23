import { useEffect, useReducer, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { Layout, Path, measure, paneIds, remove, row, setRatio, split } from "./layout";
import { Terminal } from "./Terminal";
import { useT } from "./prefs";
import type { Group, Session } from "./useGroups";

// group: 작업그룹으로 연 탭이면 그 그룹 이름 (탭 제목). 아니면 터미널 제목을 쓴다.
type Tab = { id: number; layout: Layout; focus: number; group?: string };
// sessions: 작업그룹 세션으로 띄운 터미널 → 그 세션. 없으면 그냥 셸.
type State = { tabs: Tab[]; active: number; titles: Record<number, string>; sessions: Record<number, Session>; nextId: number };

type Action =
  | { type: "newTab" }
  | { type: "selectTab"; id: number }
  | { type: "selectTabAt"; index: number }
  | { type: "cycleTab"; delta: number }
  | { type: "closeTab"; id: number }
  | { type: "split"; dir: "row" | "col" }
  | { type: "closePane"; pane?: number }
  | { type: "focus"; pane: number }
  | { type: "ratio"; tab: number; path: Path; ratio: number }
  | { type: "title"; pane: number; title: string };

// 첫 탭 = 원본 폴더에서 작업하는 작업그룹. 그룹의 세션들을 나란히 띄운다.
// 설정을 못 읽었으면 (group 없음) 셸 하나로 시작한다.
function initial(group: Group | null): State {
  if (!group) return { tabs: [{ id: 1, layout: { pane: 2 }, focus: 2 }], active: 1, titles: {}, sessions: {}, nextId: 3 };
  const panes = group.sessions.map((_, i) => 2 + i);
  return {
    tabs: [{ id: 1, layout: row(panes), focus: panes[0], group: group.name }],
    active: 1,
    titles: {},
    sessions: Object.fromEntries(group.sessions.map((s, i) => [panes[i], s])),
    nextId: 2 + panes.length,
  };
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
      const pane = s.nextId + 1;
      return { ...s, tabs: [...s.tabs, { id: s.nextId, layout: { pane }, focus: pane }], active: s.nextId, nextId: s.nextId + 2 };
    }
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
  }
}

const MENU: Record<string, Action> = {
  new_tab: { type: "newTab" },
  split_right: { type: "split", dir: "row" },
  split_down: { type: "split", dir: "col" },
  close_pane: { type: "closePane" },
};

const pct = (v: number) => `${v * 100}%`;

// 프로젝트마다 Workspace가 하나씩 떠 있다. 보이는(visible) 것만 단축키를 받는다.
// group: 처음 열 때 띄울 작업그룹 (기본 그룹). 열린 뒤에 설정이 바뀌어도 이미 뜬 세션은 그대로 둔다.
export function Workspace({ cwd, visible, group }: { cwd: string; visible: boolean; group: Group | null }) {
  const t = useT();
  const [s, dispatch] = useReducer(reducer, group, initial);
  const bodies = useRef<Record<number, HTMLDivElement | null>>({});
  const root = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // 터미널 번호는 Workspace마다 따로 매기므로 자기 영역 안에서만 찾는다.
  const focusPane = (pane: number) =>
    root.current?.querySelector<HTMLElement>(`.pane[data-pane="${pane}"] .xterm-helper-textarea`)?.focus();

  // 단축키 대부분은 네이티브 메뉴(src-tauri/src/menu.rs)가 받아서 "menu" 이벤트로 보낸다.
  useEffect(() => {
    const unlisten = listen<string>("menu", (e) => visibleRef.current && MENU[e.payload] && dispatch(MENU[e.payload]));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

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

  function startDrag(e: React.PointerEvent, tab: number, d: ReturnType<typeof measure>["dividers"][number]) {
    e.preventDefault();
    const body = bodies.current[tab]!.getBoundingClientRect();
    // 커서가 구분선 밖으로 나가도 계속 따라가도록 window에서 받는다.
    const move = (ev: PointerEvent) => {
      const ratio =
        d.dir === "row"
          ? (ev.clientX - body.left - d.parent.x * body.width) / (d.parent.w * body.width)
          : (ev.clientY - body.top - d.parent.y * body.height) / (d.parent.h * body.height);
      dispatch({ type: "ratio", tab, path: d.path, ratio: Math.min(0.9, Math.max(0.1, ratio)) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  if (s.tabs.length === 0) {
    return (
      <div className="workspace-empty" ref={root}>
        <button onClick={() => dispatch({ type: "newTab" })}>{t("workspace.newTerminal")}</button>
      </div>
    );
  }

  return (
    <div className="workspace" ref={root}>
      {/* 탭 바를 눌러도 터미널이 포커스를 잃지 않게 한다. Terminal의 포커스 효과는
          focused 값이 바뀔 때만 돌아서, 활성 탭을 다시 누르거나 다른 탭의 ×를 누르면 복원되지 않는다. */}
      <div className="tabbar" onMouseDownCapture={(e) => e.preventDefault()}>
        {s.tabs.map((tab, i) => (
          <div
            key={tab.id}
            className={`tab${tab.id === s.active ? " active" : ""}`}
            onMouseDown={() => {
              // 활성 탭을 누르면 다른 곳(파일 트리 등)에 있던 포커스를 터미널로 가져온다.
              if (tab.id === s.active) focusPane(tab.focus);
              else dispatch({ type: "selectTab", id: tab.id });
            }}
          >
            <span className="tab-title">{tab.group ?? (s.titles[tab.focus] || t("workspace.tabTitle", { n: i + 1 }))}</span>
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
        <button className="tabbar-btn" title={t("workspace.newTab")} onClick={() => dispatch({ type: "newTab" })}>
          +
        </button>
        <div className="tabbar-spacer" />
        <button className="tabbar-btn" title={t("workspace.splitRight")} onClick={() => dispatch({ type: "split", dir: "row" })}>
          ◫
        </button>
        <button className="tabbar-btn" title={t("workspace.splitDown")} onClick={() => dispatch({ type: "split", dir: "col" })}>
          ⊟
        </button>
      </div>
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
                  cwd={cwd}
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
    </div>
  );
}
