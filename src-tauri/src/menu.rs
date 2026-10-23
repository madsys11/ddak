// macOS 기본 메뉴는 ⌘W가 창을 닫는다. 터미널 단축키를 메뉴에 걸어 앱 단축키가 먼저 받게 한다.
// 메뉴를 고르면 프론트(src/Workspace.tsx, src/prefs.tsx)로 "menu" 이벤트에 항목 id를 실어 보낸다.
//
// 메뉴 문구는 프론트의 i18n 사전이 기준이다. 프론트가 뜨면 set_menu로 문구와 테마/언어 선택 상태를
// 보내고, 여기서 메뉴를 다시 만든다. 그 전까지는 Tauri 기본 메뉴가 떠 있다.

use std::collections::HashMap;

use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const TERMINAL_ITEMS: &[(&str, &str)] = &[
    ("new_tab", "CmdOrCtrl+T"),
    ("split_right", "CmdOrCtrl+D"),
    ("split_down", "CmdOrCtrl+Shift+D"),
    ("close_pane", "CmdOrCtrl+W"),
];

// 화면 배율 (프론트 src/prefs.tsx). ⌘+는 Shift+=라 ⌘=로 건다 (Safari·VS Code와 같은 키).
const ZOOM_ITEMS: &[(&str, &str)] = &[
    ("zoom_in", "CmdOrCtrl+="),
    ("zoom_out", "CmdOrCtrl+-"),
    ("zoom_reset", "CmdOrCtrl+0"),
];

const CLOSE_WINDOW: &str = "close_window";
const EDIT_GROUPS: &str = "edit_groups";
const THEME_PREFIX: &str = "theme:";
const LOCALE_PREFIX: &str = "locale:";

#[derive(serde::Deserialize)]
pub struct Choice {
    id: String,
    label: String,
    checked: bool,
}

#[derive(serde::Deserialize)]
pub struct MenuSpec {
    labels: HashMap<String, String>,
    themes: Vec<Choice>,
    locales: Vec<Choice>,
}

fn build<R: Runtime>(app: &AppHandle<R>, spec: &MenuSpec) -> tauri::Result<Menu<R>> {
    // 문구가 빠져 있으면 id를 그대로 보여 준다. 눈에 띄어야 고친다.
    let l = |id: &str| spec.labels.get(id).map(String::as_str).unwrap_or(id).to_owned();

    let app_menu = SubmenuBuilder::new(app, "ddak")
        .about_with_text(l("about"), None)
        .separator()
        .item(&MenuItemBuilder::with_id(EDIT_GROUPS, l(EDIT_GROUPS)).build(app)?)
        .separator()
        .services_with_text(l("services"))
        .separator()
        .hide_with_text(l("hide"))
        .hide_others_with_text(l("hideOthers"))
        .show_all_with_text(l("showAll"))
        .separator()
        .quit_with_text(l("quit"))
        .build()?;
    // 편집 메뉴가 있어야 웹뷰에서 ⌘C/⌘V가 동작한다.
    let edit = SubmenuBuilder::new(app, l("edit"))
        .undo_with_text(l("undo"))
        .redo_with_text(l("redo"))
        .separator()
        .cut_with_text(l("cut"))
        .copy_with_text(l("copy"))
        .paste_with_text(l("paste"))
        .select_all_with_text(l("selectAll"))
        .build()?;
    let mut terminal = SubmenuBuilder::new(app, l("terminal"));
    for (id, accel) in TERMINAL_ITEMS {
        terminal = terminal.item(&MenuItemBuilder::with_id(*id, l(id)).accelerator(*accel).build(app)?);
    }
    let choices = |title: String, prefix: &str, list: &[Choice]| {
        let mut sub = SubmenuBuilder::new(app, title);
        for c in list {
            sub = sub.item(
                &CheckMenuItemBuilder::with_id(format!("{prefix}{}", c.id), &c.label)
                    .checked(c.checked)
                    .build(app)?,
            );
        }
        sub.build()
    };
    let mut view = SubmenuBuilder::new(app, l("view"));
    for (id, accel) in ZOOM_ITEMS {
        view = view.item(&MenuItemBuilder::with_id(*id, l(id)).accelerator(*accel).build(app)?);
    }
    let view = view
        .separator()
        .item(&choices(l("theme"), THEME_PREFIX, &spec.themes)?)
        .item(&choices(l("language"), LOCALE_PREFIX, &spec.locales)?)
        .build()?;
    let window = SubmenuBuilder::new(app, l("window"))
        .minimize_with_text(l("minimize"))
        .maximize_with_text(l("maximize"))
        .separator()
        .fullscreen_with_text(l("fullscreen"))
        .separator()
        // 기본 close_window는 ⌘W라서 "터미널 닫기"와 겹친다 (muda predefined.rs). ⇧⌘W로 따로 둔다.
        .item(&MenuItemBuilder::with_id(CLOSE_WINDOW, l(CLOSE_WINDOW)).accelerator("CmdOrCtrl+Shift+W").build(app)?)
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &edit, &terminal.build()?, &view, &window])
        .build()
}

#[tauri::command]
pub fn set_menu<R: Runtime>(app: AppHandle<R>, spec: MenuSpec) -> Result<(), String> {
    let menu = build(&app, &spec).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn install<R: Runtime>(app: &AppHandle<R>) {
    app.on_menu_event(|app, event| {
        let id = event.id().0.as_str();
        if id == EDIT_GROUPS {
            // 편집 화면이 생기기 전까지는 기본 텍스트 편집기로 연다 (open -t).
            match crate::groups::ensure_file(app) {
                Ok(path) => {
                    let _ = std::process::Command::new("open").arg("-t").arg(path).spawn();
                }
                Err(e) => eprintln!("작업그룹 설정 파일 실패: {e:?}"),
            }
        } else if id == CLOSE_WINDOW {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        } else if TERMINAL_ITEMS.iter().chain(ZOOM_ITEMS).any(|(item, _)| *item == id)
            || id.starts_with(THEME_PREFIX)
            || id.starts_with(LOCALE_PREFIX)
        {
            let _ = app.emit("menu", id);
        }
    });
}
