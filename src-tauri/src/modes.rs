// 세션의 권한 모드 바꾸기 (docs/spec.md "권한 모드 바꾸기"). claude는 Shift+Tab을 누를 때마다 모드를 돌리고 (자동 → 수동 →
// 편집 허용 → 계획 → 자동, claude 2.1.312) 지금 모드를 화면 맨 아래 줄에 쓴다. 폰에서 자동 모드에 막힌 명령을 승인하려면 수동
// 모드로 바꿔 권한 확인 창이 뜨게 해야 하는데, 맥 앞에 없으면 Shift+Tab을 누를 수 없었다.
//
// - 모드 줄을 읽는 것은 프론트다 (src/programStatus.ts readMode, Terminal.tsx): 바뀌면 `pty_mode`로 알린다 (pty.rs).
// - 바꾸기: Rust가 프론트에 `mode-set`을 보내고, 프론트가 Shift+Tab을 하나씩 보내 모드 줄이 바뀐 것을 확인하며 고른 모드까지
//   간다 (programStatus.ts driveMode). 키는 `mode_write`로 써서 Rust가 지금 요청인지 다시 본다. 결과(`mode_result`)를 채팅에 기록한다.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{Emitter, Manager, State};

use crate::chat::{ChatsState, ModeChange, Record, USER};

// 고를 수 있는 모드 (모드 줄의 bypass는 읽기만 한다: 폰에서 권한 확인을 모두 끄지 않는다)
pub const MODES: [&str; 4] = ["auto", "manual", "acceptEdits", "plan"];

// 결과가 오지 않으면 이만큼 뒤에 다시 받는다 (새 요청 번호: 앞 요청의 키·결과는 버린다)
const RUN_WAIT: Duration = Duration::from_secs(10);

struct Run {
    request: u64,
    at: Instant,
    project: PathBuf,
    member: String,
    mode: String,
    via: Option<String>,
}

// 모드를 바꿀 터미널 후보 (set_mode가 모은다)
pub struct Term {
    pub pty: u32,
    // 모드 줄에서 읽은 지금 모드
    pub mode: String,
    // 사용자를 기다리는 중 (선택 창 등)
    pub awaiting: bool,
    // bypass를 켤 수 있는 세션 (bypass_possible)
    pub bypass: bool,
}

#[derive(Default)]
pub struct Modes {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    // 마지막 요청 번호
    requests: u64,
    // 터미널 → 지금 바꾸는 중인 것
    runs: HashMap<u32, Run>,
}

impl Modes {
    // 바꾸기를 시작한다: (터미널, 요청 번호). terminals: 그 참여자의 터미널 중 모드 줄을 읽은 것.
    // 꼭 하나여야 하고 (같은 이름이 둘이면 어느 쪽인지 모른다), 선택 창 등으로 사용자를 기다리는 중이 아니고, bypass를 켤 수
    // 없고 (bypass_possible, 지금 bypass인 것 포함), 그 터미널에서 바꾸는 중인 것이 없어야 한다
    pub fn begin(&self, project: &Path, member: &str, mode: &str, terminals: &[Term], via: Option<&str>, now: Instant) -> Result<(u32, u64), String> {
        if !MODES.contains(&mode) {
            return Err("mode".into());
        }
        let t = match terminals {
            [] => return Err("none".into()),
            [one] => one,
            _ => return Err("ambiguous".into()),
        };
        if t.awaiting {
            return Err("awaiting".into());
        }
        if t.bypass || t.mode == "bypass" {
            return Err("bypass".into());
        }
        let mut inner = self.inner.lock().unwrap();
        if inner.runs.get(&t.pty).is_some_and(|r| now.duration_since(r.at) < RUN_WAIT) {
            return Err("busy".into());
        }
        inner.requests += 1;
        let request = inner.requests;
        inner.runs.insert(t.pty, Run { request, at: now, project: project.to_path_buf(), member: member.to_string(), mode: mode.to_string(), via: via.map(str::to_string) });
        Ok((t.pty, request))
    }

    // 키를 쓴다: 그 터미널의 지금 요청일 때만, 잠금을 쥔 채로 (늦게 온 앞 요청의 키는 쓰이지 않는다)
    pub fn guarded<T>(&self, pty: u32, request: u64, write: impl FnOnce() -> T) -> Result<T, String> {
        let inner = self.inner.lock().unwrap();
        if !inner.runs.get(&pty).is_some_and(|r| r.request == request) {
            return Err("stale".into());
        }
        Ok(write())
    }

    // 프론트가 알린 결과. 지금 요청의 것만 받는다: 기록할 (프로젝트, 기록, 보낸 기기)
    pub fn finish(&self, pty: u32, request: u64, result: &str) -> Option<(PathBuf, ModeChange, Option<String>)> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.runs.get(&pty).is_some_and(|r| r.request == request) {
            return None;
        }
        let r = inner.runs.remove(&pty).unwrap();
        Some((r.project, ModeChange { member: r.member, mode: r.mode, result: result.to_string() }, r.via))
    }
}

// 그 프로젝트 참여자의 모드: (이름, 모드). 같은 이름의 터미널 중 모드 줄을 읽은 것이 꼭 하나일 때만 (폰의 참여자 칩, mobile.rs)
pub fn modes_in(app: &tauri::AppHandle, project: &Path) -> Vec<(String, String)> {
    let Some(chats) = app.state::<ChatsState>().0.clone() else { return Vec::new() };
    let modes = app.state::<crate::pty::Ptys>().modes();
    let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
    for (token, name) in chats.member_tokens(project) {
        for (_, _, mode, _) in modes.iter().filter(|(_, t, ..)| *t == token) {
            by_name.entry(name.clone()).or_default().push(mode.clone());
        }
    }
    let mut list: Vec<(String, String)> = by_name.into_iter().filter(|(_, m)| m.len() == 1).map(|(n, mut m)| (n, m.remove(0))).collect();
    list.sort();
    list
}

// 지금 앞에서 도는 프로세스의 인자 (셸에서 직접 띄운 claude 등). 알 수 없으면 (Windows, 프로세스를 찾거나 읽지 못함) Unknown
pub enum Foreground {
    Args(Vec<String>),
    Unknown,
}

// bypass(권한 확인을 모두 끔)를 켤 수 있는 세션인지 (리뷰 R1). claude는 --dangerously-skip-permissions·
// --allow-dangerously-skip-permissions·--permission-mode bypassPermissions로 띄우거나 설정의 permissions.defaultMode가
// bypassPermissions면 Shift+Tab이 bypass도 돈다. 그 자리는 알 수 없어서 (켜 보려면 사용자 설정에 동의를 남겨야 한다) 그런
// 세션은 바꾸지 않는다. 확인하지 못하면 켤 수 있다고 본다 (재리뷰 R1):
// - argv: 띄운 인자, fg: 지금 앞에서 도는 프로세스의 인자 (모르면 켤 수 있음). 그 글이 있으면 켤 수 있음.
// - --settings로 준 설정 (재리뷰 R1): JSON이든 파일이든 해석해서 본다 (risky_settings, 읽거나 해석하지 못하면 켤 수 있음). 띄운
//   인자의 상대 경로는 작업 폴더 기준, 앞 프로세스의 상대 경로는 그 프로세스의 폴더를 몰라 켤 수 있음.
// - standard: claude가 늘 보는 설정 파일 (settings_files). 없으면 괜찮고, 있는데 읽거나 해석하지 못하면 켤 수 있음
pub fn bypass_possible(argv: &[String], cwd: &Path, fg: &Foreground, standard: &[PathBuf]) -> bool {
    let Foreground::Args(fg) = fg else { return true };
    if argv.iter().chain(fg).any(|a| risky(a)) {
        return true;
    }
    let (Some((mut files, mut inline)), Some((more_files, more_inline))) = (settings_args(argv, Some(cwd)), settings_args(fg, None)) else { return true };
    files.extend(more_files);
    inline.extend(more_inline);
    inline.iter().any(|t| risky_settings(t))
        || files.iter().any(|p| std::fs::read_to_string(p).map_or(true, |t| risky_settings(&t)))
        || standard.iter().any(|p| std::fs::read_to_string(p).map_or_else(|e| e.kind() != std::io::ErrorKind::NotFound, |t| risky_settings(&t)))
}

fn risky(s: &str) -> bool {
    s.contains("skip-permissions") || s.contains("bypassPermissions")
}

// 설정(JSON)에 bypass가 있는지: 해석해서 모든 키와 문자열 값을 이스케이프를 푼 채로 본다 (재리뷰 2회 R1: 원문으로 찾으니
// "bypass\u0050ermissions"를 놓쳤다). 해석하지 못하면 있다고 본다. 비어 있으면 (빈칸뿐) 설정이 없는 것
fn risky_settings(text: &str) -> bool {
    fn walk(v: &serde_json::Value) -> bool {
        match v {
            serde_json::Value::String(s) => risky(s),
            serde_json::Value::Array(a) => a.iter().any(walk),
            serde_json::Value::Object(o) => o.iter().any(|(k, v)| risky(k) || walk(v)),
            _ => false,
        }
    }
    if text.trim().is_empty() {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(text).map_or(true, |v| walk(&v))
}

// --settings <파일 또는 JSON>, --settings=<…>로 준 설정: (파일, JSON 글). 상대 경로는 base 기준 (base가 없거나 값이 없으면 None)
fn settings_args(args: &[String], base: Option<&Path>) -> Option<(Vec<PathBuf>, Vec<String>)> {
    let (mut files, mut inline) = (Vec::new(), Vec::new());
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let value = if a == "--settings" { it.next()? } else if let Some(v) = a.strip_prefix("--settings=") { v } else { continue };
        if value.trim_start().starts_with('{') {
            inline.push(value.to_string());
            continue;
        }
        let path = Path::new(value);
        files.push(if path.is_absolute() { path.to_path_buf() } else { base?.join(path) });
    }
    Some((files, inline))
}

// claude가 읽을 수 있는 설정 파일: 작업 폴더와 그 위 폴더들의 .claude/settings(.local).json, 사용자 설정 폴더
// (CLAUDE_CONFIG_DIR, 없으면 ~/.claude), 관리 설정
fn settings_files(cwd: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = cwd.ancestors().map(|d| d.join(".claude")).collect();
    dirs.extend(std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).or_else(|| crate::platform::home().map(|h| h.join(".claude"))));
    let mut files: Vec<PathBuf> = dirs.iter().flat_map(|d| [d.join("settings.json"), d.join("settings.local.json")]).collect();
    #[cfg(target_os = "macos")]
    files.push(PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json"));
    #[cfg(target_os = "linux")]
    files.push(PathBuf::from("/etc/claude-code/managed-settings.json"));
    #[cfg(windows)]
    files.push(PathBuf::from(r"C:\ProgramData\ClaudeCode\managed-settings.json"));
    files
}

// 지금 앞에서 도는 프로세스의 인자 (재리뷰 2회 R1: ps 출력을 빈칸으로 나누면 --settings의 JSON을 되살릴 수 없어, 커널이 가진
// 인자 목록을 그대로 읽는다)
#[cfg(unix)]
fn foreground(ptys: &crate::pty::Ptys, pty: u32) -> Foreground {
    match ptys.foreground_pid(pty).and_then(process_args) {
        Some(args) => Foreground::Args(args),
        None => Foreground::Unknown,
    }
}

// 프로세스의 인자 목록 (맥 sysctl KERN_PROCARGS2: argc, 실행 파일 경로, NUL 채움, 인자들이 NUL로 나뉨)
#[cfg(target_os = "macos")]
fn process_args(pid: i32) -> Option<Vec<String>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size: libc::size_t = 0;
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    let mut buf = vec![0u8; size];
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    buf.truncate(size);
    let argc = usize::try_from(i32::from_ne_bytes(buf.get(..4)?.try_into().ok()?)).ok()?;
    let rest = &buf[4..];
    let rest = &rest[rest.iter().position(|&b| b == 0)?..];
    let rest = &rest[rest.iter().position(|&b| b != 0)?..];
    let args: Vec<String> = rest.split(|&b| b == 0).take(argc).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
    (args.len() == argc).then_some(args)
}

// 프로세스의 인자 목록 (리눅스 /proc/<pid>/cmdline: NUL로 나뉨)
#[cfg(all(unix, not(target_os = "macos")))]
fn process_args(pid: i32) -> Option<Vec<String>> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let raw = raw.strip_suffix(&[0]).unwrap_or(&raw);
    Some(raw.split(|&b| b == 0).map(|a| String::from_utf8_lossy(a).into_owned()).collect())
}

// Windows의 ConPTY에는 앞 프로세스를 알 길이 없다 (pty.rs foreground_pid): 셸에서 직접 띄운 claude를 놓치지 않게 모른다고 한다
#[cfg(windows)]
fn foreground(_: &crate::pty::Ptys, _: u32) -> Foreground {
    Foreground::Unknown
}

// 모드를 바꾼다 (폰 mobile.rs, 맥 chat_set_mode). 프론트가 넣고 결과를 mode_result로 알린다
pub fn set_mode(app: &tauri::AppHandle, project: &Path, member: &str, mode: &str, via: Option<&str>) -> Result<(), String> {
    let chats = app.state::<ChatsState>().0.clone().ok_or("chat")?;
    let tokens = chats.tokens_named(project, &[member.to_string()]);
    let ptys = app.state::<crate::pty::Ptys>();
    let terminals: Vec<Term> = ptys
        .modes()
        .into_iter()
        .filter(|(_, t, ..)| tokens.contains(t))
        .map(|(pty, _, mode, awaiting)| {
            let bypass = match ptys.launch(pty) {
                Some((argv, cwd)) => bypass_possible(&argv, &cwd, &foreground(&ptys, pty), &settings_files(&cwd)),
                None => true,
            };
            Term { pty, mode, awaiting, bypass }
        })
        .collect();
    let (pty, request) = app.state::<Modes>().begin(project, member, mode, &terminals, via, Instant::now())?;
    app.emit("mode-set", json!({ "pty": pty, "mode": mode, "request": request })).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_set_mode(app: tauri::AppHandle, project: String, member: String, mode: String) -> Result<(), String> {
    let project = crate::platform::canonical(&project).unwrap_or_else(|_| PathBuf::from(&project));
    set_mode(&app, &project, &member, &mode, None)
}

// 자체 테스트: 그 프로젝트 참여자의 모드 (폰의 members.modes와 같은 것)
#[tauri::command]
pub fn selftest_chat_modes(app: tauri::AppHandle, project: String) -> Vec<(String, String)> {
    let project = crate::platform::canonical(&project).unwrap_or_else(|_| PathBuf::from(&project));
    modes_in(&app, &project)
}

// 키 하나를 그 터미널에 쓴다 (프론트 Terminal.tsx). 지금 요청이 아니면 "stale"
#[tauri::command]
pub fn mode_write(ptys: State<'_, crate::pty::Ptys>, chats: State<'_, ChatsState>, modes: State<'_, Modes>, id: u32, request: u64, data: String) -> Result<(), String> {
    let typed_in = modes.guarded(id, request, || crate::pty::write_input(&ptys, id, &data, true))??;
    // 사용자 입력처럼 (pty_write와 같게, 잠금 밖에서)
    if let (Some(token), Some(chats)) = (typed_in, chats.0.as_ref()) {
        chats.user_input(&token);
    }
    Ok(())
}

// 프론트가 모드를 바꾼 결과 (sent·changed·failed). 채팅에 기록한다
#[tauri::command]
pub fn mode_result(app: tauri::AppHandle, modes: State<'_, Modes>, id: u32, request: u64, result: String) {
    let Some((project, change, via)) = modes.finish(id, request, &result) else { return };
    if let Some(chats) = app.state::<ChatsState>().0.clone() {
        let text = format!("{}: {} — {}", change.member, change.mode, change.result);
        if let Err(e) = chats.post_note(&project, USER, &text, Vec::new(), Record::Mode(change), via.as_deref()) {
            eprintln!("모드 바꾸기를 기록하지 못함: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn term(pty: u32) -> Term {
        Term { pty, mode: "auto".into(), awaiting: false, bypass: false }
    }

    #[test]
    fn begins_only_for_one_idle_terminal() {
        let m = Modes::default();
        let now = Instant::now();
        let p = Path::new("/p");
        assert_eq!(m.begin(p, "dev", "bypass", &[term(1)], None, now), Err("mode".into()));
        assert_eq!(m.begin(p, "dev", "manual", &[], None, now), Err("none".into()));
        assert_eq!(m.begin(p, "dev", "manual", &[term(1), term(2)], None, now), Err("ambiguous".into()));
        assert_eq!(m.begin(p, "dev", "manual", &[Term { awaiting: true, ..term(1) }], None, now), Err("awaiting".into()));
        // bypass를 켤 수 있거나 지금 bypass인 세션은 바꾸지 않는다 (리뷰 R1)
        assert_eq!(m.begin(p, "dev", "manual", &[Term { bypass: true, ..term(1) }], None, now), Err("bypass".into()));
        assert_eq!(m.begin(p, "dev", "manual", &[Term { mode: "bypass".into(), ..term(1) }], None, now), Err("bypass".into()));
        let (pty, first) = m.begin(p, "dev", "manual", &[term(1)], Some("phone"), now).unwrap();
        assert_eq!(pty, 1);
        // 바꾸는 중에는 받지 않고, 결과가 오지 않으면 RUN_WAIT 뒤 새 번호로 다시 받는다
        assert_eq!(m.begin(p, "dev", "plan", &[term(1)], None, now), Err("busy".into()));
        let (_, second) = m.begin(p, "dev", "plan", &[term(1)], None, now + RUN_WAIT).unwrap();
        assert!(second > first);
        // 앞 요청의 키·결과는 버린다
        assert_eq!(m.guarded(1, first, || ()), Err("stale".into()));
        assert!(m.finish(1, first, "sent").is_none());
        assert_eq!(m.guarded(1, second, || 7), Ok(7));
        let (project, change, via) = m.finish(1, second, "sent").unwrap();
        assert_eq!((project, change, via), (PathBuf::from("/p"), ModeChange { member: "dev".into(), mode: "plan".into(), result: "sent".into() }, None));
        // 끝난 요청은 다시 쓰지 않는다
        assert_eq!(m.guarded(1, second, || ()), Err("stale".into()));
        assert!(m.finish(1, second, "sent").is_none());
    }

    // bypass를 켤 수 있는지: 인자나 설정 파일에 그 글이 있거나, 있는 설정 파일을 읽지 못하면 (리뷰 R1). --settings로 준 파일과
    // 확인하지 못하는 앞 프로세스도 (재리뷰 R1)
    #[test]
    fn sees_bypass_in_args_and_settings() {
        let dir = std::env::temp_dir().join(format!("ddak-modes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let plain = dir.join("plain.json");
        let risky = dir.join("risky.json");
        let unreadable = dir.join("folder.json");
        std::fs::write(&plain, r#"{"permissions":{"defaultMode":"acceptEdits"},"disableBypassPermissionsMode":"disable"}"#).unwrap();
        std::fs::write(&risky, r#"{"permissions":{"defaultMode":"bypassPermissions"}}"#).unwrap();
        std::fs::write(dir.join("sub/custom.json"), r#"{"permissions":{"defaultMode":"bypassPermissions"}}"#).unwrap();
        std::fs::write(dir.join("sub/ok.json"), "{}").unwrap();
        std::fs::create_dir_all(&unreadable).unwrap();
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let fg = |a: &[&str]| Foreground::Args(args(a));
        let none = fg(&[]);
        let cwd = dir.join("sub");
        let missing = dir.join("missing.json");
        let check = |argv: &[&str], f: &Foreground, standard: &[PathBuf]| bypass_possible(&args(argv), &cwd, f, standard);
        // ddak의 기본 세션 인자 (--settings JSON)는 괜찮다
        assert!(!check(&["claude", "--permission-mode", "auto", "--settings", r#"{"hooks":{}}"#], &fg(&["claude", "--settings", r#"{"hooks":{}}"#]), &[plain.clone(), missing.clone()]));
        assert!(check(&["claude", "--dangerously-skip-permissions"], &none, &[]));
        assert!(check(&["claude", "--allow-dangerously-skip-permissions"], &none, &[]));
        assert!(check(&["claude", "--permission-mode=bypassPermissions"], &none, &[]));
        assert!(check(&["claude"], &fg(&["claude", "--dangerously-skip-permissions"]), &[]));
        assert!(check(&["claude"], &none, &[plain.clone(), risky.clone()]));
        assert!(check(&["claude"], &none, &[plain.clone(), unreadable]));
        // --settings 파일: 상대 경로(작업 폴더 기준)·= 형식·절대 경로, 없는 파일은 켤 수 있음, 앞 프로세스의 상대 경로는 모름
        assert!(check(&["claude", "--settings", "custom.json"], &none, &[]));
        assert!(check(&["claude", "--settings=custom.json"], &none, &[]));
        assert!(check(&["claude", "--settings", &risky.to_string_lossy()], &none, &[]));
        assert!(!check(&["claude", "--settings", "ok.json"], &none, &[]));
        assert!(check(&["claude", "--settings", "gone.json"], &none, &[]));
        assert!(check(&["claude", "--settings"], &none, &[]));
        assert!(check(&["claude"], &fg(&["claude", "--settings", "ok.json"]), &[]));
        assert!(!check(&["claude"], &fg(&["claude", "--settings", &cwd.join("ok.json").to_string_lossy()]), &[]));
        // 앞 프로세스를 확인하지 못하면 켤 수 있음
        assert!(check(&["claude"], &Foreground::Unknown, &[]));
        // 설정은 해석해서 본다: JSON 이스케이프로 쓴 bypass (인자의 JSON, --settings 파일, 표준 설정 파일), 해석하지 못하는 설정은
        // 켤 수 있음, 빈 설정 파일은 괜찮음 (재리뷰 2회 R1)
        let escaped = r#"{"permissions":{"defaultMode":"bypass\u0050ermissions"}}"#;
        std::fs::write(dir.join("sub/escaped.json"), escaped).unwrap();
        std::fs::write(dir.join("sub/broken.json"), r#"{"permissions":"#).unwrap();
        std::fs::write(dir.join("sub/empty.json"), " \n").unwrap();
        assert!(check(&["claude", "--settings", escaped], &none, &[]));
        assert!(check(&["claude", &format!("--settings={escaped}")], &none, &[]));
        assert!(check(&["claude"], &fg(&["claude", "--settings", escaped]), &[]));
        assert!(check(&["claude", "--settings", "escaped.json"], &none, &[]));
        assert!(check(&["claude"], &none, &[dir.join("sub/escaped.json")]));
        assert!(check(&["claude", "--settings", "{not json"], &none, &[]));
        assert!(check(&["claude"], &none, &[dir.join("sub/broken.json")]));
        assert!(!check(&["claude"], &none, &[dir.join("sub/empty.json")]));
        assert!(check(&["claude", "--settings", r#"{"x":["a",{"bypassPermissions":1}]}"#], &none, &[]));
        // 작업 폴더 위 폴더들의 .claude와 사용자 설정 폴더를 본다
        let files = settings_files(&dir.join("a/b"));
        assert!(files.contains(&dir.join("a/b/.claude/settings.local.json")) && files.contains(&dir.join(".claude/settings.json")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // 앞 프로세스의 인자는 빈칸으로 나누지 않고 그대로 (재리뷰 2회 R1): 이 테스트 프로세스의 인자와 같다
    #[cfg(unix)]
    #[test]
    fn reads_exact_process_args() {
        let me = process_args(std::process::id() as i32).unwrap();
        assert_eq!(me, std::env::args().collect::<Vec<_>>());
        // 빈칸이 든 인자도 하나로 (sh가 sleep으로 바뀌지 않게 명령 둘)
        let mut sh = std::process::Command::new("sh").args(["-c", "sleep 5; true", "name with space", r#"{"a": "b c"}"#]).spawn().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let got = process_args(sh.id() as i32);
        let _ = sh.kill();
        let _ = sh.wait();
        assert_eq!(got.unwrap(), vec!["sh", "-c", "sleep 5; true", "name with space", r#"{"a": "b c"}"#]);
        assert!(process_args(i32::MAX).is_none());
    }
}
