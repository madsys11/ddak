// Git Graph 탭 (docs/spec.md "git graph"): 저장소의 커밋 그래프와 참조, worktree(작업그룹)를 읽는다. 읽기 전용.
// git 명령으로 읽고 (worktrees.rs와 같은 git), 레인은 여기서 계산한다. 그리는 것은 프론트 (src/GitGraph.tsx).

use crate::fs::{code_err, CodeError};
use crate::worktrees::git;
use std::path::Path;

// git 출력은 NUL로 나눠 읽고 (커밋 메시지·파일 이름에는 NUL 말고 무엇이든 들어갈 수 있다), 읽은 SHA·시각은 형식을 확인한다.
// git에 다시 넘기는 SHA는 16진수만 받고 `--end-of-options` 뒤에 둔다 (리뷰 P1: 커밋 제목의 구분 문자로 만든 가짜 행의
// "SHA"가 git 옵션으로 해석되어 파일을 덮어썼다).

// 커밋 SHA (SHA-1 40자, SHA-256 64자, 소문자 16진수)
fn is_sha(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// git을 돌려 출력을 그대로 (자르지 않고) 돌려준다. input이 있으면 표준 입력으로 준다.
fn raw(repo: &Path, args: &[&str], input: Option<&str>) -> Result<Vec<u8>, CodeError> {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = crate::platform::background("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| code_err("git", e))?;
    if let Some(text) = input {
        let mut stdin = child.stdin.take().unwrap();
        // 출력이 큰 경우 쓰기와 읽기가 서로 기다리지 않게 따로 쓴다
        let text = text.to_string();
        std::thread::spawn(move || stdin.write_all(text.as_bytes()));
    }
    let out = child.wait_with_output().map_err(|e| code_err("git", e))?;
    if !out.status.success() {
        return Err(code_err("git", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(out.stdout)
}

fn unexpected(what: &str) -> CodeError {
    code_err("git", format!("unexpected git output ({what})"))
}

#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct Repo {
    // 프로젝트 안의 이름 (프로젝트 자체가 저장소면 "")
    name: String,
    path: String,
}

#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct Commit {
    sha: String,
    parents: Vec<String>,
    author: String,
    // 유닉스 시간 (초)
    time: i64,
    subject: String,
    // 이 커밋이 놓이는 레인
    lane: u32,
    // 이 행에서 다음 행으로 이어지는 선 (위 레인, 아래 레인)
    lines: Vec<(u32, u32)>,
}

#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct Ref {
    // 짧은 이름 (main, origin/main, v1.0)
    name: String,
    // "branch" | "remote" | "tag"
    kind: &'static str,
    sha: String,
}

#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct Worktree {
    path: String,
    sha: Option<String>,
    branch: Option<String>,
    // 이 worktree가 들어 있는 곳 (git_graph의 places 중, 실제 경로로 비교). 작업그룹 탭을 찾는다.
    place: Option<usize>,
}

#[derive(serde::Serialize, Debug)]
pub struct Graph {
    commits: Vec<Commit>,
    refs: Vec<Ref>,
    // 이 저장소(원본)의 HEAD
    head: Option<String>,
    worktrees: Vec<Worktree>,
    // limit보다 많아서 잘랐다
    truncated: bool,
    // 쓴 레인 수
    lanes: u32,
}

#[derive(serde::Serialize, Debug)]
pub struct File {
    // A, M, D, R100 등 (git diff-tree --name-status)
    status: String,
    path: String,
}

#[derive(serde::Serialize, Debug)]
pub struct Detail {
    sha: String,
    parents: Vec<String>,
    author: String,
    time: i64,
    message: String,
    // 첫 부모와 비교한 변경 (첫 커밋은 빈 트리와)
    files: Vec<File>,
}

fn run(repo: &Path, args: &[&str]) -> Result<String, CodeError> {
    git(repo, args).map_err(|e| code_err("git", e))
}

// 커밋마다 레인을 정한다 (커밋은 자식이 부모보다 먼저인 순서, git log --topo-order).
// 레인마다 다음에 올 것으로 기다리는 커밋을 둔다. 커밋은 자기를 기다리는 첫 레인(없으면 빈 레인)에 놓이고, 같은 커밋을
// 기다리던 다른 레인은 여기서 합쳐져 끝난다. 그 레인은 첫 부모를 기다리고, 다른 부모는 이미 기다리는 레인이 있으면 그리로,
// 없으면 빈 레인을 새로 쓴다. 레인은 옮기지 않는다 (지나가는 선은 곧게).
fn assign_lanes(commits: &mut [Commit]) -> u32 {
    let mut lanes: Vec<Option<String>> = Vec::new();
    let mut width = 0;
    // 행마다 이 행에서 아래로 내려가는 선: (위쪽 레인, 그 선이 기다리는 커밋, 그 레인)
    let mut down: Vec<Vec<(u32, String, u32)>> = Vec::with_capacity(commits.len());
    for c in commits.iter_mut() {
        let before = lanes.clone();
        let waiting: Vec<usize> = lanes.iter().enumerate().filter(|(_, l)| l.as_deref() == Some(&c.sha)).map(|(i, _)| i).collect();
        let free = |lanes: &mut Vec<Option<String>>| match lanes.iter().position(Option::is_none) {
            Some(i) => i,
            None => {
                lanes.push(None);
                lanes.len() - 1
            }
        };
        let lane = match waiting.first() {
            Some(&i) => i,
            None => free(&mut lanes),
        };
        for &i in &waiting {
            lanes[i] = None;
        }
        // 부모마다 그 부모를 기다리는 레인 (이미 있으면 그리로 합쳐진다)
        let mut to_parents = Vec::new();
        for (k, p) in c.parents.iter().enumerate() {
            let i = match lanes.iter().position(|l| l.as_deref() == Some(p)) {
                Some(i) => i,
                None => {
                    let i = if k == 0 && lanes[lane].is_none() { lane } else { free(&mut lanes) };
                    lanes[i] = Some(p.clone());
                    i
                }
            };
            to_parents.push(i);
        }
        c.lane = lane as u32;
        width = width.max(lanes.len());
        let mut lines = Vec::new();
        for (i, l) in lanes.iter().enumerate() {
            let Some(sha) = l else { continue };
            // 위에서 그대로 지나가는 선 (이 커밋 전에도 같은 것을 기다렸다)
            if before.get(i).and_then(|b| b.as_ref()) == Some(sha) {
                lines.push((i as u32, sha.clone(), i as u32));
            }
            // 이 커밋에서 부모로 가는 선
            if to_parents.contains(&i) {
                lines.push((lane as u32, sha.clone(), i as u32));
            }
        }
        down.push(lines);
    }
    // 선의 아래쪽: 다음 행의 커밋이면 그 커밋의 레인, 아니면 같은 레인
    let lanes_of: Vec<u32> = commits.iter().map(|c| c.lane).collect();
    let shas: Vec<String> = commits.iter().map(|c| c.sha.clone()).collect();
    for (row, c) in commits.iter_mut().enumerate() {
        let next = shas.get(row + 1);
        c.lines = down[row].iter().map(|(from, sha, lane)| (*from, if next == Some(sha) { lanes_of[row + 1] } else { *lane })).collect();
        c.lines.dedup();
    }
    width as u32
}

// 저장소의 그래프. limit: 읽을 커밋 수 (넘으면 자르고 truncated). places: 작업그룹 탭의 폴더들. worktree마다 그것이 들어 있는
// 곳(가장 깊은 것)을 찾는다 (경로 표기가 달라도 맞게 실제 경로로).
fn graph(repo: &Path, limit: usize, places: &[String]) -> Result<Graph, CodeError> {
    let real = |p: &str| crate::platform::canonical(p).unwrap_or_else(|_| Path::new(p).to_path_buf());
    let places: Vec<std::path::PathBuf> = places.iter().map(|p| real(p)).collect();
    let mut worktrees = list_worktrees(repo)?;
    for w in &mut worktrees {
        let path = real(&w.path);
        w.place = places.iter().enumerate().filter(|(_, p)| path.starts_with(p)).max_by_key(|(_, p)| p.components().count()).map(|(i, _)| i);
    }
    // 참조마다 끝까지 벗긴 커밋 (주석 태그가 태그를 가리켜도). 커밋이 아닌 것(트리를 가리키는 태그 등)은 뺀다.
    // 참조 이름에는 공백·제어 문자가 들어갈 수 없어서 줄로 나눈다 (git check-ref-format).
    let names: Vec<String> = run(repo, &["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"])?.lines().map(str::to_string).collect();
    let mut refs = Vec::new();
    if !names.is_empty() {
        let query: String = names.iter().map(|n| format!("{n}^{{commit}}\n")).collect();
        let answer = String::from_utf8_lossy(&raw(repo, &["cat-file", "--batch-check=%(objectname) %(objecttype)"], Some(&query))?).to_string();
        for (name, line) in names.iter().zip(answer.lines()) {
            let Some((sha, "commit")) = line.split_once(' ') else { continue };
            if !is_sha(sha) {
                return Err(unexpected("ref"));
            }
            let (kind, short) = if let Some(n) = name.strip_prefix("refs/heads/") {
                ("branch", n)
            } else if let Some(n) = name.strip_prefix("refs/remotes/") {
                ("remote", n)
            } else if let Some(n) = name.strip_prefix("refs/tags/") {
                ("tag", n)
            } else {
                continue;
            };
            // origin/HEAD는 가리키는 브랜치와 같아서 뺀다
            if kind == "remote" && short.ends_with("/HEAD") {
                continue;
            }
            refs.push(Ref { name: short.to_string(), kind, sha: sha.to_string() });
        }
    }
    let head = git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).ok().filter(|h| is_sha(h));
    // 시작점: 모든 참조와 각 worktree의 HEAD (detached도). 아무것도 없으면 (커밋 없는 저장소) 빈 그래프
    let mut starts: Vec<String> = refs.iter().map(|r| r.sha.clone()).chain(head.clone()).chain(worktrees.iter().filter_map(|w| w.sha.clone())).collect();
    starts.sort();
    starts.dedup();
    let mut commits = Vec::new();
    if !starts.is_empty() {
        let count = format!("--max-count={}", limit + 1);
        // 커밋마다 NUL로 나눈 네 칸: "SHA 부모…", 작성자, 시각, 제목 (-z: 커밋 사이도 NUL)
        let mut args = vec!["log", "-z", "--topo-order", &count, "--format=%H %P%x00%an%x00%at%x00%s", "--end-of-options"];
        args.extend(starts.iter().map(String::as_str));
        args.push("--");
        let out = raw(repo, &args, None)?;
        let mut fields = out.split(|b| *b == 0).map(|f| String::from_utf8_lossy(f).into_owned());
        while let Some(ids) = fields.next() {
            if ids.trim().is_empty() {
                continue;
            }
            let (Some(author), Some(time), Some(subject)) = (fields.next(), fields.next(), fields.next()) else { return Err(unexpected("log")) };
            let mut ids = ids.split_whitespace();
            let sha = ids.next().unwrap_or_default().to_string();
            let parents: Vec<String> = ids.map(str::to_string).collect();
            // 형식이 맞지 않으면 어긋나게 읽지 않고 멈춘다
            if !is_sha(&sha) || !parents.iter().all(|p| is_sha(p)) || time.is_empty() || !time.bytes().all(|b| b.is_ascii_digit()) {
                return Err(unexpected("log"));
            }
            commits.push(Commit { sha, parents, author, time: time.parse().unwrap_or(0), subject, lane: 0, lines: Vec::new() });
        }
    }
    let truncated = commits.len() > limit;
    commits.truncate(limit);
    let lanes = assign_lanes(&mut commits);
    Ok(Graph { commits, refs, head, worktrees, truncated, lanes })
}

// git worktree list --porcelain: 원본과 연결된 worktree들 (작업그룹)
fn list_worktrees(repo: &Path) -> Result<Vec<Worktree>, CodeError> {
    let mut list = Vec::new();
    for block in run(repo, &["worktree", "list", "--porcelain"])?.split("\n\n") {
        let mut w = Worktree { path: String::new(), sha: None, branch: None, place: None };
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                w.path = p.to_string();
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                // 커밋이 없는 저장소는 HEAD가 0으로만 나온다
                w.sha = (is_sha(h) && h.chars().any(|c| c != '0')).then(|| h.to_string());
            } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
                w.branch = Some(b.to_string());
            }
        }
        if !w.path.is_empty() {
            list.push(w);
        }
    }
    Ok(list)
}

fn detail(repo: &Path, sha: &str) -> Result<Detail, CodeError> {
    if !is_sha(sha) {
        return Err(code_err("git", format!("{sha}: not a commit id")));
    }
    let out = raw(repo, &["show", "-s", "--format=%H %P%x00%an%x00%at%x00%B", "--end-of-options", sha], None)?;
    let mut f = out.splitn(4, |b| *b == 0).map(|x| String::from_utf8_lossy(x).into_owned());
    let (Some(ids), Some(author), Some(time), Some(message)) = (f.next(), f.next(), f.next(), f.next()) else { return Err(unexpected("show")) };
    let mut ids = ids.split_whitespace();
    let full = ids.next().unwrap_or_default().to_string();
    let parents: Vec<String> = ids.map(str::to_string).collect();
    if full != sha || !parents.iter().all(|p| is_sha(p)) || !time.bytes().all(|b| b.is_ascii_digit()) {
        return Err(unexpected("show"));
    }
    // 첫 부모와 비교 (병합이면 들어온 변경을 본다), 첫 커밋은 빈 트리와 (--root). -z: 이름을 따옴표·이스케이프 없이 그대로
    // (리뷰 P2: 한글 이름이 8진수 이스케이프로 나왔다), 칸마다 NUL: 상태, 이름 (이름 바꾸기·복사는 옛 이름, 새 이름)
    let diff = match parents.first() {
        Some(p) => raw(repo, &["diff-tree", "-r", "-z", "--name-status", "-M", "--end-of-options", p, &full], None)?,
        None => raw(repo, &["diff-tree", "-r", "-z", "--name-status", "-M", "--root", "--no-commit-id", "--end-of-options", &full], None)?,
    };
    let mut tokens = diff.split(|b| *b == 0).map(|x| String::from_utf8_lossy(x).into_owned()).filter(|t| !t.is_empty());
    let mut files = Vec::new();
    while let Some(status) = tokens.next() {
        let renamed = status.starts_with('R') || status.starts_with('C');
        let Some(mut path) = tokens.next() else { return Err(unexpected("diff-tree")) };
        if renamed {
            path = tokens.next().ok_or_else(|| unexpected("diff-tree"))?;
        }
        files.push(File { status, path });
    }
    Ok(Detail { sha: full, parents, author, time: time.parse().unwrap_or(0), message: message.trim_end().to_string(), files })
}

// 참조·HEAD·worktree HEAD가 바뀌었는지 보는 값 (프론트가 보이는 동안 주기적으로 비교해 바뀌면 다시 읽는다)
fn fingerprint(repo: &Path) -> Result<String, CodeError> {
    let refs = run(repo, &["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/remotes", "refs/tags"])?;
    let head = git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).unwrap_or_default();
    let worktrees: Vec<String> = list_worktrees(repo)?.into_iter().map(|w| format!("{} {:?} {:?}", w.path, w.sha, w.branch)).collect();
    Ok(format!("{refs}\n{head}\n{}", worktrees.join("\n")))
}

#[tauri::command]
pub fn git_repos(project: String) -> Result<Vec<Repo>, CodeError> {
    let root = crate::platform::canonical(&project).map_err(|e| code_err("io", e))?;
    let (repos, _) = crate::worktrees::project_repos(&root)?;
    Ok(repos.into_iter().map(|r| Repo { name: r.name.unwrap_or_default(), path: r.path.to_string_lossy().into_owned() }).collect())
}

// git이 오래 걸릴 수 있어 별도 스레드에서 돈다
#[tauri::command]
pub async fn git_graph(repo: String, limit: u32, places: Vec<String>) -> Result<Graph, CodeError> {
    tauri::async_runtime::spawn_blocking(move || graph(Path::new(&repo), limit as usize, &places)).await.map_err(|e| code_err("io", e))?
}

#[tauri::command]
pub async fn git_commit(repo: String, sha: String) -> Result<Detail, CodeError> {
    tauri::async_runtime::spawn_blocking(move || detail(Path::new(&repo), &sha)).await.map_err(|e| code_err("io", e))?
}

#[tauri::command]
pub async fn git_fingerprint(repo: String) -> Result<String, CodeError> {
    tauri::async_runtime::spawn_blocking(move || fingerprint(Path::new(&repo))).await.map_err(|e| code_err("io", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(sha: &str, parents: &[&str]) -> Commit {
        Commit { sha: sha.into(), parents: parents.iter().map(|p| p.to_string()).collect(), author: String::new(), time: 0, subject: String::new(), lane: 0, lines: vec![] }
    }

    // 레인: 곧은 줄기, 갈라진 가지, 병합, 같은 부모로 합쳐지는 두 가지. (레인, 이 행에서 다음 행으로 가는 선)
    //   M      병합 (부모 A, B)
    //   |\
    //   A |    A의 부모 R
    //   | B    B의 부모 R
    //   |/
    //   R
    #[test]
    fn lanes_for_merge() {
        let mut commits = vec![c("M", &["A", "B"]), c("A", &["R"]), c("B", &["R"]), c("R", &[])];
        let width = assign_lanes(&mut commits);
        let got: Vec<(u32, Vec<(u32, u32)>)> = commits.iter().map(|c| (c.lane, c.lines.clone())).collect();
        assert_eq!(width, 2);
        assert_eq!(
            got,
            vec![
                (0, vec![(0, 0), (0, 1)]), // M → A(0), B(1)
                (0, vec![(0, 0), (1, 1)]), // A → R(0), B는 지나감
                (1, vec![(0, 0), (1, 0)]), // B: R을 기다리는 0과, B에서 R로 (아래에서 0으로 합쳐짐)
                (0, vec![]),
            ]
        );
    }

    // 두 브랜치 끝 (서로 모르는 두 줄기)와 자를 때 남은 부모: 레인이 따로 있고, 잘린 부모로 가는 선은 아래로 이어진다
    #[test]
    fn lanes_for_two_tips_and_cut_history() {
        let mut commits = vec![c("X", &["P"]), c("Y", &["Q"]), c("P", &["Z"])];
        assign_lanes(&mut commits);
        let got: Vec<(u32, Vec<(u32, u32)>)> = commits.iter().map(|c| (c.lane, c.lines.clone())).collect();
        assert_eq!(got, vec![(0, vec![(0, 0)]), (1, vec![(0, 0), (1, 1)]), (0, vec![(0, 0), (1, 1)])]);
    }

    fn sh(dir: &Path, cmd: &str) {
        let out = std::process::Command::new("sh").arg("-c").arg(cmd).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "{cmd}: {}", String::from_utf8_lossy(&out.stderr));
    }

    // 실제 저장소: 브랜치·태그(주석)·원격 추적·worktree·detached HEAD를 읽고, 커밋 상세의 메시지와 바뀐 파일, 지문 변화
    #[test]
    fn reads_real_repo() {
        let tmp = std::env::temp_dir().join(format!("ddak-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let repo = tmp.join("r");
        std::fs::create_dir_all(&repo).unwrap();
        let commit = |m: &str| format!("git -c user.name=t -c user.email=t@example.com commit -qm '{m}'");
        sh(&repo, "git init -q -b main && echo a > a.txt && git add a.txt");
        sh(&repo, &commit("first"));
        sh(&repo, "git -c user.name=t -c user.email=t@example.com tag -a v1 -m v1 && git checkout -q -b side && echo b > b.txt && git add b.txt");
        sh(&repo, &commit("side work\n\nbody line"));
        sh(&repo, "git checkout -q main && git mv a.txt renamed.txt");
        sh(&repo, &commit("rename"));
        sh(&repo, &format!("git -c user.name=t -c user.email=t@example.com merge -q --no-ff side -m merge && git update-ref refs/remotes/origin/main HEAD~1 && git worktree add -q --detach '{}' side", tmp.join("wt").display()));
        let before = fingerprint(&repo).unwrap();
        // 탭 폴더: 원본(프로젝트), 작업그룹 폴더. 같은 경로를 다른 표기(끝의 /.)로 줘도 맞는다
        let places = vec![tmp.to_string_lossy().into_owned(), format!("{}/.", tmp.join("wt").display())];

        let g = graph(&repo, 100, &places).unwrap();
        let subjects: Vec<&str> = g.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, ["merge", "side work", "rename", "first"], "{subjects:?}");
        let names: Vec<(&str, &str)> = g.refs.iter().map(|r| (r.kind, r.name.as_str())).collect();
        assert!(names.contains(&("branch", "main")) && names.contains(&("branch", "side")) && names.contains(&("remote", "origin/main")) && names.contains(&("tag", "v1")), "{names:?}");
        // 주석 태그는 가리키는 커밋으로
        let v1 = g.refs.iter().find(|r| r.name == "v1").unwrap();
        assert_eq!(v1.sha, g.commits[3].sha);
        assert_eq!(g.head.as_deref(), Some(g.commits[0].sha.as_str()));
        assert_eq!(g.worktrees.len(), 2);
        assert_eq!(g.worktrees[1].branch, None);
        assert_eq!(g.worktrees[1].sha.as_deref(), Some(g.commits[1].sha.as_str()));
        assert_eq!((g.worktrees[0].place, g.worktrees[1].place), (Some(0), Some(1)), "가장 깊은 곳을 찾음");
        assert!(!g.truncated && g.lanes == 2);
        assert!(graph(&repo, 2, &[]).unwrap().truncated);

        let d = detail(&repo, &g.commits[1].sha).unwrap();
        assert_eq!((d.message.as_str(), d.files.len()), ("side work\n\nbody line", 1));
        assert_eq!((d.files[0].status.as_str(), d.files[0].path.as_str()), ("A", "b.txt"));
        let r = detail(&repo, &g.commits[2].sha).unwrap();
        assert!(r.files[0].status.starts_with('R') && r.files[0].path == "renamed.txt", "{:?}", r.files);
        let root = detail(&repo, &g.commits[3].sha).unwrap();
        assert_eq!(root.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["a.txt"]);

        sh(&tmp.join("wt"), &commit("in worktree").replace("commit -qm", "commit -q --allow-empty -m"));
        assert_ne!(fingerprint(&repo).unwrap(), before, "worktree HEAD가 바뀌어도 지문이 같음");
        // 끝이 둘이면 (merge, in worktree) 같은 초의 커밋이라 어느 쪽이 먼저인지는 정해지지 않는다
        assert!(graph(&repo, 100, &places).unwrap().commits.iter().any(|c| c.subject == "in worktree"));

        // 커밋 없는 저장소는 빈 그래프
        let empty = tmp.join("e");
        std::fs::create_dir_all(&empty).unwrap();
        sh(&empty, "git init -q");
        assert!(graph(&empty, 10, &[]).unwrap().commits.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }
    // 리뷰 P1·P2·P3: 커밋 제목의 제어 문자(예전 구분자)로 가짜 행이 생기지 않고, 16진수가 아닌 "SHA"는 git에 넘기지 않는다
    // (파일을 덮어쓰지 않음). 한글·공백·탭이 든 파일 이름은 그대로. 주석 태그가 주석 태그를 가리켜도 커밋까지 벗기고, 트리를
    // 가리키는 태그는 뺀다.
    #[test]
    fn hostile_messages_names_and_nested_tags() {
        let tmp = std::env::temp_dir().join(format!("ddak-git-hostile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let ident = "-c user.name=t -c user.email=t@example.com";
        sh(&tmp, "git init -q -b main && echo keep > README.md && git add README.md");
        sh(&tmp, &format!("git {ident} commit -qm base"));
        let evil = "x\u{1e}--output=README.md\u{1f}\u{1f}a\u{1f}0\u{1f}y\u{1e}";
        std::fs::write(tmp.join("msg"), evil).unwrap();
        std::fs::write(tmp.join("한글 파일.txt"), "a").unwrap();
        std::fs::write(tmp.join("tab\tname.txt"), "b").unwrap();
        sh(&tmp, &format!("git add '한글 파일.txt' 'tab\tname.txt' && git {ident} commit -q -F msg && rm msg"));
        sh(&tmp, &format!("git {ident} tag -a inner -m inner HEAD~1 && git {ident} -c advice.nestedTag=false tag -a outer -m outer inner && git tag treetag 'HEAD^{{tree}}'"));

        let g = graph(&tmp, 100, &[]).unwrap();
        assert_eq!(g.commits.len(), 2, "가짜 행: {:?}", g.commits.iter().map(|c| &c.sha).collect::<Vec<_>>());
        assert_eq!(g.commits[0].subject, evil);
        let base = &g.commits[1].sha;
        let tags: Vec<(&str, &str)> = g.refs.iter().filter(|r| r.kind == "tag").map(|r| (r.name.as_str(), r.sha.as_str())).collect();
        assert_eq!(tags, [("inner", base.as_str()), ("outer", base.as_str())], "중첩 태그·트리 태그");

        assert!(detail(&tmp, "--output=README.md").is_err());
        assert_eq!(std::fs::read_to_string(tmp.join("README.md")).unwrap(), "keep\n", "파일을 덮어씀");
        let d = detail(&tmp, &g.commits[0].sha).unwrap();
        let mut files: Vec<&str> = d.files.iter().map(|f| f.path.as_str()).collect();
        files.sort();
        assert_eq!(files, ["tab\tname.txt", "한글 파일.txt"]);
        assert_eq!(d.message, evil.trim_end());
        let _ = std::fs::remove_dir_all(&tmp);
    }

}
