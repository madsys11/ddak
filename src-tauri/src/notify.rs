// 사용자에게 알림 (docs/spec.md "알림"): 세션이 사용자에게 보낸 채팅 메시지, 작업그룹의 자동 깨우기 멈춤, claude의 권한 확인.
// 응답이 끝날 때마다 울리지 않는다. macOS 알림 센터에 배너와 소리로 보내고, 사용자가 이미 보고 있으면 보내지 않는다:
// 창이 앞에 있고 그 프로젝트를 보고 있으며 (채팅 알림은) 그 프로젝트의 채팅 패널이 열려 있을 때.
//
// - 설치한 앱(.app 번들)에서만 보낸다. UNUserNotificationCenter는 번들 없는 실행 파일(개발·자체 테스트)에서 쓸 수 없다.
// - 자체 테스트(DDAK_SELFTEST)는 보내지 않고 기록만 한다 (selftest_notifications).
// - 문구는 프론트 사전에서 받는다 (set_notify_texts, 메뉴와 같은 방식). 받기 전에는 영어 기본 문구.
// - Dock 아이콘 배지: 사용자에게 온 안 읽은 메시지 수 (프론트가 센다, set_badge).
// - 누르면: 그 알림의 프로젝트로 가서, 터미널(pty)이 있으면 그 창을 보이고 포커스, 없으면 (채팅 메시지 등) 그 프로젝트의 채팅
//   패널을 연다. 알림 ID → 갈 곳을 기억해 두고 (최근 MAX_TARGETS개), 위임자의 didReceiveNotificationResponse에서 프론트에
//   "notification-click"({ project, pty })으로 알린다. 앱을 다시 켜면 이전 알림은 앞으로 가져오기만 한다.
// - 소리: 앱 메뉴 "알림 소리"에서 고른 시스템 소리 이름, "default"면 macOS 기본 소리 (set_notify_sound).
//   UNNotificationSound는 앱 번들과 앱 컨테이너의 Library/Sounds에서만 파일을 찾는다 (Apple 문서. 시스템 소리 이름을 찾는
//   NSSound와 다르다). 샌드박스가 없는 앱의 컨테이너는 홈이라, 고른 시스템 소리를 ~/Library/Sounds/ddak-<이름>.aiff로
//   복사해 그 파일 이름을 넘긴다 (리뷰 R1). 다른 ddak-*.aiff는 지운다 (ddak이 만든 것만).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

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
// 알림 소리: 고른 이름과 알림에 넘길 파일 이름 (프론트가 받기 전이나 준비하지 못하면 None = macOS 기본)
static SOUND: Mutex<Option<String>> = Mutex::new(None);
static SOUND_FILE: Mutex<Option<String>> = Mutex::new(None);
// 알림을 누르면 갈 곳. pty: 그 알림을 낸 터미널 (사용자를 기다림), 없으면 채팅 패널
#[derive(Clone, serde::Serialize)]
pub struct Target {
    project: String,
    pty: Option<u32>,
}
const MAX_TARGETS: usize = 200;
static TARGETS: Mutex<Vec<(String, Target)>> = Mutex::new(Vec::new());
static NEXT_ID: AtomicU64 = AtomicU64::new(0);
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
// 자체 테스트: 보낸 알림의 (ID, 본문) (누르기를 흉내 낸다, selftest_click_notification)
static SENT_IDS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
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

// 알림 종류. 채팅(메시지, 자동 깨우기 멈춤)은 그 프로젝트의 채팅 패널까지 보고 있어야, 권한 확인은 그 프로젝트를 보고 있으면
// 생략한다. 폰은 종류로 무엇을 보여야 알림을 닫을지 정한다 (mobile.rs notify).
pub enum Kind {
    Chat,
    Paused,
    Attention,
}

impl Kind {
    fn name(&self) -> &'static str {
        match self {
            Kind::Chat => "message",
            Kind::Paused => "paused",
            Kind::Attention => "attention",
        }
    }
}

fn watching(project: &Path, kind: &Kind) -> bool {
    with_view(|v| v.focused && v.active.as_deref() == Some(project) && (matches!(kind, Kind::Attention) || v.chat_open))
}

// 문구: 프론트 사전의 notify.<key> (없으면 기본). {이름}은 vars로 바꾼다.
pub fn text(key: &str, vars: &[(&str, &str)]) -> String {
    let fallback = match key {
        "paused" => "{group}: automatic notifications paused after sessions exchanged {n} messages without you",
        "attention" => "{name} is waiting for your permission",
        "question" => "{name} is waiting for your answer",
        "auth" => "{name} is waiting for you to sign in",
        "dialog" => "{name} is waiting for your choice",
        "blocked" => "{name} is waiting for you",
        _ => key,
    };
    let mut s = TEXTS.lock().unwrap().as_ref().and_then(|t| t.get(key).cloned()).unwrap_or_else(|| fallback.to_string());
    for (k, v) in vars {
        s = s.replace(&format!("{{{k}}}"), v);
    }
    s
}

// 알린다 (보고 있으면 생략). 제목은 "ddak · <프로젝트 폴더 이름>". pty: 누르면 보일 터미널 (없으면 채팅 패널).
// 같은 조건으로 연결된 폰에도 푸시를 보낸다 (mobile.rs, 맥 배너를 보내지 못하는 개발 실행에서도).
pub fn send(project: &Path, kind: Kind, body: &str, pty: Option<u32>) {
    if watching(project, &kind) {
        return;
    }
    if let Some(app) = APP.get() {
        crate::mobile::push(app, project, kind.name(), body);
    }
    let name = project.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    post(&format!("ddak · {name}"), body, Some(Target { project: project.to_string_lossy().into_owned(), pty }));
}

// 알림을 눌렀다: 창을 앞으로 가져오고 갈 곳을 프론트에 알린다 (모르는 ID면 앞으로 가져오기만)
pub fn clicked(id: &str) {
    use tauri::{Emitter, Manager};
    let Some(app) = APP.get() else { return };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let target = TARGETS.lock().unwrap().iter().rev().find(|(i, _)| i == id).map(|(_, t)| t.clone());
    if let Some(target) = target {
        let _ = app.emit("notification-click", target);
    }
}

// 보고 있는지 보지 않고 보낸다 (자체 테스트는 기록, 번들이 아니면 로그). target: 누르면 갈 곳
fn post(title: &str, body: &str, target: Option<Target>) {
    let title = title.to_string();
    let id = format!("ddak-{}-{}", std::process::id(), NEXT_ID.fetch_add(1, Ordering::Relaxed));
    if let Some(target) = target {
        let mut targets = TARGETS.lock().unwrap();
        targets.push((id.clone(), target));
        if targets.len() > MAX_TARGETS {
            targets.remove(0);
        }
    }
    if selftest() {
        SENT.lock().unwrap().push((title, body.to_string()));
        SENT_IDS.lock().unwrap().push((id, body.to_string()));
        return;
    }
    if !bundled() {
        eprintln!("알림 (번들이 아니라 보내지 않음): {title} — {body}");
        return;
    }
    let sound = SOUND_FILE.lock().unwrap().clone();
    #[cfg(target_os = "macos")]
    mac::deliver(&id, &title, body, sound.as_deref());
    #[cfg(windows)]
    {
        let _ = sound;
        if let Err(e) = win::deliver(&id, &title, body) {
            eprintln!("알림 실패: {e}");
        }
    }
}

const SYSTEM_SOUNDS: &str = "/System/Library/Sounds";

// 시스템 소리 name을 dir(~/Library/Sounds)에 ddak-<name>.aiff로 준비하고 그 파일 이름을 돌려준다.
// 이미 같은 크기로 있으면 그대로 두고, dir의 다른 ddak-*.aiff는 지운다.
fn prepare_sound(system: &Path, dir: &Path, name: &str) -> std::io::Result<String> {
    use std::io::{Error, ErrorKind};
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(Error::new(ErrorKind::InvalidInput, format!("소리 이름: {name}")));
    }
    let src = system.join(format!("{name}.aiff"));
    let file = format!("ddak-{name}.aiff");
    let dst = dir.join(&file);
    let len = std::fs::metadata(&src)?.len();
    std::fs::create_dir_all(dir)?;
    if std::fs::metadata(&dst).map(|m| m.len()).ok() != Some(len) {
        std::fs::copy(&src, &dst)?;
    }
    for entry in std::fs::read_dir(dir)?.flatten() {
        let other = entry.file_name().to_string_lossy().into_owned();
        if other != file && other.starts_with("ddak-") && other.ends_with(".aiff") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(file)
}

// 채팅 메시지 본문의 첫 줄 (알림 본문에 넣는다, 너무 길면 자른다)
pub fn first_line(text: &str) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if line.chars().count() > 120 { format!("{}…", line.chars().take(120).collect::<String>()) } else { line.to_string() }
}

// 맥: .app 번들 안에서 돌 때. Windows: 설치한 앱(릴리스 빌드). 토스트는 시작 메뉴 바로 가기의 앱 ID(AUMID)로 보이는데
// 개발 실행에는 그것이 없다
fn bundled() -> bool {
    if cfg!(windows) {
        return !cfg!(debug_assertions);
    }
    std::env::current_exe().is_ok_and(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
}

// 앱이 뜰 때: 알림 권한을 묻고 (처음 한 번만 macOS가 묻고, 그 뒤로는 저장된 답을 쓴다), 앞에 있을 때도 보이게 한다
pub fn init(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
    if bundled() && !selftest() {
        #[cfg(target_os = "macos")]
        {
            mac::present_in_front();
            mac::authorize();
        }
    }
}

// Windows 토스트 (WinRT ToastNotificationManager). 앱 ID는 앱 식별자 (설치 프로그램이 시작 메뉴 바로 가기에 적는 값과 같아야
// 보인다. 실기기에서 확인할 것: docs/windows-plan.md). 누르면 Activated가 (앱이 떠 있는 동안) clicked를 부른다. 소리는 Windows 기본.
#[cfg(windows)]
mod win {
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    use windows::core::HSTRING;

    fn escape(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
    }

    pub fn deliver(id: &str, title: &str, body: &str) -> windows::core::Result<()> {
        let app_id = super::APP.get().map(|a| a.config().identifier.clone()).unwrap_or_default();
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(format!(
            r#"<toast launch="{}"><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual></toast>"#,
            escape(id),
            escape(title),
            escape(body)
        )))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        let id = id.to_string();
        toast.Activated(&TypedEventHandler::new(move |_, _| {
            super::clicked(&id);
            Ok(())
        }))?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?.Show(&toast)
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{AllocAnyThread, define_class, msg_send};
    use objc2_foundation::{NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions, UNNotificationRequest,
        UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };

    // 앱이 앞에 있을 때 알림을 어떻게 보일지 위임자의 willPresent로 정한다: 배너·목록·소리. 보낼지는 send가 이미 정했으므로
    // (보고 있으면 보내지 않는다) 온 것은 다 보인다: 다른 프로젝트의 알림, 메뉴에서 소리를 고를 때의 시험 알림.
    // (2026-10-25 설치 후 사용자 확인: ddak이 앞에 있을 때 소리를 바꿔도 아무것도 안 들림. 이것이 원인인지는 설치 후 확인)
    define_class!(
        // SAFETY: NSObject는 하위 클래스 조건이 없고, Drop을 구현하지 않는다.
        #[unsafe(super(NSObject))]
        #[name = "DdakNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(&self, _center: &UNUserNotificationCenter, _notification: &UNNotification, handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
                handler.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List | UNNotificationPresentationOptions::Sound,));
            }

            // 알림을 눌렀다 (super::clicked)
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, handler: &DynBlock<dyn Fn()>) {
                super::clicked(&response.notification().request().identifier().to_string());
                handler.call(());
            }
        }
    );

    pub fn present_in_front() {
        let delegate: Retained<Delegate> = unsafe { msg_send![super(Delegate::alloc().set_ivars(())), init] };
        UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // 위임자는 약한 참조라 앱이 끝날 때까지 둔다
        std::mem::forget(delegate);
    }

    pub fn authorize() {
        let handler = RcBlock::new(|granted: Bool, _error: *mut NSError| {
            if !granted.as_bool() {
                eprintln!("알림 권한이 없어 알림을 보내지 못함 (시스템 설정 > 알림 > ddak)");
            }
        });
        let options = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge;
        UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(options, &handler);
    }

    // id: 알림 ID (누르면 이것으로 갈 곳을 찾는다). sound: ~/Library/Sounds에 준비한 파일 이름 (prepare_sound), 없으면 기본 소리
    pub fn deliver(id: &str, title: &str, body: &str, sound: Option<&str>) {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        let sound = match sound {
            Some(file) => UNNotificationSound::soundNamed(&NSString::from_str(file)),
            None => UNNotificationSound::defaultSound(),
        };
        content.setSound(Some(&sound));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(id), &content, None);
        UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, None);
    }
}

// 보고 있는 프로젝트와 그 채팅 패널이 열렸는지 (프론트 App.tsx가 바뀔 때마다 보낸다)
#[tauri::command]
pub fn set_view(active: Option<String>, chat_open: bool) {
    let active = active.map(|p| crate::platform::canonical(&p).unwrap_or_else(|_| PathBuf::from(p)));
    with_view(|v| {
        v.active = active;
        v.chat_open = chat_open;
    });
}

// 알림 소리를 정한다. preview가 있으면 그 문구로 시험 알림을 보낸다 (메뉴에서 고를 때, 보고 있어도 보낸다)
#[tauri::command]
pub fn set_notify_sound(sound: String, preview: Option<String>) {
    // 자체 테스트·개발 실행은 알림을 보내지 않으니 홈에 파일을 만들지 않는다
    // 소리 고르기는 맥 알림 센터의 것이다 (Windows는 토스트 기본 소리, 메뉴에도 없다)
    let file = if sound == "default" || selftest() || !bundled() || !cfg!(target_os = "macos") {
        None
    } else {
        let dir = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Sounds"));
        match dir.ok_or_else(|| std::io::Error::other("HOME 없음")).and_then(|d| prepare_sound(Path::new(SYSTEM_SOUNDS), &d, &sound)) {
            Ok(file) => Some(file),
            Err(e) => {
                eprintln!("알림 소리 {sound} 준비 실패, 기본 소리를 씀: {e}");
                None
            }
        }
    };
    *SOUND_FILE.lock().unwrap() = file;
    *SOUND.lock().unwrap() = Some(sound);
    if let Some(body) = preview {
        post("ddak", &body, None);
    }
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
    // Windows: 작업 표시줄 단추에 빨간 점 (수는 그리지 않는다. 0이면 지움)
    #[cfg(windows)]
    {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_overlay_icon((count > 0).then(|| tauri::image::Image::new_owned(badge_dot(16), 16, 16)));
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = (app, count);
}

// 지름 size의 빨간 원 (RGBA, 가장자리는 반투명으로)
#[cfg_attr(not(windows), allow(dead_code))]
fn badge_dot(size: u32) -> Vec<u8> {
    let r = size as f32 / 2.0;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            let d = ((x as f32 + 0.5 - r).powi(2) + (y as f32 + 0.5 - r).powi(2)).sqrt();
            let alpha = ((r - d + 0.5).clamp(0.0, 1.0) * 255.0) as u8;
            rgba.extend_from_slice(&[0xe5, 0x3e, 0x3e, alpha]);
        }
    }
    rgba
}

// 자체 테스트: 보낸 알림 (가져가면 비운다)과 마지막 배지 수, 알림 소리. 창 포커스를 정한다 (테스트 창은 포커스가 없을 수 있다)
#[tauri::command]
pub fn selftest_notifications() -> (Vec<(String, String)>, u32, Option<String>) {
    (std::mem::take(&mut *SENT.lock().unwrap()), *BADGE.lock().unwrap(), SOUND.lock().unwrap().clone())
}

// 실제 경로 (링크를 따라감. 없는 경로면 그대로). 알림의 프로젝트(실제 경로)를 등록한 프로젝트와 맞춘다 (src/notifyClick.ts)
#[tauri::command]
pub fn real_path(path: String) -> String {
    crate::platform::canonical(&path).map_or(path, |p| p.to_string_lossy().into_owned())
}

// 자체 테스트: 본문이 prefix로 시작하는 마지막 알림을 누른 것처럼 한다 (있었으면 true)
#[tauri::command]
pub fn selftest_click_notification(prefix: String) -> bool {
    let id = SENT_IDS.lock().unwrap().iter().rev().find(|(_, b)| b.starts_with(&prefix)).map(|(i, _)| i.clone());
    match id {
        Some(id) if selftest() => {
            clicked(&id);
            true
        }
        _ => false,
    }
}

// 자체 테스트: 알림 하나를 보낸다 (보고 있으면 생략하는 조건과 폰 푸시까지, 채팅을 거치지 않고)
#[tauri::command]
pub fn selftest_notify(project: String, kind: String, body: String) {
    if selftest() {
        let real = crate::platform::canonical(&project).unwrap_or_else(|_| PathBuf::from(project));
        let kind = match kind.as_str() {
            "attention" => Kind::Attention,
            "paused" => Kind::Paused,
            _ => Kind::Chat,
        };
        send(&real, kind, &body, None);
    }
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
        assert!(watching(p, &Kind::Chat) && watching(p, &Kind::Paused) && !watching(Path::new("/p/y"), &Kind::Chat));
        with_view(|v| v.focused = false);
        assert!(!watching(p, &Kind::Chat) && !watching(p, &Kind::Attention));
        assert_eq!(first_line("\n  hello\nworld"), "hello");
        assert_eq!(first_line(&"가".repeat(130)).chars().count(), 121);
        assert_eq!(text("attention", &[("name", "g/dev")]), "g/dev is waiting for your permission");
        // 폰이 알림을 닫을 조건을 고르는 종류 이름 (src/mobile/push.ts confirmed)
        assert_eq!([Kind::Chat.name(), Kind::Paused.name(), Kind::Attention.name()], ["message", "paused", "attention"]);
    }

    // 고른 시스템 소리를 ddak-<이름>.aiff로 복사하고, 전에 고른 ddak-*.aiff만 지운다. 이상한 이름·없는 소리는 실패
    #[test]
    fn prepares_sound_file() {
        let base = std::env::temp_dir().join(format!("ddak-sound-{}", std::process::id()));
        let (system, dir) = (base.join("system"), base.join("Sounds"));
        std::fs::create_dir_all(&system).unwrap();
        std::fs::write(system.join("Glass.aiff"), "glass").unwrap();
        std::fs::write(system.join("Hero.aiff"), "hero!").unwrap();
        assert_eq!(prepare_sound(&system, &dir, "Glass").unwrap(), "ddak-Glass.aiff");
        assert_eq!(std::fs::read_to_string(dir.join("ddak-Glass.aiff")).unwrap(), "glass");
        std::fs::write(dir.join("Mine.aiff"), "mine").unwrap();
        assert_eq!(prepare_sound(&system, &dir, "Hero").unwrap(), "ddak-Hero.aiff");
        let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["Mine.aiff", "ddak-Hero.aiff"]);
        assert!(prepare_sound(&system, &dir, "Funk").is_err());
        assert!(prepare_sound(&system, &dir, "../Hero").is_err());
        std::fs::remove_dir_all(&base).unwrap();
        // 실제 시스템 소리 폴더에 메뉴의 14개가 있다 (src/prefs.tsx NOTIFY_SOUNDS)
        for name in ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"] {
            assert!(Path::new(SYSTEM_SOUNDS).join(format!("{name}.aiff")).exists(), "{name}");
        }
    }
}
