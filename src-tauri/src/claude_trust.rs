// claude 폴더 신뢰 (docs/spec.md "작업그룹 준비"). 새 작업그룹 폴더에서 처음 뜬 claude는 폴더 신뢰를 묻는다. 그 창은
// 상태(OSC 7501)를 알리지 않고, 그동안 깨우면 알림의 Enter가 답을 고를 수 있었다. 원본 프로젝트 폴더를 이미 신뢰했으면
// 새 작업그룹 폴더도 신뢰한다고 claude 설정(`~/.claude.json`의 projects.<폴더>.hasTrustDialogAccepted)에 미리 적는다.
// orca(src/main/claude/claude-folder-trust-file.ts)와 같은 방식이다.
//
// - claude가 이 파일을 자주 다시 쓴다. claude가 잡는 잠금(`<파일>.lock` 폴더, proper-lockfile)을 잡고, 잠금 안에서 다시 읽어
//   바꾼 뒤 같은 폴더의 임시 파일에 써서 바꿔치운다. 잠금을 못 잡으면 적지 않는다 (claude가 신뢰를 물을 뿐이다).
//   설정 파일이 링크면 링크 경로와 실제 경로를 둘 다 잠근다: proper-lockfile의 기본은 실제 경로이고, orca는 claude가 링크
//   경로를 잠근다고 적었다 (리뷰 R1). 읽기·바꾸기는 실제 파일에 한다.
// - 원본을 신뢰하지 않았으면 적지 않는다. 사용자가 고른 적 없는 신뢰를 ddak이 주지 않는다.
// - 자체 테스트는 사용자 설정을 건드리지 않게 DDAK_HOME/claude.json을 쓴다.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Map, Value};

#[derive(Debug, PartialEq)]
pub enum Outcome {
    // 새 폴더를 신뢰한다고 적었다
    Granted,
    // 이미 신뢰한다고 적혀 있다
    Unchanged,
    // 원본 폴더를 신뢰하지 않았다 (적지 않음)
    OriginNotTrusted,
    // 설정 파일이 없다 (claude를 쓰지 않음)
    Missing,
    // 잠금을 못 잡았다
    Locked,
    // 읽거나 쓰지 못했다 (모양이 다름 포함)
    Failed(String),
}

// claude의 전역 설정 파일: CLAUDE_CONFIG_DIR(없으면 ~/.claude)의 .config.json이 있으면 그것 (예전 위치),
// 아니면 CLAUDE_CONFIG_DIR(없으면 홈)의 .claude.json
pub fn config_file() -> Option<PathBuf> {
    if std::env::var_os("DDAK_SELFTEST").is_some() {
        return std::env::var_os("DDAK_HOME").map(|h| PathBuf::from(h).join("claude.json"));
    }
    let home = crate::platform::home()?;
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()).map(PathBuf::from);
    let legacy = dir.clone().unwrap_or_else(|| home.join(".claude")).join(".config.json");
    if legacy.exists() {
        return Some(legacy);
    }
    Some(dir.unwrap_or(home).join(".claude.json"))
}

// 폴더의 설정 키 후보: 받은 경로와 실제 경로 (claude는 띄운 폴더의 경로를 키로 쓴다)
// Windows는 확장 길이 형식(`\\?\`)을 일반 형식으로 바꾸고, 구분자가 `/`인 꼴도 넣는다 (claude가 어느 꼴로 적는지 실기기에서 확인할 것)
fn keys(path: &Path) -> Vec<String> {
    let mut keys = vec![path.to_string_lossy().into_owned()];
    if let Ok(real) = crate::platform::canonical(path) {
        let real = real.to_string_lossy().into_owned();
        if !keys.contains(&real) {
            keys.push(real);
        }
    }
    if cfg!(windows) {
        for k in keys.clone() {
            let slashed = k.replace('\\', "/");
            if !keys.contains(&slashed) {
                keys.push(slashed);
            }
        }
    }
    keys
}

fn trusted(projects: &Map<String, Value>, keys: &[String]) -> bool {
    keys.iter().any(|k| projects.get(k).and_then(|e| e.get("hasTrustDialogAccepted")) == Some(&Value::Bool(true)))
}

// 설정에 적는다. Ok(Ok): 바꿈, Ok(Err): 바꿀 것 없음 (그 이유), Err: 모양이 다름
fn apply(config: &mut Value, origin: &[String], dest: &[String]) -> Result<Result<(), Outcome>, String> {
    let Value::Object(config) = config else { return Err("설정이 객체가 아님".into()) };
    let projects = config.entry("projects").or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(projects) = projects else { return Err("projects가 객체가 아님".into()) };
    if trusted(projects, dest) {
        return Ok(Err(Outcome::Unchanged));
    }
    if !trusted(projects, origin) {
        return Ok(Err(Outcome::OriginNotTrusted));
    }
    for key in dest {
        match projects.get_mut(key) {
            Some(Value::Object(entry)) => {
                entry.insert("hasTrustDialogAccepted".into(), Value::Bool(true));
            }
            _ => {
                projects.insert(key.clone(), serde_json::json!({ "hasTrustDialogAccepted": true }));
            }
        }
    }
    Ok(Ok(()))
}

fn read(file: &Path) -> Result<Value, Outcome> {
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Outcome::Missing),
        Err(e) => return Err(Outcome::Failed(e.to_string())),
    };
    serde_json::from_str(&text).map_err(|e| Outcome::Failed(e.to_string()))
}

// 잠금: proper-lockfile처럼 `<파일>.lock` 폴더를 만든다 (있으면 누가 쥐고 있다). 잠깐씩 몇 번 더 해 본다.
const LOCK_WAITS: [u64; 5] = [50, 100, 200, 250, 250];

fn lock_one(file: &Path) -> Option<PathBuf> {
    let mut lock = file.as_os_str().to_owned();
    lock.push(".lock");
    let lock = PathBuf::from(lock);
    let mut waits = LOCK_WAITS.iter();
    loop {
        match std::fs::create_dir(&lock) {
            Ok(()) => return Some(lock),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => std::thread::sleep(Duration::from_millis(*waits.next()?)),
            Err(_) => return None,
        }
    }
}

// files를 모두 잠그고 f를 돌린다. 하나라도 못 잡으면 잡은 것을 풀고 None
fn locked<T>(files: &[&Path], f: impl FnOnce() -> T) -> Option<T> {
    let mut held = Vec::new();
    for file in files {
        match lock_one(file) {
            Some(lock) => held.push(lock),
            None => break,
        }
    }
    let out = (held.len() == files.len()).then(f);
    for lock in held.iter().rev() {
        let _ = std::fs::remove_dir(lock);
    }
    out
}

// 임시 파일을 원래 파일과 같은 권한으로 만든다
#[cfg(unix)]
fn keep_mode<'a>(options: &'a mut std::fs::OpenOptions, permissions: &std::fs::Permissions) -> &'a mut std::fs::OpenOptions {
    use std::os::unix::fs::PermissionsExt;
    crate::platform::with_mode(options, permissions.mode() & 0o777)
}

#[cfg(windows)]
fn keep_mode<'a>(options: &'a mut std::fs::OpenOptions, _: &std::fs::Permissions) -> &'a mut std::fs::OpenOptions {
    options
}

// 실제 파일(target, 링크가 아님)을 같은 권한의 임시 파일에 써서 바꿔치운다
fn replace(target: &Path, config: &Value) -> Result<(), String> {
    let permissions = std::fs::metadata(target).map_err(|e| e.to_string())?.permissions();
    let mut tmp = target.as_os_str().to_owned();
    tmp.push(format!(".ddak-trust-{}.tmp", std::process::id()));
    let tmp = PathBuf::from(tmp);
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())? + "\n";
    let written = keep_mode(std::fs::OpenOptions::new().write(true).create_new(true), &permissions)
        .open(&tmp)
        .and_then(|mut f| {
            // umask로 줄어든 권한을 되돌린다 (Windows는 읽기 전용 표시만)
            f.set_permissions(permissions)?;
            f.write_all(text.as_bytes())?;
            f.sync_all()
        })
        .and_then(|()| std::fs::rename(&tmp, target));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map_err(|e| e.to_string())
}

// 원본 폴더(origin)를 신뢰했으면 새 폴더(dest)도 신뢰한다고 적는다
pub fn inherit(file: &Path, origin: &Path, dest: &Path) -> Outcome {
    let (origin, dest) = (keys(origin), keys(dest));
    // 바꿀 게 없으면 잠그지 않는다
    let mut probe = match read(file) {
        Ok(v) => v,
        Err(o) => return o,
    };
    match apply(&mut probe, &origin, &dest) {
        Err(e) => return Outcome::Failed(e),
        Ok(Err(o)) => return o,
        Ok(Ok(())) => {}
    }
    // 링크면 가리키는 파일. 잠금 전에 정하고, 잠금 안에서 그 파일을 읽고 바꾼다
    let target = match crate::platform::canonical(file) {
        Ok(t) => t,
        Err(e) => return Outcome::Failed(e.to_string()),
    };
    let files: Vec<&Path> = if target == file { vec![file] } else { vec![file, &target] };
    locked(&files, || {
        let mut config = read(&target)?;
        match apply(&mut config, &origin, &dest) {
            Err(e) => Err(Outcome::Failed(e)),
            Ok(Err(o)) => Err(o),
            Ok(Ok(())) => replace(&target, &config).map(|()| Outcome::Granted).map_err(Outcome::Failed),
        }
    })
    .map_or(Outcome::Locked, |r| r.unwrap_or_else(|o| o))
}

// 작업그룹을 만든 뒤: 원본 프로젝트를 신뢰했으면 작업그룹 폴더도 (실패해도 작업그룹은 그대로, 기록만)
pub fn inherit_for_group(project: &Path, group: &Path) {
    let Some(file) = config_file() else { return };
    match inherit(&file, project, group) {
        Outcome::Granted | Outcome::Unchanged | Outcome::OriginNotTrusted | Outcome::Missing => {}
        other => eprintln!("claude 폴더 신뢰를 적지 못함 ({}): {other:?}", group.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ddak-trust-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    // 원본을 신뢰했으면 새 폴더를 적고, 다른 항목·키 순서는 그대로 둔다. 원본을 신뢰하지 않았거나 이미 적혀 있으면 그대로.
    #[cfg(unix)]
    #[test]
    fn inherits_trust_from_origin() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp("inherit");
        let (origin, dest, other) = (dir.join("proj"), dir.join("group"), dir.join("other"));
        for d in [&origin, &dest, &other] {
            std::fs::create_dir_all(d).unwrap();
        }
        let file = dir.join("claude.json");
        let o = origin.to_string_lossy();
        std::fs::write(&file, format!(r#"{{"zeta":1,"projects":{{"{o}":{{"hasTrustDialogAccepted":true,"x":[1]}}}},"alpha":{{"b":2,"a":1}}}}"#)).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(inherit(&file, &origin, &dest), Outcome::Granted);
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["projects"][dest.to_string_lossy().as_ref()]["hasTrustDialogAccepted"], Value::Bool(true));
        assert_eq!(v["projects"][o.as_ref()]["x"], serde_json::json!([1]));
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.find("\"zeta\"").unwrap() < text.find("\"projects\"").unwrap() && text.find("\"b\"").unwrap() < text.find("\"a\"").unwrap(), "키 순서가 바뀜: {text}");
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(inherit(&file, &origin, &dest), Outcome::Unchanged);
        assert_eq!(inherit(&file, &other, &dir.join("g2")), Outcome::OriginNotTrusted);
        assert!(!std::fs::read_to_string(&file).unwrap().contains("g2"));
        // 남은 임시 파일·잠금 없음
        let left: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("claude.json")).collect();
        assert_eq!(left, ["claude.json"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // 파일이 없으면 Missing, 모양이 다르면 Failed, 잠금을 누가 쥐고 있으면 Locked (어느 경우도 파일을 바꾸지 않는다).
    // 링크인 설정 파일은 가리키는 파일을 바꾸고 링크는 둔다.
    #[test]
    fn leaves_config_alone_when_unsure() {
        let dir = tmp("unsure");
        let (origin, dest) = (dir.join("proj"), dir.join("group"));
        let file = dir.join("claude.json");
        assert_eq!(inherit(&file, &origin, &dest), Outcome::Missing);
        std::fs::write(&file, r#"{"projects":[]}"#).unwrap();
        assert!(matches!(inherit(&file, &origin, &dest), Outcome::Failed(_)));
        let o = origin.to_string_lossy();
        let body = format!(r#"{{"projects":{{"{o}":{{"hasTrustDialogAccepted":true}}}}}}"#);
        std::fs::write(&file, &body).unwrap();
        std::fs::create_dir(dir.join("claude.json.lock")).unwrap();
        assert_eq!(inherit(&file, &origin, &dest), Outcome::Locked);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), body);
        std::fs::remove_dir(dir.join("claude.json.lock")).unwrap();
        let real = dir.join("real.json");
        std::fs::rename(&file, &real).unwrap();
        crate::platform::symlink(&real, &file).unwrap();
        // 링크면 실제 파일의 잠금도 본다 (리뷰 R1). 잡은 잠금은 푼다
        std::fs::create_dir(dir.join("real.json.lock")).unwrap();
        assert_eq!(inherit(&file, &origin, &dest), Outcome::Locked);
        assert_eq!(std::fs::read_to_string(&real).unwrap(), body);
        assert!(!dir.join("claude.json.lock").exists(), "잡은 잠금을 풀지 않음");
        std::fs::remove_dir(dir.join("real.json.lock")).unwrap();
        assert_eq!(inherit(&file, &origin, &dest), Outcome::Granted);
        assert!(std::fs::symlink_metadata(&file).unwrap().file_type().is_symlink());
        assert!(std::fs::read_to_string(&real).unwrap().contains(dest.to_string_lossy().as_ref()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
