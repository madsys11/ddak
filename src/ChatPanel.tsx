import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { devHooks } from "./devHooks";
import { draggedPath, isPathDrag } from "./dragPath";
import { PANEL_SIZES, usePrefs } from "./prefs";
import { Resizer } from "./Resizer";

// src-tauri/src/chat.rs Message
// held: 자동 깨우기 제한에 걸려 받는 사람을 깨우지 않음. via: 사용자가 폰에서 보냈으면 그 기기 이름 (mobile.rs)
export type ChatMessage = { id: number; time: number; from: string; text: string; to: string[]; held?: boolean; via?: string };

// src-tauri/src/chat.rs WAKE_LIMIT
const WAKE_LIMIT = 6;

const USER = "user";

// 프로젝트 채팅방 (docs/spec.md "채팅방 설계"): 오른쪽 패널. 사용자(user)로 읽고 쓴다.
// 닫혀 있어도 떠 있으면서 새 메시지를 받고, 닫혀 있는 동안 세션이 사용자에게 보낸 메시지 수를 onUnread로 알린다
// (채팅 버튼의 점, 사이드바 프로젝트 배지, Dock 배지).
// 메시지·참여자가 바뀌면 Rust가 이벤트("chat", "chat-members")를 보내고, 받으면 이 프로젝트 것을 다시 읽는다
// (이벤트의 프로젝트는 실제 경로라 여기의 경로와 다를 수 있어서 비교하지 않는다). 이벤트를 먼저 등록하고 처음 상태를
// 읽는다 (리뷰 P2: 읽은 뒤 등록하기 전에 온 메시지를 놓쳤다). 읽기가 겹치면 마지막 요청의 결과만 쓴다.
// watching: 사용자가 실제로 보고 있다 (패널이 열려 있고, 이 프로젝트가 보이고, 창이 앞에 있음). 그때만 읽은 것으로 친다
// (리뷰 R2: 열어 둔 채 다른 프로젝트로 가면 숨은 패널이 메시지를 읽은 것으로 처리해 배지가 빠졌다).
export function ChatPanel({ project, open, watching, onClose, onUnread }: {
  project: string;
  open: boolean;
  watching: boolean;
  onClose: () => void;
  onUnread: (unread: number) => void;
}) {
  const { t, locale, panels, setPanelWidth } = usePrefs();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  // 깨우기를 기다리는 참여자 (터미널 이름 줄의 배지와 같은 상태. 채팅을 보는 동안에도 보이게)
  const [waiting, setWaiting] = useState<string[]>([]);
  // 자동 깨우기가 멈춘 작업그룹 (세션끼리 WAKE_LIMIT개를 주고받음). 사용자가 그 그룹에 쓰거나 재개하면 풀린다.
  const [paused, setPaused] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 이벤트를 등록하지 못함: 새 메시지를 스스로 다시 읽지 못한다
  const [listenError, setListenError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // 마지막으로 본 메시지 번호 (열려 있을 때 본 것)
  const seen = useRef(0);
  const latest = useRef({ watching, onUnread });
  latest.current = { watching, onUnread };

  useEffect(() => {
    let alive = true;
    const dev = import.meta.env.DEV;
    let n = 0;
    const loadMessages = () => {
      if (dev) devHooks.chatLoads = { ...devHooks.chatLoads, [project]: (devHooks.chatLoads?.[project] ?? 0) + 1 };
      const mine = ++n;
      invoke<ChatMessage[]>("chat_messages", { project }).then(
        (m) => {
          if (!alive || mine !== n) return;
          setMessages(m);
          setError(null);
          const last = m.at(-1)?.id ?? 0;
          if (latest.current.watching) seen.current = last;
          else latest.current.onUnread(m.filter((x) => x.id > seen.current && x.from !== USER && x.to.includes(USER)).length);
        },
        (e) => alive && mine === n && setError(String(e)),
      );
    };
    // 참여자도 마지막 요청만 (리뷰 P2: 늦게 온 이전 응답이 나간 참여자를 되살렸다)
    let nm = 0;
    const loadMembers = () => {
      const mine = ++nm;
      const delay = dev ? (devHooks.chatMembersDelay?.() ?? 0) : 0;
      invoke<string[]>("chat_members", { project })
        .then(async (m) => {
          if (delay) await new Promise((r) => setTimeout(r, delay));
          return m;
        })
        .then((m) => alive && mine === nm && setMembers(m), () => {});
    };
    // 대기도 마지막 요청만. "chat-wake"(대기가 바뀜)와 "chat-members"(나가면 대기도 빠짐) 때 다시 읽는다.
    let nw = 0;
    const loadWaiting = () => {
      const mine = ++nw;
      invoke<string[]>("chat_waiting", { project }).then((w) => alive && mine === nw && setWaiting(w), () => {});
    };
    let np = 0;
    const loadPaused = () => {
      const mine = ++np;
      const extra = dev ? (devHooks.chatPausedExtra ?? []) : [];
      invoke<string[]>("chat_paused", { project }).then((g) => alive && mine === np && setPaused([...g, ...extra]), () => {});
    };
    const onMembers = () => {
      loadMembers();
      loadWaiting();
    };
    const offs: (() => void)[] = [];
    (async () => {
      const delay = dev ? (devHooks.chatListenDelay ?? 0) : 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      // 등록마다 성공하는 즉시 해제를 맡는다 (이미 정리됐으면 바로 푼다). 하나라도 실패하면 성공한 것도 풀고 알린다
      // (리뷰 후속 P2: Promise.all이 실패하면 성공한 등록이 남고 처음 읽기도 하지 않았다). 처음 읽기는 그래도 한다.
      const register = (name: string, f: () => void) =>
        (dev && devHooks.chatListenFail === name ? Promise.reject(new Error(`${name}: injected failure`)) : listen(name, f)).then((off) => {
          if (alive) offs.push(off);
          else off();
        });
      const results = await Promise.allSettled([register("chat", loadMessages), register("chat-members", onMembers), register("chat-wake", loadWaiting), register("chat-limit", loadPaused)]);
      if (!alive) return;
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) {
        offs.splice(0).forEach((f) => f());
        setListenError(String(failed.reason));
      }
      loadMessages();
      loadMembers();
      loadWaiting();
      loadPaused();
    })();
    return () => {
      alive = false;
      offs.forEach((f) => f());
    };
  }, [project]);

  // 열면 입력란으로
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  // 보게 되면 (열기, 이 프로젝트로 돌아오기, 창이 앞으로) 다 본 것으로
  useEffect(() => {
    if (!watching) return;
    seen.current = messages.at(-1)?.id ?? 0;
    onUnread(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching]);

  // 맨 아래를 보고 있었으면 새 메시지를 따라 내려간다
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = list.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  async function send() {
    const sent = draft;
    const text = sent.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const delay = import.meta.env.DEV ? (devHooks.chatPostDelay ?? 0) : 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      await invoke("chat_post", { project, text });
      // 보내는 동안 새로 쓴 것은 남긴다 (리뷰 P2: 응답이 오면서 다음 초안을 지웠다)
      setDraft((d) => (d === sent ? "" : d));
      atBottom.current = true;
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }

  // 대화를 모두 지운다 (확인을 받고. 지운 내용은 앱 데이터에 남는다, src-tauri/src/chat.rs clear). 목록은 "chat" 이벤트로 바뀐다.
  async function clear() {
    const ok = await devHooks.confirm(t("chat.clearConfirm"), { okLabel: t("chat.clearOk"), cancelLabel: t("common.cancel") });
    if (ok) invoke("chat_clear", { project }).catch((e) => setError(String(e)));
  }

  const mention = (name: string) => {
    setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}@${name} `);
    input.current?.focus();
  };
  // 앱 언어로 (시스템 언어가 아니라)
  const time = (ms: number) => new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  return (
    <aside className="chat-panel" style={{ width: panels.chatWidth, display: open ? undefined : "none" }}>
      <Resizer edge="left" width={panels.chatWidth} {...PANEL_SIZES.chat} onWidth={(w) => setPanelWidth("chat", w)} onReset={() => setPanelWidth("chat", null)} />
      <div className="chat-head">
        <span className="chat-title">{t("chat.title")}</span>
        <button className="chat-clear" data-action="chat-clear" title={t("chat.clear")} disabled={messages.length === 0} onClick={clear}>
          {t("chat.clear")}
        </button>
        <button className="chat-close" title={t("chat.close")} onClick={onClose}>
          ×
        </button>
      </div>
      <div
        ref={list}
        className="chat-list"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        }}
      >
        {messages.length === 0 && !error && <div className="chat-none">{t("chat.empty")}</div>}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg${m.from === USER ? " mine" : ""}${m.to.includes(USER) ? " to-me" : ""}`} data-id={m.id}>
            <div className="chat-meta">
              <span className="chat-from">{m.from === USER ? t("chat.you") : m.from}</span>
              {m.via && (
                <span className="chat-via" data-via={m.via}>
                  {t("chat.via", { device: m.via })}
                </span>
              )}
              {m.to.length > 0 && <span className="chat-to">→ {m.to.map((x) => (x === USER ? t("chat.you") : x)).join(", ")}</span>}
              {m.held && (
                <span className="chat-held" data-held title={t("chat.heldHint")}>
                  {t("chat.held")}
                </span>
              )}
              <time>{time(m.time)}</time>
            </div>
            <div className="chat-text">{m.text}</div>
          </div>
        ))}
      </div>
      {/* 멈춘 작업그룹이 많아도 입력란을 밀어내지 않게 높이를 정한 스크롤 영역에 둔다 (리뷰 2단계 R2) */}
      {paused.length > 0 && (
        <div className="chat-paused-list">
          {paused.map((g) => (
            <div key={g} className="chat-paused" data-paused={g}>
              <span>{t("chat.paused", { group: g, n: WAKE_LIMIT })}</span>
              <button onClick={() => invoke("chat_resume", { project, group: g }).catch((e) => setError(String(e)))}>{t("chat.resume")}</button>
            </div>
          ))}
        </div>
      )}
      {error && <div className="chat-error">{error}</div>}
      {listenError && <div className="chat-error" data-listen-error>{t("chat.listenError", { detail: listenError })}</div>}
      {/* 참여자 칩은 입력란 바로 위에 둔다 (누르면 멘션을 넣으므로 쓰는 곳 가까이) */}
      <div className="chat-members" title={t("chat.membersHint")}>
        {members
          .filter((m) => m !== USER)
          .map((m) => (
            <span key={m} className="chat-member-wrap">
              <button className={`chat-member${waiting.includes(m) ? " waiting" : ""}`} data-member={m} onClick={() => mention(m)}>
                {m}
              </button>
              {waiting.includes(m) && (
                <button className="chat-member-wake" data-waiting={m} title={t("chat.wakeHint")} onClick={() => invoke("chat_wake_member", { project, name: m }).catch(() => {})}>
                  {t("chat.waiting")}
                </button>
              )}
            </span>
          ))}
        {members.length <= 1 && <span className="chat-none">{t("chat.noMembers")}</span>}
      </div>
      <textarea
        ref={input}
        className="chat-input"
        rows={3}
        value={draft}
        placeholder={t("chat.placeholder")}
        onChange={(e) => setDraft(e.target.value)}
        // 파일 트리에서 끌어다 놓으면 트리 루트 기준 상대 경로를 커서 자리에 넣는다 (루트 밖이면 절대 경로)
        onDragOver={(e) => {
          if (!isPathDrag(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          const dropped = draggedPath(e.dataTransfer);
          if (!dropped) return;
          e.preventDefault();
          const el = e.currentTarget;
          const [start, end] = [el.selectionStart, el.selectionEnd];
          const text = `${dropped.rel ?? dropped.path} `;
          setDraft((d) => d.slice(0, start) + text + d.slice(end));
          el.focus();
          requestAnimationFrame(() => el.setSelectionRange(start + text.length, start + text.length));
        }}
        onKeyDown={(e) => {
          // 한글 조합을 확정하는 Enter는 보내지 않는다
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
    </aside>
  );
}
