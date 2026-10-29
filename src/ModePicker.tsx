import { useState } from "react";
import type { MessageKey } from "./i18n";
import { errorCode } from "./PromptChoices";

// 세션의 권한 모드 고르기 (docs/spec.md "권한 모드 바꾸기", src-tauri/src/modes.rs). 폰 채팅의 참여자 칩 옆 모드를 누르면 뜬다.
// 고르면 맥이 Shift+Tab으로 바꾸고 결과는 채팅의 기록(mode)으로 온다. 기록의 글(modeText)은 맥 채팅 패널도 쓴다.

// src-tauri/src/chat.rs ModeChange
export type ModeChange = { member: string; mode: string; result: "sent" | "changed" | "failed" };

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

// 고를 수 있는 모드 (modes.rs MODES. 승인하려고 바꾸는 수동을 맨 앞에)
export const PICKABLE = ["manual", "auto", "acceptEdits", "plan"] as const;

const LABEL: Record<string, MessageKey> = { auto: "mode.auto", manual: "mode.manual", acceptEdits: "mode.acceptEdits", plan: "mode.plan", bypass: "mode.bypass" };
export const modeLabel = (mode: string, t: T) => (LABEL[mode] ? t(LABEL[mode]) : mode);

// 기록의 글 (바꿈, 화면이 바뀌어 멈춤, 바꾸지 못함)
export function modeText(c: ModeChange, t: T) {
  const key: MessageKey = c.result === "sent" ? "mode.result.sent" : c.result === "changed" ? "mode.result.changed" : "mode.result.failed";
  return t(key, { member: c.member, mode: modeLabel(c.mode, t) });
}

// 맥이 돌려준 오류 코드 → 문구 (modes.rs begin)
const ERRORS: Record<string, MessageKey> = { none: "mode.err.none", ambiguous: "mode.err.ambiguous", awaiting: "mode.err.awaiting", bypass: "mode.err.bypass", busy: "mode.err.busy" };

// mode: 지금 모드. onPick이 끝나면 (맥이 받음) 닫는다. 받지 못하면 이유를 보이고 다시 고를 수 있다
export function ModePicker({ member, mode, t, onPick, onClose }: { member: string; mode: string; t: T; onPick: (mode: string) => Promise<unknown>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (m: string) => {
    setBusy(true);
    setError(null);
    try {
      await onPick(m);
      onClose();
    } catch (e) {
      const code = errorCode(e);
      setError(ERRORS[code] ? t(ERRORS[code]) : t("mode.error", { detail: code }));
      setBusy(false);
    }
  };
  return (
    <div className="mode-picker" data-mode-picker={member}>
      <div className="mode-title">{t("mode.title", { member })}</div>
      <div className="prompt-options">
        {PICKABLE.map((m) => (
          <button key={m} data-mode={m} className={`prompt-option${m === mode ? " chosen" : ""}`} disabled={busy || m === mode} onClick={() => pick(m)}>
            {modeLabel(m, t)}
            {m === mode && <span className="chip-note">{t("mode.current")}</span>}
          </button>
        ))}
      </div>
      <div className="prompt-state">{t("mode.hint")}</div>
      {busy && <div className="prompt-state">{t("mode.sending")}</div>}
      {error && <div className="prompt-error">{error}</div>}
      <button data-action="mode-cancel" onClick={onClose}>
        {t("common.cancel")}
      </button>
    </div>
  );
}
