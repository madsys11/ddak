// 터미널 앞에서 도는 프로그램이 사용자를 기다리는지 (docs/spec.md "채팅방 설계" 깨우기).
// 깨우기의 Enter가 열린 선택 창(권한 확인, 폴더 신뢰 등)의 답을 고르지 않게, 기다리는 동안은 깨우기를 미룬다.
//
// - OSC 7501 (Program Status Protocol, orca src/shared/program-status/protocol.ts를 따름): 프로그램이 출력에
//   `ESC ] 7501 ; state=…:kind=…:msg=<base64> ST`로 자기 상태를 섞어 보낸다. claude는 터미널이 `ESC ] 7501 ; ?`에
//   답해야 보내고, codex는 묻지 않아도 보낸다 (claude 2.1.310·codex 0.164로 실험, 2026-10-25).
// - 화면: OSC 7501을 보내지 않는 선택 창이 있다 (claude의 폴더 신뢰 창). 화면 아래쪽에 선택 창 안내가 보이면 기다린다고 본다
//   (orca src/main/runtime/claude-open-dialog-hold.ts). 대화에 같은 글이 남아 깨우기가 계속 막히지 않게 DIALOG_CAP 뒤에는 풀린다.

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

// 사용자를 기다리는지: 프로그램이 blocked를 알렸거나 선택 창이 (DIALOG_CAP 안에서) 보인다
export function awaitingUser(status: ProgramStatus | undefined, dialogSince: number | undefined, now: number): boolean {
  return status?.state === "blocked" || (dialogSince !== undefined && now - dialogSince < DIALOG_CAP_MS);
}
