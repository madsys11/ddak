import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { API_VERSION, ApiError, api, events, loadComputers, pair, saveComputers, type Computer, type Members, type Message, type Project } from "./api";
import { locale, t } from "./i18n";
import { MessageView } from "./sync";

const USER = "user";
// src-tauri/src/chat.rs WAKE_LIMIT
const WAKE_LIMIT = 6;

// 주소(hash): #/ 처음, #/add 컴퓨터 추가, #/c/<컴퓨터 id> 프로젝트 목록, #/c/<컴퓨터 id>/p/<프로젝트 id> 채팅.
// 맥의 QR은 #pair=<API 주소>&code=<코드>로 연다 (추가 화면에 채워 넣는다).
type Route = { view: "home" } | { view: "add"; address: string; code: string } | { view: "projects"; computer: string } | { view: "chat"; computer: string; project: string };

function parse(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (h.startsWith("pair=")) {
    const q = new URLSearchParams(h);
    return { view: "add", address: q.get("pair") ?? "", code: q.get("code") ?? "" };
  }
  const parts = h.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "add") return { view: "add", address: "", code: "" };
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

  if (route.view === "add" || (route.view === "home" && computers.length === 0)) {
    const r = route.view === "add" ? route : { address: "", code: "" };
    return (
      <AddComputer
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
  if (route.view === "home") return <ComputerList computers={computers} onRemove={(id) => update(computers.filter((c) => c.id !== id))} />;
  const computer = computers.find((c) => c.id === route.computer);
  if (!computer) return <Redirect to="/" />;
  if (route.view === "projects") return <ProjectList computer={computer} many={computers.length > 1} />;
  return <Chat key={`${computer.id}/${route.project}`} computer={computer} project={route.project} />;
}

function AddComputer({ address: initialAddress, code: initialCode, canCancel, onPaired }: { address: string; code: string; canCancel: boolean; onPaired: (c: Computer) => void }) {
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
      </header>
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

function ComputerList({ computers, onRemove }: { computers: Computer[]; onRemove: (id: string) => void }) {
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
      </header>
      <main className="list">
        {computers.map((c) => (
          <div key={c.id} className="row">
            <button className="row-main" onClick={() => go(`/c/${encodeURIComponent(c.id)}`)}>
              <span className="row-title">{c.name}</span>
              <span className={`row-sub${state[c.id] ? " bad" : ""}`}>{state[c.id] ?? "…"}</span>
            </button>
            <button className="row-side" onClick={() => confirm(t("phone.removeConfirm", { name: c.name })) && onRemove(c.id)}>
              {t("phone.remove")}
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

function ProjectList({ computer, many }: { computer: Computer; many: boolean }) {
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
      </header>
      {live !== "live" && !error && <div className="banner">{t("phone.reconnecting")}</div>}
      {error && <div className="banner bad">{error}</div>}
      <main className="list">
        {projects?.length === 0 && <p className="hint">{t("phone.noProjects")}</p>}
        {projects?.map((p) => (
          <button key={p.id} className="row row-main" onClick={() => go(`/c/${encodeURIComponent(computer.id)}/p/${encodeURIComponent(p.id)}`)}>
            <span className="row-title">{p.name}</span>
            <span className="row-sub">
              {p.sessions > 0 ? t("phone.sessions", { n: p.sessions }) : t("phone.noSessions")}
              {p.paused.length > 0 && <span className="badge">{t("phone.pausedBadge")}</span>}
            </span>
          </button>
        ))}
      </main>
    </div>
  );
}

function Chat({ computer, project }: { computer: Computer; project: string }) {
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
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);
  // 최신 페이지로 바꾼다 (처음, 다시 이어짐, 지움)
  const loadLatest = useCallback(() => {
    const load = view.current.begin();
    api.messages(computer, project).then(
      (r) => {
        if (!view.current.latest(load, r.messages, r.more)) return;
        setName(r.name);
        setError(null);
        changed();
      },
      (e) => {
        view.current.fail(load);
        setError(errorText(e, computer.name));
      },
    );
  }, [computer, project]);
  const nb = useRef(0);
  const loadMembers = useCallback(() => {
    const mine = ++nb.current;
    api.members(computer, project).then((m) => mine === nb.current && setMembers(m), () => {});
  }, [computer, project]);
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
      } else if (kind === "cleared") loadLatest();
      else if (kind === "members" || kind === "waiting") loadMembers();
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
      atBottom.current = true;
      setError(null);
    } catch (e) {
      setError(errorText(e, computer.name));
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

  return (
    <div className="screen chat">
      <header className="bar">
        <button className="bar-back" onClick={() => go(`/c/${encodeURIComponent(computer.id)}`)} aria-label={t("phone.back")}>
          ‹
        </button>
        <h1>{name || "…"}</h1>
      </header>
      {outdated && <div className="banner bad">{t("phone.update", { name: computer.name })}</div>}
      {!outdated && live !== "live" && !error && <div className="banner">{t("phone.reconnecting")}</div>}
      {!outdated && error && <div className="banner bad">{error}</div>}
      {!outdated && (
        <>
          <div
            ref={list}
            className="messages"
            onScroll={(e) => {
              const el = e.currentTarget;
              atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
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
                <div className="text">{m.text}</div>
              </div>
            ))}
          </div>
          {members.paused.map((g) => (
            <div key={g} className="paused">
              <span>{t("chat.paused", { group: g, n: WAKE_LIMIT })}</span>
              <button onClick={() => api.resume(computer, project, g).then(loadMembers, (e) => setError(errorText(e, computer.name)))}>{t("chat.resume")}</button>
            </div>
          ))}
          <div className="chips">
            {members.members
              .filter((m) => m !== USER)
              .map((m) => (
                <button key={m} className={`chip${members.waiting.includes(m) ? " waiting" : ""}`} onClick={() => mention(m)}>
                  {m}
                  {members.waiting.includes(m) && <span className="chip-note">{t("chat.waiting")}</span>}
                </button>
              ))}
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
