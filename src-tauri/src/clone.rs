// 커밋 안 된 폴더(node_modules, 빌드 캐시 등)를 새 작업그룹으로 복제한다 (docs/spec.md "작업그룹 준비").
//
// 파일마다 clonefile(2)로 복제해서 (APFS 쓰기 시 복사: 내용이 바뀌기 전까지 공간을 같이 쓴다) 임시 폴더에 만든 뒤,
// 다 되면 renamex_np(RENAME_EXCL)로 한 번에 제자리로 옮긴다. 중간에 실패하거나 끊겨도 반쯤 만든 폴더가 제자리에
// 보이지 않는다.
// - 디렉터리를 통째로 clonefile하지 않는다: man 페이지가 강하게 권하지 않고, Worktrunk가 셸이 멈춰 되돌렸다.
// - 파일의 수정 시각·권한은 clonefile이 그대로 둔다 (빌드 캐시가 다시 빌드하지 않게). 폴더는 안을 다 채운 뒤
//   수정 시각과 권한을 되돌린다 (리뷰 P2: 0555 폴더가 0755로, 수정 시각도 바뀌었다).
// - 임시 폴더는 ddak 폴더(작업그룹 폴더들이 든 곳)에 실행마다 고유한 이름으로 만든다. 저장소 안에 두면 같은 이름의
//   사용자 폴더를 지울 수 있었다 (리뷰 P1). 끊긴 실행의 임시 폴더는 그 프로세스가 끝난 것만 지운다.
// - 소켓·FIFO·장치는 건너뛰고 알린다. 링크는 상대 링크만 그대로 만든다 (npm workspaces의 ../../packages/x는
//   새 작업그룹에서도 그 작업그룹의 폴더를 가리킨다). 운영체제가 따라간 실제 위치가 원본에서는 원본 저장소 안,
//   새 작업그룹에서는 그 worktree 안이어야 한다. 글자로 계산하지 않는다: 링크 뒤의 ..는 그 링크를 따라간 뒤에
//   처리되고, 새 worktree의 링크는 원본과 다를 수 있다 (리뷰 P2·후속 P2: ../bridge/../secret 등으로 밖의 파일을
//   고칠 수 있었다). 새 작업그룹 쪽은 옮기기 전에 확인한다: 링크가 놓일 자리에서 운영체제처럼 한 단계씩 따라가되
//   아직 옮기지 않은 복제 폴더 부분은 임시 폴더에서 읽는다 (resolve_at). 제자리에 나타나는 것은 늘 확인을 마친
//   것이라, 중간에 끊겨도 확인 안 된 폴더가 제자리에 남지 않는다 (리뷰 후속 P2: 옮긴 뒤 확인하다 끊기면 남았고,
//   다시 하면 "있음"으로 넘어갔다). 절대 경로 링크, 밖을 가리키는 링크, 가리키는 것이 없는 링크는 빼고 알린다.
// - 다른 볼륨이라 clonefile이 안 되면 실제 복사로 대신하지 않고 실패한다 (몇 GB를 조용히 복사하지 않게).

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};

// sys/clonefile.h: 원본이 링크면 따라가지 않는다
const CLONE_NOFOLLOW: u32 = 0x0001;
// 임시 폴더 이름: .ddak-clone-<도우미 PID>-<번호>
const TEMP_PREFIX: &str = ".ddak-clone-";

#[derive(Debug, Default, PartialEq)]
pub struct Report {
    pub files: usize,
    // 건너뛴 것: (복제할 폴더 기준 경로, 이유 "special" | "link")
    pub skipped: Vec<(PathBuf, &'static str)>,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Cloned(Report),
    // 이미 있어서 그대로 둠 (다시 준비 등)
    Exists,
}

// 복제 하나. src를 dst로. 링크는 src_bound(원본 저장소) 안이고, 새 작업그룹에서는 dst_bound(그 worktree) 안이어야 한다.
// temp_root: 임시 폴더를 만들 ddak 폴더 (dst와 같은 볼륨, ddak만 쓰는 곳).
pub struct Job<'a> {
    pub src: &'a Path,
    pub dst: &'a Path,
    pub src_bound: &'a Path,
    pub dst_bound: &'a Path,
    pub temp_root: &'a Path,
}

fn cstr(p: &Path) -> std::io::Result<CString> {
    Ok(CString::new(p.as_os_str().as_bytes())?)
}

// 지울 수 있게 안쪽까지 주인 권한을 준 뒤 지운다 (권한을 되돌린 0555 폴더가 들어 있을 수 있다)
fn remove_tree(dir: &Path) {
    fn unlock(dir: &Path) {
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                if e.file_type().is_ok_and(|t| t.is_dir()) {
                    unlock(&e.path());
                }
            }
        }
    }
    unlock(dir);
    let _ = std::fs::remove_dir_all(dir);
}

// 끊긴 이전 실행이 남긴 임시 폴더 중 그 도우미가 이미 끝난 것만 지운다 (돌고 있는 다른 작업그룹의 복제는 둔다).
// temp_root는 ddak만 쓰는 폴더라 이 이름은 우리 것이다.
pub fn clean_stale(temp_root: &Path) {
    let Ok(entries) = std::fs::read_dir(temp_root) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(pid) = name.strip_prefix(TEMP_PREFIX).and_then(|r| r.split('-').next()).and_then(|p| p.parse::<i32>().ok()) else {
            continue;
        };
        let alive = unsafe { libc::kill(pid, 0) } == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        if !alive {
            remove_tree(&e.path());
        }
    }
}

// 이 실행만의 임시 폴더 (이미 있으면 다음 번호)
fn make_temp(temp_root: &Path) -> Result<PathBuf, String> {
    for k in 0.. {
        let dir = temp_root.join(format!("{TEMP_PREFIX}{}-{k}", std::process::id()));
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("{}: {e}", dir.display())),
        }
    }
    unreachable!()
}

// 테스트에서만: 제자리로 옮긴 직후 끊긴 것처럼 거기서 돌아온다 (그때 남는 상태를 보기 위해)
#[cfg(test)]
thread_local! {
    static STOP_AFTER_PUBLISH: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub fn clone_tree(job: &Job) -> Result<Outcome, String> {
    if job.dst.symlink_metadata().is_ok() {
        return Ok(Outcome::Exists);
    }
    let canon = |p: &Path| std::fs::canonicalize(p).map_err(|e| format!("{}: {e}", p.display()));
    let parent = job.dst.parent().ok_or("no parent folder")?;
    let bounds = Bounds {
        src: canon(job.src_bound)?,
        dst: canon(job.dst_bound)?,
        // 따라간 경로와 비교하려면 제자리도 실제 경로로 (예: /var → /private/var)
        place: canon(parent)?.join(job.dst.file_name().ok_or("no folder name")?),
    };
    let tmp = make_temp(job.temp_root)?;
    let mut made = Made::default();
    let result = canon(&tmp).and_then(|real_tmp| {
        walk(job, &bounds, job.src, &tmp, &mut made)?;
        prepare(job, &bounds, &tmp, &real_tmp, &mut made)?;
        let (from, to) = (cstr(&tmp).map_err(|e| e.to_string())?, cstr(job.dst).map_err(|e| e.to_string())?);
        if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } != 0 {
            let e = std::io::Error::last_os_error();
            return Err(if e.kind() == std::io::ErrorKind::AlreadyExists { "exists".into() } else { format!("{}: {e}", job.dst.display()) });
        }
        Ok(())
    });
    match result {
        Ok(()) => {}
        // 옮기기 직전에 다른 쪽이 만들었으면 그것을 둔다
        Err(e) if e == "exists" => {
            remove_tree(&tmp);
            return Ok(Outcome::Exists);
        }
        Err(e) => {
            remove_tree(&tmp);
            return Err(e);
        }
    }
    #[cfg(test)]
    if STOP_AFTER_PUBLISH.with(|s| s.get()) {
        return Ok(Outcome::Cloned(made.report));
    }
    // 맨 위 폴더의 권한만 옮긴 뒤에 (쓰기 권한이 없는 폴더는 다른 폴더로 옮길 수 없다. 2026-10-24 실험).
    // 여기서 끊기면 맨 위 폴더에 주인 쓰기 권한이 더 있을 뿐이다.
    set_mode(job.src, job.dst)?;
    Ok(Outcome::Cloned(made.report))
}

// 실제 경로들: 원본 저장소, 새 worktree, 복제가 놓일 자리
struct Bounds {
    src: PathBuf,
    dst: PathBuf,
    place: PathBuf,
}

// 만든 것 (복제할 폴더 기준 경로). dirs는 안쪽부터 (맨 위 ""가 마지막).
#[derive(Default)]
struct Made {
    report: Report,
    links: Vec<PathBuf>,
    dirs: Vec<PathBuf>,
}

// 옮기기 전 마무리 (임시 폴더에서): 새 worktree에서 밖을 가리킬 링크를 지우고, 폴더의 수정 시각과 권한을 원본대로
// 되돌린다. 링크를 지우면 폴더의 수정 시각이 바뀌고 0555 폴더에서는 지울 수 없어서 순서가 이렇다.
// 맨 위 폴더는 시각만 (옮겨도 그대로다), 권한은 옮긴 뒤에.
fn prepare(job: &Job, bounds: &Bounds, tmp: &Path, real_tmp: &Path, made: &mut Made) -> Result<(), String> {
    for rel in &made.links {
        let inside = resolve_at(&bounds.place.join(rel), &bounds.place, real_tmp).is_some_and(|real| real.starts_with(&bounds.dst));
        if !inside {
            let at = tmp.join(rel);
            std::fs::remove_file(&at).map_err(|e| format!("{}: {e}", at.display()))?;
            made.report.skipped.push((rel.clone(), "link"));
        }
    }
    for rel in &made.dirs {
        set_times(&job.src.join(rel), &tmp.join(rel))?;
        if !rel.as_os_str().is_empty() {
            set_mode(&job.src.join(rel), &tmp.join(rel))?;
        }
    }
    Ok(())
}

// path를 운영체제처럼 한 단계씩 따라간 실제 경로 (중간 링크를 따라간 뒤 ..를 처리한다). place 안은 아직 없으니
// real_tmp의 같은 자리에서 읽는다. 없는 것을 가리키거나 링크가 너무 많이 이어지면 (ELOOP와 같은 40) None.
fn resolve_at(path: &Path, place: &Path, real_tmp: &Path) -> Option<PathBuf> {
    use std::collections::VecDeque;
    let mut pending: VecDeque<PathBuf> = path.components().map(|c| PathBuf::from(c.as_os_str())).collect();
    let mut cur = PathBuf::from("/");
    let mut links = 0;
    while let Some(part) = pending.pop_front() {
        match Path::new(&part).components().next()? {
            Component::RootDir => cur = PathBuf::from("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                cur.pop();
            }
            Component::Normal(name) => {
                let next = cur.join(name);
                let on_disk = match next.strip_prefix(place) {
                    Ok(rest) => real_tmp.join(rest),
                    Err(_) => next.clone(),
                };
                let meta = on_disk.symlink_metadata().ok()?;
                if meta.file_type().is_symlink() {
                    links += 1;
                    if links > 40 {
                        return None;
                    }
                    let target = std::fs::read_link(&on_disk).ok()?;
                    // 링크 자리(cur) 기준으로 이어서 따라간다. 절대 경로면 맨 위부터
                    for c in target.components().rev() {
                        pending.push_front(PathBuf::from(c.as_os_str()));
                    }
                } else {
                    cur = next;
                }
            }
            Component::Prefix(_) => return None,
        }
    }
    Some(cur)
}

fn set_times(src: &Path, dir: &Path) -> Result<(), String> {
    let meta = src.symlink_metadata().map_err(|e| format!("{}: {e}", src.display()))?;
    let times = std::fs::FileTimes::new().set_modified(meta.modified().map_err(|e| e.to_string())?).set_accessed(meta.accessed().map_err(|e| e.to_string())?);
    std::fs::File::open(dir).and_then(|f| f.set_times(times)).map_err(|e| format!("{}: {e}", dir.display()))
}

fn set_mode(src: &Path, dir: &Path) -> Result<(), String> {
    let mode = src.symlink_metadata().map_err(|e| format!("{}: {e}", src.display()))?.permissions().mode();
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode)).map_err(|e| format!("{}: {e}", dir.display()))
}

// from(원본)의 안쪽을 to(임시 폴더)에 만든다. 폴더의 수정 시각·권한은 prepare가 되돌린다.
fn walk(job: &Job, bounds: &Bounds, from: &Path, to: &Path, made: &mut Made) -> Result<(), String> {
    let entries = std::fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("{}: {e}", from.display()))?;
        let (s, t) = (entry.path(), to.join(entry.file_name()));
        let rel = s.strip_prefix(job.src).unwrap_or(&s).to_path_buf();
        let kind = entry.file_type().map_err(|e| format!("{}: {e}", s.display()))?;
        if kind.is_dir() {
            std::fs::create_dir(&t).map_err(|e| format!("{}: {e}", t.display()))?;
            walk(job, bounds, &s, &t, made)?;
        } else if kind.is_file() {
            let (a, b) = (cstr(&s).map_err(|e| e.to_string())?, cstr(&t).map_err(|e| e.to_string())?);
            if unsafe { libc::clonefile(a.as_ptr(), b.as_ptr(), CLONE_NOFOLLOW) } != 0 {
                let e = std::io::Error::last_os_error();
                return Err(match e.raw_os_error() {
                    // 다른 볼륨이거나 복제를 지원하지 않는 파일 시스템
                    Some(libc::EXDEV) | Some(libc::ENOTSUP) => format!("{}: cannot clone across volumes ({e})", s.display()),
                    _ => format!("{}: {e}", s.display()),
                });
            }
            made.report.files += 1;
        } else if kind.is_symlink() {
            // 원본 쪽: 운영체제가 이 링크를 따라간 실제 위치가 원본 저장소 안 (새 작업그룹 쪽은 prepare)
            let target = std::fs::read_link(&s).map_err(|e| format!("{}: {e}", s.display()))?;
            if target.is_relative() && std::fs::canonicalize(&s).is_ok_and(|real| real.starts_with(&bounds.src)) {
                std::os::unix::fs::symlink(&target, &t).map_err(|e| format!("{}: {e}", t.display()))?;
                made.links.push(rel);
            } else {
                made.report.skipped.push((rel, "link"));
            }
        } else {
            made.report.skipped.push((rel, "special"));
        }
    }
    made.dirs.push(from.strip_prefix(job.src).unwrap_or(from).to_path_buf());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ddak-clone-{name}-{}", std::process::id()));
        if dir.exists() {
            remove_tree(&dir);
        }
        std::fs::create_dir_all(&dir).unwrap();
        // 링크 범위 비교가 /var ↔ /private/var로 갈리지 않게 실제 경로로
        std::fs::canonicalize(&dir).unwrap()
    }

    // base 아래: repo(원본 저장소), group/repo(새 worktree), ddak(임시 폴더를 둘 ddak 폴더)
    struct Fixture {
        base: PathBuf,
        repo: PathBuf,
        group: PathBuf,
        ddak: PathBuf,
    }
    impl Fixture {
        fn new(name: &str) -> Self {
            let base = temp(name);
            let (repo, group, ddak) = (base.join("repo"), base.join("group/repo"), base.join("ddak"));
            for d in [&repo, &group, &ddak] {
                std::fs::create_dir_all(d).unwrap();
            }
            Fixture { base, repo, group, ddak }
        }
        fn clone(&self, rel: &str) -> Result<Outcome, String> {
            let (src, dst) = (self.repo.join(rel), self.group.join(rel));
            clone_tree(&Job { src: &src, dst: &dst, src_bound: &self.repo, dst_bound: &self.group, temp_root: &self.ddak })
        }
        fn cloned(&self, rel: &str) -> Report {
            match self.clone(rel).unwrap() {
                Outcome::Cloned(mut r) => {
                    r.skipped.sort();
                    r
                }
                Outcome::Exists => panic!("복제 안 됨"),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            remove_tree(&self.base);
        }
    }

    const OLD: u64 = 1_000_000_000;
    fn old() -> std::time::SystemTime {
        std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(OLD)
    }

    #[test]
    fn clones_files_links_and_skips() {
        let f = Fixture::new("tree");
        let src = f.repo.join("node_modules");
        std::fs::create_dir_all(src.join("pkg/bin")).unwrap();
        std::fs::create_dir_all(f.repo.join("packages/local")).unwrap();
        std::fs::create_dir_all(f.group.join("packages/local")).unwrap(); // 커밋된 폴더라 worktree에도 있다
        std::fs::write(src.join("pkg/index.js"), "x").unwrap();
        std::fs::write(src.join("pkg/bin/run"), "#!/bin/sh").unwrap();
        std::fs::set_permissions(src.join("pkg/bin/run"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::File::options().write(true).open(src.join("pkg/index.js")).unwrap().set_modified(old()).unwrap();
        std::os::unix::fs::symlink("../bin/run", src.join("pkg/bin/alias")).unwrap(); // 안쪽 상대 링크
        std::os::unix::fs::symlink("../packages/local", src.join("local")).unwrap(); // 저장소 안 (workspaces)
        std::os::unix::fs::symlink("../../outside", src.join("out")).unwrap(); // 저장소 밖
        std::os::unix::fs::symlink(src.join("pkg"), src.join("abs")).unwrap(); // 절대 경로
        std::os::unix::fs::symlink("../missing", src.join("dangling")).unwrap(); // 가리키는 것이 없음
        let fifo = cstr(&src.join("pipe")).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o644) }, 0);

        let report = f.cloned("node_modules");
        let dst = f.group.join("node_modules");
        assert_eq!(report.files, 2);
        let skipped: Vec<_> = report.skipped.iter().map(|(p, w)| (p.to_string_lossy().into_owned(), *w)).collect();
        assert_eq!(skipped, [("abs", "link"), ("dangling", "link"), ("out", "link"), ("pipe", "special")].map(|(p, w)| (p.to_string(), w)));
        assert_eq!(std::fs::read_to_string(dst.join("pkg/index.js")).unwrap(), "x");
        assert_eq!(std::fs::metadata(dst.join("pkg/index.js")).unwrap().modified().unwrap(), old());
        assert_eq!(std::fs::metadata(dst.join("pkg/bin/run")).unwrap().mode() & 0o777, 0o755);
        assert_eq!(std::fs::read_link(dst.join("pkg/bin/alias")).unwrap(), PathBuf::from("../bin/run"));
        assert_eq!(std::fs::read_link(dst.join("local")).unwrap(), PathBuf::from("../packages/local"));
        // 복제본을 고쳐도 원본은 그대로
        std::fs::write(dst.join("pkg/index.js"), "changed").unwrap();
        assert_eq!(std::fs::read_to_string(src.join("pkg/index.js")).unwrap(), "x");
        // 임시 폴더가 남지 않음
        assert_eq!(std::fs::read_dir(&f.ddak).unwrap().count(), 0);
        // 다시 하면 있는 것은 그대로 둔다
        assert_eq!(f.clone("node_modules").unwrap(), Outcome::Exists);
        assert_eq!(std::fs::read_to_string(dst.join("pkg/index.js")).unwrap(), "changed");
    }

    // 중간 링크를 따라가면 저장소 밖인 링크는 뺀다 (리뷰 P2). 원본에서 밖인 경우와, 새 worktree에서만 밖인 경우.
    #[test]
    fn links_through_outside_links_are_left_out() {
        let f = Fixture::new("chain");
        let outside = f.base.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret"), "keep").unwrap();
        let src = f.repo.join("node_modules");
        std::fs::create_dir_all(&src).unwrap();
        // 원본: bridge가 밖을 가리키는 링크
        std::os::unix::fs::symlink("../outside", f.repo.join("bridge")).unwrap();
        std::os::unix::fs::symlink("../bridge", src.join("escape")).unwrap();
        // 원본에서는 안쪽 폴더지만 새 worktree에서는 밖을 가리키는 링크
        std::fs::create_dir_all(f.repo.join("shared")).unwrap();
        std::os::unix::fs::symlink("../../outside", f.group.join("shared")).unwrap();
        std::os::unix::fs::symlink("../shared", src.join("via-group")).unwrap();
        let report = f.cloned("node_modules");
        let skipped: Vec<_> = report.skipped.iter().map(|(p, _)| p.to_string_lossy().into_owned()).collect();
        assert_eq!(skipped, ["escape", "via-group"]);
        assert!(f.group.join("node_modules/escape").symlink_metadata().is_err());
    }

    // 링크 뒤의 ..는 그 링크를 따라간 뒤에 처리된다 (리뷰 후속 P2). 글자로 ..를 먼저 지우면 안쪽으로 보인다.
    // - 원본에서 bridge가 밖/sub를 가리키면 ../bridge/../secret은 밖/secret이다.
    // - 원본에서는 안쪽이어도, 새 worktree의 bridge가 밖을 가리키면 (복제 폴더 안처럼 보이는 경로라도) 밖이다.
    #[test]
    fn dotdot_after_link_follows_the_link() {
        let f = Fixture::new("dotdot");
        let outside = f.base.join("outside");
        std::fs::create_dir_all(outside.join("sub")).unwrap();
        std::fs::create_dir_all(outside.join("node_modules/x")).unwrap();
        std::fs::write(outside.join("secret"), "keep").unwrap();
        let src = f.repo.join("node_modules");
        std::fs::create_dir_all(src.join("x")).unwrap();
        std::fs::write(f.repo.join("secret"), "inside").unwrap();
        // 커밋된 링크·파일이라 새 worktree에도 같은 것이 있다
        std::os::unix::fs::symlink("../outside/sub", f.repo.join("bridge")).unwrap();
        std::os::unix::fs::symlink("../../outside/sub", f.group.join("bridge")).unwrap();
        std::fs::write(f.group.join("secret"), "inside").unwrap();
        std::os::unix::fs::symlink("../bridge/../secret", src.join("escape")).unwrap();
        // 원본: inner는 안쪽 폴더, 새 worktree: inner가 밖/sub를 가리킨다
        std::fs::create_dir_all(f.repo.join("inner")).unwrap();
        std::os::unix::fs::symlink("../../outside/sub", f.group.join("inner")).unwrap();
        std::os::unix::fs::symlink("../inner/../node_modules/x", src.join("via-group")).unwrap();
        // 쓰기 권한 없는 폴더 안의 링크도 지우고, 그 폴더의 권한은 되돌린다
        std::fs::create_dir_all(src.join("ro")).unwrap();
        std::os::unix::fs::symlink("../../bridge/../secret", src.join("ro/escape")).unwrap();
        std::fs::set_permissions(src.join("ro"), std::fs::Permissions::from_mode(0o555)).unwrap();
        let report = f.cloned("node_modules");
        let skipped: Vec<_> = report.skipped.iter().map(|(p, _)| p.to_string_lossy().into_owned()).collect();
        assert_eq!(skipped, ["escape", "ro/escape", "via-group"]);
        for name in ["escape", "ro/escape", "via-group"] {
            assert!(f.group.join("node_modules").join(name).symlink_metadata().is_err(), "{name}");
        }
        assert_eq!(std::fs::metadata(f.group.join("node_modules/ro")).unwrap().mode() & 0o777, 0o555);
        assert_eq!(std::fs::read_to_string(outside.join("secret")).unwrap(), "keep");
    }

    // 끊겨도 확인 안 된 폴더가 제자리에 남지 않는다 (리뷰 후속 P2): 옮긴 직후 끊긴 것처럼 멈추면 그 자리에는
    // 밖을 가리키는 링크가 없어야 한다. 다시 하면 "있음"으로 두는데 그래도 안전해야 한다.
    #[test]
    fn interrupted_after_publish_leaves_only_checked_links() {
        let f = Fixture::new("interrupt");
        let outside = f.base.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let src = f.repo.join("node_modules");
        std::fs::create_dir_all(src.join("ok")).unwrap();
        // 원본의 bridge는 안쪽 폴더, 새 worktree의 bridge는 밖을 가리킨다 (원본 쪽 확인은 통과하는 링크)
        std::fs::create_dir_all(f.repo.join("bridge")).unwrap();
        std::os::unix::fs::symlink("../../outside", f.group.join("bridge")).unwrap();
        std::os::unix::fs::symlink("../bridge", src.join("escape")).unwrap();
        std::os::unix::fs::symlink("ok", src.join("fine")).unwrap();
        STOP_AFTER_PUBLISH.with(|s| s.set(true));
        let r = f.clone("node_modules");
        STOP_AFTER_PUBLISH.with(|s| s.set(false));
        assert!(r.is_ok(), "{r:?}");
        let dst = f.group.join("node_modules");
        assert!(dst.join("escape").symlink_metadata().is_err(), "확인 안 된 링크가 제자리에 남음");
        assert!(dst.join("fine").symlink_metadata().is_ok());
        assert_eq!(f.clone("node_modules").unwrap(), Outcome::Exists);
    }

    // resolve_at은 운영체제와 같게 따라간다: 실제로 있는 경로에서 canonicalize(realpath)와 같은 결과
    #[test]
    fn resolve_at_matches_realpath() {
        let f = Fixture::new("resolve");
        let b = &f.base;
        std::fs::create_dir_all(b.join("a/sub/deep")).unwrap();
        std::fs::create_dir_all(b.join("c")).unwrap();
        std::fs::write(b.join("a/file"), "").unwrap();
        std::fs::write(b.join("c/file"), "").unwrap();
        std::os::unix::fs::symlink("a/sub", b.join("l1")).unwrap(); // 상대
        std::os::unix::fs::symlink(b.join("c"), b.join("l2")).unwrap(); // 절대
        std::os::unix::fs::symlink("../l1/deep", b.join("c/l3")).unwrap(); // 링크를 거치는 링크
        std::os::unix::fs::symlink("nowhere", b.join("l4")).unwrap(); // 가리키는 것이 없음
        let none = Path::new("/no/such/place");
        for p in ["l1/../file", "l2/file", "l2/l3/../..", "c/l3", "l1/deep/../../file", "a/./sub/../file", "l4"] {
            let path = b.join(p);
            assert_eq!(resolve_at(&path, none, none), std::fs::canonicalize(&path).ok(), "{p}");
        }
        // 맨 위에서 ..는 맨 위 (realpath와 같음)
        assert_eq!(resolve_at(Path::new("/../tmp/.."), none, none), std::fs::canonicalize("/../tmp/..").ok());
    }

    // 폴더의 권한·수정 시각도 원본대로 (리뷰 P2). 맨 위 폴더와 안쪽 폴더 모두.
    #[test]
    fn keeps_directory_mode_and_times() {
        let f = Fixture::new("dirs");
        let src = f.repo.join("node_modules");
        std::fs::create_dir_all(src.join("ro/inner")).unwrap();
        std::fs::write(src.join("ro/inner/f"), "f").unwrap();
        for (dir, mode) in [(src.join("ro/inner"), 0o750), (src.join("ro"), 0o555), (src.clone(), 0o555)] {
            std::fs::File::open(&dir).unwrap().set_times(std::fs::FileTimes::new().set_modified(old())).unwrap();
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        f.cloned("node_modules");
        let dst = f.group.join("node_modules");
        for (dir, mode) in [(dst.join("ro/inner"), 0o750), (dst.join("ro"), 0o555), (dst.clone(), 0o555)] {
            let m = std::fs::metadata(&dir).unwrap();
            assert_eq!((m.mode() & 0o777, m.mtime() as u64), (mode, OLD), "{}", dir.display());
        }
        for d in [src.clone(), src.join("ro"), dst.clone(), dst.join("ro")] {
            std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    // 임시 폴더는 ddak 폴더에 실행마다 따로 만든다. 저장소 안의 같은 이름(예전 임시 이름) 폴더는 건드리지 않는다
    // (리뷰 P1). 끊긴 실행의 임시 폴더는 그 도우미가 끝났을 때만 지운다.
    #[test]
    fn temp_folders_are_owned() {
        let f = Fixture::new("owned");
        std::fs::create_dir_all(f.repo.join("node_modules/x")).unwrap();
        std::fs::create_dir_all(f.group.join(".node_modules.ddak-clone")).unwrap();
        std::fs::write(f.group.join(".node_modules.ddak-clone/valuable.txt"), "USER DATA").unwrap();
        let mut gone = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let dead = gone.id();
        gone.wait().unwrap();
        let stale = f.ddak.join(format!("{TEMP_PREFIX}{dead}-0"));
        std::fs::create_dir_all(stale.join("ro")).unwrap();
        std::fs::set_permissions(stale.join("ro"), std::fs::Permissions::from_mode(0o555)).unwrap();
        let running = f.ddak.join(format!("{TEMP_PREFIX}{}-7", std::process::id()));
        std::fs::create_dir_all(&running).unwrap();
        clean_stale(&f.ddak);
        f.cloned("node_modules");
        assert_eq!(std::fs::read_to_string(f.group.join(".node_modules.ddak-clone/valuable.txt")).unwrap(), "USER DATA");
        assert!(!stale.exists(), "끝난 실행의 임시 폴더가 남음");
        assert!(running.exists(), "돌고 있는 실행의 임시 폴더를 지움");
    }

    // 실패하면 제자리에도 ddak 폴더에도 아무것도 남기지 않는다.
    #[test]
    fn failure_leaves_nothing() {
        let f = Fixture::new("fail");
        let src = f.repo.join("locked");
        std::fs::create_dir_all(src.join("no")).unwrap();
        std::fs::set_permissions(src.join("no"), std::fs::Permissions::from_mode(0o000)).unwrap();
        let r = f.clone("locked");
        std::fs::set_permissions(src.join("no"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(r.is_err(), "{r:?}");
        assert!(!f.group.join("locked").exists());
        assert_eq!(std::fs::read_dir(&f.ddak).unwrap().count(), 0);
    }
}
