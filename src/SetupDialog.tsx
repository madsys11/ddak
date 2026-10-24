import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { devHooks } from "./devHooks";
import { codeError } from "./errors";
import { useT } from "./prefs";
import { baseName } from "./useProjects";

// src-tauri/src/setup.rs SetupInfo. kind: "node" (node_modules), "cargo" (cargo target)
type Candidate = { path: string; kind: "node" | "cargo" };
type Info = { candidates: Candidate[]; clone: string[] };

// 작업그룹 준비 (src-tauri/src/setup.rs): 새 작업그룹에 복제할 커밋 안 된 폴더를 고르고, 준비 스크립트를 연다.
// 고른 것은 프로젝트별 설정에 저장하고 새 작업그룹을 만들 때마다 조건을 다시 본다 (node_modules는 manifest·lockfile).
export function SetupDialog({ project, onClose }: { project: string; onClose: () => void }) {
  const t = useT();
  const [info, setInfo] = useState<Info | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 정리된 효과의 응답은 버린다. 개발 모드(StrictMode)는 효과를 두 번 돌려서, 늦게 온 첫 응답이 그 사이 사용자가
  // 고른 것을 되돌렸다 (리뷰 P2).
  useEffect(() => {
    let cancelled = false;
    const delay = import.meta.env.DEV ? (devHooks.setupLoadDelay?.() ?? 0) : 0;
    invoke<Info>("setup_load", { project })
      .then(async (loaded) => {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        return loaded;
      })
      .then(
        (loaded) => {
          if (cancelled) return;
          setInfo(loaded);
          setChosen(new Set(loaded.clone));
        },
        (e) => !cancelled && setError(codeError(e).detail),
      );
    return () => {
      cancelled = true;
    };
  }, [project]);

  // 저장돼 있지만 지금은 원본에 없는 항목도 보여서 뺄 수 있게 한다
  const rows: { path: string; hint: string }[] = info
    ? [
        ...info.candidates.map((c) => ({ path: c.path, hint: t(c.kind === "node" ? "setup.nodeHint" : "setup.cargoHint") })),
        ...info.clone.filter((p) => !info.candidates.some((c) => c.path === p)).map((path) => ({ path, hint: t("setup.missingHint") })),
      ]
    : [];

  function toggle(path: string) {
    const next = new Set(chosen);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setChosen(next);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !info) return;
    setBusy(true);
    setError(null);
    try {
      // 목록에 보인 순서대로
      await invoke("setup_save", { project, clone: rows.map((r) => r.path).filter((p) => chosen.has(p)) });
      onClose();
    } catch (raw) {
      setError(codeError(raw).detail);
      setBusy(false);
    }
  }

  function editScript() {
    invoke("setup_script_edit", { project }).catch((raw) => setError(t("sidebar.editSetupFailed", { detail: codeError(raw).detail })));
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="modal setup-dialog"
        onSubmit={save}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Escape" && !busy) onClose();
        }}
      >
        <div className="modal-title">{t("setup.title")}</div>
        <div className="modal-sub">{baseName(project)}</div>
        <div className="modal-hint">{t("setup.commitHint")}</div>
        <div className="setup-section">
          <div className="setup-label">{t("setup.cloneLabel")}</div>
          {!info && !error && <div className="modal-hint">{t("setup.loading")}</div>}
          {info && rows.length === 0 && <div className="modal-hint">{t("setup.noCandidates")}</div>}
          {rows.map((r) => (
            <label key={r.path} className="check-row" data-clone={r.path}>
              <input type="checkbox" checked={chosen.has(r.path)} disabled={busy} onChange={() => toggle(r.path)} />
              <span className="check-name">{r.path}</span>
              <span className="check-hint">{r.hint}</span>
            </label>
          ))}
          {rows.length > 0 && <div className="modal-hint">{t("setup.cloneHint")}</div>}
        </div>
        <div className="setup-section">
          <div className="setup-label">{t("setup.scriptLabel")}</div>
          <div className="field-row">
            <button type="button" className="secondary" data-action="edit-script" onClick={editScript}>
              {t("setup.editScript")}
            </button>
          </div>
          <div className="modal-hint">{t("setup.scriptHint")}</div>
        </div>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" disabled={busy || !info}>
            {t("setup.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
