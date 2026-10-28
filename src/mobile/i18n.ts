import { translate, type Locale, type MessageKey } from "../i18n";
import { loadSettings, resolveLocale } from "./settings";

// 폰 화면은 메뉴가 없어서 언어를 설정 화면에서 고른다 (기본은 폰 설정, 사전은 데스크톱과 같다).
// 바꾸면 화면을 다시 읽는다 (Settings, MobileApp.tsx)
export const locale: Locale = resolveLocale(loadSettings(), navigator.language);

export const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars);
