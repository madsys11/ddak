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
    "--row-active": "#37373D", // list.inactiveSelectionBackground
    // 파일 트리 아이콘. 저장소·worktree는 git 장식 색(수정됨·추가됨)
    "--icon-project": "#4DAAFC",
    "--icon-repo": "#E2C08D",
    "--icon-worktree": "#81B88B",
    "--git-added": "#81B88B", // Git Graph 파일 목록의 추가(A) 글자. gitDecoration.addedResourceForeground
    "--tree-link": "#9D9D9D",
    // Git Graph 레인 (VS Code Git Graph 확장의 기본 색)
    "--graph-1": "#0085D9",
    "--graph-2": "#D9008F",
    "--graph-3": "#00D90A",
    "--graph-4": "#D98500",
    "--graph-5": "#A300D9",
    "--graph-6": "#FF0000",
    // 대화상자
    "--overlay": "#00000080",
    "--widget-bg": "#202020", // editorWidget.background
    // 모바일 연결 창의 QR (카메라가 읽게 어느 테마에서나 밝은 바탕에 검은 점)
    "--qr-fg": "#000000",
    "--qr-bg": "#FFFFFF",
    "--input-bg": "#313131",
    "--input-border": "#3C3C3C",
    "--focus-border": "#0078D4",
    "--menu-hover-bg": "#0078D4", // menu.selectionBackground
    "--menu-hover-fg": "#FFFFFF",
    // 터미널 검색의 일치·지금 결과 (#RRGGBB만, xterm 검색 애드온. VS Code editor.findMatch(Highlight)Background를 배경에 섞은 색)
    "--search-match": "#4A3B22",
    "--search-match-active": "#9E6A03",
    // 창 이름표의 프로그램 상태 (App.css .pane-badge.status)
    "--status-working": "#4DAAFC",
    "--status-done": "#3FB950",
    "--status-awaiting-bg": "#E5A13A",
    "--status-awaiting-fg": "#1A1A1A",
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

const light: Theme = {
  // Light Modern. 테마 파일에 없는 색(목록 호버·비활성 선택, git 장식, 검색, 선택, ANSI)은 VS Code 라이트 기본값이다.
  name: "theme.light",
  scheme: "light",
  ui: {
    "--bg": "#FFFFFF",
    "--sidebar-bg": "#F8F8F8",
    "--tabbar-bg": "#F8F8F8",
    "--tab-inactive-bg": "#F8F8F8",
    "--border": "#E5E5E5",
    "--fg": "#3B3B3B",
    "--fg-dim": "#616161", // tab.inactiveForeground (descriptionForeground는 --fg와 같다)
    "--hover": "#F2F2F2",
    "--error": "#A1260D", // errorForeground의 VS Code 라이트 기본값. Light Modern의 #F85149는 작은 글자 대비 3.2:1
    "--accent": "#005FB8",
    "--accent-dim": "#005FB866",
    // 다크처럼 색을 채우지 않은 버튼 (button.secondary*)
    "--button-bg": "#E5E5E5",
    "--button-fg": "#3B3B3B",
    "--button-border": "#CECECE",
    "--button-hover": "#CCCCCC",
    "--row-active": "#E4E6F1", // list.inactiveSelectionBackground
    "--icon-project": "#005FB8",
    "--icon-repo": "#895503",
    "--icon-worktree": "#587C0C",
    "--git-added": "#587C0C",
    "--tree-link": "#616161",
    "--graph-1": "#0085D9",
    "--graph-2": "#D9008F",
    "--graph-3": "#00D90A",
    "--graph-4": "#D98500",
    "--graph-5": "#A300D9",
    "--graph-6": "#FF0000",
    "--overlay": "#00000033",
    "--widget-bg": "#F8F8F8",
    "--qr-fg": "#000000",
    "--qr-bg": "#FFFFFF",
    "--input-bg": "#FFFFFF",
    "--input-border": "#CECECE",
    "--focus-border": "#005FB8",
    "--menu-hover-bg": "#005FB8",
    "--menu-hover-fg": "#FFFFFF",
    // editor.findMatchHighlightBackground(#EA5C0055)를 흰 배경에 섞은 색, editor.findMatchBackground
    "--search-match": "#F8C9AA",
    "--search-match-active": "#A8AC94",
    // 이름표 배경(--sidebar-bg) 위 대비 4.5:1 이상. 링크·git 추가됨·git 수정됨 색
    "--status-working": "#005FB8",
    "--status-done": "#587C0C",
    "--status-awaiting-bg": "#895503",
    "--status-awaiting-fg": "#FFFFFF",
  },
  terminal: {
    background: "#FFFFFF",
    foreground: "#3B3B3B",
    cursor: "#005FB8",
    selectionBackground: "#ADD6FF",
    black: "#000000",
    red: "#CD3131",
    green: "#107C10",
    yellow: "#949800",
    blue: "#0451A5",
    magenta: "#BC05BC",
    cyan: "#0598BC",
    white: "#555555",
    brightBlack: "#666666",
    brightRed: "#F14C4C",
    brightGreen: "#14CE14",
    brightYellow: "#B5BA00",
    brightBlue: "#3B8EEA",
    brightMagenta: "#D670D6",
    brightCyan: "#29B8DB",
    brightWhite: "#A5A5A5",
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
    "--error": "#B02825", // #DC322F는 바탕 위 작은 글자 대비 4.5:1 미만이라 진하게
    "--accent": "#B49471",
    "--accent-dim": "#B4947188",
    "--button-bg": "#AC9D57",
    "--button-fg": "#FFFFFF",
    "--button-border": "#AC9D57",
    "--button-hover": "#9D8E4C",
    "--row-active": "#DFCA8888",
    "--icon-project": "#268BD2",
    "--icon-repo": "#B58900",
    "--icon-worktree": "#859900",
    "--git-added": "#566300", // #859900은 바탕 위 대비 3:1이라 진하게 (--status-done과 같음)
    "--tree-link": "#93A1A1",
    // Git Graph 레인 (Solarized 강조색)
    "--graph-1": "#268BD2",
    "--graph-2": "#D33682",
    "--graph-3": "#859900",
    "--graph-4": "#CB4B16",
    "--graph-5": "#6C71C4",
    "--graph-6": "#DC322F",
    "--overlay": "#00000033",
    "--widget-bg": "#EEE8D5",
    "--qr-fg": "#000000",
    "--qr-bg": "#FFFFFF",
    "--input-bg": "#DDD6C1",
    "--input-border": "#D3AF86",
    "--focus-border": "#B49471",
    "--menu-hover-bg": "#DFCA88", // list.activeSelectionBackground
    "--menu-hover-fg": "#6C6C6C",
    "--search-match": "#F0DFA8",
    "--search-match-active": "#E3B341",
    // 솔라라이즈드 파랑·초록·주황을 이름표 배경(--sidebar-bg) 위 작은 글자 대비 4.5:1 이상으로 진하게 (리뷰 R3)
    "--status-working": "#1B659A",
    "--status-done": "#566300",
    "--status-awaiting-bg": "#B5420F",
    "--status-awaiting-fg": "#FDF6E3",
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
export const THEMES = { dark, light, "solarized-light": solarizedLight } satisfies Record<string, Theme>;
export type ThemeId = keyof typeof THEMES;
export const DEFAULT_THEME: ThemeId = "dark";
export const isThemeId = (v: unknown): v is ThemeId => typeof v === "string" && v in THEMES;

export function applyTheme(id: ThemeId) {
  const root = document.documentElement;
  const theme = THEMES[id];
  for (const [name, value] of Object.entries(theme.ui)) root.style.setProperty(name, value);
  // xterm.css가 .xterm-viewport 배경을 #000으로 고정해 둔다. 마지막 줄 아래 남는 공간이 이 색으로 보이므로
  // 터미널 배경색으로 덮는다 (App.css).
  root.style.setProperty("--terminal-bg", theme.terminal.background!);
  root.style.colorScheme = theme.scheme;
  root.dataset.theme = id;
}
