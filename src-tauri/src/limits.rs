// 협업 제한 (docs/spec.md "협업 제한", docs/reviews/2026-11-03-limits-ui.md): 앱 메뉴 "협업 제한…" 창(src/LimitsDialog.tsx)에서
// 바꾸고 앱 데이터의 limits.json에 둔다. groups.json은 사용자가 직접 고치는 파일이고 앱이 다시 쓰지 않으므로 따로 둔다.
// - wakeLimit: 세션끼리 사용자 없이 주고받을 메시지 수 (자동 깨우기 제한, chat.rs). 바꾸면 바로 적용하고 모든 작업그룹을 재개한다.
// - reReviews: 재리뷰 최대 횟수. 작업그룹 규약의 {reReviews}에 넣는다 (프론트 useGroups.ts promptOf). 새로 만든 세션부터.
// 없거나 읽지 못하거나 범위 밖인 값은 기본으로 본다.

use crate::chat::{ChatsState, DEFAULT_WAKE_LIMIT};
use crate::projects::data_dir;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Runtime, State};

pub const DEFAULT_RE_REVIEWS: u32 = 2;
pub const WAKE_RANGE: (u32, u32) = (1, 100);
pub const RE_REVIEW_RANGE: (u32, u32) = (0, 5);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub wake_limit: u32,
    pub re_reviews: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { wake_limit: DEFAULT_WAKE_LIMIT, re_reviews: DEFAULT_RE_REVIEWS }
    }
}

const fn within(v: u32, (lo, hi): (u32, u32)) -> bool {
    v >= lo && v <= hi
}

fn path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("limits.json"))
}

// 파일에서 읽는다. 값마다 따로: 없거나 숫자가 아니거나 범위 밖이면 그 값만 기본
fn read(path: &Path) -> Limits {
    let mut limits = Limits::default();
    let Some(v) = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) else { return limits };
    let num = |key: &str| v.get(key).and_then(serde_json::Value::as_u64).and_then(|n| u32::try_from(n).ok());
    if let Some(n) = num("wakeLimit").filter(|n| within(*n, WAKE_RANGE)) {
        limits.wake_limit = n;
    }
    if let Some(n) = num("reReviews").filter(|n| within(*n, RE_REVIEW_RANGE)) {
        limits.re_reviews = n;
    }
    limits
}

// 쓰다 끊겨도 반쯤 쓴 파일이 남지 않게 옆에 쓰고 옮긴다
fn write(path: &Path, limits: Limits) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&limits).unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Limits {
    path(app).map(|p| read(&p)).unwrap_or_default()
}

#[tauri::command]
pub fn limits_get(app: AppHandle) -> Limits {
    load(&app)
}

// 범위를 확인하고 파일에 쓴 뒤 (쓰지 못하면 오류, 아무것도 바꾸지 않음), 대화 제한이 바뀌었으면 채팅에 넣는다 (그때 재개).
// 프론트에는 "limits" 이벤트로 새 값을 알린다 (Workspace가 그 뒤 만드는 세션의 규약, 채팅 패널의 멈춤 문구)
#[tauri::command]
pub fn limits_set(app: AppHandle, chats: State<'_, ChatsState>, wake_limit: u32, re_reviews: u32) -> Result<Limits, String> {
    if !within(wake_limit, WAKE_RANGE) || !within(re_reviews, RE_REVIEW_RANGE) {
        return Err("range".into());
    }
    let limits = Limits { wake_limit, re_reviews };
    write(&path(&app)?, limits)?;
    if let Some(chats) = chats.0.as_ref() {
        chats.set_wake_limit(wake_limit);
    }
    let _ = app.emit("limits", limits);
    Ok(limits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_falls_back_per_value() {
        let dir = std::env::temp_dir().join(format!("ddak-limits-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join("limits.json");
        assert_eq!(read(&file), Limits::default(), "없음");
        write(&file, Limits { wake_limit: 25, re_reviews: 0 }).unwrap();
        assert_eq!(read(&file), Limits { wake_limit: 25, re_reviews: 0 });
        assert!(!file.with_extension("json.tmp").exists());
        std::fs::write(&file, "{broken").unwrap();
        assert_eq!(read(&file), Limits::default(), "깨짐");
        std::fs::write(&file, r#"{"wakeLimit": 0, "reReviews": 3}"#).unwrap();
        assert_eq!(read(&file), Limits { wake_limit: DEFAULT_WAKE_LIMIT, re_reviews: 3 }, "범위 밖은 그 값만 기본");
        std::fs::write(&file, r#"{"wakeLimit": 101, "reReviews": 6}"#).unwrap();
        assert_eq!(read(&file), Limits::default());
        std::fs::write(&file, r#"{"wakeLimit": "x", "reReviews": -1}"#).unwrap();
        assert_eq!(read(&file), Limits::default());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
