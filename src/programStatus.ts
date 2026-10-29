// 터미널 앞에서 도는 프로그램이 사용자를 기다리는지 (docs/spec.md "채팅방 설계" 깨우기).
// 깨우기의 Enter가 열린 선택 창(권한 확인, 폴더 신뢰 등)의 답을 고르지 않게, 기다리는 동안은 깨우기를 미룬다.
//
// - OSC 7501 (Program Status Protocol, orca src/shared/program-status/protocol.ts를 따름): 프로그램이 출력에
//   `ESC ] 7501 ; state=…:kind=…:msg=<base64> ST`로 자기 상태를 섞어 보낸다. claude는 터미널이 `ESC ] 7501 ; ?`에
//   답해야 보내고, codex는 묻지 않아도 보낸다 (claude 2.1.310·codex 0.164로 실험, 2026-10-25).
// - 화면: OSC 7501을 보내지 않는 선택 창이 있다 (claude의 폴더 신뢰 창). 화면 아래쪽에 선택 창 안내가 보이면 기다린다고 본다
//   (orca src/main/runtime/claude-open-dialog-hold.ts). 대화에 같은 글이 남아 깨우기가 계속 막히지 않게 DIALOG_CAP 뒤에는 풀린다.

import type { Terminal } from "@xterm/xterm";

export const PROGRAM_STATES = ["idle", "working", "done", "blocked", "error"] as const;
export const PROGRAM_KINDS = ["permission", "question", "auth"] as const;
export type ProgramState = (typeof PROGRAM_STATES)[number];
export type ProgramKind = (typeof PROGRAM_KINDS)[number];
export type ProgramStatus = { state: ProgramState; kind?: ProgramKind; msg?: string };

// 물음(`?`)에 대한 답: 받을 수 있는 상태와 종류
export const PROGRAM_STATUS_REPLY = `\x1b]7501;?:states=${PROGRAM_STATES.join(",")}:kinds=${PROGRAM_KINDS.join(",")}\x1b\\`;

const MAX_BODY = 4096;
const MAX_MSG = 2732;

function decodeMsg(encoded: string): string | undefined {
  if (encoded.length > MAX_MSG || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
  try {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /[\u0000-\u001f\u007f-\u009f]/.test(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

// OSC 7501의 본문 (`7501;` 뒤부터 끝맺음 앞까지). "query": 물음, "clear": 지움, null: 모르는 것·하위 기록(id)은 버린다.
export function parseProgramStatus(body: string): ProgramStatus | "query" | "clear" | null {
  if (body.length > MAX_BODY) return null;
  if (body.trim() === "?") return "query";
  const pairs = new Map<string, string>();
  for (const pair of body.split(":")) {
    const eq = pair.indexOf("=");
    if (eq > 0) pairs.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  // 하위 기록(subagent 등)은 보지 않는다. 앞에서 도는 프로그램 자신의 상태만
  if (pairs.has("id")) return null;
  const state = pairs.get("state");
  if (state === "clear") return "clear";
  if (!PROGRAM_STATES.includes(state as ProgramState)) return null;
  const status: ProgramStatus = { state: state as ProgramState };
  const kind = pairs.get("kind");
  if (status.state === "blocked" && PROGRAM_KINDS.includes(kind as ProgramKind)) status.kind = kind as ProgramKind;
  const msg = pairs.get("msg");
  const text = msg === undefined ? undefined : decodeMsg(msg);
  if (text) status.msg = text;
  return status;
}

// 화면 아래쪽에서 볼 줄 수 (선택 창은 화면 아래에 그려진다)
export const DIALOG_LINES = 14;
// 선택 창으로 보고 깨우기를 미루는 최대 시간 (Esc로 닫으면 아무 신호가 없고, 대화에 같은 글이 남을 수 있다)
export const DIALOG_CAP_MS = 10 * 60_000;
// claude: "Enter to confirm · Esc to cancel", "Esc to cancel · Tab to amend". codex: "Press enter to confirm or esc to cancel"
const DIALOG_FOOTER = /\b(enter|esc) to (select|confirm|cancel|continue|exit)\b/i;
// 커서가 놓인 번호 선택지 (claude ❯, codex ›) 바로 위나 아래에 다른 선택지가 있을 때
const CURSORED_OPTION = /^\s*[❯›]\s*\d+\.\s/;
const OPTION = /^\s+\d+\.\s/;

// 화면 줄(위에서 아래로)에 선택 창이 보이는지
export function dialogOnScreen(lines: readonly string[]): boolean {
  const region = lines.filter((l) => l.trim() !== "").slice(-DIALOG_LINES);
  return (
    region.some((l) => DIALOG_FOOTER.test(l)) ||
    region.some((l, i) => CURSORED_OPTION.test(l) && (OPTION.test(region[i - 1] ?? "") || OPTION.test(region[i + 1] ?? "")))
  );
}

// 화면의 선택 창을 읽는다 (채팅에서 답하기, src-tauri/src/prompts.rs): 질문 줄, 선택지 글, 커서가 놓인 선택지.
// 선택지: 1부터 이어지는 번호 줄 (커서 ❯·› 가 하나에 붙음). 긴 선택지가 다음 줄로 넘어가면 이어 붙인다.
// 질문: 첫 선택지 위로 가로줄(─)이나 빈 줄 셋을 만나기 전까지의 글 전부 (줄 수를 자르지 않는다: 같은 선택 창인지를 질문
// 전체로 본다. 리뷰 R2: 8줄로 자르니 위쪽 명령만 다른 두 선택 창이 같게 보였다).
// 화면 위로 넘어가면 above(화면 위의 줄, 일반 화면의 스크롤 기록)로 이어 올라간다. start: above의 맨 위가 터미널 내용의
// 처음이라 그 위에 잘린 것이 없다 (Terminal.tsx dialogNow: 대체 화면에서 지운 뒤로 위로 밀려난 줄이 없을 때만).
// complete: 그 경계를 찾았거나 처음까지 다 읽었다. 그래도 위가 남았으면 질문이 잘렸을 수 있어 채팅에서는 답하지 않는다
// (2026-10-28 codex 업데이트 안내: 두 줄 질문이 대체 화면 맨 윗줄부터 그려져 답하지 못했다).
// codex 선택 창(아래에 "Press … to confirm or … to cancel" 안내)은 첫 줄이 정해진 제목이다. 경계 없이 화면 맨 위에 닿았으면 그 사이의
// 가장 위 제목 줄부터를 질문으로 보고 complete. codex는 선택 창 머리를 위에서부터 그리고 넘치면 아래를 "[… N lines]"로 줄여서
// 진짜 제목은 늘 화면 안에 있고, 명령 본문에 같은 글이 있어도 그 아래다. 가장 위 것을 쓰므로 질문에서 명령이 빠지지 않는다
// (리뷰 R1: 처음 만나는 제목에서 멈추니 heredoc 안의 제목에서 멈춰 위의 명령이 빠졌다). 선택 창이 화면 맨 윗줄부터 차거나
// 위에 가로줄·빈 줄 없이 대화 기록이 붙은 경우다 (2026-10-28 폰에서 답하지 못한 codex 권한 확인).
// claude의 "Do you want to proceed?"는 명령 아래의 마지막 줄이라 제목이 아니다 (경계로 보면 위의 명령이 빠진다).
// 상자 테두리(│)와 안내 줄(Esc to cancel 등)은 뺀다. 읽지 못하면 null.
export type Dialog = { question: string[]; options: string[]; cursor: number; complete: boolean };
const EDGE = /^\s*[│┃]|[│┃]\s*$/g;
const RULE = /^[\s─━═╭╮╰╯┌┐└┘╌┄-]{3,}$/;
const NUMBERED = /^(\s*)([❯›]\s*)?(\d+)\.\s+(.*\S)\s*$/;
// codex-rs/tui/src/bottom_pane/approval_overlay.rs의 제목들
const DIALOG_TITLE =
  /^(Would you like to (run the following command\?|make the following edits\?|grant these permissions\?|send input to (the existing terminal\?|terminal \S+\?))|Do you want to approve network access to ".*"\?)$/;
// codex 안내 줄 (bottom_pane/popup_consts.rs accept_cancel_hint_line): "Press enter to confirm or esc to cancel".
// claude의 "Enter to confirm · Esc to cancel"과 구분한다 (재리뷰 R1: confirm·cancel 낱말만 보니 claude 창도 codex로 봤다)
const CODEX_FOOTER = /^Press \S.* to confirm or \S.* to cancel\b/;
export function readDialog(screen: readonly string[], above: readonly string[] = [], start = false): Dialog | null {
  const lines = [...above, ...screen].map((l) => l.replace(EDGE, "").replace(/\s+$/, ""));
  // 아래에서 위로 1번 선택지를 찾고 (화면 안에서), 거기서 아래로 번호가 이어지는 묶음을 읽는다
  for (let first = lines.length - 1; first >= above.length; first--) {
    const m = NUMBERED.exec(lines[first]);
    if (!m || m[3] !== "1") continue;
    const options: string[] = [];
    let cursor = -1;
    let indent = 0;
    for (let i = first; i < lines.length; i++) {
      const o = NUMBERED.exec(lines[i]);
      if (o && Number(o[3]) === options.length + 1) {
        if (o[2]) cursor = cursor === -1 ? options.length : -2;
        options.push(o[4]);
        indent = lines[i].indexOf(o[4]);
      } else if (options.length && lines[i].trim() && !DIALOG_FOOTER.test(lines[i]) && !RULE.test(lines[i]) && lines[i].search(/\S/) >= indent) {
        options[options.length - 1] += " " + lines[i].trim();
      } else break;
    }
    if (options.length < 2 || cursor < 0) continue;
    const question: string[] = [];
    let blank = 0;
    let bounded = false;
    for (let i = first - 1; i >= 0; i--) {
      if (RULE.test(lines[i])) {
        bounded = true;
        break;
      }
      if (!lines[i].trim()) {
        if (++blank >= 3) {
          bounded = true;
          break;
        }
        continue;
      }
      blank = 0;
      question.unshift(lines[i].trim());
    }
    const end = first + options.length;
    if (!bounded && lines.slice(end).some((l) => CODEX_FOOTER.test(l.trim()))) {
      const title = question.findIndex((l) => DIALOG_TITLE.test(l));
      if (title >= 0) return { question: question.slice(title), options, cursor, complete: true };
    }
    return { question, options, cursor, complete: bounded || start };
  }
  return null;
}

// 대체 화면(기록 없음)에서 화면 위가 사라졌는지 따라간다 (Terminal.tsx dialogNow: 사라진 적이 없을 때만 맨 윗줄을 질문의 처음으로
// 본다). 사라짐으로 보는 것: 줄바꿈으로 밀림(스크롤 영역 안 포함, onScroll), 위로 밀기(CSI S), 줄 지우기(CSI M), 화면 크기 바꾸기
// (줄 수를 줄이면 위가 잘리고 폭을 줄이면 오른쪽이 잘린다. 대체 화면은 다시 감지 않는다). 처음으로 되돌리는 것: 화면 전체 지우기
// (CSI 2 J, 맨 앞에서 CSI 0 J)와 화면 바꾸기. CSI 3 J는 화면을 지우지 않으므로 아니다 (재리뷰 R1). 모르는 길로 사라지면 막지 못하므로
// 사라짐 쪽으로 넉넉히 본다 (답하지 못할 뿐 잘못 답하지는 않는다).
export function watchAltLoss(term: Pick<Terminal, "buffer" | "parser" | "onScroll" | "onResize">) {
  let lost = false;
  const alt = () => term.buffer.active.type === "alternate";
  const lose = () => {
    if (alt()) lost = true;
    return false;
  };
  const subs = [
    term.onScroll(lose),
    term.onResize(lose),
    term.parser.registerCsiHandler({ final: "S" }, lose),
    term.parser.registerCsiHandler({ final: "M" }, lose),
    term.buffer.onBufferChange(() => (lost = false)),
    term.parser.registerCsiHandler({ final: "J" }, (params) => {
      const buf = term.buffer.active;
      const mode = params[0] ?? 0;
      if (mode === 2 || (mode === 0 && buf.cursorX === 0 && buf.cursorY === 0)) lost = false;
      return false;
    }),
  ];
  return { lost: () => alt() && lost, dispose: () => subs.forEach((d) => d.dispose()) };
}

export const sameDialog = (a: Dialog | null, b: Dialog | null) =>
  !!a && !!b && a.complete && b.complete && JSON.stringify([a.question, a.options]) === JSON.stringify([b.question, b.options]);

// 키 하나를 보낸다: 보내기 직전(앞의 전송이 끝난 뒤, 실제로 쓰는 차례)에 그때의 화면으로 ok를 보고 아니면 보내지 않는다
// (리뷰 R1: 확인한 뒤 쓰는 차례를 기다리는 사이에 선택 창이 바뀌어도 Enter가 나갔다). 쓰기 실패는 "error" (리뷰 R4)
export type SendKey = (data: string, ok: (now: Dialog | null) => boolean) => Promise<"sent" | "skipped" | "error">;

// 한 터미널의 답 처리: 한 번에 하나. 요청 번호는 Rust가 늘려 가며 매기므로, 이미 본 번호 이하(늦게 온 앞 요청, 끝난 요청의 재전달)는
// 지금 처리를 건드리지 않고 버린다. 더 새 요청이 오면 지금 것을 취소한다 (재리뷰 R3: 2→1 순서로 오면 앞 요청이 새 요청을 취소하고
// Enter를 보냈다). 키를 쓰는 Rust도 지금 요청인지 다시 본다 (prompts.rs prompt_write)
export class AnswerRuns {
  private last = 0;
  private run: { cancelled: boolean } | null = null;
  start(request: number) {
    if (request <= this.last) return null;
    this.last = request;
    if (this.run) this.run.cancelled = true;
    const run = { cancelled: false };
    this.run = run;
    return run;
  }
  end(run: { cancelled: boolean }) {
    if (this.run === run) this.run = null;
  }
  cancelAll() {
    if (this.run) this.run.cancelled = true;
  }
}

// 채팅에서 고른 답을 넣는다 (Terminal.tsx): 지금 화면이 알린 선택 창(expected)과 같은지 보고, 화살표를 하나씩 보내 커서가 옮겨진
// 것을 확인한 뒤에만 Enter. 키마다 보내기 직전에 선택 창·커서를 다시 본다. 화면이 바뀌거나 취소되면(cancelled: 같은 터미널에 새
// 답이 옴, 터미널을 닫음) "changed", 커서가 한 칸에 SETTLE_MS 안에 따라오지 않거나 쓰지 못하면 "failed" (모두 Enter 없음).
// appCursor: 응용 커서 키 모드 (xterm이 키를 보낼 때처럼 ESC O)
export const SETTLE_MS = 1500;
export async function driveAnswer(o: {
  option: number;
  expected: Dialog;
  read: () => Dialog | null;
  send: SendKey;
  appCursor: () => boolean;
  cancelled?: () => boolean;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}): Promise<"sent" | "changed" | "failed"> {
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => performance.now());
  const cancelled = o.cancelled ?? (() => false);
  const start = o.read();
  if (!start || !sameDialog(start, o.expected) || o.option < 0 || o.option >= start.options.length) return "changed";
  // 지금 화면이 그 선택 창이고 커서가 cursor에 있는지
  const at = (d: Dialog | null, cursor: number) => !cancelled() && sameDialog(d, start) && d!.cursor === cursor;
  const settle = async (cursor: number) => {
    const deadline = now() + SETTLE_MS;
    for (;;) {
      const d = o.read();
      if (cancelled() || !sameDialog(d, start)) return "changed";
      if (d!.cursor === cursor) return "ok";
      if (now() > deadline) return "failed";
      await sleep(50);
    }
  };
  const sent = (r: "sent" | "skipped" | "error") => (r === "sent" ? "ok" : r === "skipped" ? "changed" : "failed");
  let cursor = start.cursor;
  while (cursor !== o.option) {
    const down = o.option > cursor;
    const from = cursor;
    const r = sent(await o.send(`${o.appCursor() ? "\x1bO" : "\x1b["}${down ? "B" : "A"}`, (d) => at(d, from)));
    if (r !== "ok") return r;
    const next = cursor + (down ? 1 : -1);
    const moved = await settle(next);
    if (moved !== "ok") return moved;
    cursor = next;
  }
  const r = sent(await o.send("\r", (d) => at(d, o.option)));
  return r === "ok" ? "sent" : r;
}

// 사용자를 기다리는지: 프로그램이 blocked를 알렸거나 선택 창이 (DIALOG_CAP 안에서) 보인다
export function awaitingUser(status: ProgramStatus | undefined, dialogSince: number | undefined, now: number): boolean {
  return status?.state === "blocked" || (dialogSince !== undefined && now - dialogSince < DIALOG_CAP_MS);
}

// claude의 권한 모드 (docs/spec.md "권한 모드 바꾸기", src-tauri/src/modes.rs). 화면 맨 아래 모드 줄에서 읽는다 (claude 2.1.312:
// `⏵⏵ auto mode on (shift+tab to cycle)`, `⏸ manual mode on · ? for shortcuts`, `⏵⏵ accept edits on …`, `⏸ plan mode on …`).
// 자동 모드를 쓸 수 없는 claude의 기본 모드는 줄에 모드가 없어 읽지 못한다 (그 세션은 바꾸지 않는다).
export type PermissionMode = "auto" | "manual" | "acceptEdits" | "plan" | "bypass";
const MODE_LINE = /^\s*(?:⏵⏵|⏸)\s+(auto mode|manual mode|accept edits|plan mode|bypass permissions) on\b/;
const MODE_OF: Record<string, PermissionMode> = { "auto mode": "auto", "manual mode": "manual", "accept edits": "acceptEdits", "plan mode": "plan", "bypass permissions": "bypass" };
// 모드 줄을 찾는 곳: 빈 줄을 뺀 맨 아래 몇 줄 (대화 중의 같은 글은 보지 않는다)
const MODE_LINES = 2;
export function readMode(lines: readonly string[]): PermissionMode | null {
  for (const l of lines.filter((l) => l.trim() !== "").slice(-MODE_LINES)) {
    const m = MODE_LINE.exec(l);
    if (m) return MODE_OF[m[1]];
  }
  return null;
}

// Shift+Tab (claude가 모드를 다음으로 돌린다)
export const MODE_KEY = "\x1b[Z";
// claude 2.1.312에서 Shift+Tab이 도는 순서. bypass를 켤 수 있는 세션은 Rust가 받지 않는다 (modes.rs bypass_possible)
export const MODE_CYCLE: readonly PermissionMode[] = ["auto", "manual", "acceptEdits", "plan"];
// 고른 모드로 바꾼다 (Terminal.tsx): Shift+Tab을 하나씩 보내고, 모드 줄이 MODE_CYCLE의 바로 다음 모드로 바뀐 것을 확인하며 고른
// 모드까지 간다. 키마다 보내기 직전에 모드 줄을 다시 본다 (ok). 처음부터 그 모드면 보내지 않고 "sent".
// read가 null(모드 줄이 사라짐, 선택 창이 뜸)이거나 취소되면 바로 "changed" (리뷰 R2: 다시 보여도 이어 가지 않는다).
// 한 번에 SETTLE_MS 안에 바뀌지 않거나, 다음이 아닌 모드로 바뀌거나 (리뷰 R2), 순서에 없는 모드에서 시작하거나, 쓰지 못하면 "failed"
export async function driveMode(o: {
  target: PermissionMode;
  read: () => PermissionMode | null;
  send: (data: string, ok: (now: PermissionMode | null) => boolean) => Promise<"sent" | "skipped" | "error">;
  cancelled?: () => boolean;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}): Promise<"sent" | "changed" | "failed"> {
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => performance.now());
  const cancelled = o.cancelled ?? (() => false);
  const start = o.read();
  if (!start || cancelled()) return "changed";
  if (start === o.target) return "sent";
  if (!MODE_CYCLE.includes(start) || !MODE_CYCLE.includes(o.target)) return "failed";
  let mode: PermissionMode = start;
  while (mode !== o.target) {
    const from: PermissionMode = mode;
    const next = MODE_CYCLE[(MODE_CYCLE.indexOf(from) + 1) % MODE_CYCLE.length];
    const r = await o.send(MODE_KEY, (m) => !cancelled() && m === from);
    if (r !== "sent") return r === "skipped" ? "changed" : "failed";
    const deadline = now() + SETTLE_MS;
    for (;;) {
      const m = o.read();
      if (cancelled() || m === null) return "changed";
      if (m === next) break;
      if (m !== from || now() > deadline) return "failed";
      await sleep(50);
    }
    mode = next;
  }
  return "sent";
}
