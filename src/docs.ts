import MarkdownIt from "markdown-it";
import { IS_WINDOWS, baseName as lastName, dirName as parentDir, isAbsolutePath, normalizePath } from "./platform";

// 문서 탭 (src/DocView.tsx): 마크다운 파일을 앱 안에서 읽기 전용으로 본다. 여기는 화면 없이 시험할 수 있는 부분.

// 문서 탭으로 여는 파일
const DOC_EXT = /\.(md|markdown)$/i;
export const isDocPath = (path: string) => isAbsolutePath(path) && DOC_EXT.test(path);

// 문서 탭으로 열어 달라는 요청 (파일 트리 더블클릭·메뉴, 터미널 ⌘클릭, 문서 안 링크). App이 받아 그 프로젝트로 가서 연다.
// project가 없으면 보고 있는 프로젝트
// anchor: 열고 나서 갈 제목 (문서 안 링크의 #)
export type OpenDoc = { path: string; project?: string; anchor?: string };
const OPEN_DOC = "ddak-open-doc";
export const requestOpenDoc = (detail: OpenDoc) => window.dispatchEvent(new CustomEvent<OpenDoc>(OPEN_DOC, { detail }));
export function onOpenDoc(handler: (d: OpenDoc) => void) {
  const listener = (e: Event) => handler((e as CustomEvent<OpenDoc>).detail);
  window.addEventListener(OPEN_DOC, listener);
  return () => window.removeEventListener(OPEN_DOC, listener);
}

export const baseName = lastName;
// 문서 경로는 절대 경로라 드라이브·UNC로 시작하면 Windows 경로다
const dirName = (path: string) => parentDir(path, IS_WINDOWS || /^[A-Za-z]:[\\/]|^\\\\/.test(path)) || "/";

// 경로의 `.`·`..`·빈 조각을 정리한다 (절대 경로. Windows 경로도, platform.ts)
const normalize = normalizePath;

// 문서 안 주소가 가리키는 것. web: 브라우저, anchor: 이 문서의 제목, file: 로컬 파일 (문서면 문서 탭, 아니면 기본 앱)
export type Target = { kind: "web"; url: string } | { kind: "anchor"; id: string } | { kind: "file"; path: string; anchor: string } | null;
export function resolveHref(doc: string, href: string): Target {
  if (/^(https?|mailto):/i.test(href)) return { kind: "web", url: href };
  if (href.startsWith("#")) return { kind: "anchor", id: decode(href.slice(1)) };
  // 그 밖의 주소 형식(javascript:, file: 등)은 따르지 않는다. Windows 드라이브 경로(C:\, C:/)는 주소 형식이 아니다
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[A-Za-z]:[\\/]/.test(href)) return null;
  const hash = href.indexOf("#");
  const [raw, anchor] = hash < 0 ? [href, ""] : [href.slice(0, hash), decode(href.slice(hash + 1))];
  const query = raw.indexOf("?");
  const rel = decode(query < 0 ? raw : raw.slice(0, query));
  if (!rel) return anchor ? { kind: "anchor", id: anchor } : null;
  // 절대 경로(`/`, Windows는 `C:\`도)면 그대로, 아니면 문서가 있는 폴더 기준
  return { kind: "file", path: normalize(isAbsolutePath(rel) ? rel : `${dirName(doc)}/${rel}`), anchor };
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// 문서 안의 HTML은 실행하지 않고 글자로 보인다 (에이전트가 쓴 문서. html: false면 markdown-it이 이스케이프한다)
const md = new MarkdownIt({ html: false, linkify: true });
type Env = { webImage: (name: string) => string };
// 그림은 만드는 HTML에 바깥 주소가 들어가지 않게 한다 (리뷰 R1: 화면에 넣은 뒤 바꾸면 그 전에 요청이 나간다).
// data: 그림은 그대로, 웹 그림은 링크 글자로, 로컬 그림은 주소 없이 data-src에 두고 DocView가 읽어 data: 주소로 넣는다.
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const tok = tokens[idx];
  const src = String(tok.attrGet("src") ?? "");
  const webImage = (env as Partial<Env> | undefined)?.webImage;
  const alt = String(self.renderInlineAsText(tok.children ?? [], options, env));
  const esc = md.utils.escapeHtml;
  if (/^data:image\//i.test(src)) return `<img src="${esc(src)}" alt="${esc(alt)}">`;
  if (/^https?:/i.test(src)) return `<a href="${esc(src)}">${esc(webImage?.(alt || src) ?? src)}</a>`;
  return `<img data-src="${esc(src)}" alt="${esc(alt)}">`;
};

// 제목의 앵커 이름 (GitHub 방식: 소문자, 공백은 -, 문장 부호는 뺀다. 같은 이름은 -1, -2)
export function slug(text: string, seen: Map<string, number>) {
  const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

// 마크다운 → HTML. 제목에 앵커 이름을 붙이고, `[ ]`·`[x]`로 시작하는 목록 항목은 체크박스로 (읽기 전용).
// webImage: 웹 그림 대신 보일 링크 글자
export function renderMarkdown(text: string, webImage: Env["webImage"]) {
  const env: Env = { webImage };
  const tokens = md.parse(text, env);
  const seen = new Map<string, number>();
  tokens.forEach((tok, i) => {
    if (tok.type === "heading_open") {
      const inline = tokens[i + 1];
      tok.attrSet("id", slug(inline?.children?.filter((c) => c.type === "text" || c.type === "code_inline").map((c) => c.content).join("") ?? "", seen));
    }
    // 목록 항목 바로 안의 첫 문단 글이 [ ] / [x]로 시작하면
    if (tok.type === "inline" && tokens[i - 1]?.type === "paragraph_open" && tokens[i - 2]?.type === "list_item_open") {
      const first = tok.children?.[0];
      const m = first?.type === "text" ? /^\[([ xX])\]\s/.exec(first.content) : null;
      if (!first || !m) return;
      first.content = first.content.slice(m[0].length);
      const Token = first.constructor as new (type: string, tag: string, nesting: number) => NonNullable<typeof first>;
      const box = new Token("html_inline", "", 0);
      box.content = `<input type="checkbox" class="doc-task" disabled${m[1] === " " ? "" : " checked"}> `;
      tok.children!.unshift(box);
      tokens[i - 2].attrJoin("class", "doc-task-item");
    }
  });
  // html_inline은 위에서 만든 체크박스뿐이다 (html: false라 문서의 HTML은 글자 토큰으로 남는다)
  return md.renderer.render(tokens, md.options, env);
}
