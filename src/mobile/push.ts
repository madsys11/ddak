import { api, type Computer, type Info, type Members, type PushBody, type PushInfo } from "./api";

// 폰의 푸시 알림 (docs/mobile-plan.md "여러 컴퓨터: 푸시 알림", "2단계 세부").
// - VAPID 키 쌍은 이 폰이 만들어 폰 저장소에 두고, 구독과 함께 페어링한 맥마다 넘긴다 (맥이 같은 키로 보낸다).
// - 알림 권한이 있으면 저절로 구독하고, 맥이 가진 구독이 이 폰의 것과 다르면 다시 보낸다. 권한은 사용자가 눌러야 받는다
//   (PWA를 설치하면 탭에서 받은 권한이 없어진다, M0).
// - 푸시 서비스가 구독을 없앴으면 (맥이 gone으로 알려 줌) 키를 바꿔 새로 구독한다. 폰에서 컴퓨터를 빼도 키를 바꾼다:
//   뺀 맥에 남은 사본으로는 더 보낼 수 없다.

const KEY = "ddak.push";
type Keys = { publicKey: string; privateKey: string };

export type PushState = "unsupported" | "denied" | "off" | "on";

const b64u = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

// 알림 권한 상태 (구독이 실제로 있는지는 sync가 맞춘다)
export function pushState(): PushState {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" ? "on" : "off";
}

function loadKeys(): Keys | null {
  try {
    const k = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return k && typeof k.publicKey === "string" && typeof k.privateKey === "string" ? k : null;
  } catch {
    return null;
  }
}

async function newKeys(): Promise<Keys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const keys = { publicKey: b64u(raw), privateKey: jwk.d! };
  localStorage.setItem(KEY, JSON.stringify(keys));
  return keys;
}

// 서비스 워커 (main.tsx가 등록한다. 등록하지 못한 곳에서는 null)
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
}

// 이 폰의 키로 만든 지금 구독
async function current(reg: ServiceWorkerRegistration): Promise<PushSubscription | null> {
  const sub = await reg.pushManager.getSubscription();
  const keys = loadKeys();
  const key = sub?.options.applicationServerKey;
  return sub && keys && key && b64u(key) === keys.publicKey ? sub : null;
}

// 구독한다. renew면 키를 바꿔 새로 (예전 구독은 해지). 권한이 있어야 한다.
async function subscribe(reg: ServiceWorkerRegistration, renew: boolean): Promise<PushSubscription> {
  if (!renew) {
    const sub = await current(reg);
    if (sub) return sub;
  }
  await (await reg.pushManager.getSubscription())?.unsubscribe();
  const keys = renew ? await newKeys() : (loadKeys() ?? (await newKeys()));
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(keys.publicKey) });
}

function body(sub: PushSubscription): PushBody {
  const keys = loadKeys()!;
  const j = sub.toJSON();
  return { endpoint: sub.endpoint, p256dh: j.keys?.p256dh ?? "", auth: j.keys?.auth ?? "", publicKey: keys.publicKey, privateKey: keys.privateKey };
}

// 한 맥에 무엇을 할지: 맥이 가진 구독(push)과 이 폰의 구독(mine) 비교.
// none: 맞음 (또는 푸시를 모르는 ddak), send: 이 구독을 보냄, renew: 이 구독은 푸시 서비스에서 없어짐 → 새로 구독
export function plan(mine: string | null, push: PushInfo | undefined): "none" | "send" | "renew" {
  if (!push || !mine) return "none";
  if (push.gone === mine) return "renew";
  return push.endpoint === mine ? "none" : "send";
}

// 맥마다 따로 맞춘다: 답한 맥부터 보내고 다른 맥을 기다리지 않는다 (리뷰 R3, 요청마다 기한은 api.ts).
// 어느 맥이 이 구독이 없어졌다고 하면 한 번만 새로 구독해 모든 맥에 보낸다. 그 뒤에 답한 맥은 그 일에 맡긴다.
export type ReconcileDeps<S extends { endpoint: string }> = {
  info: (c: Computer) => Promise<Info | null>;
  send: (c: Computer, sub: S) => Promise<unknown>;
  renew: () => Promise<S>;
};
export async function reconcile<S extends { endpoint: string }>(computers: Computer[], mine: S, deps: ReconcileDeps<S>) {
  // 맥마다 쓰기는 차례로: 먼저 보낸 예전 구독이 늦게 끝나 새 구독을 덮지 않게 (리뷰 R6)
  const writes = new Map<string, Promise<unknown>>();
  const write = (c: Computer, sub: S) => {
    const next = (writes.get(c.id) ?? Promise.resolve()).then(() => deps.send(c, sub)).catch(() => {});
    writes.set(c.id, next);
    return next;
  };
  let renewing: Promise<unknown> | null = null;
  const renewAll = () => (renewing ??= deps.renew().then((sub) => Promise.all(computers.map((c) => write(c, sub)))));
  await Promise.all(
    computers.map(async (c) => {
      const info = await deps.info(c).catch(() => null);
      if (renewing) return;
      const p = plan(mine.endpoint, info?.push);
      if (p === "send") await write(c, mine);
      else if (p === "renew") await renewAll();
    }),
  );
  await renewing;
}

// 구독을 맞춘다: 권한이 있으면 구독을 만들고, 맥마다 비교해 보내고, 없어진 구독이면 키를 바꿔 모두에 보낸다.
// renew: 키를 바꿔 모두에 보낸다. infos: 이미 읽은 맥 정보 (없으면 읽는다).
// 구독을 동시에 바꾸지 않게 한 줄로 세운다 (요청마다 기한이 있어 앞의 것이 오래 붙잡지 않는다).
let running: Promise<void> = Promise.resolve();
export function syncPush(computers: Computer[], infos: Record<string, Info> = {}, renew = false): Promise<void> {
  running = running.catch(() => {}).then(() => syncOnce(computers, infos, renew));
  return running;
}

async function syncOnce(computers: Computer[], infos: Record<string, Info>, renew: boolean) {
  if (pushState() !== "on") return;
  const reg = await registration();
  if (!reg) return;
  const sub = await subscribe(reg, renew);
  const send = (c: Computer, s: PushSubscription) => api.setPush(c, body(s));
  // 닿지 않는 맥은 다음에 열 때 다시 맞춘다 (맥이 가진 것이 다르므로 send)
  if (renew) await Promise.all(computers.map((c) => send(c, sub).catch(() => {})));
  else await reconcile(computers, sub, { info: (c) => (infos[c.id] ? Promise.resolve(infos[c.id]) : api.info(c)), send, renew: () => subscribe(reg, true) });
}

// 사용자가 "켜기"를 눌렀다: 권한을 받고 맞춘다
export async function enablePush(computers: Computer[]): Promise<PushState> {
  if (!supported()) return "unsupported";
  await Notification.requestPermission();
  await syncPush(computers);
  return pushState();
}

// 알림 키를 바꾸지 못한 까닭 (뺀 맥이 예전 구독으로 보낼 수 있다). 컴퓨터를 빼면 화면이 바뀌므로 (한 대가 되면 프로젝트
// 목록으로, 없으면 추가 화면으로) 화면이 아니라 여기에 둔다 (재리뷰 R3). 화면은 onKeyProblem으로 따라간다.
let problem: string | null = null;
const listeners = new Set<() => void>();
export const keyProblem = () => problem;
export function onKeyProblem(f: () => void) {
  listeners.add(f);
  return () => void listeners.delete(f);
}
function setProblem(p: string | null) {
  problem = p;
  listeners.forEach((f) => f());
}

const rotate = (rest: Computer[]) => (pushState() === "on" ? syncPush(rest, {}, true) : Promise.resolve());

// 키를 바꿔 (예전 구독은 해지) rest에 보낸다. 실패하면 keyProblem에 남기고, 성공하면 지운다.
export async function changeKey(rest: Computer[], run: (rest: Computer[]) => Promise<void> = rotate) {
  try {
    await run(rest);
    setProblem(null);
  } catch (e) {
    setProblem(e instanceof Error ? e.message : String(e));
  }
}

// 폰에서 컴퓨터를 뺐다: 키를 바꿔 남은 맥에 보낸다. 뺀 맥의 사본은 지우라고만 하고 기다리지 않는다: 꺼져 있어도 예전 구독이
// 없어졌으니 그 사본으로는 보낼 수 없다 (리뷰 R3).
export async function removeComputer(removed: Computer, rest: Computer[], run?: (rest: Computer[]) => Promise<void>) {
  api.deletePush(removed).catch(() => {});
  await changeKey(rest, run);
}

// 보고 있는 채팅에 온 알림을 닫아도 되는지: 그 알림이 알린 것을 화면이 맥에서 다시 읽어 보이고 있을 때만 (재리뷰 R2).
// message: 최신 메시지를 다시 읽음, paused: 멈춘 작업그룹이 보임, attention: 사용자를 기다리는 참여자가 보임
export function confirmed(kind: string, latest: boolean, members: Members | null) {
  if (kind === "message") return latest;
  if (kind === "paused") return !!members && members.paused.length > 0;
  if (kind === "attention") return !!members && Object.values(members.status ?? {}).some((s) => s !== "working");
  return false;
}
