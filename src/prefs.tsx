import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEFAULT_LOCALE, LOCALES, isLocale, translate, type Locale, type MessageKey } from "./i18n";
import { DEFAULT_THEME, THEMES, applyTheme, isThemeId, type ThemeId } from "./themes";

const LOCALE_KEY = "ddak.locale";
const THEME_KEY = "ddak.theme";

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
function syncMenu(locale: Locale, theme: ThemeId) {
  const labels = Object.fromEntries(
    Object.entries(LOCALES[locale].messages)
      .filter(([key]) => key.startsWith("menu."))
      .map(([key, text]) => [key.slice("menu.".length), text]),
  );
  const themes = Object.entries(THEMES).map(([id, th]) => ({ id, label: translate(locale, th.name), checked: id === theme }));
  const locales = Object.entries(LOCALES).map(([id, l]) => ({ id, label: l.name, checked: id === locale }));
  return invoke("set_menu", { spec: { labels, themes, locales } });
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(() => load(LOCALE_KEY, isLocale, DEFAULT_LOCALE));
  const [theme, setTheme] = useState(() => load(THEME_KEY, isThemeId, DEFAULT_THEME));
  // 네이티브 체크 항목은 누르면 muda가 체크를 먼저 뒤집는다 (muda macos/mod.rs의 Toggle).
  // 이미 선택된 항목을 다시 누르면 값은 그대로인데 체크만 꺼지므로, 누를 때마다 메뉴를 다시 맞춘다.
  const [menuClicks, setMenuClicks] = useState(0);

  // 그리기 전에 적용해야 첫 화면이 다른 테마로 깜빡이지 않는다.
  useLayoutEffect(() => applyTheme(theme), [theme]);
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    syncMenu(locale, theme).catch((e) => console.error("메뉴 갱신 실패", e));
  }, [locale, theme, menuClicks]);

  // 보기 메뉴의 테마/언어 항목은 "theme:<id>", "locale:<id>"로 온다.
  useEffect(() => {
    const unlisten = listen<string>("menu", ({ payload }) => {
      const [kind, id] = payload.split(":");
      if (kind === "theme" || kind === "locale") setMenuClicks((n) => n + 1);
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
  return <PrefsContext.Provider value={{ locale, theme, t }}>{children}</PrefsContext.Provider>;
}
