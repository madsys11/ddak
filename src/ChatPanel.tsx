import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { devHooks } from "./devHooks";
import { usePrefs } from "./prefs";

// src-tauri/src/chat.rs Message
export type ChatMessage = { id: number; time: number; from: string; text: string; to: string[] };

const USER = "user";

// 프로젝트 채팅방 (docs/spec.md "채팅방 설계"): 오른쪽 패널. 사용자(user)로 읽고 쓴다.
// 닫혀 있어도 떠 있으면서 새 메시지를 받고, 닫혀 있는 동안 사용자를 멘션한 메시지가 오면 onUnread(true)로 알린다.
// 메시지·참여자가 바뀌면 Rust가 이벤트("chat", "chat-members")를 보내고, 받으면 이 프로젝트 것을 다시 읽는다
// (이벤트의 프로젝트는 실제 경로라 여기의 경로와 다를 수 있어서 비교하지 않는다). 이벤트를 먼저 등록하고 처음 상태를
// 읽는다 (리뷰 P2: 읽은 뒤 등록하기 전에 온 메시지를 놓쳤다). 읽기가 겹치면 마지막 요청의 결과만 쓴다.
export function ChatPanel({ project, open, onClose, onUnread }: {
  project: string;
  open: boolean;
  onClose: () => void;
  onUnread: (unread: boolean) => void;
}) {
  const { t, locale } = usePrefs();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 이벤트를 등록하지 못함: 새 메시지를 스스로 다시 읽지 못한다
  const [listenError, setListenError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // 마지막으로 본 메시지 번호 (열려 있을 때 본 것)
  const seen = useRef(0);
  const latest = useRef({ open, onUnread });
  latest.current = { open, onUnread };

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
          if (latest.current.open) seen.current = last;
          else if (m.some((x) => x.id > seen.current && x.to.includes(USER))) latest.current.onUnread(true);
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
      const results = await Promise.allSettled([register("chat", loadMessages), register("chat-members", loadMembers)]);
      if (!alive) return;
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) {
        offs.splice(0).forEach((f) => f());
        setListenError(String(failed.reason));
      }
      loadMessages();
      loadMembers();
    })();
    return () => {
      alive = false;
      offs.forEach((f) => f());
    };
  }, [project]);

  // 열면 다 본 것으로 하고 입력란으로
  useEffect(() => {
    if (!open) return;
    seen.current = messages.at(-1)?.id ?? 0;
    onUnread(false);
    input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  const mention = (name: string) => {
    setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}@${name} `);
    input.current?.focus();
  };
  // 앱 언어로 (시스템 언어가 아니라)
  const time = (ms: number) => new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  return (
    <aside className="chat-panel" style={{ display: open ? undefined : "none" }}>
      <div className="chat-head">
        <span className="chat-title">{t("chat.title")}</span>
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
              {m.to.length > 0 && <span className="chat-to">→ {m.to.map((x) => (x === USER ? t("chat.you") : x)).join(", ")}</span>}
              <time>{time(m.time)}</time>
            </div>
            <div className="chat-text">{m.text}</div>
          </div>
        ))}
      </div>
      {error && <div className="chat-error">{error}</div>}
      {listenError && <div className="chat-error" data-listen-error>{t("chat.listenError", { detail: listenError })}</div>}
      {/* 참여자 칩은 입력란 바로 위에 둔다 (누르면 멘션을 넣으므로 쓰는 곳 가까이) */}
      <div className="chat-members" title={t("chat.membersHint")}>
        {members
          .filter((m) => m !== USER)
          .map((m) => (
            <button key={m} className="chat-member" data-member={m} onClick={() => mention(m)}>
              {m}
            </button>
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
