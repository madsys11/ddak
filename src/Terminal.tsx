import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { devHooks, liveTerms } from "./devHooks";
import { draggedPath, droppedFiles, isFileDrag, isPathDrag, noteFileDrag, shellQuote } from "./dragPath";
import { fixImeInput, passesImeKey } from "./hangul";
import { DIALOG_CAP_MS, PROGRAM_STATUS_REPLY, awaitingUser, dialogOnScreen, parseProgramStatus, readDialog, readMode, watchAltLoss, driveAnswer, driveMode, AnswerRuns, type Dialog, type PermissionMode, type ProgramStatus, type SendKey } from "./programStatus";
import { usePrefs } from "./prefs";
import { THEMES } from "./themes";
import { TerminalSearch } from "./TerminalSearch";
import { linkProvider, oscLinkHandler } from "./terminalLinks";
import { IS_WINDOWS, cmdKey, otherKey } from "./platform";
import { alignToPixels } from "./zoom";
import { MONO_FONT } from "./monoFont";

// xterm이 따로 보내지 않는 키 조합을 셸·CLI가 아는 입력으로 바꾼다.
// - ⌘⌫ → Ctrl+U (커서 앞 지우기, zsh는 줄 전체). VS Code 터미널과 같은 값.
// - ⇧↩ → 세션 구성의 shiftEnter (기본 설정의 claude·codex는 ESC CR). xterm 6은 Shift+Enter를 그냥 Enter로
//   보낸다 (kitty 키보드 프로토콜 없음). 모든 창에 ESC CR을 걸면 Vim 삽입 모드가 끝나서 (리뷰 지적 7) 세션별로 둔다.
//   세션 구성이 없으면 (그냥 셸에서 claude를 직접 띄움 등) 누를 때 앞에서 도는 프로그램을 보고 groups.json shiftEnterFor에서
//   찾는다 (Terminal 안의 sendShiftEnter). 거기도 없으면 Enter.
export function terminalKey(ev: KeyboardEvent, shiftEnter?: string | null): string | undefined {
  const only = (cmd: boolean, shift: boolean) => cmdKey(ev) === cmd && ev.shiftKey === shift && !otherKey(ev) && !ev.altKey;
  if (ev.key === "Backspace" && only(true, false)) return "\x15";
  if (isShiftEnter(ev) && shiftEnter) return shiftEnter;
}

// Windows의 터미널 복사·붙여넣기 (docs/windows-plan.md W3. 맥은 편집 메뉴의 ⌘C·⌘V): Ctrl+C는 선택이 있을 때만 복사하고
// 없으면 터미널로 (인터럽트). Ctrl+V는 xterm이 ^V를 보내지 않게 넘기고 웹뷰의 붙여넣기(paste 이벤트)를 xterm이 받는다.
export function clipboardKey(ev: KeyboardEvent, hasSelection: boolean, windows = IS_WINDOWS): "copy" | "paste" | undefined {
  if (!windows || ev.type !== "keydown" || !ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey) return;
  if (ev.code === "KeyC" && hasSelection) return "copy";
  if (ev.code === "KeyV") return "paste";
}

// 조합이 끝난 ⇧↩인지. 입력기 조합 중(isComposing, WebKit의 keyCode 229)의 Enter는 조합 확정이라 입력기 경로(passesImeKey,
// xterm CompositionHelper)에 맡긴다 (리뷰 R1: 한글 조합을 확정하는 ⇧↩이 명령을 실행했다).
export const isShiftEnter = (ev: KeyboardEvent) =>
  ev.key === "Enter" && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.isComposing && ev.keyCode !== 229;

export const MIN_CONTRAST = 4.5;

type Props = {
  cwd: string;
  // 작업그룹 세션의 명령과 인자. 없으면 그냥 셸. 처음 띄울 때만 쓴다.
  command?: string[];
  // command가 실패하면 대신 띄울 명령 (복원한 세션: 이어서 하기가 안 되면 처음처럼)
  fallback?: string[];
  // shiftEnter가 없을 때 ⇧↩: 앞에서 도는 프로그램 이름 → 보낼 입력 (groups.json shiftEnterFor)
  shiftEnterFor?: Record<string, string>;
  // 인자의 자리표시자 값 ({session}, {prompt}. {chat}은 Rust가 넣는다, workspaceState.ts commandOf)
  vars?: Record<string, string>;
  // Shift+Enter로 보낼 입력 (세션 구성). 없으면 그냥 Enter.
  shiftEnter?: string | null;
  // false면 명령이 끝나도 셸을 띄우지 않는다 (작업그룹 준비: onExit가 그 명령의 종료 코드를 받는다)
  shellAfter?: boolean;
  focused: boolean;
  onFocus: () => void;
  onTitle: (title: string) => void;
  // code: 종료 코드. 시그널로 끝났거나 알 수 없으면 null
  onExit: (code: number | null) => void;
  // PTY를 만들지 못함 (오류는 터미널에도 쓴다). 이때는 onExit이 오지 않는다.
  onSpawnError?: () => void;
  // PTY를 만들었다 (그 번호. 세션 다시 시작이 옛 터미널이 다 끝나기를 기다린다, Workspace.tsx)
  onPty?: (id: number) => void;
  // 채팅방에 참여할 세션: 프로젝트(원본 폴더), 참여자 이름, 창마다 고정인 키. 인자의 {chat}이 이 창의 MCP 주소로 바뀐다
  // (src-tauri/src/chat.rs)
  chat?: { project: string; name: string; key: string };
  // 채팅 깨우기를 기다리는지 바뀔 때 (src-tauri/src/pty.rs wake). wakeNow: 기다리지 않고 바로 깨운다
  onWake?: (pending: boolean, wakeNow: () => void) => void;
  // 앞에서 도는 프로그램의 상태(OSC 7501)와 사용자를 기다리는지(그 상태나 화면의 선택 창)가 바뀔 때 (src/programStatus.ts)
  onStatus?: (status: ProgramStatus | undefined, awaiting: boolean) => void;
  // 이 터미널이 낸 알림을 눌렀다: 이 창을 보이고 고른다 (src-tauri/src/notify.rs "notification-click")
  onReveal?: () => void;
};

// 선택 창의 질문을 화면 위 스크롤 기록에서 이어 읽을 때 최대 줄 수 (Terminal 안의 dialogNow)
const ABOVE_MAX = 500;

// xterm이 프로그램의 질의에 스스로 보내는 응답 (xterm 6.0 InputHandler·CoreBrowserTerminal의 triggerDataEvent 전부):
// 장치 속성 CSI ? … c / CSI > … c, 상태 CSI 0 n, 커서 위치 CSI 행;열 R / CSI ? 행;열 R, 창 정보 CSI 8|4|6;…;… t,
// 모드 질의 CSI ? … $ y, DCS 응답(ESC P … ESC \), OSC 색 응답, 포커스 CSI I / CSI O. 키보드가 만드는 CSI는 ~, A-D, H, F,
// P-S, Z로 끝나서 c·n·t·$y와 겹치지 않는다. R은 ⇧F3 등(CSI 1;수식 R)과 모양이 같지만 글자를 쓰는 키가 아니라 응답으로 봐도
// 초안 판단에는 상관없다 (리뷰 후속 P2: CSI 0 n, CSI ? 1;1 R을 놓쳤다).
export const isTerminalReply = (data: string) =>
  /^\x1b\[[?>]?[\d;]*[cnRt]$/.test(data) ||
  /^\x1b\[\??[\d;]*\$y$/.test(data) ||
  /^\x1b\[[IO]$/.test(data) ||
  /^\x1b\][\s\S]*(\x07|\x1b\\)$/.test(data) ||
  /^\x1bP[\s\S]*\x1b\\$/.test(data);

export function Terminal({ cwd, command, fallback, vars, shiftEnter, shiftEnterFor, shellAfter, chat, focused, onFocus, onTitle, onExit, onSpawnError, onPty, onWake, onStatus, onReveal }: Props) {
  const { theme, t } = usePrefs();
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm>(null);
  // 검색 (⌘F, src/TerminalSearch.tsx): 애드온은 터미널과 함께 만들고, 막대는 열 때만 그린다
  const searchRef = useRef<SearchAddon>(null);
  const [searching, setSearching] = useState(false);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  // 콜백·설정이 바뀔 때마다 터미널을 다시 만들지 않도록 최신 값을 ref로 본다.
  const latest = useRef({ onFocus, onTitle, onExit, onSpawnError, onPty, onWake, onStatus, onReveal, theme, t, command, fallback, vars, shiftEnter, shiftEnterFor, shellAfter, chat });
  latest.current = { onFocus, onTitle, onExit, onSpawnError, onPty, onWake, onStatus, onReveal, theme, t, command, fallback, vars, shiftEnter, shiftEnterFor, shellAfter, chat };

  useEffect(() => {
    const el = ref.current!;
    const term = new XTerm({
      allowProposedApi: true, // unicode11 애드온에 필요
      cursorBlink: true,
      fontFamily: MONO_FONT,
      fontSize: 13,
      macOptionIsMeta: true,
      // 글자색이 배경 대비 이보다 낮으면 그릴 때 진하게 한다 (VS Code 터미널 기본값). Solarized Light는 기본 글자가 4.1:1,
      // 강조색이 3:1 안팎이라 흐렸다. 테마 색표는 그대로 두고 그리는 색만 바뀐다.
      minimumContrastRatio: MIN_CONTRAST,
      theme: THEMES[latest.current.theme].terminal,
    });
    termRef.current = term;
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    const fit = new FitAddon();
    term.loadAddon(fit);
    // 한글 같은 전각 문자의 폭을 셸과 똑같이 계산하게 한다.
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(el);
    try {
      const webgl = new WebglAddon();
      // GPU 자원 부족 등으로 컨텍스트를 잃고 3초 안에 복구되지 않으면 xterm은 이 이벤트만 보내고
      // 화면은 멈춘 채로 둔다. 애드온을 해제하면 기본 DOM 렌더러로 돌아가 계속 그려진다.
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL이 안 되면 기본 DOM 렌더러를 쓴다.
    }
    fit.fit();
    if (import.meta.env.DEV) liveTerms.set(el, term);
    // 한글 입력기 글자 보정 (macOS WebKit은 composition 이벤트 없이 "바꾸기"로 조합한다. src/hangul.ts)
    const unfixIme = term.textarea ? fixImeInput(term, el, term.textarea) : () => {};
    term.attachCustomKeyEventHandler((ev) => {
      const clip = clipboardKey(ev, term.hasSelection());
      if (clip === "copy") {
        ev.preventDefault();
        void navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      if (clip === "paste") return false;
      const seq = ev.type === "keydown" ? terminalKey(ev, latest.current.shiftEnter) : undefined;
      if (seq) {
        ev.preventDefault(); // 입력란 자체의 줄 지우기 등 기본 동작은 막는다
        term.input(seq, true);
        return false;
      }
      // 세션 구성에 shiftEnter가 없는 ⇧↩: 앞에서 도는 프로그램을 보고 보낸다 (shiftEnterFor에 아무것도 없으면 xterm 기본 Enter)
      if (ev.type === "keydown" && isShiftEnter(ev) && Object.keys(latest.current.shiftEnterFor ?? {}).length) {
        ev.preventDefault();
        sendShiftEnter();
        return false;
      }
      return passesImeKey(ev);
    });

    let id: number | undefined;
    let disposed = false;
    // PTY가 생기면 풀린다 (그 전에 온 OSC 7501 물음의 답을 기다렸다 보낸다)
    let gotId: (id: number) => void = () => {};
    const idReady = new Promise<number>((resolve) => (gotId = resolve));
    // 화면의 URL·파일 경로를 ⌘+클릭으로 연다 (src/terminalLinks.ts)
    const linkContext = { id: () => id, cwd: () => cwd, hint: () => latest.current.t("terminal.linkHint") };
    const links = term.registerLinkProvider(linkProvider(term, linkContext));
    term.options.linkHandler = oscLinkHandler(term, linkContext);
    // 출력(바이트)과 마지막의 종료({exit})가 같은 채널로 순서대로 온다 (src-tauri/src/pty.rs pty_spawn).
    // 채널은 spawn 전에 만들어서, 생성 응답보다 먼저 끝나도 종료를 잃지 않는다.
    const onData = new Channel<ArrayBuffer | { exit: number | null }>();
    onData.onmessage = (msg) => {
      if (msg instanceof ArrayBuffer) term.write(new Uint8Array(msg));
      else if (!disposed) latest.current.onExit(msg.exit);
    };

    // 채팅 깨우기 상태 ({ pty, pending }). 생성 응답(id)보다 먼저 온 것은 모아 두었다가 id를 받으면 반영한다.
    // 변경 번호(seq)가 더 오래된 상태는 버린다 (이벤트 순서가 바뀔 수 있다. 리뷰 P2: 앞 깨우기의 해제가 새 대기를 지웠다).
    // 터미널은 등록이 끝난 뒤 띄운다 (리뷰 P2: 등록 전에 온 대기 상태를 놓쳤다).
    type Wake = { pty: number; pending: boolean; seq: number };
    const early = new Map<number, Wake>();
    let seen = 0;
    const wake = (w: Wake) => {
      if (w.seq <= seen) return;
      seen = w.seq;
      const target = id!;
      latest.current.onWake?.(w.pending, () => invoke("chat_wake_now", { id: target }));
    };
    // 이 터미널이 낸 알림을 눌렀다
    const clicks = listen<{ project: string; pty: number | null }>("notification-click", ({ payload }) => {
      if (!disposed && id !== undefined && payload.pty === id) latest.current.onReveal?.();
    });
    const wakes = (async () => {
      if (import.meta.env.DEV && devHooks.wakeListenDelay) await new Promise((r) => setTimeout(r, devHooks.wakeListenDelay));
      return listen<Wake>("chat-wake", ({ payload }) => {
        if (disposed) return;
        if (id === undefined) {
          if ((early.get(payload.pty)?.seq ?? 0) < payload.seq) early.set(payload.pty, payload);
        } else if (payload.pty === id) wake(payload);
      });
    })();

    const { command, fallback, vars, shellAfter, chat } = latest.current;
    const args = { cwd, cols: term.cols, rows: term.rows, onData, command: command ?? null, fallback: fallback ?? null, vars: vars ?? null, shellAfter: shellAfter ?? null, chat: chat ?? null };
    // 등록에 실패해도 터미널은 띄운다 (깨우기 배지만 못 본다)
    wakes.then(
      () => undefined,
      () => undefined,
    ).then(() => (disposed ? new Promise<number>(() => {}) : invoke<number>("pty_spawn", args))).then(
      async (newId) => {
        // 자체 테스트: 생성 응답이 늦게 오는 순서를 만든다 (그 사이 끝난 명령의 종료를 잃지 않는지)
        if (import.meta.env.DEV && devHooks.spawnDelay) await new Promise((r) => setTimeout(r, devHooks.spawnDelay));
        // StrictMode처럼 spawn이 끝나기 전에 언마운트된 경우
        if (disposed) {
          invoke("pty_kill", { id: newId });
          return;
        }
        id = newId;
        gotId(newId);
        latest.current.onPty?.(newId);
        if (import.meta.env.DEV) el.dataset.pty = String(newId);
        if (early.has(newId)) wake(early.get(newId)!);
        early.clear();
      },
      (e) => {
        term.write(`\r\n[${latest.current.t("terminal.spawnFailed", { error: String(e) })}]\r\n`);
        if (!disposed) latest.current.onSpawnError?.();
      },
    );

    // 입력은 앞의 전송이 끝난 뒤에 보낸다. invoke는 호출마다 따로 가서 도착 순서가 보장되지 않는다
    // (tauri scripts/ipc-protocol.js). 한글 보정의 DEL+글자가 앞 글자보다 먼저 가면 엉뚱한 글자를 지운다.
    let sending: Promise<unknown> = Promise.resolve();
    // 사용자 입력인지 (깨우기가 입력 중인지 본다, src-tauri/src/pty.rs Input): 키·붙여넣기·IME 이벤트 직후에 나온 데이터이고
    // 터미널이 스스로 보내는 응답 모양이 아닐 때. onData에는 xterm의 자동 응답(커서 위치, 포커스, 장치 속성 등)도 온다
    // (리뷰 P2). IME 조합 결과는 xterm이 조금 뒤(setTimeout)에 보내서 시간 창을 둔다.
    let userAt = -Infinity;
    const userEvent = () => (userAt = performance.now());
    const userEvents = ["keydown", "keypress", "beforeinput", "input", "paste", "compositionstart", "compositionupdate", "compositionend"];
    userEvents.forEach((e) => term.textarea?.addEventListener(e, userEvent, true));
    // 파일 트리나 Finder에서 끌어다 놓으면 셸에 쓸 수 있게 감싼 절대 경로를 붙여넣는다 (iTerm·터미널 앱과 같음. 여러 개면
    // 공백으로). 사용자 입력이다.
    const paste = (paths: string[]) => {
      if (!paths.length) return;
      userEvent();
      term.paste(`${paths.map(shellQuote).join(" ")} `);
      term.focus();
    };
    const onDragOver = (e: DragEvent) => {
      if (!isPathDrag(e.dataTransfer) && !isFileDrag(e.dataTransfer)) return;
      if (isFileDrag(e.dataTransfer)) noteFileDrag();
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      const dropped = draggedPath(e.dataTransfer);
      if (dropped) {
        e.preventDefault();
        paste([dropped.path]);
      } else if (isFileDrag(e.dataTransfer)) {
        e.preventDefault();
        droppedFiles(e.dataTransfer).then(paste);
      }
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    // 앞에서 도는 프로그램을 물어 보낼 입력을 고르고, 다른 입력과 같은 차례로 보낸다 (사용자 입력)
    const sendShiftEnter = () => {
      if (id === undefined) return;
      const target = id;
      userEvent();
      sending = sending
        .then(async () => {
          // 이름 후보(띄운 이름, 실행 파일 이름) 중 먼저 설정에 있는 것
          const names = await invoke<string[]>("pty_foreground", { id: target }).catch(() => [] as string[]);
          const data = names.map((n) => latest.current.shiftEnterFor?.[n]).find(Boolean) || "\r";
          await invoke("pty_write", { id: target, data, user: true });
        })
        .catch(() => {});
    };
    // 앞에서 도는 프로그램이 사용자를 기다리는지 (src/programStatus.ts). 기다리는 동안 Rust는 깨우기를 미룬다 (pty_awaiting).
    let status: ProgramStatus | undefined;
    let dialogSince: number | undefined;
    let dialogCap: ReturnType<typeof setTimeout> | undefined;
    let awaiting = false;
    // 마지막으로 보낸 기다림의 종류
    let awaitingKind = "";
    // 작업 중인지 (Rust가 하나라도 있으면 잠자기를 막는다, pty_working). 사용자를 기다리는 동안(선택 창 포함)은 작업 중이 아니다
    let working = false;
    // 상태는 보낸 순서대로 도착해야 한다 (invoke는 호출마다 따로 가서 순서가 보장되지 않는다. 늦게 온 오래된 값이 남으면 잠자기
    // 막기가 반대로 굳는다, 리뷰 R3). 한 줄로 세우고, PTY가 생기기 전에 바뀐 것은 생길 때까지 기다렸다 보낸다
    let statusSends: Promise<unknown> = Promise.resolve();
    const sendStatus = (cmd: "pty_awaiting" | "pty_working" | "pty_dialog" | "pty_mode", args: Record<string, unknown>) => {
      statusSends = statusSends
        .then(() => idReady)
        .then(async (target) => {
          if (import.meta.env.DEV && devHooks.statusDelay) await new Promise((r) => setTimeout(r, devHooks.statusDelay!(cmd, args)));
          await invoke(cmd, { id: target, ...args });
        })
        .catch(() => {});
    };
    let shown: { status?: ProgramStatus; awaiting: boolean } = { awaiting: false };
    // 무엇을 기다리는지 (Rust가 알림 문구를 고른다): OSC 7501 blocked의 종류, 종류가 없으면 blocked, 화면의 선택 창이면 dialog
    const awaitKind = () => (status?.state === "blocked" ? (status.kind ?? "blocked") : "dialog");
    const report = () => {
      const next = awaitingUser(status, dialogSince, Date.now());
      const kind = awaitKind();
      // 기다리는 동안 종류만 바뀌어도 보낸다 (폰의 참여자 상태, 리뷰 R4). Rust는 이어지는 기다림을 다시 알리지 않는다
      if (next !== awaiting || (next && kind !== awaitingKind)) {
        awaiting = next;
        awaitingKind = kind;
        sendStatus("pty_awaiting", { awaiting: next, kind });
      }
      const nowWorking = status?.state === "working" && !next;
      if (nowWorking !== working) {
        working = nowWorking;
        sendStatus("pty_working", { working });
      }
      if (shown.status !== status || shown.awaiting !== next) {
        shown = { status, awaiting: next };
        latest.current.onStatus?.(status, next);
      }
    };
    // OSC 7501: 물음에는 다른 입력과 같은 차례로 답하고 (사용자 입력 아님. claude는 물음 바로 뒤에 장치 속성을 물어서, 그 답보다
    // 먼저 가야 한다), 보고는 상태로. 화면에는 아무것도 그리지 않는다.
    const programStatus = term.parser.registerOscHandler(7501, (body) => {
      const parsed = parseProgramStatus(body);
      if (parsed === "query") {
        sending = sending.then(() => idReady).then((target) => invoke("pty_write", { id: target, data: PROGRAM_STATUS_REPLY, user: false })).catch(() => {});
      } else if (parsed) {
        status = parsed === "clear" ? undefined : parsed;
        report();
      }
      return true;
    });
    // 보이는 화면의 줄 (위에서 아래로)
    const screenLines = () => {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let y = buf.baseY; y < buf.baseY + term.rows; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? "");
      return lines;
    };
    // 화면의 선택 창 (src/programStatus.ts readDialog). 질문이 화면 위로 넘어가면 일반 화면은 스크롤 기록에서 ABOVE_MAX줄까지
    // 이어 읽는다 (경계를 찾아야 답할 수 있다. 기록의 처음은 처음으로 보지 않는다: 기록이 한도로 버려졌는지 지금 길이로는 알 수
    // 없다, 리뷰 R2 — 창을 넓히면 줄이 다시 감겨 짧아진다).
    // 대체 화면은 기록이 없어서, 지운 뒤로 화면 위가 사라진 적이 없을 때만 맨 윗줄을 처음으로 본다 (리뷰 R1: 화면보다 긴
    // 출력은 대체 화면에서도 위가 사라진다. programStatus.ts watchAltLoss)
    const altLoss = watchAltLoss(term);
    const dialogNow = (lines = screenLines()) => {
      const buf = term.buffer.active;
      if (buf.type === "alternate") return readDialog(lines, [], !altLoss.lost());
      const above: string[] = [];
      for (let y = Math.max(0, buf.baseY - ABOVE_MAX); y < buf.baseY; y++) above.push(buf.getLine(y)?.translateToString(true) ?? "");
      return readDialog(lines, above);
    };
    // 기다리는 동안 화면의 선택 창 (채팅에서 답하기, src-tauri/src/prompts.rs). 바뀔 때마다 차례(seq)를 붙여 알린다
    let dialogSeq = 0;
    let sentDialog: Dialog | null = null;
    let sentKind = "";
    const reportDialog = (lines: string[]) => {
      const d = awaiting ? dialogNow(lines) : null;
      const kind = awaitKind();
      if (JSON.stringify(d) === JSON.stringify(sentDialog) && (!d || kind === sentKind)) return;
      sentDialog = d;
      sentKind = kind;
      sendStatus("pty_dialog", { seq: ++dialogSeq, kind, dialog: d });
    };
    // 채팅에서 고른 답을 넣는다 (src/programStatus.ts driveAnswer). 알린 뒤 화면이 바뀌었으면 넣지 않는다 (차례·내용으로 본다).
    // 이 터미널에서는 한 번에 하나, 더 새 요청만 받는다 (AnswerRuns). 키는 prompt_write로 써서 Rust가 지금 요청인지 다시 본다.
    // 결과는 그 요청 번호와 함께 알리고, Rust가 지금 요청의 결과만 채팅에 기록한다
    const runs = new AnswerRuns();
    const answerPrompt = async ({ seq, prompt, option, request }: { seq: number; prompt: string; option: number; request: number }) => {
      const run = runs.start(request);
      if (!run) return;
      const result = (r: "sent" | "changed" | "failed") => invoke("prompt_result", { prompt, request, option, result: r }).catch(() => {});
      try {
        if (id === undefined || seq !== dialogSeq || !sentDialog) return result("changed");
        const target = id;
        // 쓰는 차례가 오면 그때의 화면으로 확인하고 쓴다. 다른 입력의 줄은 실패해도 이어 간다
        const send: SendKey = (data, ok) => {
          const p = sending.then(async () => {
            if (run.cancelled || disposed || !ok(dialogNow())) return "skipped" as const;
            try {
              await invoke("prompt_write", { id: target, prompt, request, data });
              return "sent" as const;
            } catch (e) {
              return String(e) === "stale" ? ("skipped" as const) : ("error" as const);
            }
          });
          sending = p.catch(() => {});
          return p;
        };
        const cancelled = () => run.cancelled || disposed;
        return result(await driveAnswer({ option, expected: sentDialog, read: () => dialogNow(), send, appCursor: () => term.modes.applicationCursorKeysMode, cancelled }));
      } finally {
        runs.end(run);
      }
    };
    const answers = listen<{ pty: number; seq: number; prompt: string; option: number; request: number }>("prompt-answer", ({ payload }) => {
      if (!disposed && id !== undefined && payload.pty === id) answerPrompt(payload);
    });
    // claude의 권한 모드 (화면 맨 아래 모드 줄, src/programStatus.ts readMode). 바뀌면 알린다 (폰의 참여자 칩, src-tauri/src/modes.rs).
    // 선택 창이 떠 있는 동안은 모드 줄이 가려지므로 지난 모드를 그대로 둔다
    let sentMode: PermissionMode | null = null;
    const reportMode = (lines: string[]) => {
      const mode = readMode(lines);
      if (mode === sentMode || (mode === null && awaiting)) return;
      sentMode = mode;
      sendStatus("pty_mode", { mode });
    };
    // 채팅(폰)에서 고른 모드로 바꾼다 (src/programStatus.ts driveMode). 한 번에 하나, 더 새 요청만 받는다. 키는 mode_write로 써서
    // Rust가 지금 요청인지 다시 본다. 쓰는 차례가 오면 그때 화면에 선택 창이 없고 모드 줄이 그대로인지 보고 쓴다
    const modeRuns = new AnswerRuns();
    const setMode = async ({ mode, request }: { mode: PermissionMode; request: number }) => {
      const run = modeRuns.start(request);
      if (!run) return;
      const target = id!;
      const result = (r: "sent" | "changed" | "failed") => invoke("mode_result", { id: target, request, result: r }).catch(() => {});
      try {
        const send = (data: string, ok: (now: PermissionMode | null) => boolean) => {
          const p = sending.then(async () => {
            const lines = screenLines();
            if (run.cancelled || disposed || awaiting || dialogOnScreen(lines) || !ok(readMode(lines))) return "skipped" as const;
            try {
              await invoke("mode_write", { id: target, request, data });
              return "sent" as const;
            } catch (e) {
              return String(e) === "stale" ? ("skipped" as const) : ("error" as const);
            }
          });
          sending = p.catch(() => {});
          return p;
        };
        const cancelled = () => run.cancelled || disposed;
        // 선택 창이 뜨거나 사용자를 기다리게 되면 모드 줄이 사라진 것과 같다 (리뷰 R2: 멈춘다)
        const read = () => {
          const lines = screenLines();
          return awaiting || dialogOnScreen(lines) ? null : readMode(lines);
        };
        return result(await driveMode({ target: mode, read, send, cancelled }));
      } finally {
        modeRuns.end(run);
      }
    };
    const modeSets = listen<{ pty: number; mode: PermissionMode; request: number }>("mode-set", ({ payload }) => {
      if (!disposed && id !== undefined && payload.pty === id) setMode(payload);
    });
    // 화면 아래쪽의 선택 창 (출력을 그린 뒤 잠시 모아서 본다)
    let dialogCheck: ReturnType<typeof setTimeout> | undefined;
    const checkDialog = () => {
      dialogCheck = undefined;
      const lines = screenLines();
      if (!dialogOnScreen(lines)) {
        dialogSince = undefined;
        clearTimeout(dialogCap);
      } else if (dialogSince === undefined) {
        dialogSince = Date.now();
        dialogCap = setTimeout(report, DIALOG_CAP_MS);
      }
      report();
      reportDialog(lines);
      reportMode(lines);
    };
    const parsed = term.onWriteParsed(() => {
      if (dialogCheck === undefined) dialogCheck = setTimeout(checkDialog, 100);
    });
    const input = term.onData((data) => {
      if (id === undefined) return;
      const target = id;
      const user = performance.now() - userAt < 300 && !isTerminalReply(data);
      sending = sending.then(() => invoke("pty_write", { id: target, data, user })).catch(() => {});
    });
    const resize = term.onResize(({ cols, rows }) => {
      if (id !== undefined) invoke("pty_resize", { id, cols, rows });
    });
    const title = term.onTitleChange((text) => latest.current.onTitle(text));
    const focus = () => latest.current.onFocus();
    term.textarea?.addEventListener("focus", focus);
    // 숨은 탭에서는 크기가 0이라 fit이 아무것도 하지 않고, 다시 보일 때 맞춰진다.
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(el);
    const unalign = alignToPixels(term.element!.querySelector<HTMLElement>(".xterm-screen")!);

    return () => {
      disposed = true;
      wakes.then((f) => f(), () => {});
      clicks.then((f) => f(), () => {});
      answers.then((f) => f(), () => {});
      modeSets.then((f) => f(), () => {});
      userEvents.forEach((e) => term.textarea?.removeEventListener(e, userEvent, true));
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      observer.disconnect();
      unalign();
      input.dispose();
      programStatus.dispose();
      links.dispose();
      parsed.dispose();
      altLoss.dispose();
      clearTimeout(dialogCheck);
      clearTimeout(dialogCap);
      unfixIme();
      resize.dispose();
      title.dispose();
      term.textarea?.removeEventListener("focus", focus);
      if (id !== undefined) invoke("pty_kill", { id });
      liveTerms.delete(el);
      termRef.current = null;
      term.dispose();
    };
  }, [cwd]);

  // 고른 창이 되면 터미널로 포커스. 이 창의 검색 입력란을 눌러 고른 것이면 입력란에 둔다
  useEffect(() => {
    const inSearch = !!document.activeElement?.closest(".terminal-search") && ref.current?.parentElement?.contains(document.activeElement);
    if (focused && !inSearch) termRef.current?.focus();
  }, [focused]);

  // 터미널 메뉴 "찾기" (⌘F): 포커스가 있는 터미널이 검색 막대를 연다 (열려 있으면 입력란으로)
  useEffect(() => {
    const unlisten = listen<string>("menu", ({ payload }) => {
      if (payload !== "find" || !focusedRef.current) return;
      setSearching(true);
      ref.current?.parentElement?.querySelector<HTMLInputElement>(".terminal-search input")?.select();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[theme].terminal;
  }, [theme]);

  return (
    <>
      <div ref={ref} className="terminal" />
      {searching && termRef.current && searchRef.current && (
        <TerminalSearch term={termRef.current} search={searchRef.current} onClose={() => setSearching(false)} onFocus={() => latest.current.onFocus()} />
      )}
    </>
  );
}
