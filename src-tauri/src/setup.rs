// 작업그룹 준비 스크립트 (docs/spec.md "작업그룹 · worktree 설계"). worktree에는 커밋된 파일만 있어서
// node_modules, 빌드 결과, .env 같은 것이 없다. 새 작업그룹을 만든 직후 그 폴더에서 이 스크립트를 돌린다.
//
// 프로젝트마다 앱 데이터 폴더의 setup/<프로젝트 이름>-<경로 해시>.sh 하나 (프로젝트 폴더에는 쓰지 않는다).
// 편집 화면은 아직 없고, 프로젝트 오른쪽 클릭 메뉴가 기본 텍스트 편집기로 연다 (작업그룹 설정과 같은 방식).

use crate::fs::{code_err, CodeError};
use crate::projects::data_dir;
use crate::worktrees::project_slug;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime};

// 처음 열 때 써 두는 내용. 주석뿐이면 명령이 없는 것으로 보고 돌리지 않는다.
const TEMPLATE: &str = r#"# Work group setup for this project.
# Runs with sh in the new work group folder right after its worktrees are created,
# in a "setup" pane below the sessions. Worktrees only contain committed files.
#
#   DDAK_ORIGIN  the original project folder
#   DDAK_GROUP   the work group name (e.g. dev-review-1)
#
# Examples:
#   (cd app && npm install)
#   cp "$DDAK_ORIGIN/api/.env" api/.env
"#;

pub fn script_path<R: Runtime>(app: &AppHandle<R>, project: &Path) -> Result<PathBuf, CodeError> {
    let root = std::fs::canonicalize(project).map_err(|e| code_err("io", e))?;
    let dir = data_dir(app).map_err(|e| code_err("io", e))?;
    Ok(dir.join("setup").join(format!("{}.sh", project_slug(&root))))
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
