// 프로젝트에 저장소 추가: 원격에서 clone 하거나, 로컬 저장소를 링크로 연결한다.
// 로컬 저장소를 프로젝트 안으로 옮기는 방법은 두지 않는다 (실행 중인 저장소가 끊길 수 있어서).

use crate::fs::{child_path as dest, code_err as err, git_kind, CodeError};
use std::process::{Command, Stdio};

#[tauri::command]
pub fn repo_link(project: String, target: String, name: String) -> Result<String, CodeError> {
    let real = std::fs::canonicalize(&target).map_err(|_| err("notFound", &target))?;
    if git_kind(&real).is_none() {
        return Err(err("notRepo", &target));
    }
    let project_real = std::fs::canonicalize(&project).map_err(|_| err("notFound", &project))?;
    if real.starts_with(&project_real) {
        return Err(err("insideProject", &target));
    }
    let dest = dest(&project, &name)?;
    std::os::unix::fs::symlink(&real, &dest).map_err(|e| err("io", e))?;
    Ok(dest.to_string_lossy().into_owned())
}

// clone은 오래 걸릴 수 있어 async + 별도 스레드. 비밀번호·호스트 키 확인을 물을 터미널이 없으므로
// 묻는 대신 실패하게 한다 (그때는 터미널에서 직접 clone).
#[tauri::command]
pub async fn repo_clone(project: String, url: String, name: String) -> Result<String, CodeError> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err(err("badUrl", ""));
    }
    let dest = dest(&project, &name)?;
    let target = dest.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("git");
        // "--": URL이 "-"로 시작해도 옵션으로 읽히지 않게
        cmd.args(["clone", "--"]).arg(&url).arg(&target);
        cmd.env("GIT_TERMINAL_PROMPT", "0").stdin(Stdio::null());
        if std::env::var_os("GIT_SSH_COMMAND").is_none() {
            cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
        }
        cmd.output()
    })
    .await
    .map_err(|e| err("io", e))?
    .map_err(|e| err("io", e))?;
    if !out.status.success() {
        return Err(err("git", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_checks() {
        let base = std::env::temp_dir().join(format!("ddak-repos-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let project = base.join("proj");
        std::fs::create_dir_all(project.join("inner/.git")).unwrap();
        std::fs::create_dir_all(base.join("repo/.git")).unwrap();
        std::fs::create_dir_all(base.join("plain")).unwrap();
        let p = project.to_string_lossy().into_owned();
        let s = |x: &str| base.join(x).to_string_lossy().into_owned();
        let code = |r: Result<String, CodeError>| r.unwrap_err().code;

        assert_eq!(code(repo_link(p.clone(), s("plain"), "plain".into())), "notRepo");
        assert_eq!(code(repo_link(p.clone(), s("nope"), "nope".into())), "notFound");
        assert_eq!(code(repo_link(p.clone(), s("proj/inner"), "x".into())), "insideProject");
        assert_eq!(code(repo_link(p.clone(), s("repo"), "a/b".into())), "badName");
        assert_eq!(code(repo_link(p.clone(), s("repo"), "..".into())), "badName");
        assert_eq!(code(repo_link(p.clone(), s("repo"), "inner".into())), "exists");

        let made = repo_link(p.clone(), s("repo"), " linked ".into()).unwrap();
        assert_eq!(std::fs::read_link(&made).unwrap(), std::fs::canonicalize(base.join("repo")).unwrap());
        assert_eq!(code(repo_link(p, s("repo"), "linked".into())), "exists");
        std::fs::remove_dir_all(&base).unwrap();
    }
}
