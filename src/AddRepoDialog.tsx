import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { codeError } from "./errors";
import { useT } from "./prefs";
import { baseName } from "./useProjects";
import type { MessageKey } from "./i18n";

type Mode = "clone" | "link";
// Rust가 돌려주는 오류 코드 → 문구. "io" 등 나머지는 원문을 그대로 보인다.
const ERRORS: Record<string, MessageKey> = {
  badName: "repo.error.badName",
  badUrl: "repo.error.badUrl",
  exists: "repo.error.exists",
  notFound: "repo.error.notFound",
  notRepo: "repo.error.notRepo",
  insideProject: "repo.error.insideProject",
  git: "repo.error.git",
};

// "git@host:org/app.git", "https://host/org/app/" → "app"
export const repoNameFromUrl = (url: string) =>
  url.trim().replace(/\/+$/, "").replace(/\/?\.git$/, "").split(/[/:]/).pop() ?? "";

// 프로젝트에 저장소 추가 (src-tauri/src/repos.rs). 끝나면 파일 트리는 폴더 감시로 알아서 갱신된다.
export function AddRepoDialog({ project, onClose }: { project: string; onClose: () => void }) {
  const t = useT();
  const [mode, setMode] = useState<Mode>("clone");
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  // 이름을 직접 고치기 전까지는 URL·폴더에서 이름을 따라 만든다.
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 실패할 때마다 올린다. 같은 오류가 다시 나도 새 시도의 결과인지 알 수 있게 (자체 테스트가 본다).
  const [failures, setFailures] = useState(0);

  const derive = (mode: Mode, source: string) => (mode === "clone" ? repoNameFromUrl(source) : source ? baseName(source.replace(/\/+$/, "")) : "");
  function changeSource(value: string) {
    setSource(value);
    if (!nameEdited) setName(derive(mode, value));
  }
  function changeMode(next: Mode) {
    setMode(next);
    setSource("");
    setError(null);
    if (!nameEdited) setName("");
  }

  async function browse() {
    const picked = await open({ directory: true });
    if (typeof picked === "string") changeSource(picked);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "clone") await invoke("repo_clone", { project, url: source, name });
      else await invoke("repo_link", { project, target: source, name });
      onClose();
    } catch (raw) {
      const { code, detail } = codeError(raw);
      setError(ERRORS[code] ? t(ERRORS[code], { name: name.trim(), path: detail, detail }) : detail);
      setFailures((n) => n + 1);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="modal"
        data-failures={failures}
        onSubmit={submit}
        onKeyDown={(e) => {
          // 한글 조합을 확정하는 Enter·Esc는 제출·닫기가 아니다 (WebKit은 조합 중 keyCode 229).
          if (e.nativeEvent.isComposing || e.keyCode === 229) {
            if (e.key === "Enter") e.preventDefault(); // 폼의 Enter 제출 막기
            return;
          }
          if (e.key === "Escape" && !busy) onClose();
        }}
      >
        <div className="modal-title">{t("repo.add")}</div>
        <div className="modal-sub">{baseName(project)}</div>
        <div className="segmented">
          {(["clone", "link"] as const).map((m) => (
            <button key={m} type="button" className={mode === m ? "on" : ""} data-mode={m} disabled={busy} onClick={() => changeMode(m)}>
              {t(m === "clone" ? "repo.clone" : "repo.link")}
            </button>
          ))}
        </div>
        <label>
          {t(mode === "clone" ? "repo.url" : "repo.path")}
          <div className="field-row">
            <input
              name="source"
              autoFocus
              spellCheck={false}
              value={source}
              disabled={busy}
              placeholder={mode === "clone" ? "git@github.com:org/repo.git" : "/path/to/repo"}
              onChange={(e) => changeSource(e.target.value)}
            />
            {mode === "link" && (
              <button type="button" disabled={busy} onClick={browse}>
                {t("repo.browse")}
              </button>
            )}
          </div>
        </label>
        <label>
          {t("repo.name")}
          <input
            name="name"
            spellCheck={false}
            value={name}
            disabled={busy}
            onChange={(e) => {
              setName(e.target.value);
              setNameEdited(true);
            }}
          />
        </label>
        {mode === "link" && <div className="modal-hint">{t("repo.linkHint")}</div>}
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" disabled={busy || !source.trim() || !name.trim()}>
            {busy ? t("repo.cloning") : t(mode === "clone" ? "repo.submitClone" : "repo.submitLink")}
          </button>
        </div>
      </form>
    </div>
  );
}
