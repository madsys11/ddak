import { useEffect, useRef } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { liveTerms } from "./devHooks";
import { usePrefs } from "./prefs";
import { THEMES } from "./themes";

type Props = {
  cwd: string;
  focused: boolean;
  onFocus: () => void;
  onTitle: (title: string) => void;
  onExit: () => void;
};

export function Terminal({ cwd, focused, onFocus, onTitle, onExit }: Props) {
  const { theme, t } = usePrefs();
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm>(null);
  // 콜백·설정이 바뀔 때마다 터미널을 다시 만들지 않도록 최신 값을 ref로 본다.
  const latest = useRef({ onFocus, onTitle, onExit, theme, t });
  latest.current = { onFocus, onTitle, onExit, theme, t };

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

    let id: number | undefined;
    let disposed = false;
    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = (buf) => term.write(new Uint8Array(buf));

    invoke<number>("pty_spawn", { cwd, cols: term.cols, rows: term.rows, onData }).then(
      (newId) => {
        // StrictMode처럼 spawn이 끝나기 전에 언마운트된 경우
        if (disposed) {
          invoke("pty_kill", { id: newId });
          return;
        }
        id = newId;
      },
      (e) => term.write(`\r\n[${latest.current.t("terminal.spawnFailed", { error: String(e) })}]\r\n`),
    );

    const unlistenExit = listen<{ id: number }>("pty-exit", (e) => {
      if (e.payload.id === id) latest.current.onExit();
    });
    const input = term.onData((data) => {
      if (id !== undefined) invoke("pty_write", { id, data });
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
      resize.dispose();
      title.dispose();
      term.textarea?.removeEventListener("focus", focus);
      unlistenExit.then((f) => f());
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
