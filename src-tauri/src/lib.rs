use tauri::Manager;

mod chat;
mod clone;
mod fs;
mod git;
mod groups;
mod menu;
mod prepare;
mod projects;
mod pty;
mod repos;
mod selftest;
mod setup;
mod watch;
mod workspace;
mod worktrees;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// 준비 창의 도우미 모드면 그 종료 코드 (main.rs가 창을 열기 전에 본다)
pub fn setup_helper() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    (args.first().map(String::as_str) == Some(prepare::HELPER)).then(|| prepare::run_helper(&args[1..]))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::Ptys::default())
        .manage(watch::Watches::default())
        .setup(|app| {
            menu::install(app.handle());
            app.manage(chat::install(app.handle()));
            pty::start_waker(app.handle().clone());
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
            git::git_repos,
            git::git_graph,
            git::git_commit,
            git::git_fingerprint,
            worktrees::group_status,
            worktrees::group_end,
            workspace::workspace_load,
            workspace::workspace_save,
            workspace::workspace_set_aside,
            setup::setup_script_edit,
            setup::setup_load,
            setup::setup_save,
            projects::projects_load,
            projects::projects_save,
            menu::set_menu,
            pty::pty_spawn,
            chat::chat_messages,
            chat::chat_post,
            chat::chat_members,
            chat::chat_waiting,
            chat::chat_wake_member,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::chat_wake_now,
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
