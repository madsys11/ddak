// 기준 언어. 문구를 추가할 때는 여기에 먼저 넣는다.
// 다른 언어 파일은 Messages 타입이라 키가 하나라도 빠지면 타입 검사에서 걸린다.
export const en = {
  "app.openFolder": "Open Folder",
  "app.changeFolder": "Change Folder",

  "workspace.newTerminal": "New Terminal (⌘T)",
  "workspace.tabTitle": "Terminal {n}",
  "workspace.closeTab": "Close Tab",
  "workspace.newTab": "New Tab (⌘T)",
  "workspace.splitRight": "Split Right (⌘D)",
  "workspace.splitDown": "Split Down (⇧⌘D)",

  "terminal.spawnFailed": "Failed to start terminal: {error}",

  "theme.dark": "Dark",
  "theme.solarizedLight": "Solarized Light",

  // 네이티브 메뉴 (src-tauri/src/menu.rs가 "menu." 뒤의 이름으로 찾는다)
  "menu.about": "About ddak",
  "menu.services": "Services",
  "menu.hide": "Hide ddak",
  "menu.hideOthers": "Hide Others",
  "menu.showAll": "Show All",
  "menu.quit": "Quit ddak",
  "menu.edit": "Edit",
  "menu.undo": "Undo",
  "menu.redo": "Redo",
  "menu.cut": "Cut",
  "menu.copy": "Copy",
  "menu.paste": "Paste",
  "menu.selectAll": "Select All",
  "menu.terminal": "Terminal",
  "menu.new_tab": "New Tab",
  "menu.split_right": "Split Right",
  "menu.split_down": "Split Down",
  "menu.close_pane": "Close Terminal",
  "menu.view": "View",
  "menu.theme": "Theme",
  "menu.language": "Language",
  "menu.window": "Window",
  "menu.minimize": "Minimize",
  "menu.maximize": "Zoom",
  "menu.fullscreen": "Toggle Full Screen",
  "menu.close_window": "Close Window",
};

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
