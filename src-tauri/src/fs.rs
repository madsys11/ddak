use std::path::{Path, PathBuf};

// VS Code의 기본 files.exclude와 같은 항목
const HIDDEN: &[&str] = &[".git", ".DS_Store", ".svn", ".hg", "Thumbs.db"];

// 화면에 보일 수 있는 오류. 코드로 돌려주고 문구는 프론트 사전이 정한다 (src/errors.ts).
#[derive(Debug, serde::Serialize)]
pub struct CodeError {
    pub code: &'static str,
    pub detail: String,
}

pub fn code_err(code: &'static str, detail: impl ToString) -> CodeError {
    CodeError { code, detail: detail.to_string() }
}

// 폴더 바로 아래 새 항목의 경로. 이름에 경로가 섞이면 다른 곳에 만들 수 있으니 막는다.
pub fn child_path(dir: &str, name: &str) -> Result<PathBuf, CodeError> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return Err(code_err("badName", name));
    }
    let path = Path::new(dir).join(name);
    // 깨진 링크도 "있음"으로 본다.
    if path.symlink_metadata().is_ok() {
        return Err(code_err("exists", name));
    }
    Ok(path)
}

// 새 파일·폴더 (파일 트리의 오른쪽 클릭 메뉴)
#[tauri::command]
pub fn fs_create(dir: String, name: String, kind: String) -> Result<String, CodeError> {
    let path = child_path(&dir, &name)?;
    let made = match kind.as_str() {
        "dir" => std::fs::create_dir(&path),
        // create_new: 확인과 생성 사이에 누가 만들었으면 덮어쓰지 않고 실패
        "file" => std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map(|_| ()),
        _ => return Err(code_err("io", format!("kind: {kind}"))),
    };
    made.map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => code_err("exists", name.trim()),
        _ => code_err("io", e),
    })?;
    Ok(path.to_string_lossy().into_owned())
}

#[derive(serde::Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    // 폴더가 git 저장소면 "repo", worktree면 "worktree" (파일 트리 아이콘용)
    git: Option<&'static str>,
    // 심볼릭 링크면 가리키는 경로
    link: Option<String>,
}

// worktree와 서브모듈은 .git이 "gitdir: <경로>" 한 줄짜리 파일이다.
// worktree의 gitdir은 원본 저장소의 .git/worktrees/<이름>을 가리킨다.
pub fn git_kind(dir: &Path) -> Option<&'static str> {
    let dot_git = dir.join(".git");
    let meta = std::fs::metadata(&dot_git).ok()?;
    if meta.is_dir() {
        return Some("repo");
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let gitdir = text.strip_prefix("gitdir:")?.trim();
    Some(if Path::new(gitdir).parent()?.ends_with(".git/worktrees") { "worktree" } else { "repo" })
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut entries: Vec<Entry> = std::fs::read_dir(Path::new(&path))
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| !HIDDEN.contains(&e.file_name().to_string_lossy().as_ref()))
        .map(|e| {
            // 심볼릭 링크는 따라가서 대상이 폴더인지 본다.
            let is_dir = std::fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false);
            Entry {
                name: e.file_name().to_string_lossy().into_owned(),
                path: e.path().to_string_lossy().into_owned(),
                is_dir,
                git: if is_dir { git_kind(&e.path()) } else { None },
                link: std::fs::read_link(e.path()).ok().map(|t| t.to_string_lossy().into_owned()),
            }
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirs_first_case_insensitive_and_hidden_skipped() {
        let dir = std::env::temp_dir().join(format!("ddak-fs-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for d in ["b_dir", "A_dir", ".git"] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
        }
        for f in ["z.txt", "a.txt", ".DS_Store"] {
            std::fs::write(dir.join(f), "").unwrap();
        }

        let names: Vec<_> = list_dir(dir.to_string_lossy().into_owned())
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["A_dir", "b_dir", "a.txt", "z.txt"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_checks() {
        let dir = std::env::temp_dir().join(format!("ddak-fs-create-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().into_owned();
        let code = |r: Result<String, CodeError>| r.unwrap_err().code;

        fs_create(d.clone(), " new.txt ".into(), "file".into()).unwrap();
        assert!(dir.join("new.txt").is_file());
        fs_create(d.clone(), "sub".into(), "dir".into()).unwrap();
        assert!(dir.join("sub").is_dir());
        assert_eq!(code(fs_create(d.clone(), "new.txt".into(), "dir".into())), "exists");
        assert_eq!(code(fs_create(d.clone(), "a/b".into(), "file".into())), "badName");
        assert_eq!(code(fs_create(d.clone(), "..".into(), "dir".into())), "badName");
        assert_eq!(code(fs_create(d, "  ".into(), "file".into())), "badName");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn git_kinds() {
        let dir = std::env::temp_dir().join(format!("ddak-git-kind-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("repo/.git")).unwrap();
        std::fs::create_dir_all(dir.join("plain")).unwrap();
        std::fs::create_dir_all(dir.join("wt")).unwrap();
        std::fs::write(dir.join("wt/.git"), "gitdir: /x/repo/.git/worktrees/wt\n").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/.git"), "gitdir: ../.git/modules/sub\n").unwrap();

        assert_eq!(git_kind(&dir.join("repo")), Some("repo"));
        assert_eq!(git_kind(&dir.join("plain")), None);
        assert_eq!(git_kind(&dir.join("wt")), Some("worktree"));
        assert_eq!(git_kind(&dir.join("sub")), Some("repo"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
