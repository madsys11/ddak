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

// Windows에서 실행되거나 설치·설정을 바꾸는 형식 (AssocIsDangerous와 함께 본다)
#[cfg(windows)]
const WINDOWS_RUNNABLE: &[&str] = &[
    "exe", "com", "bat", "cmd", "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "msp", "mst", "msix", "msixbundle",
    "appx", "appxbundle", "appref-ms", "lnk", "url", "scr", "cpl", "hta", "pif", "reg", "inf", "scf", "gadget", "application", "jar",
    "ws", "msc", "settingcontent-ms", "library-ms", "search-ms", "diagcab", "py", "pyw", "pl", "rb",
];

// 자체 테스트는 열지 않고 기록한다 (selftest_opened_links)
static OPENED: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

fn selftest() -> bool {
    std::env::var_os("DDAK_SELFTEST").is_some()
}

fn home() -> Option<PathBuf> {
    crate::platform::home()
}

// 상대 경로의 기준: 폴더들 (앞의 것부터), 그 바로 아래 git 저장소들 (처음 필요할 때 한 번 구해 후보들이 같이 쓴다)
struct Bases {
    dirs: Vec<PathBuf>,
    repos: std::cell::OnceCell<Option<Vec<PathBuf>>>,
}

// 저장소가 이보다 많으면 모두 보지 않고 모른다고 한다 (일부만 보고 "한 곳"이라 정하면 다른 파일을 열 수 있다, 리뷰 R2)
const MAX_REPOS: usize = 256;

impl Bases {
    fn new(dirs: Vec<PathBuf>) -> Self {
        // 같은 폴더가 두 번이면 한 번만 (프로그램의 현재 폴더 = 창의 폴더인 흔한 경우)
        let mut unique: Vec<PathBuf> = Vec::new();
        for d in dirs {
            if !unique.iter().any(|u| u == &d || same_file(u, &d)) {
                unique.push(d);
            }
        }
        Bases { dirs: unique, repos: std::cell::OnceCell::new() }
    }

    // 폴더들 바로 아래의 git 저장소 (`.git`이 폴더거나 worktree의 파일). MAX_REPOS를 넘으면 None (모름)
    fn repos(&self) -> Option<&[PathBuf]> {
        self.repos
            .get_or_init(|| {
                let mut repos = Vec::new();
                for dir in &self.dirs {
                    let Ok(entries) = std::fs::read_dir(dir) else { continue };
                    for p in entries.flatten().map(|e| e.path()) {
                        if p.is_dir() && p.join(".git").exists() {
                            repos.push(p);
                            if repos.len() > MAX_REPOS {
                                return None;
                            }
                        }
                    }
                }
                Some(repos)
            })
            .as_deref()
    }
}

// 후보 하나를 실제 있는 절대 경로로. `~/`는 홈, 상대 경로는 기준 폴더를 차례로.
// 어디에도 없으면 그 바로 아래 git 저장소 기준으로도 본다: 작업그룹 세션은 저장소들의 위 폴더에서 돌고, 에이전트는 저장소
// 안의 경로(`docs/spec.md`)로 말한다. 저장소 한 곳에서만 찾아질 때만 (여러 곳이면 어느 것인지 몰라 링크로 보지 않는다.
// 같은 실제 대상을 가리키는 저장소 링크는 한 곳)
fn resolve(candidate: &str, bases: &Bases) -> Option<PathBuf> {
    let candidate = crate::platform::from_msys(candidate);
    let candidate = candidate.as_ref();
    let path = if let Some(rest) = candidate.strip_prefix("~/") {
        home()?.join(rest)
    } else {
        PathBuf::from(candidate)
    };
    if path.is_absolute() {
        return path.exists().then_some(path);
    }
    if let Some(found) = bases.dirs.iter().map(|b| b.join(&path)).find(|p| p.exists()) {
        return Some(found);
    }
    let mut found: Option<PathBuf> = None;
    for repo in bases.repos()? {
        let p = repo.join(&path);
        if !p.exists() {
            continue;
        }
        match &found {
            None => found = Some(p),
            Some(f) if same_file(f, &p) => {}
            Some(_) => return None,
        }
    }
    found
}

fn same_file(a: &Path, b: &Path) -> bool {
    matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: i32) -> Option<PathBuf> {
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
fn process_cwd(_pid: i32) -> Option<PathBuf> {
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
    let bases = Bases::new(bases);
    candidates.iter().map(|c| resolve(c, &bases).map(|p| p.to_string_lossy().into_owned())).collect()
}

enum Action {
    Url(String),
    Open(PathBuf),
    Reveal(PathBuf),
}

#[cfg(unix)]
fn runnable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase());
    if ext.is_some_and(|e| RUNNABLE.contains(&e.as_str())) {
        return true;
    }
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

// Windows: 실행 권한이 없어서 형식으로만 안다. 알려진 실행·설치·바로 가기 형식이거나 셸이 위험하다고 하는 연결
// (AssocIsDangerous)이면 실행될 수 있는 것. 폴더는 열고, 확장자 없는 파일은 실행되지 않는다.
#[cfg(windows)]
fn runnable(path: &Path) -> bool {
    if path.is_dir() {
        return false;
    }
    let Some(ext) = path.extension().map(|e| e.to_string_lossy().to_lowercase()) else {
        return false;
    };
    if RUNNABLE.contains(&ext.as_str()) || WINDOWS_RUNNABLE.contains(&ext.as_str()) {
        return true;
    }
    let assoc: Vec<u16> = format!(".{ext}").encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { windows_sys::Win32::UI::Shell::AssocIsDangerous(assoc.as_ptr()) != 0 }
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
    let real = crate::platform::canonical(&path).map_err(|e| format!("{target}: {e}"))?;
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

// 유닉스 권한·링크·sh를 쓰는 시험 (Windows 시험은 platform.rs·conpty.rs·fs.rs)
#[cfg(all(test, unix))]
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
        assert_eq!(resolve("docs/spec.md", &Bases::new(bases.to_vec())), Some(b.join("docs/spec.md")));
        assert_eq!(resolve("docs/none.md", &Bases::new(bases.to_vec())), None);
        let abs = b.join("docs/spec.md");
        assert_eq!(resolve(abs.to_str().unwrap(), &Bases::new(Vec::new())), Some(abs.clone()));
        // 저장소들의 위 폴더: 바로 아래 git 저장소 한 곳에만 있으면 그것, 여러 곳이면 모름, 저장소가 아닌 폴더는 보지 않음
        for (repo, git_dir) in [("one", true), ("two", false)] {
            std::fs::create_dir_all(a.join(repo).join("src")).unwrap();
            if git_dir {
                std::fs::create_dir(a.join(repo).join(".git")).unwrap();
            } else {
                std::fs::write(a.join(repo).join(".git"), "gitdir: elsewhere\n").unwrap();
            }
        }
        std::fs::create_dir_all(a.join("plain/src")).unwrap();
        std::fs::write(a.join("one/src/a.rs"), "").unwrap();
        std::fs::write(a.join("plain/src/b.rs"), "").unwrap();
        assert_eq!(resolve("src/a.rs", &Bases::new(vec![a.clone()])), Some(a.join("one/src/a.rs")));
        assert_eq!(resolve("src/b.rs", &Bases::new(vec![a.clone()])), None);
        std::fs::write(a.join("two/src/a.rs"), "").unwrap();
        assert_eq!(resolve("src/a.rs", &Bases::new(vec![a.clone()])), None);
        // 폴더 자체에 있으면 저장소보다 먼저
        std::fs::create_dir(a.join("src")).unwrap();
        std::fs::write(a.join("src/a.rs"), "").unwrap();
        assert_eq!(resolve("src/a.rs", &Bases::new(vec![a.clone()])), Some(a.join("src/a.rs")));
        // 같은 실제 저장소를 가리키는 링크는 한 곳으로 친다
        let c = scratch("base-c");
        std::fs::create_dir_all(c.join("real/.git")).unwrap();
        std::fs::create_dir_all(c.join("real/docs")).unwrap();
        std::fs::write(c.join("real/docs/x.md"), "").unwrap();
        std::os::unix::fs::symlink(c.join("real"), c.join("alias")).unwrap();
        assert_eq!(resolve("docs/x.md", &Bases::new(vec![c.clone()])).map(|p| p.canonicalize().unwrap()), Some(c.join("real/docs/x.md")));
        // 이름 순으로 멀리 떨어진 두 저장소(첫째와 서른셋째)에 같은 경로가 있으면 모름. 저장소가 너무 많으면 모름
        let d = scratch("base-d");
        for i in 0..40 {
            std::fs::create_dir_all(d.join(format!("r{i:02}/.git"))).unwrap();
        }
        for i in [0, 32] {
            std::fs::create_dir_all(d.join(format!("r{i:02}/docs"))).unwrap();
            std::fs::write(d.join(format!("r{i:02}/docs/guide.md")), "").unwrap();
        }
        assert_eq!(resolve("docs/guide.md", &Bases::new(vec![d.clone()])), None);
        std::fs::write(d.join("r05/only.md"), "").unwrap();
        assert_eq!(resolve("only.md", &Bases::new(vec![d.clone()])), Some(d.join("r05/only.md")));
        for i in 40..=MAX_REPOS {
            std::fs::create_dir_all(d.join(format!("r{i:03}/.git"))).unwrap();
        }
        assert_eq!(resolve("only.md", &Bases::new(vec![d.clone()])), None);
        let _ = std::fs::remove_dir_all(c);
        let _ = std::fs::remove_dir_all(d);
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
        let got = process_cwd(std::process::id() as i32).unwrap().canonicalize().unwrap();
        assert_eq!(got, cwd);
    }
}
