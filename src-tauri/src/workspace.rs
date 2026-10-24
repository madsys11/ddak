// 프로젝트마다 마지막 작업 화면(탭·분할·작업그룹·세션)을 앱 데이터의 workspaces/<프로젝트 이름>-<경로 해시>.json에 둔다
// (docs/spec.md "복원"). 내용은 프론트가 정하고 Rust는 읽고 쓰기만 한다 (projects.json과 같은 방식).

use crate::fs::{code_err, CodeError};
use crate::projects::data_dir;
use crate::worktrees::project_slug;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime};

fn state_path<R: Runtime>(app: &AppHandle<R>, project: &str) -> Result<PathBuf, CodeError> {
    let root = std::fs::canonicalize(project).map_err(|e| code_err("io", e))?;
    let dir = data_dir(app).map_err(|e| code_err("io", e))?;
    Ok(dir.join("workspaces").join(format!("{}.json", project_slug(&root))))
}

// 없으면 None. 내용이 깨졌으면 (UTF-8·JSON이 아님) 옆으로 치워 두고 (.json.bad, 무엇이 깨졌는지 볼 수 있게) None:
// 처음처럼 연다. 읽지 못하면 (권한 등) 오류: 프론트는 그동안 저장하지 않는다 (리뷰 P1: 읽기 실패를 "없음"·"깨짐"으로
// 보고 기본 상태로 덮어썼다).
fn load(path: &Path) -> Result<Option<String>, CodeError> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => String::new(),
        Err(e) => return Err(code_err("io", format!("{}: {e}", path.display()))),
    };
    if serde_json::from_str::<serde_json::Value>(&text).is_ok() {
        return Ok(Some(text));
    }
    set_aside(path)?;
    Ok(None)
}

fn set_aside(path: &Path) -> Result<(), CodeError> {
    std::fs::rename(path, path.with_extension("json.bad")).map_err(|e| code_err("io", format!("{}: {e}", path.display())))
}

// 쓰다 끊겨도 반쯤 쓴 파일이 남지 않게 옆에 쓰고 옮긴다
fn save(path: &Path, state: &str) -> Result<(), CodeError> {
    serde_json::from_str::<serde_json::Value>(state).map_err(|e| code_err("io", e))?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| code_err("io", e))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, state).map_err(|e| code_err("io", e))?;
    std::fs::rename(&tmp, path).map_err(|e| code_err("io", e))
}

#[tauri::command]
pub fn workspace_load(app: AppHandle, project: String) -> Result<Option<String>, CodeError> {
    load(&state_path(&app, &project)?)
}

// JSON이지만 프론트가 아는 모양이 아닐 때 옆으로 치운다 (그 뒤 저장이 덮어쓰지 않게)
#[tauri::command]
pub fn workspace_set_aside(app: AppHandle, project: String) -> Result<(), CodeError> {
    set_aside(&state_path(&app, &project)?)
}

#[tauri::command]
pub fn workspace_save(app: AppHandle, project: String, state: String) -> Result<(), CodeError> {
    save(&state_path(&app, &project)?, &state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_broken_file() {
        let dir = std::env::temp_dir().join(format!("ddak-workspace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("workspaces/p.json");
        assert_eq!(load(&path).unwrap(), None);
        save(&path, r#"{"tabs":[]}"#).unwrap();
        assert_eq!(load(&path).unwrap().as_deref(), Some(r#"{"tabs":[]}"#));
        assert!(save(&path, "{broken").is_err(), "JSON이 아닌 것은 쓰지 않음");
        std::fs::write(&path, "{broken").unwrap();
        assert_eq!(load(&path).unwrap(), None);
        assert!(!path.exists() && path.with_extension("json.bad").exists());
        // UTF-8이 아닌 내용도 깨진 것
        std::fs::write(&path, b"{\xff}").unwrap();
        assert_eq!(load(&path).unwrap(), None);
        assert!(!path.exists());
        // 읽지 못하는 것은 오류이고 그대로 둔다 (깨진 것으로 치우지 않는다)
        save(&path, r#"{"tabs":[1]}"#).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let r = load(&path);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(r.is_err(), "{r:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"tabs":[1]}"#);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
