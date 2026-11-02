import type { MessageKey } from "./i18n";
import { isActive, type ChatFilter } from "./chatFilter";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

// 채팅 필터 줄 (src/chatFilter.ts): "나와 관련된 것만" 토글, 작업그룹 고르기, 숨긴 수. 맥 채팅 패널과 폰 채팅이 같이 쓴다
// (모양은 각자의 CSS: App.css·mobile.css의 .chat-filter)
export function ChatFilterBar({ filter, groups, hidden, hiddenToMe, t, onChange }: {
  filter: ChatFilter;
  groups: string[];
  hidden: number;
  hiddenToMe: number;
  t: T;
  onChange: (f: ChatFilter) => void;
}) {
  return (
    <div className="chat-filter">
      <button className={`chat-filter-mine${filter.mine ? " on" : ""}`} data-action="chat-filter-mine" aria-pressed={filter.mine} title={t("chat.filterMineHint")} onClick={() => onChange({ ...filter, mine: !filter.mine })}>
        {t("chat.filterMine")}
      </button>
      <select className={`chat-filter-group${filter.group !== null ? " on" : ""}`} data-action="chat-filter-group" title={t("chat.filterGroupHint")} value={filter.group ?? ""} onChange={(e) => onChange({ ...filter, group: e.target.value || null })}>
        <option value="">{t("chat.filterAllGroups")}</option>
        {groups.map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
      </select>
      {isActive(filter) && hidden > 0 && (
        <span className="chat-filter-hidden" data-hidden={hidden} data-hidden-to-me={hiddenToMe}>
          {hiddenToMe > 0 ? t("chat.filterHiddenToMe", { n: hidden, m: hiddenToMe }) : t("chat.filterHidden", { n: hidden })}
        </span>
      )}
    </div>
  );
}
