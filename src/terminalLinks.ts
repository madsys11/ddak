import { invoke } from "@tauri-apps/api/core";
import type { IBufferRange, ILink, ILinkHandler, ILinkProvider, Terminal as XTerm } from "@xterm/xterm";
import { isDocPath, requestOpenDoc } from "./docs";

// 터미널 링크: 화면 글자의 URL과 파일 경로를 ⌘+클릭하면 기본 앱으로 연다 (src-tauri/src/links.rs open_link). 마크다운은 문서 탭.
// claude는 ddak 안에서 경로·URL을 OSC 8 없이 평문으로 그린다 (claude 2.1.310로 실험, 2026-10-26). 그래서 글자에서 찾는다.
// 파일 경로는 실제로 있는 것만 링크로 보인다 (link_targets: 상대 경로는 앞에서 도는 프로그램의 현재 폴더, 없으면 창을 띄운 폴더).
// 그냥 클릭은 창 고르기·선택에 쓰고, 여는 것은 ⌘+클릭 (macOS 터미널들과 같음). 올리면 안내가 뜬다.
// OSC 8 링크(ls --hyperlink 등)도 같은 방식으로 연다 (xterm 기본 처리는 http만 받고 confirm·window.open이라 앱에서 열리지 않았다).

export type FoundLink = { start: number; end: number; kind: "url" | "path"; target: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
// 경로 후보 낱말: 공백과 감싸는 기호 밖의 연속된 글자
const TOKEN_RE = /[^\s"'`<>()[\]{}|,;]+/g;
// 문장 부호로 끝나면 뺀다 ("spec.md." "x.html:")
const TRAIL_RE = /[.,:;!?)\]}>'"]+$/;
// 줄·칸 번호 (src/x.ts:42, src/x.ts:42:7). 여는 것은 파일 자체
const LINE_RE = /(:\d+){1,2}$/;
// 한국어 문장에서 경로 뒤에 붙는 조사 ("docs/spec.md에", "x.html을")
const HANGUL_TAIL_RE = /[ㄱ-ㆎ가-힣]+$/;
const EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,9}$/; // 확장자는 글자로 시작 (v1.0은 아님)
const MAX_LINKS = 40;

// 한 줄에서 링크 후보 (경로는 있는지 아직 모른다). 같은 자리에서 조사를 뺀 것과 안 뺀 것을 모두 낸다 (있는 쪽을 쓴다)
export function findLinks(text: string): FoundLink[] {
  const out: FoundLink[] = [];
  const urls: [number, number][] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(TRAIL_RE, "");
    urls.push([m.index, m.index + m[0].length]);
    out.push({ start: m.index, end: m.index + url.length, kind: "url", target: url });
  }
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index;
    if (urls.some(([a, b]) => start < b && start + m[0].length > a)) continue;
    const word = m[0].replace(TRAIL_RE, "");
    const plain = word.replace(HANGUL_TAIL_RE, "").replace(TRAIL_RE, "");
    for (const shown of new Set([word, plain])) {
      const target = shown.replace(LINE_RE, "");
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || /^[\d.]+$/.test(target)) continue;
      if (!target.includes("/") && !EXT_RE.test(target)) continue;
      out.push({ start, end: start + shown.length, kind: "path", target });
    }
    if (out.length >= MAX_LINKS) break;
  }
  return out.slice(0, MAX_LINKS);
}

// 이어진(줄바꿈 없이 넘친) 줄들을 한 줄로: 글자와 글자마다의 칸 (1부터, 넓은 글자는 두 칸). first·last는 버퍼 줄 (0부터)
type Cell = { x: number; y: number; w: number };
type Line = { text: string; cells: Cell[]; first: number; last: number };
function logicalLine(term: XTerm, y: number): Line {
  const buf = term.buffer.active;
  let first = y - 1;
  while (first > 0 && buf.getLine(first)?.isWrapped && y - 1 - first < 50) first--;
  let text = "";
  const cells: Cell[] = [];
  let last = first;
  for (let row = first; row < first + 50; row++) {
    const line = buf.getLine(row);
    if (!line || (row > first && !line.isWrapped)) break;
    last = row;
    // 다음 줄로 넘친 줄의 끝에 남은 빈 칸은 공백이 아니다: 넓은 글자가 마지막 한 칸에 못 들어가면 xterm은 그 칸을 비우고
    // 다음 줄에 쓴다 (리뷰 R1: 공백으로 붙이니 URL·경로가 끊겼다). 쓴 공백은 글자(" ")가 있다
    let end = line.length;
    if (buf.getLine(row + 1)?.isWrapped) while (end > 0 && !line.getCell(end - 1)?.getChars()) end--;
    for (let x = 0; x < end; x++) {
      const cell = line.getCell(x);
      const w = cell?.getWidth() ?? 1;
      if (w === 0) continue;
      const ch = cell?.getChars() || " ";
      for (let k = 0; k < ch.length; k++) cells.push({ x: x + 1, y: row + 1, w });
      text += ch;
    }
  }
  return { text, cells, first, last };
}

// 스스로 줄을 잘라 그리는 프로그램(claude)의 긴 경로: 창 폭을 넘는 낱말을 다음 줄에 이어 그려서 터미널에는 별개의 줄이다.
// 한 줄의 마지막 낱말과 다음 줄의 (들여쓰기 뒤) 첫 낱말을 이어 붙인 글자를 만든다. 다음 줄이 그 낱말 하나뿐이면 그다음 줄로
// 계속 잇는다. 이을 때마다 그때까지를 하나씩 낸다 (경로가 끝난 줄 뒤의 설명·프롬프트까지 붙은 것만 내면 경로를 놓친다,
// 리뷰 R1). split: 첫 줄 부분의 길이 (이음을 지나는 후보만 쓴다). 붙인 경로는 실제로 있어야 링크다 (link_targets)
const WORD = String.raw`[^\s"'\`<>()[\]{}|,;]+`;
const TAIL_RE = new RegExp(`(${WORD})\\s*$`);
const HEAD_RE = new RegExp(`^\\s*(${WORD})`);
const NEAR_LINES = 3;
type Joined = { text: string; cells: Cell[]; split: number };
function joinedAround(term: XTerm, here: Line): Joined[] {
  const lines: Line[] = [here];
  for (let i = 0; i < NEAR_LINES && lines[0].first > 0; i++) lines.unshift(logicalLine(term, lines[0].first));
  for (let i = 0; i < NEAR_LINES && term.buffer.active.getLine(lines[lines.length - 1].last + 1); i++) lines.push(logicalLine(term, lines[lines.length - 1].last + 2));
  const out: Joined[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const tail = TAIL_RE.exec(lines[i].text);
    if (!tail) continue;
    let text = tail[1];
    let cells = lines[i].cells.slice(tail.index, tail.index + text.length);
    const split = text.length;
    for (let j = i + 1; j < lines.length; j++) {
      const head = HEAD_RE.exec(lines[j].text);
      if (!head) break;
      const start = head[0].length - head[1].length;
      text += head[1];
      cells = cells.concat(lines[j].cells.slice(start, head[0].length));
      out.push({ text, cells, split });
      // 그 줄이 낱말 하나뿐일 때만 다음 줄로 더 잇는다
      if (lines[j].text.trimEnd().length !== head[0].length) break;
    }
  }
  return out;
}

const range = (cells: Cell[], start: number, end: number): IBufferRange => {
  const last = cells[end - 1];
  return { start: { x: cells[start].x, y: cells[start].y }, end: { x: last.x + last.w - 1, y: last.y } };
};

export const openLink = (target: string) => invoke("open_link", { target }).catch(() => {});

// ⌘+클릭: 마크다운 파일은 앱 안 문서 탭으로 (보고 있는 프로젝트, src/docs.ts), 나머지는 기본 앱으로.
// OSC 8의 file:// 주소도 경로로 본다. 호스트가 있으면 (localhost 말고) 다른 컴퓨터의 파일이라 문서 탭으로 열지 않는다
// (리뷰 R3. open_link의 Url::to_file_path도 거절한다)
export function docPathOf(target: string): string | null {
  let path = target;
  if (/^file:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      if (url.hostname && url.hostname !== "localhost") return null;
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  }
  return isDocPath(path) ? path : null;
}

function activate(target: string) {
  const path = docPathOf(target);
  if (path) requestOpenDoc({ path });
  else openLink(target);
}

type Context = { id: () => number | undefined; cwd: () => string; hint: () => string };

// 링크 위에 올리면 터미널 요소의 title로 안내 (⌘+클릭으로 열기)
const hover = (term: XTerm, ctx: Context) => ({
  hover: () => term.element?.setAttribute("title", ctx.hint()),
  leave: () => term.element?.removeAttribute("title"),
});

export function linkProvider(term: XTerm, ctx: Context): ILinkProvider {
  // 경로가 있는지 (창·폴더·후보마다). 마우스를 움직일 때마다 묻지 않게 잠시 기억한다
  const known = new Map<string, { at: number; path: string | null }>();
  const KEEP_MS = 3000;
  return {
    provideLinks(y, callback) {
      const here = logicalLine(term, y);
      type Item = FoundLink & { text: string; cells: Cell[] };
      const found: Item[] = findLinks(here.text).map((f) => ({ ...f, text: here.text, cells: here.cells }));
      // 다음 줄에 이어 그린 경로 (URL은 있는지 확인할 수 없어 잇지 않는다)
      for (const j of joinedAround(term, here))
        for (const f of findLinks(j.text)) if (f.kind === "path" && f.start < j.split && f.end > j.split) found.push({ ...f, text: j.text, cells: j.cells });
      if (!found.length) return callback(undefined);
      const key = (target: string) => `${ctx.id()}\0${ctx.cwd()}\0${target}`;
      const now = Date.now();
      const ask = [...new Set(found.filter((f) => f.kind === "path" && !((known.get(key(f.target))?.at ?? -Infinity) > now - KEEP_MS)).map((f) => f.target))];
      const asked = ask.length
        ? invoke<(string | null)[]>("link_targets", { id: ctx.id() ?? null, cwd: ctx.cwd(), candidates: ask })
            .then((paths) => ask.forEach((t, i) => known.set(key(t), { at: now, path: paths[i] ?? null })))
            .catch(() => {})
        : Promise.resolve();
      asked.then(() => {
        const at = (p: { x: number; y: number }) => p.y * 100_000 + p.x;
        const links: ILink[] = [];
        for (const f of found) {
          const target = f.kind === "url" ? f.target : known.get(key(f.target))?.path;
          if (!target) continue;
          const r = range(f.cells, f.start, f.end);
          links.push({
            range: r,
            text: f.text.slice(f.start, f.end),
            decorations: { underline: true, pointerCursor: true },
            activate: (e) => e.metaKey && activate(target),
            ...hover(term, ctx),
          });
        }
        // 다른 링크 안에 든 것은 뺀다: 조사를 붙인 것과 뗀 것이 둘 다 있으면 긴 것, 이어 붙인 경로가 있으면 줄마다의 조각은
        // 버림. 범위가 같으면 앞의 것 하나만
        const inside = (a: ILink, b: ILink) => at(b.range.start) <= at(a.range.start) && at(a.range.end) <= at(b.range.end);
        const same = (a: ILink, b: ILink) => inside(a, b) && inside(b, a);
        const shown = links.filter(
          (l, i) => !links.some((o, j) => j !== i && inside(l, o) && (!same(l, o) || j < i)) && l.range.start.y <= y && l.range.end.y >= y,
        );
        callback(shown.length ? shown : undefined);
      });
    },
  };
}

// OSC 8 링크 처리 (Terminal 옵션 linkHandler)
export function oscLinkHandler(term: XTerm, ctx: Context): ILinkHandler {
  const h = hover(term, ctx);
  return { allowNonHttpProtocols: true, activate: (e, uri) => e.metaKey && activate(uri), hover: h.hover, leave: h.leave };
}
