// 폰 화면의 서비스 워커 (src/mobile/push.ts). 푸시를 받아 알림으로 보이고, 누르면 그 채팅을 연다. 오프라인 캐시는 두지 않는다.
// 푸시 내용 (src-tauri/src/mobile.rs notify): { title, body, kind: message·paused·attention, computer, project }

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// 채팅 화면의 주소 (src/mobile/MobileApp.tsx parse)
const chatPath = (d) => `#/c/${encodeURIComponent(d.computer)}/p/${encodeURIComponent(d.project)}`;

// 이 화면의 창만 (같은 출처의 다른 Pages 앱 창은 빼고. 리뷰 R1)
const ours = () => self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => wins.filter((w) => w.url.startsWith(self.registration.scope)));

// 알림은 늘 띄운다: 화면이 그 채팅을 보이고 있어도 메시지를 실제로 받았는지 모르고 (SSE만 끊겼을 수 있다), iOS는 알림 없는
// 푸시를 받으면 구독을 없앤다 (리뷰 R2). 그 채팅이 보이면 소리 없이 띄우고 창에 알린다 (종류와 알림 id): 창은 그 종류가 알린 것을
// 맥에서 실제로 읽어 보인 뒤에만 그 알림을 닫는다.
self.addEventListener("push", (e) => {
  let d;
  try {
    d = e.data.json();
  } catch {
    return;
  }
  const path = chatPath(d);
  const tag = `${d.computer}/${d.project}`;
  const id = self.crypto.randomUUID();
  e.waitUntil(
    ours().then(async (wins) => {
      const viewing = wins.filter((w) => w.visibilityState === "visible" && new URL(w.url).hash === path);
      await self.registration.showNotification(d.title, { body: d.body, tag, renotify: viewing.length === 0, silent: viewing.length > 0, icon: "icon-192.png", data: { path, id } });
      for (const w of viewing) w.postMessage({ type: "shown", tag, kind: d.kind, id });
    }),
  );
});

// 열린 화면이 있으면 그 화면을 앞으로 가져와 채팅으로 옮기고 (main.tsx가 받는다), 없으면 새로 연다
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const path = e.notification.data?.path ?? "";
  e.waitUntil(
    ours().then((wins) => {
      const w = wins[0];
      if (!w) return self.clients.openWindow(new URL(path, self.registration.scope).href);
      w.postMessage({ type: "open", path });
      return w.focus();
    }),
  );
});
