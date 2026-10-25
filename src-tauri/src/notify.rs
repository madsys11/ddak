// 사용자에게 알림 (docs/spec.md "알림"): 세션이 사용자에게 보낸 채팅 메시지, 작업그룹의 자동 깨우기 멈춤, claude의 권한 확인.
// 응답이 끝날 때마다 울리지 않는다. macOS 알림 센터에 배너와 소리로 보내고, 사용자가 이미 보고 있으면 보내지 않는다:
// 창이 앞에 있고 그 프로젝트를 보고 있으며 (채팅 알림은) 그 프로젝트의 채팅 패널이 열려 있을 때.
//
// - 설치한 앱(.app 번들)에서만 보낸다. UNUserNotificationCenter는 번들 없는 실행 파일(개발·자체 테스트)에서 쓸 수 없다.
// - 자체 테스트(DDAK_SELFTEST)는 보내지 않고 기록만 한다 (selftest_notifications).
// - 문구는 프론트 사전에서 받는다 (set_notify_texts, 메뉴와 같은 방식). 받기 전에는 영어 기본 문구.
// - Dock 아이콘 배지: 사용자에게 온 안 읽은 메시지 수 (프론트가 센다, set_badge).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
struct View {
    // 창이 앞에 있는지 (Tauri 창 이벤트)
    focused: bool,
    // 보고 있는 프로젝트와 그 채팅 패널이 열렸는지 (프론트, 실제 경로)
    active: Option<PathBuf>,
    chat_open: bool,
}

static VIEW: Mutex<Option<View>> = Mutex::new(None);
static TEXTS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
// 자체 테스트가 본 알림 (제목, 본문)과 마지막 배지 수
static SENT: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
static BADGE: Mutex<u32> = Mutex::new(0);

fn selftest() -> bool {
    std::env::var_os("DDAK_SELFTEST").is_some()
}

fn with_view<T>(f: impl FnOnce(&mut View) -> T) -> T {
    f(VIEW.lock().unwrap().get_or_insert_with(View::default))
}

pub fn set_focused(focused: bool) {
    with_view(|v| v.focused = focused);
}

// 알림 종류. 채팅은 그 프로젝트의 채팅 패널까지 보고 있어야, 권한 확인은 그 프로젝트를 보고 있으면 생략한다.
pub enum Kind {
    Chat,
    Attention,
}

fn watching(project: &Path, kind: &Kind) -> bool {
    with_view(|v| v.focused && v.active.as_deref() == Some(project) && (matches!(kind, Kind::Attention) || v.chat_open))
}

// 문구: 프론트 사전의 notify.<key> (없으면 기본). {이름}은 vars로 바꾼다.
pub fn text(key: &str, vars: &[(&str, &str)]) -> String {
    let fallback = match key {
        "paused" => "{group}: automatic notifications paused after sessions exchanged {n} messages without you",
        "attention" => "{name} is waiting for your permission",
        _ => key,
    };
    let mut s = TEXTS.lock().unwrap().as_ref().and_then(|t| t.get(key).cloned()).unwrap_or_else(|| fallback.to_string());
    for (k, v) in vars {
        s = s.replace(&format!("{{{k}}}"), v);
    }
    s
}

// 알린다 (보고 있으면 생략). 제목은 "ddak · <프로젝트 폴더 이름>".
pub fn send(project: &Path, kind: Kind, body: &str) {
    if watching(project, &kind) {
        return;
    }
    let name = project.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let title = format!("ddak · {name}");
    if selftest() {
        SENT.lock().unwrap().push((title, body.to_string()));
        return;
    }
    if !bundled() {
        eprintln!("알림 (번들이 아니라 보내지 않음): {title} — {body}");
        return;
    }
    #[cfg(target_os = "macos")]
    mac::deliver(&title, body);
}

// 채팅 메시지 본문의 첫 줄 (알림 본문에 넣는다, 너무 길면 자른다)
pub fn first_line(text: &str) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if line.chars().count() > 120 { format!("{}…", line.chars().take(120).collect::<String>()) } else { line.to_string() }
}

fn bundled() -> bool {
    std::env::current_exe().is_ok_and(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
}

// 앱이 뜰 때: 알림 권한을 묻는다 (처음 한 번만 macOS가 묻고, 그 뒤로는 저장된 답을 쓴다)
pub fn init() {
    if bundled() && !selftest() {
        #[cfg(target_os = "macos")]
        mac::authorize();
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest, UNNotificationSound, UNUserNotificationCenter,
    };

    pub fn authorize() {
        let handler = RcBlock::new(|granted: Bool, _error: *mut NSError| {
            if !granted.as_bool() {
                eprintln!("알림 권한이 없어 알림을 보내지 못함 (시스템 설정 > 알림 > ddak)");
            }
        });
        let options = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge;
        UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(options, &handler);
    }

    pub fn deliver(title: &str, body: &str) {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&format!("ddak-{id}")), &content, None);
        UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, None);
    }
}

// 보고 있는 프로젝트와 그 채팅 패널이 열렸는지 (프론트 App.tsx가 바뀔 때마다 보낸다)
#[tauri::command]
pub fn set_view(active: Option<String>, chat_open: bool) {
    let active = active.map(|p| std::fs::canonicalize(&p).unwrap_or_else(|_| PathBuf::from(p)));
    with_view(|v| {
        v.active = active;
        v.chat_open = chat_open;
    });
}

#[tauri::command]
pub fn set_notify_texts(texts: HashMap<String, String>) {
    *TEXTS.lock().unwrap() = Some(texts);
}

// Dock 아이콘 배지 (사용자에게 온 안 읽은 메시지 수, 0이면 지움). AppKit이라 메인 스레드에서.
#[tauri::command]
pub fn set_badge(app: tauri::AppHandle, count: u32) {
    *BADGE.lock().unwrap() = count;
    #[cfg(target_os = "macos")]
    let _ = app.run_on_main_thread(move || {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSApplication;
        use objc2_foundation::NSString;
        let Some(mtm) = MainThreadMarker::new() else { return };
        let label = (count > 0).then(|| NSString::from_str(&count.to_string()));
        NSApplication::sharedApplication(mtm).dockTile().setBadgeLabel(label.as_deref());
    });
    #[cfg(not(target_os = "macos"))]
    let _ = (app, count);
}

// 자체 테스트: 보낸 알림 (가져가면 비운다)과 마지막 배지 수, 창 포커스를 정한다 (테스트 창은 포커스가 없을 수 있다)
#[tauri::command]
pub fn selftest_notifications() -> (Vec<(String, String)>, u32) {
    (std::mem::take(&mut *SENT.lock().unwrap()), *BADGE.lock().unwrap())
}

#[tauri::command]
pub fn selftest_set_focused(focused: bool) {
    if selftest() {
        set_focused(focused);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 보고 있으면 생략: 채팅은 창이 앞 + 그 프로젝트 + 채팅 패널, 권한 확인은 창이 앞 + 그 프로젝트
    #[test]
    fn skips_when_watching() {
        let p = Path::new("/p/x");
        with_view(|v| *v = View { focused: true, active: Some(p.to_path_buf()), chat_open: false });
        assert!(!watching(p, &Kind::Chat) && watching(p, &Kind::Attention));
        with_view(|v| v.chat_open = true);
        assert!(watching(p, &Kind::Chat) && !watching(Path::new("/p/y"), &Kind::Chat));
        with_view(|v| v.focused = false);
        assert!(!watching(p, &Kind::Chat) && !watching(p, &Kind::Attention));
        assert_eq!(first_line("\n  hello\nworld"), "hello");
        assert_eq!(first_line(&"가".repeat(130)).chars().count(), 121);
        assert_eq!(text("attention", &[("name", "g/dev")]), "g/dev is waiting for your permission");
    }
}
