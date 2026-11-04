import { useT } from "./prefs";
import type { Group } from "./useGroups";

// 프로젝트를 추가할 때 첫 탭으로 열 작업그룹 고르기 (App pickProject, docs/spec.md "작업그룹 구성 · 실행").
// 기본 그룹이 먼저이고 포커스가 있어 Enter면 지금까지와 같다. 취소(Esc, 바깥 누름)하면 프로젝트를 추가하지 않는다.
// groups: 기본 그룹이 먼저인 목록 (Workspace groupChoices와 같은 순서)
export function GroupPickDialog({ name, groups, onPick, onClose }: { name: string; groups: Group[]; onPick: (group: Group) => void; onClose: () => void }) {
  const t = useT();
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal group-pick-dialog"
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="modal-title">{t("groupPick.title")}</div>
        <div className="modal-hint">{t("groupPick.hint", { name })}</div>
        <div className="session-choices">
          {groups.map((g, i) => (
            <button key={g.id} className="session-choice" data-group={g.id} autoFocus={i === 0} onClick={() => onPick(g)}>
              <span className="session-name">{g.name}</span>
              <code>{g.sessions.map((s) => s.name).join(", ")}</code>
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
