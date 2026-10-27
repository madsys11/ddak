// 작업그룹 추가: 프로젝트의 저장소마다 git worktree를 만들어 한 폴더로 묶는다 (docs/spec.md "작업그룹 · worktree 설계").
//
//   ~/.ddak/worktrees/<프로젝트 이름>-<경로 해시>/<그룹>-<번호>/
//      ├─ server/  ← server 저장소의 worktree (브랜치 ddak/<그룹>-<번호>, 원본의 현재 HEAD에서)
//      └─ notes.md ← 저장소가 아닌 항목은 원본으로 가는 심볼릭 링크 (그룹끼리 공유)
//
// 프로젝트 폴더 자체가 저장소면 그 폴더 전체를 worktree 하나로 만든다.
// 중간에 실패하면 이미 만든 worktree·브랜치·폴더를 지우고 실패를 돌려준다.

use crate::fs::{code_err, git_kind, CodeError};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use crate::pty::Ptys;
use tauri::{AppHandle, Manager};

// ~/.ddak. DDAK_HOME이 있으면 그 폴더 (자체 테스트가 사용자 폴더를 건드리지 않게).
fn ddak_home() -> Result<PathBuf, CodeError> {
    if let Some(dir) = std::env::var_os("DDAK_HOME") {
        return Ok(PathBuf::from(dir));
    }
    if std::env::var_os("DDAK_SELFTEST").is_some() {
        return Err(code_err("io", "자체 테스트에는 DDAK_HOME이 필요하다"));
    }
    let home = crate::platform::home().ok_or_else(|| code_err("io", "HOME 없음"))?;
    Ok(home.join(".ddak"))
}

// 이름이 같은 프로젝트가 둘 있어도 섞이지 않게 경로 해시를 붙인다 (FNV-1a, 실행마다 같은 값).
pub fn project_slug(root: &Path) -> String {
    let mut h: u32 = 0x811c9dc5;
    for b in root.as_os_str().as_encoded_bytes() {
        h = (h ^ *b as u32).wrapping_mul(0x01000193);
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    format!("{}-{:06x}", branch_safe(&name), h & 0xffffff)
}

// 브랜치·폴더 이름으로 쓸 수 있게 바꾼다 (영문·숫자·._- 만, 앞의 .·- 제거).
// git이 거부하는 ".."와 끝의 "."·".lock"도 없앤다 (git check-ref-format. 리뷰 지적 4: 항목 z.lock).
fn branch_safe(s: &str) -> String {
    let mapped: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '-' }).collect();
    let mut t = mapped.trim_start_matches(['.', '-']).replace("..", "-");
    while let Some(rest) = t.strip_suffix(".lock").or_else(|| t.strip_suffix('.')) {
        t = rest.to_string();
    }
    if t.is_empty() { "group".into() } else { t }
}

// 테스트에서만 git 대신 감싼 스크립트를 쓸 수 있다 (명령 사이에 다른 프로세스의 동작을 끼워 넣기 위해).
// 환경 변수(PATH)를 바꾸면 병렬로 도는 다른 테스트에도 번지므로 스레드별로 둔다 (create는 테스트 스레드에서 돈다).
#[cfg(test)]
thread_local! {
    static TEST_GIT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

fn git_command() -> Command {
    #[cfg(test)]
    if let Some(program) = TEST_GIT.with(|g| g.borrow().clone()) {
        return Command::new(program);
    }
    crate::platform::background("git")
}

pub fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_command()
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub struct Repo {
    // 그룹 폴더 안의 이름 (프로젝트 자체가 저장소면 None = 그룹 폴더 자체)
    pub name: Option<String>,
    pub path: PathBuf,
}

// 프로젝트의 저장소와 그 밖의 항목 이름. root는 실제 경로(canonicalize). 프로젝트 폴더 자체가 저장소면 그것 하나.
pub fn project_repos(root: &Path) -> Result<(Vec<Repo>, Vec<String>), CodeError> {
    let mut repos = Vec::new();
    let mut others = Vec::new();
    if git_kind(root).is_some() {
        repos.push(Repo { name: None, path: root.to_path_buf() });
        return Ok((repos, others));
    }
    let mut entries: Vec<_> = std::fs::read_dir(root).map_err(|e| code_err("io", e))?.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        if name == ".DS_Store" {
            continue;
        }
        let path = e.path();
        if std::fs::metadata(&path).is_ok_and(|m| m.is_dir()) && git_kind(&path).is_some() {
            repos.push(Repo { name: Some(name), path });
        } else {
            others.push(name);
        }
    }
    Ok((repos, others))
}

#[derive(Debug, serde::Serialize)]
pub struct Created {
    name: String,
    path: String,
    // 준비 창에서 돌릴 명령 (setup.rs: 복제 + 준비 스크립트). 할 준비가 없으면 None
    setup: Option<Vec<String>>,
}

// 저장소 하나에 만들 것: 원본 저장소, worktree 폴더, 브랜치
type Step = (PathBuf, PathBuf, String);

// 만든 것을 기억했다가 실패하면 거꾸로 지운다. 우리가 만든 것만 들어 있어야 한다.
struct Undo {
    // (원본 저장소, worktree 폴더): 그룹 폴더(dir) 안이라 우리 것
    worktrees: Vec<(PathBuf, PathBuf)>,
    // (원본 저장소, 브랜치, 만든 커밋): 없을 때만 만들기에 성공한 것
    branches: Vec<(PathBuf, String, String)>,
    dir: PathBuf,
}
impl Undo {
    fn run(self) {
        for (repo, target) in self.worktrees.into_iter().rev() {
            let _ = git(&repo, &["worktree", "remove", "--force", &target.to_string_lossy()]);
        }
        // 아직 우리가 만든 커밋을 가리킬 때만 지운다 (update-ref -d의 oldvalue 확인)
        for (repo, branch, sha) in self.branches.into_iter().rev() {
            let _ = git(&repo, &["update-ref", "-d", &format!("refs/heads/{branch}"), &sha]);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn branch_exists(repo: &Path, branch: &str) -> bool {
    git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok()
}

// 저장소마다 만들 worktree 폴더와 브랜치. 같은 저장소(git common dir)의 worktree가 프로젝트에 둘 있으면
// (server와 그 worktree인 web 등) 같은 브랜치를 두 번 만들 수 없어서 두 번째부터 항목 이름을 붙인다.
// 항목 이름을 바꾼 결과가 겹치면 (한글 이름 둘 → 둘 다 group) 번호를 더 붙인다 (리뷰 지적 4).
fn plan(repos: &[Repo], commons: &[String], dest: &Path, name: &str) -> Vec<Step> {
    let mut used: Vec<(&str, String)> = Vec::new();
    let mut steps = Vec::new();
    for (repo, common) in repos.iter().zip(commons) {
        let target = repo.name.as_ref().map_or(dest.to_path_buf(), |n| dest.join(n));
        let base = if used.iter().any(|(c, _)| *c == common.as_str()) {
            format!("ddak/{name}-{}", branch_safe(repo.name.as_deref().unwrap_or("repo")))
        } else {
            format!("ddak/{name}")
        };
        let mut branch = base.clone();
        let mut k = 2;
        while used.iter().any(|(c, b)| *c == common.as_str() && *b == branch) {
            branch = format!("{base}-{k}");
            k += 1;
        }
        used.push((common, branch.clone()));
        steps.push((repo.path.clone(), target, branch));
    }
    steps
}

// home: ~/.ddak (테스트는 임시 폴더)
fn create(home: &Path, project: &str, prefix: &str) -> Result<Created, CodeError> {
    let root = crate::platform::canonical(project).map_err(|e| code_err("io", e))?;
    let base = home.join("worktrees").join(project_slug(&root));

    let (repos, others) = project_repos(&root)?;
    if repos.is_empty() {
        return Err(code_err("noRepos", root.to_string_lossy()));
    }

    // 이름: <그룹>-<번호>. 폴더도, 실제로 만들 브랜치도 (항목 이름이 붙은 것까지) 아직 없는 첫 번호 (리뷰 지적 3)
    let prefix = branch_safe(prefix);
    let commons: Vec<String> = repos.iter().map(|r| git(&r.path, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).unwrap_or_default()).collect();
    let name = (1..1000)
        .map(|n| format!("{prefix}-{n}"))
        .find(|n| !base.join(n).exists() && plan(&repos, &commons, &base.join(n), n).iter().all(|(repo, _, b)| !branch_exists(repo, b)))
        .ok_or_else(|| code_err("io", "이름을 정하지 못함"))?;
    let dest = base.join(&name);
    std::fs::create_dir_all(&base).map_err(|e| code_err("io", e))?;
    std::fs::create_dir(&dest).map_err(|e| code_err("io", e))?;

    let mut undo = Undo { worktrees: Vec::new(), branches: Vec::new(), dir: dest.clone() };
    for (repo, target, branch) in plan(&repos, &commons, &dest, &name) {
        // 오류에 쓸 항목 이름 (그룹 폴더 자체가 worktree면 프로젝트 경로)
        let label = if target == dest { root.to_string_lossy() } else { target.file_name().unwrap_or_default().to_string_lossy() };
        let fail = |undo: Undo, e: String| {
            undo.run();
            Err(code_err("git", format!("{label}: {e}")))
        };
        // 브랜치는 worktree와 따로, 없을 때만 만든다: update-ref의 oldvalue ""는 ref를 잠근 채 없음을 확인한다.
        // 이름을 정한 뒤 다른 프로세스가 같은 브랜치를 만들었으면 여기서 실패하고 그 브랜치는 건드리지 않는다
        // (리뷰 후속 P1: 확인 → worktree add -b 사이에 생긴 외부 브랜치를 정리하며 지웠다).
        let sha = match git(&repo, &["rev-parse", "--verify", "HEAD^{commit}"]) {
            Ok(sha) => sha,
            Err(e) => return fail(undo, e),
        };
        if let Err(e) = git(&repo, &["update-ref", "-m", "ddak: work group", &format!("refs/heads/{branch}"), &sha, ""]) {
            return fail(undo, e);
        }
        undo.branches.push((repo.clone(), branch.clone(), sha));
        // 실패한 명령도 worktree 등록을 남길 수 있어서 (post-checkout 훅 실패. 리뷰 지적 1) 명령 전에 기록한다.
        // 그룹 폴더 자체가 worktree가 되는 경우 git은 빈 폴더만 받는다 (방금 만든 빈 폴더라 그대로 된다)
        undo.worktrees.push((repo.clone(), target.clone()));
        if let Err(e) = git(&repo, &["worktree", "add", &target.to_string_lossy(), &branch]) {
            return fail(undo, e);
        }
    }
    for other in &others {
        if let Err(e) = crate::platform::symlink(&root.join(other), &dest.join(other)) {
            undo.run();
            return Err(code_err("io", format!("{other}: {e}")));
        }
    }
    // 만든 것을 적어 둔다: 끝낼 때 우리가 만든 브랜치만 지우기 위해 (worktree 안에서 사용자가 다른 브랜치로 바꿨을 수 있다)
    let made = undo.branches.iter().zip(&undo.worktrees).map(|((repo, branch, sha), (_, worktree))| Made {
        repo: repo.clone(),
        worktree: worktree.clone(),
        branch: branch.clone(),
        start: sha.clone(),
    });
    if let Err(e) = write_record(&record_path(&base, &name), &Record { repos: made.collect() }) {
        undo.run();
        return Err(e);
    }
    Ok(Created { name, path: dest.to_string_lossy().into_owned(), setup: None })
}

// 작업그룹을 만들 때 적는 기록 (작업그룹 폴더들이 든 ddak 폴더의 .ddak-group-<이름>.json)
#[derive(serde::Serialize, serde::Deserialize)]
struct Record {
    repos: Vec<Made>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Made {
    // 원본 저장소, 그 worktree, 우리가 만든 브랜치, 시작 커밋
    repo: PathBuf,
    worktree: PathBuf,
    branch: String,
    start: String,
}

fn record_path(base: &Path, name: &str) -> PathBuf {
    base.join(format!(".ddak-group-{name}.json"))
}

fn write_record(path: &Path, record: &Record) -> Result<(), CodeError> {
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(record).map_err(|e| code_err("io", e))?;
    std::fs::write(&tmp, json).and_then(|()| std::fs::rename(&tmp, path)).map_err(|e| code_err("io", e))
}

// 작업그룹 끝내기 (docs/spec.md "그룹 끝내기"). 병합·PR은 사용자(또는 에이전트)가 하고, 여기서는 상태를 보여 주고 정리한다.
// 지우는 기능이라 아는 것만 지우고, 모르거나 덜 된 것이 있으면 아무것도 지우지 않고 멈춘다 (리뷰 P1 세 건, 후속 P1 두 건·P2).
// - 커밋하지 않은 변경(추적 안 하는 파일 포함, 무시된 파일 제외)이 있으면 끝내지 않는다. git worktree remove도 강제 없이
//   부르므로 확인 뒤에 생긴 변경도 git이 거부한다 (2026-10-24 실험: 무시된 node_modules만 있으면 지우고, 추적 안 하는 파일이나
//   고친 파일이 있으면 거부).
// - worktree의 실제 HEAD에서 어느 브랜치에도, 원본 HEAD에도 없는 커밋(detached HEAD에서 만든 것 등)이 있으면 끝내지 않는다
//   (worktree를 지우면 닿을 수 없게 되고 GC로 사라진다).
// - 작업그룹 폴더에 끝낼 worktree와 우리가 만든 링크(원본의 같은 이름 항목을 가리킴) 말고 다른 것이 있거나, worktree 자리에
//   폴더는 있는데 worktree가 아니면 (.git이 없음) 끝내지 않는다. 마지막에는 그 링크만 지우고 빈 폴더만 지운다.
// - 확인을 못 하면(git 오류) 0으로 보지 않고 멈춘다. 확인한 뒤 세션이 커밋하지 않게, 이 폴더를 잠그고 세션을 끝낸 뒤
//   다시 확인하고 지운다 (end).
// - 브랜치는 만들 때 적은 것만, 지금 커밋이 원본 HEAD에 있고 쓰는 곳(worktree HEAD·rebase·bisect)이 없을 때 그 커밋일
//   때만 지운다 (branch_in_use, update-ref -d의 기대값). 쓰는지 확인하지 못하면 남긴다. 지우지 못한 것은 남기고 알린다. 기록이 없는 작업그룹(이전 버전)의
//   브랜치는 모두 남긴다.

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    // 작업그룹 폴더 안의 이름 (프로젝트 자체가 저장소면 "")
    label: String,
    branch: Option<String>,
    // 원본의 지금 HEAD에 없는 커밋 수 (병합 안 됨, 기록한 브랜치 기준)
    unmerged: u32,
    // worktree HEAD에서 어느 브랜치에도·원본 HEAD에도 없는 커밋 수 (끝내면 잃는다)
    unsaved: u32,
    // 커밋하지 않은 변경 (git status --porcelain 줄 수)
    changes: u32,
    // worktree 자리가 아예 없음 (이미 지움)
    missing: bool,
    // 자리는 있는데 worktree가 아님 (.git이 없음)
    incomplete: bool,
}

#[derive(serde::Serialize, Debug)]
pub struct GroupStatus {
    repos: Vec<RepoStatus>,
    // 만들 때 적은 기록이 있는지 (없으면 브랜치를 지우지 않는다)
    recorded: bool,
    // 작업그룹 폴더에 있는 모르는 항목 (끝내지 않는다)
    unknown: Vec<String>,
}

impl GroupStatus {
    fn blocked(&self) -> Option<(&'static str, String)> {
        let names = |f: fn(&RepoStatus) -> bool| self.repos.iter().filter(|r| f(r)).map(|r| r.label.clone()).collect::<Vec<_>>().join(", ");
        if !self.unknown.is_empty() {
            return Some(("unknown", self.unknown.join(", ")));
        }
        for (code, f) in [("incomplete", (|r: &RepoStatus| r.incomplete) as fn(&RepoStatus) -> bool), ("dirty", |r| r.changes > 0), ("unsaved", |r| r.unsaved > 0)] {
            let list = names(f);
            if self.repos.iter().any(f) {
                return Some((code, list));
            }
        }
        None
    }
}

// 작업그룹 폴더가 이 프로젝트의 ddak 폴더 바로 아래 것인지 확인하고 (ddak 폴더, 이름, 원본 폴더)
fn locate(home: &Path, project: &str, group: &str) -> Result<(PathBuf, String, PathBuf), CodeError> {
    let root = crate::platform::canonical(project).map_err(|e| code_err("io", e))?;
    let base = home.join("worktrees").join(project_slug(&root));
    let group = Path::new(group);
    let name = group.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let real_base = crate::platform::canonical(&base).map_err(|e| code_err("io", e))?;
    let real_parent = group.parent().and_then(|p| crate::platform::canonical(p).ok());
    if name.is_empty() || name.starts_with('.') || real_parent.as_deref() != Some(real_base.as_path()) {
        return Err(code_err("io", format!("{}: not a work group of this project", group.display())));
    }
    Ok((base, name, root))
}

// 끝낼 저장소들: 기록이 있으면 그것, 없으면 지금 프로젝트 모양으로 짐작한다 (브랜치는 worktree의 지금 브랜치).
// 짐작에서 빠진 worktree(원본에서 연결을 끊은 저장소 등)는 모르는 항목으로 걸린다.
fn members(base: &Path, name: &str, root: &Path) -> Result<(Vec<Made>, bool), CodeError> {
    if let Ok(bytes) = std::fs::read(record_path(base, name)) {
        let record: Record = serde_json::from_slice(&bytes).map_err(|e| code_err("io", e))?;
        return Ok((record.repos, true));
    }
    let dest = base.join(name);
    let (repos, _) = project_repos(root)?;
    let made = repos.into_iter().map(|r| {
        let worktree = r.name.as_ref().map_or(dest.clone(), |n| dest.join(n));
        let branch = git(&worktree, &["branch", "--show-current"]).unwrap_or_default();
        Made { repo: r.path, worktree, branch, start: String::new() }
    });
    Ok((made.collect(), false))
}

// 작업그룹 폴더 안에서 우리가 만든 링크: 원본의 같은 이름 항목을 가리키는 심볼릭 링크
fn our_link(path: &Path, root: &Path) -> bool {
    let name = path.file_name().unwrap_or_default();
    path.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) && std::fs::read_link(path).is_ok_and(|t| t == root.join(name))
}

// 상태·HEAD·커밋 수를 확인하지 못하면 0(안전)으로 보지 않고 오류로 멈춘다 (리뷰 P1: 원본 HEAD가 아직 커밋이 없는
// 브랜치면 커밋 수 검사가 실패했는데 0으로 보고 worktree를 지웠다).
fn status_of(dest: &Path, root: &Path, made: &[Made], recorded: bool) -> Result<GroupStatus, CodeError> {
    let mut repos = Vec::new();
    for m in made {
        let label = m.worktree.strip_prefix(dest).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let fail = |e: String| code_err("git", format!("{}: {e}", if label.is_empty() { &m.branch } else { &label }));
        let count = |dir: &Path, args: &[&str]| git(dir, args).map_err(fail).and_then(|n| n.parse::<u32>().map_err(|e| fail(e.to_string())));
        let exists = m.worktree.symlink_metadata().is_ok();
        let worktree = exists && m.worktree.join(".git").is_file() && git(&m.worktree, &["rev-parse", "--is-inside-work-tree"]).is_ok();
        let changes = if worktree { git(&m.worktree, &["status", "--porcelain"]).map_err(fail)?.lines().count() as u32 } else { 0 };
        // 기록한 브랜치를 사용자가 지웠으면 지울 것도 셀 것도 없다
        let branch_ref = format!("refs/heads/{}", m.branch);
        let has_branch = !m.branch.is_empty() && git(&m.repo, &["rev-parse", "--verify", "--quiet", &branch_ref]).is_ok();
        let unmerged = if has_branch { count(&m.repo, &["rev-list", "--count", &format!("HEAD..{branch_ref}")])? } else { 0 };
        let unsaved = if worktree {
            let head = git(&m.worktree, &["rev-parse", "HEAD"]).map_err(fail)?;
            count(&m.repo, &["rev-list", "--count", &head, "--not", "--branches", "HEAD"])?
        } else {
            0
        };
        let branch = (!m.branch.is_empty()).then(|| m.branch.clone());
        repos.push(RepoStatus { label, branch, unmerged, unsaved, changes, missing: !exists, incomplete: exists && !worktree });
    }
    // 프로젝트 자체가 저장소면 작업그룹 폴더가 곧 worktree라 git status가 본다
    let mut unknown = Vec::new();
    if !made.iter().any(|m| m.worktree == dest) {
        if let Ok(entries) = std::fs::read_dir(dest) {
            for e in entries.flatten() {
                let path = e.path();
                let known = made.iter().any(|m| m.worktree == path) || our_link(&path, root) || e.file_name() == ".DS_Store";
                if !known {
                    unknown.push(e.file_name().to_string_lossy().into_owned());
                }
            }
        }
    }
    unknown.sort();
    Ok(GroupStatus { repos, recorded, unknown })
}

fn status(home: &Path, project: &str, group: &str) -> Result<GroupStatus, CodeError> {
    let (base, name, root) = locate(home, project, group)?;
    let (made, recorded) = members(&base, &name, &root)?;
    status_of(&base.join(&name), &root, &made, recorded)
}

// 브랜치를 쓰는 곳이 있는지: 어느 worktree(원본 포함)의 HEAD나 진행 중인 rebase(--update-refs 포함)·bisect가 그 브랜치를
// 가리키면 쓴다. git branch -d의 검사(branch.c branch_checked_out)와 같은 것을 직접 본다. git branch -d는 upstream이 있으면
// 원본 HEAD가 아니라 upstream 기준으로 병합을 판단해서 쓰지 않는다 (리뷰 P2). 파일이 없으면 그 상태가 아닌 것이고,
// 그 밖에 읽지 못하면 (권한 등) 쓰는지 모르므로 오류 (리뷰 후속 P2: 빈 내용으로 보고 지웠다).
fn branch_in_use(repo: &Path, branch: &str) -> Result<bool, CodeError> {
    let common = git(repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).map_err(|e| code_err("git", e))?;
    let common = PathBuf::from(common);
    let io = |p: &Path, e: std::io::Error| code_err("io", format!("{}: {e}", p.display()));
    let mut dirs = vec![common.clone()];
    match std::fs::read_dir(common.join("worktrees")) {
        Ok(entries) => {
            for e in entries {
                dirs.push(e.map_err(|e| io(&common, e))?.path());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(io(&common, e)),
    }
    let read = |p: PathBuf| match std::fs::read_to_string(&p) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(io(&p, e)),
    };
    let full = format!("refs/heads/{branch}");
    for d in dirs {
        let bisect = read(d.join("BISECT_START"))?;
        let used = read(d.join("HEAD"))?.trim() == format!("ref: {full}")
            || read(d.join("rebase-merge/head-name"))?.trim() == full
            || read(d.join("rebase-apply/head-name"))?.trim() == full
            || read(d.join("rebase-merge/update-refs"))?.lines().any(|l| l.trim() == full)
            || bisect.trim() == branch
            || bisect.trim() == full;
        if used {
            return Ok(true);
        }
    }
    Ok(false)
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Kept {
    label: String,
    branch: String,
    // "unmerged": 원본 HEAD에 병합 안 됨, "inUse": 다른 worktree에 체크아웃됨·rebase·bisect 중, "unchecked": 쓰는지
    // 확인하지 못함, "changed": 확인한 뒤 브랜치가 움직임, "noRecord": 기록 없음
    reason: &'static str,
}

#[derive(serde::Serialize, Debug)]
pub struct Ended {
    kept: Vec<Kept>,
}

// 끝내기가 실패한 이유. stopped: 세션을 끝낸 뒤라 프론트가 다시 띄워야 한다.
#[derive(serde::Serialize, Debug)]
pub struct EndError {
    code: &'static str,
    detail: String,
    stopped: bool,
}

impl From<CodeError> for EndError {
    fn from(e: CodeError) -> Self {
        EndError { code: e.code, detail: e.detail, stopped: false }
    }
}

// 확인한 뒤 지우기 전에 세션이 커밋하면 잃으므로 (리뷰 P1):
// 1. 확인해서 끝낼 수 없으면 세션을 건드리지 않고 멈춘다.
// 2. 끝날 때까지 이 폴더를 잠가 새 터미널을 막고 (리뷰 후속 P1), ddak이 이 폴더에서 띄운 터미널(닫는 중인 것 포함)을
//    모두 끝내고 기다린다 (pty::stop_under).
// 3. 다시 확인하고 지운다 (finish).
fn end(home: &Path, project: &str, group: &str, ptys: &Ptys) -> Result<Ended, EndError> {
    if let Some((code, detail)) = status(home, project, group)?.blocked() {
        return Err(code_err(code, detail).into());
    }
    let (base, name, _) = locate(home, project, group)?;
    let dest = base.join(&name);
    let real = crate::platform::canonical(&dest).unwrap_or(dest);
    let _ending = crate::pty::hold(ptys, &real);
    let stopped = |e: CodeError| EndError { code: e.code, detail: e.detail, stopped: true };
    if !crate::pty::stop_under(ptys, &real) {
        return Err(stopped(code_err("running", real.display())));
    }
    finish(home, project, group).map_err(stopped)
}

fn finish(home: &Path, project: &str, group: &str) -> Result<Ended, CodeError> {
    let (base, name, root) = locate(home, project, group)?;
    let dest = base.join(&name);
    let (made, recorded) = members(&base, &name, &root)?;
    let now = status_of(&dest, &root, &made, recorded)?;
    if let Some((code, detail)) = now.blocked() {
        return Err(code_err(code, detail));
    }
    for (m, s) in made.iter().zip(&now.repos) {
        if !s.missing {
            git(&m.repo, &["worktree", "remove", &m.worktree.to_string_lossy()]).map_err(|e| code_err("git", format!("{}: {e}", s.label)))?;
        }
    }
    // 브랜치: 지금 커밋을 읽고, 그 커밋이 원본 HEAD에 있고 브랜치를 쓰는 곳이 없으면, 브랜치가 아직 그 커밋일 때만 지운다
    // (update-ref의 기대값).
    // 검사와 지우기 사이에 누가 체크아웃하면 그 worktree는 없는 브랜치에 남지만, 지운 커밋은 원본 HEAD에 있다.
    let mut kept = Vec::new();
    for (m, s) in made.iter().zip(&now.repos) {
        let branch_ref = format!("refs/heads/{}", m.branch);
        let Some(sha) = (!m.branch.is_empty()).then(|| git(&m.repo, &["rev-parse", "--verify", "--quiet", &branch_ref]).ok()).flatten() else {
            continue;
        };
        let keep = |reason| Kept { label: s.label.clone(), branch: m.branch.clone(), reason };
        if !recorded {
            kept.push(keep("noRecord"));
        } else if git(&m.repo, &["merge-base", "--is-ancestor", &sha, "HEAD"]).is_err() {
            kept.push(keep("unmerged"));
        } else if let Some(reason) = branch_in_use(&m.repo, &m.branch).map_or(Some("unchecked"), |used| used.then_some("inUse")) {
            kept.push(keep(reason));
        } else if git(&m.repo, &["update-ref", "-d", &branch_ref, &sha]).is_err() {
            kept.push(keep("changed"));
        }
    }
    // 남은 것은 우리가 만든 링크와 .DS_Store뿐이어야 한다. 그것만 지우고 빈 폴더를 지운다 (모르는 것이 그새 생겼으면 남긴다).
    if dest.exists() {
        if let Ok(entries) = std::fs::read_dir(&dest) {
            for e in entries.flatten() {
                if our_link(&e.path(), &root) || e.file_name() == ".DS_Store" {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        std::fs::remove_dir(&dest).map_err(|e| code_err("leftover", format!("{}: {e}", dest.display())))?;
    }
    let _ = std::fs::remove_file(record_path(&base, &name));
    let _ = std::fs::remove_file(base.join(format!(".ddak-state-{name}.json")));
    Ok(Ended { kept })
}

#[tauri::command]
pub async fn group_status(project: String, group: String) -> Result<GroupStatus, CodeError> {
    let home = ddak_home()?;
    tauri::async_runtime::spawn_blocking(move || status(&home, &project, &group)).await.map_err(|e| code_err("io", e))?
}

#[tauri::command]
pub async fn group_end(app: AppHandle, project: String, group: String) -> Result<Ended, EndError> {
    let home = ddak_home()?;
    tauri::async_runtime::spawn_blocking(move || end(&home, &project, &group, &app.state::<Ptys>()))
        .await
        .map_err(|e| EndError::from(code_err("io", e)))?
}

// git 명령이 몇 초 걸릴 수 있어 별도 스레드에서 돈다.
// 할 준비가 있으면 준비 창에서 돌릴 명령을 함께 돌려준다. 준비 설정은 만들기 전에 읽는다 (잘못됐으면 아무것도
// 만들지 않고 실패).
#[tauri::command]
pub async fn group_create(app: AppHandle, project: String, prefix: String) -> Result<Created, CodeError> {
    let home = ddak_home()?;
    let plan = crate::setup::plan(&app, Path::new(&project))?;
    let origin = project.clone();
    let made = tauri::async_runtime::spawn_blocking(move || {
        let made = create(&home, &project, &prefix)?;
        // 원본 프로젝트를 claude가 신뢰하면 작업그룹 폴더도 (첫 claude가 신뢰를 묻는 동안 깨우기의 Enter가 답을 고르지 않게)
        crate::claude_trust::inherit_for_group(Path::new(&project), Path::new(&made.path));
        Ok::<_, CodeError>(made)
    })
    .await
    .map_err(|e| code_err("io", e))??;
    let setup = match plan {
        Some(plan) => Some(crate::setup::command(&plan, &origin, &made.path, &made.name)?),
        None => None,
    };
    Ok(Created { setup, ..made })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, cmd: &str) {
        let ok = Command::new("/bin/sh").arg("-c").arg(cmd).current_dir(dir).status().unwrap().success();
        assert!(ok, "{cmd}");
    }
    const INIT: &str = "git init -q && git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init";

    #[test]
    fn names() {
        assert_eq!(branch_safe("dev-review"), "dev-review");
        assert_eq!(branch_safe("개발 그룹"), "group"); // 한글·공백 → - 만 남아 잘림
        assert_eq!(branch_safe("..a b"), "a-b");
        assert_ne!(project_slug(Path::new("/x/app")), project_slug(Path::new("/y/app")));
        assert!(project_slug(Path::new("/x/app")).starts_with("app-"));
    }

    #[test]
    fn creates_and_rolls_back() {
        let tmp = std::env::temp_dir().join(format!("ddak-wt-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let proj = tmp.join("proj");
        for d in ["server", "docs"] {
            std::fs::create_dir_all(proj.join(d)).unwrap();
        }
        sh(&proj.join("server"), INIT);
        std::fs::write(proj.join("notes.md"), "n").unwrap();
        let home = tmp.join("home");
        let p = proj.to_string_lossy().into_owned();

        let a = create(&home, &p, "dev").unwrap();
        assert_eq!(a.name, "dev-1");
        let dest = PathBuf::from(&a.path);
        assert_eq!(git(&dest.join("server"), &["branch", "--show-current"]).unwrap(), "ddak/dev-1");
        assert_eq!(std::fs::read_link(dest.join("notes.md")).unwrap(), std::fs::canonicalize(&proj).unwrap().join("notes.md"));
        assert!(std::fs::read_link(dest.join("docs")).is_ok());
        assert_eq!(create(&home, &p, "dev").unwrap().name, "dev-2");

        // 커밋 없는 저장소가 있으면 실패하고, 먼저 만든 worktree·브랜치·폴더를 지운다
        std::fs::create_dir_all(proj.join("zempty")).unwrap();
        sh(&proj.join("zempty"), "git init -q");
        let e = create(&home, &p, "dev").unwrap_err();
        assert_eq!(e.code, "git");
        assert!(!dest.with_file_name("dev-3").exists());
        assert!(git(&proj.join("server"), &["rev-parse", "--verify", "--quiet", "refs/heads/ddak/dev-3"]).is_err());
        let list = git(&proj.join("server"), &["worktree", "list"]).unwrap();
        assert!(!list.contains("dev-3"), "{list}");

        std::fs::remove_dir_all(&tmp).unwrap();
    }

    // 끝내기 테스트용 프로젝트: 저장소 a, b와 메모 하나
    fn end_project(tmp: &Path) -> (PathBuf, PathBuf, String) {
        let _ = std::fs::remove_dir_all(tmp);
        let proj = tmp.join("proj");
        for d in ["a", "b"] {
            std::fs::create_dir_all(proj.join(d)).unwrap();
            sh(&proj.join(d), INIT);
        }
        std::fs::write(proj.join("notes.md"), "n").unwrap();
        let p = proj.to_string_lossy().into_owned();
        (proj, tmp.join("home"), p)
    }
    const COMMIT: &str = "git add -A && git -c user.name=t -c user.email=t@example.com commit -qm work";

    // 작업그룹 끝내기: 커밋 안 한 변경이 있으면 끝내지 않고, 병합된 우리 브랜치만 지우고 병합 안 된 것은 남긴다.
    // worktree에서 사용자가 만든 다른 브랜치는 (병합됐어도) 지우지 않는다. 원본과 링크 대상은 그대로.
    #[test]
    fn end_removes_worktrees_and_only_merged_own_branches() {
        let tmp = std::env::temp_dir().join(format!("ddak-wt-end-{}", std::process::id()));
        let (proj, home, p) = end_project(&tmp);
        let branch = |repo: &str, b: &str| git(&proj.join(repo), &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{b}")]).is_ok();

        let g = create(&home, &p, "g").unwrap();
        let dest = PathBuf::from(&g.path);
        let st = status(&home, &p, &g.path).unwrap();
        assert!(st.recorded && st.unknown.is_empty() && st.blocked().is_none(), "{st:?}");
        // 커밋 안 한 파일 → 끝내지 않음
        std::fs::write(dest.join("a/new.txt"), "x").unwrap();
        assert_eq!(status(&home, &p, &g.path).unwrap().repos[0].changes, 1);
        assert_eq!(end(&home, &p, &g.path, &Ptys::default()).unwrap_err().code, "dirty");
        assert!(dest.join("a/.git").exists());
        // 커밋 → 병합 안 됨 → 그 브랜치는 남기고 나머지는 지움
        sh(&dest.join("a"), COMMIT);
        assert_eq!(status(&home, &p, &g.path).unwrap().repos[0].unmerged, 1);
        let ended = end(&home, &p, &g.path, &Ptys::default()).unwrap();
        assert_eq!(ended.kept, vec![Kept { label: "a".into(), branch: "ddak/g-1".into(), reason: "unmerged" }]);
        assert!(branch("a", "ddak/g-1") && !branch("b", "ddak/g-1"));
        assert!(!dest.exists() && !record_path(dest.parent().unwrap(), "g-1").exists());
        assert!(proj.join("notes.md").exists());
        assert!(!git(&proj.join("a"), &["worktree", "list"]).unwrap().contains("g-1"));

        // worktree에서 브랜치를 바꿨으면: 우리 브랜치(병합됨)만 지우고 사용자 브랜치는 둔다
        let g2 = create(&home, &p, "g").unwrap();
        sh(&PathBuf::from(&g2.path).join("b"), "git checkout -q -b mine");
        end(&home, &p, &g2.path, &Ptys::default()).unwrap();
        assert!(branch("b", "mine") && !branch("b", &format!("ddak/{}", g2.name)));

        // 이 프로젝트의 작업그룹이 아니면 거부
        assert!(end(&home, &p, &tmp.join("proj").to_string_lossy(), &Ptys::default()).is_err());
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    // 모르거나 덜 된 것이 있으면 아무것도 지우지 않는다 (리뷰 P1): 작업그룹 맨 위에 새로 만든 메모·폴더, .git이 없어진
    // worktree, 기록 없는 작업그룹에서 짐작에 빠진 worktree(원본에서 연결을 끊은 저장소).
    #[test]
    fn end_keeps_everything_it_does_not_know() {
        let tmp = std::env::temp_dir().join(format!("ddak-wt-unknown-{}", std::process::id()));
        let (proj, home, p) = end_project(&tmp);
        let g = create(&home, &p, "g").unwrap();
        let dest = PathBuf::from(&g.path);
        std::fs::write(dest.join("todo.md"), "mine").unwrap();
        std::fs::create_dir_all(dest.join("drafts")).unwrap();
        std::fs::write(dest.join(".DS_Store"), "").unwrap(); // Finder가 만드는 것은 괜찮다
        assert_eq!(status(&home, &p, &g.path).unwrap().unknown, ["drafts", "todo.md"]);
        assert_eq!(end(&home, &p, &g.path, &Ptys::default()).unwrap_err().code, "unknown");
        assert!(dest.join("todo.md").exists() && dest.join("a/.git").exists() && dest.join("b/.git").exists());
        std::fs::remove_file(dest.join("todo.md")).unwrap();
        std::fs::remove_dir(dest.join("drafts")).unwrap();

        // .git이 없어진 worktree: 이미 지운 것으로 보지 않는다
        std::fs::write(dest.join("b/work.txt"), "keep").unwrap();
        std::fs::rename(dest.join("b/.git"), tmp.join("b.git")).unwrap();
        assert!(status(&home, &p, &g.path).unwrap().repos[1].incomplete);
        assert_eq!(end(&home, &p, &g.path, &Ptys::default()).unwrap_err().code, "incomplete");
        assert!(dest.join("b/work.txt").exists() && dest.join("a/.git").exists());
        std::fs::rename(tmp.join("b.git"), dest.join("b/.git")).unwrap();
        std::fs::remove_file(dest.join("b/work.txt")).unwrap();
        end(&home, &p, &g.path, &Ptys::default()).unwrap();
        assert!(!dest.exists());

        // 기록 없는 작업그룹(이전 버전)에서 b를 프로젝트에서 뺐으면, b의 worktree는 모르는 항목
        let g2 = create(&home, &p, "g").unwrap();
        let dest2 = PathBuf::from(&g2.path);
        std::fs::remove_file(record_path(dest2.parent().unwrap(), &g2.name)).unwrap();
        std::fs::write(dest2.join("b/uncommitted.txt"), "x").unwrap();
        // b를 프로젝트에서 뺀다 (옮김). 지금 프로젝트 모양으로 짐작하면 b가 빠진다
        std::fs::rename(proj.join("b"), tmp.join("b-elsewhere")).unwrap();
        let st = status(&home, &p, &g2.path).unwrap();
        assert!(!st.recorded && st.unknown.contains(&"b".to_string()), "{st:?}");
        assert_eq!(end(&home, &p, &g2.path, &Ptys::default()).unwrap_err().code, "unknown");
        assert!(dest2.join("b/uncommitted.txt").exists());
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    // worktree HEAD에만 있는 커밋(detached HEAD에서 만든 것)이 있으면 끝내지 않는다 (리뷰 P1). 브랜치를 만들어 두면 끝낸다.
    #[test]
    fn end_refuses_commits_on_no_branch() {
        let tmp = std::env::temp_dir().join(format!("ddak-wt-detached-{}", std::process::id()));
        let (proj, home, p) = end_project(&tmp);
        let g = create(&home, &p, "g").unwrap();
        let a = PathBuf::from(&g.path).join("a");
        sh(&a, "git checkout -q --detach && echo x > f.txt");
        sh(&a, COMMIT);
        let st = status(&home, &p, &g.path).unwrap();
        assert_eq!((st.repos[0].unsaved, st.repos[0].unmerged), (1, 0), "{st:?}");
        assert_eq!(end(&home, &p, &g.path, &Ptys::default()).unwrap_err().code, "unsaved");
        sh(&a, "git branch saved");
        assert_eq!(status(&home, &p, &g.path).unwrap().repos[0].unsaved, 0);
        end(&home, &p, &g.path, &Ptys::default()).unwrap();
        assert!(git(&proj.join("a"), &["rev-parse", "--verify", "--quiet", "refs/heads/saved"]).is_ok());
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    // 다른 worktree(원본 등)에 체크아웃된 우리 브랜치는 지우지 않고 알린다 (리뷰 P1: update-ref -d가 원본의 HEAD를 깨뜨렸다)
    #[test]
    fn end_keeps_branch_checked_out_elsewhere() {
        let tmp = std::env::temp_dir().join(format!("ddak-wt-inuse-{}", std::process::id()));
        let (proj, home, p) = end_project(&tmp);
        let g = create(&home, &p, "g").unwrap();
        sh(&PathBuf::from(&g.path).join("a"), "git checkout -q -b mine");
        sh(&proj.join("a"), "git checkout -q ddak/g-1");
        let ended = end(&home, &p, &g.path, &Ptys::default()).unwrap();
        assert_eq!(ended.kept, vec![Kept { label: "a".into(), branch: "ddak/g-1".into(), reason: "inUse" }]);
        assert_eq!(git(&proj.join("a"), &["branch", "--show-current"]).unwrap(), "ddak/g-1");
        assert!(git(&proj.join("a"), &["rev-parse", "HEAD"]).is_ok());
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    // 상태를 확인하지 못하면 0으로 보지 않고 멈춘다 (리뷰 후속 P1: 원본이 커밋 없는 브랜치면 커밋 수 검사가 실패했는데
    // 브랜치에 없는 커밋 0으로 보고 worktree를 지웠다).
    #[test]
    fn end_stops_when_a_check_fails() {
        let tmp = std::env::temp_dir().join(format!("ddak-wt-checkfail-{}", std::process::id()));
        let (proj, home, p) = end_project(&tmp);
        let g = create(&home, &p, "g").unwrap();
        let a = PathBuf::from(&g.path).join("a");
        sh(&a, "git checkout -q --detach && echo x > f.txt");
        sh(&a, COMMIT);
        sh(&proj.join("a"), "git checkout -q --orphan empty");
        assert_eq!(status(&home, &p, &g.path).unwrap_err().code, "git");
        assert_eq!(end(&home, &p, &g.path, &Ptys::default()).unwrap_err().code, "git");
        assert!(a.join("f.txt").exists(), "worktree를 지움");
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    // 확인한 커밋에서 브랜치가 움직였으면 지우지 않는다 (리뷰 후속 P2: git branch -d는 upstream이 있으면 원본 HEAD가 아니라
    // upstream 기준이라, upstream에만 있는 새 커밋으로 옮겨진 브랜치를 지웠다). 지우는 명령 직전에 브랜치를 옮기는 git
    // 래퍼로 순서를 정한다. upstream은 같은 저장소의 브랜치(remote ".")로 둔다.
    #[test]
    fn end_keeps_branch_moved_after_check() {
        let tmp = std::env::temp_dir().join(format!("ddak-wt-moved-{}", std::process::id()));
        let (proj, home, p) = end_project(&tmp);
        let g = create(&home, &p, "g").unwrap();
        let repo = proj.join("a");
        sh(&PathBuf::from(&g.path).join("a"), "git checkout -q -b mine");
        sh(&repo, "git branch up ddak/g-1 && git branch -q -u up ddak/g-1");
        let mark = tmp.join("moved");
        let wrapper = tmp.join("git-wrapper.sh");
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\ncase \" $* \" in *\" -d \"*ddak/g-1*)\n  if [ ! -e '{m}' ]; then touch '{m}'; sha=$(git -C '{r}' commit-tree 'HEAD^{{tree}}' -p HEAD -m later); git -C '{r}' update-ref refs/heads/up \"$sha\"; git -C '{r}' update-ref refs/heads/ddak/g-1 \"$sha\"; fi;;\nesac\nexec git \"$@\"\n",
                m = mark.display(),
                r = repo.display()
            ),
        )
        .unwrap();
        sh(&tmp, "chmod +x git-wrapper.sh");
        TEST_GIT.with(|g| *g.borrow_mut() = Some(wrapper.clone()));
        let ended = end(&home, &p, &g.path, &Ptys::default());
        TEST_GIT.with(|g| *g.borrow_mut() = None);
        assert!(mark.exists(), "래퍼가 끼어들지 않음");
        assert_eq!(ended.unwrap().kept, vec![Kept { label: "a".into(), branch: "ddak/g-1".into(), reason: "changed" }]);
        assert_eq!(git(&repo, &["log", "-1", "--format=%s", "ddak/g-1"]).as_deref(), Ok("later"));
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    // 원본에서 rebase 중인 브랜치는 (HEAD가 detached여도) 쓰는 중이라 지우지 않는다 (git branch -d와 같은 검사)
    #[test]
    fn end_keeps_branch_being_rebased() {
        let tmp = std::env::temp_dir().join(format!("ddak-wt-rebase-{}", std::process::id()));
        let (proj, home, p) = end_project(&tmp);
        let g = create(&home, &p, "g").unwrap();
        let repo = proj.join("a");
        sh(&PathBuf::from(&g.path).join("a"), "git checkout -q -b mine");
        sh(&repo, "git checkout -q ddak/g-1 && echo y > r.txt");
        sh(&repo, COMMIT);
        // 커밋 하나를 다시 적용한 뒤 exec가 실패해서 rebase가 멈춘다 (HEAD는 detached, 같은 커밋)
        let _ = Command::new("git").arg("-C").arg(&repo).args(["rebase", "-q", "--exec", "false", "HEAD~1"]).output();
        assert!(git(&repo, &["branch", "--show-current"]).unwrap().is_empty(), "rebase가 멈추지 않음");
        let ended = end(&home, &p, &g.path, &Ptys::default()).unwrap();
        assert_eq!(ended.kept, vec![Kept { label: "a".into(), branch: "ddak/g-1".into(), reason: "inUse" }]);
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    // 브랜치를 쓰는지 확인하지 못하면 (다른 worktree의 HEAD를 읽지 못함) 지우지 않고 남긴다 (리뷰 후속 P2: 빈 내용으로
    // 보고 그 worktree가 체크아웃한 브랜치를 지웠다).
    #[test]
    fn end_keeps_branch_it_cannot_check() {
        let tmp = std::env::temp_dir().join(format!("ddak-wt-unchecked-{}", std::process::id()));
        let (proj, home, p) = end_project(&tmp);
        let g = create(&home, &p, "g").unwrap();
        let repo = proj.join("a");
        sh(&PathBuf::from(&g.path).join("a"), "git checkout -q -b mine");
        sh(&repo, &format!("git worktree add -q '{}' ddak/g-1", tmp.join("other").display()));
        let head = repo.join(".git/worktrees/other/HEAD");
        sh(&tmp, &format!("chmod 000 '{}'", head.display()));
        let ended = end(&home, &p, &g.path, &Ptys::default());
        sh(&tmp, &format!("chmod 644 '{}'", head.display()));
        assert_eq!(ended.unwrap().kept, vec![Kept { label: "a".into(), branch: "ddak/g-1".into(), reason: "unchecked" }]);
        assert_eq!(git(&tmp.join("other"), &["branch", "--show-current"]).unwrap(), "ddak/g-1");
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    // 리뷰 후속 P1: 이름을 정한 뒤 (또는 마지막 확인 뒤) 다른 프로세스가 같은 브랜치를 만들어도 그 브랜치를 지우지 않는다.
    // 브랜치를 만드는 명령 직전에 외부 브랜치(고유 커밋)를 만드는 git 래퍼로 실행 순서를 정한다.
    #[test]
    fn never_deletes_branch_created_by_others() {
        let tmp = std::env::temp_dir().join(format!("ddak-wt-race-{}", std::process::id()));
        let proj = shared_repo_project(&tmp, &[]);
        let server = proj.join("server");
        let mark = tmp.join("raced");
        let wrapper = tmp.join("git-wrapper.sh");
        // rev-parse(확인)는 그냥 통과시키고, ddak/dev-1을 만드는 첫 명령 직전에 한 번만 끼어든다
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\ncase \" $* \" in *\" rev-parse \"*) ;; *\" ddak/dev-1 \"*|*\" refs/heads/ddak/dev-1 \"*)\n  if [ ! -e '{m}' ]; then touch '{m}'; sha=$(git -C '{r}' commit-tree 'HEAD^{{tree}}' -p HEAD -m external); git -C '{r}' branch ddak/dev-1 \"$sha\"; fi;;\nesac\nexec git \"$@\"\n",
                m = mark.display(),
                r = server.display()
            ),
        )
        .unwrap();
        sh(&tmp, "chmod +x git-wrapper.sh");
        TEST_GIT.with(|g| *g.borrow_mut() = Some(wrapper.clone()));
        let result = create(&tmp.join("home"), &proj.to_string_lossy(), "dev");
        TEST_GIT.with(|g| *g.borrow_mut() = None);

        assert!(mark.exists(), "래퍼가 끼어들지 않음");
        assert_eq!(result.unwrap_err().code, "git");
        let external = git(&server, &["log", "-1", "--format=%s", "ddak/dev-1"]);
        assert_eq!(external.as_deref(), Ok("external"), "외부 브랜치가 지워지거나 바뀜");
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    fn valid_branch(name: &str) -> bool {
        Command::new("git").args(["check-ref-format", "--branch", name]).output().unwrap().status.success()
    }

    // 리뷰 지적 4: 항목 이름에서 만든 브랜치가 git이 받는 이름이어야 한다
    #[test]
    fn branch_names_are_valid() {
        for s in ["z.lock", "a.", "..x", ".hidden", "리뷰", "a..b", "x.lock.lock", "-a", "a/b", "a b", "@{u}", "a.lock."] {
            let b = branch_safe(s);
            assert!(valid_branch(&format!("ddak/{b}-1")) && valid_branch(&format!("ddak/n-{b}")), "{s} → {b}");
        }
    }

    // 프로젝트: server(저장소)와 그 worktree들 (같은 저장소의 두 번째부터 브랜치에 항목 이름이 붙는다)
    fn shared_repo_project(tmp: &Path, worktrees: &[&str]) -> PathBuf {
        let _ = std::fs::remove_dir_all(tmp);
        let proj = tmp.join("proj");
        std::fs::create_dir_all(proj.join("server")).unwrap();
        sh(&proj.join("server"), INIT);
        for (i, w) in worktrees.iter().enumerate() {
            sh(&proj.join("server"), &format!("git worktree add -q -b w{i} '../{w}'"));
        }
        proj
    }

    // 리뷰 지적 1: git 명령이 실패해도 그 명령이 만든 브랜치·worktree 등록은 지운다 (훅 실패 등)
    #[test]
    fn failed_add_cleans_up_its_own_branch() {
        let tmp = std::env::temp_dir().join(format!("ddak-wt-hook-{}", std::process::id()));
        let proj = shared_repo_project(&tmp, &["web"]);
        let server = proj.join("server");
        let home = tmp.join("home");
        let p = proj.to_string_lossy().into_owned();
        // web(두 번째 항목)을 만들 때만 실패하는 post-checkout 훅
        let hook = server.join(".git/hooks/post-checkout");
        std::fs::write(&hook, "#!/bin/sh\ncase \"$(pwd)\" in */web) exit 1;; esac\n").unwrap();
        sh(&server, "chmod +x .git/hooks/post-checkout");
        assert_eq!(create(&home, &p, "dev").unwrap_err().code, "git");
        assert!(git(&server, &["branch", "--list", "ddak/*"]).unwrap().is_empty(), "브랜치가 남음");
        let list = git(&server, &["worktree", "list"]).unwrap();
        assert!(!list.contains("dev-1"), "{list}");
        // 남은 것이 없으니 다시 하면 같은 이름으로 된다
        std::fs::remove_file(&hook).unwrap();
        assert_eq!(create(&home, &p, "dev").unwrap().name, "dev-1");
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    // 리뷰 지적 3·4: 이름을 정할 때 실제로 만들 브랜치를 모두 검사하고, 항목 이름에서 만든 브랜치가 겹치지 않는다
    #[test]
    fn derived_branches_are_checked_and_unique() {
        let tmp = std::env::temp_dir().join(format!("ddak-wt-derived-{}", std::process::id()));
        let proj = shared_repo_project(&tmp, &["web", "z.lock", "리뷰", "한글"]);
        let server = proj.join("server");
        sh(&server, "git branch ddak/dev-1-web");
        let home = tmp.join("home");
        let made = create(&home, &proj.to_string_lossy(), "dev").unwrap();
        assert_eq!(made.name, "dev-2", "ddak/dev-1-web이 이미 있어서 dev-1은 건너뛴다");
        let dest = PathBuf::from(&made.path);
        let mut branches: Vec<String> = ["server", "web", "z.lock", "리뷰", "한글"]
            .iter()
            .map(|d| git(&dest.join(d), &["branch", "--show-current"]).unwrap())
            .collect();
        assert!(branches.iter().all(|b| b.starts_with("ddak/dev-2")), "{branches:?}");
        branches.sort();
        branches.dedup();
        assert_eq!(branches.len(), 5, "{branches:?}");
        std::fs::remove_dir_all(&tmp).unwrap();
    }
}
