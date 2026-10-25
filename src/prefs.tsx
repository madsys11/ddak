import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { DEFAULT_LOCALE, LOCALES, isLocale, translate, type Locale, type MessageKey } from "./i18n";
import { setZoomFactor } from "./zoom";
import { DEFAULT_THEME, THEMES, applyTheme, isThemeId, type ThemeId } from "./themes";

const LOCALE_KEY = "ddak.locale";
const THEME_KEY = "ddak.theme";
const ZOOM_KEY = "ddak.zoom";
const SIDEBAR_KEY = "ddak.sidebar";
const SIDEBAR_WIDTH_KEY = "ddak.sidebarWidth";
const CHAT_WIDTH_KEY = "ddak.chatWidth";

// 파일 트리(사이드바)·채팅 패널의 가로 크기 (px, 화면 배율 전). 끌어서 바꾸고 (src/Resizer.tsx), 더블클릭이나 보기 메뉴
// "패널 크기 초기화"로 기본값. 숨기기는 파일 트리만 (보기 메뉴 "파일 트리 보이기", ⌘B).
export const PANEL_SIZES = {
  sidebar: { default: 260, min: 160, max: 600 },
  chat: { default: 340, min: 240, max: 720 },
} as const;
export type PanelName = keyof typeof PANEL_SIZES;
type Panels = { sidebar: boolean; sidebarWidth: number; chatWidth: number };
const widthKey = (p: PanelName) => (p === "sidebar" ? SIDEBAR_WIDTH_KEY : CHAT_WIDTH_KEY);
const isWidthOf = (p: PanelName) => (v: unknown): v is string =>
  typeof v === "string" && Number.isInteger(Number(v)) && Number(v) >= PANEL_SIZES[p].min && Number(v) <= PANEL_SIZES[p].max;
const isBool = (v: unknown): v is string => v === "true" || v === "false";

// 화면 배율 단계 (브라우저와 비슷하게). 웹뷰 전체를 키우므로 터미널·메뉴·대화상자가 같이 커진다.
// 화면 위 메뉴 막대는 macOS가 그려서 바뀌지 않는다.
export const ZOOM_LEVELS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const isZoom = (v: unknown): v is string => typeof v === "string" && ZOOM_LEVELS.includes(Number(v));
const stepZoom = (zoom: number, delta: number) => {
  const i = ZOOM_LEVELS.indexOf(zoom);
  return ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, (i < 0 ? ZOOM_LEVELS.indexOf(1) : i) + delta))];
};

function load<T>(key: string, valid: (v: unknown) => v is T, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return valid(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 저장 못 해도 이번 실행에서는 쓸 수 있다.
  }
}

type Prefs = {
  locale: Locale;
  theme: ThemeId;
  panels: Panels;
  // 패널 폭을 바꾼다 (min~max로 자른다). null이면 기본값.
  setPanelWidth: (panel: PanelName, width: number | null) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
};

const PrefsContext = createContext<Prefs | null>(null);

export function usePrefs() {
  const prefs = useContext(PrefsContext);
  if (!prefs) throw new Error("PrefsProvider 밖에서 usePrefs 사용");
  return prefs;
}

export const useT = () => usePrefs().t;

// 네이티브 메뉴의 문구와 선택 상태를 Rust로 보낸다 (src-tauri/src/menu.rs).
function syncMenu(locale: Locale, theme: ThemeId, sidebar: boolean) {
  const labels = Object.fromEntries(
    Object.entries(LOCALES[locale].messages)
      .filter(([key]) => key.startsWith("menu."))
      .map(([key, text]) => [key.slice("menu.".length), text]),
  );
  const themes = Object.entries(THEMES).map(([id, th]) => ({ id, label: translate(locale, th.name), checked: id === theme }));
  const locales = Object.entries(LOCALES).map(([id, l]) => ({ id, label: l.name, checked: id === locale }));
  return invoke("set_menu", { spec: { labels, themes, locales, sidebar } });
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(() => load(LOCALE_KEY, isLocale, DEFAULT_LOCALE));
  const [theme, setTheme] = useState(() => load(THEME_KEY, isThemeId, DEFAULT_THEME));
  const [zoom, setZoom] = useState(() => Number(load(ZOOM_KEY, isZoom, "1")));
  const [panels, setPanels] = useState<Panels>(() => ({
    sidebar: load(SIDEBAR_KEY, isBool, "true") === "true",
    sidebarWidth: Number(load(SIDEBAR_WIDTH_KEY, isWidthOf("sidebar"), String(PANEL_SIZES.sidebar.default))),
    chatWidth: Number(load(CHAT_WIDTH_KEY, isWidthOf("chat"), String(PANEL_SIZES.chat.default))),
  }));
  const setPanelWidth = useCallback<Prefs["setPanelWidth"]>((panel, width) => {
    const { default: def, min, max } = PANEL_SIZES[panel];
    const w = width === null ? def : Math.round(Math.min(max, Math.max(min, width)));
    save(widthKey(panel), String(w));
    setPanels((p) => ({ ...p, [panel === "sidebar" ? "sidebarWidth" : "chatWidth"]: w }));
  }, []);
  // 네이티브 체크 항목은 누르면 muda가 체크를 먼저 뒤집는다 (muda macos/mod.rs의 Toggle).
  // 이미 선택된 항목을 다시 누르면 값은 그대로인데 체크만 꺼지므로, 누를 때마다 메뉴를 다시 맞춘다.
  const [menuClicks, setMenuClicks] = useState(0);

  // 그리기 전에 적용해야 첫 화면이 다른 테마로 깜빡이지 않는다.
  useLayoutEffect(() => applyTheme(theme), [theme]);
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    setZoomFactor(zoom);
    getCurrentWebview()
      .setZoom(zoom)
      .catch((e) => console.error("화면 배율 변경 실패", e));
  }, [zoom]);

  useEffect(() => {
    syncMenu(locale, theme, panels.sidebar).catch((e) => console.error("메뉴 갱신 실패", e));
  }, [locale, theme, panels.sidebar, menuClicks]);

  // 보기 메뉴의 테마/언어 항목은 "theme:<id>", "locale:<id>"로, 배율은 "zoom_*"로 온다.
  useEffect(() => {
    const unlisten = listen<string>("menu", ({ payload }) => {
      const [kind, id] = payload.split(":");
      if (kind === "theme" || kind === "locale" || payload === "toggle_sidebar") setMenuClicks((n) => n + 1);
      if (payload === "toggle_sidebar") {
        setPanels((p) => {
          save(SIDEBAR_KEY, String(!p.sidebar));
          return { ...p, sidebar: !p.sidebar };
        });
      } else if (payload === "reset_panels") {
        setPanelWidth("sidebar", null);
        setPanelWidth("chat", null);
      }
      if (payload === "zoom_in" || payload === "zoom_out" || payload === "zoom_reset") {
        setZoom((z) => {
          const next = payload === "zoom_reset" ? 1 : stepZoom(z, payload === "zoom_in" ? 1 : -1);
          save(ZOOM_KEY, String(next));
          return next;
        });
      }
      if (kind === "theme" && isThemeId(id)) {
        save(THEME_KEY, id);
        setTheme(id);
      } else if (kind === "locale" && isLocale(id)) {
        save(LOCALE_KEY, id);
        setLocale(id);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const t = useCallback<Prefs["t"]>((key, vars) => translate(locale, key, vars), [locale]);
  return <PrefsContext.Provider value={{ locale, theme, t, panels, setPanelWidth }}>{children}</PrefsContext.Provider>;
}
