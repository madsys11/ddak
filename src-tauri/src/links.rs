// 터미널 링크 (src/terminalLinks.ts): 화면 글자에서 찾은 파일 경로가 실제로 있는지 보고, ⌘+클릭하면 기본 앱으로 연다.
// 상대 경로는 그 터미널 앞에서 도는 프로그램의 현재 폴더 기준 (셸에서 cd 한 뒤의 `ls` 출력도 맞게). 못 찾으면 창을 띄운 폴더.
// 실행될 수 있는 것(실행 권한, .app·.command 등)은 열지 않고 Finder에서 보이기만 한다: 에이전트 출력의 경로를 눌렀다가
// 스크립트가 실행되지 않게.
use crate::pty::Ptys;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

// 눌러도 열지 않고 Finder에서 보이기만 하는 확장자 (macOS가 열면서 실행하는 것)
const RUNNABLE: &[&str] = &[
    "app", "command", "tool", "terminal", "sh", "zsh", "bash", "csh", "fish", "pkg", "mpkg", "workflow", "scpt", "scptd",
    "applescript", "jar", "webloc", "inetloc", "fileloc", "prefpane", "kext", "action", "osax",
];

// 자체 테스트는 열지 않고 기록한다 (selftest_opened_links)
static OPENED: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

fn selftest() -> bool {
    std::env::var_os("DDAK_SELFTEST").is_some()
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

// 후보 하나를 실제 있는 절대 경로로. `~/`는 홈, 상대 경로는 bases를 차례로.
fn resolve(candidate: &str, bases: &[PathBuf]) -> Option<PathBuf> {
    let path = if let Some(rest) = candidate.strip_prefix("~/") {
        home()?.join(rest)
    } else {
        PathBuf::from(candidate)
    };
    if path.is_absolute() {
        return path.exists().then_some(path);
    }
    bases.iter().map(|b| b.join(&path)).find(|p| p.exists())
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: libc::pid_t) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, (&mut info as *mut libc::proc_vnodepathinfo).cast(), size) };
    if n != size {
        return None;
    }
    let raw: &[u8; 1024] = unsafe { &*(info.pvi_cdir.vip_path.as_ptr() as *const [u8; 1024]) };
    let len = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
    (len > 0).then(|| PathBuf::from(std::ffi::OsStr::from_bytes(&raw[..len])))
}

#[cfg(not(target_os = "macos"))]
fn process_cwd(_pid: libc::pid_t) -> Option<PathBuf> {
    None
}

// 후보마다 실제 있는 절대 경로 (없으면 None)
#[tauri::command]
pub fn link_targets(ptys: State<'_, Ptys>, id: Option<u32>, cwd: String, candidates: Vec<String>) -> Vec<Option<String>> {
    let mut bases = Vec::new();
    if let Some(dir) = id.and_then(|id| ptys.foreground_pid(id)).and_then(process_cwd) {
        bases.push(dir);
    }
    bases.push(PathBuf::from(cwd));
    candidates.iter().map(|c| resolve(c, &bases).map(|p| p.to_string_lossy().into_owned())).collect()
}

enum Action {
    Url(String),
    Open(PathBuf),
    Reveal(PathBuf),
}

fn runnable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase());
    if ext.is_some_and(|e| RUNNABLE.contains(&e.as_str())) {
        return true;
    }
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

// 무엇을 할지: http(s)는 브라우저, 있는 파일·폴더는 기본 앱(실행될 수 있으면 Finder에서 보이기). 그 밖은 거절.
fn action(target: &str) -> Result<Action, String> {
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Ok(Action::Url(target.to_string()));
    }
    let path = if lower.starts_with("file://") {
        let url = url::Url::parse(target).map_err(|e| e.to_string())?;
        url.to_file_path().map_err(|_| format!("not a local file: {target}"))?
    } else {
        PathBuf::from(target)
    };
    if !path.is_absolute() {
        return Err(format!("no such file: {target}"));
    }
    // 실행 판정은 적힌 이름과 실제 대상 모두로 (리뷰 R2: `X.app/Contents/..`나 다른 이름의 링크로 .app·.command를 열 수 있었다)
    let real = path.canonicalize().map_err(|_| format!("no such file: {target}"))?;
    Ok(if runnable(&path) || runnable(&real) { Action::Reveal(real) } else { Action::Open(real) })
}

#[tauri::command]
pub fn open_link(target: String) -> Result<(), String> {
    let action = action(&target)?;
    if selftest() {
        let (kind, what) = match action {
            Action::Url(u) => ("url", u),
            Action::Open(p) => ("open", p.to_string_lossy().into_owned()),
            Action::Reveal(p) => ("reveal", p.to_string_lossy().into_owned()),
        };
        OPENED.lock().unwrap().push((kind.to_string(), what));
        return Ok(());
    }
    match action {
        Action::Url(u) => tauri_plugin_opener::open_url(u, None::<&str>),
        Action::Open(p) => tauri_plugin_opener::open_path(p, None::<&str>),
        Action::Reveal(p) => tauri_plugin_opener::reveal_item_in_dir(p),
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn selftest_opened_links() -> Vec<(String, String)> {
    std::mem::take(&mut *OPENED.lock().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ddak-links-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn resolves_relative_paths_against_each_base() {
        let a = scratch("base-a");
        let b = scratch("base-b");
        std::fs::create_dir(b.join("docs")).unwrap();
        std::fs::write(b.join("docs/spec.md"), "").unwrap();
        let bases = [a.clone(), b.clone()];
        assert_eq!(resolve("docs/spec.md", &bases), Some(b.join("docs/spec.md")));
        assert_eq!(resolve("docs/none.md", &bases), None);
        let abs = b.join("docs/spec.md");
        assert_eq!(resolve(abs.to_str().unwrap(), &[]), Some(abs.clone()));
        let _ = std::fs::remove_dir_all(a);
        let _ = std::fs::remove_dir_all(b);
    }

    #[test]
    fn opens_only_existing_files_and_web_urls() {
        let dir = scratch("open");
        let page = dir.join("report.html");
        std::fs::write(&page, "").unwrap();
        assert!(matches!(action(page.to_str().unwrap()), Ok(Action::Open(_))));
        let url = url::Url::from_file_path(&page).unwrap().to_string();
        assert!(matches!(action(&url), Ok(Action::Open(p)) if p == page));
        assert!(matches!(action("https://example.com/a"), Ok(Action::Url(_))));
        assert!(action("javascript:alert(1)").is_err());
        assert!(action("relative/report.html").is_err());
        assert!(action(dir.join("none.md").to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn runnable_files_are_only_revealed() {
        let dir = scratch("runnable");
        let script = dir.join("run");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let command = dir.join("x.command");
        std::fs::write(&command, "").unwrap();
        let app = dir.join("X.app");
        std::fs::create_dir(&app).unwrap();
        for p in [&script, &command, &app] {
            assert!(matches!(action(p.to_str().unwrap()), Ok(Action::Reveal(_))), "{p:?}");
        }
        assert!(matches!(action(dir.to_str().unwrap()), Ok(Action::Open(_))));
        // 이름으로는 안 보이게 돌아가도 실제 대상으로 판정한다
        std::fs::create_dir(app.join("Contents")).unwrap();
        let dotted = format!("{}/Contents/..", app.display());
        std::os::unix::fs::symlink(&command, dir.join("notes.txt")).unwrap();
        std::os::unix::fs::symlink(&app, dir.join("folder")).unwrap();
        for p in [dotted, dir.join("notes.txt").display().to_string(), dir.join("folder").display().to_string()] {
            assert!(matches!(action(&p), Ok(Action::Reveal(r)) if r.extension().is_some()), "{p}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_a_process_working_directory() {
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        let got = process_cwd(std::process::id() as libc::pid_t).unwrap().canonicalize().unwrap();
        assert_eq!(got, cwd);
    }
}
