// 폴더 감시. 파일 트리(펼쳐진 폴더)와 작업그룹 설정 파일(앱 데이터 폴더)이 쓴다. 하위 폴더는 보지 않는다.
// 그 폴더 안이 바뀌면 "fs-changed" 이벤트로 { path: 프론트가 쓰는 경로, entries } 를 보낸다.
// entries: 항목이 생기거나 없어지거나 이름이 바뀜. false면 파일 내용·속성만 바뀐 것 (트리는 무시, 설정 파일은 다시 읽음).
//
// FSEvents는 링크를 따라간 실제 경로로 이벤트를 준다 (notify fsevent.rs가 경로를 canonicalize).
// 링크로 연결한 저장소를 펼치면 프론트 경로와 실제 경로가 달라서, 실제 경로 → 프론트 경로로 바꿔 보낸다.

use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

type Dirs = Arc<Mutex<HashMap<PathBuf, HashMap<String, usize>>>>;

#[derive(Clone, serde::Serialize)]
struct Changed {
    path: String,
    entries: bool,
}

#[derive(Default)]
pub struct Watches {
    watcher: Mutex<Option<RecommendedWatcher>>,
    // 실제 경로 → (프론트 경로 → 등록 수). 같은 폴더를 여러 트리 노드가 펼칠 수 있다.
    // 이벤트 콜백은 이것만 잠근다. watcher를 잠근 채 watch/unwatch를 하면 notify가 이벤트 스레드를
    // 멈추고 기다리므로, 콜백이 watcher 잠금을 기다리면 교착된다.
    dirs: Dirs,
}

impl Watches {
    // 감시 중인 프론트 경로들 (자체 테스트용)
    pub fn watched(&self) -> Vec<String> {
        let mut out: Vec<String> = self.dirs.lock().unwrap().values().flat_map(|p| p.keys().cloned()).collect();
        out.sort();
        out
    }
}

fn create(app: AppHandle, dirs: Dirs) -> notify::Result<RecommendedWatcher> {
    notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        if matches!(ev.kind, EventKind::Access(_)) {
            return;
        }
        let entries = !matches!(ev.kind, EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_)));
        let dirs = dirs.lock().unwrap();
        let mut changed = HashSet::new();
        for p in &ev.paths {
            let mut parents = vec![p.parent()];
            // X/.git이 생기거나 없어지면 X의 저장소 아이콘이 바뀐다 → X를 담은 폴더도 다시 읽는다.
            if p.file_name().is_some_and(|n| n == ".git") {
                parents.push(p.parent().and_then(|x| x.parent()));
            }
            for dir in parents.into_iter().flatten() {
                if let Some(paths) = dirs.get(dir) {
                    changed.extend(paths.keys().cloned());
                }
            }
        }
        drop(dirs);
        for path in changed {
            let _ = app.emit("fs-changed", Changed { path, entries });
        }
    })
}

// 동기 명령으로 둔다. 메인 스레드에서 차례대로 돌아서 watch/unwatch 순서가 뒤바뀌지 않는다.
#[tauri::command]
pub fn fs_watch(app: AppHandle, state: State<Watches>, path: String) -> Result<(), String> {
    let real = crate::platform::canonical(&path).map_err(|e| e.to_string())?;
    let mut watcher = state.watcher.lock().unwrap();
    if watcher.is_none() {
        *watcher = Some(create(app, state.dirs.clone()).map_err(|e| e.to_string())?);
    }
    let first = {
        let mut dirs = state.dirs.lock().unwrap();
        let paths = dirs.entry(real.clone()).or_default();
        let first = paths.is_empty();
        *paths.entry(path.clone()).or_default() += 1;
        first
    };
    if first {
        if let Err(e) = watcher.as_mut().unwrap().watch(&real, RecursiveMode::NonRecursive) {
            state.dirs.lock().unwrap().remove(&real);
            return Err(e.to_string());
        }
    }
    Ok(())
}

// 폴더가 이미 지워졌을 수 있어 canonicalize 대신 등록해 둔 프론트 경로로 찾는다.
#[tauri::command]
pub fn fs_unwatch(state: State<Watches>, path: String) {
    let mut watcher = state.watcher.lock().unwrap();
    let last = {
        let mut dirs = state.dirs.lock().unwrap();
        let Some(real) = dirs.iter().find(|(_, paths)| paths.contains_key(&path)).map(|(r, _)| r.clone()) else {
            return;
        };
        let paths = dirs.get_mut(&real).unwrap();
        let n = paths.get_mut(&path).unwrap();
        *n -= 1;
        if *n == 0 {
            paths.remove(&path);
        }
        if paths.is_empty() {
            dirs.remove(&real);
            Some(real)
        } else {
            None
        }
    };
    if let (Some(real), Some(w)) = (last, watcher.as_mut()) {
        let _ = w.unwatch(&real);
    }
}
