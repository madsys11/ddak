import { useEffect, useRef } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { devHooks, liveTerms } from "./devHooks";
import { fixImeInput, passesImeKey } from "./hangul";
import { usePrefs } from "./prefs";
import { THEMES } from "./themes";

// xterm이 따로 보내지 않는 키 조합을 셸·CLI가 아는 입력으로 바꾼다.
// - ⌘⌫ → Ctrl+U (커서 앞 지우기, zsh는 줄 전체). VS Code 터미널과 같은 값.
// - ⇧↩ → 세션 구성의 shiftEnter (기본 설정의 claude·codex는 ESC CR). xterm 6은 Shift+Enter를 그냥 Enter로
//   보낸다 (kitty 키보드 프로토콜 없음). 모든 창에 ESC CR을 걸면 Vim 삽입 모드가 끝나서 (리뷰 지적 7) 세션별로 둔다.
//   없으면 xterm 기본 (Enter).
export function terminalKey(ev: KeyboardEvent, shiftEnter?: string | null): string | undefined {
  const only = (meta: boolean, shift: boolean) => ev.metaKey === meta && ev.shiftKey === shift && !ev.ctrlKey && !ev.altKey;
  if (ev.key === "Backspace" && only(true, false)) return "\x15";
  if (ev.key === "Enter" && only(false, true) && shiftEnter) return shiftEnter;
}

type Props = {
  cwd: string;
  // 작업그룹 세션의 명령과 인자. 없으면 그냥 셸. 처음 띄울 때만 쓴다.
  command?: string[];
  // command가 실패하면 대신 띄울 명령 (복원한 세션: 이어서 하기가 안 되면 처음처럼)
  fallback?: string[];
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
};

export function Terminal({ cwd, command, fallback, shiftEnter, shellAfter, chat, focused, onFocus, onTitle, onExit, onSpawnError }: Props) {
  const { theme, t } = usePrefs();
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm>(null);
  // 콜백·설정이 바뀔 때마다 터미널을 다시 만들지 않도록 최신 값을 ref로 본다.
  const latest = useRef({ onFocus, onTitle, onExit, onSpawnError, theme, t, command, fallback, shiftEnter, shellAfter, chat });
  latest.current = { onFocus, onTitle, onExit, onSpawnError, theme, t, command, fallback, shiftEnter, shellAfter, chat };

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

    const { command, fallback, shellAfter, chat } = latest.current;
    const args = { cwd, cols: term.cols, rows: term.rows, onData, command: command ?? null, fallback: fallback ?? null, shellAfter: shellAfter ?? null, chat: chat ?? null };
    invoke<number>("pty_spawn", args).then(
      async (newId) => {
        // 자체 테스트: 생성 응답이 늦게 오는 순서를 만든다 (그 사이 끝난 명령의 종료를 잃지 않는지)
        if (import.meta.env.DEV && devHooks.spawnDelay) await new Promise((r) => setTimeout(r, devHooks.spawnDelay));
        // StrictMode처럼 spawn이 끝나기 전에 언마운트된 경우
        if (disposed) {
          invoke("pty_kill", { id: newId });
          return;
        }
        id = newId;
      },
      (e) => {
        term.write(`\r\n[${latest.current.t("terminal.spawnFailed", { error: String(e) })}]\r\n`);
        if (!disposed) latest.current.onSpawnError?.();
      },
    );

    // 입력은 앞의 전송이 끝난 뒤에 보낸다. invoke는 호출마다 따로 가서 도착 순서가 보장되지 않는다
    // (tauri scripts/ipc-protocol.js). 한글 보정의 DEL+글자가 앞 글자보다 먼저 가면 엉뚱한 글자를 지운다.
    let sending: Promise<unknown> = Promise.resolve();
    const input = term.onData((data) => {
      if (id === undefined) return;
      const target = id;
      sending = sending.then(() => invoke("pty_write", { id: target, data })).catch(() => {});
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
