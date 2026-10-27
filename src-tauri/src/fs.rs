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

// 폴더 바로 아래 항목 이름. 경로가 섞이면 다른 곳에 만들 수 있으니 막는다.
fn check_name(name: &str) -> Result<&str, CodeError> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return Err(code_err("badName", name));
    }
    Ok(name)
}

// 폴더 바로 아래 새 항목의 경로. 이미 있으면 실패.
// 확인만 하는 것이라 만들거나 옮기는 쪽은 따로 덮어쓰기를 막아야 한다 (create_new, rename_excl).
pub fn child_path(dir: &str, name: &str) -> Result<PathBuf, CodeError> {
    let name = check_name(name)?;
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

// 대상이 있으면 실패하는 rename. 확인과 옮기기 사이에 대상이 생겨도 덮어쓰지 않는다 (macOS renamex_np RENAME_EXCL).
fn rename_excl(src: &Path, dest: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let from = CString::new(src.as_os_str().as_bytes())?;
    let to = CString::new(dest.as_os_str().as_bytes())?;
    if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

// 이름 바꾸기 (파일 트리). 같은 폴더 안에서 이름만 바꾼다. 이미 있는 이름이면 덮어쓰지 않고 실패한다.
// 미리 확인하지 않고 rename_excl 하나로 판단한다 (2026-10-23 실험, docs/reviews/2026-10-23-groups-input-rename.md):
// - 대소문자만 바꾸기는 대소문자를 구분하는 볼륨·안 하는 볼륨 모두 성공한다 (안 하는 볼륨은 같은 항목으로 본다).
// - 대소문자 구분 볼륨에서 그 이름이 따로 있거나, 이름이 다른 하드 링크면 EEXIST로 실패한다.
// 미리 "있음"을 확인하면 대소문자를 구분하지 않는 볼륨의 대소문자 바꾸기를 막게 되고, 그 예외를 따로 두면
// 일반 rename으로 빠져 덮어쓰기 경합이 생겼다 (리뷰).
#[tauri::command]
pub fn fs_rename(path: String, name: String) -> Result<String, CodeError> {
    let src = Path::new(&path);
    let dir = src.parent().ok_or_else(|| code_err("io", &path))?;
    let new = check_name(&name)?;
    if src.file_name().is_some_and(|n| n == new) {
        return Ok(path); // 그대로
    }
    let dest = dir.join(new);
    rename_excl(src, &dest).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => code_err("exists", new),
        _ => code_err("io", e),
    })?;
    Ok(dest.to_string_lossy().into_owned())
}

// 휴지통으로 옮기기 (파일 트리). 지우지 않고 macOS 휴지통으로 보내서 되살릴 수 있다 (NSFileManager trashItemAtURL).
// 자체 테스트(DDAK_SELFTEST)에서는 사용자의 휴지통 대신 DDAK_DATA_DIR/trash로 옮긴다 (실행마다 휴지통이 쌓이지 않게).
#[tauri::command]
pub fn fs_trash(path: String) -> Result<(), CodeError> {
    let src = Path::new(&path);
    if src.symlink_metadata().is_err() {
        return Err(code_err("io", format!("{path}: not found")));
    }
    if let (Some(_), Some(data)) = (std::env::var_os("DDAK_SELFTEST"), std::env::var_os("DDAK_DATA_DIR")) {
        let trash = Path::new(&data).join("trash");
        std::fs::create_dir_all(&trash).map_err(|e| code_err("io", e))?;
        let name = src.file_name().ok_or_else(|| code_err("io", &path))?;
        let dest = trash.join(format!("{}-{}", now_nanos(), name.to_string_lossy()));
        return std::fs::rename(src, &dest).map_err(|e| code_err("io", e));
    }
    move_to_trash(src).map_err(|e| code_err("io", e))
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos())
}

#[cfg(target_os = "macos")]
fn move_to_trash(path: &Path) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    NSFileManager::defaultManager().trashItemAtURL_resultingItemURL_error(&url, None).map_err(|e| e.localizedDescription().to_string())
}

#[cfg(not(target_os = "macos"))]
fn move_to_trash(path: &Path) -> Result<(), String> {
    Err(format!("{}: trash is only supported on macOS", path.display()))
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

// 문서 탭이 읽는 글 파일의 크기 한도 (마크다운 보기, src/DocView.tsx). 넘으면 tooLarge
const TEXT_LIMIT: u64 = 5 << 20;
// 문서 안 그림의 크기 한도
const IMAGE_LIMIT: u64 = 20 << 20;

// 한도 안이면 파일 내용. 없으면 missing, 크면 tooLarge, 나머지는 io
fn read_limited(path: &str, limit: u64) -> Result<Vec<u8>, CodeError> {
    let meta = std::fs::metadata(path).map_err(|e| code_err(if e.kind() == std::io::ErrorKind::NotFound { "missing" } else { "io" }, e))?;
    if !meta.is_file() {
        return Err(code_err("io", format!("not a file: {path}")));
    }
    if meta.len() > limit {
        return Err(code_err("tooLarge", meta.len()));
    }
    std::fs::read(path).map_err(|e| code_err("io", e))
}

// 문서 탭: 글 파일 내용 (UTF-8이 아닌 바이트는 바꿔 넣는다)
#[tauri::command]
pub fn fs_read_text(path: String) -> Result<String, CodeError> {
    Ok(String::from_utf8_lossy(&read_limited(&path, TEXT_LIMIT)?).into_owned())
}

// 문서 안 그림: data: 주소 (웹뷰가 로컬 파일을 직접 읽지 않게. 확장자로 정한 그림 형식만)
#[tauri::command]
pub fn fs_read_image(path: String) -> Result<String, CodeError> {
    use base64::Engine;
    let ext = Path::new(&path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return Err(code_err("notImage", path)),
    };
    let data = read_limited(&path, IMAGE_LIMIT)?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(data)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_documents_and_images_within_limits() {
        let dir = std::env::temp_dir().join(format!("ddak-fs-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = |n: &str| dir.join(n).to_string_lossy().into_owned();
        std::fs::write(dir.join("a.md"), b"# hi \xff").unwrap();
        assert_eq!(fs_read_text(p("a.md")).unwrap(), "# hi \u{FFFD}");
        assert_eq!(fs_read_text(p("none.md")).unwrap_err().code, "missing");
        assert_eq!(fs_read_text(dir.to_string_lossy().into_owned()).unwrap_err().code, "io");
        std::fs::File::create(dir.join("big.md")).unwrap().set_len(TEXT_LIMIT + 1).unwrap();
        assert_eq!(fs_read_text(p("big.md")).unwrap_err().code, "tooLarge");
        std::fs::write(dir.join("i.PNG"), [1u8, 2, 3]).unwrap();
        assert_eq!(fs_read_image(p("i.PNG")).unwrap(), "data:image/png;base64,AQID");
        std::fs::write(dir.join("i.txt"), "x").unwrap();
        assert_eq!(fs_read_image(p("i.txt")).unwrap_err().code, "notImage");
        std::fs::remove_dir_all(&dir).unwrap();
    }

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

    // 실제 휴지통으로 옮긴다 (사용자의 휴지통에 시험 파일이 남아서 기본으로는 돌리지 않는다)
    #[test]
    #[ignore]
    fn trash_moves_to_macos_trash() {
        let dir = std::env::temp_dir().join(format!("ddak-fs-trash-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("ddak-trash-test.txt");
        std::fs::write(&file, "x").unwrap();
        move_to_trash(&file).unwrap();
        assert!(!file.exists());
        assert!(move_to_trash(&file).is_err(), "없는 파일");
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
    fn rename_checks() {
        let dir = std::env::temp_dir().join(format!("ddak-fs-rename-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "A").unwrap();
        std::fs::write(dir.join("b.txt"), "B").unwrap();
        let p = |n: &str| dir.join(n).to_string_lossy().into_owned();
        let code = |r: Result<String, CodeError>| r.unwrap_err().code;

        assert_eq!(fs_rename(p("a.txt"), " c.txt ".into()).unwrap(), p("c.txt"));
        assert_eq!(std::fs::read_to_string(dir.join("c.txt")).unwrap(), "A");
        assert!(!dir.join("a.txt").exists());
        // 이미 있는 이름: 덮어쓰지 않음
        assert_eq!(code(fs_rename(p("c.txt"), "b.txt".into())), "exists");
        assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "B");
        assert_eq!(code(fs_rename(p("c.txt"), "x/y".into())), "badName");
        assert_eq!(code(fs_rename(p("c.txt"), "..".into())), "badName");
        // 같은 이름은 그대로
        assert_eq!(fs_rename(p("c.txt"), "c.txt".into()).unwrap(), p("c.txt"));
        // 대소문자만
        fs_rename(p("c.txt"), "C.txt".into()).unwrap();
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(names.contains(&"C.txt".to_string()) && !names.contains(&"c.txt".to_string()), "{names:?}");
        // 폴더
        fs_rename(p("sub"), "sub2".into()).unwrap();
        assert!(dir.join("sub2").is_dir());
        // 하드 링크: 같은 파일이라도 다른 이름의 항목이면 "있음" (리뷰 지적 8)
        std::fs::hard_link(dir.join("b.txt"), dir.join("link.txt")).unwrap();
        assert_eq!(code(fs_rename(p("b.txt"), "link.txt".into())), "exists");
        assert!(dir.join("b.txt").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // 대소문자를 구분하는 볼륨 (디스크 이미지를 만들어 붙인다. 느려서 따로 돌린다:
    // cargo test case_sensitive_volume -- --ignored)
    #[test]
    #[ignore]
    fn case_sensitive_volume() {
        let tmp = std::env::temp_dir().join(format!("ddak-cs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let (img, mnt) = (tmp.join("cs.dmg"), tmp.join("mnt"));
        let run = |args: &[&std::ffi::OsStr]| assert!(std::process::Command::new("hdiutil").args(args).status().unwrap().success());
        run(&["create".as_ref(), "-quiet".as_ref(), "-size".as_ref(), "20m".as_ref(), "-fs".as_ref(), "Case-sensitive APFS".as_ref(), img.as_os_str()]);
        run(&["attach".as_ref(), "-quiet".as_ref(), "-mountpoint".as_ref(), mnt.as_os_str(), img.as_os_str()]);
        let result = std::panic::catch_unwind(|| {
            let p = |n: &str| mnt.join(n).to_string_lossy().into_owned();
            let code = |r: Result<String, CodeError>| r.unwrap_err().code;
            std::fs::write(mnt.join("a.txt"), "a").unwrap();
            std::fs::write(mnt.join("A.txt"), "A-other").unwrap();
            // 그 이름이 따로 있으면 덮어쓰지 않는다 (리뷰가 짚은 경로)
            assert_eq!(code(fs_rename(p("a.txt"), "A.txt".into())), "exists");
            assert_eq!(std::fs::read_to_string(mnt.join("A.txt")).unwrap(), "A-other");
            std::fs::remove_file(mnt.join("A.txt")).unwrap();
            // 없으면 대소문자만 바꾸기
            fs_rename(p("a.txt"), "A.txt".into()).unwrap();
            assert_eq!(std::fs::read_to_string(mnt.join("A.txt")).unwrap(), "a");
            assert!(!mnt.join("a.txt").exists());
        });
        run(&["detach".as_ref(), "-quiet".as_ref(), mnt.as_os_str()]);
        std::fs::remove_dir_all(&tmp).unwrap();
        result.unwrap();
    }

    // 확인 뒤에 대상이 생겨도 덮어쓰지 않는다 (리뷰 지적 1): 경합 순간을 대상이 이미 있는 상태로 만든다
    #[test]
    fn rename_excl_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("ddak-fs-excl-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("src.txt"), "SRC").unwrap();
        std::fs::write(dir.join("dest.txt"), "DEST").unwrap();
        let e = rename_excl(&dir.join("src.txt"), &dir.join("dest.txt")).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(dir.join("dest.txt")).unwrap(), "DEST");
        assert_eq!(std::fs::read_to_string(dir.join("src.txt")).unwrap(), "SRC");
        rename_excl(&dir.join("src.txt"), &dir.join("new.txt")).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("new.txt")).unwrap(), "SRC");
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
