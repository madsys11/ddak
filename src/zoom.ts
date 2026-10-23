// 화면 배율과 devicePixelRatio.
//
// 웹뷰 배율(setZoom, macOS는 WKWebView pageZoom)은 Chromium과 달리 devicePixelRatio를 바꾸지 않는다
// (실험: 배율 1.1에서도 dpr 그대로, 터미널 캔버스 해상도도 그대로 → 늘어나서 번짐).
// xterm의 WebGL 렌더러는 캔버스 해상도를 devicePixelRatio로 정하므로, 배율을 곱한 값을 돌려주게 한다.
// xterm은 창 resize 이벤트 때 이 값을 다시 읽어 바뀌었으면 다시 그린다
// (@xterm/xterm src/browser/services/CoreBrowserService.ts). 배율을 바꾸면 resize 이벤트가 온다.
//
// xterm은 모니터 변경(레티나 ↔ 일반)을 `resolution: <dpr>dppx` 미디어 쿼리로도 감시하는데, CSS 해상도는
// 덮어쓴 값이 아니라 실제 값을 따른다 (실험: 배율 1.1에서 1dppx만 맞고 1.1dppx는 안 맞음).
// 그래서 xterm의 쿼리는 늘 안 맞아 모니터를 옮겨도 알림이 없다. 실제 값으로 따로 감시하고,
// 바뀌면 resize 이벤트를 보내 xterm이 다시 읽게 한다.

let factor = 1;

const real =
  Object.getOwnPropertyDescriptor(window, "devicePixelRatio")?.get ??
  Object.getOwnPropertyDescriptor(Window.prototype, "devicePixelRatio")?.get;

// 배율을 뺀 실제 화면 픽셀 비율 (레티나 2, 일반 모니터 1)
export const screenPixelRatio = (): number => (real ? real.call(window) : 1);

if (real) {
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => screenPixelRatio() * factor });
  watchScreen();
}

// 지금 화면 비율에 맞는 쿼리를 걸고, 안 맞게 되면(다른 모니터로 옮김) 알린 뒤 새 값으로 다시 건다.
function watchScreen() {
  const query = matchMedia(`screen and (resolution: ${screenPixelRatio()}dppx)`);
  query.addEventListener(
    "change",
    () => {
      window.dispatchEvent(new Event("resize"));
      watchScreen();
    },
    { once: true },
  );
}

// 웹뷰 배율을 바꾸기 직전에 부른다. 배율 변경이 일으키는 resize 때 xterm이 새 값을 읽도록.
export function setZoomFactor(zoom: number) {
  factor = zoom;
}
