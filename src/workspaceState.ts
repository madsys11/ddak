import { type Layout, paneIds, remove } from "./layout";
import type { Session } from "./useGroups";

// cwd: 이 탭의 터미널들이 뜨는 폴더 (원본 프로젝트 폴더 또는 작업그룹의 worktree 폴더).
// group: 작업그룹으로 연 탭이면 그 그룹 이름. worktree: 새 worktree로 만든 작업그룹이면 그 이름 (탭 제목).
// 둘 다 없으면 터미널 제목을 쓴다. name: 사용자가 바꾼 탭 이름 (탭 제목만 바뀌고 worktree·브랜치 이름은 그대로).
// setup: 작업그룹 준비 스크립트가 있는 탭이면 그 상태.
// git: Git Graph 탭 (프로젝트마다 하나, src/GitGraph.tsx). repo: 고른 저장소 이름. 터미널이 없고 layout은 자리용 창 하나.
// doc: 문서 탭 (마크다운 파일 하나, src/DocView.tsx). path: 파일의 절대 경로. git 탭처럼 터미널이 없다.
export type Tab = { id: number; layout: Layout; focus: number; cwd: string; group?: string; worktree?: string; name?: string; setup?: Setup; git?: GitTab; doc?: DocTab };
export type GitTab = { repo?: string };
export type DocTab = { path: string };
// 터미널 대신 보기 화면을 둔 탭 (분할·세션 추가가 없다)
export const isViewer = (t: Tab) => !!(t.git || t.doc);
// 창에서 돌리는 세션. setup: 작업그룹 준비를 돌리는 창 (이름표는 번역 문구). sid: 창마다 정한 세션 ID (인자의 {session}).
// prompt: 세션을 만들 때 정한 프롬프트 (인자의 {prompt}, useGroups.ts promptOf). resumed: 복원한 세션이라 이어서 하기(resume)
// 인자로 띄운다.
export type PaneSession = Session & { setup?: boolean; sid?: string; prompt?: string; resumed?: boolean };
// 작업그룹 준비. 세션(CLI)은 준비가 성공하거나 사용자가 "그래도 시작"을 누를 때까지(started) 띄우지 않는다.
// pane: 준비 창 (닫았으면 null). run: 몇 번째 실행인지 (다시 준비하면 터미널을 새로 만들고, 이전 실행의 종료는
// 무시한다). code: 실패한 종료 코드, null이면 중단 (창을 닫음·시그널). spawnFailed: 준비 창의 터미널을 만들지 못함
// (작업 폴더가 없음 등). session: 다시 준비할 때 띄울 명령.
export type Setup = {
  pane: number | null;
  run: number;
  status: "running" | "ok" | "failed";
  code: number | null;
  spawnFailed?: boolean;
  started: boolean;
  session: PaneSession;
};
// root: 프로젝트 폴더. sessions: 작업그룹 세션으로 띄운 터미널 → 그 세션. 없으면 그냥 셸.
// loaded: 저장한 상태를 읽었는지 (읽기 전에는 아무것도 띄우지 않는다). saveBlocked: 저장한 상태를 읽지 못해서
// 저장하지 않는다 (덮어쓰지 않게). slowSave: 마지막 변화가 잦은 것(구분선 끌기)이라 모았다가 저장한다.
export type State = {
  root: string;
  tabs: Tab[];
  active: number;
  titles: Record<number, string>;
  sessions: Record<number, PaneSession>;
  nextId: number;
  loaded: boolean;
  saveBlocked?: boolean;
  slowSave?: boolean;
};

// 앱 데이터 workspaces/<프로젝트>.json에 두는 것 (src-tauri/src/workspace.rs). 터미널 제목·출력은 두지 않는다.
const VERSION = 1;

export function toSaved(s: State): string {
  const panes = new Set(s.tabs.flatMap((t) => paneIds(t.layout)));
  const sessions = Object.fromEntries(
    Object.entries(s.sessions)
      .filter(([pane]) => panes.has(Number(pane)))
      .map(([pane, { resumed: _, ...session }]) => [pane, session]),
  );
  return JSON.stringify({ version: VERSION, active: s.active, tabs: s.tabs, sessions });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isOptString = (v: unknown) => v === undefined || isString(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

function isLayout(v: unknown): v is Layout {
  if (!isObject(v)) return false;
  if ("pane" in v) return isInt(v.pane);
  return (v.dir === "row" || v.dir === "col") && typeof v.ratio === "number" && v.ratio > 0 && v.ratio < 1 && isLayout(v.a) && isLayout(v.b);
}

function isSession(v: unknown): v is PaneSession {
  return (
    isObject(v) &&
    isString(v.name) &&
    isString(v.command) &&
    isStrings(v.args) &&
    (v.resume === undefined || v.resume === null || isStrings(v.resume)) &&
    typeof v.readOnly === "boolean" &&
    (v.shiftEnter === null || isString(v.shiftEnter)) &&
    isOptString(v.sid) &&
    isOptString(v.prompt)
  );
}

function isSetup(v: unknown): v is Setup {
  return (
    isObject(v) &&
    (v.pane === null || isInt(v.pane)) &&
    isInt(v.run) &&
    (v.status === "running" || v.status === "ok" || v.status === "failed") &&
    (v.code === null || isInt(v.code)) &&
    typeof v.started === "boolean" &&
    isSession(v.session)
  );
}

function isTab(v: unknown): v is Tab {
  return (
    isObject(v) &&
    isInt(v.id) &&
    isLayout(v.layout) &&
    isInt(v.focus) &&
    isString(v.cwd) &&
    isOptString(v.group) &&
    isOptString(v.worktree) &&
    isOptString(v.name) &&
    (v.setup === undefined || isSetup(v.setup)) &&
    (v.git === undefined || (isObject(v.git) && isOptString(v.git.repo))) &&
    (v.doc === undefined || (isObject(v.doc) && isString(v.doc.path)))
  );
}

// 저장한 상태로 되돌린다. 모양이 틀리면 null (처음처럼 연다).
// - 준비 창은 되살리지 않는다. 준비를 마치기 전에 닫혔으면 중단으로 보고 세션 창에 다시 준비 / 그래도 시작을 보인다.
// - 세션은 이어서 하기(resume)로 띄운다. 준비를 기다리던 탭의 세션은 아직 뜬 적이 없어서 처음처럼.
// - 셸은 같은 폴더에서 새로 띄운다 (출력은 되살리지 않는다).
export function fromSaved(text: string, root: string): State | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.version !== VERSION || !Array.isArray(raw.tabs) || !raw.tabs.every(isTab) || !isObject(raw.sessions)) return null;
  const saved = raw.sessions;
  if (!Object.entries(saved).every(([pane, session]) => isInt(Number(pane)) && isSession(session))) return null;
  const ids = new Set<number>();
  const tabs: Tab[] = [];
  const sessions: Record<number, PaneSession> = {};
  for (const t of raw.tabs as Tab[]) {
    let layout: Layout | null = t.layout;
    let setup = t.setup;
    if (setup) {
      if (setup.pane !== null && paneIds(layout).includes(setup.pane)) layout = remove(layout, setup.pane);
      const finished = setup.started || setup.status !== "running";
      setup = { ...setup, pane: null, status: finished ? setup.status : "failed", code: finished ? setup.code : null };
    }
    if (!layout) continue;
    const panes = paneIds(layout);
    // 같은 번호가 두 번 나오면 깨진 것 (다른 탭과도, 같은 탭 안에서도. 리뷰 P2: 한 분할의 양쪽이 같은 번호였다)
    for (const p of [t.id, ...panes]) {
      if (ids.has(p)) return null;
      ids.add(p);
    }
    const waiting = !!setup && !setup.started;
    for (const p of panes) {
      const session = saved[p] as PaneSession | undefined;
      if (session && !session.setup) sessions[p] = { ...session, resumed: !waiting };
    }
    tabs.push({ ...t, layout, setup, focus: panes.includes(t.focus) ? t.focus : panes[0] });
  }
  const active = isInt(raw.active) && tabs.some((t) => t.id === raw.active) ? (raw.active as number) : (tabs[0]?.id ?? 0);
  return { root, tabs, active, titles: {}, sessions, nextId: Math.max(0, ...ids) + 1, loaded: true };
}

// 세션을 띄울 명령. 복원한 세션은 resume 인자로 띄우고, 그것이 실패하면 (이어서 할 대화가 아직 없음 등) 처음 인자로
// 띄운다 (src-tauri/src/pty.rs fallback). 인자의 자리표시자는 여기서 바꾸지 않고 값(vars)과 함께 넘긴다: Rust가 {chat}까지
// 한 번에 바꾼다 (차례로 바꾸면 넣은 프롬프트 안의 {chat} 등이 다시 바뀌었다). 처음·복원·fallback에 같은 값을 쓴다.
export function commandOf(s: PaneSession | undefined): { command?: string[]; fallback?: string[]; vars?: Record<string, string> } {
  if (!s?.command) return {};
  const vars = { session: s.sid ?? "", prompt: s.prompt ?? "" };
  const first = [s.command, ...s.args];
  if (s.resumed && s.resume) return { command: [s.command, ...s.resume], fallback: first, vars };
  return { command: first, vars };
}
