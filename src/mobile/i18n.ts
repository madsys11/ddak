import { translate, type Locale, type MessageKey } from "../i18n";

// 폰 화면은 메뉴가 없어서 언어를 폰 설정에서 고른다 (사전은 데스크톱과 같다)
export const locale: Locale = navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en";

export const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars);
