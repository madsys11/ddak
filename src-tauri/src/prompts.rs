// 선택 창을 채팅으로 (docs/spec.md "선택 창 답하기"). 세션의 프로그램(claude·codex)이 권한 확인·질문 같은 선택 창을 띄우면
// 그 세션 이름으로 채팅에 질문과 선택지를 올리고, 사용자가 채팅(맥 패널·폰)에서 고르면 그 터미널에 답을 넣는다.
// 맥 앞에 없어도 폰으로 일을 이어 가게 (선택 창이 떠 있는 동안은 채팅 알림도 미뤄져서 폰만으로는 풀 방법이 없었다).
//
// - 화면을 읽는 것은 프론트다 (src/programStatus.ts readDialog, Terminal.tsx): 선택 창이 보이거나 바뀌거나 사라지면 `pty_dialog`로
//   알린다 (seq: 그 터미널이 보낸 차례). 같은 선택 창이면 (커서만 움직임) 새로 올리지 않는다.
// - 답: 열려 있는 선택 창에만, 한 번에 하나씩. Rust는 프론트에 `prompt-answer`를 보내고, 프론트가 그때 화면의 선택 창이 알린
//   것과 같은지 보고 화살표로 커서를 옮겨 옮겨진 것을 확인한 뒤에만 Enter를 보낸다. 결과(`prompt_result`)를 채팅에 기록한다.
// - 확인 단계(승인일 수 있는 선택지는 한 번 더 묻기)는 화면(채팅 패널·폰)이 한다. 여기서는 선택지마다 confirm만 정한다.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{Emitter, Manager, State};

use crate::chat::{Answer, Chats, ChatsState, Prompt, PromptOption, USER};

// 화면에서 읽은 선택 창 (src/programStatus.ts Dialog)
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Dialog {
    pub question: Vec<String>,
    pub options: Vec<String>,
    // 커서가 놓인 선택지 (0부터)
    pub cursor: usize,
    // 질문의 위 경계(가로줄·빈 줄 셋)를 화면 안에서 찾았다. 아니면 질문이 화면 밖으로 잘렸을 수 있어 채팅에서는 답하지 않는다
    pub complete: bool,
}

impl Dialog {
    // 같은 선택 창인지 (커서 위치는 보지 않는다)
    fn same(&self, other: &Dialog) -> bool {
        self.question == other.question && self.options == other.options && self.complete == other.complete
    }
}

struct Open {
    project: PathBuf,
    member: String,
    pty: u32,
    // 그 터미널이 마지막으로 알린 차례 (답할 때 프론트가 그 뒤로 바뀌지 않았는지 본다)
    seq: u64,
    dialog: Dialog,
    // 답을 보내는 중. 결과가 오지 않으면 ANSWER_WAIT 뒤에 다시 받는다 (새 요청 번호: 앞 요청의 결과는 버린다. 프론트는 같은
    // 터미널에 새 답이 오면 앞의 것을 취소한다)
    answering: Option<Answering>,
}

struct Answering {
    at: Instant,
    request: u64,
    via: Option<String>,
}

// 닫힌 선택 창을 잠시 기억한다: 화면을 다시 그리며 잠깐 사라졌다 같은 것이 다시 보이면 새로 올리지 않고 그 id를 다시 연다
struct Closed {
    id: String,
    open: Open,
    at: Instant,
}

const ANSWER_WAIT: Duration = Duration::from_secs(10);
const REOPEN_WITHIN: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct Prompts {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    // 선택 창 id → 열린 것
    open: HashMap<String, Open>,
    // 터미널 → 마지막에 닫힌 것
    closed: HashMap<u32, Closed>,
    // 마지막 답 요청 번호
    requests: u64,
}

// 추측할 수 없는 id (macOS arc4random)
fn prompt_id() -> String {
    let mut bytes = [0u8; 12];
    unsafe { libc::arc4random_buf(bytes.as_mut_ptr().cast(), bytes.len()) };
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// 거절·취소 쪽 선택지는 확인 없이 보낸다. 그 밖은 승인일 수 있어 확인을 받는다. 질문(AskUserQuestion 등)의 답은 확인 없이
fn needs_confirm(kind: &str, label: &str) -> bool {
    if kind == "question" {
        return false;
    }
    let l = label.trim().to_lowercase();
    let word = |w: &str| l == w || l.starts_with(&format!("{w} ")) || l.starts_with(&format!("{w},")) || l.starts_with(&format!("{w}("));
    !(["no", "cancel", "deny", "reject", "exit"].iter().any(|w| word(w)) || ["아니", "취소", "거절", "거부"].iter().any(|w| l.starts_with(w)))
}

// 채팅에 보일 글 (세션이 읽을 일은 없다: 받는 사람은 사용자뿐)
fn prompt_text(dialog: &Dialog) -> String {
    let options: Vec<String> = dialog.options.iter().enumerate().map(|(i, o)| format!("{}. {o}", i + 1)).collect();
    [dialog.question.join("\n"), options.join("\n")].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n")
}

pub enum Report {
    // 할 일 없음
    None,
    // 열린 목록이 바뀜 (이 프로젝트들)
    Changed(Vec<PathBuf>),
    // 새 선택 창: 채팅에 올린다
    New { project: PathBuf, member: String, prompt: Prompt, text: String, closed: Vec<PathBuf> },
}

impl Prompts {
    // 터미널의 선택 창이 바뀌었다. member: 그 터미널이 채팅방 참여자면 (프로젝트, 이름)
    pub fn report(&self, pty: u32, seq: u64, kind: &str, member: Option<(PathBuf, String)>, dialog: Option<Dialog>, now: Instant) -> Report {
        let mut inner = self.inner.lock().unwrap();
        let current = inner.open.iter().find(|(_, o)| o.pty == pty).map(|(id, _)| id.clone());
        if let (Some(id), Some(d)) = (&current, &dialog) {
            let o = inner.open.get_mut(id).unwrap();
            if o.dialog.same(d) {
                o.seq = seq;
                o.dialog.cursor = d.cursor;
                return Report::None;
            }
        }
        let mut changed = Vec::new();
        if let Some(id) = current {
            let o = inner.open.remove(&id).unwrap();
            changed.push(o.project.clone());
            inner.closed.insert(pty, Closed { id, open: o, at: now });
        }
        let (Some(d), Some((project, member))) = (dialog, member) else {
            return if changed.is_empty() { Report::None } else { Report::Changed(changed) };
        };
        if d.options.is_empty() {
            return if changed.is_empty() { Report::None } else { Report::Changed(changed) };
        }
        // 방금 닫힌 같은 선택 창이면 다시 연다 (새로 올리지 않는다). 다른 선택 창이면 닫힌 것은 남겨 둔다 (그 답의 결과가
        // 아직 올 수 있다, finish)
        if inner.closed.get(&pty).is_some_and(|c| c.open.dialog.same(&d) && now.duration_since(c.at) < REOPEN_WITHIN) {
            let Closed { id, open: mut o, .. } = inner.closed.remove(&pty).unwrap();
            // 보내던 답은 그대로 둔다 (잠깐 다시 그린 것뿐이라 그 답의 결과를 기다린다. 리뷰 R3)
            o.seq = seq;
            o.dialog.cursor = d.cursor;
            changed.push(o.project.clone());
            inner.open.insert(id, o);
            return Report::Changed(changed);
        }
        let id = prompt_id();
        let prompt = Prompt {
            id: id.clone(),
            kind: kind.to_string(),
            question: d.question.clone(),
            options: d.options.iter().map(|l| PromptOption { label: l.clone(), confirm: needs_confirm(kind, l) }).collect(),
            answerable: d.complete,
        };
        let text = prompt_text(&d);
        inner.open.insert(id, Open { project: project.clone(), member: member.clone(), pty, seq, dialog: d, answering: None });
        Report::New { project, member, prompt, text, closed: changed }
    }

    // 이 프로젝트에 열린 선택 창 id (alive: 아직 있는 터미널인지)
    pub fn open_in(&self, project: &Path, alive: impl Fn(u32) -> bool) -> Vec<String> {
        let inner = self.inner.lock().unwrap();
        let mut ids: Vec<String> = inner.open.iter().filter(|(_, o)| o.project == project && alive(o.pty)).map(|(id, _)| id.clone()).collect();
        ids.sort();
        ids
    }

    // 답을 보내기 시작한다: (터미널, 차례, 요청 번호). 열려 있지 않거나 다른 프로젝트·없는 선택지·이미 보내는 중이거나 질문이
    // 화면 밖으로 잘렸으면 오류
    pub fn begin(&self, project: &Path, id: &str, option: usize, via: Option<&str>, now: Instant) -> Result<(u32, u64, u64), String> {
        let mut inner = self.inner.lock().unwrap();
        inner.requests += 1;
        let request = inner.requests;
        let o = inner.open.get_mut(id).filter(|o| o.project == project).ok_or("closed")?;
        if !o.dialog.complete {
            return Err("incomplete".into());
        }
        if option >= o.dialog.options.len() {
            return Err("option".into());
        }
        if o.answering.as_ref().is_some_and(|a| now.duration_since(a.at) < ANSWER_WAIT) {
            return Err("busy".into());
        }
        o.answering = Some(Answering { at: now, request, via: via.map(str::to_string) });
        Ok((o.pty, o.seq, request))
    }

    // 답의 키를 쓴다: 그 터미널에 지금 열려 있는 그 선택 창의 지금 요청일 때만, 잠금을 쥔 채로 (확인과 쓰기 사이에 새 요청이
    // 끼지 않게). 앞 요청이 늦게 오거나 순서가 바뀌어 와도 그 키는 쓰이지 않는다 (재리뷰 R3). 닫힌 선택 창의 요청은 결과 기록만
    // 받고 키는 쓰지 않는다 (닫힌 사이 같은 터미널에 다른 선택 창이 떠 있을 수 있다, 재리뷰 R6)
    pub fn guarded<T>(&self, id: &str, request: u64, pty: u32, write: impl FnOnce() -> T) -> Result<T, String> {
        let inner = self.inner.lock().unwrap();
        let current = |o: &Open| o.pty == pty && o.answering.as_ref().is_some_and(|a| a.request == request);
        if !inner.open.get(id).is_some_and(current) {
            return Err("stale".into());
        }
        Ok(write())
    }

    // 프론트가 답을 보낸 결과. 기록할 것: (프로젝트, 답, 보낸 기기). 지금 보내는 요청의 결과만 받는다 (시간이 지나 다시 보냈거나
    // 이미 끝난 요청의 늦은 결과는 버린다, 리뷰 R3). 보냈으면 그 선택 창은 닫는다.
    // Enter 뒤 화면이 먼저 바뀌어 이미 닫혔을 수 있다 (닫힌 것에서 찾는다: 다시 열지 않게 지운다)
    pub fn finish(&self, id: &str, request: u64, option: usize, result: &str) -> Option<(PathBuf, Answer, Option<String>)> {
        let mut inner = self.inner.lock().unwrap();
        let current = |a: &Option<Answering>| a.as_ref().is_some_and(|a| a.request == request);
        if !inner.open.contains_key(id) {
            let pty = inner.closed.iter().find(|(_, c)| c.id == id && current(&c.open.answering)).map(|(pty, _)| *pty)?;
            let mut c = inner.closed.remove(&pty).unwrap();
            let via = c.open.answering.take().and_then(|a| a.via);
            let answer = Answer { prompt: id.to_string(), member: c.open.member.clone(), option, label: c.open.dialog.options.get(option).cloned().unwrap_or_default(), result: result.to_string() };
            return Some((c.open.project, answer, via));
        }
        let o = inner.open.get_mut(id).filter(|o| current(&o.answering))?;
        let via = o.answering.take().and_then(|a| a.via);
        let answer = Answer {
            prompt: id.to_string(),
            member: o.member.clone(),
            option,
            label: o.dialog.options.get(option).cloned().unwrap_or_default(),
            result: result.to_string(),
        };
        let project = o.project.clone();
        if result == "sent" {
            let pty = o.pty;
            inner.open.remove(id);
            inner.closed.remove(&pty);
        }
        Some((project, answer, via))
    }
}

fn changed(app: &tauri::AppHandle, projects: &[PathBuf]) {
    for p in projects {
        let _ = app.emit("chat-prompts", json!({ "project": p }));
        crate::mobile::publish(app, Some(p), "members", json!({}));
    }
}

fn chats(app: &tauri::AppHandle) -> Option<Arc<Chats>> {
    app.state::<ChatsState>().0.clone()
}

// 터미널의 선택 창 (프론트 Terminal.tsx). dialog: 없으면 닫힘
#[tauri::command]
pub fn pty_dialog(app: tauri::AppHandle, ptys: State<'_, crate::pty::Ptys>, prompts: State<'_, Prompts>, id: u32, seq: u64, kind: String, dialog: Option<Dialog>) {
    let Some(chats) = chats(&app) else { return };
    let member = ptys.token_of(id).and_then(|t| chats.member_of(&t));
    match prompts.report(id, seq, &kind, member, dialog, Instant::now()) {
        Report::None => {}
        Report::Changed(projects) => changed(&app, &projects),
        Report::New { project, member, prompt, text, closed } => {
            if let Err(e) = chats.post_note(&project, &member, &text, vec![USER.to_string()], Some(prompt), None, None) {
                eprintln!("선택 창을 채팅에 올리지 못함: {e}");
            }
            changed(&app, &closed);
            changed(&app, &[project]);
        }
    }
}

// 열린 선택 창 id (채팅 패널: 이것만 누를 수 있다)
#[tauri::command]
pub fn chat_prompts(ptys: State<'_, crate::pty::Ptys>, prompts: State<'_, Prompts>, project: String) -> Vec<String> {
    let project = std::fs::canonicalize(&project).unwrap_or_else(|_| PathBuf::from(&project));
    prompts.open_in(&project, |pty| ptys.exists(pty))
}

// 답을 보낸다 (맥 채팅 패널, 폰 mobile.rs). 프론트가 넣고 결과를 prompt_result로 알린다
pub fn answer(app: &tauri::AppHandle, project: &Path, id: &str, option: usize, via: Option<&str>) -> Result<(), String> {
    let prompts = app.state::<Prompts>();
    let (pty, seq, request) = prompts.begin(project, id, option, via, Instant::now())?;
    if !app.state::<crate::pty::Ptys>().exists(pty) {
        prompts.finish(id, request, option, "changed");
        return Err("closed".into());
    }
    app.emit("prompt-answer", json!({ "pty": pty, "seq": seq, "prompt": id, "option": option, "request": request })).map_err(|e| e.to_string())
}

// 답의 키 하나를 그 터미널에 쓴다 (프론트 Terminal.tsx). 지금 보내는 요청이 아니면 "stale"
#[tauri::command]
pub fn prompt_write(ptys: State<'_, crate::pty::Ptys>, chats: State<'_, ChatsState>, prompts: State<'_, Prompts>, id: u32, prompt: String, request: u64, data: String) -> Result<(), String> {
    let typed_in = prompts.guarded(&prompt, request, id, || crate::pty::write_input(&ptys, id, &data, true))??;
    // 사용자 입력처럼 (pty_write와 같게, 잠금 밖에서)
    if let (Some(token), Some(chats)) = (typed_in, chats.0.as_ref()) {
        chats.user_input(&token);
    }
    Ok(())
}

#[tauri::command]
pub fn chat_answer(app: tauri::AppHandle, project: String, prompt: String, option: usize) -> Result<(), String> {
    let project = std::fs::canonicalize(&project).unwrap_or_else(|_| PathBuf::from(&project));
    answer(&app, &project, &prompt, option, None)
}

// 프론트가 답을 넣은 결과 (sent·changed·failed). 채팅에 기록한다
#[tauri::command]
pub fn prompt_result(app: tauri::AppHandle, prompts: State<'_, Prompts>, prompt: String, request: u64, option: usize, result: String) {
    let Some((project, answer, via)) = prompts.finish(&prompt, request, option, &result) else { return };
    if let Some(chats) = chats(&app) {
        let text = format!("{}: {} — {}", answer.member, answer.label, answer.result);
        if let Err(e) = chats.post_note(&project, USER, &text, Vec::new(), None, Some(answer), via.as_deref()) {
            eprintln!("선택 창의 답을 기록하지 못함: {e}");
        }
    }
    changed(&app, &[project]);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dialog(options: &[&str], cursor: usize) -> Dialog {
        Dialog { question: vec!["Bash command".into(), "npm test".into(), "Do you want to proceed?".into()], options: options.iter().map(|s| s.to_string()).collect(), cursor, complete: true }
    }
    fn member() -> Option<(PathBuf, String)> {
        Some((PathBuf::from("/p"), "g/dev".into()))
    }

    #[test]
    fn confirm_only_for_approvals() {
        assert!(needs_confirm("permission", "Yes"));
        assert!(needs_confirm("permission", "Yes, and don't ask again for npm test commands"));
        assert!(needs_confirm("dialog", "Yes, I trust this folder"));
        assert!(!needs_confirm("permission", "No, and tell Claude what to do differently (esc)"));
        assert!(!needs_confirm("dialog", "No, exit"));
        assert!(!needs_confirm("permission", "아니요"));
        assert!(!needs_confirm("question", "Yes"));
        assert!(needs_confirm("permission", "Nothing to lose"), "no로 시작하는 낱말은 거절이 아니다");
    }

    // 새 선택 창은 올리고, 커서만 움직이면 그대로, 바뀌면 닫고 새로, 사라지면 닫고, 잠깐 사라졌다 같은 것이 보이면 다시 연다
    #[test]
    fn follows_the_screen() {
        let p = Prompts::default();
        let t0 = Instant::now();
        let Report::New { prompt, text, .. } = p.report(1, 1, "permission", member(), Some(dialog(&["Yes", "No"], 0)), t0) else { panic!("새 선택 창") };
        assert_eq!(prompt.options.iter().map(|o| o.confirm).collect::<Vec<_>>(), [true, false]);
        assert!(text.ends_with("1. Yes\n2. No"), "{text}");
        let id = prompt.id;
        assert!(matches!(p.report(1, 2, "permission", member(), Some(dialog(&["Yes", "No"], 1)), t0), Report::None));
        let (pty, seq, request) = p.begin(Path::new("/p"), &id, 0, None, t0).unwrap();
        assert_eq!((pty, seq), (1, 2), "커서만 움직이면 같은 선택 창, 차례는 새 것");
        p.finish(&id, request, 0, "failed");
        assert!(matches!(p.report(1, 3, "permission", member(), None, t0), Report::Changed(_)));
        assert!(p.open_in(Path::new("/p"), |_| true).is_empty());
        assert!(matches!(p.report(1, 4, "permission", member(), Some(dialog(&["Yes", "No"], 0)), t0 + Duration::from_secs(1)), Report::Changed(_)), "다시 염");
        assert_eq!(p.open_in(Path::new("/p"), |_| true), [id.clone()]);
        assert!(matches!(p.report(1, 5, "permission", member(), Some(dialog(&["Allow", "Deny"], 0)), t0), Report::New { .. }), "바뀌면 새로");
        assert_eq!(p.open_in(Path::new("/p"), |_| true).len(), 1);
        assert!(!p.open_in(Path::new("/p"), |_| true).contains(&id));
        // 참여자가 아닌 터미널, 선택지가 없는 것은 올리지 않는다
        assert!(matches!(p.report(2, 1, "permission", None, Some(dialog(&["Yes"], 0)), t0), Report::None));
        assert!(matches!(p.report(3, 1, "permission", member(), Some(dialog(&[], 0)), t0), Report::None));
    }

    // 답은 열린 선택 창에만, 그 프로젝트에서, 있는 선택지로, 한 번에 하나 (결과가 오지 않으면 잠시 뒤 새 요청으로 다시). 앞
    // 요청의 늦은 결과는 버린다. 보내면 닫힌다
    #[test]
    fn answers_once() {
        let p = Prompts::default();
        let t0 = Instant::now();
        let Report::New { prompt, .. } = p.report(1, 1, "permission", member(), Some(dialog(&["Yes", "No"], 0)), t0) else { panic!() };
        let id = prompt.id;
        assert_eq!(p.begin(Path::new("/other"), &id, 0, None, t0), Err("closed".into()));
        assert_eq!(p.begin(Path::new("/p"), "nope", 0, None, t0), Err("closed".into()));
        assert_eq!(p.begin(Path::new("/p"), &id, 2, None, t0), Err("option".into()));
        let (_, _, first) = p.begin(Path::new("/p"), &id, 1, Some("phone"), t0).unwrap();
        assert_eq!(p.begin(Path::new("/p"), &id, 0, None, t0), Err("busy".into()));
        let (_, _, second) = p.begin(Path::new("/p"), &id, 0, Some("mac"), t0 + ANSWER_WAIT).expect("결과가 오지 않으면 다시");
        assert!(p.finish(&id, first, 1, "sent").is_none(), "앞 요청의 늦은 결과는 버림");
        assert_eq!(p.open_in(Path::new("/p"), |_| true), [id.clone()], "버린 결과로 닫지 않음");
        let (project, answer, via) = p.finish(&id, second, 0, "sent").unwrap();
        assert_eq!((project, answer.label.as_str(), answer.member.as_str(), via.as_deref()), (PathBuf::from("/p"), "Yes", "g/dev", Some("mac")));
        assert_eq!(p.begin(Path::new("/p"), &id, 0, None, t0), Err("closed".into()), "보내면 닫힘");
        assert!(matches!(p.report(1, 2, "permission", member(), Some(dialog(&["Yes", "No"], 0)), t0), Report::New { .. }), "보낸 뒤 같은 것이 다시 뜨면 새 선택 창");
    }

    // 실패한 답 뒤에는 다시 고를 수 있다. 잠깐 닫혔다 다시 열려도 보내던 답은 그대로 (그 결과를 받는다)
    #[test]
    fn retry_after_failure_and_flicker() {
        let p = Prompts::default();
        let t0 = Instant::now();
        let Report::New { prompt, .. } = p.report(1, 1, "permission", member(), Some(dialog(&["Yes", "No"], 0)), t0) else { panic!() };
        let id = prompt.id;
        let (_, _, r1) = p.begin(Path::new("/p"), &id, 0, None, t0).unwrap();
        assert_eq!(p.finish(&id, r1, 0, "failed").unwrap().1.result, "failed");
        let (_, _, r2) = p.begin(Path::new("/p"), &id, 1, Some("phone"), t0).expect("실패한 뒤 다시");
        assert!(matches!(p.report(1, 2, "permission", member(), None, t0), Report::Changed(_)));
        assert!(matches!(p.report(1, 3, "permission", member(), Some(dialog(&["Yes", "No"], 0)), t0), Report::Changed(_)), "다시 염");
        assert_eq!(p.begin(Path::new("/p"), &id, 0, None, t0), Err("busy".into()), "다시 열려도 보내던 답은 그대로");
        assert_eq!(p.finish(&id, r2, 1, "sent").unwrap().2.as_deref(), Some("phone"));
    }

    // 질문이 화면 밖으로 잘렸을 수 있는 선택 창은 올리되 답하지 않는다 (리뷰 R2)
    #[test]
    fn no_answer_when_question_is_cut() {
        let p = Prompts::default();
        let t0 = Instant::now();
        let mut d = dialog(&["Yes", "No"], 0);
        d.complete = false;
        let Report::New { prompt, .. } = p.report(1, 1, "permission", member(), Some(d), t0) else { panic!() };
        assert!(!prompt.answerable);
        assert_eq!(p.begin(Path::new("/p"), &prompt.id, 1, None, t0), Err("incomplete".into()));
    }

    // 키는 그 터미널에 열린 선택 창의 지금 요청일 때만 쓴다: 새 요청이 생긴 뒤의 앞 요청, 다른 터미널, 닫힌 선택 창(다른 선택
    // 창으로 바뀜, 그 뒤 새 선택 창에 요청이 생겨도), 끝난 요청은 쓰지 않는다. 닫힌 선택 창의 결과 기록은 받는다
    #[test]
    fn writes_only_for_the_current_request() {
        let p = Prompts::default();
        let t0 = Instant::now();
        let Report::New { prompt, .. } = p.report(1, 1, "permission", member(), Some(dialog(&["Yes", "No"], 0)), t0) else { panic!() };
        let (_, _, first) = p.begin(Path::new("/p"), &prompt.id, 0, None, t0).unwrap();
        let (_, _, second) = p.begin(Path::new("/p"), &prompt.id, 1, None, t0 + ANSWER_WAIT).unwrap();
        let mut wrote = Vec::new();
        assert_eq!(p.guarded(&prompt.id, first, 1, || wrote.push("old")), Err("stale".into()));
        assert_eq!(p.guarded(&prompt.id, second, 2, || wrote.push("other pty")), Err("stale".into()));
        assert_eq!(p.guarded(&prompt.id, second, 1, || wrote.push("new")), Ok(()));
        // 다른 선택 창 B로 바뀐 뒤에는 A의 요청으로 쓰지 않는다 (B에 새 요청이 생겨도)
        let Report::New { prompt: b, .. } = p.report(1, 2, "question", member(), Some(dialog(&["A", "B"], 0)), t0) else { panic!() };
        assert_eq!(p.guarded(&prompt.id, second, 1, || wrote.push("after close")), Err("stale".into()));
        let (_, _, for_b) = p.begin(Path::new("/p"), &b.id, 1, None, t0).unwrap();
        assert_eq!(p.guarded(&prompt.id, second, 1, || wrote.push("after B request")), Err("stale".into()));
        assert_eq!(p.guarded(&b.id, for_b, 1, || wrote.push("B")), Ok(()));
        // 닫힌 A의 결과 기록은 받는다
        assert!(p.finish(&prompt.id, second, 1, "sent").is_some());
        assert_eq!(p.guarded(&prompt.id, second, 1, || wrote.push("finished")), Err("stale".into()));
        assert_eq!(wrote, ["new", "B"]);
    }

    // Enter 뒤 다음 선택 창이 결과보다 먼저 알려져도 (앞 선택 창은 이미 닫힘) 답을 기록하고, 앞 것은 다시 열지 않는다
    #[test]
    fn records_answer_after_screen_moved_on() {
        let p = Prompts::default();
        let t0 = Instant::now();
        let Report::New { prompt, .. } = p.report(1, 1, "permission", member(), Some(dialog(&["Yes", "No"], 0)), t0) else { panic!() };
        let (_, _, request) = p.begin(Path::new("/p"), &prompt.id, 0, Some("phone"), t0).unwrap();
        assert!(matches!(p.report(1, 2, "question", member(), Some(dialog(&["A", "B"], 0)), t0), Report::New { .. }));
        assert!(p.finish(&prompt.id, request + 1, 0, "sent").is_none(), "다른 요청 번호는 버림");
        let (_, answer, via) = p.finish(&prompt.id, request, 0, "sent").expect("닫힌 것에서 찾음");
        assert_eq!((answer.label.as_str(), via.as_deref()), ("Yes", Some("phone")));
        assert!(p.finish(&prompt.id, request, 0, "sent").is_none(), "한 번만");
    }
}
