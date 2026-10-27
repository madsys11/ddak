// 작업그룹 준비 (docs/spec.md "작업그룹 준비"). worktree에는 커밋된 파일만 있어서 node_modules, 빌드 결과,
// .env 같은 것이 없다. 새 작업그룹을 만든 직후 그 폴더에서 고른 항목을 복제하고 준비 스크립트를 돌린다.
//
// 프로젝트마다 앱 데이터 폴더의 setup/<프로젝트 이름>-<경로 해시>.sh (스크립트)와 .json (복제할 항목) 하나씩
// (프로젝트 폴더에는 쓰지 않는다). 스크립트는 기본 텍스트 편집기로 연다 (작업그룹 설정과 같은 방식).
//
// 돌리기: 준비 창에서 이 앱 실행 파일을 도우미로 띄운다 (prepare.rs).

use crate::fs::{code_err, CodeError};
use crate::projects::data_dir;
use crate::prepare::HELPER;
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
    let root = crate::platform::canonical(project).map_err(|e| code_err("io", e))?;
    let dir = data_dir(app).map_err(|e| code_err("io", e))?;
    Ok(dir.join("setup").join(format!("{}.{ext}", project_slug(&root))))
}

pub fn script_path<R: Runtime>(app: &AppHandle<R>, project: &Path) -> Result<PathBuf, CodeError> {
    setup_file(app, project, "sh")
}

// 새 작업그룹에서 할 일 (설정 파일 내용이자 도우미에 넘기는 것).
// clone: 가져올 항목, 프로젝트 폴더 기준 상대 경로 (예: web/node_modules). 새 작업그룹 폴더는 프로젝트와 같은 모양이라
// 같은 상대 경로가 그 worktree 안의 자리다. install: 고른 설치 명령 (가져온 뒤 그 폴더에서 돈다).
#[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spec {
    #[serde(default)]
    pub clone: Vec<String>,
    #[serde(default)]
    pub install: Vec<Install>,
}

// 설치 명령 하나. dir: 프로젝트 폴더 기준 (프로젝트 자체가 저장소면 맨 위는 "")
#[derive(Clone, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Install {
    pub dir: String,
    pub command: String,
}

fn load_config(path: &Path) -> Result<Spec, CodeError> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| code_err("setupConfig", format!("{}: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Spec::default()),
        Err(e) => Err(code_err("setupConfig", format!("{}: {e}", path.display()))),
    }
}

// 프로젝트 안의 상대 경로만 (빈 경로, 절대 경로, ., .. 거부)
pub fn safe_rel(rel: &str) -> bool {
    let p = Path::new(rel);
    !rel.is_empty() && p.components().all(|c| matches!(c, Component::Normal(_)))
}

// 설치 명령의 폴더: 프로젝트 안의 상대 경로, 또는 맨 위("")
pub fn safe_dir(dir: &str) -> bool {
    dir.is_empty() || safe_rel(dir)
}

#[derive(serde::Serialize, PartialEq, Debug)]
pub struct Candidate {
    path: String,
    // "node": node_modules (manifest·lockfile이 같을 때만 복제), "cargo": cargo target (빌드 캐시),
    // "venv": 파이썬 가상 환경 (같은 Python으로 새로 만듦), "secret": .env 같은 파일 (그대로 복사, 기본은 고르지 않음)
    kind: &'static str,
}

// 비밀 값이 들어 있을 만한 무시된 파일. 예시 파일(.env.example 등)은 보통 커밋하므로 뺀다.
fn secret_file(name: &str) -> bool {
    let examples = [".env.example", ".env.sample", ".env.template"];
    (name == ".env" || name.starts_with(".env.")) && !examples.contains(&name)
        || [".npmrc", ".pypirc", "credentials.json", "secrets.json"].contains(&name)
        || name.ends_with(".pem")
        || name.ends_with(".key")
}

const CAN_CLONE: bool = cfg!(target_os = "macos");

// 원본에서 가져올 만한 무시된 항목. 저장소마다 git이 무시하는 항목(접힌 폴더 단위)에서 고른다.
// dist·알 수 없는 캐시·DB·로그는 후보로 내지 않는다 (사양).
fn candidates(repos: &[crate::worktrees::Repo]) -> Vec<Candidate> {
    let mut out = Vec::new();
    for repo in repos {
        let Ok(list) = git(&repo.path, &["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]) else {
            continue;
        };
        for entry in list.split('\0').filter(|e| !e.is_empty()) {
            let (rel, is_dir) = match entry.strip_suffix('/') {
                Some(dir) => (dir, true),
                None => (entry, false),
            };
            let path = repo.path.join(rel);
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            let kind = if is_dir {
                // 폴더 복제는 맥(APFS clonefile)에서만 한다. Windows는 설치 명령으로 (docs/windows-plan.md)
                match name {
                    "node_modules" if CAN_CLONE && path.with_file_name("package.json").is_file() => "node",
                    "target" if CAN_CLONE && path.join("CACHEDIR.TAG").is_file() => "cargo",
                    _ if path.join("pyvenv.cfg").is_file() => "venv",
                    _ => continue,
                }
            } else if secret_file(name) {
                "secret"
            } else {
                continue;
            };
            out.push(Candidate { path: project_path(repo, rel), kind });
        }
    }
    out
}

// 저장소 안의 상대 경로 → 프로젝트 폴더 기준
fn project_path(repo: &crate::worktrees::Repo, rel: &str) -> String {
    match (&repo.name, rel) {
        (Some(n), "") => n.clone(),
        (Some(n), r) => format!("{n}/{r}"),
        (None, r) => r.to_string(),
    }
}

// 셸 명령에 넣을 한 단어. 안전한 글자뿐이면 그대로, 아니면 작은따옴표로 감싼다 (리뷰 P2: 가상 환경 이름
// "env$(touch x)"가 명령 치환으로 실행됐다)
fn shell_word(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-/+@%".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

#[derive(serde::Serialize, PartialEq, Debug)]
pub struct Suggestion {
    dir: String,
    command: String,
}

// 설치 명령 제안: 저장소에 커밋된 lockfile에서 (새 worktree에는 커밋된 파일만 있다). venvs: 가상 환경 후보
// (requirements.txt는 같은 폴더에 가상 환경이 있을 때만 그 pip로 제안한다. 아니면 시스템 Python에 깔린다).
fn suggestions(repos: &[crate::worktrees::Repo], venvs: &[&str]) -> Vec<Suggestion> {
    const LOCKS: &[&str] = &[
        "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
        "uv.lock", "poetry.lock", "Pipfile.lock", "requirements.txt", "Gemfile.lock", "go.sum",
    ];
    let mut out: Vec<Suggestion> = Vec::new();
    for repo in repos {
        let mut args = vec!["ls-files", "-z", "--"];
        let patterns: Vec<String> = LOCKS.iter().flat_map(|f| [f.to_string(), format!("*/{f}")]).collect();
        args.extend(patterns.iter().map(String::as_str));
        let Ok(list) = git(&repo.path, &args) else { continue };
        let mut files: Vec<&str> = list.split('\0').filter(|e| !e.is_empty() && !e.split('/').any(|c| c == "node_modules")).collect();
        files.sort();
        for file in files {
            let (dir, name) = file.rsplit_once('/').unwrap_or(("", file));
            let dir_path = repo.path.join(dir);
            let command = match name {
                "package-lock.json" | "npm-shrinkwrap.json" => "npm ci".to_string(),
                // Yarn 2 이상(Berry)은 .yarnrc.yml을 두고 --immutable을 쓴다
                "yarn.lock" if dir_path.join(".yarnrc.yml").is_file() => "yarn install --immutable".into(),
                "yarn.lock" => "yarn install --frozen-lockfile".into(),
                "pnpm-lock.yaml" => "pnpm install --frozen-lockfile".into(),
                "bun.lock" | "bun.lockb" => "bun install --frozen-lockfile".into(),
                "uv.lock" => "uv sync --frozen".into(),
                "poetry.lock" => "poetry install".into(),
                "Pipfile.lock" => "pipenv sync".into(),
                "requirements.txt" => {
                    let here = project_path(repo, dir);
                    let venv = venvs.iter().find(|v| Path::new(v).parent().map(|p| p.to_string_lossy()) == Some(here.as_str().into()));
                    match venv.and_then(|v| Path::new(v).file_name()) {
                        Some(name) => {
                            let bin = if cfg!(windows) { "Scripts" } else { "bin" };
                            format!("{}/{bin}/pip install -r requirements.txt", shell_word(&name.to_string_lossy()))
                        }
                        None => continue,
                    }
                }
                "Gemfile.lock" => "bundle install".into(),
                "go.sum" => "go mod download".into(),
                _ => continue,
            };
            let suggestion = Suggestion { dir: project_path(repo, dir), command };
            if !out.contains(&suggestion) {
                out.push(suggestion);
            }
        }
    }
    out
}

#[derive(serde::Serialize)]
pub struct SetupInfo {
    candidates: Vec<Candidate>,
    suggestions: Vec<Suggestion>,
    clone: Vec<String>,
    install: Vec<Install>,
}

// "작업그룹 준비…" 창이 연다. git이 걸릴 수 있어 별도 스레드에서.
#[tauri::command]
pub async fn setup_load(app: AppHandle, project: String) -> Result<SetupInfo, CodeError> {
    let config = load_config(&setup_file(&app, Path::new(&project), "json")?)?;
    let root = crate::platform::canonical(&project).map_err(|e| code_err("io", e))?;
    let (candidates, suggestions) = tauri::async_runtime::spawn_blocking(move || {
        let (repos, _) = project_repos(&root)?;
        let candidates = candidates(&repos);
        let venvs: Vec<&str> = candidates.iter().filter(|c| c.kind == "venv").map(|c| c.path.as_str()).collect();
        let suggestions = suggestions(&repos, &venvs);
        Ok::<_, CodeError>((candidates, suggestions))
    })
    .await
    .map_err(|e| code_err("io", e))??;
    Ok(SetupInfo { candidates, suggestions, clone: config.clone, install: config.install })
}

#[tauri::command]
pub fn setup_save(app: AppHandle, project: String, clone: Vec<String>, install: Vec<Install>) -> Result<(), CodeError> {
    if let Some(bad) = clone.iter().find(|r| !safe_rel(r)) {
        return Err(code_err("io", format!("{bad}: not a path inside the project")));
    }
    if let Some(bad) = install.iter().find(|i| !safe_dir(&i.dir) || i.command.trim().is_empty()) {
        return Err(code_err("io", format!("{}: not a folder inside the project or an empty command", bad.dir)));
    }
    let path = setup_file(&app, Path::new(&project), "json")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| code_err("io", e))?;
    let json = serde_json::to_string_pretty(&Spec { clone, install }).map_err(|e| code_err("io", e))?;
    // 쓰다 끊겨도 반쯤 쓴 파일이 남지 않게 옆에 쓰고 옮긴다
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| code_err("io", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| code_err("io", e))
}

// 새 작업그룹에서 할 준비. 스크립트도 할 일도 없으면 None.
pub struct Plan {
    script: Option<String>,
    spec: Spec,
}

pub fn plan<R: Runtime>(app: &AppHandle<R>, project: &Path) -> Result<Option<Plan>, CodeError> {
    let script = script_to_run(app, project)?;
    let spec = load_config(&setup_file(app, project, "json")?)?;
    Ok((script.is_some() || !spec.clone.is_empty() || !spec.install.is_empty()).then_some(Plan { script, spec }))
}

// 준비 창에서 돌릴 명령: 이 실행 파일의 도우미 모드 (prepare.rs)
pub fn command(plan: &Plan, origin: &str, group: &str, name: &str) -> Result<Vec<String>, CodeError> {
    let exe = std::env::current_exe().map_err(|e| code_err("io", e))?;
    let spec = serde_json::to_string(&plan.spec).map_err(|e| code_err("io", e))?;
    let script = plan.script.clone().unwrap_or_default();
    Ok(vec![exe.to_string_lossy().into_owned(), HELPER.into(), origin.into(), group.into(), name.into(), script, spec])
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
        crate::platform::edit_text(&path).map_err(|e| code_err("io", e))?;
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

    // 제안한 명령에 넣은 이름은 셸이 한 단어로 읽고 아무것도 실행하지 않는다
    #[test]
    fn shell_words_are_inert() {
        assert_eq!(shell_word(".venv"), ".venv");
        let dir = std::env::temp_dir().join(format!("ddak-setup-word-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["my env", "env$(touch injected)", "it's", "a;touch injected", "`touch injected`"] {
            let out = std::process::Command::new(crate::platform::sh().unwrap())
                .arg("-c")
                .arg(format!("printf '%s' {}", shell_word(name)))
                .current_dir(&dir)
                .output()
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout), name);
        }
        assert!(!dir.join("injected").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn paths() {
        assert!(safe_rel("web/node_modules") && safe_rel("node_modules"));
        assert!(!safe_rel("") && !safe_rel("/abs") && !safe_rel("../x") && !safe_rel("a/../b") && !safe_rel("./a"));
        assert!(safe_dir("") && safe_dir("web") && !safe_dir("..") && !safe_dir("/x"));
    }

    // 무시된 항목 중: node_modules(옆에 package.json), cargo target(CACHEDIR.TAG), 가상 환경(pyvenv.cfg), 비밀 파일.
    // 설치 제안은 커밋된 lockfile에서 (requirements.txt는 같은 폴더에 가상 환경이 있을 때만).
    #[test]
    fn finds_candidates_and_suggestions() {
        let root = std::env::temp_dir().join(format!("ddak-setup-cand-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let web = root.join("web");
        for (f, body) in [
            ("package.json", "{}"),
            ("package-lock.json", "{}"),
            ("packages/a/package.json", "{}"),
            ("target/CACHEDIR.TAG", "Signature: 8a477f597d28d172789f06886806bc55"),
            ("target/debug/f", ""),
            ("dist/app.js", ""),
            ("orphan/node_modules/z/f", ""), // 옆에 package.json 없음
            ("node_modules/x/f", ""),
            ("packages/a/node_modules/y/f", ""),
            (".venv/pyvenv.cfg", "home = /usr/bin"),
            ("api/env/pyvenv.cfg", "home = /usr/bin"),
            (".env", "TOKEN=1"),
            (".env.local", "TOKEN=2"),
            (".env.example", "TOKEN="), // 무시돼도 예시 파일은 후보가 아님
            ("api/server.pem", ""),
            ("requirements.txt", "requests\n"),
            ("api/requirements.txt", "flask\n"),
            ("tool/uv.lock", ""),
            ("plain/requirements.txt", "x\n"), // 가상 환경이 없으면 제안하지 않음
            (".gitignore", "node_modules/\ntarget/\ndist/\n.venv/\nenv/\n.env*\n*.pem\n"),
        ] {
            std::fs::create_dir_all(web.join(f).parent().unwrap()).unwrap();
            std::fs::write(web.join(f), body).unwrap();
        }
        let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(&web).status().unwrap().success());
        git(&["init", "-q"]);
        git(&["add", "-A"]);
        git(&["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init"]);
        std::fs::write(root.join("notes.md"), "").unwrap();
        let root = std::fs::canonicalize(&root).unwrap();
        let (repos, _) = project_repos(&root).unwrap();
        let mut got = candidates(&repos);
        got.sort_by(|a, b| a.path.cmp(&b.path));
        let want = [
            ("web/.env", "secret"),
            ("web/.env.local", "secret"),
            ("web/.venv", "venv"),
            ("web/api/env", "venv"),
            ("web/api/server.pem", "secret"),
            ("web/node_modules", "node"),
            ("web/packages/a/node_modules", "node"),
            ("web/target", "cargo"),
        ];
        // node_modules·target 복제는 맥에서만 (CAN_CLONE)
        let want: Vec<Candidate> = want.into_iter().filter(|(_, kind)| CAN_CLONE || !["node", "cargo"].contains(kind)).map(|(path, kind)| Candidate { path: path.into(), kind }).collect();
        assert_eq!(got, want);
        let venvs: Vec<&str> = got.iter().filter(|c| c.kind == "venv").map(|c| c.path.as_str()).collect();
        let key = |s: &Suggestion| (s.dir.clone(), s.command.clone());
        let mut got = suggestions(&repos, &venvs);
        got.sort_by_key(key);
        let mut want: Vec<Suggestion> = [
            ("web", "npm ci"),
            ("web", if cfg!(windows) { ".venv/Scripts/pip install -r requirements.txt" } else { ".venv/bin/pip install -r requirements.txt" }),
            ("web/api", if cfg!(windows) { "env/Scripts/pip install -r requirements.txt" } else { "env/bin/pip install -r requirements.txt" }),
            ("web/tool", "uv sync --frozen"),
        ]
        .into_iter()
        .map(|(dir, command)| Suggestion { dir: dir.into(), command: command.into() })
        .collect();
        want.sort_by_key(key);
        assert_eq!(got, want);
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
