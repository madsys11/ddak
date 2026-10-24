// 작업그룹 준비 (docs/spec.md "작업그룹 준비"). worktree에는 커밋된 파일만 있어서 node_modules, 빌드 결과,
// .env 같은 것이 없다. 새 작업그룹을 만든 직후 그 폴더에서 고른 항목을 복제하고 준비 스크립트를 돌린다.
//
// 프로젝트마다 앱 데이터 폴더의 setup/<프로젝트 이름>-<경로 해시>.sh (스크립트)와 .json (복제할 항목) 하나씩
// (프로젝트 폴더에는 쓰지 않는다). 스크립트는 기본 텍스트 편집기로 연다 (작업그룹 설정과 같은 방식).
//
// 돌리기: 준비 창에서 이 앱 실행 파일을 도우미로 띄운다 (`ddak --ddak-setup …`, main.rs). 도우미가 복제하고
// 끝나면 스크립트로 exec한다. 진행·건너뛴 이유가 그 창에 보이고, 종료 코드·끝내기·다시 준비는 준비 창 그대로 쓴다.

use crate::clone::{clean_stale, clone_tree, Job, Outcome};
use crate::fs::{code_err, git_kind, CodeError};
use crate::projects::data_dir;
use crate::worktrees::{git, project_repos, project_slug};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Runtime};

// 처음 열 때 써 두는 내용. 주석뿐이면 명령이 없는 것으로 보고 돌리지 않는다.
const TEMPLATE: &str = r#"# Work group setup for this project.
# Runs with sh in the new work group folder after its worktrees are created and the
# folders chosen in Work Group Setup are copied, in a "setup" pane below the sessions.
# The sessions start when it succeeds. Worktrees only contain committed files.
#
#   DDAK_ORIGIN  the original project folder
#   DDAK_GROUP   the work group name (e.g. dev-review-1)
#
# Examples:
#   (cd app && npm install)
#   cp "$DDAK_ORIGIN/api/.env" api/.env
"#;

fn setup_file<R: Runtime>(app: &AppHandle<R>, project: &Path, ext: &str) -> Result<PathBuf, CodeError> {
    let root = std::fs::canonicalize(project).map_err(|e| code_err("io", e))?;
    let dir = data_dir(app).map_err(|e| code_err("io", e))?;
    Ok(dir.join("setup").join(format!("{}.{ext}", project_slug(&root))))
}

pub fn script_path<R: Runtime>(app: &AppHandle<R>, project: &Path) -> Result<PathBuf, CodeError> {
    setup_file(app, project, "sh")
}

// 복제할 항목: 프로젝트 폴더 기준 상대 경로 (예: web/node_modules). 새 작업그룹 폴더는 프로젝트와 같은 모양이라
// 같은 상대 경로가 그 worktree 안의 자리다.
#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub clone: Vec<String>,
}

fn load_config(path: &Path) -> Result<Config, CodeError> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| code_err("setupConfig", format!("{}: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(e) => Err(code_err("setupConfig", format!("{}: {e}", path.display()))),
    }
}

// 프로젝트 안의 상대 경로만 (빈 경로, 절대 경로, ., .. 거부)
fn safe_rel(rel: &str) -> bool {
    let p = Path::new(rel);
    !rel.is_empty() && p.components().all(|c| matches!(c, Component::Normal(_)))
}

#[derive(serde::Serialize, PartialEq, Debug)]
pub struct Candidate {
    path: String,
    // "node": node_modules (manifest·lockfile이 같을 때만 복제), "cargo": cargo target (빌드 캐시)
    kind: &'static str,
}

// 원본에서 복제할 만한 무시된 폴더. 저장소마다 git이 무시하는 항목(접힌 폴더 단위)에서 고른다.
// dist·알 수 없는 캐시·DB·로그는 후보로 내지 않는다 (사양).
fn candidates(root: &Path) -> Result<Vec<Candidate>, CodeError> {
    let (repos, _) = project_repos(root)?;
    let mut out = Vec::new();
    for repo in repos {
        let Ok(list) = git(&repo.path, &["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]) else {
            continue;
        };
        for entry in list.split('\0').filter_map(|e| e.strip_suffix('/')) {
            let dir = repo.path.join(entry);
            let kind = match dir.file_name().and_then(|n| n.to_str()) {
                Some("node_modules") if dir.with_file_name("package.json").is_file() => "node",
                Some("target") if dir.join("CACHEDIR.TAG").is_file() => "cargo",
                _ => continue,
            };
            let path = repo.name.as_ref().map_or(entry.to_string(), |n| format!("{n}/{entry}"));
            out.push(Candidate { path, kind });
        }
    }
    Ok(out)
}

#[derive(serde::Serialize)]
pub struct SetupInfo {
    candidates: Vec<Candidate>,
    clone: Vec<String>,
}

// "작업그룹 준비…" 창이 연다. git이 걸릴 수 있어 별도 스레드에서.
#[tauri::command]
pub async fn setup_load(app: AppHandle, project: String) -> Result<SetupInfo, CodeError> {
    let config = load_config(&setup_file(&app, Path::new(&project), "json")?)?;
    let root = std::fs::canonicalize(&project).map_err(|e| code_err("io", e))?;
    let candidates = tauri::async_runtime::spawn_blocking(move || candidates(&root)).await.map_err(|e| code_err("io", e))??;
    Ok(SetupInfo { candidates, clone: config.clone })
}

#[tauri::command]
pub fn setup_save(app: AppHandle, project: String, clone: Vec<String>) -> Result<(), CodeError> {
    if let Some(bad) = clone.iter().find(|r| !safe_rel(r)) {
        return Err(code_err("io", format!("{bad}: not a path inside the project")));
    }
    let path = setup_file(&app, Path::new(&project), "json")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| code_err("io", e))?;
    let json = serde_json::to_string_pretty(&Config { clone }).map_err(|e| code_err("io", e))?;
    // 쓰다 끊겨도 반쯤 쓴 파일이 남지 않게 옆에 쓰고 옮긴다
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| code_err("io", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| code_err("io", e))
}

// 새 작업그룹에서 할 준비. 스크립트도 복제할 항목도 없으면 None.
pub struct Plan {
    script: Option<String>,
    clone: Vec<String>,
}

pub fn plan<R: Runtime>(app: &AppHandle<R>, project: &Path) -> Result<Option<Plan>, CodeError> {
    let script = script_to_run(app, project)?;
    let clone = load_config(&setup_file(app, project, "json")?)?.clone;
    Ok((script.is_some() || !clone.is_empty()).then_some(Plan { script, clone }))
}

// 준비 창에서 돌릴 명령: 이 실행 파일의 도우미 모드 (setup_helper)
pub fn command(plan: &Plan, origin: &str, group: &str, name: &str) -> Result<Vec<String>, CodeError> {
    let exe = std::env::current_exe().map_err(|e| code_err("io", e))?;
    let mut argv = vec![exe.to_string_lossy().into_owned(), HELPER.into(), origin.into(), group.into(), name.into()];
    argv.push(plan.script.clone().unwrap_or_default());
    argv.extend(plan.clone.iter().cloned());
    Ok(argv)
}

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

// 도우미: args = [원본 폴더, 작업그룹 폴더, 작업그룹 이름, 스크립트 (없으면 ""), 복제할 항목…].
// 복제를 하나라도 못 하면 스크립트를 돌리지 않고 1로 끝난다 (준비 실패: 다시 준비 / 그래도 시작).
// 출력은 영어 (터미널에 찍는 진단 문구, 준비 스크립트 안내와 같음).
pub fn run_helper(args: &[String]) -> i32 {
    let [origin, group, name, script, clone @ ..] = args else {
        eprintln!("[ddak] usage: {HELPER} <origin> <group> <name> <script> [paths…]");
        return 2;
    };
    let (origin, group) = (Path::new(origin), Path::new(group));
    let origin_is_repo = git_kind(origin).is_some();
    // 임시 폴더는 작업그룹 폴더들이 든 ddak 폴더에 둔다 (worktrees.rs: ~/.ddak/worktrees/<프로젝트>/)
    let Some(temp_root) = group.parent() else {
        eprintln!("[ddak] {}: no parent folder", group.display());
        return 2;
    };
    clean_stale(temp_root);
    let mut failed = false;
    for rel in clone {
        let (src, dst) = (origin.join(rel), group.join(rel));
        if !safe_rel(rel) {
            eprintln!("[ddak] {rel}: not a path inside the project");
            failed = true;
            continue;
        }
        if !src.is_dir() {
            println!("[ddak] skipped {rel}: not in the original folder");
            continue;
        }
        if !dst.parent().is_some_and(|p| p.is_dir()) {
            eprintln!("[ddak] {rel}: its folder is not in the work group");
            failed = true;
            continue;
        }
        // 그 항목이 든 저장소: 원본과 새 작업그룹에서 (링크가 가리켜도 되는 범위, lockfile을 볼 범위)
        let mut parts = Path::new(rel).components();
        let repo_rel = if origin_is_repo { PathBuf::new() } else { parts.next().map(|c| PathBuf::from(c.as_os_str())).unwrap_or_default() };
        let (src_repo, dst_repo) = (origin.join(&repo_rel), group.join(&repo_rel));
        if dst.file_name().is_some_and(|n| n == "node_modules") {
            let inner = Path::new(rel).strip_prefix(&repo_rel).unwrap_or(Path::new(rel)).parent().unwrap_or(Path::new(""));
            if let Some(file) = manifest_differs(&src_repo, &dst_repo, inner) {
                let file = repo_rel.join(file);
                println!("[ddak] skipped {rel}: {} differs from the work group (install there instead)", file.display());
                continue;
            }
        }
        let started = std::time::Instant::now();
        match clone_tree(&Job { src: &src, dst: &dst, src_bound: &src_repo, dst_bound: &dst_repo, temp_root }) {
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
            }
            Err(e) => {
                eprintln!("[ddak] could not clone {rel}: {e}");
                failed = true;
            }
        }
    }
    if failed {
        eprintln!("[ddak] setup stopped");
        return 1;
    }
    if script.is_empty() {
        return 0;
    }
    use std::os::unix::process::CommandExt;
    let err = std::process::Command::new("/bin/sh").arg(script).env("DDAK_ORIGIN", origin).env("DDAK_GROUP", name).exec();
    eprintln!("[ddak] could not run {script}: {err}");
    127
}

// 주석과 빈 줄 말고 명령이 있는지
fn has_commands(script: &str) -> bool {
    script.lines().map(str::trim).any(|l| !l.is_empty() && !l.starts_with('#'))
}

// 돌릴 스크립트 경로. 파일이 없거나 명령이 없으면 None.
pub fn script_to_run<R: Runtime>(app: &AppHandle<R>, project: &Path) -> Result<Option<String>, CodeError> {
    Ok(script_at(&script_path(app, project)?))
}

// 없는 파일만 "준비 없음"으로 본다. 읽지 못하면 (디렉터리, 권한 등) 그대로 돌려서 sh가 준비 창에 오류를 보이고
// 실패하게 한다: 세션은 기다리고 다시 준비 / 그래도 시작을 고를 수 있다 (리뷰 P2: 읽기 오류를 "없음"으로 보고
// 준비 없이 CLI를 띄웠다). 내용은 바이트로 읽어 UTF-8이 아니어도 명령이 있는지 본다 (sh는 바이트로 읽는다).
fn script_at(path: &Path) -> Option<String> {
    let run = Some(path.to_string_lossy().into_owned());
    match std::fs::read(path) {
        Ok(bytes) => run.filter(|_| has_commands(&String::from_utf8_lossy(&bytes))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => run,
    }
}

// 없으면 안내를 써 두고 연다. 이미 있으면 그대로 둔다 (create_new: 확인 뒤 쓰면 그 사이 저장한 내용을 덮을 수 있다).
fn ensure(path: &Path) -> Result<(), CodeError> {
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| code_err("io", e))?;
    match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut f) => {
            use std::io::Write;
            f.write_all(TEMPLATE.as_bytes()).map_err(|e| code_err("io", e))
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(code_err("io", e)),
    }
}

// 경로를 돌려준다 (자체 테스트는 편집기를 띄우지 않고 이 경로에 직접 쓴다).
#[tauri::command]
pub fn setup_script_edit(app: AppHandle, project: String) -> Result<String, CodeError> {
    let path = script_path(&app, Path::new(&project))?;
    ensure(&path)?;
    if std::env::var_os("DDAK_SELFTEST").is_none() {
        std::process::Command::new("open").arg("-t").arg(&path).spawn().map_err(|e| code_err("io", e))?;
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_has_no_commands() {
        assert!(!has_commands(TEMPLATE));
        assert!(!has_commands("\n  # x\n\n"));
        assert!(has_commands(&format!("{TEMPLATE}npm install\n")));
        assert!(has_commands("  cp a b"));
    }

    #[test]
    fn unreadable_script_still_runs() {
        let dir = std::env::temp_dir().join(format!("ddak-setup-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(script_at(&dir.join("missing.sh")), None);
        std::fs::write(dir.join("comments.sh"), TEMPLATE).unwrap();
        assert_eq!(script_at(&dir.join("comments.sh")), None);
        // UTF-8이 아닌 내용, 파일 대신 디렉터리: 돌린다 (sh가 실행하거나 오류로 실패)
        std::fs::write(dir.join("latin1.sh"), b"echo caf\xe9\n").unwrap();
        std::fs::create_dir_all(dir.join("dir.sh")).unwrap();
        for name in ["latin1.sh", "dir.sh"] {
            let path = dir.join(name);
            assert_eq!(script_at(&path), Some(path.to_string_lossy().into_owned()), "{name}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn paths_and_manifests() {
        assert!(safe_rel("web/node_modules") && safe_rel("node_modules"));
        assert!(!safe_rel("") && !safe_rel("/abs") && !safe_rel("../x") && !safe_rel("a/../b") && !safe_rel("./a"));
        let dir = std::env::temp_dir().join(format!("ddak-setup-man-{}", std::process::id()));
        let (a, b) = (dir.join("a"), dir.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        for d in [&a, &b] {
            std::fs::write(d.join("package.json"), "{}").unwrap();
            std::fs::write(d.join("package-lock.json"), "1").unwrap();
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
        for d in [&a, &b] {
            std::fs::create_dir_all(d.join("packages/x")).unwrap();
            std::fs::write(d.join("packages/x/package.json"), "{}").unwrap();
        }
        let pkg = Path::new("packages/x");
        assert_eq!(manifest_differs(&a, &b, pkg), None);
        std::fs::write(a.join("package-lock.json"), "root changed").unwrap();
        assert_eq!(manifest_differs(&a, &b, pkg), Some(PathBuf::from("package-lock.json")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // 저장소마다 무시된 폴더 중 node_modules(옆에 package.json)와 cargo target(CACHEDIR.TAG)만 후보
    #[test]
    fn finds_candidates() {
        let root = std::env::temp_dir().join(format!("ddak-setup-cand-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let web = root.join("web");
        std::fs::create_dir_all(web.join("node_modules/x")).unwrap();
        std::fs::create_dir_all(web.join("packages/a/node_modules/y")).unwrap();
        std::fs::create_dir_all(web.join("target/debug")).unwrap();
        std::fs::create_dir_all(web.join("dist")).unwrap();
        std::fs::create_dir_all(web.join("orphan/node_modules/z")).unwrap(); // 옆에 package.json 없음
        std::fs::write(web.join("package.json"), "{}").unwrap();
        std::fs::write(web.join("packages/a/package.json"), "{}").unwrap();
        std::fs::write(web.join("target/CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55").unwrap();
        std::fs::write(web.join("dist/app.js"), "").unwrap();
        std::fs::write(web.join("orphan/node_modules/z/f"), "").unwrap();
        std::fs::write(web.join("node_modules/x/f"), "").unwrap();
        std::fs::write(web.join("packages/a/node_modules/y/f"), "").unwrap();
        std::fs::write(web.join("target/debug/f"), "").unwrap();
        std::fs::write(web.join(".gitignore"), "node_modules/\ntarget/\ndist/\n").unwrap();
        let ok = std::process::Command::new("git").args(["init", "-q"]).current_dir(&web).status().unwrap().success();
        assert!(ok);
        std::fs::write(root.join("notes.md"), "").unwrap();
        let root = std::fs::canonicalize(&root).unwrap();
        let mut got = candidates(&root).unwrap();
        got.sort_by(|a, b| a.path.cmp(&b.path));
        let want = [("web/node_modules", "node"), ("web/packages/a/node_modules", "node"), ("web/target", "cargo")];
        assert_eq!(got, want.map(|(path, kind)| Candidate { path: path.into(), kind }));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn ensure_keeps_existing() {
        let dir = std::env::temp_dir().join(format!("ddak-setup-{}", std::process::id()));
        let path = dir.join("setup/p.sh");
        ensure(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), TEMPLATE);
        std::fs::write(&path, "npm install\n").unwrap();
        ensure(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "npm install\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
