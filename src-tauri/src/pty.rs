use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

#[cfg(unix)]
use portable_pty::native_pty_system;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
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

#[cfg(all(unix, not(target_os = "macos")))]
fn enable_utf8_erase(_master: &dyn MasterPty) -> Result<(), String> {
    Ok(())
}

// 자식 프로세스. 거두기는 끝내기(terminate)만 한다: 세션이 다 끝난 뒤에 거둔다. 거두지 않은 자식은 끝났어도
// 좀비로 PID를 쥐고 있어서, 그 번호는 다른 프로세스에도 새 그룹·세션에도 쓰이지 않는다. 그래서 자식(세션 리더)이
// 먼저 끝나도 그 세션에 남은 프로세스를 안전하게 찾고 보낼 수 있다 (리뷰 P1: portable-pty의 clone_killer는
// 확인 없이 저장한 PID에 보낸다. 후속 P2: 부모가 먼저 끝나면 SIGHUP을 무시하는 자식이 남았다).
// Windows는 자식이 끝나면 PID가 바로 다시 쓰일 수 있어서 PID 대신 터미널마다의 Job으로 찾는다 (conpty.rs).
struct Proc {
    child: Box<dyn Child + Send + Sync>,
    reaped: bool,
    #[cfg(windows)]
    job: crate::conpty::Job,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    proc: Arc<Mutex<Proc>>,
    // 띄운 폴더 (실제 경로). 작업그룹을 끝낼 때 그 폴더의 세션을 찾는다 (stop_under).
    cwd: PathBuf,
    // 목록에서 빠질 때 (닫기·작업그룹 끝내기) 부른다. 채팅방에서 나간다 (pty_spawn).
    leave: Option<Box<dyn FnOnce() + Send>>,
    // 채팅방 참여 토큰 (깨울 터미널을 찾는다)
    chat_token: Option<String>,
    // 사용자의 마지막 입력 (깨우기가 입력 중인지 본다)
    input: Input,
    // 앞에서 도는 프로그램이 사용자를 기다린다 (권한 확인·선택 창 등. 프론트가 알린다, pty_awaiting). 그동안 깨우지 않는다.
    // awaiting_changed: 마지막으로 바뀐 때, awaiting_changes: 바뀐 횟수 (기다리는 동안 친 키를 초안과 구분한다. 확인 사이에
    // 기다림이 시작되고 끝나도 횟수로 안다)
    awaiting: bool,
    // 무엇을 기다리는지 (permission·question·auth·dialog·blocked. 폰의 참여자 칩, mobile.rs)
    awaiting_kind: String,
    awaiting_changed: Option<Instant>,
    awaiting_changes: u64,
    // 알림을 쓰고 Enter를 보낼 차례를 기다린다 (wake_tick)
    enter: Option<Enter>,
    // claude 훅으로 "사용자를 기다림"을 알린 때 (뒤따라 켜진 상태의 기다림이 같은 확인인지 본다, set_awaiting)
    hook_attention: Option<Instant>,
    // 앞에서 도는 프로그램이 작업 중이다 (OSC 7501 working, 프론트가 알린다). 하나라도 있으면 잠자기를 막는다 (keep_awake)
    working: bool,
}

// 알림을 쓴 뒤 보낼 Enter. at: 알림을 쓴 때, before: 그때의 사용자 입력, force: 바로 깨우기(사용자가 누름)라 기다려도 보냄,
// changes: 그때의 기다림 변경 횟수 (달라졌으면 그 뒤 프로그램이 사용자를 기다린 적이 있다)
#[derive(Clone, Copy)]
struct Enter {
    at: Instant,
    before: Input,
    force: bool,
    changes: u64,
}

// 사용자 입력 (pty_write). 깨우기는 치는 중(선택지를 고르는 중 포함)에 끼어들지 않게, IDLE 동안 입력이 없을 때만 알림을
// 입력한다. 마지막 키가 Enter인지는 보지 않는다: 쓰다가 지운 경우 영원히 기다렸다. 쓰다 남긴 초안이 있으면 알림이 그 뒤에
// 붙는다 (사용자는 채팅으로 명령하는 것을 기본으로 한다).
#[derive(Clone, Copy, PartialEq, Debug)]
struct Input {
    last: Option<Instant>,
}

impl Input {
    const NONE: Input = Input { last: None };

    fn typed(&mut self, now: Instant) {
        self.last = Some(now);
    }

    fn quiet(&self, now: Instant) -> bool {
        self.last.is_none_or(|t| now.duration_since(t) >= WAKE_IDLE)
    }
}

// 깨우기 (docs/spec.md "채팅방 설계"): 멘션된 세션의 터미널에 알림 문구를 쓰고 WAKE_GAP 뒤에 Enter를 따로 보낸다
// (한 번에 보내면 claude가 붙여넣기로 봐서 제출하지 않는다. docs/reviews/2026-10-24-chat-wake-experiment.md).
pub const WAKE_IDLE: Duration = Duration::from_secs(3);
const WAKE_GAP: Duration = Duration::from_millis(300);
// claude 훅의 알림 뒤 이 안에 켜진 상태의 기다림은 같은 확인으로 본다 (set_awaiting). 훅은 확인이 뜬 지 약 6초 뒤에 오고
// 상태는 보통 먼저 오지만 순서 보장은 없다
const ATTENTION_GAP: Duration = Duration::from_secs(10);

fn wake_notice(from: &[String]) -> String {
    format!(
        "[ddak] New chat message from {}. Read it with the ddak read_messages tool. Post with post_message only what moves the work: a result someone asked for, a needed request or question, or a concrete blocker. Do not post acknowledgements. @mention only someone who must act next or who asked for what you deliver.",
        from.join(", ")
    )
}

// 깨우기를 기다리는 터미널: 보낸 사람들, 바로 깨우기 (사용자가 누름)
#[derive(Default)]
struct Pending {
    from: Vec<String>,
    now: bool,
}

impl Session {
    fn left(&mut self) {
        if let Some(leave) = self.leave.take() {
            leave();
        }
    }
}

// 터미널 목록. 잠그는 순서는 ending → sessions → closing.
#[derive(Default)]
pub struct Ptys {
    next_id: AtomicU32,
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
    // 닫았지만 아직 다 끝나지 않은 터미널 (프로세스, 띄운 폴더). 다 끝나면 빠진다. 작업그룹을 끝낼 때 이것도 기다린다
    // (리뷰 후속 P1: 먼저 닫은 터미널의 백그라운드 작업을 놓쳤다).
    closing: Arc<Mutex<HashMap<u32, (Arc<Mutex<Proc>>, PathBuf)>>>,
    // 끝내는 중인 작업그룹 폴더. 그 안에는 새 터미널을 띄우지 않는다 (리뷰 후속 P1: 확인 뒤 새로 뜬 터미널이 커밋했다).
    // 띄우기는 읽기로 잡은 채 확인·띄우기·등록을 하고, 잠그기는 쓰기로 잡으므로 띄우는 중인 것은 등록을 마친 뒤에 잠근다.
    ending: RwLock<Vec<PathBuf>>,
    // 깨우기를 기다리는 터미널 (wake, wake_tick)
    wakes: Mutex<HashMap<u32, Pending>>,
    // 작업 중인 터미널이 있는 동안 띄워 두는 caffeinate (keep_awake)
    awake: Mutex<Option<crate::platform::KeepAwake>>,
    // 깨우기 상태 변경 번호. wakes를 잡은 채 매긴다. 이벤트는 잠금 밖에서 보내 순서가 바뀔 수 있어서, 프론트가 터미널마다
    // 더 오래된 번호를 버린다 (리뷰 P2: 앞 깨우기의 해제가 새 대기를 지웠다).
    wake_seq: AtomicU64,
}

// 셸 한 단어로 감싼다: 작은따옴표 안에서는 아무것도 해석되지 않고, 작은따옴표 자체만 '\''로 끊어 넣는다.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// claude 세션이 자기 하위 프로세스에 넣는 표시 (대화 기록 저장을 끄는 CLAUDE_CODE_CHILD_SESSION, 그 세션의 ID·메시지 소켓 등).
// ddak이 claude 안에서 떴으면 (개발, claude 안에서 돌린 install.sh가 다시 연 앱) 이것을 물려받아 터미널의 claude까지 하위 세션으로
// 보고 기록을 저장하지 않았다 (2026-10-25 실제로 남). 터미널에는 넘기지 않는다.
// 이름으로 고른다: 같은 접두사에 사용자 설정(CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_MAX_OUTPUT_TOKENS 등)이 있다 (리뷰 R1: 접두사로
// 지웠더니 설정도 지웠다). 목록은 그때 claude 안에서 띄운 앱의 환경에서 본 것. CLAUDE_EFFORT도 있었지만 사용자 설정일 수 있어
// 남긴다. scripts/install.sh의 목록과 같아야 한다 (테스트가 확인).
pub const CLAUDE_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
];

fn is_claude_session_var(key: &str) -> bool {
    CLAUDE_SESSION_VARS.contains(&key)
}

fn strip_claude_session_vars(cmd: &mut CommandBuilder, keys: impl Iterator<Item = String>) {
    for key in keys.filter(|k| is_claude_session_var(k)) {
        cmd.env_remove(key);
    }
}

// command가 있으면 (작업그룹 세션) 셸 안에서 그 명령을 실행하고, 끝나면 그 자리에 셸을 띄운다.
// 셸을 거쳐야 .zshrc 등에서 잡는 PATH로 claude·codex를 찾는다. CLI를 끝내도 창이 닫히지 않고 셸이 남는다.
// shell_after가 false면 (작업그룹 준비 스크립트) 셸을 띄우지 않아서 PTY의 종료 코드가 그 명령의 종료 코드다.
// fallback: command가 실패하면 새로 시작할지 물어보고 y면 돌릴 명령 (복원한 세션: 이어서 하기가 안 되면 처음처럼).
// 묻는 이유: 시작하자마자 실패한 것(이어 갈 대화 없음)과 이어 받아 쓰다가 0이 아닌 코드로 끝난 것(Ctrl-C 130 등)을
// 구분할 수 없어서, 자동으로 새로 시작하면 쓰던 세션을 끝낸 뒤 새 세션이 뜬다 (리뷰 P2).
// Windows는 Git Bash (docs/windows-plan.md W2). 셸 경로가 C:\…여도 sh_quote로 감싸면 bash가 그대로 받는다.
fn shell_command(cwd: &str, command: Option<&[String]>, fallback: Option<&[String]>, shell_after: bool) -> Result<CommandBuilder, String> {
    let shell = crate::platform::user_shell()?.to_string_lossy().into_owned();
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
    strip_claude_session_vars(&mut cmd, std::env::vars_os().filter_map(|(k, _)| k.into_string().ok()));
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Finder/Dock에서 실행한 앱은 LANG이 없어서 한글이 깨진다.
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    Ok(cmd)
}

// 자식이 끝날 때까지 거두지 않고 기다린다 (waitid WNOWAIT). 끝난 자식은 거둘 때까지 좀비로 남아 PID가 그대로다.
// 종료 코드는 거두지 않고 siginfo에서 읽는다. 시그널로 끝났거나 모르면 (ECHILD: 끝내기가 이미 거둠) None.
#[cfg(unix)]
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

// Windows: 끝날 때까지 자식 핸들을 본다 (거두기·좀비가 없어 잠금을 오래 쥐지 않게 짧게 나눠 본다)
#[cfg(windows)]
fn wait_exit_windows(proc: &Mutex<Proc>) -> Option<u32> {
    loop {
        match proc.lock().unwrap().child.try_wait() {
            Ok(Some(status)) => return Some(status.exit_code()),
            Ok(None) => {}
            Err(_) => return None,
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

// 플랫폼마다 PTY를 열고 띄운다: 맥은 portable-pty, Windows는 Job 안에서 띄우는 ConPTY (conpty.rs)
#[cfg(unix)]
fn open_and_spawn(cmd: CommandBuilder, size: PtySize) -> Result<(Box<dyn MasterPty + Send>, Proc), String> {
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;
    enable_utf8_erase(&*pair.master)?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    Ok((pair.master, Proc { child, reaped: false }))
}

#[cfg(windows)]
fn open_and_spawn(cmd: CommandBuilder, size: PtySize) -> Result<(Box<dyn MasterPty + Send>, Proc), String> {
    let job = crate::conpty::Job::new()?;
    let (master, child) = crate::conpty::spawn(&cmd, size, &job)?;
    Ok((Box::new(master), Proc { child: Box::new(child), reaped: false, job }))
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
    let real = crate::platform::canonical(cwd).map_err(|e| e.to_string())?;
    let (master, proc) = open_and_spawn(shell_command(cwd, command, fallback, shell_after)?, size)?;
    #[cfg(unix)]
    let pid = proc.child.process_id();
    let proc = Arc::new(Mutex::new(proc));
    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = master.take_writer().map_err(|e| e.to_string())?;

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
    #[cfg(windows)]
    let waited = proc.clone();
    std::thread::spawn(move || {
        #[cfg(unix)]
        let code = pid.and_then(wait_exit);
        #[cfg(windows)]
        let code = wait_exit_windows(&waited);
        // 남은 출력을 먼저 보내도록 출력이 끝나기를 잠시 기다린다
        let _ = output_ended.recv_timeout(Duration::from_millis(500));
        exited(code);
    });
    Ok(Session { master, writer, proc, cwd: real, leave: None, chat_token: None, input: Input::NONE, awaiting: false, awaiting_kind: String::new(), awaiting_changed: None, awaiting_changes: 0, enter: None, hook_attention: None, working: false })
}

// 이 세션(setsid로 만든 세션, ID = 자식 PID)에 남은 프로세스. 좀비는 아무것도 못 하니 뺀다.
#[cfg(target_os = "macos")]
fn session_members(sid: i32) -> Vec<i32> {
    const SZOMB: u32 = 5; // sys/proc.h
    let alive = |pid: i32| {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
        n == size && info.pbi_status != SZOMB
    };
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    let mut pids = vec![0 as libc::pid_t; count.max(0) as usize + 256];
    let bytes = (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
    let n = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    pids.truncate(n.max(0) as usize);
    pids.into_iter().filter(|&p| p > 0 && unsafe { libc::getsid(p) } == sid && alive(p)).collect()
}

// 끝내기: 이 터미널에서 띄운 프로세스를 모두 끝내고 끝날 때까지 기다린다. 자식의 프로세스 그룹만 보면, 대화형 셸이
// 작업마다 그룹을 따로 만들어서 SIGHUP을 무시하는 백그라운드 작업이 남는다 (리뷰 후속 P1). 그래서 세션(setsid,
// ID = 자식 PID) 전체에 SIGHUP(멈춘 작업도 받게 SIGCONT), 0.25초 뒤에도 남으면 SIGKILL, 좀비를 뺀 구성원이 없어질
// 때까지(최대 3초) 기다린 뒤 자식을 거둔다. 그래서 nohup으로 띄운 작업도 터미널을 닫으면 끝난다.
// 세션을 떠난 프로세스(스스로 setsid한 데몬 등)는 찾지 못한다. 다 끝나지 않았으면 거두지 않고 false
// (자식이 좀비로 세션 ID를 쥐고 있어 다시 불러도 안전하다).
#[cfg(unix)]
fn terminate(proc: &Mutex<Proc>) -> bool {
    let mut p = proc.lock().unwrap();
    let Some(sid) = p.child.process_id().map(|id| id as i32).filter(|_| !p.reaped) else {
        return true;
    };
    let signal = |sig| {
        for pid in session_members(sid) {
            unsafe { libc::kill(pid, sig) };
        }
    };
    let wait_empty = |tries: u32| {
        for _ in 0..tries {
            if session_members(sid).is_empty() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        session_members(sid).is_empty()
    };
    signal(libc::SIGHUP);
    signal(libc::SIGCONT);
    if !wait_empty(5) {
        signal(libc::SIGKILL);
        if !wait_empty(60) {
            return false;
        }
    }
    let _ = p.child.wait();
    p.reaped = true;
    true
}

// Windows: 터미널의 Job 전체를 끝내고, Job에 남은 프로세스가 0이 될 때까지 다시 본다 (docs/windows-plan.md "세션 끝내기").
// 처음부터 Job 안에서 띄워서(conpty.rs) 새로 들어올 수 있는 것은 Job 안 프로세스의 자식뿐이다. 다시 볼 때 남아 있으면
// (끝내는 사이 생긴 자식) 다시 끝낸다. 3초 안에 0이 안 되거나 수를 읽지 못하면 false (닫는 중으로 남아 다시 부른다).
#[cfg(windows)]
fn terminate(proc: &Mutex<Proc>) -> bool {
    let mut p = proc.lock().unwrap();
    if p.reaped {
        return true;
    }
    for _ in 0..60 {
        match p.job.active() {
            Some(0) => {
                let _ = p.child.wait();
                p.reaped = true;
                return true;
            }
            _ => p.job.terminate(),
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

// 터미널을 닫는다: 목록에서 닫는 중으로 옮기고 (빠지는 틈이 없게 두 목록을 함께 잡는다) 따로 끝낸다. 다 끝나면
// 닫는 중에서 뺀다. 터미널(master)은 끝낼 때까지 들고 있는다.
fn close(ptys: &Ptys, id: u32) {
    let mut session = {
        let mut sessions = ptys.sessions.lock().unwrap();
        let Some(session) = sessions.remove(&id) else {
            return;
        };
        ptys.closing.lock().unwrap().insert(id, (session.proc.clone(), session.cwd.clone()));
        session
    };
    session.left();
    let closing = ptys.closing.clone();
    std::thread::spawn(move || {
        if terminate(&session.proc) {
            closing.lock().unwrap().remove(&id);
        }
        drop(session);
    });
}

// 작업그룹 끝내기: dir을 잠근 동안 (hold) 그 안에서 띄운 터미널과 닫는 중인 터미널을 모두 끝내고 끝날 때까지 기다린다.
// 끝낸 터미널은 목록에서 빠지므로 프론트의 pty_kill은 아무것도 하지 않는다. 다 끝났으면 true.
pub fn stop_under(ptys: &Ptys, dir: &Path) -> bool {
    let (stopped, procs) = {
        let mut sessions = ptys.sessions.lock().unwrap();
        let mut closing = ptys.closing.lock().unwrap();
        let ids: Vec<u32> = sessions.iter().filter(|(_, s)| s.cwd.starts_with(dir)).map(|(id, _)| *id).collect();
        let stopped: Vec<Session> = ids.iter().filter_map(|id| sessions.remove(id)).collect();
        for (id, s) in ids.iter().zip(&stopped) {
            closing.insert(*id, (s.proc.clone(), s.cwd.clone()));
        }
        let procs: Vec<(u32, Arc<Mutex<Proc>>)> = closing.iter().filter(|(_, (_, cwd))| cwd.starts_with(dir)).map(|(id, (p, _))| (*id, p.clone())).collect();
        (stopped, procs)
    };
    let mut stopped = stopped;
    stopped.iter_mut().for_each(Session::left);
    let waits: Vec<_> = procs.into_iter().map(|(id, proc)| (id, std::thread::spawn(move || terminate(&proc)))).collect();
    let mut all = true;
    for (id, w) in waits {
        if w.join().unwrap_or(false) {
            ptys.closing.lock().unwrap().remove(&id);
        } else {
            all = false;
        }
    }
    drop(stopped);
    all
}

// dir 안에서 띄운 터미널이 남아 있는지 (닫는 중 포함)
#[cfg(all(test, unix))]
fn running_under(ptys: &Ptys, dir: &Path) -> bool {
    let sessions = ptys.sessions.lock().unwrap();
    let closing = ptys.closing.lock().unwrap();
    sessions.values().any(|s| s.cwd.starts_with(dir)) || closing.values().any(|(_, cwd)| cwd.starts_with(dir))
}

// 끝내는 동안 dir을 잠근다. 돌려받은 것을 놓으면 풀린다.
pub struct Ending<'a> {
    ptys: &'a Ptys,
    dir: PathBuf,
}

impl Drop for Ending<'_> {
    fn drop(&mut self) {
        let mut ending = self.ptys.ending.write().unwrap();
        if let Some(i) = ending.iter().position(|d| *d == self.dir) {
            ending.remove(i);
        }
    }
}

pub fn hold<'a>(ptys: &'a Ptys, dir: &Path) -> Ending<'a> {
    ptys.ending.write().unwrap().push(dir.to_path_buf());
    Ending { ptys, dir: dir.to_path_buf() }
}

// 띄우고 목록에 넣는다. 끝내는 중인 작업그룹 폴더 안이면 띄우지 않는다.
#[allow(clippy::too_many_arguments)]
fn open(
    ptys: &Ptys,
    cwd: &str,
    command: Option<&[String]>,
    fallback: Option<&[String]>,
    shell_after: bool,
    size: PtySize,
    output: impl FnMut(Vec<u8>) -> bool + Send + 'static,
    exited: impl FnOnce(Option<u32>) + Send + 'static,
    joined: Option<Joined>,
) -> Result<u32, String> {
    let (leave, chat_token): (Leave, _) = match joined {
        Some(j) => (Some(j.leave), Some(j.token)),
        None => (None, None),
    };
    let ending = ptys.ending.read().unwrap();
    let refuse = crate::platform::canonical(cwd).is_ok_and(|real| ending.iter().any(|d| real.starts_with(d)));
    let spawned = if refuse { Err(format!("{cwd}: this work group is ending")) } else { spawn(cwd, command, fallback, shell_after, size, output, exited) };
    let mut session = match spawned {
        Ok(session) => session,
        Err(e) => {
            if let Some(leave) = leave {
                leave();
            }
            return Err(e);
        }
    };
    session.leave = leave;
    session.chat_token = chat_token;
    let id = ptys.next_id.fetch_add(1, Ordering::Relaxed);
    ptys.sessions.lock().unwrap().insert(id, session);
    Ok(id)
}

// 종료는 출력과 같은 채널로 보낸다 ({"exit": 코드}). 채널은 보낸 순서대로 전달되고 프론트가 spawn을 부르기 전에
// 만들어 두므로, 생성 응답(id)보다 먼저 끝나도 잃지 않는다 (리뷰 P2: 전역 이벤트는 id를 받기 전이면 버려졌다).
// 채팅방에 참여할 세션: 프로젝트(원본 폴더)와 참여자 이름 (작업그룹/역할)
#[derive(serde::Deserialize)]
pub struct ChatJoin {
    project: String,
    name: String,
    // 창마다 고정인 키 (chat.rs Member)
    key: String,
}

type Leave = Option<Box<dyn FnOnce() + Send>>;

// 채팅방 참여: 나가기와 토큰
struct Joined {
    leave: Box<dyn FnOnce() + Send>,
    token: String,
}

// 인자의 자리표시자를 한 번에 바꾼다: {이름}은 값 그대로, {이름:toml}은 TOML 문자열 리터럴(따옴표 포함, codex -c의 값).
// 바꿔 넣은 값은 다시 보지 않는다 (값 안의 {chat} 등은 그대로. 차례로 replace하면 프롬프트 본문이 바뀌었다, 설계 리뷰 지적 2).
// vars에 없는 이름이나 중괄호(JSON 등)는 그대로 둔다.
pub fn fill_placeholders(arg: &str, vars: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(arg.len());
    let mut rest = arg;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let hit = tail[1..].find('}').and_then(|j| {
            let inner = &tail[1..1 + j];
            let (name, toml) = inner.strip_suffix(":toml").map_or((inner, false), |n| (n, true));
            vars.get(name).map(|v| (j + 2, if toml { toml_string(v) } else { v.clone() }))
        });
        match hit {
            Some((len, value)) => {
                out.push_str(&value);
                rest = &tail[len..];
            }
            None => {
                out.push('{');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

// TOML 기본 문자열 리터럴 (따옴표로 감싸고 ", \, 제어 문자를 이스케이프)
fn toml_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// 채팅방에 참여시키고 인자의 자리표시자를 바꾼다 ({chat}은 그 주소, 나머지는 vars). 나가기와 토큰을 함께 돌려준다.
fn join_chat(
    chats: Option<Arc<crate::chat::Chats>>,
    chat: Option<ChatJoin>,
    command: Option<Vec<String>>,
    fallback: Option<Vec<String>>,
    vars: HashMap<String, String>,
) -> (Option<Vec<String>>, Option<Vec<String>>, Option<Joined>) {
    let joined = chat.zip(chats).map(|(c, chats)| {
        let project = crate::platform::canonical(&c.project).unwrap_or_else(|_| PathBuf::from(&c.project));
        let (token, url, _) = chats.join(&project, &c.name, &c.key);
        let t = token.clone();
        (url, Joined { leave: Box::new(move || chats.leave(&t)), token })
    });
    let mut vars = vars;
    vars.insert("chat".into(), joined.as_ref().map_or(String::new(), |(url, _)| url.clone()));
    // 사용자를 기다린다는 신호를 보낼 주소 (claude 권한 확인 훅, src-tauri/src/chat.rs /attention/<토큰>)
    vars.insert("attention".into(), joined.as_ref().map_or(String::new(), |(url, _)| url.replacen("/mcp/", "/attention/", 1)));
    let fill = |argv: Option<Vec<String>>| argv.map(|a| a.iter().map(|x| fill_placeholders(x, &vars)).collect::<Vec<_>>());
    (fill(command), fill(fallback), joined.map(|(_, j)| j))
}

// chat이 있으면 채팅방에 참여시키고, 명령·fallback 인자의 {chat}을 그 창의 MCP 주소로 바꾼다 (src-tauri/src/chat.rs).
// 터미널이 목록에서 빠지면 나간다. 채팅 서버가 없으면 (띄우지 못함) {chat}은 빈 값이 된다.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(
    ptys: State<'_, Ptys>,
    chats: State<'_, crate::chat::ChatsState>,
    chat: Option<ChatJoin>,
    cwd: String,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    command: Option<Vec<String>>,
    fallback: Option<Vec<String>>,
    shell_after: Option<bool>,
    vars: Option<HashMap<String, String>>,
) -> Result<u32, String> {
    let on_exit = on_data.clone();
    let (command, fallback, joined) = join_chat(chats.0.clone(), chat, command, fallback, vars.unwrap_or_default());
    open(
        &ptys,
        &cwd,
        command.as_deref(),
        fallback.as_deref(),
        shell_after.unwrap_or(true),
        PtySize { rows, cols, pixel_width: 0, pixel_height: 0 },
        move |bytes| on_data.send(InvokeResponseBody::Raw(bytes)).is_ok(),
        move |code| {
            let _ = on_exit.send(InvokeResponseBody::Json(serde_json::json!({ "exit": code }).to_string()));
        },
        joined,
    )
}

// user: 사용자가 친 것 (키·붙여넣기·IME). 터미널이 스스로 보낸 응답(커서 위치 등)은 깨우기의 입력 상태에 넣지 않는다
// (리뷰 P2: 커서 위치 응답 때문에 입력 중으로 보고 깨우지 않았다). 무엇이 사용자 입력인지는 프론트가 정한다 (Terminal.tsx).
#[tauri::command]
pub fn pty_write(ptys: State<'_, Ptys>, chats: State<'_, crate::chat::ChatsState>, id: u32, data: String, user: Option<bool>) -> Result<(), String> {
    let typed_in = write_input(&ptys, id, &data, user.unwrap_or(false))?;
    // 작업그룹 세션의 터미널에 사용자가 입력하면 그 그룹의 자동 깨우기를 다시 센다 (chat.rs user_input). 잠금 밖에서.
    if let (Some(token), Some(chats)) = (typed_in, chats.0.as_ref()) {
        chats.user_input(&token);
    }
    Ok(())
}

// 터미널 앞에서 지금 도는 프로그램 이름 (포그라운드 프로세스 그룹의 대표, macOS proc_name). ⇧↩을 그 프로그램에 맞게
// 보내려고 쓴다 (src/Terminal.tsx, groups.json shiftEnterFor). 알 수 없으면 None (그러면 Enter).
#[tauri::command]
pub fn pty_foreground(ptys: State<'_, Ptys>, id: u32) -> Vec<String> {
    foreground(&ptys, id)
}

// 앞에서 도는 프로그램의 이름 후보: 띄울 때 쓴 이름(argv[0]의 마지막 부분), 커널이 기록한 실행 파일 이름 순.
// 둘이 다를 수 있다: claude는 versions/2.1.310을 가리키는 링크라 커널 이름은 "2.1.310"이다 (2026-10-25).
fn foreground(ptys: &Ptys, id: u32) -> Vec<String> {
    let Some(pid) = ptys.foreground_pid(id) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for name in [invoked_name(pid), process_name(pid)].into_iter().flatten() {
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

#[cfg(target_os = "macos")]
fn process_name(pid: i32) -> Option<String> {
    let mut buf = [0u8; 256];
    let n = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    (n > 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

// argv[0]의 마지막 부분. 로그인 셸의 "-zsh"는 "zsh"로.
// KERN_PROCARGS2: argc(int), 실행 파일 경로, NUL 채움, argv[0], ... 순이다.
#[cfg(target_os = "macos")]
fn invoked_name(pid: i32) -> Option<String> {
    let mut max: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 2, (&mut max as *mut libc::c_int).cast(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    let mut buf = vec![0u8; max.max(0) as usize];
    let mut size = buf.len();
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    let rest = buf.get(std::mem::size_of::<libc::c_int>()..size)?;
    let path_end = rest.iter().position(|&b| b == 0)?;
    let rest = &rest[path_end..];
    let start = rest.iter().position(|&b| b != 0)?;
    let rest = &rest[start..];
    let arg0 = &rest[..rest.iter().position(|&b| b == 0).unwrap_or(rest.len())];
    let arg0 = String::from_utf8_lossy(arg0);
    let base = arg0.rsplit('/').next().unwrap_or(&arg0);
    Some(base.trim_start_matches('-').to_string())
}

#[cfg(not(target_os = "macos"))]
fn process_name(_pid: i32) -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
fn invoked_name(_pid: i32) -> Option<String> {
    None
}

// 쓴다. 사용자 입력이면 입력 상태를 바꾸고, 채팅방에 참여한 터미널이면 그 토큰을 돌려준다.
pub(crate) fn write_input(ptys: &Ptys, id: u32, data: &str, user: bool) -> Result<Option<String>, String> {
    let mut sessions = ptys.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("no such pty")?;
    if user {
        session.input.typed(Instant::now());
    }
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    Ok(if user { session.chat_token.clone() } else { None })
}

// 이 토큰들로 참여한 터미널이 from의 메시지를 받았다: 깨우기를 기다린다. (기다리게 된 터미널, 변경 번호)
// 테스트용 줄임. 앱은 wake_all로 한꺼번에 예약한다.
#[cfg(all(test, unix))]
fn wake(ptys: &Ptys, tokens: &[String], from: &str) -> Vec<(u32, u64)> {
    wake_all(ptys, &tokens.iter().map(|t| (t.clone(), from.to_string())).collect::<Vec<_>>())
}

// 여러 (채팅 토큰, 보낸 사람)을 잠금 하나 안에서 한꺼번에 예약한다. 한 터미널에 보낸 사람이 여럿이어도 알림은 한 번이다
// (리뷰 2단계 R1: 따로 부르면 그 사이 wake_tick이 앞 것을 먼저 써서 같은 터미널에 알림이 두 번 갔다). 터미널마다 변경 번호 하나.
pub fn wake_all(ptys: &Ptys, items: &[(String, String)]) -> Vec<(u32, u64)> {
    let sessions = ptys.sessions.lock().unwrap();
    let mut wakes = ptys.wakes.lock().unwrap();
    let mut ids: Vec<u32> = Vec::new();
    for (token, from) in items {
        for (id, _) in sessions.iter().filter(|(_, s)| s.chat_token.as_deref() == Some(token.as_str())) {
            let p = wakes.entry(*id).or_default();
            if !p.from.iter().any(|f| f == from) {
                p.from.push(from.clone());
            }
            if !ids.contains(id) {
                ids.push(*id);
            }
        }
    }
    ids.into_iter().map(|id| (id, ptys.wake_seq.fetch_add(1, Ordering::Relaxed) + 1)).collect()
}

// 깨우기를 기다리는 터미널을 본다 (주기적으로, now는 지금). 사용자가 입력 중이 아니고 프로그램이 사용자를 기다리지 않으면
// (또는 바로 깨우기를 눌렀으면) 알림을 쓰고, WAKE_GAP 뒤의 확인에서 Enter를 보낸다. 그 사이 사용자가 입력했으면 Enter를
// 보내지 않는다 (알림이 초안과 함께 제출되지 않게. 사용자가 Enter를 치면 함께 제출된다).
// 프로그램이 사용자를 기다리는 동안은 알림도 Enter도 미룬다: Enter가 선택 창의 답을 고르지 않게 (docs/reviews/2026-10-25-wake-hold.md).
// 미룬 Enter는 기다림이 끝나면 보낸다. 기다리는 동안 친 키(선택 창의 답)는 초안으로 보지 않고, 끝난 뒤에 친 것만 본다.
// 바로 깨우기는 기다려도 알림과 Enter를 보낸다 (사용자가 고른 것). Enter를 기다리는 터미널에는 다음 알림을 쓰지 않는다.
// 대기에서 빠진 터미널과 변경 번호 (알림을 썼거나, 터미널이 없어져 그만둠)
pub fn wake_tick(ptys: &Ptys, now: Instant) -> Vec<(u32, u64)> {
    let mut sessions = ptys.sessions.lock().unwrap();
    let mut wakes = ptys.wakes.lock().unwrap();
    for session in sessions.values_mut() {
        let Some(e) = session.enter else { continue };
        // 기다리는 동안은 무엇을 쳐도 (선택지 고르기·답) Enter를 둔다
        if session.awaiting && !e.force {
            continue;
        }
        // 알림 뒤에 기다린 적이 있으면 그 기다림이 끝난 뒤에 친 키만 초안이다
        let since = if session.awaiting_changes != e.changes { e.before.last.max(session.awaiting_changed) } else { e.before.last };
        if session.input.last > since {
            session.enter = None;
        } else if now >= e.at + WAKE_GAP {
            let _ = session.writer.write_all(b"\r");
            session.enter = None;
        }
    }
    let (mut woke, mut gone) = (Vec::new(), Vec::new());
    for (id, p) in wakes.iter() {
        let Some(session) = sessions.get_mut(id) else {
            gone.push(*id);
            continue;
        };
        if session.enter.is_some() || !(p.now || (session.input.quiet(now) && !session.awaiting)) {
            continue;
        }
        if session.writer.write_all(wake_notice(&p.from).as_bytes()).is_err() {
            gone.push(*id);
            continue;
        }
        woke.push(*id);
        session.enter = Some(Enter { at: now, before: session.input, force: p.now, changes: session.awaiting_changes });
    }
    woke.into_iter()
        .chain(gone)
        .map(|id| {
            wakes.remove(&id);
            (id, ptys.wake_seq.fetch_add(1, Ordering::Relaxed) + 1)
        })
        .collect()
}

// 깨우기 확인을 주기적으로 돌린다. 대기에서 빠진 터미널은 "chat-wake" 이벤트로 알린다 ({ pty, pending: false, seq }).
pub fn start_waker(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));
        let woke = wake_tick(&app.state::<Ptys>(), Instant::now());
        for (id, seq) in &woke {
            let _ = app.emit("chat-wake", serde_json::json!({ "pty": id, "pending": false, "seq": seq }));
        }
        // 폰은 어느 프로젝트인지 모르고 보고 있는 참여자를 다시 읽는다 (mobile.rs)
        if !woke.is_empty() {
            crate::mobile::publish(&app, None, "waiting", serde_json::json!({}));
        }
        app.state::<Ptys>().keep_awake();
    });
}

// 앞에서 도는 프로그램이 작업 중인지 (프론트 src/Terminal.tsx: OSC 7501 working)
// 바뀔 때만 온다: 폰은 참여자 상태를 다시 읽는다 (mobile.rs)
#[tauri::command]
pub fn pty_working(app: tauri::AppHandle, ptys: State<'_, Ptys>, id: u32, working: bool) {
    if let Some(s) = ptys.sessions.lock().unwrap().get_mut(&id) {
        s.working = working;
    }
    crate::mobile::publish(&app, None, "status", serde_json::json!({}));
}

// 자체 테스트: 잠자기를 막고 있는지 (caffeinate가 떠 있는지)
#[tauri::command]
pub fn selftest_keep_awake(ptys: State<'_, Ptys>) -> bool {
    ptys.awake.lock().unwrap().is_some()
}

// 앞에서 도는 프로그램이 사용자를 기다리는지 (프론트 src/Terminal.tsx: OSC 7501 blocked, 화면의 선택 창)
// 사용자를 기다리게 되면 (kind: permission·question·auth·dialog) 채팅방 참여자의 터미널이면 사용자에게 알린다 (chat.rs
// Change::Attention, 보고 있으면 생략). claude·codex 모두 된다 (codex는 권한 확인 훅이 없다)
#[tauri::command]
pub fn pty_awaiting(app: tauri::AppHandle, ptys: State<'_, Ptys>, chats: State<'_, crate::chat::ChatsState>, id: u32, awaiting: bool, kind: Option<String>) {
    let kind = kind.as_deref().unwrap_or("dialog");
    ptys.set_awaiting_kind(id, kind);
    // 알림은 잠금 밖에서
    if let (Some(token), Some(chats)) = (ptys.set_awaiting(id, awaiting), chats.0.as_ref()) {
        chats.attention(&token, kind, false);
    }
    crate::mobile::publish(&app, None, "status", serde_json::json!({}));
}

// 자체 테스트: 그 터미널이 사용자를 기다린다고 알려졌는지
#[tauri::command]
pub fn selftest_pty_awaiting(ptys: State<'_, Ptys>, id: u32) -> Option<bool> {
    ptys.sessions.lock().unwrap().get(&id).map(|s| s.awaiting)
}

// 자체 테스트: 그 터미널이 기다리는 종류 (기다리지 않으면 없음)
#[tauri::command]
pub fn selftest_pty_awaiting_kind(ptys: State<'_, Ptys>, id: u32) -> Option<String> {
    ptys.sessions.lock().unwrap().get(&id).filter(|s| s.awaiting).map(|s| s.awaiting_kind.clone())
}

// 깨우기를 기다리는 터미널을 사용자가 눌러 바로 깨운다 (다음 확인 때)
#[tauri::command]
pub fn chat_wake_now(ptys: State<'_, Ptys>, id: u32) {
    if let Some(p) = ptys.wakes.lock().unwrap().get_mut(&id) {
        p.now = true;
    }
}

impl Ptys {
    // 기다리게 되었고 알려야 하면 그 터미널의 채팅 토큰 (알릴 참여자). 기다림이 켜질 때마다(대기 한 번마다) 알린다.
    // 다만 claude 훅이 ATTENTION_GAP 안에 먼저 알렸고 그 뒤 기다림이 끝난 적이 없으면 같은 확인이라 알리지 않는다
    // (훅→상태 순서, 리뷰 R3·R4). 상태→훅 순서는 claim_hook_attention이 막는다.
    fn set_awaiting(&self, id: u32, awaiting: bool) -> Option<String> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions.get_mut(&id)?;
        if s.awaiting == awaiting {
            return None;
        }
        let now = Instant::now();
        let ended = s.awaiting_changed;
        s.awaiting = awaiting;
        s.awaiting_changed = Some(now);
        s.awaiting_changes += 1;
        if !awaiting {
            return None;
        }
        let hook = s.hook_attention.take();
        // 같은 시각(시계 해상도)도 그 뒤로 본다
        let same = hook.is_some_and(|h| now.saturating_duration_since(h) < ATTENTION_GAP && ended.is_none_or(|e| h >= e));
        if same { None } else { s.chat_token.clone() }
    }

    // 작업 중인 터미널이 하나라도 있으면 시스템이 저절로 잠들지 않게 한다 (caffeinate -i. 화면은 꺼질 수 있다). 자리를 비운
    // 사이 Mac이 잠들면 claude·codex의 작업이 멈춘다. 없어지면 끝낸다. -w로 ddak이 끝나면 caffeinate도 끝난다.
    // 주기적으로 부른다 (start_waker). 터미널이 닫혀 목록에서 빠지는 것도 여기서 반영된다.
    pub fn keep_awake(&self) {
        let any = self.sessions.lock().unwrap().values().any(|s| s.working);
        let mut awake = self.awake.lock().unwrap();
        // 누가 끝냈으면 다시 띄운다
        if awake.as_mut().is_some_and(|a| !a.alive()) {
            *awake = None;
        }
        if any && awake.is_none() {
            match crate::platform::KeepAwake::start() {
                Ok(a) => *awake = Some(a),
                Err(e) => eprintln!("잠자기 막기 실패: {e}"),
            }
        } else if !any {
            if let Some(a) = awake.take() {
                a.stop();
            }
        }
    }

    // 터미널 앞에서 도는 프로그램(포그라운드 프로세스 그룹의 대표)의 pid (터미널 링크의 상대 경로 기준, links.rs)
    // Windows의 ConPTY에는 포그라운드 프로세스 그룹이 없다 (링크는 띄운 폴더 기준, ⇧↩은 세션 구성의 것만. docs/windows-plan.md)
    #[cfg(unix)]
    pub fn foreground_pid(&self, id: u32) -> Option<i32> {
        self.sessions.lock().unwrap().get(&id).and_then(|s| s.master.process_group_leader())
    }

    #[cfg(windows)]
    pub fn foreground_pid(&self, _id: u32) -> Option<i32> {
        None
    }

    // 이 터미널의 채팅 토큰 (채팅방 참여자가 아니면 없음)
    pub fn token_of(&self, id: u32) -> Option<String> {
        self.sessions.lock().unwrap().get(&id).and_then(|s| s.chat_token.clone())
    }

    pub fn exists(&self, id: u32) -> bool {
        self.sessions.lock().unwrap().contains_key(&id)
    }

    // 이 채팅 토큰의 터미널 (알림을 누르면 보일 창)
    pub fn pty_of_token(&self, token: &str) -> Option<u32> {
        self.sessions.lock().unwrap().iter().find(|(_, s)| s.chat_token.as_deref() == Some(token)).map(|(id, _)| *id)
    }

    // claude 훅의 "사용자를 기다림"을 알려도 되는지: 그 토큰의 터미널이 지금 기다리는 중이면 상태로 이미 알린 확인이라 false.
    // 알리면 그때를 적어 둔다 (뒤따라 켜지는 상태의 기다림을 같은 확인으로 본다). 터미널이 없는 토큰은 true.
    pub fn claim_hook_attention(&self, token: &str, now: Instant) -> bool {
        let mut sessions = self.sessions.lock().unwrap();
        let mut mine: Vec<&mut Session> = sessions.values_mut().filter(|s| s.chat_token.as_deref() == Some(token)).collect();
        if mine.iter().any(|s| s.awaiting) {
            return false;
        }
        for s in mine.iter_mut() {
            s.hook_attention = Some(now);
        }
        true
    }

    fn set_awaiting_kind(&self, id: u32, kind: &str) {
        if let Some(s) = self.sessions.lock().unwrap().get_mut(&id) {
            s.awaiting_kind = kind.to_string();
        }
    }

    // 채팅에 참여한 터미널의 상태: (토큰, 사용자를 기다리면 그 종류, 작업 중이면 "working"). 둘 다 아니면 빠진다 (폰, mobile.rs)
    pub fn statuses(&self) -> Vec<(String, String)> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .values()
            .filter_map(|s| {
                let status = if s.awaiting { s.awaiting_kind.clone() } else if s.working { "working".into() } else { return None };
                Some((s.chat_token.clone()?, status))
            })
            .collect()
    }

    // 깨우기를 기다리는 터미널의 채팅 토큰 (채팅 패널의 대기 표시, chat.rs chat_waiting)
    pub fn waiting_tokens(&self) -> Vec<String> {
        let sessions = self.sessions.lock().unwrap();
        let wakes = self.wakes.lock().unwrap();
        wakes.keys().filter_map(|id| sessions.get(id)?.chat_token.clone()).collect()
    }

    // 이 토큰의 터미널 중 깨우기를 기다리는 것을 바로 깨운다 (다음 확인 때. 채팅 패널에서 누름)
    pub fn wake_now_tokens(&self, tokens: &[String]) {
        let sessions = self.sessions.lock().unwrap();
        let mut wakes = self.wakes.lock().unwrap();
        for (id, p) in wakes.iter_mut() {
            if sessions.get(id).and_then(|s| s.chat_token.as_ref()).is_some_and(|t| tokens.contains(t)) {
                p.now = true;
            }
        }
    }
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
    // 기다림이 길 수 있어 (SIGHUP 뒤 유예) 따로 돌린다
    close(&ptys, id);
    Ok(())
}

// 유닉스 권한·링크·sh를 쓰는 시험 (Windows 시험은 platform.rs·conpty.rs·fs.rs)
#[cfg(all(test, unix))]
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

    // 작업그룹 끝내기: 그 폴더에서 띄운 터미널의 세션이 다 끝난 뒤에 돌아온다. SIGHUP을 무시하고 그룹을 따로 만든
    // 작업(job control: terminate의 그룹 신호가 닿지 않는다)도 남지 않는다. 다른 폴더의 터미널은 그대로다.
    #[test]
    fn stop_under_ends_whole_session_before_returning() {
        let dir = std::env::temp_dir().join(format!("ddak-stop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let log = dir.join("log");
        let script = format!("set -m; (trap '' HUP; while :; do echo t >> '{}'; sleep 0.05; done) & wait", log.display());
        let argv: Vec<String> = ["/bin/sh", "-c", &script].iter().map(|a| a.to_string()).collect();
        let other: Vec<String> = ["/bin/sh", "-c", "sleep 30"].iter().map(|a| a.to_string()).collect();
        let open = |cwd: &Path, argv: &[String]| spawn(&cwd.to_string_lossy(), Some(argv), None, false, SIZE, |_| true, |_| ()).unwrap();
        let ptys = Ptys::default();
        ptys.sessions.lock().unwrap().insert(1, open(&dir, &argv));
        ptys.sessions.lock().unwrap().insert(2, open(Path::new("/"), &other));
        let size = || std::fs::metadata(&log).map(|m| m.len()).unwrap_or(0);
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while size() == 0 {
            assert!(std::time::Instant::now() < deadline, "작업이 쓰지 않음");
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(stop_under(&ptys, &dir), "다 끝나지 않음");
        let before = size();
        std::thread::sleep(Duration::from_millis(400));
        let after = size();
        assert!(!running_under(&ptys, &dir) && running_under(&ptys, Path::new("/")), "다른 폴더의 터미널까지 끝냄");
        if let Some(rest) = ptys.sessions.lock().unwrap().remove(&2) {
            terminate(&rest.proc);
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(before, after, "끝낸 뒤에도 그 폴더의 작업이 계속 씀");
    }

    // 먼저 닫은 터미널(일반 닫기 경로)의 백그라운드 작업도 끝내기가 기다린다 (리뷰 후속 P1: 닫으면 목록에서 바로 빠지고
    // 그룹만 끝내서, 그 뒤 stop_under가 못 찾았고 작업이 계속 썼다). 닫기만 해도 결국 세션 전체가 끝난다.
    #[test]
    fn stop_under_waits_for_terminals_already_closed() {
        let dir = std::env::temp_dir().join(format!("ddak-closed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let ptys = Ptys::default();
        let log = |name: &str| dir.join(name);
        let size = |name: &str| std::fs::metadata(log(name)).map(|m| m.len()).unwrap_or(0);
        let start = |name: &str| {
            let script = format!("set -m; (trap '' HUP; while :; do echo t >> '{}'; sleep 0.05; done) & wait", log(name).display());
            let argv: Vec<String> = ["/bin/sh", "-c", &script].iter().map(|a| a.to_string()).collect();
            let id = open(&ptys, &dir.to_string_lossy(), Some(&argv), None, false, SIZE, |_| true, |_| (), None).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            while size(name) == 0 {
                assert!(std::time::Instant::now() < deadline, "작업이 쓰지 않음");
                std::thread::sleep(Duration::from_millis(50));
            }
            id
        };
        let stable = |name: &str| {
            let before = size(name);
            std::thread::sleep(Duration::from_millis(400));
            before == size(name)
        };
        // 닫기만 해도 끝난다
        close(&ptys, start("a"));
        std::thread::sleep(Duration::from_millis(600));
        let closed_alone = stable("a");
        // 닫은 직후 끝내기는 그것까지 끝난 뒤에 돌아온다
        close(&ptys, start("b"));
        let all = stop_under(&ptys, &dir);
        let after_stop = stable("b");
        let running = running_under(&ptys, &dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(closed_alone, "닫은 터미널의 작업이 계속 씀");
        assert!(all && after_stop && !running, "끝내기 뒤에도 닫은 터미널의 작업이 씀 ({all}, {after_stop}, {running})");
    }

    // 끝내는 중인 폴더(와 그 안)에는 새 터미널을 띄우지 않는다 (리뷰 후속 P1). 다른 폴더는 띄우고, 풀면 다시 띄운다.
    #[test]
    fn ending_folder_refuses_new_terminals() {
        let dir = std::env::temp_dir().join(format!("ddak-hold-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let ptys = Ptys::default();
        let argv = vec!["/bin/sh".to_string(), "-c".to_string(), "sleep 30".to_string()];
        let try_open = |cwd: &Path| open(&ptys, &cwd.to_string_lossy(), Some(&argv), None, false, SIZE, |_| true, |_| (), None).is_ok();
        let held = hold(&ptys, &dir);
        let (inside, sub, other) = (try_open(&dir), try_open(&dir.join("sub")), try_open(&std::env::temp_dir()));
        drop(held);
        let after = try_open(&dir);
        stop_under(&ptys, Path::new("/"));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!inside && !sub && other && after, "{inside} {sub} {other} {after}");
    }

    // 채팅방 참여: 인자의 {chat}이 그 창의 MCP 주소로 바뀌고 (fallback도), 터미널을 닫으면 참여자에서 빠진다
    #[test]
    fn chat_url_fills_args_and_leaves_on_close() {
        let dir = std::env::temp_dir().join(format!("ddak-pty-chat-{}", std::process::id()));
        let chats = crate::chat::Chats::new(dir.clone(), Box::new(|_, _| ()), 0);
        let join = ChatJoin { project: "/".into(), name: "origin/dev".into(), key: "k".into() };
        let argv = |s: &str| Some(vec!["/bin/sh".to_string(), "-c".to_string(), s.to_string()]);
        let (command, fallback, leave) = join_chat(Some(chats.clone()), Some(join), argv("echo URL={chat}"), argv("echo {chat}"), HashMap::new());
        let url = fallback.as_ref().unwrap()[2].strip_prefix("echo ").unwrap().to_string();
        assert!(url.starts_with("http://127.0.0.1:") && url.contains("/mcp/"), "{url}");
        assert_eq!(chats.members(Path::new("/")), ["user", "origin/dev"]);
        let ptys = Ptys::default();
        let out = Arc::new(Mutex::new(Vec::new()));
        let sink = out.clone();
        let id = open(&ptys, "/", command.as_deref(), None, false, SIZE, move |b| { sink.lock().unwrap().extend(b); true }, |_| (), leave).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !String::from_utf8_lossy(&out.lock().unwrap()).contains(&format!("URL={url}")) {
            assert!(std::time::Instant::now() < deadline, "주소가 인자로 가지 않음");
            std::thread::sleep(Duration::from_millis(50));
        }
        close(&ptys, id);
        assert_eq!(chats.members(Path::new("/")), ["user"], "닫아도 참여자로 남음");
        // 채팅 서버가 없으면 빈 값
        let (command, _, leave) = join_chat(None, Some(ChatJoin { project: "/".into(), name: "x".into(), key: "x".into() }), argv("{chat}"), None, HashMap::new());
        assert!(command.unwrap()[2].is_empty() && leave.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 입력 중인지: 한 번도 안 쳤거나 WAKE_IDLE 동안 입력이 없으면 깨울 수 있다 (마지막 키가 Enter가 아니어도).
    #[test]
    fn input_quiet_after_idle() {
        let t = Instant::now();
        let mut i = Input::NONE;
        assert!(i.quiet(t));
        i.typed(t);
        assert!(!i.quiet(t + Duration::from_secs(1)), "치는 중에 깨움");
        assert!(i.quiet(t + WAKE_IDLE), "초안이 남았다고 계속 기다림");
    }

    // 깨우기: 멘션된 참여자의 터미널에 알림을 쓰고 잠시 뒤 Enter를 따로 보낸다. 보낸 사람은 모아서 한 번에. 초안이 있거나
    // 막 쳤으면 기다리고, 알림을 쓴 뒤 사용자가 치면 Enter를 보내지 않는다. 터미널이 없어지면 그만둔다.
    #[test]
    fn wake_writes_notice_then_enter_when_quiet() {
        let ptys = Ptys::default();
        let out = Arc::new(Mutex::new(Vec::new()));
        let sink = out.clone();
        let argv: Vec<String> = ["/bin/sh", "-c", "stty -echo; while read l; do echo \"GOT:$l\"; done"].iter().map(|a| a.to_string()).collect();
        let joined = Joined { leave: Box::new(|| ()), token: "tok".into() };
        let id = open(&ptys, "/", Some(&argv), None, false, SIZE, move |b| { sink.lock().unwrap().extend(b); true }, |_| (), Some(joined)).unwrap();
        let text = || String::from_utf8_lossy(&out.lock().unwrap()).to_string();
        // 기다리는 동안 확인을 돌린다 (Enter는 알림을 쓴 뒤 WAKE_GAP이 지난 확인에서 간다)
        let wait = |what: &str| {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !text().contains(what) {
                assert!(Instant::now() < deadline, "{what} 없음: {:?}", text());
                wake_tick(&ptys, Instant::now() + WAKE_IDLE + WAKE_GAP);
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        std::thread::sleep(Duration::from_millis(300));
        let first = wake(&ptys, &["tok".into(), "other".into()], "origin/a");
        assert_eq!(first.iter().map(|w| w.0).collect::<Vec<_>>(), [id]);
        wake(&ptys, &["tok".into()], "origin/b");
        wake(&ptys, &["tok".into()], "origin/a");
        // 막 쳤으면 기다린다
        write_input(&ptys, id, "draft", true).unwrap();
        let typed_at = Instant::now();
        assert!(wake_tick(&ptys, typed_at).is_empty(), "치는 중에 깨움");
        // 터미널이 스스로 보낸 응답(커서 위치)은 입력으로 보지 않는다 (리뷰 P2). 친 때부터 IDLE이 지나면 깨운다
        // (초안이 남아 있어도. 알림은 초안 뒤에 붙는다)
        std::thread::sleep(Duration::from_millis(50));
        write_input(&ptys, id, "\u{1b}[1;1R", false).unwrap();
        let done = wake_tick(&ptys, typed_at + WAKE_IDLE);
        assert_eq!(done.iter().map(|w| w.0).collect::<Vec<_>>(), [id], "응답 때문에 깨우지 않음");
        // 변경 번호는 늘어난다 (프론트가 오래된 상태를 버린다)
        assert!(done[0].1 > first[0].1);
        // (초안과 가짜 응답 바이트도 PTY로 가서 read의 줄 앞에 붙는다)
        wait("[ddak] New chat message from origin/a, origin/b. Read it with the ddak read_messages tool");
        assert!(text().contains("GOT:draft"), "{:?}", text());
        assert!(wake_tick(&ptys, Instant::now() + WAKE_IDLE).is_empty(), "한 번 깨운 뒤에도 또 깨움");

        // 알림과 Enter 사이에 온 자동 응답(사용자 입력 아님)은 Enter를 막지 않는다 (리뷰 후속 P2)
        wake(&ptys, &["tok".into()], "origin/r");
        assert_eq!(wake_tick(&ptys, Instant::now() + WAKE_IDLE).iter().map(|w| w.0).collect::<Vec<_>>(), [id]);
        write_input(&ptys, id, "\u{1b}[0n", false).unwrap();
        wait("from origin/r. Read it with the ddak read_messages tool");

        // 알림을 쓴 뒤 사용자가 치면 Enter를 보내지 않는다 (사용자가 Enter를 쳐야 함께 제출된다)
        wake(&ptys, &["tok".into()], "origin/c");
        assert_eq!(wake_tick(&ptys, Instant::now() + WAKE_IDLE).iter().map(|w| w.0).collect::<Vec<_>>(), [id]);
        write_input(&ptys, id, "y", true).unwrap();
        wake_tick(&ptys, Instant::now() + WAKE_IDLE + WAKE_GAP);
        std::thread::sleep(Duration::from_millis(300));
        assert!(!text().contains("GOT:[ddak] New chat message from origin/c"), "사용자 입력 뒤에 Enter를 보냄");
        write_input(&ptys, id, "\r", true).unwrap();
        wait("from origin/c. Read it with the ddak read_messages tool. Post with post_message only what moves the work: a result someone asked for, a needed request or question, or a concrete blocker. Do not post acknowledgements. @mention only someone who must act next or who asked for what you deliver.y");

        // 바로 깨우기는 초안이 있어도 깨운다 (채팅 패널: 토큰으로 대기를 보고 누른다). 터미널이 없어지면 그만둔다
        assert!(ptys.waiting_tokens().is_empty());
        wake(&ptys, &["tok".into()], "origin/d");
        write_input(&ptys, id, "z", true).unwrap();
        assert_eq!(ptys.waiting_tokens(), ["tok"]);
        ptys.wake_now_tokens(&["other".into()]);
        assert!(wake_tick(&ptys, Instant::now()).is_empty(), "다른 토큰을 깨움");
        ptys.wake_now_tokens(&["tok".into()]);
        assert_eq!(wake_tick(&ptys, Instant::now()).iter().map(|w| w.0).collect::<Vec<_>>(), [id]);
        assert!(ptys.waiting_tokens().is_empty());
        // 보낸 사람이 여럿이어도 한꺼번에 예약하면 알림은 한 번 (리뷰 2단계 R1)
        let both = wake_all(&ptys, &[("tok".into(), "origin/x".into()), ("other".into(), "origin/z".into()), ("tok".into(), "origin/y".into())]);
        assert_eq!(both.iter().map(|w| w.0).collect::<Vec<_>>(), [id]);
        assert_eq!(wake_tick(&ptys, Instant::now() + WAKE_IDLE).iter().map(|w| w.0).collect::<Vec<_>>(), [id]);
        wait("New chat message from origin/x, origin/y. Read it");
        assert!(wake_tick(&ptys, Instant::now() + WAKE_IDLE).is_empty(), "두 번 깨움");
        wake(&ptys, &["tok".into()], "origin/e");
        close(&ptys, id);
        assert_eq!(wake_tick(&ptys, Instant::now() + WAKE_IDLE).iter().map(|w| w.0).collect::<Vec<_>>(), [id], "없어진 터미널을 그만두지 않음");
    }

    // 폰에 보일 참여자 상태: 기다리면 그 종류, 아니면 작업 중, 둘 다 아니거나 채팅에 없는 터미널은 빠진다
    #[test]
    fn statuses_of_chat_terminals() {
        let ptys = Ptys::default();
        let argv: Vec<String> = ["/bin/sh", "-c", "sleep 5"].iter().map(|a| a.to_string()).collect();
        let joined = Joined { leave: Box::new(|| ()), token: "tok".into() };
        let id = open(&ptys, "/", Some(&argv), None, false, SIZE, |_| true, |_| (), Some(joined)).unwrap();
        let other = open(&ptys, "/", Some(&argv), None, false, SIZE, |_| true, |_| (), None).unwrap();
        assert!(ptys.statuses().is_empty());
        ptys.sessions.lock().unwrap().get_mut(&id).unwrap().working = true;
        ptys.sessions.lock().unwrap().get_mut(&other).unwrap().working = true;
        assert_eq!(ptys.statuses(), [("tok".to_string(), "working".to_string())]);
        ptys.set_awaiting_kind(id, "permission");
        assert_eq!(ptys.set_awaiting(id, true).as_deref(), Some("tok"));
        assert_eq!(ptys.statuses(), [("tok".to_string(), "permission".to_string())]);
        // 기다리는 동안 종류만 바뀌면 상태만 바뀌고 다시 알리지 않는다 (리뷰 R4)
        ptys.set_awaiting_kind(id, "question");
        assert_eq!(ptys.set_awaiting(id, true), None);
        assert_eq!(ptys.statuses(), [("tok".to_string(), "question".to_string())]);
        ptys.set_awaiting(id, false);
        assert_eq!(ptys.statuses(), [("tok".to_string(), "working".to_string())]);
        close(&ptys, id);
        close(&ptys, other);
    }

    // 프로그램이 사용자를 기다리는 동안(선택 창 등)은 알림도 Enter도 미루고, 끝나면 보낸다 (Enter가 선택 창의 답을 고르지
    // 않게). 기다리는 동안 친 키(선택 창의 답)는 초안으로 보지 않고, 끝난 뒤에 친 키는 초안으로 본다 (Enter를 보내지 않음).
    // 바로 깨우기(사용자가 누름)는 기다려도 알림과 Enter를 보낸다 (리뷰 R2·R3).
    #[test]
    fn wake_holds_while_program_awaits_user() {
        let ptys = Ptys::default();
        let out = Arc::new(Mutex::new(Vec::new()));
        let sink = out.clone();
        let argv: Vec<String> = ["/bin/sh", "-c", "stty -echo; while read l; do echo \"GOT:$l\"; done"].iter().map(|a| a.to_string()).collect();
        let joined = Joined { leave: Box::new(|| ()), token: "tok".into() };
        let id = open(&ptys, "/", Some(&argv), None, false, SIZE, move |b| { sink.lock().unwrap().extend(b); true }, |_| (), Some(joined)).unwrap();
        let text = || String::from_utf8_lossy(&out.lock().unwrap()).to_string();
        let tick = || wake_tick(&ptys, Instant::now() + WAKE_IDLE + WAKE_GAP);
        let wait = |what: &str| {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !text().contains(what) {
                assert!(Instant::now() < deadline, "{what} 없음: {:?}", text());
                tick();
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        // 몇 번 확인을 돌려도 Enter가 가지 않았는지
        let no_enter = |what: &str, why: &str| {
            for _ in 0..4 {
                tick();
                std::thread::sleep(Duration::from_millis(50));
            }
            std::thread::sleep(Duration::from_millis(200));
            assert!(!text().contains(what), "{why}: {:?}", text());
        };
        let notice = |from: &str| format!("GOT:[ddak] New chat message from {from}.");
        std::thread::sleep(Duration::from_millis(300));
        // 기다리게 될 때만 알릴 참여자(토큰)를 돌려준다 (같은 값이면 없음, 풀리면 없음)
        assert_eq!(ptys.set_awaiting(id, true).as_deref(), Some("tok"));
        assert_eq!(ptys.set_awaiting(id, true), None);
        assert_eq!(ptys.set_awaiting(id, false), None);
        // 답한 뒤 새로 켜진 기다림은 또 알린다 (리뷰 R4)
        assert_eq!(ptys.set_awaiting(id, true).as_deref(), Some("tok"), "새 대기를 알리지 않음");
        // 상태로 알린 대기 중의 훅은 같은 확인이라 알리지 않는다
        assert!(!ptys.claim_hook_attention("tok", Instant::now()));
        assert_eq!(ptys.set_awaiting(id, false), None);
        // 훅이 먼저 알리고 곧 상태가 켜지면 같은 확인이라 알리지 않는다. 그 대기가 끝나고 새로 켜지면 알린다
        assert!(ptys.claim_hook_attention("tok", Instant::now()));
        assert_eq!(ptys.set_awaiting(id, true), None, "훅이 알린 확인을 또 알림");
        assert_eq!(ptys.set_awaiting(id, false), None);
        assert_eq!(ptys.set_awaiting(id, true).as_deref(), Some("tok"), "훅 뒤의 새 대기를 알리지 않음");
        assert_eq!(ptys.set_awaiting(id, false), None);
        // 훅이 먼저 알리고 그 사이 다른 대기가 끝났으면 (훅이 그 전 대기의 것) 새 대기는 알린다
        assert!(ptys.claim_hook_attention("tok", Instant::now()));
        assert_eq!(ptys.set_awaiting(id, true), None);
        assert_eq!(ptys.set_awaiting(id, false), None);
        assert!(ptys.claim_hook_attention("tok", Instant::now() - Duration::from_secs(1)));
        assert_eq!(ptys.set_awaiting(id, true).as_deref(), Some("tok"), "끝난 대기 전의 훅 때문에 새 대기를 알리지 않음");
        assert_eq!(ptys.set_awaiting(id, false), None);
        // 모르는 토큰의 훅은 막지 않는다
        assert!(ptys.claim_hook_attention("other", Instant::now()));
        ptys.set_awaiting(id, true);
        wake(&ptys, &["tok".into()], "origin/a");
        assert!(tick().is_empty(), "기다리는 중에 알림을 씀");
        ptys.set_awaiting(id, false);
        assert_eq!(tick().iter().map(|w| w.0).collect::<Vec<_>>(), [id], "끝난 뒤에 알림을 쓰지 않음");
        wait(&notice("origin/a"));

        // 알림을 쓴 뒤 Enter 전에 기다리게 되면 미룬다. 기다리는 동안 친 키(선택지 고르기·답)는 초안이 아니다: 끝나면 Enter 한 번.
        // 답 키 뒤에도 기다리는 채로 확인이 돈다 (리뷰 2차 R3)
        wake(&ptys, &["tok".into()], "origin/b");
        assert_eq!(wake_tick(&ptys, Instant::now() + WAKE_IDLE).iter().map(|w| w.0).collect::<Vec<_>>(), [id]);
        ptys.set_awaiting(id, true);
        no_enter(&notice("origin/b"), "기다리는 중에 Enter를 보냄");
        write_input(&ptys, id, "1", true).unwrap();
        no_enter(&notice("origin/b"), "기다리는 중 친 키 뒤에 Enter를 보냄");
        std::thread::sleep(Duration::from_millis(20));
        ptys.set_awaiting(id, false);
        wait(&notice("origin/b"));
        no_enter(&notice("origin/c"), "다음 알림 전");
        assert!(!text().lines().any(|l| l.trim_end_matches('\r') == "GOT:"), "Enter를 두 번 보냄: {:?}", text());
        assert_eq!(text().matches(&notice("origin/b")).count(), 1);

        // 확인 없이 기다림이 시작되고, 답하고, 끝나도 같다 (리뷰 2차 R3)
        wake(&ptys, &["tok".into()], "origin/e");
        assert_eq!(wake_tick(&ptys, Instant::now() + WAKE_IDLE).iter().map(|w| w.0).collect::<Vec<_>>(), [id]);
        ptys.set_awaiting(id, true);
        std::thread::sleep(Duration::from_millis(20));
        write_input(&ptys, id, "2", true).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        ptys.set_awaiting(id, false);
        wait(&notice("origin/e"));
        assert_eq!(text().matches(&notice("origin/e")).count(), 1);

        // 기다림이 끝난 뒤에 친 키는 초안이다: Enter를 보내지 않는다 (사용자가 Enter를 치면 함께 제출)
        wake(&ptys, &["tok".into()], "origin/c");
        assert_eq!(wake_tick(&ptys, Instant::now() + WAKE_IDLE).iter().map(|w| w.0).collect::<Vec<_>>(), [id]);
        ptys.set_awaiting(id, true);
        tick();
        ptys.set_awaiting(id, false);
        std::thread::sleep(Duration::from_millis(20));
        write_input(&ptys, id, "x", true).unwrap();
        no_enter(&notice("origin/c"), "끝난 뒤 친 초안과 함께 Enter를 보냄");
        write_input(&ptys, id, "\r", true).unwrap();
        wait(&notice("origin/c"));

        // 바로 깨우기는 기다리는 중에도 알림과 Enter를 보낸다
        ptys.set_awaiting(id, true);
        wake(&ptys, &["tok".into()], "origin/d");
        ptys.wake_now_tokens(&["tok".into()]);
        assert_eq!(wake_tick(&ptys, Instant::now()).iter().map(|w| w.0).collect::<Vec<_>>(), [id], "바로 깨우기를 막음");
        wait(&notice("origin/d"));
        close(&ptys, id);
    }

    // 작업 중인 터미널이 있으면 caffeinate -i -w <ddak>를 띄워 두고, 없어지면 (작업이 끝나거나 터미널이 닫히면) 끝낸다.
    // 누가 caffeinate를 끝냈으면 다시 띄운다
    #[test]
    fn keeps_awake_while_working() {
        let ptys = Ptys::default();
        let argv: Vec<String> = ["/bin/sh", "-c", "sleep 30"].iter().map(|a| a.to_string()).collect();
        let id = open(&ptys, "/", Some(&argv), None, false, SIZE, |_| true, |_| (), None).unwrap();
        let set = |w: bool| ptys.sessions.lock().unwrap().get_mut(&id).unwrap().working = w;
        let held = || ptys.awake.lock().unwrap().as_ref().map(|c| c.id());
        ptys.keep_awake();
        assert_eq!(held(), None);
        set(true);
        ptys.keep_awake();
        let pid = held().expect("작업 중인데 caffeinate가 없음");
        let args = std::process::Command::new("ps").args(["-o", "args=", "-p", &pid.to_string()]).output().unwrap();
        assert!(String::from_utf8_lossy(&args.stdout).contains(&format!("caffeinate -i -w {}", std::process::id())));
        ptys.keep_awake();
        assert_eq!(held(), Some(pid), "작업 중에 다시 띄움");
        // 누가 끝내면 다시 띄운다
        ptys.awake.lock().unwrap().as_mut().unwrap().kill().unwrap();
        std::thread::sleep(Duration::from_millis(100));
        ptys.keep_awake();
        assert!(held().is_some_and(|p| p != pid), "끝난 caffeinate를 다시 띄우지 않음");
        set(false);
        ptys.keep_awake();
        assert_eq!(held(), None, "작업이 끝났는데 잠자기를 막음");
        set(true);
        ptys.keep_awake();
        close(&ptys, id);
        ptys.keep_awake();
        assert_eq!(held(), None, "터미널을 닫았는데 잠자기를 막음");
    }

    // claude 세션 표시는 터미널에 넘기지 않고, 같은 접두사의 사용자 설정과 그 밖의 CLAUDE 변수는 그대로 둔다 (리뷰 R1).
    // install.sh도 같은 목록을 지운다.
    #[test]
    fn claude_session_vars_are_not_inherited() {
        let mut cmd = CommandBuilder::new("/bin/sh");
        let kept = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_EFFORT", "CLAUDE_CONFIG_DIR", "PATH"];
        let keys: Vec<&str> = CLAUDE_SESSION_VARS.iter().copied().chain(kept).collect();
        for k in &keys {
            cmd.env(k, "x");
        }
        strip_claude_session_vars(&mut cmd, keys.iter().map(|k| k.to_string()));
        let left: Vec<&str> = keys.into_iter().filter(|k| cmd.get_env(k).is_some()).collect();
        assert_eq!(left, kept);
        let install = include_str!("../../scripts/install.sh");
        let line = install.lines().find(|l| l.trim_start().starts_with("for k in CLAUDECODE ")).expect("install.sh의 목록");
        let listed: Vec<&str> = line.trim_start().trim_start_matches("for k in ").split("; do").next().unwrap().split_whitespace().collect();
        assert_eq!(listed, CLAUDE_SESSION_VARS, "install.sh와 목록이 다름");
    }

    // 자리표시자는 한 번에 바꾼다: 넣은 값 안의 {chat}은 그대로, :toml은 TOML 문자열 리터럴, 모르는 이름·JSON 중괄호는 그대로
    #[test]
    fn placeholders_fill_once() {
        let vars: HashMap<String, String> =
            [("chat", "http://x/mcp/t"), ("prompt", "say \"hi\" {chat}\n\\ end"), ("session", "S")].into_iter().map(|(k, v)| (k.into(), v.into())).collect();
        assert_eq!(fill_placeholders("{prompt}", &vars), "say \"hi\" {chat}\n\\ end");
        assert_eq!(fill_placeholders("x={prompt:toml}", &vars), r#"x="say \"hi\" {chat}\n\\ end""#);
        assert_eq!(fill_placeholders(r#"{"url":"{chat}","s":"{session}"} {nope} {x:toml} {"#, &vars), r#"{"url":"http://x/mcp/t","s":"S"} {nope} {x:toml} {"#);
        assert_eq!(toml_string("a\u{1}b\tc"), r#""a\u0001b\tc""#);
    }

    // 앞에서 도는 프로그램 이름: 셸이 exec한 cat이면 "cat"
    #[test]
    fn foreground_names_the_running_program() {
        let ptys = Ptys::default();
        let argv: Vec<String> = ["/bin/sh", "-c", "exec cat"].iter().map(|a| a.to_string()).collect();
        let id = open(&ptys, "/", Some(&argv), None, false, SIZE, |_| true, |_| (), None).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while foreground(&ptys, id) != ["cat"] {
            assert!(Instant::now() < deadline, "{:?}", foreground(&ptys, id));
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(foreground(&ptys, 9999).is_empty());
        close(&ptys, id);
    }

    // 링크로 띄운 프로그램: 커널 이름은 링크가 가리키는 파일 이름이라, 띄운 이름(argv[0])을 먼저 준다.
    // (claude → versions/2.1.310. 커널 이름만 보면 shiftEnterFor의 claude와 맞지 않았다)
    #[test]
    fn foreground_names_a_linked_program_by_its_invoked_name() {
        let dir = std::env::temp_dir().join(format!("ddak-fg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let link = dir.join("claude");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink("/bin/cat", &link).unwrap();
        let ptys = Ptys::default();
        let argv = vec!["/bin/sh".to_string(), "-c".to_string(), format!("exec '{}'", link.display())];
        let id = open(&ptys, "/", Some(&argv), None, false, SIZE, |_| true, |_| (), None).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while foreground(&ptys, id) != ["claude", "cat"] {
            assert!(Instant::now() < deadline, "{:?}", foreground(&ptys, id));
            std::thread::sleep(Duration::from_millis(50));
        }
        close(&ptys, id);
        std::fs::remove_dir_all(&dir).unwrap();
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
