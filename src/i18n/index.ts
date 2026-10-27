import { keyLabels } from "../platform";
import { en, type MessageKey, type Messages } from "./en";
import { ko } from "./ko";

// 언어를 추가하려면 사전 파일을 만들고 여기에 한 줄 넣는다. 이름은 그 언어로 쓴다.
export const LOCALES = {
  en: { name: "English", messages: en },
  ko: { name: "한국어", messages: ko },
} satisfies Record<string, { name: string; messages: Messages }>;

export type Locale = keyof typeof LOCALES;
export type { MessageKey };
export const DEFAULT_LOCALE: Locale = "en";

export const isLocale = (v: unknown): v is Locale => typeof v === "string" && v in LOCALES;

// 사전의 키 기호(⌘·⇧)는 Windows에서 Ctrl·Shift로 (platform.ts keyLabels). 넣는 값(vars)은 바꾸지 않는다
export function translate(locale: Locale, key: MessageKey, vars?: Record<string, string | number>) {
  const text: string = keyLabels(LOCALES[locale].messages[key]);
  return vars ? text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m)) : text;
}
