use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Ptys {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

#[derive(Clone, serde::Serialize)]
struct ExitEvent {
    id: u32,
}

fn shell_command(cwd: &str) -> CommandBuilder {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    // 로그인 셸로 띄워야 GUI 앱에서도 사용자의 PATH(.zprofile 등)가 잡힌다.
    cmd.arg("-l");
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Finder/Dock에서 실행한 앱은 LANG이 없어서 한글이 깨진다.
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    cmd
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    ptys: State<'_, Ptys>,
    cwd: String,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(shell_command(&cwd)).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = ptys.next_id.fetch_add(1, Ordering::Relaxed);

    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                // 바이트 그대로 보낸다. 여기서 문자열로 바꾸면 경계에 걸린 한글이 깨진다.
                Ok(n) => {
                    if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = app.emit("pty-exit", ExitEvent { id });
    });

    ptys.sessions
        .lock()
        .unwrap()
        .insert(id, Session { master: pair.master, writer, child });
    Ok(id)
}

#[tauri::command]
pub fn pty_write(ptys: State<'_, Ptys>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = ptys.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("no such pty")?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(ptys: State<'_, Ptys>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = ptys.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such pty")?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(ptys: State<'_, Ptys>, id: u32) -> Result<(), String> {
    if let Some(mut session) = ptys.sessions.lock().unwrap().remove(&id) {
        let _ = session.child.kill();
        // 좀비 프로세스가 남지 않게 거둔다. 오래 걸릴 수 있어서 별도 스레드에서.
        std::thread::spawn(move || {
            let _ = session.child.wait();
        });
    }
    Ok(())
}
