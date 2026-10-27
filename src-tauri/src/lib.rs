use tauri::Manager;

mod chat;
mod claude_trust;
mod clone;
mod fs;
mod git;
mod groups;
mod links;
mod menu;
mod mobile;
mod notify;
mod prepare;
mod projects;
mod prompts;
mod pty;
mod push;
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

// 웹뷰가 앱 화면에 머무는 주소인지. 그 밖의 주소로는 이동하지 않는다 (stay_in_app).
// 앱 화면: 설치한 앱은 tauri://, 개발·자체 테스트는 개발 서버(dev_url)와 같은 출처. about:blank 같은 빈 화면은 둔다.
fn app_page(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    url.scheme() == "tauri" || url.scheme() == "about" || dev_url.is_some_and(|d| url.origin() == d.origin())
}

// 웹뷰가 앱 화면을 떠나지 않게 한다. Finder에서 끌어 온 파일을 놓으면 WKWebView가 그 파일로 이동해 작업 화면이 모두
// 사라졌다 (docs/reviews/2026-10-27-drop-navigation.md). 바깥 주소는 웹뷰가 아니라 기본 앱으로 연다 (links.rs open_link).
// 화면 쪽도 터미널·채팅 입력란 밖에 놓은 앱 밖 파일은 받지 않는다 (src/dragPath.ts refuseOutsideDrops).
fn stay_in_app<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("stay-in-app")
        .on_navigation(|webview, url| {
            let dev_url = if tauri::is_dev() { webview.config().build.dev_url.as_ref() } else { None };
            app_page(url, dev_url)
        })
        .build()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(stay_in_app())
        .manage(pty::Ptys::default())
        .manage(watch::Watches::default())
        .manage(prompts::Prompts::default())
        .setup(|app| {
            menu::install(app.handle());
            notify::init(app.handle());
            let chats = chat::install(app.handle());
            let mobile = mobile::install(app.handle(), chats.0.clone());
            app.manage(chats);
            app.manage(mobile);
            pty::start_waker(app.handle().clone());
            Ok(())
        })
        // 알림을 보낼지 정할 때 창이 앞에 있는지 본다 (src-tauri/src/notify.rs)
        .on_window_event(|_, event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                notify::set_focused(*focused);
            }
        })
        .invoke_handler(tauri::generate_handler![
            notify::set_view,
            notify::set_notify_texts,
            notify::set_notify_sound,
            notify::set_badge,
            notify::selftest_notifications,
            notify::selftest_click_notification,
            notify::real_path,
            notify::selftest_set_focused,
            notify::selftest_notify,
            links::link_targets,
            prompts::pty_dialog,
            prompts::chat_prompts,
            prompts::chat_answer,
            prompts::prompt_result,
            prompts::prompt_write,
            links::open_link,
            links::selftest_opened_links,
            fs::list_dir,
            fs::fs_create,
            fs::fs_rename,
            fs::fs_trash,
            fs::fs_read_text,
            fs::fs_read_image,
            fs::drag_files,
            fs::drag_count,
            fs::selftest_drag_files,
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
            chat::chat_paused,
            chat::chat_clear,
            chat::chat_resume,
            chat::selftest_chat_join,
            chat::selftest_chat_leave,
            mobile::mobile_status,
            mobile::mobile_set_enabled,
            mobile::mobile_serve,
            mobile::mobile_pair_code,
            mobile::mobile_forget,
            mobile::selftest_mobile_http,
            mobile::selftest_mobile_pushes,
            pty::pty_write,
            pty::pty_foreground,
            pty::pty_awaiting,
            pty::selftest_pty_awaiting,
            pty::selftest_pty_awaiting_kind,
            pty::pty_working,
            pty::selftest_keep_awake,
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

#[cfg(test)]
mod tests {
    // 창의 네이티브 끌어 놓기 처리기를 끈다. 켜 두면 Tauri가 모든 끌기를 가로채(처리기가 늘 true) 웹뷰의 HTML 끌어 놓기
    // (파일 트리 → 터미널·채팅 입력란, src/dragPath.ts)가 dragover·drop을 받지 못한다 (tauri-runtime-wry, wry drag_drop.rs).
    // 자체 테스트는 합성 이벤트라 이것을 잡지 못해서 설정을 직접 본다.
    // 설치한 앱은 번들 전체를 임시(ad-hoc) 서명한다 ("-"). 링커가 실행 파일만 서명하면 서명 식별자가 앱 식별자가 아니고
    // Info.plist도 묶이지 않아, macOS 알림 센터가 앱으로 알아보지 못해 알림 권한을 묻지도 보내지도 못했다
    // (src-tauri/src/notify.rs, docs/reviews/2026-10-25-notify.md). 배포 때 Developer ID로 바꾼다 (docs/spec.md "배포 계획").
    #[test]
    fn bundle_is_signed_ad_hoc() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["bundle"]["macOS"]["signingIdentity"], "-");
    }

    #[test]
    fn webview_stays_on_app_pages() {
        let url = |s: &str| tauri::Url::parse(s).unwrap();
        let dev = url("http://localhost:1430");
        for ok in ["tauri://localhost/", "tauri://localhost/index.html#x", "about:blank", "http://localhost:1430/src/App.tsx"] {
            assert!(super::app_page(&url(ok), Some(&dev)), "{ok}");
        }
        for no in ["file:///Users/x/a.png", "https://example.com/", "http://localhost:3000/", "https://localhost:1430/", "data:text/html,x"] {
            assert!(!super::app_page(&url(no), Some(&dev)), "{no}");
        }
        // 설치한 앱(개발 서버 없음)
        assert!(super::app_page(&url("tauri://localhost/"), None));
        assert!(!super::app_page(&url("http://localhost:1430/"), None));
    }

    #[test]
    fn native_drag_drop_is_off() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = conf["app"]["windows"].as_array().unwrap();
        assert!(!windows.is_empty() && windows.iter().all(|w| w["dragDropEnabled"] == false), "{windows:?}");
    }
}
