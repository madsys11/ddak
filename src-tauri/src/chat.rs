// 프로젝트 채팅방 (docs/spec.md "채팅방 설계"). 프로젝트마다 방이 하나이고, 사용자와 ddak이 띄운 세션이 참여한다.
//
// - 세션은 MCP로 참여한다. ddak이 127.0.0.1의 빈 포트에 MCP 서버(streamable HTTP)를 띄우고, 세션을 띄울 때 창마다
//   토큰을 만들어 인자 안의 {chat}을 그 창의 주소(http://127.0.0.1:<포트>/mcp/<토큰>)로 바꾼다 (pty_spawn). 주소로
//   누가 보냈는지 안다. 터미널을 닫으면 참여자에서 빠진다. ddak은 CLI를 해석하지 않는다: MCP를 붙이는 인자는 설정에 있다.
// - 참여자 이름은 `작업그룹/역할` (원본 작업그룹은 origin). 사용자는 `user`. 창마다 고정인 키(창의 세션 ID)에 이름을
//   정해 두고 (<slug>.names.json, 앱을 다시 켜도 같다) 다른 키에는 주지 않는다: 겹치면 `-2`를 붙인다.
// - 메시지는 일반 텍스트. @이름·@all로 멘션하고, 멘션된 참여자만 알림을 받는다. 사용자 메시지는 받을 참여자가 없으면
//   보내지 않는다 (모두에게는 @all). 스레드는 없다.
//   이름에 공백·문장부호가 있어도 그대로 멘션한다 (지금 참여자 이름 중 @ 뒤에 가장 길게 맞는 것).
// - 앱 데이터 chats/<프로젝트 이름>-<경로 해시>.jsonl에 한 줄씩 붙인다. 깨진 줄(JSON·UTF-8)은 건너뛰고, 끊긴 마지막 줄
//   뒤에는 줄을 바꾼 뒤 붙인다. 파일을 읽지 못하면 (없음 말고) 그 방은 읽기·쓰기를 모두 멈춘다 (번호가 겹치지 않게).

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

pub const USER: &str = "user";
// 사용자 메시지에 받을 참여자가 없음 (화면이 문구로 바꾼다)
pub const NO_RECIPIENT: &str = "no-recipient";

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Message {
    pub id: u64,
    // 유닉스 시간 (밀리초)
    pub time: u64,
    pub from: String,
    pub text: String,
    // 멘션된 참여자 (보낼 때 있던 참여자 중에서. @all이면 보낸 사람 말고 모두)
    pub to: Vec<String>,
    // 자동 깨우기 제한에 걸려 받는 사람을 깨우지 않았다 (to는 원래 받는 사람 그대로. WAKE_LIMIT)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub held: bool,
    // 사용자가 폰에서 보냈으면 그 기기 이름 (mobile.rs)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    // 세션이 띄운 선택 창 (prompts.rs): 사용자가 채팅에서 고른다
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<Prompt>,
    // 선택 창에 보낸 답의 기록 (prompts.rs)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<Answer>,
    // 세션의 권한 모드를 바꾼 기록 (modes.rs)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ModeChange>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Prompt {
    // 이 선택 창의 id (답할 때 가리킨다. 열려 있는 동안만 답할 수 있다)
    pub id: String,
    // 무엇을 기다리는지 (permission·question·auth·dialog·blocked)
    pub kind: String,
    // 화면에서 읽은 질문 줄
    pub question: Vec<String>,
    pub options: Vec<PromptOption>,
    // 채팅에서 답할 수 있다 (질문이 화면 밖으로 잘렸을 수 있으면 아님: 맥에서 답한다)
    #[serde(default)]
    pub answerable: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PromptOption {
    pub label: String,
    // 보내기 전에 한 번 더 확인을 받는다 (승인일 수 있는 것)
    pub confirm: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Answer {
    pub prompt: String,
    // 선택 창의 주인 (참여자 이름)
    pub member: String,
    // 고른 선택지 (0부터)와 그 글
    pub option: usize,
    pub label: String,
    // sent: 보냄. changed: 화면의 선택 창이 바뀌거나 닫혀 보내지 않음. failed: 커서를 옮기지 못하는 등으로 보내지 않음
    pub result: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ModeChange {
    // 모드를 바꾼 세션 (참여자 이름)
    pub member: String,
    // 고른 모드 (auto·manual·acceptEdits·plan)
    pub mode: String,
    // sent: 바뀜. changed: 화면이 바뀌거나(선택 창이 뜸 등) 취소돼 멈춤. failed: 모드 줄이 따라오지 않거나 쓰지 못해 멈춤
    pub result: String,
}

// 기록 메시지에 붙는 것 (post_note)
pub enum Record {
    Prompt(Prompt),
    Answer(Answer),
    Mode(ModeChange),
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
    // 프로젝트 → 지운 지점의 번호 (새 번호는 이것과 남은 메시지 중 큰 것 + 1)
    floors: HashMap<PathBuf, u64>,
    names: HashMap<PathBuf, Names>,
    // (프로젝트, 작업그룹) → 자동 깨우기 셈 (WAKE_LIMIT). 메모리에만 둔다: 앱을 다시 켜면 처음부터 센다.
    limits: HashMap<(PathBuf, String), Limit>,
    // 프로젝트 → 사용자가 본 마지막 번호 (안 읽은 수, unread). 메모리에만 둔다: 없으면 앱을 켜기 전 것까지 본 것으로 친다.
    seen: HashMap<PathBuf, u64>,
}

// 자동 깨우기 제한 (docs/spec.md "작업그룹 협업 규약"). 세션끼리 끝없이 주고받지 않도록, 사용자 메시지 없이 한 작업그룹의
// 세션이 다른 세션에게 보낸 메시지를 센다 (@all도 1개). WAKE_LIMIT개까지는 깨우고, 그 뒤 메시지는 저장만 하고 깨우지 않는다
// (held). 사용자 메시지가 그 작업그룹에 닿거나 사용자가 재개하면 다시 세고, 보류된 알림을 받는 사람마다 한 번 알린다.
// 이미 깨운 세션의 작업은 멈추지 않는다 (새 알림을 넣지 않을 뿐).
pub const WAKE_LIMIT: u32 = 6;

#[derive(Default)]
struct Limit {
    count: u32,
    // 보류된 알림: (받는 사람, 보낸 사람)
    held: Vec<(String, String)>,
}

// 참여자 이름 "작업그룹/역할"의 작업그룹 (사용자는 없음)
fn group_of(name: &str) -> Option<&str> {
    name.split_once('/').map(|(g, _)| g)
}

// 앱 상태 (서버를 띄우지 못했으면 None: 세션은 채팅 없이 뜬다)
pub struct ChatsState(pub Option<Arc<Chats>>);

// 방에 생긴 일: 새 메시지, 참여자가 바뀜 (들어옴·나감)
pub enum Change<'a> {
    // 새 메시지와, 이 메시지(사용자)로 자동 깨우기 제한이 풀려 보류됐던 알림 (받는 사람, 보낸 사람). 둘은 한꺼번에 깨운다
    // (리뷰 2단계 R1: 따로 깨우면 같은 받는 사람에게 알림이 두 번 갈 수 있었다).
    Message(&'a Message, &'a [(String, String)]),
    Members,
    // 자동 깨우기 제한이 걸리거나 풀림
    Limits,
    // 재개 버튼으로 풀려 보류됐던 알림: (받는 사람, 보낸 사람)
    Released(&'a [(String, String)]),
    // 대화를 모두 지움 (chat_clear)
    Cleared,
    // 사용자가 본 마지막 번호가 올라감 (데스크톱 채팅 패널이나 폰에서 읽음. 안 읽은 수가 바뀐다)
    Seen,
    // 이 작업그룹의 자동 깨우기가 막 멈춤 (사용자에게 알린다)
    Paused(&'a str),
    // 이 참여자가 사용자를 기다림 (사용자에게 알린다). kind: permission·question·auth (OSC 7501 blocked의 종류), blocked
    // (종류 없음), dialog (화면의 선택 창).
    // hook: claude의 권한 확인 훅(/attention/<토큰>)에서 옴. 아니면 터미널의 프로그램 상태(pty_awaiting, 대기가 켜질 때마다).
    // 같은 확인을 두 경로가 어느 순서로든 알리므로 하나로 친다: 상태 쪽은 pty.rs set_awaiting, 훅 쪽은 claim_hook_attention.
    // 훅은 상태를 보내지 않는 claude를 위해 남긴다
    Attention { name: &'a str, token: &'a str, kind: &'a str, hook: bool },
    // 이 참여자의 CLI가 대화를 시작·전환함 (claude SessionStart 훅, /session/<토큰>). key: 창 키, id: 새 대화 ID,
    // source: startup·resume·clear·compact·fork. 프론트가 그 창의 이어서 하기 ID(cur)를 옮긴다.
    Session { key: &'a str, id: &'a str, source: &'a str },
}

// claude 대화 ID 모양 (UUID 8-4-4-4-12). 다른 값은 인자에 넣지 않게 받지 않는다.
fn is_uuid(s: &str) -> bool {
    s.len() == 36 && s.char_indices().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() })
}

type OnMessage = Box<dyn Fn(&Path, Change) + Send + Sync>;

pub struct Chats {
    inner: Mutex<Inner>,
    // 메시지 파일을 두는 폴더 (앱 데이터 chats)
    dir: PathBuf,
    port: u16,
    // 새 메시지·참여자 변화마다 (프론트에 알림, 깨우기). 잠금을 놓은 뒤에 부른다.
    on_message: OnMessage,
    // 만든 때 (ms). 이보다 앞의 메시지는 읽은 것으로 친다 (unread)
    started: u64,
}

// 추측할 수 없는 토큰
fn token() -> String {
    let mut bytes = [0u8; 16];
    crate::platform::fill_random(&mut bytes);
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

// 대화를 지운 지점 (지운 뒤 새 파일의 첫 줄): 그때의 마지막 번호. 번호는 이 뒤로 이어서 매긴다.
#[derive(serde::Serialize, serde::Deserialize)]
struct Cleared {
    cleared: u64,
}

// 메시지 파일을 읽는다. 없으면 빈 방, 그 밖에 읽지 못하면 오류. 줄마다 따로 읽어 깨진 줄(UTF-8·JSON)만 건너뛴다.
// 지운 지점 줄이 있으면 그 번호도 돌려준다 (없으면 0).
fn load_messages(path: &Path) -> Result<(Vec<Message>, u64), String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), 0)),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let (mut messages, mut floor) = (Vec::new(), 0);
    for line in bytes.split(|b| *b == b'\n').filter_map(|l| std::str::from_utf8(l).ok()) {
        if let Ok(m) = serde_json::from_str::<Message>(line) {
            messages.push(m);
        } else if let Ok(c) = serde_json::from_str::<Cleared>(line) {
            floor = floor.max(c.cleared);
        }
    }
    Ok((messages, floor))
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
        Arc::new(Chats { inner: Mutex::new(Inner::default()), dir, port, on_message, started: now_ms() })
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
            let (loaded, floor) = load_messages(&self.file(project))?;
            inner.rooms.insert(project.to_path_buf(), loaded);
            inner.floors.insert(project.to_path_buf(), floor);
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

    // 깨울 (채팅 토큰, 보낸 사람): 메시지의 받는 사람(보류한 메시지면 없음)과 풀려난 보류분. pty::wake_all로 한꺼번에 예약한다.
    pub fn wake_items(&self, project: &Path, message: Option<&Message>, released: &[(String, String)]) -> Vec<(String, String)> {
        let inner = self.inner.lock().unwrap();
        let pairs = message.filter(|m| !m.held).into_iter().flat_map(|m| m.to.iter().filter(|n| *n != USER).map(|n| (n.clone(), m.from.clone())));
        let pairs: Vec<(String, String)> = pairs.chain(released.iter().cloned()).collect();
        let mut items = Vec::new();
        for (name, from) in pairs {
            for (token, _) in inner.members.iter().filter(|(_, m)| m.project == project && m.name == name) {
                items.push((token.clone(), from.clone()));
            }
        }
        items
    }

    // 이 이름들로 참여한 토큰 (깨울 터미널을 찾는다)
    pub fn tokens_named(&self, project: &Path, names: &[String]) -> Vec<String> {
        let inner = self.inner.lock().unwrap();
        inner.members.iter().filter(|(_, m)| m.project == project && names.contains(&m.name)).map(|(t, _)| t.clone()).collect()
    }

    // 참여한 토큰과 이름 (깨우기를 기다리는 참여자를 찾는다)
    pub fn member_tokens(&self, project: &Path) -> Vec<(String, String)> {
        let inner = self.inner.lock().unwrap();
        inner.members.iter().filter(|(_, m)| m.project == project).map(|(t, m)| (t.clone(), m.name.clone())).collect()
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

    // 안 읽은 수: 세션이 사용자에게 보낸 메시지 (보낸 사람이 사용자가 아니고 받는 사람에 사용자) 중 사용자가 본 마지막 번호 뒤의
    // 것. 아직 본 적이 없으면 앱을 켠 뒤에 온 것 (docs/mobile-plan.md "3단계 세부"). 읽지 못하는 방은 0
    pub fn unread(&self, project: &Path) -> usize {
        let mut inner = self.inner.lock().unwrap();
        let seen = inner.seen.get(project).copied();
        let started = self.started;
        let Ok(room) = self.room(&mut inner, project) else { return 0 };
        room.iter().filter(|m| m.from != USER && m.to.iter().any(|t| t == USER) && seen.map_or(m.time >= started, |s| m.id > s)).count()
    }

    // 여기까지 봤다 (지금보다 앞 번호면 그대로). 올라가면 알린다 (Change::Seen). 처음이면 앱을 켜기 전 것보다 앞으로 가지 않는다
    // (안 읽은 수가 늘지 않게)
    pub fn seen(&self, project: &Path, id: u64) {
        let changed = {
            let mut inner = self.inner.lock().unwrap();
            let current = match inner.seen.get(project) {
                Some(s) => *s,
                None => {
                    let started = self.started;
                    self.room(&mut inner, project).map(|r| r.iter().filter(|m| m.time < started).map(|m| m.id).max().unwrap_or(0)).unwrap_or(0)
                }
            };
            let next = current.max(id);
            inner.seen.insert(project.to_path_buf(), next);
            next > current
        };
        if changed {
            (self.on_message)(project, Change::Seen);
        }
    }

    // 보낸다. 파일에 붙인 뒤에 목록에 넣고 알린다 (쓰지 못하면 오류, 목록도 그대로).
    pub fn post(&self, project: &Path, from: &str, text: &str) -> Result<Message, String> {
        self.post_via(project, from, text, None)
    }

    // 이 토큰의 참여자 (프로젝트, 이름)
    pub fn member_of(&self, token: &str) -> Option<(PathBuf, String)> {
        self.inner.lock().unwrap().members.get(token).map(|m| (m.project.clone(), m.name.clone()))
    }

    // 기록을 붙인다: 받는 사람(to)을 정해서, 멘션·자동 깨우기 셈 없이 (선택 창과 그 답 prompts.rs, 모드 바꾸기 modes.rs). 받는 사람이 세션이 아니면
    // 아무도 깨우지 않는다. 알림은 on_message가 메시지를 보고 정한다
    pub fn post_note(&self, project: &Path, from: &str, text: &str, to: Vec<String>, record: Record, via: Option<&str>) -> Result<Message, String> {
        let (mut prompt, mut answer, mut mode) = (None, None, None);
        match record {
            Record::Prompt(p) => prompt = Some(p),
            Record::Answer(a) => answer = Some(a),
            Record::Mode(m) => mode = Some(m),
        }
        let message = {
            let mut inner = self.inner.lock().unwrap();
            let file = self.file(project);
            self.room(&mut inner, project)?;
            let floor = inner.floors.get(project).copied().unwrap_or(0);
            let room = inner.rooms.get_mut(project).unwrap();
            let id = room.iter().map(|m| m.id).max().unwrap_or(0).max(floor) + 1;
            let message = Message { id, time: now_ms(), from: from.to_string(), text: text.to_string(), to, held: false, via: via.map(str::to_string), prompt, answer, mode };
            let line = serde_json::to_string(&message).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&self.dir).and_then(|()| append_line(&file, &line)).map_err(|e| e.to_string())?;
            room.push(message.clone());
            message
        };
        (self.on_message)(project, Change::Message(&message, &[]));
        Ok(message)
    }

    // via: 폰에서 보낸 기기 이름 (mobile.rs)
    pub fn post_via(&self, project: &Path, from: &str, text: &str, via: Option<&str>) -> Result<Message, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("empty message".into());
        }
        let message = {
            let mut inner = self.inner.lock().unwrap();
            let present: Vec<String> = inner.members.values().filter(|m| m.project == project).map(|m| m.name.clone()).chain([USER.to_string()]).collect();
            // 멘션은 지금 없는 창의 이름(.names.json)까지 알아본다. 받는 사람은 지금 있는 참여자 중에서만.
            // (리뷰 P2: 칩으로 고른 세션이 보내기 전에 나가면 멘션이 없는 것으로 보여 모두를 깨웠다)
            let mut known = present.clone();
            known.extend(self.names(&mut inner, project).by_key.values().cloned());
            let said = mentions(text, &known);
            // 멘션된 참여자에게만 (@all이면 모두). 세션의 메시지는 받는 사람이 없으면 기록만.
            let all = said.iter().any(|m| m == "all");
            let mut to: Vec<String> = present.into_iter().filter(|n| n != from && (all || said.contains(n))).collect();
            to.sort();
            to.dedup();
            // 사용자 메시지는 지금 받을 참여자가 있어야 보낸다 (멘션이 없으면 모두에게 가던 때 실수로 모든 세션을 깨웠다.
            // 끝난 세션만 멘션했어도 막는다). 화면은 초안을 남기고 받는 사람을 고르게 한다
            if from == USER && to.is_empty() {
                return Err(NO_RECIPIENT.into());
            }
            // 자동 깨우기 제한: 세션이 다른 세션에게 보낸 것만 센다. 셈과 보류는 이 잠금 안에서 정한다 (동시에 보내도 넘지 않게)
            let counted = (from != USER && to.iter().any(|n| n != USER)).then(|| group_of(from)).flatten().map(|g| (project.to_path_buf(), g.to_string()));
            let held = counted.as_ref().is_some_and(|k| inner.limits.get(k).is_some_and(|l| l.count >= WAKE_LIMIT));
            let file = self.file(project);
            // 처음이면 파일에서 읽는다 (지운 지점도)
            self.room(&mut inner, project)?;
            let floor = inner.floors.get(project).copied().unwrap_or(0);
            let room = inner.rooms.get_mut(project).unwrap();
            let id = room.iter().map(|m| m.id).max().unwrap_or(0).max(floor) + 1;
            let message = Message { id, time: now_ms(), from: from.to_string(), text: text.to_string(), to, held, via: via.map(str::to_string), prompt: None, answer: None, mode: None };
            let line = serde_json::to_string(&message).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&self.dir).and_then(|()| append_line(&file, &line)).map_err(|e| e.to_string())?;
            room.push(message.clone());
            // 저장한 뒤에 센다 (저장하지 못한 메시지는 세지 않는다)
            let mut limits_changed = false;
            let mut paused_now = None;
            let mut released = Vec::new();
            if let Some(key) = counted {
                let group = key.1.clone();
                let limit = inner.limits.entry(key).or_default();
                if held {
                    limit.held.extend(message.to.iter().filter(|n| *n != USER).map(|n| (n.clone(), message.from.clone())));
                } else {
                    limit.count += 1;
                    limits_changed = limit.count == WAKE_LIMIT;
                    paused_now = limits_changed.then_some(group);
                }
            } else if from == USER {
                // 사용자 메시지가 닿은 작업그룹은 다시 센다
                let groups: Vec<String> = message.to.iter().filter_map(|n| group_of(n)).map(str::to_string).collect();
                for g in groups {
                    if let Some(limit) = inner.limits.remove(&(project.to_path_buf(), g)) {
                        limits_changed |= limit.count >= WAKE_LIMIT;
                        released.extend(limit.held);
                    }
                }
            }
            released.sort();
            released.dedup();
            (message, limits_changed, paused_now, released)
        };
        let (message, limits_changed, paused_now, released) = message;
        (self.on_message)(project, Change::Message(&message, &released));
        if limits_changed {
            (self.on_message)(project, Change::Limits);
        }
        if let Some(group) = paused_now {
            (self.on_message)(project, Change::Paused(&group));
        }
        Ok(message)
    }

    // 대화를 모두 지운다 (채팅 패널). 지운 파일은 chats/cleared/<이름>-<시각>.jsonl로 옮겨 두고 (되살릴 수 있게), 새 파일의
    // 첫 줄에 지운 지점 {"cleared": 마지막 번호}를 남긴다. 번호는 그 뒤로 이어서 매긴다: 세션이 읽은 위치를 번호로 기억해서,
    // 1부터 다시 쓰면 새 메시지를 놓친다. 새 파일을 먼저 만들고 바꿔 넣으며, 바꿔 넣지 못하면 옮긴 파일을 되돌린다.
    pub fn clear(&self, project: &Path) -> Result<(), String> {
        {
            let mut inner = self.inner.lock().unwrap();
            self.room(&mut inner, project)?;
            let floor = inner.floors.get(project).copied().unwrap_or(0);
            let room = inner.rooms.get_mut(project).unwrap();
            let last = room.iter().map(|m| m.id).max().unwrap_or(0).max(floor);
            if room.is_empty() {
                return Ok(());
            }
            let file = self.file(project);
            let name = file.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let archive = self.dir.join("cleared");
            let kept = archive.join(format!("{name}-{}.jsonl", now_ms()));
            let fresh = self.dir.join(format!("{name}.jsonl.new"));
            let line = serde_json::to_string(&Cleared { cleared: last }).map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&archive).map_err(|e| e.to_string())?;
            std::fs::write(&fresh, format!("{line}\n")).map_err(|e| e.to_string())?;
            if let Err(e) = std::fs::rename(&file, &kept) {
                let _ = std::fs::remove_file(&fresh);
                return Err(e.to_string());
            }
            if let Err(e) = std::fs::rename(&fresh, &file) {
                let _ = std::fs::rename(&kept, &file);
                return Err(e.to_string());
            }
            room.clear();
            inner.floors.insert(project.to_path_buf(), last);
        }
        (self.on_message)(project, Change::Cleared);
        Ok(())
    }

    // 자동 깨우기가 멈춘 작업그룹 (WAKE_LIMIT에 닿음)
    pub fn paused(&self, project: &Path) -> Vec<String> {
        let inner = self.inner.lock().unwrap();
        let mut groups: Vec<String> = inner.limits.iter().filter(|((p, _), l)| p == project && l.count >= WAKE_LIMIT).map(|((_, g), _)| g.clone()).collect();
        groups.sort();
        groups
    }

    // 사용자가 그 작업그룹의 자동 깨우기를 재개한다: 다시 세고, 보류된 알림을 받는 사람마다 한 번 알린다
    pub fn resume(&self, project: &Path, group: &str) {
        let limit = self.inner.lock().unwrap().limits.remove(&(project.to_path_buf(), group.to_string()));
        let Some(mut limit) = limit else { return };
        limit.held.sort();
        limit.held.dedup();
        if !limit.held.is_empty() {
            (self.on_message)(project, Change::Released(&limit.held));
        }
        (self.on_message)(project, Change::Limits);
    }

    // 사용자가 이 참여자의 터미널에 입력했다 (pty_write): 그 작업그룹에 사용자가 개입한 것이므로 자동 깨우기를 다시 센다
    // (재개와 같다: 보류분은 받는 사람마다 한 번 깨운다). 지시를 채팅이 아니라 터미널에 쓰면 셈이 쌓이기만 해서 정상적인
    // 리뷰 흐름도 멈췄다 (2026-10-25). 셈이 없으면 아무것도 하지 않는다 (키마다 불린다).
    pub fn user_input(&self, token: &str) {
        let key = {
            let inner = self.inner.lock().unwrap();
            let Some(m) = inner.members.get(token) else { return };
            let Some(group) = group_of(&m.name) else { return };
            let key = (m.project.clone(), group.to_string());
            if !inner.limits.contains_key(&key) {
                return;
            }
            key
        };
        self.resume(&key.0, &key.1);
    }

    // 이 토큰의 참여자가 사용자를 기다린다 (Change::Attention)
    pub fn attention(&self, token: &str, kind: &str, hook: bool) {
        let who = self.inner.lock().unwrap().members.get(token).map(|m| (m.project.clone(), m.name.clone()));
        if let Some((project, name)) = who {
            (self.on_message)(&project, Change::Attention { name: &name, token, kind, hook });
        }
    }

    // 이 토큰의 참여자(창)의 CLI가 대화를 시작·전환함 (Change::Session). 모르는 토큰이면 false
    pub fn session_started(&self, token: &str, id: &str, source: &str) -> bool {
        let who = self.inner.lock().unwrap().members.get(token).map(|m| (m.project.clone(), m.key.clone()));
        let Some((project, key)) = who else { return false };
        (self.on_message)(&project, Change::Session { key: &key, id, source });
        true
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
        // /mcp/<토큰>: MCP. /attention/<토큰>: 그 참여자가 사용자를 기다린다는 신호 (claude 권한 확인 훅, 본문 없음).
        // /session/<토큰>: 그 참여자의 CLI가 대화를 시작·전환함 (claude SessionStart 훅, 본문은 훅 입력 JSON)
        let url = request.url().to_string();
        let attention = url.starts_with("/attention/");
        let session = url.starts_with("/session/");
        let token = ["/mcp/", "/attention/", "/session/"].iter().find_map(|p| url.strip_prefix(p)).map(str::to_string);
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
        if attention {
            self.attention(&token, "permission", true);
            let _ = request.respond(reply(204, String::new()));
            return;
        }
        if session {
            let input = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
            let id = input.get("session_id").and_then(Value::as_str).filter(|id| is_uuid(id));
            let code = match id {
                Some(id) => {
                    self.session_started(&token, id, input.get("source").and_then(Value::as_str).unwrap_or(""));
                    204
                }
                None => 400,
            };
            let _ = request.respond(reply(code, String::new()));
            return;
        }
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
                Some(Ok(m)) if m.held => text(
                    format!(
                        "Posted #{}, but nobody was notified: automatic notifications for your work group are paused after {WAKE_LIMIT} messages between sessions without the user. \
                        The message is saved and the user sees it; do not post it again. Notifications resume when the user writes to your work group or resumes them.",
                        m.id
                    ),
                    false,
                ),
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
                    .map(|m| format!("#{} {}{}{}: {}", m.id, m.from, if m.to.is_empty() { String::new() } else { format!(" → {}", m.to.join(", ")) }, if m.held { " (not notified)" } else { "" }, m.text))
                    .collect();
                text(lines.join("\n"), false)
            }
            other => text(format!("Unknown tool: {other}"), true),
        }
    }
}

// 앱이 뜰 때: 앱 데이터 chats 폴더로 서버를 띄우고, 새 메시지는 프론트에 "chat" 이벤트로 ({ project, message }),
// 참여자 변화는 "chat-members" 이벤트로 ({ project }) 알린다. 새 메시지에 멘션된 세션의 터미널은 깨우기를 기다리게 하고
// "chat-wake" 이벤트로 알린다 ({ pty, pending: true, seq }, src-tauri/src/pty.rs wake).
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
        use tauri::Manager;
        // 깨울 것을 모아 한 번에 예약한다 (pty::wake_all)
        let wake = |message: Option<&Message>, released: &[(String, String)]| {
            let items = emitter.state::<ChatsState>().0.as_ref().map(|c| c.wake_items(project, message, released)).unwrap_or_default();
            if items.is_empty() {
                return;
            }
            for (pty, seq) in crate::pty::wake_all(&emitter.state::<crate::pty::Ptys>(), &items) {
                let _ = emitter.emit("chat-wake", json!({ "pty": pty, "pending": true, "seq": seq }));
            }
            crate::mobile::publish(&emitter, Some(project), "waiting", json!({}));
        };
        match change {
            Change::Message(message, released) => {
                // 세션이 사용자에게 보낸 것만 알린다 (질문·결정 요청·작업 완료 보고. 사용자 자신이 보낸 것은 아님).
                // 화면 갱신·깨우기(터미널 잠금을 기다릴 수 있다)보다 먼저.
                // 선택 창 메시지는 "기다림" 알림(Attention)이 이미 알린다 (내용은 채팅에서 본다)
                if message.from != USER && message.to.iter().any(|n| n == USER) && message.prompt.is_none() {
                    crate::notify::send(project, crate::notify::Kind::Chat, &format!("{}: {}", message.from, crate::notify::first_line(&message.text)), None);
                }
                let _ = emitter.emit("chat", json!({ "project": project, "message": message }));
                crate::mobile::publish(&emitter, Some(project), "message", json!({ "message": message }));
                wake(Some(message), released);
            }
            Change::Members => {
                let _ = emitter.emit("chat-members", json!({ "project": project }));
                crate::mobile::publish(&emitter, Some(project), "members", json!({}));
            }
            Change::Limits => {
                let _ = emitter.emit("chat-limit", json!({ "project": project }));
                crate::mobile::publish(&emitter, Some(project), "members", json!({}));
            }
            Change::Released(released) => wake(None, released),
            Change::Seen => {
                let _ = emitter.emit("chat-seen", json!({ "project": project }));
                crate::mobile::publish(&emitter, Some(project), "unread", json!({}));
            }
            Change::Cleared => {
                let _ = emitter.emit("chat", json!({ "project": project }));
                crate::mobile::publish(&emitter, Some(project), "cleared", json!({}));
            }
            Change::Paused(group) => {
                crate::notify::send(project, crate::notify::Kind::Paused, &crate::notify::text("paused", &[("group", group), ("n", &WAKE_LIMIT.to_string())]), None);
            }
            Change::Attention { name, token, kind, hook } => {
                let ptys = emitter.state::<crate::pty::Ptys>();
                if hook && !ptys.claim_hook_attention(token, std::time::Instant::now()) {
                    return;
                }
                // 누르면 그 터미널로
                let pty = ptys.pty_of_token(token);
                let key = match kind {
                    "question" => "question",
                    "auth" => "auth",
                    "dialog" => "dialog",
                    "blocked" => "blocked",
                    _ => "attention",
                };
                crate::notify::send(project, crate::notify::Kind::Attention, &crate::notify::text(key, &[("name", name)]), pty);
            }
            // 창 키는 창마다 다른 UUID라 프론트는 프로젝트 경로를 맞추지 않고 키로 창을 찾는다 (Workspace.tsx)
            Change::Session { key, id, source } => {
                let _ = emitter.emit("session-id", json!({ "project": project, "key": key, "id": id, "source": source }));
            }
        }
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
    crate::platform::canonical(project).unwrap_or_else(|_| PathBuf::from(project))
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

// 자체 테스트: 터미널 없이 참여자를 넣고 뺀다 (폰에서 보내기에 받는 사람이 있게). 자체 테스트가 아니면 아무것도 하지 않는다
#[tauri::command]
pub fn selftest_chat_join(state: tauri::State<'_, ChatsState>, project: String, name: String) -> Option<String> {
    let chats = std::env::var_os("DDAK_SELFTEST").and(state.0.as_ref())?;
    Some(chats.join(&real(&project), &name, "").0)
}

// 자체 테스트: 참여자 이름으로 보낸다 (세션이 MCP로 보낸 것처럼)
#[tauri::command]
pub fn selftest_chat_post(state: tauri::State<'_, ChatsState>, project: String, from: String, text: String) -> Result<Message, String> {
    let chats = std::env::var_os("DDAK_SELFTEST").and(state.0.as_ref()).ok_or("selftest only")?;
    chats.post(&real(&project), &from, &text)
}

#[tauri::command]
pub fn selftest_chat_leave(state: tauri::State<'_, ChatsState>, token: String) {
    if let Some(chats) = std::env::var_os("DDAK_SELFTEST").and(state.0.as_ref()) {
        chats.leave(&token);
    }
}

// 대화를 모두 지운다 (사용자. 채팅 패널에서 확인을 받은 뒤)
#[tauri::command]
pub fn chat_clear(state: tauri::State<'_, ChatsState>, project: String) -> Result<(), String> {
    chats_of(&state)?.clear(&real(&project))
}

// 사용자에게 온 안 읽은 메시지 수 (Chats::unread. 사이드바·Dock 배지)
#[tauri::command]
pub fn chat_unread(state: tauri::State<'_, ChatsState>, project: String) -> Result<usize, String> {
    Ok(chats_of(&state)?.unread(&real(&project)))
}

// 여기까지 봤다 (채팅 패널을 보고 있을 때)
#[tauri::command]
pub fn chat_seen(state: tauri::State<'_, ChatsState>, project: String, id: u64) -> Result<(), String> {
    chats_of(&state)?.seen(&real(&project), id);
    Ok(())
}

// 자동 깨우기가 멈춘 작업그룹 (채팅 패널의 알림). 바뀌면 "chat-limit" 이벤트가 온다.
#[tauri::command]
pub fn chat_paused(state: tauri::State<'_, ChatsState>, project: String) -> Result<Vec<String>, String> {
    Ok(chats_of(&state)?.paused(&real(&project)))
}

#[tauri::command]
pub fn chat_resume(state: tauri::State<'_, ChatsState>, project: String, group: String) -> Result<(), String> {
    chats_of(&state)?.resume(&real(&project), &group);
    Ok(())
}

// 깨우기를 기다리는 참여자 (채팅 패널의 대기 표시). 대기가 바뀌면 "chat-wake" 이벤트가 온다.
#[tauri::command]
pub fn chat_waiting(state: tauri::State<'_, ChatsState>, ptys: tauri::State<'_, crate::pty::Ptys>, project: String) -> Result<Vec<String>, String> {
    let members = chats_of(&state)?.member_tokens(&real(&project));
    let waiting = ptys.waiting_tokens();
    let mut names: Vec<String> = members.into_iter().filter(|(t, _)| waiting.contains(t)).map(|(_, n)| n).collect();
    names.sort();
    names.dedup();
    Ok(names)
}

// 그 참여자를 기다리지 않고 바로 깨운다 (채팅 패널의 대기 표시를 누름)
#[tauri::command]
pub fn chat_wake_member(state: tauri::State<'_, ChatsState>, ptys: tauri::State<'_, crate::pty::Ptys>, project: String, name: String) -> Result<(), String> {
    let tokens = chats_of(&state)?.tokens_named(&real(&project), &[name]);
    ptys.wake_now_tokens(&tokens);
    Ok(())
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

    // 안 읽은 수 (모바일 3단계): 세션이 사용자에게 보낸 것 중 본 번호 뒤의 것. 앱을 켜기 전에 온 것은 읽은 것으로 친다.
    // 본 번호는 앞으로만 가고, 올라갈 때만 알린다 (처음 볼 때 앱을 켜기 전 것보다 뒤로 가지 않는다)
    #[test]
    fn unread_after_seen_and_start() {
        let dir = temp("unread");
        let a = Path::new("/p/a");
        let earlier = Chats::new(dir.clone(), Box::new(|_, _| {}), 0);
        earlier.join(a, "origin/dev", "k1");
        earlier.post(a, "origin/dev", "@user before start").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let notified = Arc::new(Mutex::new(0));
        let sink = notified.clone();
        let started = move || {
            let sink = sink.clone();
            Chats::new(dir.clone(), Box::new(move |_, c| if let Change::Seen = c { *sink.lock().unwrap() += 1 }), 0)
        };
        let chats = started();
        chats.join(a, "origin/dev", "k1");
        assert_eq!(chats.unread(a), 0, "앱을 켜기 전 메시지를 안 읽음으로 셈");
        let m2 = chats.post(a, "origin/dev", "@user first").unwrap();
        chats.post(a, USER, "@origin/dev ok").unwrap();
        let m4 = chats.post(a, "origin/dev", "@user second").unwrap();
        assert_eq!(chats.unread(a), 2);
        chats.seen(a, m2.id);
        assert_eq!((chats.unread(a), *notified.lock().unwrap()), (1, 1));
        chats.seen(a, 1);
        assert_eq!((chats.unread(a), *notified.lock().unwrap()), (1, 1), "앞 번호로 되돌아감");
        chats.seen(a, m4.id);
        assert_eq!((chats.unread(a), *notified.lock().unwrap()), (0, 2));
        // 다시 켠 뒤 처음 본 번호가 앞이어도 (폰이 0을 보냄) 앱을 켜기 전 것을 안 읽음으로 되돌리지 않는다
        std::thread::sleep(std::time::Duration::from_millis(5));
        let again = started();
        again.seen(a, 0);
        assert_eq!((again.unread(a), *notified.lock().unwrap()), (0, 2));
    }

    // 이름은 키마다 정해 두고 다른 키에는 주지 않는다 (-2). 멘션된 참여자(보낸 사람 빼고, @all·멘션 없는 사용자 메시지는 모두)만 to에 들어가고
    // 모르는 이름은 무시한다. 파일에 붙여서 다시 켜도 그대로 읽는다. 포트 없이 돈다.
    #[test]
    fn names_mentions_and_file() {
        let dir = temp("store");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let chats = Chats::new(dir.clone(), Box::new(move |_, c| {
            if let Change::Message(m, _) = c {
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
        // 사용자가 아무도 멘션하지 않으면 보내지 않는다 (기록·알림 없음). @all이면 모두에게. 세션이 멘션하지 않으면 아무에게도
        assert_eq!(chats.post(a, USER, "everyone, mail me at a@b.c").unwrap_err(), NO_RECIPIENT);
        let m3 = chats.post(a, USER, "@all mail me at a@b.c").unwrap();
        let m4 = chats.post(a, "origin/dev", "note to self").unwrap();
        assert_eq!(m3.to, ["origin/dev", "origin/dev-2", "user-2"]);
        assert!(m4.to.is_empty());
        assert_eq!(*seen.lock().unwrap(), [1, 2, 3, 4]);
        assert!(chats.messages(b).unwrap().is_empty());
        let again = Chats::new(dir.clone(), Box::new(|_, _| ()), 0);
        assert_eq!(again.messages(a).unwrap(), [m1, m2, m3, m4]);
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

    // 대화 지우기: 지운 파일은 cleared/로 옮겨 두고, 번호는 이어서 매긴다 (다시 켜도). 빈 방은 그대로. 읽은 위치가 번호라서
    // 지운 뒤 새 메시지는 since 없이 읽어도 보인다.
    #[test]
    fn clear_archives_and_keeps_numbering() {
        let dir = temp("clear");
        let p = Path::new("/p/c");
        let cleared = Arc::new(Mutex::new(0));
        let count = cleared.clone();
        let chats = Chats::new(dir.clone(), Box::new(move |_, c| if let Change::Cleared = c { *count.lock().unwrap() += 1 }), 0);
        chats.clear(p).unwrap();
        assert_eq!(*cleared.lock().unwrap(), 0, "빈 방을 지움");
        for t in ["one", "two", "three"] {
            chats.post(p, "origin/dev", t).unwrap();
        }
        chats.clear(p).unwrap();
        assert!(chats.messages(p).unwrap().is_empty());
        assert_eq!(*cleared.lock().unwrap(), 1);
        let kept: Vec<_> = std::fs::read_dir(dir.join("cleared")).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(load_messages(&kept[0].path()).unwrap().0.len(), 3);
        assert_eq!(chats.post(p, "origin/dev", "four").unwrap().id, 4);
        let again = Chats::new(dir.clone(), Box::new(|_, _| ()), 0);
        assert_eq!(again.messages(p).unwrap().iter().map(|m| m.id).collect::<Vec<_>>(), [4]);
        // 다시 켠 뒤 또 지워도 이어서
        again.clear(p).unwrap();
        assert_eq!(again.post(p, "origin/dev", "five").unwrap().id, 5);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 자동 깨우기 제한: 작업그룹마다 세션이 다른 세션에게 보낸 메시지를 세고 (@all도 1개, 사용자에게만 보낸 것·멘션 없는
    // 것은 세지 않음) WAKE_LIMIT개 뒤부터는 저장만 하고 깨우지 않는다 (held, to는 그대로). 다른 작업그룹·프로젝트는 따로 센다.
    // 사용자 메시지가 그 작업그룹에 닿거나 재개하면 다시 세고, 보류된 알림을 (받는 사람, 보낸 사람)마다 한 번 알린다.
    #[test]
    fn wake_limit_per_work_group() {
        let dir = temp("limit");
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = log.clone();
        let chats = Chats::new(dir.clone(), Box::new(move |_, c| {
            let entry = match c {
                Change::Message(_, []) | Change::Members | Change::Cleared | Change::Seen | Change::Attention { .. } | Change::Session { .. } => return,
                Change::Paused(g) => format!("paused {g}"),
                Change::Message(m, r) => format!("message {} released {r:?}", m.from),
                Change::Limits => "limits".to_string(),
                Change::Released(r) => format!("released {r:?}"),
            };
            sink.lock().unwrap().push(entry);
        }), 0);
        let taken = || std::mem::take(&mut *log.lock().unwrap());
        let (p, q) = (Path::new("/p/w"), Path::new("/p/q"));
        let tokens: Vec<String> = [(p, "g1/dev", "k1"), (p, "g1/rev", "k2"), (p, "g2/dev", "k3"), (q, "g1/dev", "k4"), (q, "g1/rev", "k5")]
            .into_iter()
            .map(|(project, name, key)| chats.join(project, name, key).0)
            .collect();
        let post = |project: &Path, from: &str, text: &str| chats.post(project, from, text).unwrap();
        for _ in 0..4 {
            assert!(!post(p, "g1/dev", "@user done").held && !post(p, "g1/dev", "note").held);
        }
        for _ in 0..5 {
            assert!(!post(p, "g1/dev", "@g1/rev hi").held);
        }
        assert!(chats.paused(p).is_empty());
        assert!(!post(p, "g1/dev", "@all hi").held);
        // 막 멈췄을 때 한 번 알린다 (사용자 알림)
        assert_eq!((chats.paused(p), taken()), (vec!["g1".to_string()], vec!["limits".to_string(), "paused g1".to_string()]));
        let held = post(p, "g1/rev", "@g1/dev again");
        assert!(held.held && held.to == ["g1/dev"]);
        assert!(post(p, "g1/rev", "@g1/dev more").held);
        assert!(taken().is_empty(), "보류할 때마다 알림");
        // 다른 작업그룹·프로젝트는 따로 센다
        assert!(!post(p, "g2/dev", "@g1/dev hi").held && !post(q, "g1/dev", "@g1/rev hi").held);
        // 저장한 파일에도 held가 남는다
        let again = Chats::new(dir.clone(), Box::new(|_, _| ()), 0);
        assert!(again.messages(p).unwrap().iter().any(|m| m.id == held.id && m.held));
        // 사용자 메시지가 g1에 닿으면 다시 센다 (g2는 그대로). 사용자 알림과 풀려난 보류분은 한꺼번에 깨운다 (리뷰 2단계 R1)
        let go_on = post(p, USER, "@g1/dev go on");
        assert!(!go_on.held);
        let released = [("g1/dev".to_string(), "g1/rev".to_string())];
        assert_eq!(chats.wake_items(p, Some(&go_on), &released), [(tokens[0].clone(), USER.to_string()), (tokens[0].clone(), "g1/rev".to_string())]);
        assert!(chats.wake_items(p, Some(&held), &[]).is_empty(), "보류한 메시지를 깨움");
        assert_eq!(taken(), [r#"message user released [("g1/dev", "g1/rev")]"#, "limits"]);
        assert!(chats.paused(p).is_empty() && !post(p, "g1/rev", "@g1/dev ok").held);
        for _ in 0..5 {
            post(p, "g2/dev", "@g1/dev x");
        }
        assert_eq!(chats.paused(p), ["g2"]);
        // 재개 버튼
        taken();
        assert!(post(p, "g2/dev", "@g1/rev y").held);
        chats.resume(p, "g2");
        chats.resume(p, "g2");
        assert_eq!(taken(), [r#"released [("g1/rev", "g2/dev")]"#, "limits"]);
        assert!(chats.paused(p).is_empty());
        // 사용자가 그 작업그룹 세션의 터미널에 입력해도 다시 센다 (다른 그룹·프로젝트는 그대로, 셈이 없으면 아무것도 안 함)
        for _ in 0..6 {
            post(p, "g1/dev", "@g1/rev z");
        }
        assert!(post(p, "g1/dev", "@g1/rev held").held);
        post(q, "g1/dev", "@g1/rev q");
        taken();
        chats.user_input(&tokens[2]);
        assert_eq!(chats.paused(p), ["g1"], "다른 그룹의 입력으로 풀림");
        chats.user_input(&tokens[1]);
        assert!(chats.paused(p).is_empty() && taken() == [r#"released [("g1/rev", "g1/dev")]"#, "limits"]);
        chats.user_input(&tokens[1]);
        assert!(taken().is_empty(), "셈이 없는데 알림");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 리뷰 P2: 사용자가 멘션한 세션이 보내기 전에 나갔으면 모두에게 보내지 않는다. 나간 세션·모르는 이름만이면 받을 사람이
    // 없어 보내지 않는다.
    #[test]
    fn mention_of_left_session_is_not_broadcast() {
        let dir = temp("left");
        let p = Path::new("/p/l");
        let chats = Chats::new(dir.clone(), Box::new(|_, _| ()), 0);
        chats.join(p, "origin/dev", "k1");
        let (t, _, _) = chats.join(p, "origin/reviewer", "k2");
        chats.leave(&t);
        // 나간 세션이나 모르는 이름만 멘션하면 받을 사람이 없어 보내지 않는다 (모두에게 가지 않는다)
        assert_eq!(chats.post(p, USER, "@origin/reviewer 확인해 줘").unwrap_err(), NO_RECIPIENT);
        assert_eq!(chats.post(p, USER, "@origin/nobody hi").unwrap_err(), NO_RECIPIENT);
        assert!(chats.messages(p).unwrap().is_empty());
        assert_eq!(chats.post(p, USER, "@origin/reviewer @origin/dev 확인해 줘").unwrap().to, ["origin/dev"]);
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
        let line = |id: u64| serde_json::to_string(&Message { id, time: 0, from: USER.into(), text: format!("m{id}"), to: vec![], held: false, via: None, prompt: None, answer: None, mode: None }).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let mut bytes = format!("{}\n", line(1)).into_bytes();
        bytes.extend(b"\xff\xfe broken\n");
        bytes.extend(format!("{}\n{{\"id\":3,\"ti", line(2)).into_bytes());
        std::fs::write(chats.file(p), &bytes).unwrap();
        assert_eq!(chats.messages(p).unwrap().iter().map(|m| m.id).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(chats.post(p, "origin/dev", "new").unwrap().id, 3);
        let again = Chats::new(dir.clone(), Box::new(|_, _| ()), 0);
        assert_eq!(again.messages(p).unwrap().iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), ["m1", "m2", "new"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 리뷰 P2: 파일을 읽지 못하면 (없음이 아니면) 빈 방으로 보지 않는다. 읽기·쓰기 모두 오류이고 파일은 그대로다.
    // 고치면 다시 읽는다.
    #[cfg(unix)]
    #[test]
    fn unreadable_room_refuses_reads_and_writes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("unreadable");
        let p = Path::new("/p/u");
        let first = Chats::new(dir.clone(), Box::new(|_, _| ()), 0);
        first.post(p, "origin/dev", "one").unwrap();
        first.post(p, "origin/dev", "two").unwrap();
        let file = first.file(p);
        let before = std::fs::read(&file).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o200)).unwrap();
        let chats = Chats::new(dir.clone(), Box::new(|_, _| ()), 0);
        let (read, post) = (chats.messages(p).is_err(), chats.post(p, "origin/dev", "three").is_err());
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read && post, "읽기 {read}, 쓰기 {post}");
        assert_eq!(std::fs::read(&file).unwrap(), before);
        assert_eq!(chats.post(p, "origin/dev", "three").unwrap().id, 3);
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
        let seen_attention = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = seen_attention.clone();
        let chats = Chats::start(
            dir.clone(),
            Box::new(move |_, c| match c {
                Change::Attention { name, kind, hook, .. } => sink.lock().unwrap().push(format!("{name} {kind} {hook}")),
                Change::Session { key, id, source } => sink.lock().unwrap().push(format!("session {key} {id} {source}")),
                _ => {}
            }),
        )
        .unwrap();
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
        chats.post(project, USER, "@all third").unwrap();
        assert_eq!(call("read_messages", json!({})), "#3 user → origin/dev: @all third");
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
        // 사용자를 기다린다는 신호 (claude 권한 확인 훅): 그 참여자의 /attention/<토큰>. 모르는 토큰 404, GET 405, 다른 Host 403
        let attention = path.replacen("/mcp/", "/attention/", 1);
        assert_eq!(http(chats.port, "POST", &attention, &host, "").0, 204);
        assert_eq!(*seen_attention.lock().unwrap(), ["origin/dev permission true"]);
        // 터미널의 프로그램 상태에서 온 것 (pty_awaiting): 기다리는 것의 종류. 모르는 토큰은 없음
        chats.attention(path.trim_start_matches("/mcp/"), "question", false);
        chats.attention("nope", "question", false);
        assert_eq!(*seen_attention.lock().unwrap(), ["origin/dev permission true", "origin/dev question false"]);
        assert_eq!(http(chats.port, "POST", "/attention/nope", &host, "").0, 404);
        assert_eq!(http(chats.port, "GET", &attention, &host, "").0, 405);
        assert_eq!(http(chats.port, "POST", &attention, "evil.example:80", "").0, 403);
        // 대화를 시작·전환함 (claude SessionStart 훅): /session/<토큰>에 훅 입력 JSON. 그 창 키·새 ID·source를 알린다.
        // ID가 UUID가 아니거나 본문이 JSON이 아니면 400, 모르는 토큰 404, GET 405, 다른 Host 403
        let session = path.replacen("/mcp/", "/session/", 1);
        let id = "0de1a391-15e0-4a5a-bbfb-a823ddce0189";
        let input = json!({ "session_id": id, "source": "clear", "hook_event_name": "SessionStart", "cwd": "/p/x" }).to_string();
        assert_eq!(http(chats.port, "POST", &session, &host, &input).0, 204);
        assert_eq!(seen_attention.lock().unwrap().last().unwrap(), &format!("session k {id} clear"));
        let before = seen_attention.lock().unwrap().len();
        for bad in [json!({ "session_id": "x; rm -rf /" }).to_string(), json!({ "source": "clear" }).to_string(), "{broken".into()] {
            assert_eq!(http(chats.port, "POST", &session, &host, &bad).0, 400, "{bad}");
        }
        assert_eq!(http(chats.port, "POST", "/session/nope", &host, &input).0, 404);
        assert_eq!(http(chats.port, "GET", &session, &host, "").0, 405);
        assert_eq!(http(chats.port, "POST", &session, "evil.example:80", &input).0, 403);
        assert_eq!(seen_attention.lock().unwrap().len(), before, "거절한 요청은 알리지 않음");
        assert!(is_uuid(id) && !is_uuid(&id.to_uppercase().replace('-', "_")) && !is_uuid(&id[1..]));
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
            if let Change::Message(m, _) = c {
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
