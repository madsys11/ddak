// Windows: 탐색기 등 앱 밖에서 끌어 놓은 파일의 경로 (맥은 fs.rs의 끌기 대지). WebView2의 drop도 File(이름)만 준다.
// 화면이 놓은 File들을 chrome.webview.postMessageWithAdditionalObjects("ddak-drop:<토큰>", files)로 보내면 WebView2가
// ICoreWebView2File로 넘겨주고, 그 경로를 토큰별로 둔다. 화면은 drop_paths(토큰)로 가져간다 (src/dragPath.ts droppedFiles).
// 토큰은 화면이 놓을 때마다 새로 만든 것이라 다른 끌기의 경로와 섞이지 않는다.

use std::sync::Mutex;
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2};
use webview2_com::{WebMessageReceivedEventHandler, take_pwstr};
use windows::core::{Interface, PWSTR};

const PREFIX: &str = "ddak-drop:";
// 가져가지 않은 것은 최근 몇 개만 둔다
const KEEP: usize = 8;
static DROPS: Mutex<Vec<(String, Vec<String>)>> = Mutex::new(Vec::new());

// 화면이 보낸 토큰의 경로 (한 번 가져가면 지운다). 아직 오지 않았으면 None
pub fn take(token: &str) -> Option<Vec<String>> {
    let mut drops = DROPS.lock().unwrap();
    let i = drops.iter().position(|(t, _)| t == token)?;
    Some(drops.remove(i).1)
}

fn paths(args: &ICoreWebView2WebMessageReceivedEventArgs2) -> windows::core::Result<Vec<String>> {
    let objects = unsafe { args.AdditionalObjects()? };
    let mut count = 0u32;
    unsafe { objects.Count(&mut count)? };
    let mut out = Vec::new();
    for i in 0..count {
        let Ok(file) = unsafe { objects.GetValueAtIndex(i) }.and_then(|o| o.cast::<ICoreWebView2File>()) else { continue };
        let mut path = PWSTR::null();
        if unsafe { file.Path(&mut path) }.is_ok() {
            out.push(take_pwstr(path));
        }
    }
    Ok(out)
}

// 창의 웹뷰에 메시지 처리기를 하나 더 건다 (Tauri의 IPC 처리기는 그대로)
pub fn install(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let handler = WebMessageReceivedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut message = PWSTR::null();
            if args.TryGetWebMessageAsString(&mut message).is_err() {
                return Ok(());
            }
            let message = take_pwstr(message);
            let Some(token) = message.strip_prefix(PREFIX) else { return Ok(()) };
            let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() else { return Ok(()) };
            let found = paths(&args2).unwrap_or_default();
            let mut drops = DROPS.lock().unwrap();
            drops.push((token.to_string(), found));
            if drops.len() > KEEP {
                drops.remove(0);
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_WebMessageReceived(&handler, &mut token);
    });
}
