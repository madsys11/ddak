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
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || (cfg!(windows) && !windows_name_ok(name)) {
        return Err(code_err("badName", name));
    }
    Ok(name)
}

// Windows에서 폴더 바로 아래 한 항목의 이름이 될 수 있는지 (docs/windows-plan.md "파일 이름"). `\`·`:`(드라이브 접두사,
// 대체 데이터 스트림)가 들면 Path::join이 폴더 밖이나 다른 드라이브가 되고, 끝의 점·공백과 장치 이름은 OS가 다른 것으로 바꾼다.
fn windows_name_ok(name: &str) -> bool {
    !(name.chars().any(|c| c < ' ' || "<>:\"/\\|?*".contains(c)) || name.ends_with(['.', ' ']) || crate::platform::is_device_name(name))
}

// 만든 경로가 정확히 그 폴더 바로 아래인지 (이름 검사를 지나도 한 번 더)
fn directly_under(dir: &Path, path: &Path) -> bool {
    let normal = matches!(path.components().next_back(), Some(std::path::Component::Normal(_)));
    normal && path.parent() == Some(dir) && path.components().count() == dir.components().count() + 1
}

// 폴더 바로 아래 새 항목의 경로. 이미 있으면 실패.
// 확인만 하는 것이라 만들거나 옮기는 쪽은 따로 덮어쓰기를 막아야 한다 (create_new, rename_excl).
pub fn child_path(dir: &str, name: &str) -> Result<PathBuf, CodeError> {
    let name = check_name(name)?;
    let path = Path::new(dir).join(name);
    if !directly_under(Path::new(dir), &path) {
        return Err(code_err("badName", name));
    }
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
#[cfg(unix)]
pub(crate) fn rename_excl(src: &Path, dest: &Path) -> std::io::Result<()> {
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

// Windows: MoveFileExW에 MOVEFILE_REPLACE_EXISTING을 주지 않으면 대상이 있을 때 실패한다 (std::fs::rename은 덮어쓴다).
// 대소문자만 바꾸기는 같은 항목이라 된다.
// 다만 대상이 같은 파일의 다른 이름(하드 링크)이면 MoveFileExW가 성공하고 원래 이름이 사라진다 (2026-10-28 CI).
// 그래서 대소문자만 다른 이름이 아니면 대상이 있는지 먼저 본다. 확인 뒤에 생긴 대상은 MoveFileExW가 막는다.
#[cfg(windows)]
pub(crate) fn rename_excl(src: &Path, dest: &Path) -> std::io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let lower = |p: &Path| p.file_name().map(|n| n.to_string_lossy().to_lowercase());
    if lower(src) != lower(dest) && dest.symlink_metadata().is_ok() {
        return Err(std::io::ErrorKind::AlreadyExists.into());
    }
    let (from, to) = (wide(src), wide(dest));
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

// Windows API에 넘길 NUL로 끝나는 UTF-16 경로
#[cfg(windows)]
pub fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
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
    if !directly_under(dir, &dest) {
        return Err(code_err("badName", new));
    }
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

// Windows 휴지통 (셸 파일 작업, FOF_ALLOWUNDO). 휴지통이 없는 곳(네트워크 드라이브 등)이면 아주 지울지 셸이 묻는다
// (FOF_WANTNUKEWARNING: 묻지 않고 지우지 않게).
#[cfg(windows)]
fn move_to_trash(path: &Path) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::{
        FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FOF_WANTNUKEWARNING, SHFILEOPSTRUCTW, SHFileOperationW,
    };
    // 이름 목록은 NUL 두 개로 끝난다
    let mut from = wide(path);
    from.push(0);
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.wFunc = FO_DELETE;
    op.pFrom = from.as_ptr();
    op.fFlags = (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING) as u16;
    let r = unsafe { SHFileOperationW(&mut op) };
    if r != 0 {
        return Err(format!("{}: trash failed ({r:#x})", path.display()));
    }
    if op.fAnyOperationsAborted != 0 {
        return Err(format!("{}: trash cancelled", path.display()));
    }
    Ok(())
}

// Finder 등 앱 밖에서 끌어 놓은 파일의 경로 (src/dragPath.ts droppedFiles). 웹뷰의 drop은 File만 주고 경로는 주지 않아
// 끌기 대지(drag pasteboard)를 읽는다. 대지는 놓은 뒤에도 마지막 끌기의 내용을 들고 있어서, 화면이 끌기 중(dragover)에 본
// 대지 번호(changeCount, 새 끌기마다 바뀐다)와 놓은 파일 이름이 모두 맞을 때만 쓴다. Finder는 파일 참조
// 주소(file:///.file/id=…)를 싣기도 해서 경로 주소로 바꾼다.
// 자체 테스트는 시스템 끌기 대지 대신 이름을 붙인 대지를 쓴다 (selftest_drag_files가 채운다).
#[derive(serde::Serialize)]
pub struct DragFiles {
    count: isize,
    paths: Vec<String>,
}

#[tauri::command]
pub fn drag_files() -> DragFiles {
    let board = drag_board();
    DragFiles { count: board_count(&board), paths: read_drag_files(&board) }
}

// Windows: 화면이 토큰과 함께 보낸 파일들의 경로 (windrop.rs). 아직 오지 않았으면 None, 맥은 늘 None (끌기 대지를 쓴다)
#[tauri::command]
pub fn drop_paths(token: String) -> Option<Vec<String>> {
    #[cfg(windows)]
    return crate::windrop::take(&token);
    #[cfg(not(windows))]
    {
        let _ = token;
        None
    }
}

#[tauri::command]
pub fn drag_count() -> isize {
    board_count(&drag_board())
}

#[tauri::command]
pub fn selftest_drag_files(paths: Vec<String>) {
    if std::env::var_os("DDAK_SELFTEST").is_some() {
        write_drag_files(&drag_board(), &paths);
    }
}

#[cfg(target_os = "macos")]
type Board = objc2::rc::Retained<objc2_app_kit::NSPasteboard>;
#[cfg(not(target_os = "macos"))]
type Board = ();

#[cfg(target_os = "macos")]
fn drag_board() -> Board {
    use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag};
    if std::env::var_os("DDAK_SELFTEST").is_some() {
        return NSPasteboard::pasteboardWithName(&objc2_foundation::NSString::from_str("io.github.madsys11.ddak.selftest-drag"));
    }
    NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag })
}

#[cfg(target_os = "macos")]
fn board_count(board: &Board) -> isize {
    board.changeCount()
}

#[cfg(target_os = "macos")]
fn read_drag_files(board: &Board) -> Vec<String> {
    use objc2_app_kit::NSPasteboardTypeFileURL;
    use objc2_foundation::NSURL;
    let Some(items) = board.pasteboardItems() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let s = item.stringForType(unsafe { NSPasteboardTypeFileURL })?;
            let url = NSURL::URLWithString(&s)?;
            // NSURL의 경로는 한글 등을 풀어 쓴 꼴(NFD)이라 터미널에서 자모가 흩어진다. 모아 쓴 꼴(NFC)로 (APFS는 둘 다 찾는다)
            Some(url.filePathURL()?.path()?.precomposedStringWithCanonicalMapping().to_string())
        })
        .collect()
}

// 있는 파일은 Finder처럼 파일 참조 주소로 싣는다
#[cfg(target_os = "macos")]
fn write_drag_files(board: &Board, paths: &[String]) {
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboardItem, NSPasteboardTypeFileURL, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};
    board.clearContents();
    let items: Vec<objc2::rc::Retained<ProtocolObject<dyn NSPasteboardWriting>>> = paths
        .iter()
        .filter_map(|p| {
            let url = NSURL::fileURLWithPath(&NSString::from_str(p));
            let url = url.fileReferenceURL().unwrap_or(url);
            let item = NSPasteboardItem::new();
            let s = url.absoluteString()?;
            item.setString_forType(&s, unsafe { NSPasteboardTypeFileURL });
            Some(ProtocolObject::from_retained(item))
        })
        .collect();
    board.writeObjects(&NSArray::from_retained_slice(&items));
}

#[cfg(not(target_os = "macos"))]
fn drag_board() -> Board {}

#[cfg(not(target_os = "macos"))]
fn board_count(_: &Board) -> isize {
    0
}

#[cfg(not(target_os = "macos"))]
fn read_drag_files(_: &Board) -> Vec<String> {
    Vec::new()
}

#[cfg(not(target_os = "macos"))]
fn write_drag_files(_: &Board, _: &[String]) {}

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

    // Windows에서 폴더 밖이나 다른 것이 될 이름은 거절한다 (규칙은 맥에서도 시험한다)
    #[test]
    fn windows_names() {
        for bad in ["..\\out", "C:\\out", "C:out", "\\out", "a:stream", "a<b", "a|b", "a?", "a*", "a\"b", "tab\there", "end.", "end ", "CON", "con.txt",
            "Nul", "COM1", "lpt9.log", "COM¹", "CONIN$"]
        {
            assert!(!windows_name_ok(bad), "{bad}");
        }
        for good in ["a.txt", ".env", "한글 이름.md", "COM", "COM10", "console.log", "LPT0", "a..b"] {
            assert!(windows_name_ok(good), "{good}");
        }
        assert!(directly_under(Path::new("/p/d"), &Path::new("/p/d").join("x")));
        assert!(!directly_under(Path::new("/p/d"), &Path::new("/p/d").join("/abs")));
        assert!(!directly_under(Path::new("/p/d"), &Path::new("/p/d").join("..")));
    }

    // 끌기 대지의 파일 참조 주소(Finder가 싣는 모양)를 경로로 읽는다. 한글·공백 이름, 없는 파일(일반 file 주소)도.
    #[cfg(target_os = "macos")]
    #[test]
    fn reads_dragged_file_paths_from_pasteboard() {
        let dir = std::env::temp_dir().join(format!("ddak-fs-drag-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("폴더 a")).unwrap();
        std::fs::write(dir.join("사진 1.png"), "x").unwrap();
        let dir = dir.canonicalize().unwrap();
        let paths: Vec<String> = ["사진 1.png", "폴더 a", "없음.txt"].iter().map(|n| dir.join(n).to_string_lossy().into_owned()).collect();
        let board = objc2_app_kit::NSPasteboard::pasteboardWithUniqueName();
        write_drag_files(&board, &paths);
        let first = board.pasteboardItems().unwrap().iter().next().unwrap().stringForType(unsafe { objc2_app_kit::NSPasteboardTypeFileURL }).unwrap().to_string();
        assert!(first.starts_with("file:///.file/id="), "{first}");
        assert_eq!(read_drag_files(&board), paths);
        // 다시 실으면 (새 끌기) 대지 번호가 바뀐다
        let count = board_count(&board);
        write_drag_files(&board, &paths[..1]);
        assert_ne!(board_count(&board), count);
        assert_eq!(read_drag_files(&board), paths[..1]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

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
