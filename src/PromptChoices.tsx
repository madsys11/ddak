import { useEffect, useState } from "react";
import type { MessageKey } from "./i18n";

// 세션이 띄운 선택 창을 채팅에서 고른다 (src-tauri/src/prompts.rs). 맥 채팅 패널과 폰 화면이 같이 쓴다 (모양은 각자의 CSS).
// 열려 있는 동안만 누를 수 있고, 승인일 수 있는 선택지(confirm)는 한 번 더 묻는다. 누르면 onAnswer가 맥에 보내고, 넣은 결과는
// 채팅의 답 기록(answer)으로 온다.

// src-tauri/src/chat.rs Prompt·Answer
export type PromptOption = { label: string; confirm: boolean };
// answerable: 채팅에서 답할 수 있음 (질문이 화면 밖으로 잘렸을 수 있으면 아님. 예전 ddak에는 없다)
export type Prompt = { id: string; kind: string; question: string[]; options: PromptOption[]; answerable?: boolean };
export type Answer = { prompt: string; member: string; option: number; label: string; result: "sent" | "changed" | "failed" };

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

// 맥이 돌려준 오류 코드 → 문구
const ERRORS: Record<string, MessageKey> = { closed: "prompt.err.closed", busy: "prompt.err.busy", option: "prompt.err.closed", incomplete: "prompt.incomplete" };

export function errorCode(e: unknown) {
  return e instanceof Error ? ((e as Error & { code?: string }).code ?? e.message) : String(e);
}

// 선택 창마다 마지막 답 기록 (메시지 번호와 함께, 채팅 패널·폰이 메시지 목록에서 모은다)
export type LastAnswer = { id: number; answer: Answer };
export function lastAnswers(messages: { id: number; answer?: Answer }[]) {
  const last = new Map<string, LastAnswer>();
  for (const m of messages) if (m.answer) last.set(m.answer.prompt, { id: m.id, answer: m.answer });
  return last;
}

// open: 맥에 아직 열려 있음. last: 이 선택 창의 마지막 답 기록 (보냈으면 닫힘. 바뀜·실패면 다시 고를 수 있다, 리뷰 R5)
export function PromptChoices({ prompt, open, last, t, onAnswer }: { prompt: Prompt; open: boolean; last?: LastAnswer; t: T; onAnswer: (option: number) => Promise<unknown> }) {
  const [asking, setAsking] = useState<number | null>(null);
  // 맥이 받아 넣는 중 (결과 기록이 오거나 닫히면 끝)
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sent = last?.answer.result === "sent" ? last.answer : undefined;
  // 새 결과가 오면 보내는 중을 끝낸다. 보내지 못했으면 그 이유를 보이고 다시 고를 수 있다
  useEffect(() => {
    if (!last) return;
    setBusy(null);
    if (last.answer.result !== "sent") setError(answerText(last.answer, t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id]);
  // 결과가 오지 않으면 (맥이 10초 뒤 다시 받는다) 다시 누를 수 있게
  useEffect(() => {
    if (busy === null) return;
    const timer = setTimeout(() => setBusy(null), 12_000);
    return () => clearTimeout(timer);
  }, [busy]);
  // 질문이 화면 밖으로 잘렸을 수 있으면 맥에서 답한다 (예전 ddak의 메시지는 answerable이 없다: 답할 수 있던 것)
  const answerable = prompt.answerable !== false;
  const live = open && !sent && answerable;
  const pick = async (i: number) => {
    setAsking(null);
    setBusy(i);
    setError(null);
    try {
      await onAnswer(i);
    } catch (e) {
      const code = errorCode(e);
      setError(ERRORS[code] ? t(ERRORS[code]) : t("prompt.error", { detail: code }));
      setBusy(null);
    }
  };
  return (
    <div className="prompt" data-prompt={prompt.id}>
      {prompt.question.length > 0 && <div className="prompt-question">{prompt.question.join("\n")}</div>}
      <div className="prompt-options">
        {prompt.options.map((o, i) => (
          <button
            key={i}
            data-option={i}
            className={`prompt-option${sent?.option === i ? " chosen" : ""}${asking === i ? " asking" : ""}`}
            disabled={!live || busy !== null}
            onClick={() => (o.confirm ? setAsking(i) : pick(i))}
          >
            {i + 1}. {o.label}
          </button>
        ))}
      </div>
      {asking !== null && live && busy === null && (
        <div className="prompt-confirm" data-confirm={asking}>
          <span>{t("prompt.confirm", { label: prompt.options[asking].label })}</span>
          <button className="primary" data-action="prompt-send" onClick={() => pick(asking)}>
            {t("prompt.send")}
          </button>
          <button data-action="prompt-cancel" onClick={() => setAsking(null)}>
            {t("common.cancel")}
          </button>
        </div>
      )}
      {busy !== null && open && !sent && <div className="prompt-state">{t("prompt.sending")}</div>}
      {!open && !sent && <div className="prompt-state">{t("prompt.closed")}</div>}
      {open && !answerable && <div className="prompt-state">{t("prompt.incomplete")}</div>}
      {error && <div className="prompt-error">{error}</div>}
    </div>
  );
}

// 답 기록의 글 (보냄, 화면이 바뀌어 안 보냄, 옮기지 못해 안 보냄)
export function answerText(a: Answer, t: T) {
  const key: MessageKey = a.result === "sent" ? "prompt.answer.sent" : a.result === "changed" ? "prompt.answer.changed" : "prompt.answer.failed";
  return t(key, { member: a.member, label: a.label });
}
