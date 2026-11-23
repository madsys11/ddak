import { useEffect, useRef, useState } from "react";
import type { MessageKey } from "./i18n";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

// 끝난 뒤 "초기화됨"을 보이는 시간
export const RESET_DONE_MS = 2000;

// 협업 제한 초기화 단추 (맥 채팅 패널 머리 src/ChatPanel.tsx, 폰 채팅 머리 src/mobile/MobileApp.tsx). 셈을 지우는 것은 각자
// (맥 chat_reset_limits, 폰 POST …/reset-limits). 멈춘 그룹이 없으면 화면에 바뀌는 것이 없어서 여러 번 누르게 되므로,
// 보내는 동안 끄고 성공하면 잠시 "초기화됨"으로 바꿔 보인다 (그동안도 끔). 실패하면 바로 되돌리고 그 화면의 오류 줄(setError)에
// errorText로 보인다. 다시 눌러 성공하면 그 오류를 지운다: 성공·실패 안내가 함께 남았다 (리뷰 R1). 그사이 다른 오류로
// 바뀌었으면 그것은 남긴다.
export function ResetLimitsButton({ className, t, onReset, setError, errorText }: {
  className: string;
  t: T;
  onReset: () => Promise<unknown>;
  setError: (f: (current: string | null) => string | null) => void;
  errorText: (e: unknown) => string;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // 이 단추가 마지막으로 보인 실패 문구
  const failure = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const click = async () => {
    setState("busy");
    try {
      await onReset();
      if (!alive.current) return;
      const shown = failure.current;
      failure.current = null;
      if (shown !== null) setError((current) => (current === shown ? null : current));
      setState("done");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), RESET_DONE_MS);
    } catch (e) {
      if (!alive.current) return;
      setState("idle");
      const text = errorText(e);
      failure.current = text;
      setError(() => text);
    }
  };
  return (
    <button className={`${className}${state === "done" ? " done" : ""}`} data-action="chat-reset-limits" data-state={state} disabled={state !== "idle"} title={t("chat.resetLimitsHint")} onClick={click}>
      {state === "done" ? t("chat.resetLimitsDone") : t("chat.resetLimits")}
    </button>
  );
}
