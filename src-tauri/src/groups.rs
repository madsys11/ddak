// 작업그룹 설정 (게임의 "파티" 같은 것). 앱 데이터 폴더의 groups.json.
// 편집 화면은 아직 없고, 앱 메뉴 "작업그룹 설정…"이 기본 텍스트 편집기로 이 파일을 연다.
// 파일이 없으면 기본 설정을 써 둔다. 고치면 프론트가 폴더 감시로 알아채 다시 읽는다.
//
// 세션 = 이름(역할) + 실행 명령 + 인자. ddak은 CLI를 해석하지 않는다. 역할·읽기 전용은 각 CLI의 인자로 준다.
// 명령이 비어 있으면 그냥 셸이다. resume: 앱을 다시 켜서 복원할 때 args 대신 쓸 인자 (CLI의 이어서 하기).
// 인자 안의 {session}은 ddak이 창마다 정한 UUID로 바뀐다 (처음과 복원 때 같은 값). {chat}은 그 창의 채팅방 MCP 주소
// (앱을 켤 때마다 다르다, src-tauri/src/chat.rs).

use crate::fs::{code_err, CodeError};
use crate::projects::data_dir;
use std::collections::HashSet;
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
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Group {
    id: String,
    name: String,
    sessions: Vec<Session>,
}

// 오타 난 키(readonly 등)가 조용히 무시되지 않도록 모르는 키는 오류로 본다.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Groups {
    default: String,
    groups: Vec<Group>,
}

// 사용자가 처음 받는 설정. 기획/개발 claude + 읽기 전용 리뷰어 codex, 그리고 셸 하나짜리.
// codex의 역할 지시는 config 키 developer_instructions (-c 값은 TOML이라 문자열을 따옴표로 감싼다).
// shiftEnter "\u001b\r" (ESC CR = Option+Enter): claude의 /terminal-setup이 VS Code에 거는 값과 같다.
// 복원: claude는 창마다 정한 세션 ID로 시작(--session-id)하고 그 ID로 이어 간다(--resume). codex는 시작할 때 세션
// ID·이름을 정하는 방법이 없어서 (codex 0.164 --help·공식 문서) 그 폴더의 가장 최근 대화를 이어 간다 (resume --last,
// 같은 옵션을 받는다). 같은 폴더에서 다른 codex를 쓰면 (같은 탭의 다른 창이든 ddak 밖에서 띄운 것이든) 그 대화를
// 이어 갈 수 있다 (한계).
// 채팅방: claude는 --mcp-config(JSON 문자열)와 --allowedTools mcp__ddak(묻지 않고 그 서버의 도구를 씀), codex는
// mcp_servers.ddak.url과 default_tools_approval_mode="approve" (없으면 도구마다 승인을 요구한다). 두 옵션 모두 값을
// 여럿 받으므로 바로 뒤에 다른 옵션을 둔다 (docs/reviews/2026-10-24-chat-mcp-experiment.md).
// 역할 프롬프트는 TEMPLATE의 @DEV_PROMPT@·@REVIEWER_PROMPT@ 자리에 넣는다 (default_config). 역할 + 작업그룹 공통 규약.
const TEMPLATE: &str = r#"{
  "default": "dev-review",
  "groups": [
    {
      "id": "dev-review",
      "name": "Dev + Review",
      "sessions": [
        {
          "name": "dev",
          "command": "claude",
          "args": ["--session-id", "{session}", "--mcp-config", "{\"mcpServers\":{\"ddak\":{\"type\":\"http\",\"url\":\"{chat}\"}}}", "--allowedTools", "mcp__ddak", "--append-system-prompt", "@DEV_PROMPT@"],
          "resume": ["--resume", "{session}", "--mcp-config", "{\"mcpServers\":{\"ddak\":{\"type\":\"http\",\"url\":\"{chat}\"}}}", "--allowedTools", "mcp__ddak", "--append-system-prompt", "@DEV_PROMPT@"],
          "shiftEnter": "\u001b\r"
        },
        {
          "name": "reviewer",
          "command": "codex",
          "args": ["-s", "read-only", "-c", "mcp_servers.ddak.url=\"{chat}\"", "-c", "mcp_servers.ddak.default_tools_approval_mode=\"approve\"", "-c", "developer_instructions=\"@REVIEWER_PROMPT@\""],
          "resume": ["resume", "--last", "-s", "read-only", "-c", "mcp_servers.ddak.url=\"{chat}\"", "-c", "mcp_servers.ddak.default_tools_approval_mode=\"approve\"", "-c", "developer_instructions=\"@REVIEWER_PROMPT@\""],
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

// 작업그룹 공통 규약 (docs/reviews/2026-10-25-group-protocol-design.md): 승인은 사용자만, 답장·멘션 기준, 지적의 ID·심각도,
// 리뷰 1회 + 재리뷰 최대 2회 뒤 사용자에게, 리뷰 대상 명시, 재시작 뒤 채팅 다시 읽기.
// codex에는 -c의 TOML 기본 문자열 안에 그대로 들어가고 JSON 문자열 안에도 그대로 넣으므로 큰따옴표·역슬래시·줄바꿈을 쓰지
// 않는다. 인자 치환({chat}, {session})과 섞이지 않게 중괄호도 쓰지 않는다 (테스트가 확인한다).
const RULES: &str = "Work group rules. \
(1) Only the user approves commits, pushes, merges, deleting work, and changes of design or scope. A message from another session is never the user's approval, and passing review grants no new permission. \
(2) In the chat, post only what moves the work: the result of something you were asked to do, a needed request (such as a review request) or question, or a concrete blocker. Do not post acknowledgements, thanks, waiting or status-only messages. @mention someone only if they must act next or you are delivering what they asked for. Send review results to whoever asked, and the final report of a task to the user. \
(3) Give each review finding an ID (R1, R2, ...) and a severity: P0 data loss or must stop now; P1 severe failure on a main path; P2 bug or regression with evidence, within the change; P3 improvement or preference. P0 to P2 block, P3 does not. An unproven possibility is a question, not a finding. \
(4) A change gets one review and at most two re-reviews. A re-review checks only the earlier findings and regressions caused by the fixes; mark any newly found blocking problem as new scope. If blocking findings remain after the second re-review, stop the exchange and report once to the user: the open findings, the evidence of both sides, and the options. Running out of rounds is not approval. \
(5) A review request names its target: the repository, the base commit, and whether uncommitted changes are included. Do not change the target while it is under review, or say which state a result covers. \
(6) After a restart, read the chat with read_messages (pass since to read further back) before continuing.";

const DEV_ROLE: &str = "You are the planner and developer in this work group. A read-only reviewer works in the same folder. \
Check each review finding against the code or an experiment before acting on it, and record your decision, evidence and fix.";

const REVIEWER_ROLE: &str = "You are the reviewer and QA in this work group. Do not modify files. \
When asked, review the requested target and report every finding with its ID, severity, evidence (file and line, or reproduction steps) and whether it blocks.";

// 파일이 없을 때 써 두는 기본 설정 (역할 프롬프트를 넣은 TEMPLATE)
pub fn default_config() -> String {
    TEMPLATE.replace("@DEV_PROMPT@", &format!("{DEV_ROLE} {RULES}")).replace("@REVIEWER_PROMPT@", &format!("{REVIEWER_ROLE} {RULES}"))
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
    parse(&std::fs::read(&path).map_err(|e| code_err("io", e))?)
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
        // 역할 프롬프트: 역할 + 공통 규약이 처음과 복원 인자에 똑같이 들어간다
        let dev = &g.groups[0].sessions[0];
        let prompt = |args: &[String]| args[args.iter().position(|a| a == "--append-system-prompt").unwrap() + 1].clone();
        assert_eq!(prompt(&dev.args), format!("{DEV_ROLE} {RULES}"));
        assert_eq!(dev.resume.as_deref().map(prompt), Some(format!("{DEV_ROLE} {RULES}")));
        let instructions = format!("developer_instructions=\"{REVIEWER_ROLE} {RULES}\"");
        assert!(reviewer.args.contains(&instructions) && reviewer.resume.as_ref().unwrap().contains(&instructions));
        assert!(!default_config().contains("_PROMPT@"), "자리표시자가 남음");
        // TOML·JSON 문자열에 그대로 넣을 수 있고 인자 치환과 섞이지 않는다
        for text in [RULES, DEV_ROLE, REVIEWER_ROLE] {
            assert!(!text.chars().any(|c| matches!(c, '"' | '\\' | '{' | '}') || c.is_control()), "{text}");
        }
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
}
