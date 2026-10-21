// 탭 하나의 분할 구조. 잎은 터미널 하나, 가지는 두 영역으로 나눈 것.
export type Layout =
  | { pane: number }
  | { dir: "row" | "col"; ratio: number; a: Layout; b: Layout };

export type Path = ("a" | "b")[];
// 0~1 비율 좌표
export type Rect = { x: number; y: number; w: number; h: number };

export function paneIds(l: Layout): number[] {
  return "pane" in l ? [l.pane] : [...paneIds(l.a), ...paneIds(l.b)];
}

// 터미널 하나를 두 개로 나눈다. 새 터미널은 오른쪽(row) 또는 아래(col)에 놓인다.
export function split(l: Layout, target: number, dir: "row" | "col", added: number): Layout {
  if ("pane" in l) return l.pane === target ? { dir, ratio: 0.5, a: l, b: { pane: added } } : l;
  return { ...l, a: split(l.a, target, dir, added), b: split(l.b, target, dir, added) };
}

// 터미널 하나를 빼고, 남은 쪽이 그 자리를 채운다. 마지막 하나를 빼면 null.
export function remove(l: Layout, target: number): Layout | null {
  if ("pane" in l) return l.pane === target ? null : l;
  const a = remove(l.a, target);
  const b = remove(l.b, target);
  if (!a) return b;
  if (!b) return a;
  return { ...l, a, b };
}

export function setRatio(l: Layout, path: Path, ratio: number): Layout {
  if ("pane" in l) return l;
  if (path.length === 0) return { ...l, ratio };
  const [head, ...rest] = path;
  return { ...l, [head]: setRatio(l[head], rest, ratio) };
}

export type Divider = { path: Path; dir: "row" | "col"; parent: Rect; ratio: number };

export function measure(l: Layout, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }, path: Path = []) {
  const panes: { id: number; rect: Rect }[] = [];
  const dividers: Divider[] = [];
  (function walk(l: Layout, r: Rect, path: Path) {
    if ("pane" in l) {
      panes.push({ id: l.pane, rect: r });
      return;
    }
    const [ra, rb] =
      l.dir === "row"
        ? [{ ...r, w: r.w * l.ratio }, { ...r, x: r.x + r.w * l.ratio, w: r.w * (1 - l.ratio) }]
        : [{ ...r, h: r.h * l.ratio }, { ...r, y: r.y + r.h * l.ratio, h: r.h * (1 - l.ratio) }];
    dividers.push({ path, dir: l.dir, parent: r, ratio: l.ratio });
    walk(l.a, ra, [...path, "a"]);
    walk(l.b, rb, [...path, "b"]);
  })(l, rect, path);
  return { panes, dividers };
}
