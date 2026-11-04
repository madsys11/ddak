// 사이드바 프로젝트 줄의 상태 (docs/spec.md "사이드바 · 파일 트리"). 프로젝트 하나의 세션 창들(작업그룹 탭 포함)의 프로그램
// 상태와 자동 깨우기가 멈춘 작업그룹을 모아, 가장 급한 것 하나를 점·칩으로 보인다 (docs/reviews/2026-11-04-project-status.md).

import type { MessageKey } from "./i18n";
import type { ProgramStatus } from "./programStatus";

// 상태별 세션(창) 수. 멈춤(paused)은 작업그룹 수
export type ProjectStatus = { awaiting: number; paused: number; error: number; working: number; done: number };
export type ProjectState = keyof ProjectStatus;

// 급한 순서: 사용자를 기다림 > 자동 깨우기 멈춤 > 오류 > 작업 중 > 완료
export const PROJECT_STATES: readonly ProjectState[] = ["awaiting", "paused", "error", "working", "done"];

export const EMPTY_PROJECT_STATUS: ProjectStatus = { awaiting: 0, paused: 0, error: 0, working: 0, done: 0 };

// 창들의 상태를 센다. 기다리는 창은 상태와 관계없이 기다림으로만 센다. idle·상태 없음은 세지 않는다
// (Windows의 화면·훅은 작업 중과 상태 없음만 준다. 작업 중이 사라졌다고 완료·오류로 짐작하지 않는다)
export function countStatuses(panes: readonly { status?: ProgramStatus; awaiting: boolean }[], paused = 0): ProjectStatus {
  const c = { ...EMPTY_PROJECT_STATUS, paused };
  for (const p of panes) {
    if (p.awaiting) c.awaiting++;
    else if (p.status?.state === "error") c.error++;
    else if (p.status?.state === "working") c.working++;
    else if (p.status?.state === "done") c.done++;
  }
  return c;
}

// 가장 급한 상태 (없으면 null)
export function topState(s: ProjectStatus | undefined): ProjectState | null {
  return (s && PROJECT_STATES.find((k) => s[k] > 0)) ?? null;
}

export const sameStatus = (a: ProjectStatus | undefined, b: ProjectStatus | undefined) =>
  a === b || (!!a && !!b && PROJECT_STATES.every((k) => a[k] === b[k]));

const LABEL: Record<ProjectState, MessageKey> = {
  awaiting: "sidebar.state.awaiting",
  paused: "sidebar.state.paused",
  error: "sidebar.state.error",
  working: "sidebar.state.working",
  done: "sidebar.state.done",
};

// 툴팁·스크린리더용 요약: "waiting 1 · working 2" (급한 순서, 0은 뺀다). 없으면 ""
export function statusSummary(s: ProjectStatus | undefined, t: (key: MessageKey, vars?: Record<string, string | number>) => string): string {
  if (!s) return "";
  return PROJECT_STATES.filter((k) => s[k] > 0)
    .map((k) => t(LABEL[k], { n: s[k] }))
    .join(" · ");
}
