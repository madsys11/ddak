import { isLocale, type Locale } from "../i18n";
import { applyTheme, isThemeId, type ThemeId } from "../themes";

// 폰 화면 설정 (설정 화면, docs/spec.md "모바일 연결"): 테마·언어는 "폰 설정 따라"(auto)가 기본, 글자 크기는 배율.
// 폰 저장소(localStorage)에 둔다. 저장소를 못 쓰거나 값이 이상하면 기본값.
export type PhoneSettings = { theme: "auto" | ThemeId; locale: "auto" | Locale; fontScale: number };

export const FONT_SCALES = [0.85, 1, 1.15, 1.3, 1.5];
export const DEFAULT_SETTINGS: PhoneSettings = { theme: "auto", locale: "auto", fontScale: 1 };
const KEY = "ddak.phone.settings";

export function parseSettings(raw: string | null): PhoneSettings {
  let v: Partial<Record<keyof PhoneSettings, unknown>> = {};
  try {
    v = JSON.parse(raw ?? "{}") ?? {};
  } catch {
    // 기본값
  }
  return {
    theme: v.theme === "auto" || isThemeId(v.theme) ? v.theme : DEFAULT_SETTINGS.theme,
    locale: v.locale === "auto" || isLocale(v.locale) ? v.locale : DEFAULT_SETTINGS.locale,
    fontScale: typeof v.fontScale === "number" && FONT_SCALES.includes(v.fontScale) ? v.fontScale : DEFAULT_SETTINGS.fontScale,
  };
}

export function loadSettings(): PhoneSettings {
  try {
    return parseSettings(localStorage.getItem(KEY));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// 저장했는지 돌려준다 (사생활 보호 모드 등에서 저장소가 막히면 false)
export function saveSettings(s: PhoneSettings): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

// 폰 설정 따라: 어두우면 Dark, 밝으면 Solarized Light (예전부터의 폰 기본)
export const resolveTheme = (s: PhoneSettings, prefersDark: boolean): ThemeId => (s.theme !== "auto" ? s.theme : prefersDark ? "dark" : "solarized-light");
export const resolveLocale = (s: PhoneSettings, language: string): Locale => (s.locale !== "auto" ? s.locale : language.toLowerCase().startsWith("ko") ? "ko" : "en");

// 테마와 글자 크기를 화면에 (언어는 i18n.ts가 시작할 때 읽는다)
export function applySettings(s: PhoneSettings) {
  const root = document.documentElement;
  applyTheme(resolveTheme(s, matchMedia("(prefers-color-scheme: dark)").matches));
  root.style.setProperty("--font-scale", String(s.fontScale));
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(root).getPropertyValue("--tabbar-bg").trim());
}
