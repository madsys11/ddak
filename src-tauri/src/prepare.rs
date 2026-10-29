// 작업그룹 준비 도우미: 준비 창에서 이 앱 실행 파일을 `ddak --ddak-setup …`으로 띄우면 (main.rs) 창을 열지 않고
// 이것만 돌고 끝난다 (docs/spec.md "작업그룹 준비"). 고른 항목을 가져오고 → 설치 명령 → 준비 스크립트로 exec.
// 진행·건너뛴 이유가 준비 창에 보이고, 종료 코드·끝내기·다시 준비는 준비 창 그대로 쓴다.
// 하나라도 실패하면 그 뒤는 하지 않고 1로 끝난다 (준비 실패: 다시 준비 / 그래도 시작).
// 출력은 영어 (터미널에 찍는 진단 문구, 준비 스크립트 안내와 같음).

use crate::clone::{clean_stale, clone_tree, copy_file_into, remove_tree, Job, Outcome};
use crate::fs::git_kind;
use crate::setup::{safe_dir, safe_rel, Spec};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const HELPER: &str = "--ddak-setup";

// node_modules는 설치를 정한 파일이 원본과 새 작업그룹에서 같을 때만 복제한다 (원본에서 package.json을 고치고
// 설치했다면 새 작업그룹의 커밋된 package.json과 맞지 않는다). workspace의 하위 패키지는 위쪽(설치 루트)의
// lockfile을 쓰므로 node_modules가 든 폴더부터 저장소 맨 위까지 모든 폴더를 본다 (리뷰 P2). 다르면 그 파일 경로.
// inner: 저장소 기준 node_modules가 든 폴더.
const NODE_MANIFESTS: &[&str] =
    &["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "pnpm-workspace.yaml", "bun.lock", "bun.lockb"];
fn manifest_differs(origin_repo: &Path, group_repo: &Path, inner: &Path) -> Option<PathBuf> {
    inner.ancestors().find_map(|dir| {
        let differs = |f: &&&str| std::fs::read(origin_repo.join(dir).join(f)).ok() != std::fs::read(group_repo.join(dir).join(f)).ok();
        NODE_MANIFESTS.iter().find(differs).map(|f| dir.join(f))
    })
}

// Node 패키지 관리자의 설치 명령인지 (node_modules가 이미 있으면 건너뛴다: 복제한 것을 npm ci가 지우지 않게)
pub fn is_node_install(command: &str) -> bool {
    matches!(command.split_whitespace().next(), Some("npm" | "yarn" | "pnpm" | "bun"))
}

// 파이썬 가상 환경은 복제하지 않고 같은 Python으로 새로 만든다 (안의 경로가 원본 폴더를 가리킨다).
// pyvenv.cfg의 home이 그 Python이 든 폴더다.
fn recreate_venv(src: &Path, dst: &Path) -> Result<(), String> {
    let cfg = std::fs::read_to_string(src.join("pyvenv.cfg")).map_err(|e| format!("pyvenv.cfg: {e}"))?;
    let value = |key: &str| {
        cfg.lines().find_map(|l| l.split_once('=').filter(|(k, _)| k.trim() == key).map(|(_, v)| v.trim().to_string()))
    };
    let home = value("home").ok_or("pyvenv.cfg has no home")?;
    let names: &[&str] = if cfg!(windows) { &["python.exe", "python3.exe"] } else { &["python3", "python"] };
    let python = names.iter().map(|p| Path::new(&home).join(p)).find(|p| p.is_file()).ok_or(format!("no python in {home}"))?;
    let mut cmd = Command::new(&python);
    cmd.args(["-m", "venv"]);
    if value("include-system-site-packages").as_deref() == Some("true") {
        cmd.arg("--system-site-packages");
    }
    let status = cmd.arg(dst).status().map_err(|e| format!("{}: {e}", python.display()))?;
    if status.success() { Ok(()) } else { Err(format!("{} -m venv failed ({status})", python.display())) }
}

// 작업그룹별 진행 기록: 무엇을 시작했고 무엇을 마쳤는지 (ddak 폴더의 .ddak-state-<작업그룹>.json).
// 폴더가 있다는 것만으로는 성공한 것인지 실패하고 남은 것인지 알 수 없어서 (리뷰 P2: 실패한 npm ci·venv가 남긴 폴더를
// 다시 하기에서 성공으로 넘겼다) 이것으로 구분한다. 작업그룹을 끝낼 때 같이 지운다.
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct State {
    #[serde(default)]
    started: Vec<String>,
    #[serde(default)]
    done: Vec<String>,
    // 우리가 직접 만든 폴더의 식별자 [dev, inode, 만든 시각 초, 나노초]. 시작 기록만으로는 그 자리의 폴더가 우리 것인지
    // 알 수 없어서 (리뷰 P1: 만들지 못하고 기록만 남은 자리에 사용자가 만든 폴더를 지웠다) 이것이 맞을 때만 지운다.
    #[serde(default)]
    made: std::collections::BTreeMap<String, [u64; 4]>,
}

// 폴더 식별자: 같은 볼륨의 같은 inode이고 만든 시각까지 같아야 같은 폴더다 (링크는 따라가지 않는다)
fn folder_id(path: &Path) -> Option<[u64; 4]> {
    let meta = path.symlink_metadata().ok().filter(|m| m.is_dir())?;
    let born = meta.created().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    let (dev, ino) = crate::platform::file_id(path)?;
    Some([dev, ino, born.as_secs(), born.subsec_nanos() as u64])
}

struct Progress {
    path: PathBuf,
    state: State,
}

// 다시 쓰는 작업그룹 (worktrees.rs reuse): 설치·복제의 시작·성공 기록을 지운다. 코드를 앞으로 감아 lockfile 등이 바뀌었을 수
// 있어, 예전 성공 기록을 보고 설치를 건너뛰지 않게 다시 설치한다 (리뷰 R3). 가상 환경과 만든 폴더 기록은 둔다 (그 폴더가 우리
// 것인지 알아야 다시 만들 때 지울 수 있다). 기록 파일이 없으면 할 것 없음
pub fn forget_installs(temp_root: &Path, group: &Path) -> Result<(), String> {
    let mut progress = Progress::open(temp_root, group);
    if !progress.path.exists() {
        return Ok(());
    }
    let keys: Vec<String> = progress.state.done.iter().chain(&progress.state.started).filter(|k| k.starts_with("install:") || k.starts_with("clone:")).cloned().collect();
    progress.forget(&keys.iter().map(String::as_str).collect::<Vec<_>>())
}

impl Progress {
    // 기록을 못 읽으면 빈 기록으로 시작한다 (우리가 남긴 것을 모르면 지우지 않고, 설치는 다시 한다)
    fn open(temp_root: &Path, group: &Path) -> Progress {
        let name = group.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let path = temp_root.join(format!(".ddak-state-{name}.json"));
        let state = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Progress { path, state }
    }
    fn done(&self, key: &str) -> bool {
        self.state.done.iter().any(|k| k == key)
    }
    fn made(&self, key: &str) -> Option<[u64; 4]> {
        self.state.made.get(key).copied()
    }
    // 시작했거나(done=false) 마쳤다고 적는다. 쓰다 끊겨도 반쯤 쓴 기록이 남지 않게 옆에 쓰고 옮긴다.
    fn mark(&mut self, key: &str, done: bool) -> Result<(), String> {
        self.state.started.retain(|k| k != key);
        self.state.done.retain(|k| k != key);
        if done { &mut self.state.done } else { &mut self.state.started }.push(key.to_string());
        self.save()
    }
    // 시작·마침·만든 폴더 기록을 지운다
    fn forget(&mut self, keys: &[&str]) -> Result<(), String> {
        self.state.started.retain(|k| !keys.contains(&k.as_str()));
        self.state.done.retain(|k| !keys.contains(&k.as_str()));
        self.state.made.retain(|k, _| !keys.contains(&k.as_str()));
        self.save()
    }
    fn remember_made(&mut self, key: &str, id: [u64; 4]) -> Result<(), String> {
        self.state.made.insert(key.to_string(), id);
        self.save()
    }
    fn save(&self) -> Result<(), String> {
        let tmp = self.path.with_extension(format!("json.{}", std::process::id()));
        let json = serde_json::to_vec_pretty(&self.state).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, json).and_then(|()| std::fs::rename(&tmp, &self.path)).map_err(|e| format!("{}: {e}", self.path.display()))
    }
}

// 프로젝트 기준 경로 rel이 든 저장소 (프로젝트 자체가 저장소면 맨 위)
fn repo_of(rel: &str, origin_is_repo: bool) -> PathBuf {
    if origin_is_repo {
        return PathBuf::new();
    }
    Path::new(rel).components().next().map(|c| PathBuf::from(c.as_os_str())).unwrap_or_default()
}

// 새 작업그룹에 쓸 자리가 그 worktree 안인지: 부모 폴더를 실제로 따라간 곳이 worktree의 실제 경로 안이고, 그 자리가
// 링크가 아니어야 한다. 원본에서는 일반 폴더라도 새 worktree에서는 밖을 가리키는 링크일 수 있다 (리뷰 P1: config가
// 밖을 가리키는 링크라 config/.env를 밖에 썼다).
fn place_inside(place: &Path, bound: &Path) -> Result<(), String> {
    let parent = place.parent().ok_or("no parent folder")?;
    let real = crate::platform::canonical(parent).map_err(|_| "its folder is not in the work group".to_string())?;
    let bound = crate::platform::canonical(bound).map_err(|e| format!("{}: {e}", bound.display()))?;
    if !real.starts_with(&bound) {
        return Err("its folder leads outside the work group".into());
    }
    if place.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("it is a link in the work group".into());
    }
    Ok(())
}

// args = [원본 폴더, 작업그룹 폴더, 작업그룹 이름, 스크립트 (없으면 ""), 할 일 (setup::Spec JSON)]
pub fn run_helper(args: &[String]) -> i32 {
    let [origin, group, name, script, spec] = args else {
        eprintln!("[ddak] usage: {HELPER} <origin> <group> <name> <script> <spec>");
        return 2;
    };
    let spec: Spec = match serde_json::from_str(spec) {
        Ok(spec) => spec,
        Err(e) => {
            eprintln!("[ddak] bad setup spec: {e}");
            return 2;
        }
    };
    let (origin, group) = (Path::new(origin), Path::new(group));
    // 임시 폴더는 작업그룹 폴더들이 든 ddak 폴더에 둔다 (worktrees.rs: ~/.ddak/worktrees/<프로젝트>/)
    let Some(temp_root) = group.parent() else {
        eprintln!("[ddak] {}: no parent folder", group.display());
        return 2;
    };
    clean_stale(temp_root);
    let origin_is_repo = git_kind(origin).is_some();
    let mut progress = Progress::open(temp_root, group);
    let ok = spec.clone.iter().all(|rel| bring(origin, group, temp_root, origin_is_repo, rel, &mut progress))
        && spec.install.iter().all(|i| install(group, origin_is_repo, &i.dir, &i.command, &mut progress));
    if !ok {
        eprintln!("[ddak] setup stopped");
        return 1;
    }
    if script.is_empty() {
        return 0;
    }
    run_script(script, origin, name)
}

#[cfg(unix)]
fn run_script(script: &str, origin: &Path, name: &str) -> i32 {
    use std::os::unix::process::CommandExt;
    let err = Command::new("/bin/sh").arg(script).env("DDAK_ORIGIN", origin).env("DDAK_GROUP", name).exec();
    eprintln!("[ddak] could not run {script}: {err}");
    127
}

// Windows에는 exec가 없어 Git Bash로 돌리고 그 종료 코드로 끝난다
#[cfg(windows)]
fn run_script(script: &str, origin: &Path, name: &str) -> i32 {
    let sh = match crate::platform::sh() {
        Ok(sh) => sh,
        Err(e) => {
            eprintln!("[ddak] could not run {script}: {e}");
            return 127;
        }
    };
    match Command::new(sh).arg(script).env("DDAK_ORIGIN", origin).env("DDAK_GROUP", name).status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            eprintln!("[ddak] could not run {script}: {e}");
            127
        }
    }
}

// 고른 항목 하나를 새 작업그룹으로: 파일은 복사, 파이썬 가상 환경은 새로 만들기, 그 밖의 폴더는 복제.
// 계속해도 되면 true (건너뛰기는 실패가 아니다).
fn bring(origin: &Path, group: &Path, temp_root: &Path, origin_is_repo: bool, rel: &str, progress: &mut Progress) -> bool {
    let fail = |e: String| {
        eprintln!("[ddak] {rel}: {e}");
        false
    };
    if !safe_rel(rel) {
        return fail("not a path inside the project".into());
    }
    let (src, dst) = (origin.join(rel), group.join(rel));
    if src.symlink_metadata().is_err() {
        println!("[ddak] skipped {rel}: not in the original folder");
        return true;
    }
    // 그 항목이 든 저장소: 원본과 새 작업그룹에서 (쓸 자리·링크가 가리켜도 되는 범위, lockfile을 볼 범위)
    let repo_rel = repo_of(rel, origin_is_repo);
    let (src_repo, dst_repo) = (origin.join(&repo_rel), group.join(&repo_rel));
    if let Err(e) = place_inside(&dst, &dst_repo) {
        return fail(e);
    }
    if !src.is_dir() || src.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
        return match copy_file_into(&src, &dst, temp_root) {
            Ok(true) => {
                println!("[ddak] copied {rel}");
                true
            }
            Ok(false) => {
                println!("[ddak] kept {rel}: already exists");
                true
            }
            Err(e) => fail(format!("could not copy: {e}")),
        };
    }
    if src.join("pyvenv.cfg").is_file() {
        return venv(&src, &dst, rel, progress);
    }
    if dst.file_name().is_some_and(|n| n == "node_modules") {
        let inner = Path::new(rel).strip_prefix(&repo_rel).unwrap_or(Path::new(rel)).parent().unwrap_or(Path::new(""));
        if let Some(file) = manifest_differs(&src_repo, &dst_repo, inner) {
            let file = repo_rel.join(file);
            println!("[ddak] skipped {rel}: {} differs from the work group (install there instead)", file.display());
            return true;
        }
    }
    let started = std::time::Instant::now();
    match clone_tree(&Job { src: &src, dst: &dst, src_bound: &src_repo, dst_bound: &dst_repo, temp_root }) {
        // 이미 있는 것은 우리가 복제했는지 모른다 (실패한 설치가 남긴 node_modules일 수 있다). 기록하지 않는다.
        Ok(Outcome::Exists) => println!("[ddak] kept {rel}: already exists"),
        Ok(Outcome::Cloned(report)) => {
            let files = if report.files == 1 { "1 file".to_string() } else { format!("{} files", report.files) };
            println!("[ddak] cloned {rel}: {files} ({:.1}s)", started.elapsed().as_secs_f32());
            for (path, why) in report.skipped.iter().take(10) {
                let why = if *why == "link" { "link pointing outside the repository" } else { "socket, FIFO or device" };
                println!("[ddak]   left out {}: {why}", path.display());
            }
            if report.skipped.len() > 10 {
                println!("[ddak]   left out {} more", report.skipped.len() - 10);
            }
            if let Err(e) = progress.mark(&format!("clone:{rel}"), true) {
                return fail(e);
            }
        }
        Err(e) => return fail(format!("could not clone: {e}")),
    }
    true
}

// 완성된 가상 환경처럼 보이는지 (pyvenv.cfg와 bin/python, Windows는 Scripts\python.exe)
fn complete_venv(dir: &Path) -> bool {
    let python = if cfg!(windows) { dir.join("Scripts").join("python.exe") } else { dir.join("bin/python") };
    dir.join("pyvenv.cfg").is_file() && python.exists()
}

// 가상 환경 새로 만들기. 만드는 곳 안에 경로가 박혀서 다른 곳에 만들어 옮길 수 없다. 그래서 폴더를 직접 만들어 그
// 식별자를 적어 두고 그 안에 만든다 (python -m venv는 비어 있는 폴더에 만든다. 2026-10-24 실험: inode 그대로).
// - 실패하면 바로 지운다. 끊겨서 남은 폴더는 다시 할 때 식별자가 맞을 때만 지우고 다시 만든다.
// - 우리가 만들지 않은 폴더는 지우지 않는다: 완성된 가상 환경이면 그대로 쓰고, 아니면 지우라고 알리고 멈춘다
//   (폴더를 만든 직후 기록하기 전에 끊긴 경우도 여기로 온다).
fn venv(src: &Path, dst: &Path, rel: &str, progress: &mut Progress) -> bool {
    let key = format!("venv:{rel}");
    let fail = |e: String| {
        eprintln!("[ddak] could not create {rel}: {e}");
        false
    };
    if dst.symlink_metadata().is_ok() {
        if progress.done(&key) {
            println!("[ddak] kept {rel}: already exists");
            return true;
        }
        if progress.made(&key).is_some_and(|id| folder_id(dst) == Some(id)) {
            println!("[ddak] removing {rel} left by an earlier attempt");
            remove_tree(dst);
        } else if complete_venv(dst) {
            println!("[ddak] kept {rel}: already exists");
            return true;
        } else {
            return fail("a folder that ddak did not make is in the way; remove it and run the setup again".into());
        }
    }
    println!("[ddak] creating {rel} with the same Python");
    if let Err(e) = std::fs::create_dir(dst) {
        return fail(e.to_string());
    }
    let Some(id) = folder_id(dst) else {
        return fail("could not read the new folder".into());
    };
    let result = progress
        .remember_made(&key, id)
        .and_then(|()| progress.mark(&key, false))
        .and_then(|()| recreate_venv(src, dst))
        .and_then(|()| progress.mark(&key, true));
    if let Err(e) = result {
        // 실패: 만든 폴더를 바로 지운다 (식별자가 맞을 때만)
        if folder_id(dst) == Some(id) {
            remove_tree(dst);
        }
        let _ = progress.forget(&[&key]);
        return fail(e);
    }
    true
}

// 고른 설치 명령 하나를 새 작업그룹의 그 폴더에서 돌린다 (출력은 준비 창으로). Node 설치는 그 폴더의 node_modules가
// 우리가 복제했거나 이 설치가 성공해서 생긴 것이면 건너뛴다: npm ci처럼 지우고 다시 받는 명령이 복제를 버리지 않게
// (사양). 실패한 설치가 남긴 node_modules면 다시 한다 (리뷰 P2).
fn install(group: &Path, origin_is_repo: bool, dir: &str, command: &str, progress: &mut Progress) -> bool {
    let label = if dir.is_empty() { command.to_string() } else { format!("{dir}: {command}") };
    let fail = |e: String| {
        eprintln!("[ddak] {label}: {e}");
        false
    };
    if !safe_dir(dir) {
        return fail("not a folder inside the project".into());
    }
    let at = group.join(dir);
    if !at.is_dir() {
        return fail("the folder is not in the work group".into());
    }
    // 그 폴더를 실제로 따라간 곳도 그 worktree 안이어야 한다 (밖을 가리키는 링크 폴더에서 돌리지 않게)
    let bound = group.join(repo_of(dir, origin_is_repo));
    let inside = crate::platform::canonical(&at).ok().zip(crate::platform::canonical(&bound).ok()).is_some_and(|(real, b)| real.starts_with(b));
    if !inside {
        return fail("the folder leads outside the work group".into());
    }
    let key = format!("install:{dir}\n{command}");
    let modules = Path::new(dir).join("node_modules").to_string_lossy().into_owned();
    let ours = progress.done(&format!("clone:{modules}")) || progress.done(&key);
    if is_node_install(command) && at.join("node_modules").exists() && ours {
        println!("[ddak] skipped {label}: node_modules is already there");
        return true;
    }
    // 돌리기 전에 이전 성공·복제 기록을 지운다: 이 설치가 node_modules를 바꾸므로, 실패하면 그 기록은 더 이상 맞지 않다
    // (리뷰 P2: 다시 설치하다 실패해도 예전 성공 기록을 보고 다음에 건너뛰었다). 성공한 뒤에만 다시 적는다.
    let clone_key = format!("clone:{modules}");
    if let Err(e) = progress.forget(&[&key, &clone_key]) {
        return fail(e);
    }
    println!("[ddak] running {label}");
    let sh = match crate::platform::sh() {
        Ok(sh) => sh,
        Err(e) => return fail(e),
    };
    match Command::new(sh).arg("-c").arg(command).current_dir(&at).status() {
        Ok(status) if status.success() => match progress.mark(&key, true) {
            Ok(()) => true,
            Err(e) => fail(e),
        },
        Ok(status) => fail(format!("failed ({status})")),
        Err(e) => fail(e.to_string()),
    }
}

// 유닉스 권한·링크·sh를 쓰는 시험 (Windows 시험은 platform.rs·conpty.rs·fs.rs)
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ddak-prepare-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn manifests_up_to_the_repo_root() {
        let dir = temp("man");
        let (a, b) = (dir.join("a"), dir.join("b"));
        for d in [&a, &b] {
            std::fs::create_dir_all(d.join("packages/x")).unwrap();
            std::fs::write(d.join("package.json"), "{}").unwrap();
            std::fs::write(d.join("package-lock.json"), "1").unwrap();
            std::fs::write(d.join("packages/x/package.json"), "{}").unwrap();
        }
        let here = Path::new("");
        assert_eq!(manifest_differs(&a, &b, here), None);
        std::fs::write(a.join("package-lock.json"), "2").unwrap();
        assert_eq!(manifest_differs(&a, &b, here), Some(PathBuf::from("package-lock.json")));
        std::fs::write(a.join("package-lock.json"), "1").unwrap();
        std::fs::write(b.join("yarn.lock"), "y").unwrap(); // 한쪽에만 있는 lockfile도 다름
        assert_eq!(manifest_differs(&a, &b, here), Some(PathBuf::from("yarn.lock")));
        std::fs::remove_file(b.join("yarn.lock")).unwrap();
        // workspace 하위 패키지: 자기 package.json은 같아도 저장소 맨 위 lockfile이 다르면 다름 (리뷰 P2)
        let pkg = Path::new("packages/x");
        assert_eq!(manifest_differs(&a, &b, pkg), None);
        std::fs::write(a.join("package-lock.json"), "root changed").unwrap();
        assert_eq!(manifest_differs(&a, &b, pkg), Some(PathBuf::from("package-lock.json")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // 원본 가상 환경의 Python으로 새로 만든다 (안의 python이 새 폴더 것이어야 한다)
    #[test]
    fn recreates_venv_with_the_same_python() {
        let dir = temp("venv");
        let ok = Command::new("python3").args(["-m", "venv", "--without-pip"]).arg(dir.join("src")).status().is_ok_and(|s| s.success());
        if !ok {
            eprintln!("python3 없음: 건너뜀");
            return;
        }
        recreate_venv(&dir.join("src"), &dir.join("dst")).unwrap();
        let cfg = |d: &str| std::fs::read_to_string(dir.join(d).join("pyvenv.cfg")).unwrap();
        let home = |c: String| c.lines().find(|l| l.starts_with("home")).map(String::from);
        assert_eq!(home(cfg("src")), home(cfg("dst")));
        assert!(dir.join("dst/bin/python").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // 원본·새 작업그룹·ddak 폴더 (프로젝트 폴더 안에 저장소 web)
    struct Dirs {
        base: PathBuf,
        origin: PathBuf,
        group: PathBuf,
        ddak: PathBuf,
    }
    impl Dirs {
        fn new(name: &str) -> Dirs {
            let base = std::fs::canonicalize(temp(name)).unwrap();
            let (origin, ddak) = (base.join("origin"), base.join("ddak"));
            let group = ddak.join("g-1");
            for d in [origin.join("web"), group.join("web"), base.join("outside")] {
                std::fs::create_dir_all(d).unwrap();
            }
            Dirs { base, origin, group, ddak }
        }
        fn progress(&self) -> Progress {
            Progress::open(&self.ddak, &self.group)
        }
        fn bring(&self, rel: &str) -> bool {
            bring(&self.origin, &self.group, &self.ddak, false, rel, &mut self.progress())
        }
        fn install(&self, dir: &str, command: &str) -> bool {
            install(&self.group, false, dir, command, &mut self.progress())
        }
    }
    impl Drop for Dirs {
        fn drop(&mut self) {
            remove_tree(&self.base);
        }
    }

    // 새 worktree의 부모 폴더가 밖을 가리키는 링크면 그 밖에 쓰지 않는다 (리뷰 P1). 파일 복사·폴더 복제·설치 모두.
    #[test]
    fn never_writes_through_a_linked_parent() {
        let d = Dirs::new("parent");
        std::fs::create_dir_all(d.origin.join("web/config")).unwrap();
        std::fs::write(d.origin.join("web/config/.env"), "TOKEN=1").unwrap();
        std::fs::create_dir_all(d.origin.join("web/cache/target/x")).unwrap();
        std::os::unix::fs::symlink(d.base.join("outside"), d.group.join("web/config")).unwrap();
        std::os::unix::fs::symlink(d.base.join("outside"), d.group.join("web/cache")).unwrap();
        assert!(!d.bring("web/config/.env"));
        assert!(!d.bring("web/cache/target"));
        assert!(!d.install("web/config", "touch ran"));
        assert_eq!(std::fs::read_dir(d.base.join("outside")).unwrap().count(), 0, "밖에 썼음");
    }

    // 실패한 Node 설치가 남긴 node_modules는 우리 것이 아니라 다시 설치한다 (리뷰 P2). 복제했거나 설치가 성공해서 생긴
    // node_modules면 건너뛴다 (npm ci가 지우지 않게). 그 밖의 설치는 그대로 돌리고 실패를 알린다.
    #[test]
    fn node_install_reruns_unless_node_modules_is_ours() {
        let d = Dirs::new("install");
        std::fs::create_dir_all(d.group.join("web/node_modules")).unwrap();
        // 남은 node_modules (기록 없음) → 돌린다
        assert!(!d.install("web", "npm ci; touch ran; exit 7"));
        assert!(d.group.join("web/ran").exists(), "실패하고 남은 node_modules인데 건너뜀");
        std::fs::remove_file(d.group.join("web/ran")).unwrap();
        assert!(!d.install("web", "npm ci; touch ran; exit 7"), "실패를 성공으로 넘김");
        assert!(d.group.join("web/ran").exists());
        // 성공하면 기록되고 다음에는 건너뛴다
        std::fs::remove_file(d.group.join("web/ran")).unwrap();
        assert!(d.install("web", "npm ci; touch ran"));
        std::fs::remove_file(d.group.join("web/ran")).unwrap();
        assert!(d.install("web", "npm ci; touch ran"));
        assert!(!d.group.join("web/ran").exists(), "성공한 설치를 다시 함");
        // 복제한 node_modules도 건너뛴다
        std::fs::create_dir_all(d.origin.join("api/node_modules/x")).unwrap();
        std::fs::create_dir_all(d.group.join("api")).unwrap();
        assert!(d.bring("api/node_modules"));
        assert!(d.install("api", "npm ci; touch ran"));
        assert!(!d.group.join("api/ran").exists(), "복제한 node_modules인데 설치함");
        // 그 밖의 설치·잘못된 폴더
        assert!(!d.install("api", "exit 3"));
        assert!(!d.install("missing", "true"));
        assert!(!d.install("../x", "true"));
    }

    // 가상 환경: 만들다 실패하면 바로 지운다. 끊겨서 남은 폴더는 우리가 만든 그 폴더(식별자 일치)일 때만 지우고 다시
    // 만든다 (리뷰 P2). 우리가 만들지 않은 폴더는 지우지 않는다 (리뷰 후속 P1): 완성된 환경이면 그대로, 아니면 멈추고 알림.
    #[test]
    fn venv_only_removes_the_folder_it_made() {
        let d = Dirs::new("venvretry");
        let home = d.base.join("python-home");
        std::fs::create_dir_all(&home).unwrap();
        let python = home.join("python3");
        let set_python = |script: &str| {
            std::fs::write(&python, format!("#!/bin/sh\n{script}\n")).unwrap();
            std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let src = d.origin.join("web/.venv");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("pyvenv.cfg"), format!("home = {}\n", home.display())).unwrap();
        let dst = d.group.join("web/.venv");
        // 인자: -m venv <폴더>. 안에 쓰다가 실패한다 → 우리가 만든 폴더를 바로 지운다
        set_python(r#"touch "$3/leftover"; exit 9"#);
        assert!(!d.bring("web/.venv"));
        assert!(dst.symlink_metadata().is_err(), "실패한 폴더가 남음");
        // Python이 없음 → 실패. 그 자리에 사용자가 폴더를 만들면 다시 해도 지우지 않는다 (리뷰 후속 P1)
        std::fs::write(src.join("pyvenv.cfg"), "home = /no/such/python-home\n").unwrap();
        assert!(!d.bring("web/.venv"));
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(dst.join("mine"), "user").unwrap();
        std::fs::write(src.join("pyvenv.cfg"), format!("home = {}\n", home.display())).unwrap();
        assert!(!d.bring("web/.venv"), "우리 것이 아닌 덜 된 폴더를 성공으로 넘김");
        assert_eq!(std::fs::read_to_string(dst.join("mine")).unwrap(), "user", "사용자 파일을 지움");
        // 사용자가 만든 완성된 환경은 그대로 쓴다
        std::fs::create_dir_all(dst.join("bin")).unwrap();
        std::fs::write(dst.join("pyvenv.cfg"), "").unwrap();
        std::fs::write(dst.join("bin/python"), "").unwrap();
        assert!(d.bring("web/.venv"));
        assert!(dst.join("mine").exists());
        remove_tree(&dst);
        // 끊긴 경우: 우리가 만든 폴더(식별자를 적은 것)가 남아 있으면 지우고 다시 만든다
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(dst.join("partial"), "").unwrap();
        let mut progress = d.progress();
        progress.remember_made("venv:web/.venv", folder_id(&dst).unwrap()).unwrap();
        progress.mark("venv:web/.venv", false).unwrap();
        set_python(r#"mkdir -p "$3/bin" && touch "$3/bin/python" "$3/pyvenv.cfg""#);
        assert!(d.bring("web/.venv"));
        assert!(dst.join("bin/python").exists() && !dst.join("partial").exists());
        // 마친 것은 그대로
        assert!(d.bring("web/.venv"));
    }

    // 다시 설치하다 실패하면 예전 성공 기록이 남지 않는다 (리뷰 후속 P2): 성공 → node_modules 지움 → 다시 설치 실패 →
    // 다음에는 다시 설치한다
    #[test]
    fn failed_reinstall_clears_the_old_success() {
        let d = Dirs::new("reinstall");
        let flag = d.base.join("fail");
        let cmd = format!("npm ci; mkdir -p node_modules; touch ran; test ! -f '{}'", flag.display());
        assert!(d.install("web", &cmd));
        std::fs::remove_dir_all(d.group.join("web/node_modules")).unwrap();
        std::fs::write(&flag, "").unwrap();
        assert!(!d.install("web", &cmd));
        std::fs::remove_file(d.group.join("web/ran")).unwrap();
        assert!(!d.install("web", &cmd), "실패한 다시 설치를 예전 성공 기록으로 건너뜀");
        assert!(d.group.join("web/ran").exists());
    }

    #[test]
    fn node_installs() {
        assert!(is_node_install("npm ci") && is_node_install("pnpm install --frozen-lockfile"));
        assert!(!is_node_install("uv sync --frozen") && !is_node_install("npmx"));
    }
}
