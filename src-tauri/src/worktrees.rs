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

// ~/.ddak. DDAK_HOME이 있으면 그 폴더 (자체 테스트가 사용자 폴더를 건드리지 않게).
fn ddak_home() -> Result<PathBuf, CodeError> {
    if let Some(dir) = std::env::var_os("DDAK_HOME") {
        return Ok(PathBuf::from(dir));
    }
    if std::env::var_os("DDAK_SELFTEST").is_some() {
        return Err(code_err("io", "자체 테스트에는 DDAK_HOME이 필요하다"));
    }
    let home = std::env::var_os("HOME").ok_or_else(|| code_err("io", "HOME 없음"))?;
    Ok(PathBuf::from(home).join(".ddak"))
}

// 이름이 같은 프로젝트가 둘 있어도 섞이지 않게 경로 해시를 붙인다 (FNV-1a, 실행마다 같은 값).
fn project_slug(root: &Path) -> String {
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
    Command::new("git")
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
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

struct Repo {
    // 그룹 폴더 안의 이름 (프로젝트 자체가 저장소면 None = 그룹 폴더 자체)
    name: Option<String>,
    path: PathBuf,
}

#[derive(Debug, serde::Serialize)]
pub struct Created {
    name: String,
    path: String,
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
    let root = std::fs::canonicalize(project).map_err(|e| code_err("io", e))?;
    let base = home.join("worktrees").join(project_slug(&root));

    // 저장소와 그 밖의 항목
    let mut repos = Vec::new();
    let mut others = Vec::new();
    if git_kind(&root).is_some() {
        repos.push(Repo { name: None, path: root.clone() });
    } else {
        let mut entries: Vec<_> = std::fs::read_dir(&root).map_err(|e| code_err("io", e))?.filter_map(|e| e.ok()).collect();
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
    }
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
        if let Err(e) = std::os::unix::fs::symlink(root.join(other), dest.join(other)) {
            undo.run();
            return Err(code_err("io", format!("{other}: {e}")));
        }
    }
    Ok(Created { name, path: dest.to_string_lossy().into_owned() })
}

// git 명령이 몇 초 걸릴 수 있어 별도 스레드에서 돈다.
#[tauri::command]
pub async fn group_create(project: String, prefix: String) -> Result<Created, CodeError> {
    let home = ddak_home()?;
    tauri::async_runtime::spawn_blocking(move || create(&home, &project, &prefix)).await.map_err(|e| code_err("io", e))?
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
