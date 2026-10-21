import type { ITheme } from "@xterm/xterm";
import type { MessageKey } from "./i18n";

// 색은 VS Code에 들어 있는 테마 파일에서 가져왔다.
// (Visual Studio Code.app/Contents/Resources/app/extensions/theme-*/themes/*.json)
export type Theme = {
  name: MessageKey;
  scheme: "dark" | "light";
  ui: Record<`--${string}`, string>;
  terminal: ITheme;
};

const dark: Theme = {
  // Dark Modern. ANSI 색은 테마 파일에 없고 VS Code 기본값이다.
  name: "theme.dark",
  scheme: "dark",
  ui: {
    "--bg": "#1F1F1F",
    "--sidebar-bg": "#181818",
    "--tabbar-bg": "#181818",
    "--tab-inactive-bg": "#181818",
    "--border": "#2B2B2B",
    "--fg": "#CCCCCC",
    "--fg-dim": "#9D9D9D",
    "--hover": "#2A2D2E",
    "--error": "#F85149",
    "--accent": "#0078D4",
    "--accent-dim": "#0078D466",
    "--button-bg": "#313131",
    "--button-fg": "#CCCCCC",
    "--button-border": "#3C3C3C",
    "--button-hover": "#3A3A3A",
  },
  terminal: {
    background: "#1F1F1F",
    foreground: "#CCCCCC",
    cursor: "#AEAFAD",
    selectionBackground: "#264F78",
    black: "#000000",
    red: "#CD3131",
    green: "#0DBC79",
    yellow: "#E5E510",
    blue: "#2472C8",
    magenta: "#BC3FBC",
    cyan: "#11A8CD",
    white: "#E5E5E5",
    brightBlack: "#666666",
    brightRed: "#F14C4C",
    brightGreen: "#23D18B",
    brightYellow: "#F5F543",
    brightBlue: "#3B8EEA",
    brightMagenta: "#D670D6",
    brightCyan: "#29B8DB",
    brightWhite: "#E5E5E5",
  },
};

const solarizedLight: Theme = {
  name: "theme.solarizedLight",
  scheme: "light",
  ui: {
    "--bg": "#FDF6E3",
    "--sidebar-bg": "#EEE8D5",
    "--tabbar-bg": "#D9D2C2",
    "--tab-inactive-bg": "#D3CBB7",
    "--border": "#DDD6C1",
    "--fg": "#586E75",
    "--fg-dim": "#839496",
    "--hover": "#DFCA8844",
    "--error": "#DC322F",
    "--accent": "#B49471",
    "--accent-dim": "#B4947188",
    "--button-bg": "#AC9D57",
    "--button-fg": "#FFFFFF",
    "--button-border": "#AC9D57",
    "--button-hover": "#9D8E4C",
  },
  terminal: {
    background: "#FDF6E3",
    foreground: "#657B83",
    cursor: "#657B83",
    // 테마의 editor.selectionBackground(#EEE8D5)는 배경과 거의 같아 터미널에서 안 보인다.
    // 목록 선택색(list.activeSelectionBackground)을 반투명으로 쓴다.
    selectionBackground: "#DFCA8899",
    black: "#073642",
    red: "#DC322F",
    green: "#859900",
    yellow: "#B58900",
    blue: "#268BD2",
    magenta: "#D33682",
    cyan: "#2AA198",
    white: "#EEE8D5",
    brightBlack: "#002B36",
    brightRed: "#CB4B16",
    brightGreen: "#586E75",
    brightYellow: "#657B83",
    brightBlue: "#839496",
    brightMagenta: "#6C71C4",
    brightCyan: "#93A1A1",
    brightWhite: "#FDF6E3",
  },
};

// 테마를 추가하려면 여기에 한 줄 넣고 이름 문구를 i18n 사전에 넣는다.
export const THEMES = { dark, "solarized-light": solarizedLight } satisfies Record<string, Theme>;
export type ThemeId = keyof typeof THEMES;
export const DEFAULT_THEME: ThemeId = "dark";
export const isThemeId = (v: unknown): v is ThemeId => typeof v === "string" && v in THEMES;

export function applyTheme(id: ThemeId) {
  const root = document.documentElement;
  const theme = THEMES[id];
  for (const [name, value] of Object.entries(theme.ui)) root.style.setProperty(name, value);
  root.style.colorScheme = theme.scheme;
  root.dataset.theme = id;
}
