// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 작업그룹 준비 창에서 도우미로 띄운 경우 (src/setup.rs): 창을 열지 않고 준비만 하고 끝낸다
    if let Some(code) = ddak_lib::setup_helper() {
        std::process::exit(code);
    }
    ddak_lib::run()
}
