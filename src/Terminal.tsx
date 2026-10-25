import { useEffect, useRef } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { devHooks, liveTerms } from "./devHooks";
import { draggedPath, isPathDrag, shellQuote } from "./dragPath";
import { fixImeInput, passesImeKey } from "./hangul";
import { usePrefs } from "./prefs";
import { THEMES } from "./themes";

// xterm이 따로 보내지 않는 키 조합을 셸·CLI가 아는 입력으로 바꾼다.
// - ⌘⌫ → Ctrl+U (커서 앞 지우기, zsh는 줄 전체). VS Code 터미널과 같은 값.
// - ⇧↩ → 세션 구성의 shiftEnter (기본 설정의 claude·codex는 ESC CR). xterm 6은 Shift+Enter를 그냥 Enter로
//   보낸다 (kitty 키보드 프로토콜 없음). 모든 창에 ESC CR을 걸면 Vim 삽입 모드가 끝나서 (리뷰 지적 7) 세션별로 둔다.
//   세션 구성이 없으면 (그냥 셸에서 claude를 직접 띄움 등) 누를 때 앞에서 도는 프로그램을 보고 groups.json shiftEnterFor에서
//   찾는다 (Terminal 안의 sendShiftEnter). 거기도 없으면 Enter.
export function terminalKey(ev: KeyboardEvent, shiftEnter?: string | null): string | undefined {
  const only = (meta: boolean, shift: boolean) => ev.metaKey === meta && ev.shiftKey === shift && !ev.ctrlKey && !ev.altKey;
  if (ev.key === "Backspace" && only(true, false)) return "\x15";
  if (isShiftEnter(ev) && shiftEnter) return shiftEnter;
}

// 조합이 끝난 ⇧↩인지. 입력기 조합 중(isComposing, WebKit의 keyCode 229)의 Enter는 조합 확정이라 입력기 경로(passesImeKey,
// xterm CompositionHelper)에 맡긴다 (리뷰 R1: 한글 조합을 확정하는 ⇧↩이 명령을 실행했다).
export const isShiftEnter = (ev: KeyboardEvent) =>
  ev.key === "Enter" && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.isComposing && ev.keyCode !== 229;

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
  // 채팅방에 참여할 세션: 프로젝트(원본 폴더), 참여자 이름, 창마다 고정인 키. 인자의 {chat}이 이 창의 MCP 주소로 바뀐다
  // (src-tauri/src/chat.rs)
  chat?: { project: string; name: string; key: string };
  // 채팅 깨우기를 기다리는지 바뀔 때 (src-tauri/src/pty.rs wake). wakeNow: 기다리지 않고 바로 깨운다
  onWake?: (pending: boolean, wakeNow: () => void) => void;
};

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

export function Terminal({ cwd, command, fallback, vars, shiftEnter, shiftEnterFor, shellAfter, chat, focused, onFocus, onTitle, onExit, onSpawnError, onWake }: Props) {
  const { theme, t } = usePrefs();
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm>(null);
  // 콜백·설정이 바뀔 때마다 터미널을 다시 만들지 않도록 최신 값을 ref로 본다.
  const latest = useRef({ onFocus, onTitle, onExit, onSpawnError, onWake, theme, t, command, fallback, vars, shiftEnter, shiftEnterFor, shellAfter, chat });
  latest.current = { onFocus, onTitle, onExit, onSpawnError, onWake, theme, t, command, fallback, vars, shiftEnter, shiftEnterFor, shellAfter, chat };

  useEffect(() => {
    const el = ref.current!;
    const term = new XTerm({
      allowProposedApi: true, // unicode11 애드온에 필요
      cursorBlink: true,
      fontFamily: "Menlo, monospace",
      fontSize: 13,
      macOptionIsMeta: true,
      theme: THEMES[latest.current.theme].terminal,
    });
    termRef.current = term;
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
    // 파일 트리에서 끌어다 놓으면 셸에 쓸 수 있게 감싼 절대 경로를 붙여넣는다 (iTerm·터미널 앱과 같음). 사용자 입력이다.
    const onDragOver = (e: DragEvent) => {
      if (!isPathDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      const dropped = draggedPath(e.dataTransfer);
      if (!dropped) return;
      e.preventDefault();
      userEvent();
      term.paste(`${shellQuote(dropped.path)} `);
      term.focus();
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

    return () => {
      disposed = true;
      wakes.then((f) => f(), () => {});
      userEvents.forEach((e) => term.textarea?.removeEventListener(e, userEvent, true));
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      observer.disconnect();
      input.dispose();
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

  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[theme].terminal;
  }, [theme]);

  return <div ref={ref} className="terminal" />;
}
