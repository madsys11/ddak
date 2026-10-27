// 폰 화면 → 각 맥의 모바일 서버 (src-tauri/src/mobile.rs). 맥마다 tailnet 주소와 기기 토큰을 폰 저장소에 둔다.
// 토큰은 Authorization 헤더로만 보낸다 (URL에 싣지 않는다). SSE도 EventSource 대신 fetch 스트림으로 받는다.

// 이 화면이 아는 API 버전 (mobile.rs API_VERSION)
export const API_VERSION = 1;

export type Computer = { id: string; name: string; api: string; token: string };

import type { Answer, Prompt } from "../PromptChoices";

// src-tauri/src/chat.rs Message (prompt: 세션이 띄운 선택 창, answer: 그 답의 기록. 예전 ddak에는 없다)
export type Message = { id: number; time: number; from: string; text: string; to: string[]; held?: boolean; via?: string; prompt?: Prompt; answer?: Answer };
// awaiting: 사용자를 기다리는 세션 수 (예전 ddak에는 없다)
// open: 맥에서 열려 있는지 (아니면 세션이 없다), unread: 사용자에게 온 안 읽은 메시지 수 (예전 ddak에는 없다)
export type Project = { id: string; name: string; sessions: number; awaiting?: number; paused: string[]; open?: boolean; unread?: number };
// status: 참여자마다 "working"이나 기다리는 종류 (permission·question·auth·dialog·blocked). 없으면 쉬는 중
// prompts: 맥에 열려 있는 선택 창 id (예전 ddak에는 없다)
export type Members = { members: string[]; waiting: string[]; status?: Record<string, string>; paused: string[]; prompts?: string[]; open?: boolean };
// 맥이 가진 이 폰의 푸시 구독 주소와, 푸시 서비스가 없앴다고 답한 주소 (푸시를 모르는 ddak에는 없다)
export type PushInfo = { endpoint: string | null; gone: string | null };
export type Info = { id: string; name: string; version: string; api: number; push?: PushInfo };
// src-tauri/src/push.rs Subscription
export type PushBody = { endpoint: string; p256dh: string; auth: string; publicKey: string; privateKey: string };

const KEY = "ddak.computers";

export function loadComputers(): Computer[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((c) => c && typeof c.api === "string" && typeof c.token === "string") : [];
  } catch {
    return [];
  }
}

export function saveComputers(list: Computer[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // 저장하지 못하면 이번 실행에서만 쓴다
  }
}

// status 0: 닿지 않음 (꺼짐, Tailscale 끊김)
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

// 요청 기한: 닿지 않는 맥 하나가 다른 맥의 일(알림 구독 맞추기 등)을 붙잡지 않게 (리뷰 R3)
const TIMEOUT_MS = 15_000;

async function request<T>(api: string, path: string, token: string | null, body?: unknown, method?: "DELETE"): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let r: Response;
  try {
    r = await fetch(api + path, { method: method ?? (body === undefined ? "GET" : "POST"), headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new ApiError(0, "unreachable");
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(r.status, (data && typeof data.error === "string" && data.error) || "error");
  return data as T;
}

export const api = {
  info: (c: Computer) => request<Info>(c.api, "/api/info", c.token),
  projects: (c: Computer) => request<{ projects: Project[] }>(c.api, "/api/projects", c.token).then((r) => r.projects),
  messages: (c: Computer, project: string, before?: number) =>
    request<{ name: string; messages: Message[]; more: boolean }>(c.api, `/api/projects/${encodeURIComponent(project)}/messages?limit=50${before ? `&before=${before}` : ""}`, c.token),
  members: (c: Computer, project: string) => request<Members>(c.api, `/api/projects/${encodeURIComponent(project)}/members`, c.token),
  post: (c: Computer, project: string, text: string) => request<Message>(c.api, `/api/projects/${encodeURIComponent(project)}/messages`, c.token, { text }),
  // 선택 창에 답한다 (넣은 결과는 채팅의 답 기록으로 온다)
  answer: (c: Computer, project: string, prompt: string, option: number) => request<unknown>(c.api, `/api/projects/${encodeURIComponent(project)}/answer`, c.token, { prompt, option }),
  // 맥에서 연다 ("맥에서 열기"), 여기까지 읽었다
  open: (c: Computer, project: string) => request<unknown>(c.api, `/api/projects/${encodeURIComponent(project)}/open`, c.token, {}),
  read: (c: Computer, project: string, id: number) => request<unknown>(c.api, `/api/projects/${encodeURIComponent(project)}/read`, c.token, { id }),
  resume: (c: Computer, project: string, group: string) => request<unknown>(c.api, `/api/projects/${encodeURIComponent(project)}/resume`, c.token, { group }),
  setPush: (c: Computer, body: PushBody) => request<unknown>(c.api, "/api/push", c.token, body),
  deletePush: (c: Computer) => request<unknown>(c.api, "/api/push", c.token, undefined, "DELETE"),
};

// 페어링: 맥의 "모바일 연결…" 창에 뜬 주소와 코드 → 이 폰의 기기 토큰
export async function pair(address: string, code: string): Promise<Computer> {
  const apiUrl = normalizeAddress(address);
  const device = deviceName();
  const r = await request<{ token: string; id: string; name: string }>(apiUrl, "/api/pair", null, { code: code.trim(), device });
  return { id: r.id, name: r.name, api: apiUrl, token: r.token };
}

// "mac.tail0.ts.net", "https://mac.tail0.ts.net/" → "https://mac.tail0.ts.net"
export function normalizeAddress(address: string) {
  const a = address.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(a) ? a : `https://${a}`;
}

// 맥의 기기 목록에 보일 이름 (브라우저가 알려 주는 것만)
function deviceName() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : "Browser";
  const browser = /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "";
  return [os, browser].filter(Boolean).join(" ");
}

// SSE를 fetch 스트림으로 받는다. 스트림이 끝나거나 끊기면 돌아온다 (다시 잇는 것은 부르는 쪽).
export async function events(c: Computer, onEvent: (kind: string, data: Record<string, unknown>) => void, signal: AbortSignal) {
  let r: Response;
  try {
    r = await fetch(`${c.api}/api/events`, { headers: { Authorization: `Bearer ${c.token}` }, cache: "no-store", signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "unreachable");
  }
  if (!r.ok || !r.body) {
    const data = await r.json().catch(() => null);
    throw new ApiError(r.status, (data && data.error) || "error");
  }
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const kind = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!kind) continue;
      try {
        onEvent(kind, data ? JSON.parse(data) : {});
      } catch {
        // 깨진 이벤트는 건너뛴다
      }
    }
  }
}
