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

// 셸 한 단어로 감싼다: 작은따옴표 안에서는 아무것도 해석되지 않고, 작은따옴표 자체만 '\''로 끊어 넣는다.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// command가 있으면 (작업그룹 세션) 셸 안에서 그 명령을 실행하고, 끝나면 그 자리에 셸을 띄운다.
// 셸을 거쳐야 .zshrc 등에서 잡는 PATH로 claude·codex를 찾는다. CLI를 끝내도 창이 닫히지 않고 셸이 남는다.
fn shell_command(cwd: &str, command: Option<&[String]>) -> CommandBuilder {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    // 로그인 셸로 띄워야 GUI 앱에서도 사용자의 PATH(.zprofile 등)가 잡힌다.
    cmd.arg("-l");
    if let Some(argv) = command.filter(|a| !a.is_empty()) {
        let line = argv.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" ");
        cmd.args(["-i", "-c", &format!("{line}; exec {} -l", sh_quote(&shell))]);
    }
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
    command: Option<Vec<String>>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(shell_command(&cwd, command.as_deref())).map_err(|e| e.to_string())?;
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

#[cfg(test)]
mod tests {
    use super::*;

    // 감싼 인자를 실제 셸에 넘겨서 그대로 돌아오는지 본다.
    #[test]
    fn quoting_survives_shell() {
        let args = ["it's", "a b", "$HOME", "\"q\"", "`x`", "\\n", "한글"];
        let line = args.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" ");
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &format!("printf '%s\\n' {line}")])
            .output()
            .unwrap();
        let got: Vec<String> = String::from_utf8(out.stdout).unwrap().lines().map(String::from).collect();
        assert_eq!(got, args);
    }
}
