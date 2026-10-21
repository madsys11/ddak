// 자체 테스트 모드. DDAK_SELFTEST=<테스트용 폴더>로 실행하면 프론트(src/selftest.ts)가
// 실제 앱에서 시나리오를 돌리고 결과를 보고한 뒤 앱을 종료한다. 실행은 scripts/selftest.sh.

use tauri::AppHandle;
use tauri::menu::MenuItemKind;

#[tauri::command]
pub fn selftest_config() -> Option<String> {
    std::env::var("DDAK_SELFTEST").ok()
}

#[tauri::command]
pub fn selftest_report(app: AppHandle, ok: bool, log: String) {
    println!("=== DDAK SELFTEST BEGIN ===\n{log}\n=== DDAK SELFTEST {} ===", if ok { "PASS" } else { "FAIL" });
    app.exit(if ok { 0 } else { 1 });
}

// 실제로 걸린 네이티브 메뉴를 "상위/항목" 목록으로 돌려준다. 체크된 항목은 끝에 " [x]".
#[tauri::command]
pub fn selftest_menu(app: AppHandle) -> Result<Vec<String>, String> {
    fn walk(items: Vec<MenuItemKind<tauri::Wry>>, prefix: &str, out: &mut Vec<String>) -> tauri::Result<()> {
        for item in items {
            match item {
                MenuItemKind::Submenu(sub) => {
                    let path = format!("{prefix}{}/", sub.text()?);
                    out.push(path.clone());
                    walk(sub.items()?, &path, out)?;
                }
                MenuItemKind::MenuItem(i) => out.push(format!("{prefix}{}", i.text()?)),
                MenuItemKind::Predefined(i) => out.push(format!("{prefix}{}", i.text()?)),
                MenuItemKind::Check(i) => {
                    out.push(format!("{prefix}{}{}", i.text()?, if i.is_checked()? { " [x]" } else { "" }))
                }
                MenuItemKind::Icon(i) => out.push(format!("{prefix}{}", i.text()?)),
            }
        }
        Ok(())
    }
    let menu = app.menu().ok_or("메뉴 없음")?;
    let mut out = Vec::new();
    walk(menu.items().map_err(|e| e.to_string())?, "", &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

// 네이티브 메뉴 항목을 제목 경로(예: ["View", "Theme", "Dark"])로 찾아 실제로 실행한다.
// 프론트에서 "menu" 이벤트를 직접 보내는 것과 달리, 체크 항목의 자동 토글 같은
// muda의 클릭 처리를 그대로 거친다. AppKit은 메인 스레드에서만 다룰 수 있다.
// async여야 한다: 동기 명령은 메인 스레드에서 돌 수 있어, 메인 스레드 작업을 기다리면 교착된다.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn selftest_click_menu(app: AppHandle, path: Vec<String>) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;

    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let result = (|| {
            let mtm = MainThreadMarker::new().ok_or("메인 스레드 아님")?;
            let mut menu = NSApplication::sharedApplication(mtm).mainMenu().ok_or("메인 메뉴 없음")?;
            for (depth, title) in path.iter().enumerate() {
                let index = (0..menu.numberOfItems())
                    .find(|&i| menu.itemAtIndex(i).is_some_and(|item| item.title().to_string() == *title))
                    .ok_or_else(|| format!("메뉴 항목 없음: {}", path[..=depth].join("/")))?;
                if depth == path.len() - 1 {
                    menu.performActionForItemAtIndex(index);
                } else {
                    menu = menu.itemAtIndex(index).and_then(|item| item.submenu()).ok_or("하위 메뉴 없음")?;
                }
            }
            Ok::<(), String>(())
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}
