mod fs;
mod groups;
mod menu;
mod projects;
mod pty;
mod repos;
mod selftest;
mod setup;
mod watch;
mod worktrees;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::Ptys::default())
        .manage(watch::Watches::default())
        .setup(|app| {
            menu::install(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs::list_dir,
            fs::fs_create,
            fs::fs_rename,
            groups::groups_load,
            groups::groups_dir,
            watch::fs_watch,
            watch::fs_unwatch,
            repos::repo_link,
            repos::repo_clone,
            worktrees::group_create,
            setup::setup_script_edit,
            projects::projects_load,
            projects::projects_save,
            menu::set_menu,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            selftest::selftest_config,
            selftest::selftest_report,
            selftest::selftest_menu,
            selftest::selftest_watched,
            #[cfg(target_os = "macos")]
            selftest::selftest_click_menu,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
