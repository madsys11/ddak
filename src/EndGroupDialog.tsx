import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { codeError } from "./errors";
import { useT } from "./prefs";
import { baseName } from "./useProjects";

// src-tauri/src/worktrees.rs GroupStatus·Ended
type RepoStatus = {
  label: string;
  branch: string | null;
  unmerged: number;
  unsaved: number;
  changes: number;
  missing: boolean;
  incomplete: boolean;
};
type Status = { repos: RepoStatus[]; recorded: boolean; unknown: string[] };
type Kept = { label: string; branch: string; reason: "unmerged" | "inUse" | "unchecked" | "changed" | "noRecord" };
type Ended = { kept: Kept[] };

const KEPT_REASON = {
  unmerged: "endGroup.keptUnmerged",
  inUse: "endGroup.keptInUse",
  unchecked: "endGroup.keptUnchecked",
  changed: "endGroup.keptChanged",
  noRecord: "endGroup.keptNoRecord",
} as const;
// group_end가 거부한 이유 (worktrees.rs GroupStatus::blocked, "running") → 문구
const BLOCKED = {
  dirty: "endGroup.dirty",
  unsaved: "endGroup.unsavedError",
  unknown: "endGroup.unknownError",
  incomplete: "endGroup.incompleteError",
  running: "endGroup.runningError",
} as const;

// 작업그룹 끝내기: 저장소마다 상태(커밋 안 한 변경, 브랜치에 없는 커밋, 원본에 병합 안 된 커밋)를 보이고, 끝내면 worktree를
// 지우고 병합된 우리 브랜치를 지운다 (병합 안 된 것·사용 중인 것은 남긴다). 지우는 기능이라 커밋 안 한 변경, 브랜치에 없는
// 커밋, 작업그룹 폴더의 모르는 항목, 덜 된 worktree가 있으면 끝내지 않는다. 병합·PR은 사용자가 한다.
// group_end는 확인한 뒤 이 폴더를 잠그고 그 안에서 띄운 세션을 끝내고 기다린 뒤 다시 확인하고 지운다 (확인한 뒤 세션이 만든
// 커밋을 잃지 않게, 리뷰 P1). onStopping: 부르기 직전 (세션이 끝나도 창을 닫지 않게). onFailed(stopped): 끝내지 못함,
// stopped면 세션을 끝낸 뒤라 다시 띄워야 한다.
// onCloseTab: 작업그룹의 마지막 탭을 닫으려다 열린 창이면 "탭만 닫기"로 할 일 (안내와 단추가 더해진다)
export function EndGroupDialog({ project, group, name, onClose, onCloseTab, onStopping, onFailed, onEnded }: {
  project: string;
  group: string;
  name: string;
  onClose: () => void;
  onCloseTab?: () => void;
  onStopping: () => void;
  onFailed: (stopped: boolean) => void;
  onEnded: () => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 끝냈고 남긴 브랜치가 있으면 알려 주고 닫는다
  const [kept, setKept] = useState<Kept[] | null>(null);
  // 세션을 끝낸 뒤 실패해서 다시 띄웠다
  const [restarted, setRestarted] = useState(false);

  useEffect(() => {
    let alive = true;
    invoke<Status>("group_status", { project, group }).then(
      (s) => alive && setStatus(s),
      (e) => alive && setError(codeError(e).detail),
    );
    return () => {
      alive = false;
    };
  }, [project, group]);

  const blocked = !!status && (status.unknown.length > 0 || status.repos.some((r) => r.changes > 0 || r.unsaved > 0 || r.incomplete));
  const labelOf = (r: { label: string }) => r.label || baseName(project);

  async function end() {
    if (busy || !status || blocked) return;
    setBusy(true);
    setError(null);
    const fail = (raw: unknown) => {
      const { code, detail } = codeError(raw);
      setError(code in BLOCKED ? t(BLOCKED[code as keyof typeof BLOCKED], { items: detail }) : detail);
      setBusy(false);
    };
    onStopping();
    try {
      const ended = await invoke<Ended>("group_end", { project, group });
      onEnded();
      if (ended.kept.length) setKept(ended.kept);
      else onClose();
    } catch (raw) {
      fail(raw);
      // src-tauri/src/worktrees.rs EndError.stopped
      const stopped = typeof raw === "object" && raw !== null && (raw as { stopped?: boolean }).stopped === true;
      onFailed(stopped);
      setRestarted(stopped);
    }
  }

  const row = (r: RepoStatus) => {
    if (r.missing) return { text: t("endGroup.missing"), error: false };
    if (r.incomplete) return { text: t("endGroup.incomplete"), error: true };
    if (r.changes > 0) return { text: t("endGroup.changes", { n: r.changes }), error: true };
    if (r.unsaved > 0) return { text: t("endGroup.unsaved", { n: r.unsaved }), error: true };
    if (r.unmerged > 0) return { text: t("endGroup.unmerged", { n: r.unmerged }), error: false };
    return { text: t(status?.recorded ? "endGroup.merged" : "endGroup.mergedKept"), error: false };
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        className="modal end-group-dialog"
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Escape" && !busy) onClose();
        }}
      >
        <div className="modal-title">{t("endGroup.title")}</div>
        <div className="modal-sub">{name}</div>
        {kept ? (
          <>
            <div className="modal-hint">{t("endGroup.kept")}</div>
            {kept.map((k) => (
              <div key={k.label + k.branch} className="end-row" data-kept={labelOf(k)}>
                <span className="check-dir">{labelOf(k)}</span>
                <code>{k.branch}</code>
                <span className="end-state">{t(KEPT_REASON[k.reason])}</span>
              </div>
            ))}
            <div className="modal-actions">
              <button autoFocus onClick={onClose}>
                {t("endGroup.close")}
              </button>
            </div>
          </>
        ) : (
          <>
            {onCloseTab && <div className="modal-hint" data-last-tab>{t("endGroup.lastTab")}</div>}
            <div className="modal-hint">{t("endGroup.hint")}</div>
            {!status && !error && <div className="modal-hint">{t("endGroup.loading")}</div>}
            {status?.repos.map((r) => {
              const { text, error: bad } = row(r);
              return (
                <div key={r.label} className="end-row" data-repo={labelOf(r)}>
                  <span className="check-dir">{labelOf(r)}</span>
                  {r.branch && <code>{r.branch}</code>}
                  <span className={`end-state${bad ? " error" : ""}`}>{text}</span>
                </div>
              );
            })}
            {status && !status.recorded && <div className="modal-hint">{t("endGroup.noRecord")}</div>}
            {!!status?.unknown.length && <div className="modal-error">{t("endGroup.unknownError", { items: status.unknown.join(", ") })}</div>}
            {status?.repos.some((r) => r.changes > 0) && <div className="modal-error">{t("endGroup.commitFirst")}</div>}
            {status?.repos.some((r) => r.unsaved > 0) && <div className="modal-error">{t("endGroup.branchFirst")}</div>}
            {error && <div className="modal-error">{error}</div>}
            {error && restarted && <div className="modal-hint">{t("endGroup.restarted")}</div>}
            <div className="modal-actions">
              <button className="secondary" disabled={busy} onClick={onClose}>
                {t("common.cancel")}
              </button>
              {onCloseTab && (
                <button
                  className="secondary"
                  data-action="close-tab-only"
                  disabled={busy}
                  onClick={() => {
                    onCloseTab();
                    onClose();
                  }}
                >
                  {t("endGroup.closeTabOnly")}
                </button>
              )}
              <button data-action="end-group" disabled={busy || !status || blocked} onClick={end}>
                {t("endGroup.submit")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
