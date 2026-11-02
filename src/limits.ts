import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { devHooks } from "./devHooks";

// 협업 제한 (src-tauri/src/limits.rs, 앱 메뉴 "협업 제한…" src/LimitsDialog.tsx): 세션끼리 사용자 없이 주고받을 메시지 수(자동 깨우기
// 제한)와 재리뷰 최대 횟수. 앱 전체에 하나라 작은 저장소로 둔다: App이 처음에 읽고(loadLimits) Workspace를 연다 (처음 만드는 세션이
// 기본 횟수로 만들어지지 않게). 바뀌면 Rust가 "limits" 이벤트로 알린다.
export type Limits = { wakeLimit: number; reReviews: number };
export const DEFAULT_LIMITS: Limits = { wakeLimit: 10, reReviews: 2 };
// 고를 수 있는 범위 (limits.rs WAKE_RANGE·RE_REVIEW_RANGE)
export const WAKE_RANGE = [1, 100] as const;
export const RE_REVIEW_RANGE = [0, 5] as const;

let current: Limits = DEFAULT_LIMITS;
// 저장한 값을 읽었다 (읽기를 시도해 끝남). 그 전에는 기본값이라 창이 그 값을 보이거나 저장하면 안 된다 (리뷰 R1)
let loaded = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());
const set = (l: Limits) => {
  current = l;
  notify();
};
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};

export const currentLimits = () => current;
export const useLimits = () => useSyncExternalStore(subscribe, () => current);
export const useLimitsLoaded = () => useSyncExternalStore(subscribe, () => loaded);

// 처음 읽기와 바뀜 알림 등록. 읽지 못하면 기본값으로 연다. 끝나면 풀린다 (App이 기다린다)
let started: Promise<void> | null = null;
export function loadLimits() {
  started ??= (async () => {
    await listen<Limits>("limits", ({ payload }) => set(payload)).catch(() => {});
    await invoke<Limits>("limits_get").then(set, () => {});
    loaded = true;
    notify();
  })();
  return started;
}

// 자체 테스트: 아직 읽지 않은 처음 상태(기본값)로 되돌리고 devHooks.limitsGetDelay 뒤에 다시 읽는다 (앱을 켠 직후 창을 여는 경우.
// 바뀜 알림 등록은 남는다)
export function devResetLimits() {
  if (!import.meta.env.DEV) return;
  current = DEFAULT_LIMITS;
  loaded = false;
  started = (async () => {
    const delay = devHooks.limitsGetDelay ?? 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    await invoke<Limits>("limits_get").then(set, () => {});
    loaded = true;
    notify();
  })();
  notify();
  return started;
}

export const saveLimits = (l: Limits) => invoke<Limits>("limits_set", { wakeLimit: l.wakeLimit, reReviews: l.reReviews }).then((saved) => (set(saved), saved));

// 작업그룹 규약의 {reReviews}를 횟수로 (useGroups.ts promptOf). 다른 글은 그대로
export const fillRules = (rules: string, reReviews = current.reReviews) => rules.split("{reReviews}").join(String(reReviews));
