// 프로젝트 목록 저장. 앱 데이터 폴더의 projects.json에 둔다 (프로젝트 폴더에는 아무것도 쓰지 않는다).
// 목록의 내용은 프론트가 정하고, 여기서는 읽고 쓰기만 한다.

use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Default, serde::Serialize, serde::Deserialize)]
pub struct Store {
    #[serde(default)]
    projects: Vec<Project>,
    // 마지막으로 보고 있던 프로젝트 경로
    #[serde(default)]
    active: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Project {
    path: String,
}

// 앱 데이터 폴더 (프로젝트 목록, 작업그룹 설정, 탭 상태, 채팅).
// DDAK_DATA_DIR이 있으면 그 폴더를 쓴다 (자체 테스트가 실제 목록을 건드리지 않게).
// 개발 빌드는 설치한 앱의 폴더 옆 `<식별자>-dev`를 쓴다. 설치한 ddak 안에서 개발 빌드를 띄워도 두 앱이 같은 상태 파일을
// 서로 덮어쓰지 않게 (docs/spec.md "배포 계획").
pub fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    match std::env::var_os("DDAK_DATA_DIR") {
        Some(dir) => Ok(PathBuf::from(dir)),
        None if std::env::var_os("DDAK_SELFTEST").is_some() => Err("자체 테스트에는 DDAK_DATA_DIR이 필요하다".into()),
        None => {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            if cfg!(debug_assertions) {
                let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                return Ok(dir.with_file_name(format!("{name}-dev")));
            }
            Ok(dir)
        }
    }
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("projects.json"))
}

fn load(path: &std::path::Path) -> Result<Store, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(e.to_string()),
    }
}

// 쓰다가 앱이 죽어도 기존 파일이 깨지지 않도록 임시 파일에 쓴 뒤 바꿔치기한다.
fn save(path: &std::path::Path, store: &Store) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn projects_load(app: AppHandle) -> Result<Store, String> {
    load(&store_path(&app)?)
}

#[tauri::command]
pub fn projects_save(app: AppHandle, store: Store) -> Result<(), String> {
    save(&store_path(&app)?, &store)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_is_empty_and_roundtrip() {
        let dir = std::env::temp_dir().join(format!("ddak-projects-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("projects.json");

        let empty = load(&path).unwrap();
        assert!(empty.projects.is_empty() && empty.active.is_none());

        let store = Store { projects: vec![Project { path: "/a".into() }], active: Some("/a".into()) };
        save(&path, &store).unwrap();
        let back = load(&path).unwrap();
        assert_eq!(back.projects[0].path, "/a");
        assert_eq!(back.active.as_deref(), Some("/a"));
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
