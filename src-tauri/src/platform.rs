// 맥과 Windows에서 다르게 하는 작은 것들 (docs/windows-plan.md). 큰 기능(터미널 끝내기, 복제 등)은 각 모듈에서 나눈다.

use std::path::{Path, PathBuf};

// 추측할 수 없는 난수 (토큰·id·키). 맥은 arc4random, Windows는 OS 난수 (getrandom → ProcessPrng)
#[cfg(unix)]
pub fn fill_random(buf: &mut [u8]) {
    unsafe { libc::arc4random_buf(buf.as_mut_ptr().cast(), buf.len()) };
}

#[cfg(windows)]
pub fn fill_random(buf: &mut [u8]) {
    getrandom::fill(buf).expect("OS 난수를 읽지 못함");
}

// 0..n 고르게 (n > 0)
#[cfg(unix)]
pub fn random_below(n: u32) -> u32 {
    unsafe { libc::arc4random_uniform(n) }
}

#[cfg(windows)]
pub fn random_below(n: u32) -> u32 {
    // 나머지로 치우치지 않게 n의 배수 범위 밖은 버린다
    let zone = u32::MAX - u32::MAX % n;
    loop {
        let mut b = [0u8; 4];
        fill_random(&mut b);
        let v = u32::from_le_bytes(b);
        if v < zone {
            return v % n;
        }
    }
}

// link가 target을 가리키는 심볼릭 링크. Windows는 파일·폴더 링크가 따로이고, 일반 사용자는 개발자 모드가 있어야 만든다.
#[cfg(unix)]
pub fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
pub fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    }
}

// 홈 폴더. Windows 앱에는 HOME이 없다 (Git Bash는 USERPROFILE로 정한다)
pub fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| if cfg!(windows) { std::env::var_os("USERPROFILE") } else { None }).map(PathBuf::from)
}

// 새로 만드는 파일의 권한 (유닉스 mode). Windows는 앱 데이터 폴더의 사용자별 권한을 따르므로 하지 않는다.
#[cfg(unix)]
pub fn with_mode(options: &mut std::fs::OpenOptions, mode: u32) -> &mut std::fs::OpenOptions {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(mode)
}

#[cfg(windows)]
pub fn with_mode(options: &mut std::fs::OpenOptions, _mode: u32) -> &mut std::fs::OpenOptions {
    options
}

// 링크를 따라가지 않은 그 항목의 (볼륨, 파일 번호). 같은 볼륨의 같은 번호면 같은 항목이다.
#[cfg(unix)]
pub fn file_id(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let meta = path.symlink_metadata().ok()?;
    Some((meta.dev(), meta.ino()))
}

#[cfg(windows)]
pub fn file_id(path: &Path) -> Option<(u64, u64)> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, GetFileInformationByHandle, OPEN_EXISTING,
    };
    let name = crate::fs::wide(path);
    // 폴더도 열 수 있게 BACKUP_SEMANTICS, 링크는 따라가지 않게 OPEN_REPARSE_POINT. 접근 권한 0: 속성만 읽는다
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetFileInformationByHandle(handle, &mut info) } != 0;
    unsafe { CloseHandle(handle) };
    ok.then(|| (info.dwVolumeSerialNumber as u64, ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64))
}

// 사용자의 셸. 맥은 $SHELL (없으면 zsh), Windows는 Git Bash (docs/windows-plan.md W2)
pub fn user_shell() -> Result<PathBuf, String> {
    if cfg!(windows) {
        return git_bash();
    }
    Ok(std::env::var_os("SHELL").map(PathBuf::from).unwrap_or_else(|| "/bin/zsh".into()))
}

// sh 스크립트를 돌릴 셸 (준비 스크립트, 설치 명령). 맥은 /bin/sh, Windows는 Git Bash
pub fn sh() -> Result<PathBuf, String> {
    if cfg!(windows) { git_bash() } else { Ok("/bin/sh".into()) }
}

// Git for Windows의 bash.exe: DDAK_BASH, 그다음 PATH의 git.exe 옆 (<Git>\cmd\git.exe → <Git>\bin\bash.exe), 그다음 기본 설치 위치.
// System32의 bash.exe(WSL)는 쓰지 않는다.
fn git_bash() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("DDAK_BASH").map(PathBuf::from).filter(|p| p.is_file()) {
        return Ok(p);
    }
    let from_path = std::env::var_os("PATH").into_iter().flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).find_map(|dir| {
        dir.join("git.exe").is_file().then(|| dir.parent().map(|git| git.join("bin").join("bash.exe"))).flatten()
    });
    let installed = ["ProgramFiles", "ProgramW6432", "LOCALAPPDATA"].iter().filter_map(|v| std::env::var_os(v)).flat_map(|base| {
        let base = PathBuf::from(base);
        [base.join("Git").join("bin").join("bash.exe"), base.join("Programs").join("Git").join("bin").join("bash.exe")]
    });
    from_path.into_iter().chain(installed).find(|p| p.is_file()).ok_or_else(|| "Git Bash not found: install Git for Windows (https://git-scm.com/download/win)".into())
}

// 설정 파일(.json, .sh)을 텍스트 편집기로 연다. 맥은 기본 텍스트 편집기(open -t), Windows는 메모장
// (.sh·.json의 기본 연결은 실행이거나 없을 수 있다)
pub fn edit_text(path: &Path) -> std::io::Result<()> {
    let mut cmd = if cfg!(windows) { std::process::Command::new("notepad.exe") } else {
        let mut c = std::process::Command::new("open");
        c.arg("-t");
        c
    };
    cmd.arg(path).spawn().map(|_| ())
}

// 지울 수 있게 주인 쓰기 권한을 준다 (유닉스 0700, Windows는 읽기 전용 표시를 끔)
#[cfg(unix)]
pub fn make_writable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
}

#[cfg(windows)]
pub fn make_writable(path: &Path) {
    if let Ok(meta) = path.symlink_metadata() {
        let mut p = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        p.set_readonly(false);
        let _ = std::fs::set_permissions(path, p);
    }
}

// 그 PID의 프로세스가 아직 있는지 (권한이 없어 못 보는 것도 있는 것으로)
#[cfg(unix)]
pub fn process_alive(pid: i32) -> bool {
    let r = unsafe { libc::kill(pid, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
pub fn process_alive(pid: i32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32) };
    if handle.is_null() {
        return unsafe { GetLastError() } == ERROR_ACCESS_DENIED;
    }
    let mut code = 0u32;
    let ok = unsafe { GetExitCodeProcess(handle, &mut code) } != 0;
    unsafe { CloseHandle(handle) };
    !ok || code == STILL_ACTIVE as u32
}

// 작업 중인 동안 시스템이 저절로 잠들지 않게 한다 (pty.rs keep_awake). 화면은 꺼질 수 있다.
// 맥: caffeinate -i -w <ddak pid> (ddak이 끝나면 함께 끝난다).
#[cfg(target_os = "macos")]
pub struct KeepAwake(std::process::Child);

#[cfg(target_os = "macos")]
impl KeepAwake {
    pub fn start() -> Result<KeepAwake, String> {
        let child = std::process::Command::new("/usr/bin/caffeinate").args(["-i", "-w", &std::process::id().to_string()]).spawn();
        child.map(KeepAwake).map_err(|e| format!("caffeinate: {e}"))
    }

    // 누가 끝냈으면 false
    pub fn alive(&mut self) -> bool {
        matches!(self.0.try_wait(), Ok(None))
    }

    pub fn stop(mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }

    #[cfg(test)]
    pub fn id(&self) -> u32 {
        self.0.id()
    }

    // 시험: 누가 caffeinate를 끝낸 것처럼
    #[cfg(test)]
    pub fn kill(&mut self) -> std::io::Result<()> {
        self.0.kill()
    }
}

// Windows: SetThreadExecutionState는 부른 스레드에 걸리는 상태라 전용 스레드가 걸어 두고, 멈출 때 그 스레드가 풀고 끝난다.
// ddak이 끝나면 스레드와 함께 풀린다.
#[cfg(windows)]
pub struct KeepAwake {
    stop: std::sync::mpsc::Sender<()>,
    thread: std::thread::JoinHandle<()>,
}

#[cfg(windows)]
impl KeepAwake {
    pub fn start() -> Result<KeepAwake, String> {
        use windows_sys::Win32::System::Power::{ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState};
        let (stop, stopped) = std::sync::mpsc::channel::<()>();
        let (ready, started) = std::sync::mpsc::channel::<bool>();
        let thread = std::thread::spawn(move || {
            let ok = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) } != 0;
            let _ = ready.send(ok);
            if ok {
                let _ = stopped.recv();
                unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
            }
        });
        match started.recv() {
            Ok(true) => Ok(KeepAwake { stop, thread }),
            _ => Err("SetThreadExecutionState failed".into()),
        }
    }

    pub fn alive(&mut self) -> bool {
        !self.thread.is_finished()
    }

    pub fn stop(self) {
        let _ = self.stop.send(());
        let _ = self.thread.join();
    }
}

// 앱이 뒤에서 돌리는 명령 (git, tailscale). Windows의 GUI 앱이 콘솔 프로그램을 띄우면 그때마다 콘솔 창이 뜬다
// (Git Graph는 3초마다 git을 부른다). CREATE_NO_WINDOW로 막는다. 준비 도우미처럼 콘솔 안에서 도는 쪽에는 쓰지 않는다.
pub fn background(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

// 실제 경로 (std::fs::canonicalize). Windows는 일반 형식으로 바꾼다: 이 경로가 프론트·저장 파일·git·심볼릭 링크 대상·터미널
// 작업 폴더로 가기 때문이다. 일반 형식으로 바꿀 수 없는 경로(260자 넘음 등)는 지원하지 않음 오류 (docs/windows-plan.md "경로").
// 맥은 canonicalize 그대로.
pub fn canonical(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    let real = std::fs::canonicalize(path)?;
    plain_path(real).map_err(|p| std::io::Error::other(format!("unsupported path (too long or not a plain path): {}", p.display())))
}

// 바깥(프론트, 저장 파일, git·셸·탐색기)에 넘길 경로. Windows의 canonicalize는 `\\?\C:\…`(확장 길이 형식)를 돌려주는데,
// 이것을 일반 형식으로 바꿔도 뜻이 같을 때만 바꾼다 (docs/windows-plan.md "경로"). 바꿀 수 없으면 Err (지원하지 않는 경로).
// 맥은 그대로.
pub fn plain_path(path: PathBuf) -> Result<PathBuf, PathBuf> {
    if cfg!(windows) { plain_windows(path) } else { Ok(path) }
}

// 규칙은 문자열로만 보므로 맥에서도 시험한다
fn plain_windows(path: PathBuf) -> Result<PathBuf, PathBuf> {
    let s = path.to_string_lossy();
    let plain = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        let drive = rest.as_bytes();
        if !(drive.len() >= 3 && drive[0].is_ascii_alphabetic() && drive[1] == b':' && drive[2] == b'\\') {
            return Err(path); // 볼륨 GUID 등
        }
        rest.to_string()
    } else {
        return Ok(path);
    };
    // 일반 형식에서는 OS가 끝의 점·공백을 지우고 장치 이름을 장치로 읽으며, 260자(MAX_PATH)를 넘으면 열지 못한다
    let parts_ok = plain.split('\\').skip(if plain.starts_with(r"\\") { 4 } else { 1 }).all(|c| {
        c.is_empty() || (!c.ends_with(['.', ' ']) && !is_device_name(c))
    });
    if plain.encode_utf16().count() >= 260 || !parts_ok {
        return Err(path);
    }
    Ok(PathBuf::from(plain))
}

// Git Bash(msys)가 쓰는 /c/Users/… 꼴을 Windows 경로 C:/Users/…로 (터미널 링크). 맥과 그 밖의 글자는 그대로
pub fn from_msys(s: &str) -> std::borrow::Cow<'_, str> {
    if cfg!(windows) { msys_to_windows(s) } else { std::borrow::Cow::Borrowed(s) }
}

fn msys_to_windows(s: &str) -> std::borrow::Cow<'_, str> {
    let b = s.as_bytes();
    if b.len() >= 2 && b[0] == b'/' && b[1].is_ascii_alphabetic() && (b.len() == 2 || b[2] == b'/') {
        let drive = (b[1] as char).to_ascii_uppercase();
        return std::borrow::Cow::Owned(format!("{drive}:/{}", s.get(3..).unwrap_or("")));
    }
    std::borrow::Cow::Borrowed(s)
}

// Windows 장치 이름 (확장자가 붙어도 장치)
pub fn is_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end().to_ascii_uppercase();
    let numbered = |p: &str| stem.strip_prefix(p).is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"));
    ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str()) || numbered("COM") || numbered("LPT")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_below_stays_in_range() {
        assert!((0..1000).all(|_| random_below(7) < 7));
        let mut a = [0u8; 16];
        let mut b = [0u8; 16];
        fill_random(&mut a);
        fill_random(&mut b);
        assert_ne!(a, b);
    }

    #[test]
    fn msys_paths() {
        assert_eq!(msys_to_windows("/c/Users/me/a.md"), "C:/Users/me/a.md");
        assert_eq!(msys_to_windows("/d"), "D:/");
        assert_eq!(msys_to_windows("/usr/bin"), "/usr/bin");
        assert_eq!(msys_to_windows("docs/x.md"), "docs/x.md");
    }

    #[test]
    fn plain_windows_paths() {
        let p = |s: &str| plain_windows(PathBuf::from(s)).map(|p| p.to_string_lossy().into_owned());
        assert_eq!(p(r"\\?\C:\Users\me\한글 폴더"), Ok(r"C:\Users\me\한글 폴더".into()));
        assert_eq!(p(r"\\?\UNC\server\share\dir"), Ok(r"\\server\share\dir".into()));
        assert_eq!(p(r"C:\already"), Ok(r"C:\already".into()));
        assert_eq!(p(r"\\?\C:\"), Ok(r"C:\".into()));
        assert!(p(r"\\?\C:\dir\trailing.").is_err());
        assert!(p(r"\\?\C:\dir\nul.txt").is_err());
        assert!(p(r"\\?\Volume{0000}\x").is_err());
        assert!(p(&format!(r"\\?\C:\{}", "a".repeat(300))).is_err());
    }
}
