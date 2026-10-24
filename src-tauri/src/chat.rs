// 프로젝트 채팅방 (docs/spec.md "채팅방 설계"). 프로젝트마다 방이 하나이고, 사용자와 ddak이 띄운 세션이 참여한다.
//
// - 세션은 MCP로 참여한다. ddak이 127.0.0.1의 빈 포트에 MCP 서버(streamable HTTP)를 띄우고, 세션을 띄울 때 창마다
//   토큰을 만들어 인자 안의 {chat}을 그 창의 주소(http://127.0.0.1:<포트>/mcp/<토큰>)로 바꾼다 (pty_spawn). 주소로
//   누가 보냈는지 안다. 터미널을 닫으면 참여자에서 빠진다. ddak은 CLI를 해석하지 않는다: MCP를 붙이는 인자는 설정에 있다.
// - 참여자 이름은 `작업그룹/역할` (원본 작업그룹은 origin). 사용자는 `user`. 창마다 고정인 키(창의 세션 ID)에 이름을
//   정해 두고 (<slug>.names.json, 앱을 다시 켜도 같다) 다른 키에는 주지 않는다: 겹치면 `-2`를 붙인다.
// - 메시지는 일반 텍스트. @이름·@all로 멘션하고, 멘션된 참여자만 알림을 받는다 (깨우기는 다음 단계). 스레드는 없다.
//   이름에 공백·문장부호가 있어도 그대로 멘션한다 (지금 참여자 이름 중 @ 뒤에 가장 길게 맞는 것).
// - 앱 데이터 chats/<프로젝트 이름>-<경로 해시>.jsonl에 한 줄씩 붙인다. 깨진 줄(JSON·UTF-8)은 건너뛰고, 끊긴 마지막 줄
//   뒤에는 줄을 바꾼 뒤 붙인다. 파일을 읽지 못하면 (없음 말고) 그 방은 읽기·쓰기를 모두 멈춘다 (번호가 겹치지 않게).

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

pub const USER: &str = "user";

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Message {
    pub id: u64,
    // 유닉스 시간 (밀리초)
    pub time: u64,
    pub from: String,
    pub text: String,
    // 멘션된 참여자 (보낼 때 있던 참여자 중에서. @all이면 보낸 사람 말고 모두)
    pub to: Vec<String>,
}

struct Member {
    project: PathBuf,
    name: String,
    // 창마다 고정인 키 (창의 세션 ID). 같은 창이 터미널을 다시 띄우면 (StrictMode, 다시 띄우기) 앞 터미널이 나가기 전에
    // 들어와도 같은 이름을 쓴다.
    key: String,
    // 읽은 마지막 메시지 번호 (read_messages가 since 없이 부르면 그 뒤부터)
    last_read: Option<u64>,
}

// 프로젝트의 키 → 이름 (<slug>.names.json). saved: 파일을 읽었거나 없었다 (읽지 못했으면 덮어쓰지 않는다).
#[derive(Default)]
struct Names {
    by_key: HashMap<String, String>,
    saved: bool,
}

#[derive(Default)]
struct Inner {
    // 토큰 → 참여자
    members: HashMap<String, Member>,
    // 프로젝트(실제 경로) → 메시지 (처음 쓸 때 파일에서 읽는다. 읽기에 실패하면 넣지 않고 다음에 다시 읽는다)
    rooms: HashMap<PathBuf, Vec<Message>>,
    names: HashMap<PathBuf, Names>,
}

// 앱 상태 (서버를 띄우지 못했으면 None: 세션은 채팅 없이 뜬다)
pub struct ChatsState(pub Option<Arc<Chats>>);

// 방에 생긴 일: 새 메시지, 참여자가 바뀜 (들어옴·나감)
pub enum Change<'a> {
    Message(&'a Message),
    Members,
}

type OnMessage = Box<dyn Fn(&Path, Change) + Send + Sync>;

pub struct Chats {
    inner: Mutex<Inner>,
    // 메시지 파일을 두는 폴더 (앱 데이터 chats)
    dir: PathBuf,
    port: u16,
    // 새 메시지·참여자 변화마다 (프론트에 알림, 깨우기). 잠금을 놓은 뒤에 부른다.
    on_message: OnMessage,
}

// 추측할 수 없는 토큰 (macOS arc4random)
fn token() -> String {
    let mut bytes = [0u8; 16];
    unsafe { libc::arc4random_buf(bytes.as_mut_ptr().cast(), bytes.len()) };
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

// 본문에서 멘션된 이름: @ 바로 뒤에 오는 이름 중 가장 긴 것 (뒤가 끝·공백·문장부호일 때). "all"은 @all.
// 이름을 공백으로 나누지 않아서 공백·문장부호가 든 이름도 맞는다 ("@origin/코드 리뷰 봐 줘", "@origin/reviewer.").
fn mentions(text: &str, names: &[String]) -> Vec<String> {
    let boundary = |rest: &str| rest.chars().next().is_none_or(|c| c.is_whitespace() || ".,:;!?)]}'\"".contains(c));
    let all = "all".to_string();
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(i) = text[at..].find('@').map(|i| at + i) {
        let rest = &text[i + 1..];
        let best = names.iter().chain([&all]).filter(|n| rest.starts_with(n.as_str()) && boundary(&rest[n.len()..])).max_by_key(|n| n.len());
        // 맞춘 이름이 차지한 곳은 건너뛴다 (이름 안의 @를 다시 멘션으로 보지 않게. 리뷰 후속 P2)
        at = i + 1 + best.map_or(0, |n| n.len());
        found.extend(best.cloned());
    }
    found
}

// 메시지 파일을 읽는다. 없으면 빈 방, 그 밖에 읽지 못하면 오류. 줄마다 따로 읽어 깨진 줄(UTF-8·JSON)만 건너뛴다.
fn load_messages(path: &Path) -> Result<Vec<Message>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    Ok(bytes.split(|b| *b == b'\n').filter_map(|l| std::str::from_utf8(l).ok()).filter_map(|l| serde_json::from_str(l).ok()).collect())
}

// 한 줄을 붙인다. 마지막 줄이 줄바꿈 없이 끊겨 있으면 (쓰다 멈춤) 먼저 줄을 바꾼다 (안 그러면 새 줄이 깨진 줄에 붙는다).
fn append_line(path: &Path, line: &str) -> std::io::Result<()> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::OpenOptions::new().create(true).read(true).append(true).open(path)?;
    let mut last = [0u8; 1];
    let cut = f.seek(SeekFrom::End(0))? > 0 && { f.seek(SeekFrom::End(-1))?; f.read_exact(&mut last)?; last[0] != b'\n' };
    f.write_all(format!("{}{line}\n", if cut { "\n" } else { "" }).as_bytes())
}

impl Chats {
    // 서버 없이 (저장·참여만. 테스트용)
    pub(crate) fn new(dir: PathBuf, on_message: OnMessage, port: u16) -> Arc<Chats> {
        Arc::new(Chats { inner: Mutex::new(Inner::default()), dir, port, on_message })
    }

    // 서버를 띄운다. 포트를 못 열면 오류 (채팅 없이 세션은 뜬다: {chat}이 빈 값이 된다)
    pub fn start(dir: PathBuf, on_message: OnMessage) -> std::io::Result<Arc<Chats>> {
        let server = tiny_http::Server::http("127.0.0.1:0").map_err(std::io::Error::other)?;
        let port = server.server_addr().to_ip().map(|a| a.port()).ok_or_else(|| std::io::Error::other("no port"))?;
        let chats = Chats::new(dir, on_message, port);
        let serving = chats.clone();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let chats = serving.clone();
                // 요청마다 따로 (CLI가 연결을 붙잡아도 다른 세션이 막히지 않게)
                std::thread::spawn(move || chats.respond(request));
            }
        });
        Ok(chats)
    }

    fn file(&self, project: &Path) -> PathBuf {
        self.dir.join(format!("{}.jsonl", crate::worktrees::project_slug(project)))
    }

    fn names_file(&self, project: &Path) -> PathBuf {
        self.dir.join(format!("{}.names.json", crate::worktrees::project_slug(project)))
    }

    fn room<'a>(&self, inner: &'a mut Inner, project: &Path) -> Result<&'a mut Vec<Message>, String> {
        if !inner.rooms.contains_key(project) {
            let loaded = load_messages(&self.file(project))?;
            inner.rooms.insert(project.to_path_buf(), loaded);
        }
        Ok(inner.rooms.get_mut(project).unwrap())
    }

    fn names<'a>(&self, inner: &'a mut Inner, project: &Path) -> &'a mut Names {
        inner.names.entry(project.to_path_buf()).or_insert_with(|| match std::fs::read(self.names_file(project)) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(by_key) => Names { by_key, saved: true },
                // 깨진 파일도 읽지 못한 것과 같다: 덮어쓰지 않는다 (리뷰 후속 P2: 빈 매핑으로 보고 덮어써 이름이 바뀌었다)
                Err(e) => {
                    eprintln!("채팅 이름 파일이 깨짐: {e}");
                    Names::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Names { by_key: HashMap::new(), saved: true },
            Err(e) => {
                eprintln!("채팅 이름 파일을 읽지 못함: {e}");
                Names::default()
            }
        })
    }

    // 참여한다: (토큰, 주소, 실제 이름). key: 창마다 고정인 키. 그 키에 정해 둔 이름이 있으면 그것을 쓴다.
    pub fn join(&self, project: &Path, name: &str, key: &str) -> (String, String, String) {
        let t = token();
        // 키가 없으면 이 참여만의 키
        let key = if key.is_empty() { t.clone() } else { key.to_string() };
        let mut inner = self.inner.lock().unwrap();
        let live: Vec<(String, String)> = inner.members.values().filter(|m| m.project == project).map(|m| (m.name.clone(), m.key.clone())).collect();
        let names = self.names(&mut inner, project);
        let assigned = match names.by_key.get(&key) {
            Some(n) => n.clone(),
            None => {
                let taken = |n: &str| n == USER || names.by_key.iter().any(|(k, v)| v == n && *k != key) || live.iter().any(|(v, k)| v == n && *k != key);
                let mut unique = name.to_string();
                let mut i = 2;
                while taken(&unique) {
                    unique = format!("{name}-{i}");
                    i += 1;
                }
                names.by_key.insert(key.clone(), unique.clone());
                if names.saved {
                    let path = self.names_file(project);
                    let tmp = path.with_extension("json.tmp");
                    let json = serde_json::to_vec(&names.by_key).unwrap_or_default();
                    let saved = std::fs::create_dir_all(&self.dir).and_then(|()| std::fs::write(&tmp, json)).and_then(|()| std::fs::rename(&tmp, &path));
                    if let Err(e) = saved {
                        eprintln!("채팅 이름 파일을 쓰지 못함: {e}");
                    }
                }
                unique
            }
        };
        inner.members.insert(t.clone(), Member { project: project.to_path_buf(), name: assigned.clone(), key, last_read: None });
        drop(inner);
        (self.on_message)(project, Change::Members);
        (t.clone(), format!("http://127.0.0.1:{}/mcp/{t}", self.port), assigned)
    }

    pub fn leave(&self, token: &str) {
        let left = self.inner.lock().unwrap().members.remove(token);
        if let Some(m) = left {
            (self.on_message)(&m.project, Change::Members);
        }
    }

    pub fn members(&self, project: &Path) -> Vec<String> {
        let inner = self.inner.lock().unwrap();
        let mut names: Vec<String> = inner.members.values().filter(|m| m.project == project).map(|m| m.name.clone()).collect();
        names.sort();
        names.dedup();
        names.insert(0, USER.to_string());
        names
    }

    pub fn messages(&self, project: &Path) -> Result<Vec<Message>, String> {
        let mut inner = self.inner.lock().unwrap();
        self.room(&mut inner, project).cloned()
    }

    // 보낸다. 파일에 붙인 뒤에 목록에 넣고 알린다 (쓰지 못하면 오류, 목록도 그대로).
    pub fn post(&self, project: &Path, from: &str, text: &str) -> Result<Message, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("empty message".into());
        }
        let message = {
            let mut inner = self.inner.lock().unwrap();
            let present: Vec<String> = inner.members.values().filter(|m| m.project == project).map(|m| m.name.clone()).chain([USER.to_string()]).collect();
            let said = mentions(text, &present);
            let mut to: Vec<String> = if said.iter().any(|m| m == "all") {
                present.into_iter().filter(|n| n != from).collect()
            } else {
                present.into_iter().filter(|n| said.contains(n) && n != from).collect()
            };
            to.sort();
            to.dedup();
            let file = self.file(project);
            let room = self.room(&mut inner, project)?;
            let id = room.iter().map(|m| m.id).max().map_or(1, |n| n + 1);
            let message = Message { id, time: now_ms(), from: from.to_string(), text: text.to_string(), to };
            let line = serde_json::to_string(&message).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&self.dir).and_then(|()| append_line(&file, &line)).map_err(|e| e.to_string())?;
            room.push(message.clone());
            message
        };
        (self.on_message)(project, Change::Message(&message));
        Ok(message)
    }

    fn respond(&self, mut request: tiny_http::Request) {
        let reply = |code: u16, body: String| tiny_http::Response::from_string(body).with_status_code(code);
        // DNS 리바인딩: 다른 이름으로 들어온 요청은 받지 않는다 (토큰이 있어도)
        let host_ok = request.headers().iter().any(|h| {
            h.field.equiv("Host") && (h.value.as_str().starts_with("127.0.0.1:") || h.value.as_str().starts_with("localhost:"))
        });
        // 브라우저가 보낸 요청(Origin)은 이 서버 자신의 것만 (MCP 규격: Origin을 검사해야 한다). CLI는 Origin을 보내지 않는다.
        let origin_ok = request.headers().iter().filter(|h| h.field.equiv("Origin")).all(|h| {
            [format!("http://127.0.0.1:{}", self.port), format!("http://localhost:{}", self.port)].contains(&h.value.as_str().to_string())
        });
        let host_ok = host_ok && origin_ok;
        let token = request.url().strip_prefix("/mcp/").map(str::to_string);
        let known = token.as_ref().is_some_and(|t| self.inner.lock().unwrap().members.contains_key(t));
        if !host_ok || !known {
            let _ = request.respond(reply(if host_ok { 404 } else { 403 }, String::new()));
            return;
        }
        // 서버가 먼저 보내는 스트림(GET)은 두지 않는다 (MCP 규격: 405로 답해도 된다)
        if *request.method() != tiny_http::Method::Post {
            let _ = request.respond(reply(405, String::new()));
            return;
        }
        let mut body = String::new();
        if request.as_reader().read_to_string(&mut body).is_err() {
            let _ = request.respond(reply(400, String::new()));
            return;
        }
        let token = token.unwrap();
        let answer = match serde_json::from_str::<Value>(&body) {
            Err(e) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": e.to_string() } })),
            Ok(Value::Array(batch)) => {
                let answers: Vec<Value> = batch.iter().filter_map(|r| self.rpc(&token, r)).collect();
                (!answers.is_empty()).then(|| Value::Array(answers))
            }
            Ok(r) => self.rpc(&token, &r),
        };
        let response = match answer {
            // 알림(id 없음)에는 본문 없이 202
            None => reply(202, String::new()),
            Some(v) => reply(200, v.to_string())
                .with_header("Content-Type: application/json".parse::<tiny_http::Header>().unwrap()),
        };
        let _ = request.respond(response);
    }

    // JSON-RPC 요청 하나. 알림이면 None.
    fn rpc(&self, token: &str, request: &Value) -> Option<Value> {
        let id = request.get("id").cloned()?;
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        let result = match method {
            "initialize" => {
                let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
                let version = if ["2024-11-05", "2025-03-26", "2025-06-18"].contains(&asked) { asked } else { "2025-06-18" };
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "ddak", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": "ddak project chat room: talk with the user and the other sessions working on this project. \
                        Use read_messages when told there is a new message, and post_message to answer. Mention members with @name.",
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools() })),
            "tools/call" => Ok(self.call(token, &params)),
            _ => Err((-32601, format!("method not found: {method}"))),
        };
        Some(match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
        })
    }

    // 도구 실행 결과 (MCP tools/call result). 도구 오류는 isError로 알린다.
    fn call(&self, token: &str, params: &Value) -> Value {
        let text = |t: String, error: bool| json!({ "content": [{ "type": "text", "text": t }], "isError": error });
        let Some((project, me)) = self.inner.lock().unwrap().members.get(token).map(|m| (m.project.clone(), m.name.clone())) else {
            return text("You are no longer in the chat room.".into(), true);
        };
        let args = params.get("arguments").cloned().unwrap_or(json!({}));
        match params.get("name").and_then(Value::as_str).unwrap_or("") {
            "list_members" => {
                let list = self.members(&project).into_iter().map(|n| if n == me { format!("{n} (you)") } else { n }).collect::<Vec<_>>();
                text(list.join("\n"), false)
            }
            "post_message" => match args.get("text").and_then(Value::as_str).map(|t| self.post(&project, &me, t)) {
                Some(Ok(m)) => text(
                    format!("Posted #{}.{}", m.id, if m.to.is_empty() { " Nobody was mentioned, so nobody is notified.".into() } else { format!(" Notified: {}.", m.to.join(", ")) }),
                    false,
                ),
                Some(Err(e)) => text(format!("Could not post: {e}"), true),
                None => text("Missing \"text\".".into(), true),
            },
            "read_messages" => {
                let since = args.get("since").and_then(Value::as_u64);
                let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(50).clamp(1, 200) as usize;
                let mut inner = self.inner.lock().unwrap();
                let last_read = inner.members.get(token).and_then(|m| m.last_read);
                let room = match self.room(&mut inner, &project) {
                    Ok(room) => room.clone(),
                    Err(e) => return text(format!("Could not read the chat room: {e}"), true),
                };
                // since가 없으면 안 읽은 것 (처음이면 마지막 20개)
                let picked: Vec<&Message> = match since.or(last_read) {
                    Some(after) => room.iter().filter(|m| m.id > after).take(limit).collect(),
                    None => room.iter().rev().take(limit.min(20)).rev().collect(),
                };
                if let (Some(last), Some(m)) = (picked.last(), inner.members.get_mut(token)) {
                    m.last_read = Some(m.last_read.map_or(last.id, |r| r.max(last.id)));
                }
                if picked.is_empty() {
                    return text("No new messages.".into(), false);
                }
                let lines: Vec<String> = picked
                    .iter()
                    .map(|m| format!("#{} {}{}: {}", m.id, m.from, if m.to.is_empty() { String::new() } else { format!(" → {}", m.to.join(", ")) }, m.text))
                    .collect();
                text(lines.join("\n"), false)
            }
            other => text(format!("Unknown tool: {other}"), true),
        }
    }
}

// 앱이 뜰 때: 앱 데이터 chats 폴더로 서버를 띄우고, 새 메시지는 프론트에 "chat" 이벤트로 ({ project, message }),
// 참여자 변화는 "chat-members" 이벤트로 ({ project }) 알린다.
pub fn install(app: &tauri::AppHandle) -> ChatsState {
    use tauri::Emitter;
    let dir = match crate::projects::data_dir(app) {
        Ok(d) => d.join("chats"),
        Err(e) => {
            eprintln!("채팅 폴더 실패: {e}");
            return ChatsState(None);
        }
    };
    let emitter = app.clone();
    let on_message: OnMessage = Box::new(move |project, change| {
        let _ = match change {
            Change::Message(message) => emitter.emit("chat", json!({ "project": project, "message": message })),
            Change::Members => emitter.emit("chat-members", json!({ "project": project })),
        };
    });
    match Chats::start(dir, on_message) {
        Ok(chats) => ChatsState(Some(chats)),
        Err(e) => {
            eprintln!("채팅 서버 실패: {e}");
            ChatsState(None)
        }
    }
}

fn chats_of(state: &tauri::State<'_, ChatsState>) -> Result<Arc<Chats>, String> {
    state.0.clone().ok_or_else(|| "chat server is not running".to_string())
}

fn real(project: &str) -> PathBuf {
    std::fs::canonicalize(project).unwrap_or_else(|_| PathBuf::from(project))
}

#[tauri::command]
pub fn chat_messages(state: tauri::State<'_, ChatsState>, project: String) -> Result<Vec<Message>, String> {
    chats_of(&state)?.messages(&real(&project))
}

// 사용자로 보낸다
#[tauri::command]
pub fn chat_post(state: tauri::State<'_, ChatsState>, project: String, text: String) -> Result<Message, String> {
    chats_of(&state)?.post(&real(&project), USER, &text)
}

#[tauri::command]
pub fn chat_members(state: tauri::State<'_, ChatsState>, project: String) -> Result<Vec<String>, String> {
    Ok(chats_of(&state)?.members(&real(&project)))
}

fn tools() -> Value {
    json!([
        {
            "name": "list_members",
            "description": "List who is in this project's chat room: the user and the sessions of every work group, named group/role. Marks which one is you.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "post_message",
            "description": "Post a message to this project's chat room. Mention members with @name (for example @origin/reviewer) or @all. Only mentioned members are notified.",
            "inputSchema": {
                "type": "object",
                "properties": { "text": { "type": "string", "description": "The message. Plain text." } },
                "required": ["text"]
            }
        },
        {
            "name": "read_messages",
            "description": "Read this project's chat room. Without since, returns the messages you have not read yet (the last 20 the first time).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "since": { "type": "integer", "description": "Return messages after this message number." },
                    "limit": { "type": "integer", "description": "At most this many messages (default 50)." }
                }
            }
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ddak-chat-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    // 이름은 키마다 정해 두고 다른 키에는 주지 않는다 (-2). 멘션된 참여자(보낸 사람 빼고, @all은 모두)만 to에 들어가고
    // 모르는 이름은 무시한다. 파일에 붙여서 다시 켜도 그대로 읽는다. 포트 없이 돈다.
    #[test]
    fn names_mentions_and_file() {
        let dir = temp("store");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let chats = Chats::new(dir.clone(), Box::new(move |_, c| {
            if let Change::Message(m) = c {
                sink.lock().unwrap().push(m.id)
            }
        }), 0);
        let (a, b) = (Path::new("/p/a"), Path::new("/p/b"));
        assert_eq!(chats.join(a, "origin/dev", "k1").2, "origin/dev");
        assert_eq!(chats.join(a, "origin/dev", "k2").2, "origin/dev-2");
        // 같은 창(키)이 다시 들어오면 같은 이름
        assert_eq!(chats.join(a, "origin/dev", "k1").2, "origin/dev");
        assert_eq!(chats.join(a, "user", "k3").2, "user-2");
        assert_eq!(chats.join(b, "origin/dev", "k1").2, "origin/dev");
        let m1 = chats.post(a, USER, "@origin/dev, hi @nobody.").unwrap();
        let m2 = chats.post(a, "origin/dev", "@all done").unwrap();
        assert_eq!((m1.id, m1.to.clone()), (1, vec!["origin/dev".to_string()]));
        assert_eq!(m2.to, ["origin/dev-2", "user", "user-2"]);
        assert!(chats.post(a, USER, "   ").is_err());
        assert_eq!(*seen.lock().unwrap(), [1, 2]);
        assert!(chats.messages(b).unwrap().is_empty());
        let again = Chats::new(dir.clone(), Box::new(|_, _| ()), 0);
        assert_eq!(again.messages(a).unwrap(), [m1, m2]);
        // 참여자가 바뀌면 알린다 (들어옴·나감, 모르는 토큰은 알리지 않음)
        let changes = Arc::new(Mutex::new(0));
        let count = changes.clone();
        let watched = Chats::new(dir.clone(), Box::new(move |_, c| if let Change::Members = c { *count.lock().unwrap() += 1 }), 0);
        let (t, _, _) = watched.join(a, "origin/dev", "k1");
        watched.leave(&t);
        watched.leave(&t);
        assert_eq!(*changes.lock().unwrap(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 리뷰 P2: 키의 이름은 그 키의 참여자가 모두 나가도, 앱을 다시 켜도 그대로다. 그 이름은 다른 키에 주지 않는다.
    #[test]
    fn name_stays_with_key() {
        let dir = temp("names");
        let p = Path::new("/p/n");
        let chats = Chats::new(dir.clone(), Box::new(|_, _| ()), 0);
        let (t1, _, _) = chats.join(p, "origin/dev", "k1");
        let (t2, _, n2) = chats.join(p, "origin/dev", "k2");
        chats.leave(&t1);
        chats.leave(&t2);
        assert_eq!((n2.as_str(), chats.join(p, "origin/dev", "k2").2.as_str()), ("origin/dev-2", "origin/dev-2"));
        assert_eq!(chats.join(p, "origin/dev", "k3").2, "origin/dev-3");
        let again = Chats::new(dir.clone(), Box::new(|_, _| ()), 0);
        assert_eq!(again.join(p, "origin/dev", "k2").2, "origin/dev-2");
        assert_eq!(again.join(p, "origin/dev", "k1").2, "origin/dev");
        // 깨진 이름 파일은 덮어쓰지 않는다 (리뷰 후속 P2)
        let file = again.names_file(p);
        let mut bytes = std::fs::read(&file).unwrap();
        bytes.pop();
        std::fs::write(&file, &bytes).unwrap();
        let broken = Chats::new(dir.clone(), Box::new(|_, _| ()), 0);
        broken.join(p, "origin/dev", "k9");
        assert_eq!(std::fs::read(&file).unwrap(), bytes, "깨진 이름 파일을 덮어씀");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 리뷰 P2: 공백·문장부호가 든 이름도 그대로 멘션된다. 더 긴 이름이 앞부분이 같은 짧은 이름보다 먼저다.
    #[test]
    fn mentions_match_whole_names() {
        let names: Vec<String> = ["origin/코드 리뷰", "origin/reviewer.", "origin/dev", "origin/dev-2", "user"].iter().map(|s| s.to_string()).collect();
        let m = |t: &str| mentions(t, &names);
        assert_eq!(m("@origin/코드 리뷰 봐 줘"), ["origin/코드 리뷰"]);
        assert_eq!(m("@origin/reviewer.. 확인"), ["origin/reviewer."]);
        assert_eq!(m("@origin/dev-2, @origin/dev"), ["origin/dev-2", "origin/dev"]);
        assert!(m("@origin/devx @origin/코드").is_empty());
        assert_eq!(m("(@user) @all"), ["user", "all"]);
        // 이름 안의 @all은 따로 멘션이 아니다
        let odd: Vec<String> = vec!["origin/코드 @all 리뷰".into(), "origin/other".into()];
        assert_eq!(mentions("@origin/코드 @all 리뷰 봐 줘", &odd), ["origin/코드 @all 리뷰"]);
    }

    // 리뷰 P1: 끊긴 마지막 줄 뒤에 붙인 메시지도 다시 켜면 남는다. UTF-8이 깨진 줄도 그 줄만 건너뛴다.
    #[test]
    fn broken_lines_lose_nothing_after_them() {
        let dir = temp("broken");
        let p = Path::new("/p/b");
        let chats = Chats::new(dir.clone(), Box::new(|_, _| ()), 0);
        let line = |id: u64| serde_json::to_string(&Message { id, time: 0, from: USER.into(), text: format!("m{id}"), to: vec![] }).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let mut bytes = format!("{}\n", line(1)).into_bytes();
        bytes.extend(b"\xff\xfe broken\n");
        bytes.extend(format!("{}\n{{\"id\":3,\"ti", line(2)).into_bytes());
        std::fs::write(chats.file(p), &bytes).unwrap();
        assert_eq!(chats.messages(p).unwrap().iter().map(|m| m.id).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(chats.post(p, USER, "new").unwrap().id, 3);
        let again = Chats::new(dir.clone(), Box::new(|_, _| ()), 0);
        assert_eq!(again.messages(p).unwrap().iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), ["m1", "m2", "new"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 리뷰 P2: 파일을 읽지 못하면 (없음이 아니면) 빈 방으로 보지 않는다. 읽기·쓰기 모두 오류이고 파일은 그대로다.
    // 고치면 다시 읽는다.
    #[test]
    fn unreadable_room_refuses_reads_and_writes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("unreadable");
        let p = Path::new("/p/u");
        let first = Chats::new(dir.clone(), Box::new(|_, _| ()), 0);
        first.post(p, USER, "one").unwrap();
        first.post(p, USER, "two").unwrap();
        let file = first.file(p);
        let before = std::fs::read(&file).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o200)).unwrap();
        let chats = Chats::new(dir.clone(), Box::new(|_, _| ()), 0);
        let (read, post) = (chats.messages(p).is_err(), chats.post(p, USER, "three").is_err());
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read && post, "읽기 {read}, 쓰기 {post}");
        assert_eq!(std::fs::read(&file).unwrap(), before);
        assert_eq!(chats.post(p, USER, "three").unwrap().id, 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // HTTP 요청 하나를 보내고 (상태, 본문)
    fn http(port: u16, method: &str, path: &str, host: &str, body: &str) -> (u16, String) {
        request(port, method, path, host, "", body)
    }

    fn http_with(port: u16, path: &str, host: &str, headers: &str, body: &str) -> (u16, String) {
        request(port, "POST", path, host, headers, body)
    }

    fn request(port: u16, method: &str, path: &str, host: &str, headers: &str, body: &str) -> (u16, String) {
        use std::io::Read;
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let req = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        s.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        let status = out.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        (status, out.split_once("\r\n\r\n").map_or(String::new(), |(_, b)| b.to_string()))
    }

    // MCP (streamable HTTP, JSON 응답): 초기화, 알림은 202, 도구 목록·호출. 보낸 사람은 주소로 정해진다.
    // read_messages는 since 없이 부르면 안 읽은 것만. 모르는 토큰 404, 다른 Host·Origin 403, GET 405, 나가면 404.
    // 포트를 연다.
    #[test]
    fn mcp_over_http() {
        let dir = temp("http");
        let chats = Chats::start(dir.clone(), Box::new(|_, _| ())).unwrap();
        let project = Path::new("/p/x");
        let (token, url, _) = chats.join(project, "origin/dev", "k");
        let path = url.split_once(&format!("127.0.0.1:{}", chats.port)).unwrap().1.to_string();
        let host = format!("127.0.0.1:{}", chats.port);
        let rpc = |body: Value| {
            let (status, text) = http(chats.port, "POST", &path, &host, &body.to_string());
            (status, serde_json::from_str::<Value>(&text).unwrap_or(Value::Null))
        };
        let call = |name: &str, args: Value| {
            let (_, v) = rpc(json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": { "name": name, "arguments": args } }));
            v["result"]["content"][0]["text"].as_str().unwrap_or("").to_string()
        };

        let (status, init) = rpc(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } }));
        assert_eq!((status, init["result"]["protocolVersion"].as_str()), (200, Some("2025-03-26")));
        assert_eq!(rpc(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).0, 202);
        let (_, list) = rpc(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
        let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["list_members", "post_message", "read_messages"]);

        chats.post(project, USER, "@origin/dev first").unwrap();
        assert!(call("post_message", json!({ "text": "@user ok" })).contains("Notified: user"));
        assert_eq!(chats.messages(project).unwrap()[1].from, "origin/dev");
        let first = call("read_messages", json!({}));
        assert!(first.contains("#1 user → origin/dev: @origin/dev first") && first.contains("#2 origin/dev → user: @user ok"), "{first}");
        assert_eq!(call("read_messages", json!({})), "No new messages.");
        chats.post(project, USER, "third").unwrap();
        assert_eq!(call("read_messages", json!({})), "#3 user: third");
        assert!(call("read_messages", json!({ "since": 1 })).starts_with("#2 "));
        assert!(call("list_members", json!({})).contains("origin/dev (you)"));
        assert_eq!(rpc(json!({ "jsonrpc": "2.0", "id": 3, "method": "nope" })).1["error"]["code"], -32601);

        assert_eq!(http(chats.port, "POST", "/mcp/nope", &host, "{}").0, 404);
        assert_eq!(http(chats.port, "POST", &path, "evil.example:80", "{}").0, 403);
        // 리뷰 P2: 다른 사이트에서 온 브라우저 요청(Origin)은 토큰이 맞아도 받지 않는다
        let post = json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "post_message", "arguments": { "text": "from a page" } } }).to_string();
        assert_eq!(http_with(chats.port, &path, &host, "Origin: https://untrusted.example\r\n", &post).0, 403);
        assert!(chats.messages(project).unwrap().iter().all(|m| m.text != "from a page"));
        assert_eq!(http_with(chats.port, &path, &host, &format!("Origin: http://127.0.0.1:{}\r\n", chats.port), &post).0, 200);
        assert_eq!(http(chats.port, "GET", &path, &host, "").0, 405);
        chats.leave(&token);
        assert_eq!(http(chats.port, "POST", &path, &host, "{}").0, 404);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 실험용: 서버를 띄우고 참여자 둘(dev, reviewer)의 주소를 찍은 뒤 기다린다. 실제 claude·codex를 붙여 본다.
    // DDAK_CHAT_EXPERIMENT=<초> cargo test chat::tests::serve_for_experiment -- --ignored --nocapture
    #[test]
    #[ignore]
    fn serve_for_experiment() {
        let dir = std::env::temp_dir().join("ddak-chat-experiment");
        let chats = Chats::start(dir.clone(), Box::new(|_, c| {
            if let Change::Message(m) = c {
                println!("MESSAGE {}", serde_json::to_string(m).unwrap())
            }
        })).unwrap();
        let project = Path::new("/tmp/ddak-chat-project");
        for name in ["origin/dev", "origin/reviewer"] {
            let (_, url, name) = chats.join(project, name, name);
            println!("MEMBER {name} {url}");
        }
        chats.post(project, USER, "@origin/dev hello from the user. Reply to me with @user.").unwrap();
        let secs = std::env::var("DDAK_CHAT_EXPERIMENT").ok().and_then(|s| s.parse().ok()).unwrap_or(120);
        std::thread::sleep(std::time::Duration::from_secs(secs));
        println!("FILE {}", std::fs::read_to_string(chats.file(project)).unwrap_or_default());
    }
}
