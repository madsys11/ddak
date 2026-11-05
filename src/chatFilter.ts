// 채팅 필터 (docs/spec.md "채팅방 설계" 필터, docs/reviews/2026-11-02-chat-filter.md): 맥 채팅 패널(ChatPanel.tsx)과
// 폰 채팅(mobile/MobileApp.tsx)이 같이 쓴다. 보이는 것만 거른다 (읽음·알림·서버는 그대로).
// - mine: 받은 사람에 사용자가 있는 메시지 ("나에게 온 것만". @all이면 사용자도 받는다. 사용자가 보낸 것은 빠진다).
// - group: 그 작업그룹에 속한 참여자가 관계된 메시지. 관계된 참여자 = 보낸 사람, 받은 사람, 그리고 선택 창 답·권한 모드 기록의
//   대상 세션 (이 기록은 from이 user, to가 비어 있고 대상은 member에만 있다: prompts.rs prompt_result, modes.rs mode_result).
// - 둘 다면 둘 다 맞는 것.

export const USER = "user";

export type ChatFilter = { mine: boolean; group: string | null };
export const NO_FILTER: ChatFilter = { mine: false, group: null };

type Filterable = { from: string; to: string[]; answer?: { member: string }; mode?: { member: string } };

// 참여자 이름 `작업그룹/역할`의 작업그룹 (src-tauri/src/chat.rs group_of와 같다: 첫 / 앞). 없으면 null (user 등)
export function groupOf(name: string): string | null {
  const i = name.indexOf("/");
  return i < 0 ? null : name.slice(0, i);
}

export const involved = (m: Filterable): string[] => [m.from, ...m.to, ...(m.answer ? [m.answer.member] : []), ...(m.mode ? [m.mode.member] : [])];

export const isActive = (f: ChatFilter) => f.mine || f.group !== null;

export function matches(m: Filterable, f: ChatFilter): boolean {
  if (f.mine && !m.to.includes(USER)) return false;
  return f.group === null || involved(m).some((n) => groupOf(n) === f.group);
}

// 고를 수 있는 작업그룹: 지금 참여자 + 받은 메시지(필터 전)에 관계된 참여자의 그룹, 이름순. 고른 그룹이 없어졌어도 남긴다
export function groupsIn(messages: Filterable[], members: string[], chosen: string | null = null): string[] {
  const groups = new Set<string>();
  for (const n of [...members, ...messages.flatMap(involved)]) {
    const g = groupOf(n);
    if (g !== null) groups.add(g);
  }
  if (chosen !== null) groups.add(chosen);
  return [...groups].sort((a, b) => a.localeCompare(b));
}

// 보일 메시지와 숨긴 수 (그중 사용자가 받은 것). 받은 메시지 전체 기준
export function applyFilter<M extends Filterable>(messages: M[], f: ChatFilter) {
  if (!isActive(f)) return { shown: messages, hidden: 0, hiddenToMe: 0 };
  const shown: M[] = [];
  let hidden = 0;
  let hiddenToMe = 0;
  for (const m of messages) {
    if (matches(m, f)) shown.push(m);
    else {
      hidden++;
      if (m.to.includes(USER)) hiddenToMe++;
    }
  }
  return { shown, hidden, hiddenToMe };
}

// 기억: localStorage[storageKey] = { 키 → 필터 }. 읽지 못하거나 모양이 틀리면 필터 없음
function readAll(storageKey: string): Record<string, unknown> {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function loadFilter(storageKey: string, id: string): ChatFilter {
  const v = readAll(storageKey)[id] as Partial<ChatFilter> | undefined;
  if (!v || typeof v !== "object") return NO_FILTER;
  return { mine: v.mine === true, group: typeof v.group === "string" ? v.group : null };
}

export function saveFilter(storageKey: string, id: string, f: ChatFilter) {
  const all = readAll(storageKey);
  if (isActive(f)) all[id] = f;
  else delete all[id];
  try {
    localStorage.setItem(storageKey, JSON.stringify(all));
  } catch {
    // 저장하지 못해도 이번 화면에서는 쓴다
  }
}
