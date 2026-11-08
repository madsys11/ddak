import type { MessageKey } from "./i18n";
import { isActive, type ChatFilter } from "./chatFilter";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

// 채팅 필터 줄 (src/chatFilter.ts): 작업그룹 탭 (전체 + 그룹마다 하나, 넘치면 맥 패널은 다음 줄로, 폰은 가로로 밀림), "나에게 온 것만" 토글, 숨긴 수.
// 맥 채팅 패널과 폰 채팅이 같이 쓴다 (모양은 각자의 CSS: App.css·mobile.css의 .chat-filter)
export function ChatFilterBar({ filter, groups, hidden, hiddenToMe, t, onChange }: {
  filter: ChatFilter;
  groups: string[];
  hidden: number;
  hiddenToMe: number;
  t: T;
  onChange: (f: ChatFilter) => void;
}) {
  const tab = (group: string | null, label: string) => (
    <button
      key={group ?? ""}
      className={`chat-filter-tab${filter.group === group ? " on" : ""}`}
      data-action="chat-filter-group"
      data-group={group ?? ""}
      aria-pressed={filter.group === group}
      title={group === null ? undefined : t("chat.filterGroupHint", { group })}
      onClick={() => onChange({ ...filter, group })}
    >
      {label}
    </button>
  );
  return (
    <div className="chat-filter">
      <div className="chat-filter-tabs">
        {tab(null, t("chat.filterAllGroups"))}
        {groups.map((g) => tab(g, g))}
      </div>
      <button className={`chat-filter-mine${filter.mine ? " on" : ""}`} data-action="chat-filter-mine" aria-pressed={filter.mine} title={t("chat.filterMineHint")} onClick={() => onChange({ ...filter, mine: !filter.mine })}>
        {t("chat.filterMine")}
      </button>
      {isActive(filter) && hidden > 0 && (
        <span className="chat-filter-hidden" data-hidden={hidden} data-hidden-to-me={hiddenToMe}>
          {hiddenToMe > 0 ? t("chat.filterHiddenToMe", { n: hidden, m: hiddenToMe }) : t("chat.filterHidden", { n: hidden })}
        </span>
      )}
    </div>
  );
}
