// Windows: 메뉴 단축키 (Ctrl+T, Ctrl+= 등). 웹뷰에 포커스가 있으면 키 입력은 WebView2로 가서 Tauri의 메뉴 단축키
// 처리(앱 메시지 루프의 TranslateAcceleratorW 훅)에 오지 않는다 (실험 2026-10-28: 메뉴 클릭은 되는데 단축키는 안 됨).
// WebView2가 페이지보다 먼저 알려 주는 AcceleratorKeyPressed에서 메뉴 단축키 표(menu::shortcuts)와 맞춰 보고,
// 같으면 페이지에 넘기지 않고 그 메뉴 항목을 실행한다. 그래서 메뉴의 키는 터미널 프로그램에 가지 않는다
// (docs/windows-plan.md W3). 표에 없는 키(Ctrl+C·Ctrl+V·Ctrl+1~9 등)는 그대로 페이지로 간다.

use tauri::{AppHandle, Runtime};
use webview2_com::AcceleratorKeyPressedEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};

fn down(key: u16) -> bool {
    unsafe { GetKeyState(key as i32) < 0 }
}

pub fn install<R: Runtime>(window: &tauri::WebviewWindow<R>, app: AppHandle<R>) {
    let _ = window.with_webview(move |webview| unsafe {
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
            args.KeyEventKind(&mut kind)?;
            if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN {
                return Ok(());
            }
            let mut key = 0u32;
            args.VirtualKey(&mut key)?;
            let (ctrl, shift, alt) = (down(VK_CONTROL), down(VK_SHIFT), down(VK_MENU));
            let Some((id, _)) = crate::menu::shortcuts().find(|(_, s)| crate::menu::shortcut_matches(s, ctrl, shift, alt, key)) else {
                return Ok(());
            };
            args.SetHandled(true)?;
            // 이 처리기는 메인 스레드에서 돈다. 창 닫기는 Tauri가 이벤트 루프로 미뤄서(window.close → proxy.send_event)
            // 웹뷰 이벤트 처리 안에서 창이 없어지지 않는다. 나머지는 프론트에 "menu" 이벤트를 보낼 뿐이다.
            crate::menu::run(&app, id);
            Ok(())
        }));
        let mut token = 0i64;
        let _ = webview.controller().add_AcceleratorKeyPressed(&handler, &mut token);
    });
}
