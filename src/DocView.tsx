import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { codeError } from "./errors";
import { baseName, isDocPath, renderMarkdown, requestOpenDoc, resolveHref } from "./docs";
import { useT } from "./prefs";
import { openLink } from "./terminalLinks";
import { watchDir } from "./watchDir";

// 문서 탭: 마크다운 파일을 읽기 전용으로 그린다 (src/docs.ts). 파일이 바뀌면 다시 읽는다 (그 폴더를 감시).
// 링크: 웹 주소는 브라우저, 다른 문서는 문서 탭, 그 밖의 파일은 기본 앱 (터미널 링크와 같은 규칙, links.rs open_link),
// #제목은 이 문서 안에서. 그림: 로컬 파일은 Rust가 읽어 data: 주소로 (fs_read_image), 웹 그림은 불러오지 않고 링크로 둔다.
// jump: 열고 나서 갈 제목 (다른 문서의 #제목 링크로 열었을 때). n이 바뀔 때마다 한 번
export function DocView({ path, project, jump }: { path: string; project: string; jump?: { anchor: string; n: number } }) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    // 늦게 온 이전 읽기가 새 내용을 덮지 않게 마지막 읽기만 쓴다
    let seq = 0;
    const load = () => {
      const n = ++seq;
      invoke<string>("fs_read_text", { path }).then(
        (s) => alive && n === seq && (setText(s), setError(null)),
        (e) => {
          if (!alive || n !== seq) return;
          const { code, detail } = codeError(e);
          setText(null);
          setError(code === "missing" ? t("doc.missing", { path }) : code === "tooLarge" ? t("doc.tooLarge") : t("doc.readFailed", { detail }));
        },
      );
    };
    load();
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const unwatch = watchDir(dir, load, { contents: true });
    return () => {
      alive = false;
      unwatch();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // 웹 그림은 만들 때 링크 글자로 바뀐다 (docs.ts, 문서를 열기만 해도 바깥에 요청이 가지 않게)
  const html = useMemo(() => (text === null ? "" : renderMarkdown(text, (name) => t("doc.webImage", { name }))), [text, t]);

  // 로컬 그림: 주소 없이 그려진 것(data-src)을 Rust가 읽어 data: 주소로 넣는다
  useEffect(() => {
    const root = body.current;
    if (!root) return;
    let alive = true;
    for (const img of root.querySelectorAll<HTMLImageElement>("img[data-src]")) {
      const target = resolveHref(path, img.dataset.src!);
      if (target?.kind !== "file") continue;
      invoke<string>("fs_read_image", { path: target.path }).then(
        (data) => alive && (img.src = data),
        () => alive && img.classList.add("broken"),
      );
    }
    return () => {
      alive = false;
    };
  }, [html, path]);

  // 열고 나서 그 제목으로 (그 제목이 그려진 뒤에. 한 요청에 한 번)
  const jumped = useRef(0);
  useEffect(() => {
    if (!jump || jump.n === jumped.current) return;
    const el = body.current?.querySelector(`[id="${CSS.escape(jump.anchor)}"]`);
    if (!el) return;
    jumped.current = jump.n;
    el.scrollIntoView();
  }, [jump, html]);

  // 링크를 누르면: 웹뷰가 앱 화면을 떠나지 않게 기본 동작은 늘 막는다
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as Element).closest("a");
    if (!a) return;
    e.preventDefault();
    const target = resolveHref(path, a.getAttribute("href") ?? "");
    if (!target) return;
    if (target.kind === "web") openLink(target.url);
    else if (target.kind === "anchor") body.current?.querySelector(`[id="${CSS.escape(target.id)}"]`)?.scrollIntoView();
    else if (isDocPath(target.path) && target.path !== path) requestOpenDoc({ path: target.path, project, anchor: target.anchor || undefined });
    else if (target.path === path && target.anchor) body.current?.querySelector(`[id="${CSS.escape(target.anchor)}"]`)?.scrollIntoView();
    else if (target.path !== path) openLink(target.path);
  };

  return (
    <div className="doc-view" data-doc={path}>
      <div className="doc-header" title={path}>
        <span className="doc-name">{baseName(path)}</span>
        <button className="doc-open" title={t("doc.openDefault")} onClick={() => openLink(path)}>
          {t("doc.openDefault")}
        </button>
      </div>
      {error && <div className="doc-error">{error}</div>}
      {/* html: 문서의 HTML은 이스케이프된다 (docs.ts) */}
      <div className="doc-body" ref={body} onClick={onClick} onAuxClick={(e) => e.preventDefault()} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
