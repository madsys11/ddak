// 맥과 Windows에서 다른 것 (docs/windows-plan.md). 화면은 WebView2(Windows)·WKWebView(맥)라 userAgent로 가른다.

export const IS_WINDOWS = typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);

type Mods = { metaKey: boolean; ctrlKey: boolean };

// 앱 단축키의 수정 키: 맥 ⌘, Windows Ctrl (W3: ⌘를 Ctrl로 그대로 바꾼다)
export const cmdKey = (e: Mods) => (IS_WINDOWS ? e.ctrlKey : e.metaKey);
// 앱 단축키가 아닌 쪽 (맥 Ctrl, Windows ⊞). 눌려 있으면 앱 단축키로 보지 않는다
export const otherKey = (e: Mods) => (IS_WINDOWS ? e.metaKey : e.ctrlKey);

// 화면 문구의 키 표시. 사전은 맥 기호로 쓰고 Windows에서 바꾼다: ⇧⌘T → Ctrl+Shift+T, ⌘T → Ctrl+T, ⌘-click → Ctrl+click
export function keyLabels(text: string, windows = IS_WINDOWS): string {
  if (!windows) return text;
  return text
    .replace(/⇧⌘/g, "Ctrl+Shift+")
    .replace(/⌘-/g, "Ctrl+")
    .replace(/⌘\+?/g, "Ctrl+")
    .replace(/⇧/g, "Shift+")
    .replace(/⌥/g, "Alt+");
}

// 경로의 구분자: Windows는 \ 와 / 모두, 맥은 / 만 (맥에서 \ 는 이름의 일부다: Finder의 "a\b.png")
const SEP = /[\\/]/;
const sepOf = (windows: boolean) => (windows ? SEP : "/");

// 마지막 이름 (구분자로 끝나면 그 앞)
export function baseName(path: string, windows = IS_WINDOWS): string {
  const parts = path.split(sepOf(windows)).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

// 끝의 구분자를 지운다 (루트 /, C:\ 는 그대로)
export function trimTrailingSep(path: string, windows = IS_WINDOWS): string {
  if (path.length <= 1 || (windows && /^[A-Za-z]:[\\/]$/.test(path))) return path;
  return path.replace(windows ? /[\\/]+$/ : /\/+$/, "") || path;
}

// 마지막 구분자 앞 (없으면 ""). 루트의 바로 아래면 루트 ("/", "C:\")
export function dirName(path: string, windows = IS_WINDOWS): string {
  const i = Math.max(path.lastIndexOf("/"), windows ? path.lastIndexOf("\\") : -1);
  if (i < 0) return "";
  const dir = path.slice(0, i);
  if (dir === "") return path[0];
  if (/^[A-Za-z]:$/.test(dir)) return dir + path[i];
  return dir;
}

// file:// 주소의 경로. Windows는 file:///C:/a/b.md → C:\a\b.md, file://서버/공유/x → \\서버\공유\x.
// 맥은 localhost나 빈 호스트만. 읽지 못하면 null
export function fileUrlPath(target: string, windows = IS_WINDOWS): string | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const local = !url.hostname || url.hostname === "localhost";
  if (!windows) return local ? path : null;
  if (!local) return `\\\\${url.hostname}${path.replace(/\//g, "\\")}`;
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1).replace(/\//g, "\\") : null;
}

// 절대 경로인지: /…, C:\…, C:/…, \\서버\…
export const isAbsolutePath = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");

// 절대 경로의 `.`·`..`·빈 조각을 정리한다. Windows 경로(드라이브·UNC)는 \ 로 잇고 루트 위로 올라가지 않는다.
// 맥 경로(/로 시작)의 \ 는 이름의 일부로 둔다
export function normalizePath(path: string): string {
  const unc = path.startsWith("/") ? null : /^\\\\[^\\/]+[\\/][^\\/]+/.exec(path);
  const drive = path.startsWith("/") ? null : /^[A-Za-z]:(?=[\\/])/.exec(path);
  const root = unc ? unc[0] + "\\" : drive ? drive[0] + "\\" : "/";
  const rest = unc ? path.slice(unc[0].length) : drive ? path.slice(2) : path;
  const sep = root === "/" ? "/" : "\\";
  const out: string[] = [];
  for (const part of rest.split(root === "/" ? "/" : SEP)) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return root + out.join(sep);
}

// root 안이면 root 기준 상대 경로 (구분자는 그대로), 밖이면 undefined
export function relativeTo(path: string, root: string, windows = IS_WINDOWS): string | undefined {
  for (const sep of windows ? ["\\", "/"] : ["/"]) {
    const base = root.endsWith(sep) ? root : root + sep;
    if (path.startsWith(base)) return path.slice(base.length) || undefined;
  }
}
