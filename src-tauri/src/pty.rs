use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};

// 셸이 줄 편집을 맡기 전(프롬프트가 뜨기 전)이나 read·input()·비밀번호 입력 같은 줄 단위 입력에서는 OS의 tty가
// 지우기(DEL)를 처리한다. IUTF8이 꺼져 있으면 한 바이트만 지워서 한글(UTF-8 3바이트)이 깨진다 ("ㅎ⌫" → 2바이트 남음).
// macOS 기본 PTY에는 꺼져 있다 (Terminal.app은 켠다). master에서 바꿔도 같은 tty 설정이다.
#[cfg(target_os = "macos")]
fn enable_utf8_erase(master: &dyn MasterPty) -> Result<(), String> {
    let fd = master.as_raw_fd().ok_or("pty fd 없음")?;
    // tcgetattr로 채운 뒤 쓰므로 0으로 시작해도 된다
    let mut t: libc::termios = unsafe { std::mem::zeroed() };
    if unsafe { libc::tcgetattr(fd, &mut t) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    t.c_iflag |= libc::IUTF8;
    if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &t) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn enable_utf8_erase(_master: &dyn MasterPty) -> Result<(), String> {
    Ok(())
}

// 자식 프로세스. 거두기는 끝내기(terminate)만 한다: 신호를 다 보낸 뒤에 거둔다. 거두지 않은 자식은 끝났어도
// 좀비로 PID를 쥐고 있어서, 그 번호는 다른 프로세스에도 새 프로세스 그룹에도 쓰이지 않는다. 그래서 자식(그룹
// 리더)이 먼저 끝나도 그 그룹에 남은 프로세스에게 안전하게 보낼 수 있다 (리뷰 P1: portable-pty의 clone_killer는
// 확인 없이 저장한 PID에 보낸다. 후속 P2: 부모가 먼저 끝나면 SIGHUP을 무시하는 자식이 남았다).
struct Proc {
    child: Box<dyn Child + Send + Sync>,
    reaped: bool,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    proc: Arc<Mutex<Proc>>,
}

#[derive(Default)]
pub struct Ptys {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

// 셸 한 단어로 감싼다: 작은따옴표 안에서는 아무것도 해석되지 않고, 작은따옴표 자체만 '\''로 끊어 넣는다.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// command가 있으면 (작업그룹 세션) 셸 안에서 그 명령을 실행하고, 끝나면 그 자리에 셸을 띄운다.
// 셸을 거쳐야 .zshrc 등에서 잡는 PATH로 claude·codex를 찾는다. CLI를 끝내도 창이 닫히지 않고 셸이 남는다.
// shell_after가 false면 (작업그룹 준비 스크립트) 셸을 띄우지 않아서 PTY의 종료 코드가 그 명령의 종료 코드다.
// fallback: command가 실패하면 새로 시작할지 물어보고 y면 돌릴 명령 (복원한 세션: 이어서 하기가 안 되면 처음처럼).
// 묻는 이유: 시작하자마자 실패한 것(이어 갈 대화 없음)과 이어 받아 쓰다가 0이 아닌 코드로 끝난 것(Ctrl-C 130 등)을
// 구분할 수 없어서, 자동으로 새로 시작하면 쓰던 세션을 끝낸 뒤 새 세션이 뜬다 (리뷰 P2).
fn shell_command(cwd: &str, command: Option<&[String]>, fallback: Option<&[String]>, shell_after: bool) -> CommandBuilder {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    // 로그인 셸로 띄워야 GUI 앱에서도 사용자의 PATH(.zprofile 등)가 잡힌다.
    cmd.arg("-l");
    if let Some(argv) = command.filter(|a| !a.is_empty()) {
        let quote = |argv: &[String]| argv.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" ");
        let mut line = quote(argv);
        if let Some(other) = fallback.filter(|a| !a.is_empty()) {
            let ask = "printf '\\n[ddak] Could not continue the previous session (exit %s). Start a new one? [y/N] ' \"$code\"";
            line = format!("{line} || {{ code=$?; {ask}; read -r answer; case \"$answer\" in [yY]*) {};; esac; }}", quote(other));
        }
        let script = if shell_after { format!("{line}; exec {} -l", sh_quote(&shell)) } else { line };
        cmd.args(["-i", "-c", &script]);
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

// 자식이 끝날 때까지 거두지 않고 기다린다 (waitid WNOWAIT). 끝난 자식은 거둘 때까지 좀비로 남아 PID가 그대로다.
// 종료 코드는 거두지 않고 siginfo에서 읽는다. 시그널로 끝났거나 모르면 (ECHILD: 끝내기가 이미 거둠) None.
fn wait_exit(pid: u32) -> Option<u32> {
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let r = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) };
        if r == 0 {
            return (info.si_code == libc::CLD_EXITED).then(|| unsafe { info.si_status() } as u32);
        }
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return None;
        }
    }
}

// PTY를 열고 명령을 띄운다. 출력은 output으로 보내고, 출력이 끝나면 (또는 자식이 끝난 뒤 잠시 기다려도 출력이
// 끝나지 않으면: 손자가 터미널을 쥐고 있음) 종료 코드를 exited로 한 번 보낸다. 시그널로 끝났거나 모르면 None.
fn spawn(
    cwd: &str,
    command: Option<&[String]>,
    fallback: Option<&[String]>,
    shell_after: bool,
    size: PtySize,
    mut output: impl FnMut(Vec<u8>) -> bool + Send + 'static,
    exited: impl FnOnce(Option<u32>) + Send + 'static,
) -> Result<Session, String> {
    // portable-pty는 작업 폴더가 없으면 오류 없이 홈 폴더에서 띄운다 (cmdbuilder.rs as_command). 준비 스크립트나
    // CLI가 엉뚱한 폴더에서 돌지 않게 먼저 막는다.
    if !Path::new(cwd).is_dir() {
        return Err(format!("{cwd}: no such folder"));
    }
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;
    enable_utf8_erase(&*pair.master)?;
    let child = pair.slave.spawn_command(shell_command(cwd, command, fallback, shell_after)).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let pid = child.process_id();
    let proc = Arc::new(Mutex::new(Proc { child, reaped: false }));
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let (read_done, output_ended) = channel::<()>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                // 바이트 그대로 보낸다. 여기서 문자열로 바꾸면 경계에 걸린 한글이 깨진다.
                Ok(n) => {
                    if !output(buf[..n].to_vec()) {
                        break;
                    }
                }
            }
        }
        let _ = read_done.send(());
    });
    std::thread::spawn(move || {
        let code = pid.and_then(wait_exit);
        // 남은 출력을 먼저 보내도록 출력이 끝나기를 잠시 기다린다
        let _ = output_ended.recv_timeout(Duration::from_millis(500));
        exited(code);
    });
    Ok(Session { master: pair.master, writer, proc })
}

// 끝내기: 자식의 프로세스 그룹에 SIGHUP, 0.25초 안에 그룹이 비지 않으면 SIGKILL, 그 뒤 자식을 거둔다 (리뷰 P2:
// SIGHUP을 무시하는 준비 스크립트가 계속 돌았다). 준비 스크립트는 셸이 exec로 바뀌어 자식이 그룹 리더이고 그
// 자식들도 같은 그룹이다. 거두기 전이라 리더가 끝났어도 그룹 ID는 다시 쓰이지 않는다 (Proc).
fn terminate(proc: &Mutex<Proc>) {
    let mut p = proc.lock().unwrap();
    let Some(pid) = p.child.process_id().map(|id| id as i32).filter(|_| !p.reaped) else {
        return;
    };
    let group_alive = || unsafe { libc::kill(-pid, 0) } == 0;
    // 그룹이 없으면 (자식이 그룹을 바꿈) 자식에게만
    if unsafe { libc::kill(-pid, libc::SIGHUP) } != 0 {
        unsafe { libc::kill(pid, libc::SIGHUP) };
    }
    for _ in 0..5 {
        if !group_alive() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    if group_alive() {
        unsafe { libc::kill(-pid, libc::SIGKILL) };
    }
    // 리더가 그룹을 옮겼어도 끝낸다 (거두기 전이라 안전)
    unsafe { libc::kill(pid, libc::SIGKILL) };
    let _ = p.child.wait();
    p.reaped = true;
}

// 종료는 출력과 같은 채널로 보낸다 ({"exit": 코드}). 채널은 보낸 순서대로 전달되고 프론트가 spawn을 부르기 전에
// 만들어 두므로, 생성 응답(id)보다 먼저 끝나도 잃지 않는다 (리뷰 P2: 전역 이벤트는 id를 받기 전이면 버려졌다).
#[tauri::command]
pub fn pty_spawn(
    ptys: State<'_, Ptys>,
    cwd: String,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    command: Option<Vec<String>>,
    fallback: Option<Vec<String>>,
    shell_after: Option<bool>,
) -> Result<u32, String> {
    let on_exit = on_data.clone();
    let session = spawn(
        &cwd,
        command.as_deref(),
        fallback.as_deref(),
        shell_after.unwrap_or(true),
        PtySize { rows, cols, pixel_width: 0, pixel_height: 0 },
        move |bytes| on_data.send(InvokeResponseBody::Raw(bytes)).is_ok(),
        move |code| {
            let _ = on_exit.send(InvokeResponseBody::Json(serde_json::json!({ "exit": code }).to_string()));
        },
    )?;
    let id = ptys.next_id.fetch_add(1, Ordering::Relaxed);
    ptys.sessions.lock().unwrap().insert(id, session);
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
    // 기다림이 길 수 있어 (SIGHUP 뒤 유예) 따로 돌린다. 터미널(master)은 끝낼 때까지 들고 있는다.
    if let Some(session) = ptys.sessions.lock().unwrap().remove(&id) {
        std::thread::spawn(move || {
            terminate(&session.proc);
            drop(session);
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 셸 줄 편집 전·read 같은 줄 단위 입력에서 지우기(DEL)가 한글 한 글자를 통째로 지운다.
    // 자체 테스트의 간헐 실패 "[??한글]"의 원인 (프롬프트 전에 친 "ㅎ"의 3바이트 중 1바이트만 지워졌다).
    #[test]
    fn erase_removes_whole_utf8_char() {
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        enable_utf8_erase(&*pair.master).unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "IFS= read -r l; printf '<%s>' \"$l\""]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        // 읽기는 따로 돌린다 (자식이 끝나도 master 읽기가 끝나지 않을 수 있다)
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 256];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        writer.write_all("[ㅎ\x7f하\n".as_bytes()).unwrap();
        let mut out = Vec::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !String::from_utf8_lossy(&out).contains('>') && std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(100)) {
                out.extend(chunk);
            }
        }
        let _ = child.kill();
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("<[하>"), "{text:?}");
    }

    const SIZE: PtySize = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };

    // spawn으로 띄우고 출력은 모아 두고 종료 코드는 채널로 받는다
    fn start(argv: &[&str]) -> (Session, Arc<Mutex<Vec<u8>>>, std::sync::mpsc::Receiver<Option<u32>>) {
        start_or(argv, &[])
    }

    // fallback: argv가 실패하면 돌릴 명령 (비면 없음)
    fn start_or(argv: &[&str], fallback: &[&str]) -> (Session, Arc<Mutex<Vec<u8>>>, std::sync::mpsc::Receiver<Option<u32>>) {
        let fallback: Vec<String> = fallback.iter().map(|a| a.to_string()).collect();
        let argv: Vec<String> = argv.iter().map(|a| a.to_string()).collect();
        let out = Arc::new(Mutex::new(Vec::new()));
        let sink = out.clone();
        let (tx, rx) = channel();
        let session = spawn(
            "/",
            Some(&argv),
            Some(&fallback),
            false,
            SIZE,
            move |bytes| {
                sink.lock().unwrap().extend(bytes);
                true
            },
            move |code| {
                let _ = tx.send(code);
            },
        )
        .unwrap();
        (session, out, rx)
    }

    // 준비 스크립트처럼 셸을 띄우지 않으면 PTY의 종료 코드가 그 명령의 종료 코드다 (로그인·대화형 셸을 거쳐도).
    #[test]
    fn exit_code_without_shell_after() {
        let (session, _, exited) = start(&["/bin/sh", "-c", "exit 3"]);
        let code = exited.recv_timeout(Duration::from_secs(20));
        terminate(&session.proc);
        assert_eq!(code, Ok(Some(3)), "명령이 끝난 뒤에도 프로세스가 끝나지 않음");
    }

    // 복원한 세션: 이어서 하기 명령이 실패하면 물어보고, y일 때만 처음 명령을 돌린다 (리뷰 P2)
    #[test]
    fn fallback_asks_before_starting_fresh() {
        let answer = |reply: &str| {
            let (mut session, out, exited) = start_or(&["/bin/sh", "-c", "exit 130"], &["/bin/sh", "-c", "exit 5"]);
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            while !String::from_utf8_lossy(&out.lock().unwrap()).contains("[y/N]") {
                assert!(std::time::Instant::now() < deadline, "묻지 않음");
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(String::from_utf8_lossy(&out.lock().unwrap()).contains("(exit 130)"));
            session.writer.write_all(reply.as_bytes()).unwrap();
            let code = exited.recv_timeout(Duration::from_secs(20));
            terminate(&session.proc);
            code
        };
        assert_eq!(answer("y\n"), Ok(Some(5)), "y면 새로 시작");
        assert_eq!(answer("\n"), Ok(Some(0)), "기본은 시작하지 않음");
        // 이어서 하기가 되면 묻지 않는다
        let (session, out, exited) = start_or(&["/bin/sh", "-c", "exit 0"], &["/bin/sh", "-c", "exit 5"]);
        assert_eq!(exited.recv_timeout(Duration::from_secs(20)), Ok(Some(0)));
        assert!(!String::from_utf8_lossy(&out.lock().unwrap()).contains("[y/N]"));
        terminate(&session.proc);
    }

    // 없는 작업 폴더에서는 띄우지 않는다 (portable-pty는 홈 폴더로 바꿔 띄운다)
    #[test]
    fn missing_cwd_fails() {
        let argv = ["/bin/pwd".to_string()];
        let r = spawn("/no/such/ddak-dir", Some(&argv), None, false, SIZE, |_| true, |_| {});
        assert!(r.is_err());
    }

    // 끝난 자식은 끝내기 전까지 거두지 않는다 (좀비로 PID를 쥔다). 그래서 끝내기가 보내는 신호는 거둔 PID·
    // 다시 쓰인 그룹 ID로 가지 않는다 (리뷰 P1, 후속 P2).
    #[test]
    fn child_stays_unreaped_until_terminate() {
        let (session, _, exited) = start(&["/bin/sh", "-c", "exit 0"]);
        let pid = session.proc.lock().unwrap().child.process_id().unwrap() as i32;
        assert_eq!(exited.recv_timeout(Duration::from_secs(20)), Ok(Some(0)));
        let zombie = unsafe { libc::kill(pid, 0) } == 0;
        terminate(&session.proc);
        let gone = unsafe { libc::kill(pid, 0) } != 0;
        assert!(zombie, "끝내기 전에 거둠");
        assert!(gone, "끝내기가 거두지 않음");
    }

    // 거둔 뒤 같은 PID를 다른 프로세스가 받은 상황: 두 번째 끝내기는 신호를 보내지 않는다.
    #[derive(Debug)]
    struct Other(u32);
    impl portable_pty::ChildKiller for Other {
        fn kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(Other(self.0))
        }
    }
    impl Child for Other {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            Ok(Some(portable_pty::ExitStatus::with_exit_code(0)))
        }
        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            Ok(portable_pty::ExitStatus::with_exit_code(0))
        }
        fn process_id(&self) -> Option<u32> {
            Some(self.0)
        }
    }

    #[test]
    fn terminate_never_signals_reaped_pid() {
        let mut other = std::process::Command::new("/bin/sleep").arg("5").spawn().unwrap();
        terminate(&Mutex::new(Proc { child: Box::new(Other(other.id())), reaped: true }));
        std::thread::sleep(Duration::from_millis(100));
        let alive = other.try_wait().unwrap().is_none();
        let _ = other.kill();
        let _ = other.wait();
        assert!(alive, "다른 프로세스가 신호를 받아 끝남");
    }

    // 부모 셸은 SIGHUP에 끝나고 그 자식만 무시하는 경우도 끝내기 뒤에는 멈춘다 (리뷰 후속 P2). 부모가 끝나면
    // 터미널이 끊겨 출력으로는 알 수 없어서 파일에 쓴다.
    #[test]
    fn terminate_stops_hup_ignoring_child_after_parent_exits() {
        let log = std::env::temp_dir().join(format!("ddak-hup-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&log);
        let script = format!("(trap '' HUP; while :; do echo t >> '{}'; sleep 0.05; done) & wait", log.display());
        let (session, _, exited) = start(&["/bin/sh", "-c", &script]);
        let size = || std::fs::metadata(&log).map(|m| m.len()).unwrap_or(0);
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while size() == 0 {
            assert!(std::time::Instant::now() < deadline, "자식이 쓰지 않음");
            std::thread::sleep(Duration::from_millis(50));
        }
        terminate(&session.proc);
        let _ = exited.recv_timeout(Duration::from_secs(3));
        std::thread::sleep(Duration::from_millis(200));
        let before = size();
        std::thread::sleep(Duration::from_millis(600));
        let after = size();
        let _ = std::fs::remove_file(&log);
        assert_eq!(before, after, "부모가 끝난 뒤 남은 자식이 계속 씀");
    }

    // SIGHUP을 무시하는 준비 스크립트도 끝내기 뒤에는 멈춘다 (리뷰 P2). 스크립트의 자식(sleep)도 같은 그룹이다.
    #[test]
    fn terminate_stops_hup_ignoring_script() {
        let (session, out, exited) = start(&["/bin/sh", "-c", "trap '' HUP; while :; do echo tick; sleep 0.1; done"]);
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !String::from_utf8_lossy(&out.lock().unwrap()).contains("tick") {
            assert!(std::time::Instant::now() < deadline, "출력이 오지 않음");
            std::thread::sleep(Duration::from_millis(50));
        }
        terminate(&session.proc);
        let code = exited.recv_timeout(Duration::from_secs(3));
        std::thread::sleep(Duration::from_millis(200));
        let before = out.lock().unwrap().len();
        std::thread::sleep(Duration::from_millis(600));
        let after = out.lock().unwrap().len();
        assert_eq!(before, after, "끝낸 뒤에도 출력이 이어짐");
        assert_eq!(code, Ok(None), "시그널로 끝났으니 종료 코드 없음");
    }

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
