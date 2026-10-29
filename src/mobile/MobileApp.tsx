import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { LOCALES, type Locale, type MessageKey } from "../i18n";
import { THEMES, type ThemeId } from "../themes";
import { API_VERSION, ApiError, api, events, loadComputers, pair, saveComputers, type Computer, type Members, type Message, type Project } from "./api";
import { locale, t } from "./i18n";
import { changeKey, confirmed, enablePush, keyProblem, onKeyProblem, pushState, removeComputer, syncPush } from "./push";
import { FONT_SCALES, applySettings, loadSettings, resolveLocale, saveSettings, type PhoneSettings } from "./settings";
import { MessageView, ReadMark, readTarget } from "./sync";
import { PromptChoices, answerText, lastAnswers } from "../PromptChoices";
import { ModePicker, modeLabel, modeText } from "../ModePicker";

const USER = "user";
// src-tauri/src/chat.rs NO_RECIPIENT: 받을 참여자가 없어 보내지 않음
const NO_RECIPIENT = "no-recipient";
// src-tauri/src/chat.rs WAKE_LIMIT
const WAKE_LIMIT = 6;

// 참여자 상태 (src-tauri/src/pty.rs statuses): 작업 중이거나 사용자를 기다리는 종류
const STATUS: Record<string, MessageKey> = {
  working: "status.working",
  permission: "status.permission",
  question: "status.question",
  auth: "status.auth",
  dialog: "status.dialog",
  blocked: "status.blocked",
};

// 주소(hash): #/ 처음, #/add 컴퓨터 추가, #/settings 설정, #/c/<컴퓨터 id> 프로젝트 목록, #/c/<컴퓨터 id>/p/<프로젝트 id> 채팅.
// 맥의 QR은 #pair=<API 주소>&code=<코드>로 연다 (추가 화면에 채워 넣는다).
type Route = { view: "home" } | { view: "settings" } | { view: "add"; address: string; code: string } | { view: "projects"; computer: string } | { view: "chat"; computer: string; project: string };

function parse(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (h.startsWith("pair=")) {
    const q = new URLSearchParams(h);
    return { view: "add", address: q.get("pair") ?? "", code: q.get("code") ?? "" };
  }
  const parts = h.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "add") return { view: "add", address: "", code: "" };
  if (parts[0] === "settings") return { view: "settings" };
  if (parts[0] === "c" && parts[1] && parts[2] === "p" && parts[3]) return { view: "chat", computer: parts[1], project: parts[3] };
  if (parts[0] === "c" && parts[1]) return { view: "projects", computer: parts[1] };
  return { view: "home" };
}

// replace: 지금 주소를 기록에 남기지 않는다 (페어링 링크의 코드)
const go = (path: string, replace = false) => {
  if (replace) location.replace(`#${path}`);
  else location.hash = path;
};

// 그리는 중에 주소를 바꾸지 않게 (그린 뒤에 옮긴다)
function Redirect({ to }: { to: string }) {
  useEffect(() => go(to), [to]);
  return null;
}

function errorText(e: unknown, name: string) {
  if (!(e instanceof ApiError)) return t("phone.error", { detail: String(e) });
  if (e.status === 0) return t("phone.unreachable", { name });
  if (e.status === 401 && e.code === "token") return t("phone.unpaired", { name });
  if (e.status === 401 && e.code === "code") return t("phone.badCode");
  if (e.status === 403 && e.code === "identity") return t("phone.identity");
  if (e.status === 503) return t("phone.tailscale", { name });
  if (e.status === 429) return t("phone.tooMany");
  return t("phone.error", { detail: `${e.status} ${e.code}` });
}

// 연결이 살아 있는 동안 SSE를 받는다. 화면이 숨으면 끊고 (모바일 브라우저가 어차피 끊는다. 실험 M0), 보이면 바로 다시 잇는다.
// 이어질 때마다 onLive를 부른다 (끊긴 동안 놓친 것을 다시 읽게).
type Live = "live" | "connecting" | "down";
function useEvents(computer: Computer | null, onEvent: (kind: string, data: Record<string, unknown>) => void, onLive: () => void): Live {
  const [live, setLive] = useState<Live>("connecting");
  const handlers = useRef({ onEvent, onLive });
  handlers.current = { onEvent, onLive };
  useEffect(() => {
    if (!computer) return;
    let alive = true;
    let ctl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const connect = async () => {
      clearTimeout(timer);
      if (!alive || document.hidden || ctl) return;
      const mine = new AbortController();
      ctl = mine;
      setLive("connecting");
      try {
        await events(
          computer,
          (kind, data) => {
            if (kind === "hello") {
              failures = 0;
              setLive("live");
              handlers.current.onLive();
            } else handlers.current.onEvent(kind, data);
          },
          mine.signal,
        );
      } catch {
        // 아래에서 다시 잇는다
      }
      if (ctl === mine) ctl = null;
      if (!alive || mine.signal.aborted) return;
      setLive("down");
      // 막 켜진 화면에서는 네트워크가 늦게 붙는 경우가 있어서 처음에는 짧게 (실험 M0)
      const delays = [1000, 3000, 10000];
      timer = setTimeout(connect, delays[Math.min(failures++, delays.length - 1)]);
    };
    const onVisible = () => {
      if (document.hidden) {
        clearTimeout(timer);
        ctl?.abort();
        ctl = null;
      } else {
        failures = 0;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    connect();
    return () => {
      alive = false;
      clearTimeout(timer);
      ctl?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [computer]);
  return live;
}

export function MobileApp() {
  const [route, setRoute] = useState(() => parse(location.hash));
  const [computers, setComputers] = useState(loadComputers);
  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const update = (list: Computer[]) => {
    saveComputers(list);
    setComputers(list);
  };

  if (route.view === "settings") return <Settings />;
  if (route.view === "add" || (route.view === "home" && computers.length === 0)) {
    const r = route.view === "add" ? route : { address: "", code: "" };
    return (
      <AddComputer
        computers={computers}
        key={`${r.address}|${r.code}`}
        address={r.address}
        code={r.code}
        canCancel={computers.length > 0}
        onPaired={(c) => {
          update([...computers.filter((x) => x.id !== c.id && x.api !== c.api), c]);
          go(`/c/${encodeURIComponent(c.id)}`, true);
        }}
      />
    );
  }
  // 컴퓨터가 하나면 목록을 건너뛴다
  if (route.view === "home" && computers.length === 1) return <Redirect to={`/c/${encodeURIComponent(computers[0].id)}`} />;
  // 알림 키를 바꾸지 못하면 (뺀 맥이 예전 구독으로 보낼 수 있다) 어느 화면에서든 알린다 (KeyProblem)
  const remove = (id: string) => {
    const rest = computers.filter((c) => c.id !== id);
    const removed = computers.find((c) => c.id === id);
    update(rest);
    if (removed) removeComputer(removed, rest);
  };
  if (route.view === "home") return <ComputerList computers={computers} onRemove={remove} />;
  const computer = computers.find((c) => c.id === route.computer);
  if (!computer) return <Redirect to="/" />;
  if (route.view === "projects") return <ProjectList computer={computer} computers={computers} />;
  return <Chat key={`${computer.id}/${route.project}`} computer={computer} project={route.project} home={computers.length > 1} />;
}

function AddComputer({ computers, address: initialAddress, code: initialCode, canCancel, onPaired }: { computers: Computer[]; address: string; code: string; canCancel: boolean; onPaired: (c: Computer) => void }) {
  const [address, setAddress] = useState(initialAddress);
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!address.trim() || !/^\d{6}$/.test(code.trim())) return setError(t("phone.needAddressCode"));
    setBusy(true);
    try {
      onPaired(await pair(address, code));
    } catch (e) {
      setError(errorText(e, address));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="screen">
      <header className="bar">
        {canCancel && (
          <button className="bar-back" onClick={() => go("/")} aria-label={t("phone.back")}>
            ‹
          </button>
        )}
        <h1>{t("phone.addComputer")}</h1>
        <SettingsButton />
      </header>
      <KeyProblem computers={computers} />
      <main className="form">
        <p className="hint">{t("phone.pairHint")}</p>
        <label>
          {t("phone.address")}
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://mac.tailnet.ts.net" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </label>
        <label>
          {t("phone.code")}
          <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy} onClick={submit}>
          {busy ? t("phone.pairing") : t("phone.pair")}
        </button>
      </main>
    </div>
  );
}

const SettingsButton = () => (
  <button className="bar-side" onClick={() => go("/settings")} aria-label={t("phone.settings")} title={t("phone.settings")}>
    ⚙
  </button>
);

// 선 아이콘 (글자 크기를 따르고 색은 버튼 글자색)
const Icon = ({ paths }: { paths: string[] }) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths.map((d) => (
      <path key={d} d={d} />
    ))}
  </svg>
);

// 처음(컴퓨터 목록)으로 한 번에. 컴퓨터가 여럿일 때 채팅 막대에 둔다 (여러 프로젝트를 다니면 뒤로 가기로는 멀다.
// 하나면 처음이 프로젝트 목록이라 ‹와 같다)
const HomeButton = () => (
  <button className="bar-side" data-home onClick={() => go("/")} aria-label={t("phone.computers")} title={t("phone.computers")}>
    <Icon paths={["M3 11 12 3l9 8", "M5 9.5V21h5v-6h4v6h5V9.5"]} />
  </button>
);

// 설정 (settings.ts): 테마·언어·글자 크기. 테마와 글자 크기는 바로 바뀌고, 언어는 화면을 다시 읽어 바꾼다 (문구를 시작할 때 고른다).
// apply·reload는 자체 테스트가 바꾼다 (데스크톱 화면에 적용하지 않게)
export function Settings({ apply = applySettings, reload = () => location.reload() }: { apply?: (s: PhoneSettings) => void; reload?: () => void }) {
  const [settings, setSettings] = useState(loadSettings);
  const [unsaved, setUnsaved] = useState(false);
  // 저장하지 못하면 테마·글자 크기는 지금 화면에만 반영하고 알린다. 언어는 다시 읽어야 바뀌는데 다시 읽으면 저장값(이전 언어)으로
  // 돌아가므로 바꾸지 않는다 (리뷰 R2)
  const change = (next: PhoneSettings) => {
    const saved = saveSettings(next);
    setUnsaved(!saved);
    const relocale = resolveLocale(next, navigator.language) !== locale;
    if (relocale && !saved) return;
    setSettings(next);
    if (relocale) reload();
    else apply(next);
  };
  const auto = t("phone.followPhone");
  const themes: ["auto" | ThemeId, string][] = [["auto", auto], ...Object.entries(THEMES).map(([id, th]): [ThemeId, string] => [id as ThemeId, t(th.name)])];
  const locales: ["auto" | Locale, string][] = [["auto", auto], ...Object.entries(LOCALES).map(([id, l]): [Locale, string] => [id as Locale, l.name])];
  const group = <T extends string | number>(label: string, key: keyof PhoneSettings, options: [T, string][]) => (
    <section className="setting" data-setting={key}>
      <h2>{label}</h2>
      <div className="choices">
        {options.map(([value, text]) => (
          <button key={value} className={settings[key] === value ? "on" : ""} aria-pressed={settings[key] === value} data-value={value} onClick={() => change({ ...settings, [key]: value })}>
            {text}
          </button>
        ))}
      </div>
    </section>
  );
  return (
    <div className="screen">
      <header className="bar">
        <button className="bar-back" onClick={() => go("/")} aria-label={t("phone.back")}>
          ‹
        </button>
        <h1>{t("phone.settings")}</h1>
      </header>
      <main className="settings">
        {unsaved && <p className="error">{t("phone.settingsUnsaved")}</p>}
        {group(t("phone.theme"), "theme", themes)}
        {group(t("phone.language"), "locale", locales)}
        <p className="hint">{t("phone.languageHint")}</p>
        {group(t("phone.fontSize"), "fontScale", FONT_SCALES.map((f): [number, string] => [f, `${Math.round(f * 100)}%`]))}
      </main>
    </div>
  );
}

// 알림 키를 바꾸지 못했다 (src/mobile/push.ts keyProblem): 다시 시도할 수 있게
export function KeyProblem({ computers }: { computers: Computer[] }) {
  const problem = useSyncExternalStore(onKeyProblem, keyProblem);
  if (!problem) return null;
  return (
    <div className="banner bad push-banner">
      <span>{t("phone.keyFailed", { detail: problem })}</span>
      <button onClick={() => changeKey(computers)}>{t("phone.retry")}</button>
    </div>
  );
}

// 이 폰의 알림: 권한이 있으면 구독을 맞추고 (src/mobile/push.ts), 없으면 켜기를 보인다. 화면이 다시 보일 때마다 맞춘다.
function PushBanner({ computers }: { computers: Computer[] }) {
  const [state, setState] = useState(pushState);
  const [error, setError] = useState<string | null>(null);
  const failed = (e: unknown) => setError(t("phone.notifyFailed", { detail: e instanceof Error ? e.message : String(e) }));
  useEffect(() => {
    const check = () => {
      if (document.hidden) return;
      setState(pushState());
      syncPush(computers).then(() => setError(null), failed);
    };
    check();
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, [computers]);
  const enable = () =>
    enablePush(computers).then((s) => {
      setState(s);
      setError(null);
    }, failed);
  const problem = <KeyProblem computers={computers} />;
  if (error)
    return (
      <>
        {problem}
        <div className="banner bad">{error}</div>
      </>
    );
  if (state === "denied")
    return (
      <>
        {problem}
        <div className="banner">{t("phone.notifyDenied")}</div>
      </>
    );
  if (state !== "off") return problem;
  return (
    <div className="banner push-banner">
      <span>{t("phone.notifyOff")}</span>
      <button className="primary" onClick={enable}>
        {t("phone.notifyOn")}
      </button>
    </div>
  );
}

export function ComputerList({ computers, onRemove }: { computers: Computer[]; onRemove: (id: string) => void }) {
  // 컴퓨터마다 켜져 있는지 (/api/info가 답하는지)
  const [state, setState] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    for (const c of computers) {
      api.info(c).then(
        (info) => alive && setState((s) => ({ ...s, [c.id]: info.api === API_VERSION ? "" : t("phone.update", { name: c.name }) })),
        (e) => alive && setState((s) => ({ ...s, [c.id]: errorText(e, c.name) })),
      );
    }
    return () => {
      alive = false;
    };
  }, [computers]);
  return (
    <div className="screen">
      <header className="bar">
        <h1>{t("phone.computers")}</h1>
        <SettingsButton />
      </header>
      <PushBanner computers={computers} />
      <main className="list">
        {computers.map((c) => (
          <div key={c.id} className="row">
            <button className="row-main" onClick={() => go(`/c/${encodeURIComponent(c.id)}`)}>
              <span className="row-title">{c.name}</span>
              <span className={`row-sub${state[c.id] ? " bad" : ""}`}>{state[c.id] ?? "…"}</span>
            </button>
            {/* 실수로 누르지 않게 작은 빨간 휴지통 아이콘, 누르면 확인 창 */}
            <button
              className="row-side row-remove"
              onClick={() => confirm(t("phone.removeConfirm", { name: c.name })) && onRemove(c.id)}
              aria-label={t("phone.remove")}
              title={t("phone.remove")}
            >
              <Icon paths={["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13", "M10 11v6", "M14 11v6"]} />
            </button>
          </div>
        ))}
        <button className="row-add" onClick={() => go("/add")}>
          + {t("phone.addComputer")}
        </button>
      </main>
    </div>
  );
}

function ProjectList({ computer, computers }: { computer: Computer; computers: Computer[] }) {
  const many = computers.length > 1;
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const n = useRef(0);
  const load = useCallback(() => {
    const mine = ++n.current;
    Promise.all([api.info(computer), api.projects(computer)]).then(
      ([info, list]) => {
        if (mine !== n.current) return;
        // 이 화면이 모르는 API면 목록도 쓰지 않는다
        setError(info.api === API_VERSION ? null : t("phone.update", { name: computer.name }));
        setProjects(info.api === API_VERSION ? list : null);
      },
      (e) => mine === n.current && setError(errorText(e, computer.name)),
    );
  }, [computer]);
  useEffect(load, [load]);
  // 이벤트가 몰려도 한 번만 다시 읽는다
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const soon = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 300);
  };
  const live = useEvents(computer, soon, load);
  return (
    <div className="screen">
      <header className="bar">
        {many && (
          <button className="bar-back" onClick={() => go("/")} aria-label={t("phone.back")}>
            ‹
          </button>
        )}
        <h1>{computer.name}</h1>
        {!many && (
          <button className="bar-side" onClick={() => go("/add")}>
            +
          </button>
        )}
        <SettingsButton />
      </header>
      {live !== "live" && !error && <div className="banner">{t("phone.reconnecting")}</div>}
      {error && <div className="banner bad">{error}</div>}
      <PushBanner computers={computers} />
      <main className="list">
        {projects?.length === 0 && <p className="hint">{t("phone.noProjects")}</p>}
        {projects?.map((p) => (
          <button key={p.id} className="row row-main" onClick={() => go(`/c/${encodeURIComponent(computer.id)}/p/${encodeURIComponent(p.id)}`)}>
            <span className="row-title">{p.name}</span>
            <span className="row-sub">
              {p.open === false ? t("phone.notOpen") : p.sessions > 0 ? t("phone.sessions", { n: p.sessions }) : t("phone.noSessions")}
              {!!p.unread && <span className="badge unread">{t("phone.unreadBadge", { n: p.unread })}</span>}
              {!!p.awaiting && <span className="badge">{t("phone.awaitingBadge", { n: p.awaiting })}</span>}
              {p.paused.length > 0 && <span className="badge">{t("phone.pausedBadge")}</span>}
            </span>
          </button>
        ))}
      </main>
    </div>
  );
}

export function Chat({ computer, project, home = false }: { computer: Computer; project: string; home?: boolean }) {
  const [name, setName] = useState("");
  // 보이는 메시지 (src/mobile/sync.ts). 바뀔 때마다 그리기 번호를 올린다.
  const view = useRef(new MessageView());
  const [, redraw] = useState(0);
  const changed = () => redraw((n) => n + 1);
  const { messages, more } = view.current;
  const [members, setMembers] = useState<Members>({ members: [], waiting: [], paused: [] });
  const [error, setError] = useState<string | null>(null);
  // 맥의 ddak이 이 화면이 모르는 API면 쓰지 않는다
  const [outdated, setOutdated] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // "맥에서 열기"를 보냈다 (맥이 열면 참여자가 바뀌어 안내가 사라진다)
  const [opening, setOpening] = useState(false);
  // 권한 모드를 고르는 참여자 (참여자 칩 옆 모드를 누름)
  const [picking, setPicking] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);
  // 여기까지 읽었다고 맥에 알린다 (맥의 배지와 목록의 안 읽은 수): 화면이 보이고, 맨 아래(최신)를 보고 있고, 서버와 맞춘
  // 상태일 때만 (src/mobile/sync.ts readable, ReadMark. 3단계 리뷰 R1·R2). 실패하면 ReadMark가 다시 보낸다
  const reads = useRef<ReadMark | null>(null);
  useEffect(() => {
    const r = new ReadMark((id) => api.read(computer, project, id));
    reads.current = r;
    return () => r.stop();
  }, [computer, project]);
  const markRead = useCallback(() => {
    reads.current?.mark(readTarget(view.current, !document.hidden, atBottom.current));
  }, []);
  // 최신 페이지로 바꾼다 (처음, 다시 이어짐, 지움, 이 채팅의 알림이 옴). 화면에 적용했으면 true
  const loadLatest = useCallback(() => {
    const load = view.current.begin();
    return api.messages(computer, project).then(
      (r) => {
        if (!view.current.latest(load, r.messages, r.more)) return false;
        setName(r.name);
        setError(null);
        changed();
        markRead();
        return true;
      },
      (e) => {
        view.current.fail(load);
        setError(errorText(e, computer.name));
        return false;
      },
    );
  }, [computer, project, markRead]);
  const nb = useRef(0);
  // 참여자를 다시 읽는다. 화면에 적용했으면 그 값
  const loadMembers = useCallback(() => {
    const mine = ++nb.current;
    return api.members(computer, project).then(
      (m) => {
        if (mine !== nb.current) return null;
        setMembers(m);
        return m;
      },
      () => null,
    );
  }, [computer, project]);
  // 보고 있는 이 채팅의 알림이 왔다 (main.tsx, sw.js): 그 종류가 알린 것을 다시 읽어 보였으면 그 알림을 닫는다
  // (SSE만 끊겼거나 읽지 못하면 알림이 남는다. 재리뷰 R2)
  useEffect(() => {
    const on = (e: Event) => {
      const { tag, kind, id } = (e as CustomEvent<{ tag: string; kind: string; id: string }>).detail;
      if (tag !== `${computer.id}/${project}`) return;
      Promise.all([kind === "message" ? loadLatest() : false, kind === "message" ? null : loadMembers()]).then(([latest, m]) => {
        if (!confirmed(kind, latest, m) || document.hidden) return;
        navigator.serviceWorker
          ?.getRegistration()
          .then((r) => r?.getNotifications({ tag }))
          .then((ns) => ns?.filter((n) => n.data?.id === id).forEach((n) => n.close()), () => {});
      });
    };
    addEventListener("ddak-shown", on);
    return () => removeEventListener("ddak-shown", on);
  }, [computer, project, loadLatest, loadMembers]);
  useEffect(() => {
    api.info(computer).then((info) => setOutdated(info.api !== API_VERSION), () => {});
    loadLatest();
    loadMembers();
  }, [computer, loadLatest, loadMembers]);
  const live = useEvents(
    computer,
    (kind, data) => {
      if (data.project !== undefined && data.project !== project) return;
      if (kind === "message" && data.message) {
        view.current.event(data.message as Message);
        changed();
        markRead();
      } else if (kind === "cleared") loadLatest();
      else if (kind === "members" || kind === "waiting" || kind === "status") loadMembers();
    },
    () => {
      loadLatest();
      loadMembers();
    },
  );

  useLayoutEffect(() => {
    const el = list.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const earlier = async () => {
    const { before, gen } = view.current.older();
    if (!before) return;
    try {
      const el = list.current;
      const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
      const r = await api.messages(computer, project, before);
      if (!view.current.earlier(gen, r.messages, r.more)) return;
      atBottom.current = false;
      changed();
      // 보던 자리를 지킨다
      requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight - fromBottom));
    } catch (e) {
      setError(errorText(e, computer.name));
    }
  };

  const send = async () => {
    const sent = draft;
    if (!sent.trim() || sending) return;
    setSending(true);
    try {
      view.current.event(await api.post(computer, project, sent));
      changed();
      // 보내는 동안 새로 쓴 것은 남긴다
      setDraft((d) => (d === sent ? "" : d));
      // 보내면 맨 아래로 옮겨 최신을 보게 되므로 읽음도 알린다 (스크롤로 내려온 것이 아니라 onScroll이 알리지 않는다. 3단계 재리뷰 R4)
      atBottom.current = true;
      markRead();
      setError(null);
    } catch (e) {
      // 받는 사람이 없으면 보내지 않았다. 초안은 그대로 둔다
      setError(e instanceof ApiError && e.code === NO_RECIPIENT ? t("chat.noRecipient") : errorText(e, computer.name));
    } finally {
      setSending(false);
    }
  };

  const mention = (who: string) => {
    setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}@${who} `);
    input.current?.focus();
  };
  const time = (ms: number) => new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const who = (n: string) => (n === USER ? t("chat.you") : n);
  // 선택 창마다 마지막 답 기록
  const answers = lastAnswers(messages);

  return (
    <div className="screen chat">
      <header className="bar">
        <button className="bar-back" onClick={() => go(`/c/${encodeURIComponent(computer.id)}`)} aria-label={t("phone.back")}>
          ‹
        </button>
        <h1>{name || "…"}</h1>
        {home && <HomeButton />}
      </header>
      {outdated && <div className="banner bad">{t("phone.update", { name: computer.name })}</div>}
      {!outdated && live !== "live" && !error && <div className="banner">{t("phone.reconnecting")}</div>}
      {!outdated && error && <div className="banner bad">{error}</div>}
      {!outdated && members.open === false && (
        <div className="banner push-banner">
          <span>{t("phone.closedHint")}</span>
          <button
            className="primary"
            disabled={opening}
            onClick={() => {
              setOpening(true);
              api.open(computer, project).then(
                () => setTimeout(() => setOpening(false), 10_000),
                (e) => {
                  setOpening(false);
                  setError(errorText(e, computer.name));
                },
              );
            }}
          >
            {opening ? t("phone.opening") : t("phone.openOnMac")}
          </button>
        </div>
      )}
      {!outdated && (
        <>
          <div
            ref={list}
            className="messages"
            onScroll={(e) => {
              const el = e.currentTarget;
              const was = atBottom.current;
              atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
              // 아래로 내려와 최신을 보게 됨
              if (atBottom.current && !was) markRead();
            }}
          >
            {more && (
              <button className="earlier" onClick={earlier}>
                {t("phone.earlier")}
              </button>
            )}
            {messages.length === 0 && !error && <p className="hint">{t("chat.empty")}</p>}
            {messages.map((m) => (
              <div key={m.id} className={`msg${m.from === USER ? " mine" : ""}${m.to.includes(USER) ? " to-me" : ""}`}>
                <div className="meta">
                  <span className="from">{who(m.from)}</span>
                  {m.to.length > 0 && <span>→ {m.to.map(who).join(", ")}</span>}
                  {m.via && <span>{t("chat.via", { device: m.via })}</span>}
                  {m.held && <span className="tag">{t("chat.held")}</span>}
                  <time>{time(m.time)}</time>
                </div>
                {m.prompt ? (
                  <PromptChoices
                    prompt={m.prompt}
                    open={!!members.prompts?.includes(m.prompt.id)}
                    last={answers.get(m.prompt.id)}
                    t={t}
                    onAnswer={(option) => api.answer(computer, project, m.prompt!.id, option)}
                  />
                ) : m.answer ? (
                  <div className={`text answer ${m.answer.result}`}>{answerText(m.answer, t)}</div>
                ) : m.mode ? (
                  <div className={`text answer ${m.mode.result}`}>{modeText(m.mode, t)}</div>
                ) : (
                  <div className="text">{m.text}</div>
                )}
              </div>
            ))}
          </div>
          {members.paused.map((g) => (
            <div key={g} className="paused">
              <span>{t("chat.paused", { group: g, n: WAKE_LIMIT })}</span>
              <button onClick={() => api.resume(computer, project, g).then(loadMembers, (e) => setError(errorText(e, computer.name)))}>{t("chat.resume")}</button>
            </div>
          ))}
          {picking && members.modes?.[picking] && (
            <ModePicker member={picking} mode={members.modes[picking]} t={t} onPick={(mode) => api.setMode(computer, project, picking, mode)} onClose={() => setPicking(null)} />
          )}
          <div className="chips">
            {/* 모두에게는 @all을 골라야 한다 (멘션이 없으면 보내지 않는다) */}
            {members.members.length > 1 && (
              <button className="chip" data-member="all" onClick={() => mention("all")}>
                {t("chat.all")}
              </button>
            )}
            {members.members
              .filter((m) => m !== USER)
              .map((m) => {
                const status = members.status?.[m];
                const look = status === "working" ? " working" : status ? " awaiting" : members.waiting.includes(m) ? " waiting" : "";
                const mode = members.modes?.[m];
                return (
                  <span key={m} className="chip-pair">
                    <button className={`chip${look}`} onClick={() => mention(m)}>
                      {m}
                      {status && STATUS[status] && <span className="chip-note">{t(STATUS[status])}</span>}
                      {members.waiting.includes(m) && <span className="chip-note">{t("chat.waiting")}</span>}
                    </button>
                    {mode && (
                      <button className={`chip mode-chip${picking === m ? " picking" : ""}`} data-mode-of={m} onClick={() => setPicking(picking === m ? null : m)}>
                        {modeLabel(mode, t)}
                      </button>
                    )}
                  </span>
                );
              })}
            {members.members.length <= 1 && <span className="hint">{t("chat.noMembers")}</span>}
          </div>
          <div className="composer">
            <textarea ref={input} rows={2} value={draft} placeholder={t("phone.placeholder")} onChange={(e) => setDraft(e.target.value)} />
            <button className="primary" disabled={sending || !draft.trim()} onClick={send}>
              {t("phone.send")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
