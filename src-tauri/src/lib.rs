mod fs;
mod menu;
mod pty;
mod selftest;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::Ptys::default())
        .setup(|app| {
            menu::install(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs::list_dir,
            menu::set_menu,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            selftest::selftest_config,
            selftest::selftest_report,
            selftest::selftest_menu,
            #[cfg(target_os = "macos")]
            selftest::selftest_click_menu,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
