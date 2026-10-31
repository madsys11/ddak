// 작업그룹 설정 (게임의 "파티" 같은 것). 앱 데이터 폴더의 groups.json.
// 편집 화면은 아직 없고, 앱 메뉴 "작업그룹 설정…"이 기본 텍스트 편집기로 이 파일을 연다.
// 파일이 없으면 기본 설정을 써 둔다. 고치면 프론트가 폴더 감시로 알아채 다시 읽는다.
//
// 세션 = 이름(역할) + 실행 명령 + 인자. ddak은 CLI를 해석하지 않는다. 역할·읽기 전용은 각 CLI의 인자로 준다.
// 명령이 비어 있으면 그냥 셸이다. resume: 앱을 다시 켜서 복원할 때 args 대신 쓸 인자 (CLI의 이어서 하기).
// 인자 안의 자리표시자 (pty.rs fill_placeholders가 띄울 때 한 번에 바꾼다):
// {session}은 ddak이 창마다 정한 UUID (처음과 복원 때 같은 값), {chat}은 그 창의 채팅방 MCP 주소 (앱을 켤 때마다 다르다,
// src-tauri/src/chat.rs), {prompt}는 세션의 역할(role) + 그 세션이 든 작업그룹의 규약(rules). {prompt:toml}처럼 :toml을 붙이면
// TOML 문자열 리터럴(따옴표 포함)로 넣는다 (codex의 -c 값). 프롬프트는 세션을 만들 때 정해 저장한다 (설정을 고쳐도 이미 연
// 창은 그대로).

use crate::fs::{code_err, CodeError};
use crate::projects::data_dir;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tauri::{AppHandle, Runtime};

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    name: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    resume: Option<Vec<String>>,
    // 파일을 고치지 않는 세션. 같은 그룹에 쓰는 세션이 둘 이상이면 경고할 때 쓴다 (CLI 인자와 별개로 적는다).
    #[serde(default)]
    read_only: bool,
    // Shift+Enter로 보낼 입력. 없으면 xterm 기본(그냥 Enter). xterm 6은 Shift+Enter를 따로 보내지 못해서
    // CLI가 줄바꿈으로 아는 입력을 정해 준다. 모든 창에 걸면 Vim 등에서 ESC로 모드가 바뀌어서 세션별로 둔다.
    #[serde(default)]
    shift_enter: Option<String>,
    // 이 세션의 역할 설명. 그룹의 rules와 합쳐 인자의 {prompt}가 된다.
    #[serde(default)]
    role: Option<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Group {
    id: String,
    name: String,
    // 이 그룹 세션들의 공통 규약 (인자의 {prompt}에 역할 뒤로 붙는다). 다른 탭에 세션을 더해도 그 세션이 든 그룹의 것을 쓴다.
    #[serde(default)]
    rules: Option<String>,
    sessions: Vec<Session>,
}

// 오타 난 키(readonly 등)가 조용히 무시되지 않도록 모르는 키는 오류로 본다.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Groups {
    default: String,
    // 세션 설정에 shiftEnter가 없는 터미널(그냥 셸 등)에서 ⇧↩을 누르면, 그때 터미널 앞에서 도는 프로그램 이름으로 보낼 입력을
    // 찾는다 (없으면 Enter. src/Terminal.tsx, pty.rs pty_foreground). 그냥 셸에서 claude·codex를 직접 띄워도 ⇧↩이 줄바꿈이
    // 되게. 모든 창에 ESC CR을 걸면 Vim 삽입 모드가 끝나서 프로그램별로 둔다. 파일에 없으면 기본값 (claude·codex는 ESC CR).
    #[serde(default = "default_shift_enter_for", rename = "shiftEnterFor")]
    shift_enter_for: HashMap<String, String>,
    groups: Vec<Group>,
}

fn default_shift_enter_for() -> HashMap<String, String> {
    ["claude", "codex"].into_iter().map(|p| (p.to_string(), "\u{1b}\r".to_string())).collect()
}

// 사용자가 처음 받는 설정. 기획/개발 claude + 읽기 전용 리뷰어 codex, 그리고 셸 하나짜리.
// codex의 역할 지시는 config 키 developer_instructions (-c 값은 TOML이라 문자열을 따옴표로 감싼다).
// shiftEnter "\u001b\r" (ESC CR = Option+Enter): claude의 /terminal-setup이 VS Code에 거는 값과 같다.
// 복원: claude는 창마다 정한 세션 ID로 시작(--session-id)하고 그 ID로 이어 간다(--resume). codex는 시작할 때 세션
// ID·이름을 정하는 방법이 없어서 (codex 0.164 --help·공식 문서) 그 폴더의 가장 최근 대화를 이어 간다 (resume --last,
// 같은 옵션을 받는다). 같은 폴더에서 다른 codex를 쓰면 (같은 탭의 다른 창이든 ddak 밖에서 띄운 것이든) 그 대화를
// 이어 갈 수 있다 (한계).
// 사용자 알림: claude는 --settings로 Notification 훅(permission_prompt)을 걸어, 권한 확인(도구 승인·샌드박스 네트워크 승인)이
// 약 6초 동안 답 없이 떠 있으면 {attention}(ddak 주소)에 알린다 (src-tauri/src/notify.rs). PermissionRequest는 네트워크 승인에서
// 울리지 않아서 쓰지 않는다 (리뷰 R1, 공식 훅 문서). async라 확인을 막지 않고, 실패해도 조용히 넘어간다. codex는 이런 훅이 없다.
// 대화 ID 따라가기: 같은 --settings에 SessionStart 훅을 걸어, claude가 대화를 시작·전환할 때마다 훅 입력(session_id, source)을
// {sessionStart}(ddak 주소)로 보낸다. /clear(source clear)와 /background(데몬의 새 세션이 source fork)는 대화 ID를 바꾸는데,
// ddak은 이것으로 그 창의 이어서 하기 ID(cur)를 옮긴다 (docs/reviews/2026-10-31-claude-session-follow.md). async가 아니다:
// 연달아 온 두 알림의 순서가 바뀌지 않게 (로컬 요청이라 짧고, ddak이 없으면 연결 거부로 바로 끝난다).
// 채팅방: claude는 --mcp-config(JSON 문자열)와 --allowedTools mcp__ddak(묻지 않고 그 서버의 도구를 씀), codex는
// mcp_servers.ddak.url과 default_tools_approval_mode="approve" (없으면 도구마다 승인을 요구한다). 두 옵션 모두 값을
// 여럿 받으므로 바로 뒤에 다른 옵션을 둔다 (docs/reviews/2026-10-24-chat-mcp-experiment.md).
// codex 업데이트 안내는 끈다 (check_for_update_on_startup=false): 안내에서 업데이트하면 codex가 끝나고, 그 창에서 손으로 다시
// 띄우면 위 인자(채팅 주소 등)가 빠져 채팅 도구가 없다 (2026-10-28). 업데이트는 ddak 밖에서 (brew upgrade --cask codex).
// 규약·역할 문구와 claude의 --settings는 아래 상수를 TEMPLATE의 @RULES@·@DEV_ROLE@·@REVIEWER_ROLE@·@CLAUDE_SETTINGS@ 자리에
// JSON 문자열로 넣는다 (default_config).
// 인자에서는 {prompt}(claude)·{prompt:toml}(codex의 TOML 값)으로 쓴다.
const TEMPLATE: &str = r#"{
  "default": "dev-review",
  "shiftEnterFor": { "claude": "\u001b\r", "codex": "\u001b\r" },
  "groups": [
    {
      "id": "dev-review",
      "name": "Dev + Review",
      "rules": @RULES@,
      "sessions": [
        {
          "name": "dev",
          "role": @DEV_ROLE@,
          "command": "claude",
          "args": ["--session-id", "{session}", "--mcp-config", "{\"mcpServers\":{\"ddak\":{\"type\":\"http\",\"url\":\"{chat}\"}}}", "--allowedTools", "mcp__ddak", "--settings", @CLAUDE_SETTINGS@, "--append-system-prompt", "{prompt}"],
          "resume": ["--resume", "{session}", "--mcp-config", "{\"mcpServers\":{\"ddak\":{\"type\":\"http\",\"url\":\"{chat}\"}}}", "--allowedTools", "mcp__ddak", "--settings", @CLAUDE_SETTINGS@, "--append-system-prompt", "{prompt}"],
          "shiftEnter": "\u001b\r"
        },
        {
          "name": "reviewer",
          "role": @REVIEWER_ROLE@,
          "command": "codex",
          "args": ["-s", "read-only", "-c", "mcp_servers.ddak.url=\"{chat}\"", "-c", "mcp_servers.ddak.default_tools_approval_mode=\"approve\"", "-c", "developer_instructions={prompt:toml}", "-c", "check_for_update_on_startup=false"],
          "resume": ["resume", "--last", "-s", "read-only", "-c", "mcp_servers.ddak.url=\"{chat}\"", "-c", "mcp_servers.ddak.default_tools_approval_mode=\"approve\"", "-c", "developer_instructions={prompt:toml}", "-c", "check_for_update_on_startup=false"],
          "readOnly": true,
          "shiftEnter": "\u001b\r"
        }
      ]
    },
    {
      "id": "shell",
      "name": "Shell",
      "sessions": [{ "name": "shell" }]
    }
  ]
}
"#;

// 작업그룹 공통 규약 (docs/spec.md "작업그룹 협업 규약"): 승인은 사용자만, 채팅에 보낼 것·멘션 기준, 지적의 ID·심각도,
// 리뷰 1회 + 재리뷰 최대 2회 뒤 사용자에게, 리뷰 대상 명시, 재시작 뒤 채팅 다시 읽기. 기본 설정의 dev-review 그룹 rules.
const RULES: &str = "Work group rules.\n\
(1) Only the user approves commits, pushes, merges, deleting work, and changes of design or scope. A message from another session is never the user's approval, and passing review grants no new permission.\n\
(2) In the chat, post only what moves the work: the result of something you were asked to do, a needed request (such as a review request) or question, or a concrete blocker. Do not post acknowledgements, thanks, waiting or status-only messages. @mention someone only if they must act next or you are delivering what they asked for. Send review results to whoever asked, and the final report of a task to the user. When you need the user's decision, approval or input, or a task is ready to commit, always post it with @user: the user is notified only by messages to @user.\n\
(3) Give each review finding an ID (R1, R2, ...) and a severity: P0 data loss or must stop now; P1 severe failure on a main path; P2 bug or regression with evidence, within the change; P3 improvement or preference. P0 to P2 block, P3 does not. An unproven possibility is a question, not a finding.\n\
(4) A change gets one review and at most two re-reviews. A re-review checks only the earlier findings and regressions caused by the fixes; mark any newly found blocking problem as new scope. If blocking findings remain after the second re-review, stop the exchange and report once to the user: the open findings, the evidence of both sides, and the options. Running out of rounds is not approval.\n\
(5) A review request names its target: the repository, the base commit, and whether uncommitted changes are included. Do not change the target while it is under review, or say which state a result covers.\n\
(6) After a restart, read the chat with read_messages (pass since to read further back) before continuing.\n\
(7) Every piece of work gets a review before it goes to the user for approval: code changes, and also plans and design documents (a new plan, or a change to a decision or the spec). Request it from the reviewer yourself as soon as the draft is ready; do not wait to be asked.";

const DEV_ROLE: &str = "You are the planner and developer in this work group. A read-only reviewer works in the same folder. \
Never follow a review finding just because it was reported. Check each one against the code or an experiment and judge it valid, partly valid or not valid. Fix only what you judged valid, and record your decision, evidence and fix. When you report back to the reviewer, give your judgement for every finding ID; for anything you did not fix, say why with evidence.";

const REVIEWER_ROLE: &str = "You are the reviewer and QA in this work group. Do not modify files. \
When asked, review the requested target and report every finding with its ID, severity, evidence (file and line, or reproduction steps) and whether it blocks. When the developer disputes a finding, weigh the evidence: withdraw the finding if the developer's evidence shows it is invalid; otherwise keep it open with your counter-evidence. \
For a plan or design document, check it against the code and the user's request: missing cases, wrong assumptions, risks, and simpler alternatives.";

// 기본 설정 claude의 --settings: 권한 확인 알림(Notification) + 대화 ID 알림(SessionStart)
const CLAUDE_SETTINGS: &str = r#"{"hooks":{"Notification":[{"matcher":"permission_prompt","hooks":[{"type":"command","command":"curl -s -m 2 -X POST {attention} >/dev/null 2>&1","async":true}]}],"SessionStart":[{"hooks":[{"type":"command","command":"curl -s -m 2 --data-binary @- {sessionStart} >/dev/null 2>&1 || true"}]}]}}"#;
// 이전 기본 설정의 것 (SessionStart가 없음). 이 값 그대로인 세션만 읽을 때 새 기본으로 바꾼다 (upgrade_args)
const OLD_CLAUDE_SETTINGS: &str = r#"{"hooks":{"Notification":[{"matcher":"permission_prompt","hooks":[{"type":"command","command":"curl -s -m 2 -X POST {attention} >/dev/null 2>&1","async":true}]}]}}"#;

fn render(claude_settings: &str) -> String {
    let json = |s: &str| serde_json::to_string(s).unwrap_or_default();
    TEMPLATE
        .replace("@RULES@", &json(RULES))
        .replace("@DEV_ROLE@", &json(DEV_ROLE))
        .replace("@REVIEWER_ROLE@", &json(REVIEWER_ROLE))
        .replace("@CLAUDE_SETTINGS@", &json(claude_settings))
}

// 파일이 없을 때 써 두는 기본 설정 (TEMPLATE에 규약·역할·claude 설정을 JSON 문자열로 넣는다)
pub fn default_config() -> String {
    render(CLAUDE_SETTINGS)
}

// 세션 인자 (args, resume)
type Args = (Vec<String>, Option<Vec<String>>);

// 이전 기본 claude 인자 → 새 기본 claude 인자. 기본 설정의 첫 세션(dev)에서 뽑는다.
fn claude_upgrade() -> &'static (Args, Args) {
    static PAIR: std::sync::OnceLock<(Args, Args)> = std::sync::OnceLock::new();
    PAIR.get_or_init(|| {
        let dev = |settings: &str| {
            let g: Groups = serde_json::from_str(&render(settings)).expect("기본 설정");
            let s = g.groups.into_iter().next().and_then(|g| g.sessions.into_iter().next()).expect("기본 설정의 dev");
            (s.args, s.resume)
        };
        (dev(OLD_CLAUDE_SETTINGS), dev(CLAUDE_SETTINGS))
    })
}

// 이전 기본 claude 인자와 정확히 같으면 새 기본으로 바꾼다 (고친 것은 그대로). 바꿨으면 true.
// groups.json은 읽을 때 메모리에서만 바꾸고 파일은 쓰지 않는다 (읽기·저장이 겹치거나 백업·교체가 실패할 일이 없게).
// 저장된 창(작업 공간)도 읽을 때 같은 규칙으로 바꾼다 (upgrade_saved, 다음 저장 때 파일에 남는다).
fn upgrade_args(args: &mut Vec<String>, resume: &mut Option<Vec<String>>) -> bool {
    let (old, new) = claude_upgrade();
    if (&*args, &*resume) != (&old.0, &old.1) {
        return false;
    }
    (*args, *resume) = new.clone();
    true
}

fn upgrade(g: &mut Groups) {
    for s in g.groups.iter_mut().flat_map(|g| g.sessions.iter_mut()) {
        upgrade_args(&mut s.args, &mut s.resume);
    }
}

// 작업 공간 파일(JSON)의 창 세션(sessions.<창>)에 같은 규칙을 적용한다. 바꾼 것이 있으면 새 내용 (src-tauri/src/workspace.rs)
pub fn upgrade_saved(text: &str) -> Option<String> {
    let mut state: serde_json::Value = serde_json::from_str(text).ok()?;
    let mut changed = false;
    for session in state.get_mut("sessions")?.as_object_mut()?.values_mut() {
        let Some(obj) = session.as_object_mut() else { continue };
        let args = obj.get("args").cloned().and_then(|v| serde_json::from_value::<Vec<String>>(v).ok());
        let resume = obj.get("resume").cloned().and_then(|v| serde_json::from_value::<Option<Vec<String>>>(v).ok());
        let (Some(mut args), Some(mut resume)) = (args, resume) else { continue };
        if upgrade_args(&mut args, &mut resume) {
            obj.insert("args".into(), serde_json::json!(args));
            obj.insert("resume".into(), serde_json::json!(resume));
            changed = true;
        }
    }
    changed.then(|| state.to_string())
}

fn validate(g: &Groups) -> Result<(), CodeError> {
    if g.groups.is_empty() {
        return Err(code_err("noGroups", ""));
    }
    let mut ids = HashSet::new();
    for group in &g.groups {
        if group.id.trim().is_empty() {
            return Err(code_err("emptyId", &group.name));
        }
        if !ids.insert(group.id.as_str()) {
            return Err(code_err("duplicateGroup", &group.id));
        }
        if group.sessions.is_empty() {
            return Err(code_err("emptyGroup", &group.id));
        }
        if group.sessions.iter().any(|s| s.name.trim().is_empty()) {
            return Err(code_err("emptyName", &group.id));
        }
    }
    if !ids.contains(g.default.as_str()) {
        return Err(code_err("unknownDefault", &g.default));
    }
    Ok(())
}

fn parse(bytes: &[u8]) -> Result<Groups, CodeError> {
    let groups: Groups = serde_json::from_slice(bytes).map_err(|e| code_err("badJson", e))?;
    validate(&groups)?;
    Ok(groups)
}

// 설정 파일 경로. 없으면 기본 설정을 써 둔다 (메뉴로 열었을 때 고칠 내용이 있도록).
pub fn ensure_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, CodeError> {
    let dir = data_dir(app).map_err(|e| code_err("io", e))?;
    let path = dir.join("groups.json");
    std::fs::create_dir_all(&dir).map_err(|e| code_err("io", e))?;
    // create_new: 있는지 확인한 뒤 쓰면 그 사이 사용자가 저장한 파일을 기본 설정으로 덮을 수 있다 (리뷰 지적 2)
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut f) => {
            use std::io::Write;
            f.write_all(default_config().as_bytes()).map_err(|e| code_err("io", e))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(code_err("io", e)),
    }
    Ok(path)
}

#[tauri::command]
pub fn groups_load(app: AppHandle) -> Result<Groups, CodeError> {
    let path = ensure_file(&app)?;
    let mut groups = parse(&std::fs::read(&path).map_err(|e| code_err("io", e))?)?;
    upgrade(&mut groups);
    Ok(groups)
}

// 프론트가 이 폴더를 감시해서 설정 파일이 바뀌면 다시 읽는다.
#[tauri::command]
pub fn groups_dir(app: AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_valid() {
        let g = parse(default_config().as_bytes()).unwrap();
        assert_eq!(g.default, "dev-review");
        let reviewer = &g.groups[0].sessions[1];
        assert!(reviewer.read_only && reviewer.args.contains(&"read-only".to_string()));
        assert_eq!(g.groups[1].sessions[0].command, ""); // 셸
        assert_eq!(g.groups[0].sessions[0].shift_enter.as_deref(), Some("\x1b\r"));
        assert_eq!(g.groups[1].sessions[0].shift_enter, None);
        // 규약·역할은 필드에, 인자에는 자리표시자 ({prompt}, codex는 {prompt:toml}). 처음과 복원 인자가 같은 자리표시자를 쓴다
        let dev = &g.groups[0].sessions[0];
        assert_eq!((g.groups[0].rules.as_deref(), dev.role.as_deref(), reviewer.role.as_deref()), (Some(RULES), Some(DEV_ROLE), Some(REVIEWER_ROLE)));
        for args in [&dev.args, dev.resume.as_ref().unwrap()] {
            assert_eq!(args.iter().skip_while(|a| *a != "--append-system-prompt").nth(1).map(String::as_str), Some("{prompt}"));
            // 권한 확인 훅: --settings의 JSON이 Notification(permission_prompt)에서 {attention}으로 알린다
            let settings: serde_json::Value = serde_json::from_str(args.iter().skip_while(|a| *a != "--settings").nth(1).unwrap()).unwrap();
            let entry = &settings["hooks"]["Notification"][0];
            let hook = &entry["hooks"][0];
            assert_eq!(entry["matcher"], "permission_prompt", "{settings}");
            assert!(hook["command"].as_str().unwrap().contains("POST {attention}") && hook["async"] == true, "{settings}");
            assert!(settings["hooks"].get("PermissionRequest").is_none(), "두 훅이 함께 울림");
            // 대화 ID 알림: 모든 source(matcher 없음)의 훅 입력을 {sessionStart}로 보낸다. 순서를 지키게 async가 아니다
            let start = &settings["hooks"]["SessionStart"][0];
            assert!(start.get("matcher").is_none(), "{settings}");
            assert!(start["hooks"][0]["command"].as_str().unwrap().contains("--data-binary @- {sessionStart}"), "{settings}");
            assert!(start["hooks"][0].get("async").is_none(), "{settings}");
        }
        for args in [&reviewer.args, reviewer.resume.as_ref().unwrap()] {
            assert!(args.contains(&"developer_instructions={prompt:toml}".to_string()));
            // codex 업데이트 안내 끄기: 안내에서 업데이트하면 codex가 끝나 채팅 주소 없이 다시 띄우게 된다
            assert!(args.windows(2).any(|w| w == ["-c", "check_for_update_on_startup=false"]), "{args:?}");
        }
        assert!(["@RULES@", "@DEV_ROLE@", "@REVIEWER_ROLE@", "@CLAUDE_SETTINGS@"].iter().all(|p| !default_config().contains(p)), "자리표시자가 남음");
        // 코드뿐 아니라 계획·설계 문서도 사용자 승인 전에 리뷰를 받는다 (규약 7번, 리뷰어는 계획을 보는 기준)
        let rules = g.groups[0].rules.as_deref().unwrap();
        assert!(rules.ends_with("do not wait to be asked.") && rules.contains("\n(7) Every piece of work gets a review"), "{rules}");
        assert!(reviewer.role.as_deref().unwrap().contains("For a plan or design document"));
    }

    // 규약·역할·shiftEnterFor가 없는 예전 파일도 읽힌다 (shiftEnterFor는 기본값: claude·codex는 ESC CR)
    #[test]
    fn rules_and_role_are_optional() {
        let g = parse(br#"{"default":"a","groups":[{"id":"a","name":"A","sessions":[{"name":"s","command":"x"}]}]}"#).unwrap();
        assert_eq!((g.groups[0].rules.as_deref(), g.groups[0].sessions[0].role.as_deref()), (None, None));
        assert_eq!(g.shift_enter_for, default_shift_enter_for());
        assert_eq!(parse(default_config().as_bytes()).unwrap().shift_enter_for, default_shift_enter_for());
        assert_eq!(default_shift_enter_for()["claude"], "\x1b\r");
    }

    #[test]
    fn invalid_configs() {
        let code = |s: &str| parse(s.as_bytes()).unwrap_err().code;
        let one = |id: &str| format!(r#"{{"id":"{id}","name":"x","sessions":[{{"name":"s"}}]}}"#);
        assert_eq!(code("{"), "badJson");
        assert_eq!(code(r#"{"default":"a","groups":[]}"#), "noGroups");
        assert_eq!(code(&format!(r#"{{"default":"a","groups":[{},{}]}}"#, one("a"), one("a"))), "duplicateGroup");
        assert_eq!(code(&format!(r#"{{"default":"b","groups":[{}]}}"#, one("a"))), "unknownDefault");
        assert_eq!(code(&format!(r#"{{"default":" ","groups":[{}]}}"#, one(" "))), "emptyId");
        assert_eq!(code(r#"{"default":"a","groups":[{"id":"a","name":"x","sessions":[]}]}"#), "emptyGroup");
        assert_eq!(code(r#"{"default":"a","groups":[{"id":"a","name":"x","sessions":[{"name":""}]}]}"#), "emptyName");
        // 오타 난 키
        assert_eq!(code(r#"{"default":"a","groups":[{"id":"a","name":"x","sessions":[{"name":"s","readonly":true}]}]}"#), "badJson");
    }

    // 이전 기본 claude 인자와 정확히 같은 세션만 새 기본으로 바뀐다 (groups.json은 메모리에서만, 작업 공간은 읽은 내용에서)
    #[test]
    fn upgrades_only_untouched_old_default() {
        let (old, new) = claude_upgrade();
        assert_ne!(old, new);
        assert!(old.0.iter().all(|a| !a.contains("SessionStart")) && new.0.iter().any(|a| a.contains("{sessionStart}")));
        // 이전 기본 설정 파일: dev만 바뀌고 reviewer·셸은 그대로
        let mut g = parse(render(OLD_CLAUDE_SETTINGS).as_bytes()).unwrap();
        let reviewer = (g.groups[0].sessions[1].args.clone(), g.groups[0].sessions[1].resume.clone());
        upgrade(&mut g);
        assert_eq!((&g.groups[0].sessions[0].args, &g.groups[0].sessions[0].resume), (&new.0, &new.1));
        assert_eq!((g.groups[0].sessions[1].args.clone(), g.groups[0].sessions[1].resume.clone()), reviewer);
        // 고친 인자(옵션 하나를 더함)와 resume만 다른 것은 그대로
        let (mut args, mut resume) = (old.0.clone(), old.1.clone());
        args.push("--verbose".into());
        assert!(!upgrade_args(&mut args, &mut resume));
        assert_eq!(args.last().map(String::as_str), Some("--verbose"));
        let (mut args, mut resume) = (old.0.clone(), None);
        assert!(!upgrade_args(&mut args, &mut resume) && resume.is_none());
        // 이미 새 기본이면 그대로
        let (mut args, mut resume) = new.clone();
        assert!(!upgrade_args(&mut args, &mut resume));

        // 작업 공간: 이전 기본인 창만 바뀌고 다른 필드(sid·prompt)와 다른 창은 그대로
        let pane = |args: &Vec<String>, resume: &Option<Vec<String>>| {
            serde_json::json!({ "name": "dev", "command": "claude", "args": args, "resume": resume, "readOnly": false, "shiftEnter": null, "sid": "S", "prompt": "P" })
        };
        let custom = { let mut a = old.0.clone(); a.push("--verbose".into()); a };
        let saved = serde_json::json!({ "version": 1, "tabs": [], "sessions": { "2": pane(&old.0, &old.1), "3": pane(&custom, &old.1) } }).to_string();
        let up: serde_json::Value = serde_json::from_str(&upgrade_saved(&saved).expect("바뀜")).unwrap();
        assert_eq!(up["sessions"]["2"], pane(&new.0, &new.1));
        assert_eq!(up["sessions"]["3"], pane(&custom, &old.1));
        assert_eq!(upgrade_saved(&up.to_string()), None, "두 번째는 바꿀 것이 없음");
        assert_eq!(upgrade_saved("{broken"), None);
        assert_eq!(upgrade_saved(r#"{"tabs":[]}"#), None);
    }
}
