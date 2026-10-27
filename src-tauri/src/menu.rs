// macOS 기본 메뉴는 ⌘W가 창을 닫는다. 터미널 단축키를 메뉴에 걸어 앱 단축키가 먼저 받게 한다.
// 메뉴를 고르면 프론트(src/Workspace.tsx, src/prefs.tsx)로 "menu" 이벤트에 항목 id를 실어 보낸다.
//
// 메뉴 문구는 프론트의 i18n 사전이 기준이다. 프론트가 뜨면 set_menu로 문구와 테마/언어 선택 상태를
// 보내고, 여기서 메뉴를 다시 만든다. 그 전까지는 Tauri 기본 메뉴가 떠 있다.

use std::collections::HashMap;

use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const TERMINAL_ITEMS: &[(&str, Option<&str>)] = &[
    ("new_tab", Some("CmdOrCtrl+T")),
    // 새 작업그룹 (worktree 세트 + 기본 그룹 세션). ⌘T는 셸 탭으로 둔다.
    ("new_group", Some("CmdOrCtrl+Shift+T")),
    // 지금 탭에 작업그룹 설정의 세션 하나를 더한다 (src/AddSessionDialog.tsx). 단축키는 없다.
    ("add_session", None),
    ("split_right", Some("CmdOrCtrl+D")),
    ("split_down", Some("CmdOrCtrl+Shift+D")),
    ("close_pane", Some("CmdOrCtrl+W")),
    // 포커스가 있는 터미널에서 찾기 (src/TerminalSearch.tsx)
    ("find", Some("CmdOrCtrl+F")),
];

// 화면 배율 (프론트 src/prefs.tsx). ⌘+는 Shift+=라 ⌘=로 건다 (Safari·VS Code와 같은 키).
const ZOOM_ITEMS: &[(&str, &str)] = &[
    ("zoom_in", "CmdOrCtrl+="),
    ("zoom_out", "CmdOrCtrl+-"),
    ("zoom_reset", "CmdOrCtrl+0"),
];

const MAC: bool = cfg!(target_os = "macos");
const CLOSE_WINDOW: &str = "close_window";
// 보기 메뉴: 프로젝트의 Git Graph 탭을 연다 (src/GitGraph.tsx). 단축키는 없다.
const GIT_GRAPH: &str = "git_graph";
// 보기 메뉴: 파일 트리 보이기(체크, ⌘B)·패널 크기 초기화 (프론트 src/prefs.tsx)
const TOGGLE_SIDEBAR: &str = "toggle_sidebar";
const RESET_PANELS: &str = "reset_panels";
const EDIT_GROUPS: &str = "edit_groups";
// 앱 메뉴: 모바일 연결 창 (프론트 src/MobileDialog.tsx, src-tauri/src/mobile.rs)
const MOBILE: &str = "mobile";
const THEME_PREFIX: &str = "theme:";
const LOCALE_PREFIX: &str = "locale:";
// 앱 메뉴: 알림 소리 (프론트 src/prefs.tsx NOTIFY_SOUNDS, src-tauri/src/notify.rs)
const SOUND_PREFIX: &str = "sound:";

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
    #[serde(default)]
    sounds: Vec<Choice>,
    // 파일 트리가 보이는지 (보기 메뉴의 체크)
    #[serde(default = "shown")]
    sidebar: bool,
}

fn shown() -> bool {
    true
}

fn build<R: Runtime>(app: &AppHandle<R>, spec: &MenuSpec) -> tauri::Result<Menu<R>> {
    // 문구가 빠져 있으면 id를 그대로 보여 준다. 눈에 띄어야 고친다.
    let l = |id: &str| spec.labels.get(id).map(String::as_str).unwrap_or(id).to_owned();

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
    let mut app_menu = SubmenuBuilder::new(app, "ddak")
        .about_with_text(l("about"), None)
        .separator()
        .item(&MenuItemBuilder::with_id(EDIT_GROUPS, l(EDIT_GROUPS)).build(app)?)
        .item(&MenuItemBuilder::with_id(MOBILE, l(MOBILE)).build(app)?);
    // 알림 소리는 맥 알림 센터의 시스템 소리라 맥에만 (notify.rs)
    if MAC {
        app_menu = app_menu
            .item(&choices(l("notify_sound"), SOUND_PREFIX, &spec.sounds)?)
            .separator()
            .services_with_text(l("services"))
            .separator()
            .hide_with_text(l("hide"))
            .hide_others_with_text(l("hideOthers"))
            .show_all_with_text(l("showAll"));
    }
    let app_menu = app_menu.separator().quit_with_text(l("quit")).build()?;
    // 편집 메뉴가 있어야 맥 웹뷰에서 ⌘C/⌘V가 동작한다. Windows는 두지 않는다: 메뉴 단축키는 웹뷰보다 먼저 잡혀서
    // (Tauri의 TranslateAcceleratorW 훅) 편집 메뉴의 Ctrl+C가 터미널의 인터럽트를 가로챈다. 입력란은 웹뷰가 스스로
    // 복사·붙여넣기하고, 터미널은 Terminal.tsx가 한다 (docs/windows-plan.md W3).
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
        let mut item = MenuItemBuilder::with_id(*id, l(id));
        if let Some(accel) = accel {
            item = item.accelerator(*accel);
        }
        terminal = terminal.item(&item.build(app)?);
    }
    let mut view = SubmenuBuilder::new(app, l("view"))
        .item(&MenuItemBuilder::with_id(GIT_GRAPH, l(GIT_GRAPH)).build(app)?)
        .separator()
        .item(&CheckMenuItemBuilder::with_id(TOGGLE_SIDEBAR, l(TOGGLE_SIDEBAR)).checked(spec.sidebar).accelerator("CmdOrCtrl+B").build(app)?)
        .item(&MenuItemBuilder::with_id(RESET_PANELS, l(RESET_PANELS)).build(app)?)
        .separator();
    for (id, accel) in ZOOM_ITEMS {
        view = view.item(&MenuItemBuilder::with_id(*id, l(id)).accelerator(*accel).build(app)?);
    }
    let view = view
        .separator()
        .item(&choices(l("theme"), THEME_PREFIX, &spec.themes)?)
        .item(&choices(l("language"), LOCALE_PREFIX, &spec.locales)?)
        .build()?;
    let mut window = SubmenuBuilder::new(app, l("window")).minimize_with_text(l("minimize")).maximize_with_text(l("maximize")).separator();
    // 전체 화면은 Windows 메뉴 항목이 없다 (muda: 지원하지 않으면 꺼진 채로 보인다)
    if MAC {
        window = window.fullscreen_with_text(l("fullscreen")).separator();
    }
    let window = window
        // 기본 close_window는 ⌘W라서 "터미널 닫기"와 겹친다 (muda predefined.rs). ⇧⌘W로 따로 둔다.
        .item(&MenuItemBuilder::with_id(CLOSE_WINDOW, l(CLOSE_WINDOW)).accelerator("CmdOrCtrl+Shift+W").build(app)?)
        .build()?;
    let terminal = terminal.build()?;
    let menus: Vec<&dyn tauri::menu::IsMenuItem<R>> =
        if MAC { vec![&app_menu, &edit, &terminal, &view, &window] } else { vec![&app_menu, &terminal, &view, &window] };
    MenuBuilder::new(app).items(&menus).build()
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
            // 편집 화면이 생기기 전까지는 기본 텍스트 편집기로 연다 (platform::edit_text).
            match crate::groups::ensure_file(app) {
                Ok(path) => {
                    let _ = crate::platform::edit_text(&path);
                }
                Err(e) => eprintln!("작업그룹 설정 파일 실패: {e:?}"),
            }
        } else if id == CLOSE_WINDOW {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        } else if TERMINAL_ITEMS.iter().map(|(item, _)| *item).chain(ZOOM_ITEMS.iter().map(|(item, _)| *item)).any(|item| item == id)
            || [GIT_GRAPH, TOGGLE_SIDEBAR, RESET_PANELS, MOBILE].contains(&id)
            || id.starts_with(THEME_PREFIX)
            || id.starts_with(LOCALE_PREFIX)
            || id.starts_with(SOUND_PREFIX)
        {
            let _ = app.emit("menu", id);
        }
    });
}
