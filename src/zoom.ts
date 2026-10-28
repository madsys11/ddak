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
//
// Windows의 WebView2(Chromium)는 배율(ZoomFactor)을 devicePixelRatio에 이미 넣는다 (실험 2026-10-28: 화면 비율 1.5,
// 배율 1.5에서 2.25). 여기서 또 곱하면 xterm이 아는 칸 폭과 캔버스에 그려지는 칸 폭이 배율만큼 달라져 한글 조합 박스가
// 커서에서 어긋났다. 그래서 Chromium에서는 덮어쓰지 않는다 (xterm의 모니터 감시도 그대로 맞는다).
// Chromium인지는 alignToPixels처럼 devicePixelContentBoxSize로 본다 (WebKit에는 없다).

let factor = 1;

// 웹뷰가 배율을 devicePixelRatio에 넣는지 (Chromium)
export const zoomInPixelRatio = typeof ResizeObserverEntry !== "undefined" && "devicePixelContentBoxSize" in ResizeObserverEntry.prototype;

const real =
  Object.getOwnPropertyDescriptor(window, "devicePixelRatio")?.get ??
  Object.getOwnPropertyDescriptor(Window.prototype, "devicePixelRatio")?.get;

// 배율을 뺀 실제 화면 픽셀 비율 (레티나 2, 일반 모니터 1)
export const screenPixelRatio = (): number => (real ? real.call(window) : 1) / (zoomInPixelRatio ? factor : 1);

if (real && !zoomInPixelRatio) {
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

// 터미널 캔버스를 화면 픽셀에 맞춘다.
// xterm의 WebGL 렌더러는 캔버스의 CSS 크기를 (캔버스 픽셀 ÷ devicePixelRatio)를 반올림한 정수 px로 둔다. 비율이 정수가
// 아니거나(배율) 캔버스 픽셀이 비율로 나누어떨어지지 않으면(칸 수) 화면에 보이는 크기가 캔버스 픽셀 수와 1~2픽셀 달라
// 늘어나서 번진다 (2026-10-28 측정, 레티나: 0.5배만 늘 맞고, 1배는 칸 수가 짝수일 때만, 나머지 배율은 대부분 어긋남).
// Chromium은 ResizeObserver의 devicePixelContentBoxSize로 xterm이 스스로 고치지만 WebKit에는 그 API가 없다.
// 그래서 CSS 크기를 나누어떨어지는 소수 그대로 두고, 화면 픽셀 경계에 오도록 위치도 소수점만큼 옮긴다.
// screen: `.xterm-screen`. 돌려주는 함수로 멈춘다.
export function alignToPixels(screen: HTMLElement): () => void {
  if (zoomInPixelRatio) return () => {};
  let shift = { x: 0, y: 0 };
  let frame = 0;
  const align = () => {
    frame = 0;
    if (!screen.isConnected) return;
    const k = window.devicePixelRatio;
    for (const canvas of screen.querySelectorAll("canvas")) {
      const [w, h] = [canvas.width / k, canvas.height / k];
      if (Math.abs(parseFloat(canvas.style.width) - w) > 0.001) canvas.style.width = `${w}px`;
      if (Math.abs(parseFloat(canvas.style.height) - h) > 0.001) canvas.style.height = `${h}px`;
    }
    // 옮기기 전 위치 (지금 옮겨 둔 만큼 뺀다)
    const r = screen.getBoundingClientRect();
    const [left, top] = [r.left - shift.x, r.top - shift.y];
    const next = { x: (Math.round(left * k) - left * k) / k, y: (Math.round(top * k) - top * k) / k };
    if (Math.abs(next.x - shift.x) > 0.001 || Math.abs(next.y - shift.y) > 0.001) {
      shift = next;
      screen.style.transform = next.x || next.y ? `translate(${next.x}px, ${next.y}px)` : "";
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(align);
  };
  // xterm이 캔버스 크기를 바꿀 때(칸 수·배율), 캔버스를 새로 만들 때, 터미널 자리가 바뀔 때.
  // 여기서 옮긴 screen 자신의 style 변경만 뺀다 (캔버스가 붙는 childList는 target이 screen이어도 받는다, 리뷰 R1)
  const mutations = new MutationObserver((records) => {
    if (records.some((r) => !(r.type === "attributes" && r.target === screen))) schedule();
  });
  mutations.observe(screen, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "width", "height"] });
  const resizes = new ResizeObserver(schedule);
  resizes.observe(screen.parentElement ?? screen);
  window.addEventListener("resize", schedule);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    mutations.disconnect();
    resizes.disconnect();
    window.removeEventListener("resize", schedule);
  };
}
