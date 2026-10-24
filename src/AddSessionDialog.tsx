import { useState } from "react";
import { useT } from "./prefs";
import type { Group, Session } from "./useGroups";

// 쓰기 가능한 세션: 명령이 있고 읽기 전용이 아닌 것 (그냥 셸은 사용자가 직접 쓰므로 세지 않는다)
export const isWriter = (s: { command: string; readOnly: boolean; setup?: boolean }) => !!s.command && !s.readOnly && !s.setup;

// 세션 추가: 작업그룹 설정의 세션 하나를 골라 지금 탭에 분할 창으로 띄운다 (그 탭의 폴더에서).
// 쓰기 가능한 세션이 이미 있는 탭에 또 더하려 하면 경고한다: 같은 폴더에서 둘이 같은 파일을 고칠 수 있다.
// 병렬 작업은 새 작업그룹(worktree)으로 유도하고, 그래도 원하면 더한다. writers: 탭에 이미 있는 쓰기 가능한 세션 이름.
export function AddSessionDialog({ groups, writers, onAdd, onNewGroup, onClose }: {
  groups: Group[] | null;
  writers: string[];
  onAdd: (session: Session) => void;
  onNewGroup: () => void;
  onClose: () => void;
}) {
  const t = useT();
  // 경고를 보이는 중인 세션
  const [warned, setWarned] = useState<Session | null>(null);

  const pick = (s: Session) => {
    if (isWriter(s) && writers.length) return setWarned(s);
    onAdd(s);
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal add-session-dialog"
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="modal-title">{t("addSession.title")}</div>
        {warned ? (
          <>
            <div className="modal-error" data-warning>
              {t("addSession.warning", { name: warned.name, names: writers.join(", ") })}
            </div>
            <div className="modal-actions">
              <button className="secondary" autoFocus onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button
                className="secondary"
                data-action="new-group"
                onClick={() => {
                  onClose();
                  onNewGroup();
                }}
              >
                {t("addSession.newGroup")}
              </button>
              <button data-action="add-anyway" onClick={() => (onAdd(warned), onClose())}>
                {t("addSession.addAnyway")}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="modal-hint">{t("addSession.hint")}</div>
            {!groups && <div className="modal-error">{t("addSession.noSettings")}</div>}
            <div className="session-choices">
              {groups?.flatMap((g) =>
                g.sessions.map((s, i) => (
                  <button key={`${g.id}/${i}`} className="session-choice" data-session={`${g.id}/${s.name}`} autoFocus={g === groups[0] && i === 0} onClick={() => pick(s)}>
                    <span className="session-name">{s.name}</span>
                    <span className="session-group">{g.name}</span>
                    {s.readOnly && <span className="pane-badge">{t("session.readOnly")}</span>}
                    <code>{s.command ? [s.command, ...s.args].join(" ") : t("addSession.shell")}</code>
                  </button>
                )),
              )}
            </div>
            <div className="modal-actions">
              <button className="secondary" onClick={onClose}>
                {t("common.cancel")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
