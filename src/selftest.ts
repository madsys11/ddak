// 실제 앱 안에서 도는 자체 테스트. scripts/selftest.sh로 실행한다.
// 테스트용 폴더 구조는 그 스크립트가 만든다.
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Terminal, type ILink } from "@xterm/xterm";
import { devHooks, liveTerms } from "./devHooks";
import type { Groups } from "./useGroups";
import { isTerminalReply } from "./Terminal";
import { fixImeInput } from "./hangul";
import { projectForClick } from "./notifyClick";
import { DIALOG_CAP_MS, PROGRAM_STATUS_REPLY, awaitingUser, dialogOnScreen, parseProgramStatus, readDialog, driveAnswer, sameDialog, AnswerRuns, watchAltLoss, readMode, driveMode, type Dialog, type PermissionMode } from "./programStatus";
import { docPathOf, findLinks, linkProvider } from "./terminalLinks";
import { renderMarkdown, resolveHref } from "./docs";
import { baseName as platformBaseName, dirName as platformDirName, fileUrlPath, keyLabels, normalizePath, relativeTo, trimTrailingSep } from "./platform";
import { MIN_CONTRAST, clipboardKey } from "./Terminal";
import { insertAt } from "./dragPath";
import selftestPlan from "../scripts/selftest-plan.json";
import { gitDecorations, gitSummary } from "./gitStatus";
import { THEMES, isThemeId } from "./themes";
import { LOCALES, isLocale } from "./i18n";
import mobileCss from "./mobile/mobile.css?raw";
import { MessageView, ReadMark, readTarget } from "./mobile/sync";
import { changeKey, confirmed, keyProblem, plan as pushPlan, reconcile, removeComputer } from "./mobile/push";
import { Chat, ComputerList, KeyProblem, ProjectList, Settings as PhoneSettingsView } from "./mobile/MobileApp";
import { locale as phoneLocale, t as phoneT } from "./mobile/i18n";
import { DEFAULT_SETTINGS as DEFAULT_PHONE_SETTINGS, parseSettings as parsePhoneSettings, resolveLocale as resolvePhoneLocale, resolveTheme as resolvePhoneTheme, type PhoneSettings } from "./mobile/settings";
import { API_VERSION as PHONE_API, ApiError as PhoneApiError, api as phoneApi } from "./mobile/api";
import type { Info, PushInfo } from "./mobile/api";
import { en } from "./i18n/en";
import { type PaneSession, commandOf, followSession, fromSaved } from "./workspaceState";
import { screenPixelRatio, setZoomFactor } from "./zoom";
import { MONO_FONT, monoFaces } from "./monoFont";
import { ZOOM_LEVELS } from "./prefs";

const log: string[] = [];
let failed = false;

function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed = true;
  log.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function waitFor<T>(what: string, fn: () => T | undefined | null | false, ms = 10000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`시간 초과: ${what}`);
}

// 깨우기가 사용자 입력 뒤 기다리는 시간 (src-tauri/src/pty.rs WAKE_IDLE)
const WAKE_IDLE_MS = 3000;

// waitFor의 비동기판 (Rust 명령으로 확인할 때)
async function waitAsync<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 10000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`시간 초과: ${what}`);
}

// 화면 폭 때문에 줄바꿈된 줄은 한 줄로 합친다.
function screen(term: Terminal) {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)!;
    if (line.isWrapped && lines.length) lines[lines.length - 1] += line.translateToString(true);
    else lines.push(line.translateToString(true));
  }
  return lines;
}

const fileRows = () => [...document.querySelectorAll<HTMLElement>(".tree-row:not(.project-row):not(.tree-input-row)")];
// 이름을 바꾸는 중인 행은 이름 대신 입력란이 있다 (이름 없음으로 센다)
const rowName = (el: Element) => el.querySelector(".tree-name")?.textContent ?? "";
const rowNames = () => fileRows().map(rowName);
const fileRow = (name: string) => fileRows().find((el) => rowName(el) === name);
const projectRows = () => [...document.querySelectorAll<HTMLElement>(".project-row")];
const projectRow = (path: string) => projectRows().find((el) => el.dataset.project === path);
const tabsIn = (path: string) => document.querySelectorAll(`.project-workspace[data-project="${CSS.escape(path)}"] .tab`).length;
type Store = { projects: { path: string }[]; active: string | null };
const loadStore = () => invoke<Store>("projects_load");
// 목록 저장은 화면이 바뀐 뒤 효과에서 일어나므로 조건이 맞을 때까지 다시 읽는다.
async function waitStore(ok: (s: Store) => boolean, ms = 3000) {
  const end = Date.now() + ms;
  let s = await loadStore();
  while (!ok(s) && Date.now() < end) {
    await sleep(100);
    s = await loadStore();
  }
  return s;
}

// 목록이 빈 상태에서 시작해 테스트용 폴더를 프로젝트로 추가한다.
async function testProjectStart(root: string) {
  await waitFor("빈 목록 화면", () => document.querySelector(".empty-box"));
  check("프로젝트: 목록이 비어 있으면 추가 화면", true);
  check("프로젝트: 저장된 목록도 비어 있음", (await loadStore()).projects.length === 0);

  const missing = root.replace(/\/proj$/, "/nope");
  await devHooks.addProject!(missing);
  const err = await waitFor("없는 폴더 오류", () => document.querySelector(".sidebar-error")?.textContent);
  check("프로젝트: 없는 폴더는 추가되지 않고 오류 표시", err.includes(missing) && !!document.querySelector(".empty-box"), err);

  await devHooks.addProject!(root + "/"); // 끝의 /는 떼고 저장해야 한다
  const row = await waitFor("프로젝트 행", () => projectRow(root));
  check("프로젝트: 추가하면 목록에 나오고 활성", row.classList.contains("active") && row.querySelector(".tree-name")?.textContent === "proj");
  check("프로젝트: 프로젝트 아이콘", !!row.querySelector("svg.icon-project"));
  check("프로젝트: 오류 표시가 사라짐", !document.querySelector(".sidebar-error"));
  const store = await waitStore((s) => s.projects.length === 1);
  check("프로젝트: 앱 데이터에 저장", store.projects[0]?.path === root && store.active === root, JSON.stringify(store));
}

async function testTree() {
  const names = await waitFor("트리 표시", () => rowNames().length > 0 && rowNames());
  check("트리: 폴더 먼저, 대소문자 무시 정렬", names.join(",") === "A_dir,b_dir,server,web,a.txt,z.txt", names.join(","));
  check("트리: 저장소 아이콘", fileRow("server")?.dataset.git === "repo" && !!fileRow("server")?.querySelector("svg.icon-repo"));
  check("트리: worktree 아이콘", fileRow("web")?.dataset.git === "worktree" && !!fileRow("web")?.querySelector("svg.icon-worktree"));
  check("트리: 일반 폴더는 아이콘 없음 (화살표만)", !fileRow("A_dir")?.querySelector("svg:not(.icon-chevron)"));
  const chevron = () => fileRow("A_dir")!.querySelector(".tree-twisty svg.icon-chevron")!;
  const angle = () => {
    const m = new DOMMatrix(getComputedStyle(chevron()).transform);
    return Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI);
  };
  check("트리: 접힌 폴더는 오른쪽 화살표", angle() === 0 && fileRow("A_dir")!.querySelector(".tree-twisty")!.getAttribute("data-open") === "false", `${angle()}`);
  check("트리: 파일은 화살표 없음", !fileRow("a.txt")?.querySelector(".tree-twisty svg"));

  const aDir = fileRow("A_dir")!;
  aDir.click();
  const opened = await waitFor("폴더 펼치기", () => rowNames().includes("inner.txt") && rowNames());
  check("트리: 클릭하면 펼쳐짐", opened.indexOf("inner.txt") === opened.indexOf("A_dir") + 1, opened.join(","));
  // 회전은 0.12초 애니메이션이라 끝날 때까지 기다린다
  await waitFor("화살표 회전", () => angle() === 90, 3000).then(
    () => check("트리: 펼치면 화살표가 아래로 (90° 회전)", true),
    () => check("트리: 펼치면 화살표가 아래로 (90° 회전)", false, `${angle()}`),
  );
  aDir.click();
  await waitFor("폴더 접기", () => !rowNames().includes("inner.txt"));
  check("트리: 다시 클릭하면 접힘", true);
}

// 파일 트리의 git 표시 (src/gitStatus.ts, git.rs git_status): 저장소를 펼치면 파일은 글자(M 수정, A 스테이징, U 추적 안 함),
// 바뀐 것이 든 폴더는 점. 저장소 행은 접혀 있어도 자기 저장소에 바뀐 것이 있으면 점. 추적 안 하는 폴더 안은 무시한 파일만 빼고 U. 내용만 바뀐 것(폴더 감시에 안 잡힘)과 커밋도 몇 초 안에
// 반영된다. 분해형(NFD) 한글 이름도 git의 합성형 경로와 맞춘다. 펼쳐 둔 폴더에서 git init 하면 표시가 생긴다.
async function testTreeGit(term: Terminal) {
  const ident = "-c user.name=t -c user.email=t@example.com";
  // 분해형 "한" (맥 파일 시스템은 만든 그대로 둔다)
  const nfd = "\u1112\u1161\u11AB";
  await run(term, `git init -q gst && cd gst && mkdir lib && echo a > mod.txt && echo l > lib/x.txt && echo k > keep.txt && printf '*.log\\n' > .gitignore && git add . && git ${ident} commit -qm base; cd ..`);
  await run(term, `cd gst && N=$(printf '\\341\\204\\222\\341\\205\\241\\341\\206\\253') && mkdir "$N" && echo h > "$N/in.txt" && git add . && git ${ident} commit -qm nfd && echo m >> "$N/in.txt" && touch "$N.txt"; cd ..`);
  await run(term, "cd gst && echo m >> mod.txt && echo m >> lib/x.txt && echo s > staged.txt && git add staged.txt && mkdir -p fresh/deep && touch fresh/deep/f fresh/debug.log loose.txt; cd ..");
  const status = (name: string) => {
    const row = fileRow(name);
    return row ? `${row.dataset.gitStatus ?? "-"}${row.querySelector(".tree-git")?.textContent ?? ""}${row.querySelector(".tree-name.git-modified") ? "~" : ""}` : "없음";
  };
  const all = (names: string[]) => names.map((n) => `${n}=${status(n)}`).join(" ");
  await waitFor("저장소 표시", () => fileRow("gst")?.dataset.git === "repo", 3000);
  // 접힌 저장소 행: 안에 수정·스테이징·추적 안 함이 있으면 가장 눈에 띌 것(수정)의 점
  await waitFor("접힌 저장소 행의 점", () => status("gst") === "M•~", 3000).catch(() => {});
  check("파일 트리 git: 접힌 저장소 행도 자기 저장소에 바뀐 것이 있으면 점 (수정 색)", status("gst") === "M•~", status("gst"));
  fileRow("gst")!.click();
  const names = ["gst", "fresh", "lib", nfd, "keep.txt", "loose.txt", "mod.txt", "staged.txt", `${nfd}.txt`];
  const want = `gst=M•~ fresh=U• lib=M•~ ${nfd}=M•~ keep.txt=- loose.txt=UU mod.txt=MM~ staged.txt=AA ${nfd}.txt=UU`;
  await waitFor("git 표시", () => all(names) === want, 5000).catch(() => {});
  check("파일 트리 git: 수정 M·스테이징 A·추적 안 함 U, 바뀐 것이 든 폴더와 저장소 행은 점, 분해형 한글 이름도", all(names) === want, all(names));
  fileRow(nfd)!.click();
  await waitFor("분해형 폴더 안", () => status("in.txt") === "MM~", 3000).catch(() => {});
  check("파일 트리 git: 분해형 한글 폴더 안의 수정도 M", status("in.txt") === "MM~", status("in.txt"));
  fileRow("fresh")!.click();
  await waitFor("추적 안 하는 폴더 안", () => status("deep") === "U•" && status("debug.log") === "-", 3000).catch(() => {});
  check("파일 트리 git: 추적 안 하는 폴더 안도 U, 그 안의 무시한 파일은 표시 없음", status("deep") === "U•" && status("debug.log") === "-", all(["deep", "debug.log"]));
  await run(term, "echo k >> gst/keep.txt");
  await waitFor("내용만 바뀜", () => status("keep.txt") === "MM~", 3000 + 3000).catch(() => {});
  check("파일 트리 git: 내용만 바뀐 파일도 몇 초 안에 M", status("keep.txt") === "MM~", status("keep.txt"));
  await run(term, `git -C gst add -A && git -C gst ${ident} commit -qm all`);
  const clean = names.map((n) => `${n}=-`).join(" ");
  await waitFor("커밋 뒤", () => all(names) === clean, 3000 + 3000).catch(() => {});
  check("파일 트리 git: 커밋하면 표시가 사라짐", all(names) === clean, all(names));
  fileRow("gst")!.click();
  await waitFor("접기", () => !fileRow("mod.txt"));
  await run(term, "rm -rf gst && mkdir gnew && touch gnew/one.txt");

  // 저장소가 아닌 폴더를 펼쳐 둔 채 git init
  await waitFor("새 폴더", () => fileRow("gnew"), 3000);
  fileRow("gnew")!.click();
  await waitFor("새 폴더 펼침", () => fileRow("one.txt"), 3000);
  check("파일 트리 git: 저장소가 아닌 폴더는 표시 없음", status("one.txt") === "-", status("one.txt"));
  await run(term, "git init -q gnew");
  await waitFor("git init 뒤", () => status("one.txt") === "UU", 3000 + 3000).catch(() => {});
  check("파일 트리 git: 펼쳐 둔 폴더에서 git init 하면 표시가 생김", status("one.txt") === "UU", status("one.txt"));
  fileRow("gnew")!.click();
  await waitFor("접기", () => !fileRow("one.txt"));
  await run(term, "rm -rf gnew");
  await waitFor("지움", () => !fileRow("gnew"), 3000);

  // 정규형: 맥은 합성형·분해형을 같은 이름으로, Windows는 다른 이름으로 (리뷰 R3)
  const nfc = nfd.normalize("NFC");
  const mac = gitDecorations("", [[`${nfc}/a.txt`, "M"], [`${nfc}.txt`, "U"]], false);
  const win = gitDecorations("", [[`${nfc}/a.txt`, "M"], [`${nfc}.txt`, "U"]], true);
  const inside = gitDecorations(`${nfd}/`, [[`${nfc}/a.txt`, "M"]], false);
  check(
    "파일 트리 git: 맥은 NFC 경로와 NFD 이름·위치를 맞추고, Windows는 정규형이 다른 이름을 합치지 않음",
    mac(nfd) === "M" && mac(`${nfd}.txt`) === "U" && inside("a.txt") === "M" && win(nfd) === undefined && win(nfc) === "M",
    `${mac(nfd)} ${mac(`${nfd}.txt`)} ${inside("a.txt")} ${win(nfd)} ${win(nfc)}`,
  );
  // 저장소 행 (gitSummary): 충돌 > 수정·삭제·이름 바뀜(M) > 추가·추적 안 함, 위치 아래만
  const sums = [
    gitSummary("", [["a", "U"], ["b/c", "D"]]),
    gitSummary("", [["a", "R"], ["x/", "U"], ["b", "!"]]),
    gitSummary("", [["x/", "U"]]),
    gitSummary("sub/", [["a", "M"], ["sub/b", "A"]]),
    gitSummary("", []),
  ].join(",");
  check("파일 트리 git: 저장소 행의 점은 가장 눈에 띌 것 (충돌 > 수정 > 추가·추적 안 함)", sums === "M,!,U,A,", sums);
}

// 명령을 보내고 앞뒤에 찍은 표시 사이의 출력을 돌려준다.
// 입력 줄에는 표시가 따옴표로 쪼개져 있어서 출력 줄과 구분된다.
async function run(term: Terminal, cmd: string, ms = 10000) {
  // 셸이 줄 편집기로 돌아오기 전에 친 입력은 tty가 줄 단위로 받는데, macOS는 한 줄에 MAX_CANON(1024) 바이트까지만
  // 받고 나머지를 버린다 (앞 명령 직후에 보낸 긴 명령이 잘려 끝나지 않았다). 길면 바로 실패로 알린다.
  const bytes = new TextEncoder().encode(cmd).length;
  if (bytes > 900) throw new Error(`명령이 너무 김 (${bytes}바이트, tty 한 줄은 1024바이트까지): ${cmd.slice(0, 80)}…`);
  const tag = Math.random().toString(36).slice(2, 8);
  const [begin, end] = [`DDAKB${tag}`, `DDAKE${tag}`];
  const mark = (t: string) => `echo "${t.slice(0, 5)}""${t.slice(5)}"`;
  term.input(`${mark(begin)}; ${cmd}; ${mark(end)}\r`);
  const lines = await waitFor(`명령 완료: ${cmd}`, () => {
    const s = screen(term);
    return s.some((l) => l.trim() === end) && s;
  }, ms).catch((e) => {
    // 시간 초과면 그때 화면 끝부분을 같이 남긴다 (무엇에 걸렸는지 보이게)
    throw new Error(`${e} | 화면: ${screen(term).filter((l) => l.trim()).slice(-8).join(" ⏎ ")}`);
  });
  return lines.slice(lines.findIndex((l) => l.trim() === begin) + 1, lines.findIndex((l) => l.trim() === end));
}

// 터미널 입력란에 키를 보내고 그 동안 터미널로 나간 입력을 돌려준다.
// xterm은 키를 keyCode로 가린다. 합성 이벤트는 keyCode가 0이라 실제 브라우저처럼 채워 준다.
const KEY_CODES: Record<string, number> = { Enter: 13, Backspace: 8 };
function keySends(term: Terminal, init: KeyboardEventInit) {
  const got: string[] = [];
  const d = term.onData((x) => got.push(x));
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(ev, "keyCode", { get: () => KEY_CODES[init.key ?? ""] ?? 0 });
  term.textarea!.dispatchEvent(ev);
  d.dispose();
  return got.join("");
}

// 지금 보이는 탭의 터미널들. 화면에 놓인 순서(위→아래, 왼→오른)대로.
// 방금 만든 창은 xterm이 등록되기 전일 수 있어 등록된 것만 센다 (안 그러면 term이 비어 있는 창을 집는다).
function visiblePanes() {
  return [...document.querySelectorAll<HTMLElement>(".pane")]
    .filter((el) => el.offsetParent !== null)
    .map((el) => ({ el, rect: el.getBoundingClientRect(), term: liveTerms.get(el.querySelector(".terminal")!)! }))
    .filter((p) => p.term)
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
}
// 창 이름 줄의 글 (오른쪽 끝 단추 ↻·×는 빼고). 이름 줄이 없으면 undefined
const paneLabel = (pane: Element) => {
  const label = pane.querySelector(".pane-label");
  return label ? [...label.childNodes].filter((n) => !(n instanceof Element && n.classList.contains("pane-actions"))).map((n) => n.textContent).join("") : undefined;
};
// 터미널이 없는 창(작업그룹 준비를 기다리는 세션)까지 포함한 보이는 창
const paneEls = () => [...document.querySelectorAll<HTMLElement>(".pane")].filter((el) => el.offsetParent !== null);
const setupStatus = (pane: HTMLElement) => pane.querySelector<HTMLElement>("[data-setup-status]")?.dataset.setupStatus;
const activeTabEl = () => document.querySelector<HTMLElement>(".project-workspace:not([style*='none']) .tab.active");
const tabCount = () => document.querySelectorAll(".tab").length;
const activeTabIndex = () => [...document.querySelectorAll(".tab")].findIndex((el) => el.classList.contains("active"));
const menu = (id: string) => emit("menu", id);
const key = (k: string, code: string, shift = false) =>
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, metaKey: true, shiftKey: shift, bubbles: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 앱 창이 포커스를 잃으면 WebKit이 화면 갱신을 늦춘다 (자체 테스트 중 다른 앱을 쓸 때). 그러면 ResizeObserver·
// DOM 렌더러 그리기처럼 화면 갱신에 묶인 것이 늦게 온다. 그런 검사가 실패하면 이 값을 같이 남긴다.
// 화면 갱신(rAF) 한 번을 기다린다. 창이 가려지면 rAF가 멈추므로 ms까지만 기다린다 (끝없이 기다려 단계 제한 시간 300초에
// 걸리고 뒤 단계가 돌지 않았다, 2026-10-25 tabScroll).
async function frameInfo(ms = 3000) {
  const t0 = performance.now();
  const drawn = await Promise.race([new Promise<boolean>((r) => requestAnimationFrame(() => r(true))), sleep(ms).then(() => false)]);
  const raf = drawn ? `${Math.round(performance.now() - t0)}ms` : `>${ms}ms(멈춤)`;
  return `focus=${document.hasFocus()} vis=${document.visibilityState} raf=${raf}`;
}
// 시간 초과면 그때 화면을 같이 남긴다 (간헐 실패의 원인을 보려고)
const ready = (term: Terminal) =>
  waitFor("셸 프롬프트", () => screen(term).some((l) => l.trim() !== ""), 15000).catch((e) => {
    throw new Error(`${e} | 화면 줄 ${term.buffer.active.length}, 커서 ${term.buffer.active.cursorX},${term.buffer.active.cursorY}`);
  });
const near = (a: number, b: number) => Math.abs(a - b) < 0.03;
// 진짜 클릭과 달리 합성 이벤트는 브라우저 기본 동작(포커스 이동)을 하지 않는다.
// 그래서 "기본 동작을 막았는지"(반환값 false)와 "직접 포커스를 옮겼는지"를 따로 본다.
const mouseDown = (el: Element) => !el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
const blur = () => (document.activeElement as HTMLElement | null)?.blur();

// 첫 터미널 (기본 단계 terminalReady): 뒤 단계가 이어 쓰는 터미널이 뜨고 셸이 명령을 받을 때까지 기다린다.
// 터미널 검사는 terminal 단계에 따로 있다 (골라 돌릴 때 매번 돌지 않게).
async function openFirstTerminal() {
  const term = await waitFor("터미널 생성", () => visiblePanes()[0]?.term);
  await ready(term);
  const out = await run(term, "echo READY-$((40+2))");
  if (!out.some((l) => l.trim() === "READY-42")) throw new Error(`첫 터미널이 명령을 받지 않음: ${out.join("|")}`);
  return term;
}

async function testTerminal(root: string, term: Terminal) {
  const pwd = await run(term, "pwd");
  check("터미널: 작업 폴더가 루트", pwd.some((l) => l.trim() === root), pwd.join("|"));

  // 앱이 claude 안에서 떴어도 (scripts/selftest.sh가 표시를 넣는다) 터미널은 claude 세션 표시를 물려받지 않는다.
  // 물려받으면 그 터미널의 claude가 하위 세션으로 보고 대화 기록을 저장하지 않는다. 그 밖의 CLAUDE 변수는 넘긴다.
  // 넘기는 쪽 예는 세션 표시와 접두사가 같은 이름으로 둔다 (리뷰 R1: 접두사로 지우면 사용자 설정도 지웠다). 아무도 읽지 않는
  // 이름이어야 한다 (CLAUDE_CONFIG_DIR 같은 실제 설정이면 claude 검사의 claude가 첫 실행 화면을 띄웠다).
  const env = await run(term, `echo "ENV:[$CLAUDECODE][$CLAUDE_CODE_CHILD_SESSION][$CLAUDE_CODE_DDAK_SELFTEST]"`);
  check(
    "터미널: claude 세션 표시는 물려받지 않고 같은 접두사의 다른 변수는 넘김",
    env.some((l) => l.trim() === "ENV:[][][keep]"),
    env.filter((l) => l.includes("ENV:")).join("|"),
  );

  const korean = await run(term, "echo 한글테스트");
  const row = korean.find((l) => l.includes("한글테스트"));
  check("터미널: 한글 출력", row !== undefined, korean.join("|"));
  // 한글 한 글자가 두 칸을 차지해야 커서 위치가 셸과 맞는다.
  const buf = term.buffer.active;
  let width = -1;
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)!;
    if (line.translateToString(true).trim() === "한글테스트") {
      width = line.getCell(line.translateToString().indexOf("한"))!.getWidth();
    }
  }
  check("터미널: 한글 폭 2칸", width === 2, `width=${width}`);

  // 한글 입력: 실제 앱에서 기록한 WebKit의 이벤트 순서를 그대로 재현한다 (src/hangul.ts).
  // composition 이벤트 없이 첫 자모는 insertText, 이후 조합은 insertReplacementText로 온다.
  // 실제 기록 순서: 키마다 beforeinput/input → keydown(keyCode 229) → keyup. 실제 입력 이벤트는 composed=true.
  // fast: 빠르게 치면 앞 키를 떼기 전에 다음 키를 누른다. 다음 키의 입력이 앞 키의 keydown 바로 뒤에
  // (keyup 없이) 온다: input(ㄱ) → keyup(ㄴ) → keydown(ㄱ).
  const ta = term.textarea!;
  const key = (type: string, k: string, code: number) => {
    const ev = new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true });
    Object.defineProperty(ev, "keyCode", { get: () => code });
    Object.defineProperty(ev, "charCode", { get: () => (type === "keypress" ? code : 0) });
    Object.defineProperty(ev, "which", { get: () => code });
    return ta.dispatchEvent(ev); // false면 취소됨
  };
  // 입력기를 거치지 않는 키 (영문, 스페이스): keydown → keypress → beforeinput/input → keyup.
  // 브라우저처럼 keydown이 취소되면(xterm이 keydown에서 보내고 취소함) keypress·input은 일어나지 않는다.
  const plain = async (text: string) => {
    for (const ch of text) {
      if (key("keydown", ch, ch.toUpperCase().charCodeAt(0)) && key("keypress", ch, ch.charCodeAt(0))) {
        ta.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: ch, bubbles: true, cancelable: true, composed: true }));
        ta.value += ch;
        ta.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: ch, bubbles: true, composed: true }));
      }
      key("keyup", ch, ch.toUpperCase().charCodeAt(0));
      await sleep(20);
    }
  };
  const ime = async (steps: [string, string, string][], fast: boolean) => {
    let held: string | null = null;
    for (const [inputType, data, k] of steps) {
      ta.dispatchEvent(new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true, composed: true }));
      ta.value = inputType === "insertText" ? ta.value + data : ta.value.slice(0, -1) + data;
      ta.dispatchEvent(new InputEvent("input", { inputType, data, bubbles: true, composed: true }));
      if (held) key("keyup", held, 0);
      key("keydown", k, 229);
      held = k;
      if (!fast) {
        key("keyup", k, 0);
        held = null;
      }
      await sleep(fast ? 5 : 30);
    }
    if (held) key("keyup", held, 0);
  };
  const hangul: [string, string, string][] = [
    ["insertText", "ㅎ", "ㅎ"], ["insertReplacementText", "하", "ㅏ"], ["insertReplacementText", "한", "ㄴ"],
    ["insertText", "ㄱ", "ㄱ"], ["insertReplacementText", "그", "ㅡ"], ["insertReplacementText", "글", "ㄹ"],
  ];
  // 입력란이 포커스를 잃으면 xterm이 입력란을 비운다 (CoreBrowserTerminal `_handleTextAreaBlur`). 이 합성 이벤트는 그 뒤에도
  // 앞 글자를 바꾸는 입력을 이어 보내서, 앞 글자를 지우지 못해 "[ㅎ한글]"처럼 된다 (조합 도중 포커스를 빼서 재현:
  // 간헐 실패와 출력·전송 순서가 같았다). 실제 입력기가 포커스 전환 뒤 바꾸기를 이어 보내는지는 확인하지 않았다.
  // 그래서 입력하는 동안 입력란이 포커스를 잃었으면 (다른 앱을 씀 등) 그 시도는 버리고 다시 한다 (최대 3번). 입력 중
  // 포커스를 잃지 않았는데 틀리면 실패로 둔다.
  let blurs = 0;
  const onBlur = () => blurs++;
  ta.addEventListener("blur", onBlur);
  // type: 입력을 친다. 결과 줄은 시도마다 붙이는 표시 + expect
  const typed = async (name: string, type: () => Promise<void>, expect: string) => {
    let detail = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = blurs;
      const tag = `K${attempt}${Math.random().toString(36).slice(2, 6)}`;
      const sent: string[] = [];
      const rec = term.onData((x) => sent.push(x));
      term.input(`echo '${tag}[`, true);
      await type();
      term.input("]'\r", true);
      rec.dispose();
      // 입력을 다 친 바로 그때 정한다. 결과를 기다리는 동안 잃은 포커스는 입력에 영향이 없어서 다시 하는 이유가 아니다
      // (리뷰 P2: 대기 중의 포커스 잃음이 진짜 결함을 가릴 수 있었다)
      const lost = blurs - before;
      const ok = await waitFor(name, () => screen(term).some((l) => l.trim() === `${tag}${expect}`), 5000).then(() => true, () => false);
      const line = screen(term).filter((l) => l.trim().startsWith(tag)).slice(-1)[0]?.trim() ?? "";
      detail = `${line} 보낸 것: ${JSON.stringify(sent).replace(/\x7f/g, "<DEL>")} 입력 중 포커스 잃음 ${lost}회, 창 포커스 ${document.hasFocus()}`;
      if (ok) return check(name, true, attempt > 1 ? `입력 중 포커스를 잃어 ${attempt}번째에 통과` : undefined);
      if (lost === 0) break;
    }
    check(name, false, detail);
  };
  for (const fast of [false, true]) {
    await typed(`터미널: 한글 입력 (WebKit 바꾸기 이벤트로 조합${fast ? ", 빠르게 쳐서 키가 겹침" : ""})`, () => ime(hangul, fast), "[한글]");
  }
  // 실제 앱에서 기록한 "마찬가지로" 빠른 입력 (2026-10-23). 받침이 다음 음절로 넘어갈 때
  // "맟" → 바꾸기 "마" + 새 입력 "차"로 온다. 키를 떼기 전에 다음 입력이 오는 순서도 그대로다.
  // ["i", 글자] = insertText, ["r", 글자] = insertReplacementText, ["d"/"u", 키] = keydown(229)/keyup
  const recorded: [string, string][] = [
    ["i", "ㅁ"], ["d", "ㅁ"], ["u", "ㅁ"], ["r", "마"], ["d", "ㅏ"], ["u", "ㅏ"], ["r", "맟"], ["d", "ㅊ"], ["u", "ㅊ"],
    ["r", "마"], ["i", "차"], ["d", "ㅏ"], ["r", "찬"], ["d", "ㄴ"], ["u", "ㅏ"], ["u", "ㄴ"],
    ["r", "찬"], ["i", "ㄱ"], ["d", "ㄱ"], ["r", "가"], ["d", "ㅏ"], ["u", "ㄱ"], ["u", "ㅏ"],
    ["r", "갖"], ["d", "ㅈ"], ["r", "가"], ["i", "지"], ["d", "ㅣ"], ["u", "ㅈ"],
    ["r", "질"], ["d", "ㄹ"], ["u", "ㅣ"], ["r", "지"], ["i", "로"], ["d", "ㅗ"], ["u", "ㄹ"], ["u", "ㅗ"],
  ];
  await typed(
    "터미널: 실제로 기록한 빠른 한글 입력 재현 (받침이 넘어감)",
    async () => {
      for (const [kind, v] of recorded) {
        if (kind === "d" || kind === "u") key(kind === "d" ? "keydown" : "keyup", v, kind === "d" ? 229 : 0);
        else {
          const inputType = kind === "i" ? "insertText" : "insertReplacementText";
          ta.dispatchEvent(new InputEvent("beforeinput", { inputType, data: v, bubbles: true, cancelable: true, composed: true }));
          ta.value = kind === "i" ? ta.value + v : ta.value.slice(0, -1) + v;
          ta.dispatchEvent(new InputEvent("input", { inputType, data: v, bubbles: true, composed: true }));
        }
        await sleep(5);
      }
    },
    "[마찬가지로]",
  );
  ta.removeEventListener("blur", onBlur);

  // ⌘⌫ → Ctrl+U, ⇧↩ → 세션 구성의 shiftEnter (테스트 설정은 ESC CR). 실제로 보내는 값과 셸에서의 동작을 본다.
  const sentBy = (init: KeyboardEventInit) => keySends(term, init);
  term.input("echo SHOULD_NOT_RUN", true);
  check("터미널: ⌘⌫는 Ctrl+U를 보냄", sentBy({ key: "Backspace", metaKey: true }) === "\x15");
  const killed = await run(term, "echo AFTER_KILL");
  check("터미널: ⌘⌫로 셸 입력줄이 지워짐", killed.some((l) => l.trim() === "AFTER_KILL") && !screen(term).some((l) => l.includes("SHOULD_NOT_RUNecho")), killed.join("|"));
  // 실행됐다면 곧바로 SHIFT_ENTER_1이 출력된다. 줄바꿈이면 다음 Enter 전까지 아무것도 출력되지 않는다.
  const printed = (t: string) => screen(term).some((l) => l.trim() === t);
  term.input("echo SHIFT_ENTER_1", true);
  check("터미널: ⇧↩는 ESC CR을 보냄", sentBy({ key: "Enter", shiftKey: true }) === "\x1b\r");
  await sleep(800);
  const ranEarly = printed("SHIFT_ENTER_1");
  term.input("echo SHIFT_ENTER_2\r", true);
  await waitFor("두 줄 실행", () => printed("SHIFT_ENTER_1") && printed("SHIFT_ENTER_2"), 5000).then(
    () => check("터미널: ⇧↩는 셸에서 실행하지 않고 줄바꿈 (Enter에 두 줄이 함께 실행)", !ranEarly),
    () => check("터미널: ⇧↩는 셸에서 실행하지 않고 줄바꿈 (Enter에 두 줄이 함께 실행)", false, screen(term).slice(-6).join("|")),
  );

  // 영문·스페이스는 xterm이 키 이벤트로 보낸다. 입력란 보정이 한 번 더 보내면 안 된다.
  term.input("echo '[", true);
  await plain("ab ");
  await ime(hangul, true);
  await plain(" c");
  term.input("]'\r", true);
  await waitFor("영문·한글 섞어 입력", () => screen(term).some((l) => l.trim() === "[ab 한글 c]"), 5000).then(
    () => check("터미널: 영문·스페이스·한글을 섞어 쳐도 겹치거나 빠지지 않음", true),
    () => check("터미널: 영문·스페이스·한글을 섞어 쳐도 겹치거나 빠지지 않음", false, screen(term).filter((l) => l.trim().startsWith("[")).slice(-1).join("|")),
  );

  const locale = await run(term, "locale charmap");
  check("터미널: UTF-8 로캘", locale.some((l) => l.trim() === "UTF-8"), locale.join("|"));
  // tty가 지우기로 한글 한 글자를 통째로 지운다 (프롬프트 전·read 입력. src-tauri/src/pty.rs enable_utf8_erase)
  const iutf8 = (await run(term, "stty -a | tr ' ' '\\n' | grep -x -- '-*iutf8'")).map((l) => l.trim());
  check("터미널: tty IUTF8 켜짐", iutf8.includes("iutf8") && !iutf8.includes("-iutf8"), iutf8.join("|"));

  const term256 = await run(term, "echo $TERM");
  check("터미널: TERM=xterm-256color", term256.some((l) => l.trim() === "xterm-256color"), term256.join("|"));

  // 패널 폭을 줄이면 xterm이 맞춰지고 PTY 크기도 따라가야 한다.
  const before = term.cols;
  document.querySelector<HTMLElement>(".panel")!.style.maxWidth = "400px";
  await waitFor("터미널 폭 변경", () => term.cols < before);
  const size = await run(term, "stty size");
  check("터미널: 크기 조절이 PTY에 반영", size.some((l) => l.trim() === `${term.rows} ${term.cols}`), `${size.join("|")} vs ${term.rows} ${term.cols}`);
  document.querySelector<HTMLElement>(".panel")!.style.maxWidth = "";
  await waitFor("터미널 폭 복원", () => term.cols === before);
}

// Claude Code TUI가 뜨는지만 본다. 아무것도 입력하지 않고 바로 끝낸다.
async function testClaude(term: Terminal) {
  const which = await run(term, "command -v claude || echo none");
  if (which.some((l) => l.trim() === "none")) {
    log.push("SKIP  Claude Code: claude 명령 없음");
    return;
  }
  term.input("claude\r");
  try {
    await waitFor("Claude Code 화면", () => screen(term).some((l) => /claude code|trust|welcome/i.test(l)), 30000);
    check("Claude Code: TUI 표시", true);
  } catch (e) {
    check("Claude Code: TUI 표시", false, String(e));
  }
  // 신뢰 확인 화면에서는 Esc, 프롬프트에서는 Ctrl+C 두 번으로 나간다.
  await sleep(1500);
  term.input("\x1b");
  await sleep(500);
  term.input("\x03");
  await sleep(300);
  term.input("\x03");
  await run(term, "true", 15000); // 셸로 돌아왔는지
}

const nativeMenu = () => invoke<string[]>("selftest_menu");
// 네이티브 메뉴 항목을 실제로 실행한다. 체크 항목의 자동 토글까지 진짜 클릭과 같은 경로다.
const clickMenu = (...path: string[]) => invoke("selftest_click_menu", { path });
// 메뉴는 프론트가 Rust에 보내 다시 만들므로 조금 늦게 바뀐다. 조건이 맞을 때까지 기다리고,
// 끝내 안 맞으면 마지막 상태를 돌려줘서 check가 내용을 보여 주게 한다.
async function waitMenu(ok: (m: string[]) => boolean, ms = 5000) {
  const end = Date.now() + ms;
  let m = await nativeMenu();
  while (!ok(m) && Date.now() < end) {
    await sleep(100);
    m = await nativeMenu();
  }
  return m;
}
const newTabTitle = () => document.querySelector<HTMLElement>(".tabbar-btn")!.title;

// 언어·테마 (기본 영어 + 다크, 보기 메뉴로 전환, 네이티브 메뉴에도 반영)
async function testPrefs() {
  for (const [id, { messages }] of Object.entries(LOCALES)) {
    const missing = Object.keys(en).filter((k) => !(messages as Record<string, string>)[k]);
    check(`언어: ${id} 사전에 빠진 문구 없음`, missing.length === 0, missing.join(","));
  }
  check("언어: 기본은 영어", document.documentElement.lang === "en" && newTabTitle() === "New Tab (⌘T)", newTabTitle());
  check("테마: 기본은 다크", document.documentElement.dataset.theme === "dark");

  const enMenu = await waitMenu((m) => m.includes("View/"));
  check(
    "메뉴: 영어 문구와 현재 선택 표시",
    ["Edit/Copy", "Terminal/Close Terminal", "Window/Close Window", "View/Theme/Dark [x]", "View/Language/English [x]"].every((x) => enMenu.includes(x)),
    enMenu.filter((x) => x.startsWith("View/")).join(", "),
  );
  // 사전에 문구가 없으면 Rust가 id를 그대로 띄운다
  const ids = Object.keys(en).filter((k) => k.startsWith("menu.")).map((k) => k.slice(5));
  const raw = enMenu.filter((x) => ids.includes(x.split("/").filter(Boolean).pop()!));
  check("메뉴: 번역 안 된 항목 없음", raw.length === 0, raw.join(", "));

  // 이미 선택된 항목을 다시 누르면 muda가 체크를 끈다. 프론트가 다시 맞춰야 한다 (리뷰 지적).
  await clickMenu("View", "Theme", "Dark");
  await clickMenu("View", "Language", "English");
  const again = await waitMenu((m) => m.includes("View/Theme/Dark [x]") && m.includes("View/Language/English [x]"));
  check(
    "메뉴: 선택된 테마·언어를 다시 눌러도 체크 유지",
    again.includes("View/Theme/Dark [x]") && again.includes("View/Language/English [x]"),
    again.filter((x) => x.startsWith("View/") && !x.endsWith("/")).join(", "),
  );
  check("메뉴: 다시 눌러도 값은 그대로", document.documentElement.lang === "en" && document.documentElement.dataset.theme === "dark");

  await clickMenu("View", "Language", "한국어");
  await waitFor("한국어 전환", () => document.documentElement.lang === "ko");
  check("언어: 보기 메뉴로 한국어 전환", newTabTitle() === "새 탭 (⌘T)", newTabTitle());
  const koMenu = await waitMenu((m) => m.includes("보기/언어/한국어 [x]"));
  check(
    "메뉴: 한국어로 다시 만들어지고 선택이 옮겨짐",
    koMenu.includes("편집/복사하기") && koMenu.includes("보기/언어/한국어 [x]") && koMenu.includes("보기/언어/English"),
    koMenu.filter((x) => x.startsWith("보기/")).join(", "),
  );

  await clickMenu("보기", "테마", "Solarized Light");
  await waitFor("테마 전환", () => document.documentElement.dataset.theme === "solarized-light");
  const bg = (sel: string) => getComputedStyle(document.querySelector(sel)!).backgroundColor;
  check(
    "테마: Solarized Light 화면·사이드바 색",
    bg("html") === "rgb(253, 246, 227)" && bg(".sidebar") === "rgb(238, 232, 213)",
    `${bg("html")} / ${bg(".sidebar")}`,
  );
  const terms = [...liveTerms.values()];
  // 터미널 색은 React 효과에서 바뀌어서 화면 테마 값보다 조금 늦다
  const termBg = (bg: string) => terms.length > 0 && terms.every((tm) => tm.options.theme?.background === bg);
  await waitFor("터미널 색", () => termBg("#FDF6E3"), 3000).catch(() => {});
  check("테마: 열린 터미널 색도 바뀜", termBg("#FDF6E3"));
  check("테마: 터미널 빈 공간(viewport)도 테마 배경색", bg(".xterm-viewport") === "rgb(253, 246, 227)", bg(".xterm-viewport"));
  // 누른 항목은 muda가 바로 체크하지만, 이전 선택(다크)의 체크는 프론트가 메뉴를 다시 만들어야 풀린다
  const sMenu = await waitMenu((m) => m.includes("보기/테마/Solarized Light [x]") && m.includes("보기/테마/다크"));
  check("메뉴: 테마 선택 표시", sMenu.includes("보기/테마/Solarized Light [x]") && sMenu.includes("보기/테마/다크"));
  check("설정: 언어·테마 저장", localStorage.getItem("ddak.locale") === "ko" && localStorage.getItem("ddak.theme") === "solarized-light");

  await clickMenu("보기", "테마", "Solarized Light");
  const againKo = await waitMenu((m) => m.includes("보기/테마/Solarized Light [x]"));
  check("메뉴: 한국어 메뉴에서도 다시 눌러 체크 유지", againKo.includes("보기/테마/Solarized Light [x]"));

  await clickMenu("보기", "언어", "English");
  await waitMenu((m) => m.includes("View/")); // 메뉴가 영어로 다시 만들어진 뒤에 누른다
  await clickMenu("View", "Theme", "Light");
  await waitFor("라이트 테마", () => document.documentElement.dataset.theme === "light");
  await waitFor("터미널 라이트", () => termBg("#FFFFFF"), 3000).catch(() => {});
  const lMenu = await waitMenu((m) => m.includes("View/Theme/Light [x]"));
  check(
    "테마: Light(VS Code Light Modern) 화면·사이드바·터미널 색과 메뉴 체크",
    bg("html") === "rgb(255, 255, 255)" && bg(".sidebar") === "rgb(248, 248, 248)" && termBg("#FFFFFF") && lMenu.includes("View/Theme/Light [x]") && !lMenu.includes("View/Theme/Solarized Light [x]"),
    `${bg("html")} / ${bg(".sidebar")} / ${lMenu.filter((x) => x.startsWith("View/Theme/")).join(", ")}`,
  );
  await clickMenu("View", "Theme", "Dark");
  await waitFor("기본값 복귀", () => document.documentElement.lang === "en" && document.documentElement.dataset.theme === "dark");
  await waitFor("터미널 다크", () => termBg("#1F1F1F"), 3000).catch(() => {});
  check("테마: 다크로 돌아오면 터미널도 다크", termBg("#1F1F1F"));
}

// 알림 소리 (앱 메뉴 "알림 소리", src/prefs.tsx NOTIFY_SOUNDS, src-tauri/src/notify.rs): 기본은 Glass. 고르면 저장하고 Rust의
// 알림 소리가 바뀌며, 그 소리로 시험 알림을 보낸다 (같은 것을 다시 골라도). 실제 소리는 설치한 앱에서만 난다.
async function testNotifySound() {
  const notes = () => invoke<[[string, string][], number, string | null]>("selftest_notifications");
  const soundMenu = (m: string[]) => m.filter((x) => x.startsWith("ddak/Notification Sound/") && !x.endsWith("/"));
  const first = await waitMenu((m) => soundMenu(m).length > 0);
  const [, , initial] = await notes();
  check(
    "알림 소리: 앱 메뉴에 기본 + 시스템 소리 14개, 처음엔 Glass",
    soundMenu(first).length === 15 && first.includes("ddak/Notification Sound/macOS Default") && first.includes("ddak/Notification Sound/Glass [x]") && initial === "Glass",
    `${initial} | ${soundMenu(first).join(", ")}`,
  );
  await clickMenu("ddak", "Notification Sound", "Hero");
  const picked = await waitMenu((m) => m.includes("ddak/Notification Sound/Hero [x]") && m.includes("ddak/Notification Sound/Glass"));
  const [sent, , sound] = await notes();
  check(
    "알림 소리: 고르면 저장·체크가 옮겨지고 그 소리로 시험 알림",
    picked.includes("ddak/Notification Sound/Hero [x]") && !picked.includes("ddak/Notification Sound/Glass [x]") && localStorage.getItem("ddak.notifySound") === "Hero" &&
      sound === "Hero" && sent.some(([t, b]) => t === "ddak" && b === "Notification sound: Hero"),
    `${sound} ${localStorage.getItem("ddak.notifySound")} ${JSON.stringify(sent)} | ${soundMenu(picked).filter((x) => x.endsWith("[x]")).join(", ")}`,
  );
  // 이미 고른 것을 다시 누르면 muda가 체크를 끈다. 프론트가 다시 맞추고, 시험 알림은 또 보낸다
  await clickMenu("ddak", "Notification Sound", "Hero");
  const again = await waitMenu((m) => m.includes("ddak/Notification Sound/Hero [x]"));
  const [sentAgain] = await notes();
  check("알림 소리: 다시 골라도 체크 유지, 시험 알림 다시", again.includes("ddak/Notification Sound/Hero [x]") && sentAgain.length === 1, JSON.stringify(sentAgain));
  await clickMenu("ddak", "Notification Sound", "macOS Default");
  await waitMenu((m) => m.includes("ddak/Notification Sound/macOS Default [x]"));
  const [sentDefault, , def] = await notes();
  check("알림 소리: macOS 기본", def === "default" && sentDefault.some(([, b]) => b === "Notification sound: macOS Default"), `${def} ${JSON.stringify(sentDefault)}`);
  await clickMenu("ddak", "Notification Sound", "Glass");
  await waitMenu((m) => m.includes("ddak/Notification Sound/Glass [x]"));
  await notes();
}

// 폰 채팅이 보이는 메시지 (src/mobile/sync.ts): 서버에 재생이 없어서 처음·다시 이어짐·지움 때 최신 페이지로 바꾼다.
// 리뷰 R2(첫 조회와 SSE hello가 겹쳐 more를 잃음)·R3(끊긴 동안 50개 넘게 생기면 가운데가 빠짐, 지운 것이 남음) 순서를 그대로 돌린다.
function testMobileSyncUnit() {
  const msg = (id: number) => ({ id, time: 0, from: "user", text: `m${id}`, to: [] });
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => msg(a + i));
  const ids = (v: MessageView) => `${v.messages[0]?.id ?? "-"}..${v.messages.at(-1)?.id ?? "-"}(${v.messages.length}) more=${v.more}`;

  // R2: 처음 조회 중에 hello가 다시 조회 → 첫 응답은 늦은 것으로 버리고, 둘째 응답이 more까지 정한다 (어느 순서로 와도)
  for (const order of ["first-then-second", "second-then-first"]) {
    const v = new MessageView();
    const first = v.begin();
    const second = v.begin();
    const answers: [number, boolean][] = order === "first-then-second" ? [[first, false], [second, true]] : [[second, true], [first, false]];
    const used = answers.map(([load]) => v.latest(load, range(11, 60), true));
    check(`폰 채팅: 겹친 조회는 마지막 것만 쓰고 이전 메시지 버튼을 지킴 (${order})`, used.join(",") === answers.map(([, u]) => u).join(",") && ids(v) === "11..60(50) more=true", `${used} ${ids(v)}`);
  }
  // R3a: 1~10을 본 뒤 끊긴 동안 11~70이 생김 → 다시 이으면 최신 50개(21~70)와 이전 버튼, 이전을 읽으면 1~20이 빠짐 없이
  const a = new MessageView();
  a.latest(a.begin(), range(1, 10), false);
  a.latest(a.begin(), range(21, 70), true);
  const { before, gen } = a.older();
  a.earlier(gen, range(1, 20), false);
  const continuous = a.messages.every((m, i) => m.id === i + 1);
  check("폰 채팅: 끊긴 동안 많이 생겨도 다시 이으면 가운데가 빠지지 않음", before === 21 && continuous && ids(a) === "1..70(70) more=false", `${before} ${ids(a)}`);
  // R3b: 끊긴 동안 맥에서 대화를 지우고 새 11번만 남음 → 다시 이으면 지운 것은 사라짐
  const b = new MessageView();
  b.latest(b.begin(), range(1, 10), false);
  b.latest(b.begin(), [msg(11)], false);
  check("폰 채팅: 끊긴 동안 지운 대화는 다시 이으면 사라짐", ids(b) === "11..11(1) more=false", ids(b));
  // 조회를 보낸 뒤 SSE로 온 메시지는 응답에 없어도 남는다
  const c = new MessageView();
  const loading = c.begin();
  c.event(msg(61));
  c.latest(loading, range(11, 60), true);
  check("폰 채팅: 조회 중에 온 새 메시지를 잃지 않음", ids(c) === "11..61(51) more=true", ids(c));
  // 이전 페이지를 읽는 사이 최신으로 바뀌었으면 그 응답은 붙이지 않는다 (사이가 빈다)
  const d = new MessageView();
  d.latest(d.begin(), range(51, 100), true);
  const old = d.older();
  d.latest(d.begin(), range(81, 130), true);
  const stale = d.earlier(old.gen, range(1, 50), false);
  check("폰 채팅: 늦게 온 이전 페이지는 바뀐 목록에 붙이지 않음", !stale && ids(d) === "81..130(50) more=true", `${stale} ${ids(d)}`);
  // 반대 순서 (재리뷰 R3): 최신 조회를 기다리는 동안에는 이전 페이지를 읽지 않는다. 읽었더라도 붙이지 않는다.
  const e = new MessageView();
  e.latest(e.begin(), range(51, 100), true);
  const reload = e.begin();
  const during = e.older();
  e.latest(reload, range(151, 200), true);
  const late = e.earlier(during.gen, range(1, 50), false);
  check("폰 채팅: 최신 조회를 기다리는 동안 누른 이전 메시지는 읽지도 붙이지도 않음", during.before === undefined && !late && ids(e) === "151..200(50) more=true", `${during.before} ${late} ${ids(e)}`);
  // 재리뷰 R6: 최신 조회가 실패하면 기다림을 풀어 이전 메시지를 다시 읽을 수 있다. 앞선 조회의 실패는 뒤 조회의 기다림을 풀지 않는다.
  const f = new MessageView();
  f.latest(f.begin(), range(51, 100), true);
  const failed = f.begin();
  f.fail(failed);
  const afterFail = f.older().before;
  const first = f.begin();
  const second = f.begin();
  f.fail(first);
  const stillWaiting = f.older().before;
  f.latest(second, range(101, 150), true);
  check("폰 채팅: 최신 조회가 실패해도 이전 메시지를 읽을 수 있음 (늦은 실패는 새 조회를 풀지 않음)", afterFail === 51 && stillWaiting === undefined && ids(f) === "101..150(50) more=true", `${afterFail} ${stillWaiting} ${ids(f)}`);

  // 폰 알림 구독 맞추기 (src/mobile/push.ts plan): 맥이 가진 것과 같으면 그대로, 다르면 보냄, 푸시 서비스가 없앤 구독이면 새로
  const plans = [
    pushPlan("a", { endpoint: "a", gone: null }),
    pushPlan("a", { endpoint: null, gone: null }),
    pushPlan("a", { endpoint: "old", gone: null }),
    pushPlan("a", { endpoint: null, gone: "a" }),
    pushPlan("a", { endpoint: null, gone: "old" }),
    pushPlan(null, { endpoint: "a", gone: null }),
    pushPlan("a", undefined),
  ].join(",");
  check("폰 알림: 구독 맞추기 (같음·없음·다름·없어짐·예전 것이 없어짐·폰에 없음·푸시를 모르는 ddak)", plans === "none,send,send,renew,send,none,none", plans);

  // 3단계 리뷰 R1·R2: 읽음은 최신 조회가 성공해 서버와 맞춘 뒤, 화면이 보이고 맨 아래를 볼 때만
  const r = new MessageView();
  const reloading = r.begin();
  r.event(msg(101));
  const beforeSync = readTarget(r, true, true);
  r.fail(reloading);
  const afterFailed = readTarget(r, true, true);
  r.latest(r.begin(), range(52, 101), true);
  const synced = readTarget(r, true, true);
  r.event(msg(102));
  const readTargets = [beforeSync, afterFailed, synced, readTarget(r, true, true), readTarget(r, true, false), readTarget(r, false, true)].join(",");
  check("폰 채팅: 읽음은 서버와 맞춘 뒤 화면이 보이고 맨 아래를 볼 때만 (조회 중·실패·위쪽·숨김이면 0)", readTargets === "0,0,101,102,0,0", readTargets);
}

// 폰 채팅 화면의 읽음 (src/mobile/MobileApp.tsx Chat): 실제 화면을 iframe에 그리고 맥 API만 대역으로 바꾼다. 위로 올려 읽다가
// 보내면 맨 아래로 가서 최신을 보게 되므로 읽음을 알린다 (3단계 재리뷰 R4: 스크롤로 내려온 것이 아니라 알리지 않았다)
async function testMobileChatUnit() {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:400px;height:400px";
  document.body.appendChild(frame);
  const vars = Object.entries(THEMES.dark.ui).map(([k, v]) => `${k}:${v}`).join(";");
  const loaded = new Promise((r) => (frame.onload = r));
  frame.srcdoc = `<style>:root{${vars}}${mobileCss}</style><div id="root"></div>`;
  await loaded;
  const doc = frame.contentDocument!;
  const saved = { ...phoneApi };
  const reads: number[] = [];
  const modeSets: string[] = [];
  const message = (id: number) => ({ id, time: 0, from: id % 2 ? "origin/dev" : "user", text: `m${id}`, to: ["user"] });
  Object.assign(phoneApi, {
    info: async () => ({ id: "c", name: "Mac", version: "", api: PHONE_API }),
    messages: async () => ({ name: "proj", messages: Array.from({ length: 100 }, (_, i) => message(i + 1)), more: false }),
    members: async () => ({ members: ["user", "origin/dev", "origin/rev"], waiting: [], paused: [], modes: { "origin/dev": "auto" }, open: true }),
    read: async (_c: unknown, _p: unknown, id: number) => void reads.push(id),
    post: async (_c: unknown, _p: unknown, text: string) => ({ id: 102, time: 0, from: "user", text, to: ["origin/dev"] }),
    setMode: async (_c: unknown, _p: unknown, member: string, mode: string) => {
      modeSets.push(`${member}:${mode}`);
      if (modeSets.length === 1) throw new PhoneApiError(409, "awaiting");
      if (modeSets.length === 2) throw new PhoneApiError(409, "bypass");
    },
  });
  const root = createRoot(doc.getElementById("root")!);
  try {
    root.render(createElement(Chat, { computer: { id: "c", name: "Mac", api: "http://127.0.0.1:9", token: "t" }, project: "p" }));
    await waitFor("처음 읽음", () => reads.length > 0, 5000).catch(() => null);
    const first = reads.join(",");
    // 위쪽을 본다 (스크롤 이벤트로 맨 아래가 아니게)
    const list = await waitFor("메시지 목록", () => doc.querySelector<HTMLElement>(".messages"), 3000);
    list.scrollTop = 0;
    list.dispatchEvent(new Event("scroll"));
    await sleep(100);
    const input = doc.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    Object.getOwnPropertyDescriptor((frame.contentWindow as unknown as typeof globalThis).HTMLTextAreaElement.prototype, "value")!.set!.call(input, "@origin/dev hi");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(50);
    doc.querySelector<HTMLElement>(".composer button.primary")!.click();
    await waitFor("보낸 뒤 읽음", () => reads.length > 1, 3000).catch(() => null);
    check("폰 채팅: 위쪽을 보다가 보내면 맨 아래로 가며 읽음을 알림 (처음 읽음 100, 보낸 뒤 102)", first === "100" && reads.join(",") === "100,102", `${first} / ${reads}`);

    // 권한 모드 (src/ModePicker.tsx): 모드를 읽은 참여자만 칩 옆에 모드, 누르면 고르는 창 (지금 모드는 못 누름). 맥이 거절하면
    // 이유를 보이고 다시 고를 수 있고, 받으면 닫힌다
    const modeChip = doc.querySelector<HTMLElement>("[data-mode-of='origin/dev']");
    const onlyDev = !!modeChip && !doc.querySelector("[data-mode-of='origin/rev']") && modeChip.textContent === phoneT("mode.auto");
    modeChip?.click();
    const picker = await waitFor("모드 고르기", () => doc.querySelector<HTMLElement>("[data-mode-picker='origin/dev']"), 2000).catch(() => null);
    const currentOff = !!picker?.querySelector<HTMLButtonElement>("[data-mode=auto]")?.disabled;
    picker?.querySelector<HTMLElement>("[data-mode=manual]")?.click();
    const refused = await waitFor("거절 이유", () => doc.querySelector(".mode-picker .prompt-error")?.textContent, 2000).catch(() => "");
    doc.querySelector<HTMLElement>(".mode-picker [data-mode=manual]")?.click();
    const bypassText = phoneT("mode.err.bypass");
    const refusedBypass = await waitFor("bypass 거절 이유", () => doc.querySelector(".mode-picker .prompt-error")?.textContent === bypassText, 2000).then(() => true, () => false);
    doc.querySelector<HTMLElement>(".mode-picker [data-mode=manual]")?.click();
    const closed = await waitFor("고르는 창 닫힘", () => !doc.querySelector(".mode-picker"), 2000).then(() => true, () => false);
    check(
      "폰 채팅: 모드를 읽은 참여자만 칩 옆에 권한 모드, 누르면 고르는 창(지금 모드는 못 누름), 맥이 거절하면 이유를 보이고 다시 고르면 보내고 닫힘",
      onlyDev && currentOff && refused === phoneT("mode.err.awaiting") && refusedBypass && modeSets.join(",") === "origin/dev:manual,origin/dev:manual,origin/dev:manual" && closed,
      `${onlyDev} ${modeChip?.textContent} ${currentOff} ${refused} ${refusedBypass} ${modeSets} ${closed}`,
    );

    // 처음으로 (컴퓨터가 여럿일 때만): 막대의 집 버튼이 #/(컴퓨터 목록)로 간다. 화면이 쓰는 location은 이 창의 것이라 주소를 되돌린다
    const noHome = !doc.querySelector(".bar [data-home]");
    root.render(createElement(Chat, { computer: { id: "c", name: "Mac", api: "http://127.0.0.1:9", token: "t" }, project: "p", home: true }));
    const homeButton = await waitFor("집 버튼", () => doc.querySelector<HTMLElement>(".bar [data-home]"), 2000).catch(() => null);
    const before = location.href;
    homeButton?.click();
    const went = location.hash;
    history.replaceState(history.state, "", before);
    check(
      "폰 채팅: 컴퓨터가 여럿이면 막대에 집 버튼, 누르면 컴퓨터 목록(#/)으로 (하나면 없음)",
      noHome && homeButton?.getAttribute("aria-label") === phoneT("phone.computers") && went === "#/",
      `${noHome} ${homeButton?.getAttribute("aria-label")} ${went}`,
    );
  } finally {
    root.unmount();
    Object.assign(phoneApi, saved);
    frame.remove();
  }
}

// 폰 설정 (src/mobile/settings.ts, MobileApp.tsx Settings): 테마·언어·글자 크기. 저장한 값이 이상하면 기본(폰 설정 따라, 100%).
// 실제 설정 화면을 iframe에 그려 누른다: 테마·글자 크기는 바로 적용, 지금과 다른 언어는 화면을 다시 읽는다.
// 글자 크기는 모든 글자에 배율로 걸리고, 입력란은 iOS 확대를 막으려고 16px 아래로 내려가지 않는다.
async function testMobileSettingsUnit() {
  const def = JSON.stringify(DEFAULT_PHONE_SETTINGS);
  const parsed = [null, "x{", '{"theme":"neon","locale":"fr","fontScale":9}', '{"theme":"light","locale":"ko","fontScale":1.3}'].map((r) => JSON.stringify(parsePhoneSettings(r)));
  check(
    "폰 설정: 없거나 깨지거나 모르는 값은 기본, 맞는 값은 그대로",
    parsed[0] === def && parsed[1] === def && parsed[2] === def && parsed[3] === '{"theme":"light","locale":"ko","fontScale":1.3}',
    parsed.join(" | "),
  );
  // 상속 키는 테마·언어가 아니다 (리뷰 R1: 그대로 받아 applyTheme·translate에서 예외로 시작이 멈췄다). 데스크톱 설정도 같은 검사를 쓴다
  const inherited = ["constructor", "__proto__", "toString", "hasOwnProperty"];
  const odd = inherited.map((k) => JSON.stringify(parsePhoneSettings(JSON.stringify({ theme: k, locale: k })))).filter((r) => r !== def);
  check(
    "폰 설정: 상속 키(constructor·__proto__ 등)는 테마·언어로 받지 않고 기본으로 (데스크톱 isThemeId·isLocale도)",
    odd.length === 0 && inherited.every((k) => !isThemeId(k) && !isLocale(k)) && isThemeId("light") && isLocale("ko"),
    odd.join(" | "),
  );
  const auto = { theme: "auto", locale: "auto", fontScale: 1 } as const;
  check(
    "폰 설정: 폰 설정 따라는 밝기(Dark/Solarized Light)와 폰 언어, 고르면 그 값",
    resolvePhoneTheme(auto, true) === "dark" && resolvePhoneTheme(auto, false) === "solarized-light" && resolvePhoneTheme({ ...auto, theme: "light" }, true) === "light" &&
      resolvePhoneLocale(auto, "ko-KR") === "ko" && resolvePhoneLocale(auto, "en-US") === "en" && resolvePhoneLocale({ ...auto, locale: "en" }, "ko-KR") === "en",
  );

  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:400px;height:600px";
  document.body.appendChild(frame);
  const vars = Object.entries(THEMES.dark.ui).map(([k, v]) => `${k}:${v}`).join(";");
  const loaded = new Promise((r) => (frame.onload = r));
  frame.srcdoc = `<style>:root{${vars}}${mobileCss}</style><div id="root"></div><div class="row-sub">s</div><textarea></textarea>`;
  await loaded;
  const doc = frame.contentDocument!;
  const applied: string[] = [];
  let reloads = 0;
  const stored = localStorage.getItem("ddak.phone.settings");
  localStorage.removeItem("ddak.phone.settings");
  const root = createRoot(doc.getElementById("root")!);
  const button = (key: string, value: string) => doc.querySelector<HTMLElement>(`[data-setting="${key}"] button[data-value="${value}"]`);
  try {
    root.render(createElement(PhoneSettingsView, { apply: (s: PhoneSettings) => void applied.push(`${s.theme}/${s.locale}/${s.fontScale}`), reload: () => void reloads++ }));
    await waitFor("설정 화면", () => button("theme", "auto"), 3000);
    const themes = [...doc.querySelectorAll<HTMLElement>('[data-setting="theme"] button')].map((b) => b.dataset.value).join(",");
    check("폰 설정: 테마는 폰 설정 따라와 모든 테마, 처음엔 폰 설정 따라", themes === `auto,${Object.keys(THEMES).join(",")}` && button("theme", "auto")!.getAttribute("aria-pressed") === "true", themes);
    button("theme", "light")!.click();
    await sleep(50);
    button("fontScale", "1.3")!.click();
    await sleep(50);
    check(
      "폰 설정: 테마·글자 크기는 고르면 바로 적용하고 저장, 고른 것 표시",
      applied.join(" ") === "light/auto/1 light/auto/1.3" && reloads === 0 && localStorage.getItem("ddak.phone.settings") === '{"theme":"light","locale":"auto","fontScale":1.3}' &&
        button("fontScale", "1.3")!.classList.contains("on") && !button("fontScale", "1")!.classList.contains("on"),
      `${applied.join(" ")} reload=${reloads} ${localStorage.getItem("ddak.phone.settings")}`,
    );
    const other = phoneLocale === "ko" ? "en" : "ko";
    button("locale", other)!.click();
    await sleep(50);
    const reloadedForOther = reloads === 1 && applied.length === 2;
    button("locale", "auto")!.click();
    await sleep(50);
    check("폰 설정: 지금과 다른 언어를 고르면 화면을 다시 읽고, 같은 언어면 그대로 적용", reloadedForOther && reloads === 1 && applied.length === 3, `reload=${reloads} ${applied.join(" ")}`);

    // 저장하지 못하면: 언어는 바꾸지 않고(다시 읽으면 이전 언어로 돌아간다) 알린다, 테마는 지금 화면에만 적용하고 알린다 (리뷰 R2)
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    try {
      button("locale", other)!.click();
      await sleep(50);
      const keptLocale = reloads === 1 && applied.length === 3 && button("locale", "auto")!.classList.contains("on") && !!doc.querySelector(".settings .error");
      button("theme", "dark")!.click();
      await sleep(50);
      check(
        "폰 설정: 저장하지 못하면 언어는 바꾸지 않고(다시 읽지 않음) 알리며, 테마는 지금 화면에만 적용하고 알림",
        keptLocale && reloads === 1 && applied[3] === "dark/auto/1.3" && button("theme", "dark")!.classList.contains("on") && !!doc.querySelector(".settings .error"),
        `${keptLocale} reload=${reloads} ${applied.join(" ")} ${doc.querySelector(".settings .error")?.textContent ?? "(알림 없음)"}`,
      );
    } finally {
      Storage.prototype.setItem = setItem;
    }
    button("theme", "light")!.click();
    await sleep(50);
    check("폰 설정: 다시 저장되면 알림이 사라짐", !doc.querySelector(".settings .error") && localStorage.getItem("ddak.phone.settings") === '{"theme":"light","locale":"auto","fontScale":1.3}');

    const size = (sel: string) => frame.contentWindow!.getComputedStyle(doc.querySelector(sel)!).fontSize;
    doc.documentElement.style.setProperty("--font-scale", "1.3");
    const big = [size("body"), size("body > .row-sub"), size("body > textarea"), size(".bar h1")];
    doc.documentElement.style.setProperty("--font-scale", "0.85");
    const small = [size("body"), size("body > .row-sub"), size("body > textarea")];
    check(
      "폰 설정: 글자 크기 배율이 본문·작은 글자·제목에 걸리고, 입력란은 16px 아래로 내려가지 않음",
      // 계산값은 20.799999px처럼 나온다
      [...big, ...small].map((v) => Math.round(parseFloat(v) * 10) / 10).join(",") === "20.8,18.2,20.8,22.1,13.6,11.9,16",
      `${big.join(",")} / ${small.join(",")}`,
    );
  } finally {
    root.unmount();
    frame.remove();
    if (stored === null) localStorage.removeItem("ddak.phone.settings");
    else localStorage.setItem("ddak.phone.settings", stored);
  }
}

// 폰 화면 글자색 (src/mobile/mobile.css): 배경 없는 버튼(프로젝트 이름, 막대의 ‹·+)은 모든 테마에서 화면 글자색이어야 한다.
// 밝은 테마의 --button-fg는 색을 채운 버튼용 흰색이라 그대로 물려받으면 배경에 묻힌다 (2026-10-27 사용자 화면)
async function testMobileThemeUnit() {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:400px;height:300px";
  document.body.appendChild(frame);
  const wrong: string[] = [];
  for (const [id, theme] of Object.entries(THEMES)) {
    const vars = Object.entries(theme.ui).map(([k, v]) => `${k}:${v}`).join(";");
    const loaded = new Promise((r) => (frame.onload = r));
    frame.srcdoc = `<style>:root{${vars}}${mobileCss}</style><header class="bar"><button class="bar-back">‹</button><h1>Mac</h1><button class="bar-side">+</button></header><main class="list"><button class="row row-main"><span class="row-title">proj</span></button></main><button class="row-side row-remove">x</button><span class="ref" style="color:var(--fg)">x</span><span class="ref-error" style="color:var(--error)">x</span>`;
    await loaded;
    const doc = frame.contentDocument!;
    const color = (sel: string) => frame.contentWindow!.getComputedStyle(doc.querySelector(sel)!).color;
    for (const sel of [".row-title", ".bar-back", ".bar-side"]) if (color(sel) !== color(".ref")) wrong.push(`${id} ${sel} ${color(sel)} (화면 글자 ${color(".ref")})`);
    const remove = frame.contentWindow!.getComputedStyle(doc.querySelector(".row-remove")!);
    if (color(".row-remove") !== color(".ref-error") || remove.backgroundColor !== "rgba(0, 0, 0, 0)") wrong.push(`${id} .row-remove ${remove.color} ${remove.backgroundColor} (오류색 ${color(".ref-error")})`);
  }
  check("폰 화면: 배경 없는 버튼(프로젝트 이름, 막대의 ‹·+)은 화면 글자색, 컴퓨터 빼기는 배경 없이 오류색 (모든 테마)", wrong.length === 0, wrong.join(", "));

  // 컴퓨터 빼기 (MobileApp.tsx ComputerList): 글자 없는 휴지통 아이콘(이름은 "빼기"), 확인 창에서 취소하면 빼지 않는다.
  // 컴퓨터 목록·프로젝트 목록은 맥이 알려 준 이름(/api/info)으로 저장한 이름을 맞추게 한다 (맥 "모바일 연결" 창에서 바꿈)
  const loaded = new Promise((r) => (frame.onload = r));
  frame.srcdoc = `<style>${mobileCss}</style><div id="root"></div>`;
  await loaded;
  const doc = frame.contentDocument!;
  const savedInfo = phoneApi.info;
  const savedProjects = phoneApi.projects;
  const savedConfirm = window.confirm;
  phoneApi.info = async () => ({ id: "a", name: "Mac", version: "", api: PHONE_API });
  phoneApi.projects = async () => [];
  const renamed: string[] = [];
  const onRename = (id: string, name: string) => renamed.push(`${id}:${name}`);
  const old = { id: "a", name: "Old Mac", api: "http://127.0.0.1:9", token: "t" };
  const removed: string[] = [];
  const asked: string[] = [];
  let answer = false;
  window.confirm = (text?: string) => (asked.push(text ?? ""), answer);
  const root = createRoot(doc.getElementById("root")!);
  try {
    root.render(createElement(ComputerList, { computers: [old], onRemove: (id: string) => removed.push(id), onRename }));
    const button = await waitFor("빼기 버튼", () => doc.querySelector<HTMLElement>(".row-remove"), 2000).catch(() => null);
    const iconOnly = !!button?.querySelector("svg") && button.textContent === "" && button.getAttribute("aria-label") === phoneT("phone.remove");
    button?.click();
    const cancelled = removed.length;
    answer = true;
    button?.click();
    check(
      "폰 컴퓨터 목록: 빼기는 글자 없는 아이콘(이름 '빼기'), 확인 창에서 취소하면 그대로, 확인하면 뺌",
      iconOnly && asked.length === 2 && asked[0] === phoneT("phone.removeConfirm", { name: "Old Mac" }) && cancelled === 0 && removed.join(",") === "a",
      `${iconOnly} ${button?.textContent} ${button?.getAttribute("aria-label")} ${asked.length} ${cancelled} ${removed}`,
    );
    const fromList = renamed.join(",");
    renamed.length = 0;
    root.render(createElement(ProjectList, { computer: old, computers: [old], onRename }));
    await waitFor("프로젝트 목록에서 이름 맞춤", () => renamed.length > 0, 2000).catch(() => null);
    check("폰: 컴퓨터 목록·프로젝트 목록이 맥이 알려 준 이름으로 저장한 이름을 맞춤", fromList === "a:Mac" && renamed.join(",") === "a:Mac", `${fromList} / ${renamed}`);
  } finally {
    root.unmount();
    phoneApi.info = savedInfo;
    phoneApi.projects = savedProjects;
    window.confirm = savedConfirm;
    frame.remove();
  }
}

// 폰 알림의 실제 코드를 브라우저·네트워크 대역과 돌린다: 맥마다 구독 맞추기 (src/mobile/push.ts reconcile)와 서비스 워커
// (src/mobile/public/sw.js)
async function testMobilePushUnit() {
  const computer = (id: string) => ({ id, name: id, api: `https://${id}.example`, token: "t" });
  const [a, b] = [computer("a"), computer("b")];
  const later = <T,>() => {
    let resolve!: (v: T) => void;
    return { promise: new Promise<T>((r) => (resolve = r)), resolve };
  };
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const info = (push: PushInfo): Info => ({ id: "x", name: "x", version: "", api: 1, push });
  // 리뷰 R3: 답하지 않는 맥(b)이 답한 맥(a)에 구독을 보내는 것을 붙잡지 않는다
  {
    const sent: string[] = [];
    const slow = later<Info | null>();
    const done = reconcile([a, b], { endpoint: "e1" }, {
      info: (c) => (c === a ? Promise.resolve(info({ endpoint: null, gone: null })) : slow.promise),
      send: async (c, s) => sent.push(`${c.id}:${s.endpoint}`),
      renew: async () => ({ endpoint: "e2" }),
    });
    await settle();
    const early = sent.join(",");
    slow.resolve(info({ endpoint: "old", gone: null }));
    await done;
    check("폰 알림: 답하지 않는 맥이 답한 맥의 구독 보내기를 붙잡지 않음", early === "a:e1" && sent.join(",") === "a:e1,b:e1", `${early} / ${sent}`);
  }
  // 한 맥이 이 구독이 없어졌다고 하면 한 번만 새로 구독해 모든 맥에 보낸다. 늦게 답한 맥에 예전 구독을 보내지 않는다
  {
    const sent: string[] = [];
    let renews = 0;
    const slow = later<Info | null>();
    const done = reconcile([a, b], { endpoint: "e1" }, {
      info: (c) => (c === a ? Promise.resolve(info({ endpoint: null, gone: "e1" })) : slow.promise),
      send: async (c, s) => sent.push(`${c.id}:${s.endpoint}`),
      renew: async () => {
        renews++;
        return { endpoint: "e2" };
      },
    });
    await settle();
    slow.resolve(info({ endpoint: "old", gone: null }));
    await done;
    check("폰 알림: 없어진 구독은 한 번만 새로 구독해 모든 맥에 (늦게 답한 맥에 예전 것을 보내지 않음)", renews === 1 && [...sent].sort().join(",") === "a:e2,b:e2", `${renews} ${sent}`);
  }
  // 재리뷰 R6: a에 예전 구독(e1)을 보내는 중에 b가 없어졌다고 하면, 새 구독(e2)은 a의 앞 쓰기가 끝난 뒤에 쓴다 (맥에 남는 것은 e2)
  {
    const stored: Record<string, string> = {};
    const first = later<void>();
    const slow = later<Info | null>();
    let firstA = true;
    const done = reconcile([a, b], { endpoint: "e1" }, {
      info: (c) => (c === a ? Promise.resolve(info({ endpoint: null, gone: null })) : slow.promise),
      send: async (c, s) => {
        if (c === a && firstA) {
          firstA = false;
          await first.promise;
        }
        stored[c.id] = s.endpoint;
      },
      renew: async () => ({ endpoint: "e2" }),
    });
    await settle();
    slow.resolve(info({ endpoint: null, gone: "e1" }));
    await settle();
    first.resolve();
    await done;
    check("폰 알림: 늦게 끝난 예전 구독 쓰기가 새 구독을 덮지 않음 (맥마다 쓰기를 차례로)", stored.a === "e2" && stored.b === "e2", JSON.stringify(stored));
  }
  // 재리뷰 R3: 컴퓨터를 빼고 키를 바꾸지 못하면 화면이 바뀌어도 (2→1대는 프로젝트 목록, 마지막이면 추가 화면) 알린다
  {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(createElement(KeyProblem, { computers: [b] }));
    await removeComputer(a, [b], async () => {
      throw new Error("permission denied");
    });
    await settle();
    const shownAfterTwoToOne = host.textContent ?? "";
    await removeComputer(b, [], async () => {
      throw new Error("still denied");
    });
    await settle();
    const shownAfterLast = host.textContent ?? "";
    await changeKey([], async () => {});
    await settle();
    check(
      "폰 알림: 컴퓨터를 빼고 키를 바꾸지 못하면 화면이 바뀌어도 알리고, 다시 시도해 성공하면 지움",
      shownAfterTwoToOne.includes("permission denied") && shownAfterLast.includes("still denied") && keyProblem() === null && host.textContent === "",
      `${shownAfterTwoToOne} | ${shownAfterLast} | ${host.textContent}`,
    );
    root.unmount();
    host.remove();
  }
  // 재리뷰 R2: 보고 있는 채팅의 알림은 그 종류가 알린 것을 다시 읽어 보였을 때만 닫는다
  const m = (status: Record<string, string>, paused: string[] = []) => ({ members: [], waiting: [], status, paused });
  const closes = [
    confirmed("message", true, null),
    confirmed("message", false, null),
    confirmed("attention", false, m({ dev: "permission" })),
    confirmed("attention", true, m({ dev: "working" })),
    confirmed("attention", true, null),
    confirmed("paused", false, m({}, ["g"])),
    confirmed("paused", false, m({})),
    confirmed("other", true, m({ dev: "permission" })),
  ].join(",");
  check("폰 알림: 보고 있는 채팅의 알림은 그 종류를 보였을 때만 닫음 (메시지·권한 확인·멈춤)", closes === "true,false,true,false,false,true,false,false", closes);

  // 3단계 리뷰 R3: 읽음 보내기가 실패하면 같은 번호로 다시 보내고, 그 사이 더 뒤 번호를 보내면 그것만 남는다
  {
    const sent: string[] = [];
    let failNext = 1;
    const marks = new ReadMark(async (id) => {
      sent.push(String(id));
      if (failNext-- > 0) throw new Error("offline");
    }, 20);
    marks.mark(100);
    await new Promise((r) => setTimeout(r, 80));
    // 실패한 100은 저절로 다시 보냈다 (아래 mark 전에 본다)
    const retried = sent.join(",");
    marks.mark(100);
    marks.mark(99);
    failNext = 1;
    marks.mark(101);
    await settle();
    marks.mark(102);
    await new Promise((r) => setTimeout(r, 80));
    marks.stop();
    check("폰 채팅: 읽음 보내기가 실패하면 다시 보내고, 보낸 번호 이하는 다시 보내지 않음", retried === "100,100" && sent.join(",") === "100,100,101,102", `${retried} / ${sent}`);
  }

  // 서비스 워커: 실제 sw.js를 가짜 self(창 목록, 알림, 창 열기)로 실행한다
  const source = await fetch("/src/mobile/public/sw.js").then((r) => r.text());
  const scope = "https://user.example/ddak/";
  type Win = { url: string; visibilityState: string; posted: { type: string; kind?: string; id?: string }[]; focused: boolean; postMessage: (m: { type: string }) => void; focus: () => Promise<void> };
  const win = (url: string, visible: boolean): Win => {
    const w: Win = { url, visibilityState: visible ? "visible" : "hidden", posted: [], focused: false, postMessage: (m) => w.posted.push(m), focus: async () => void (w.focused = true) };
    return w;
  };
  let wins: Win[] = [];
  const shown: [string, NotificationOptions & { renotify?: boolean }][] = [];
  const opened: string[] = [];
  const handlers: Record<string, (e: object) => void> = {};
  const fakeSelf = {
    addEventListener: (kind: string, f: (e: object) => void) => (handlers[kind] = f),
    skipWaiting: () => {},
    crypto,
    registration: { scope, showNotification: async (title: string, o: NotificationOptions) => void shown.push([title, o]) },
    clients: { claim: async () => {}, matchAll: async () => wins, openWindow: async (u: string) => void opened.push(u) },
  };
  new Function("self", source)(fakeSelf);
  const fire = async (kind: string, e: object) => {
    let wait: Promise<unknown> = Promise.resolve();
    handlers[kind]({ ...e, waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  };
  const chat = "#/c/c1/p/proj-1";
  const push = () => fire("push", { data: { json: () => ({ title: "Mac · proj", body: "dev: done", kind: "attention", computer: "c1", project: "proj-1" }) } });
  const click = () => fire("notificationclick", { notification: { close: () => {}, data: { path: chat } } });
  // 리뷰 R1: 같은 출처의 다른 앱 창은 ddak 창이 아니다 (같은 주소 조각이 보여도 알림을 띄우고, 누르면 ddak 창으로)
  const other = win(`https://user.example/other-app/${chat}`, true);
  const ours = win(`${scope}${chat}`, false);
  wins = [other, ours];
  await push();
  check("폰 알림: 다른 앱 창이 같은 주소 조각을 보여도 알림을 띄움 (소리 있게)", shown.length === 1 && shown[0][1].silent === false && shown[0][1].tag === "c1/proj-1" && other.posted.length === 0, JSON.stringify(shown));
  await click();
  check("폰 알림: 누르면 다른 앱이 아니라 ddak 창을 앞으로 가져와 그 채팅으로", ours.focused && ours.posted.some((m) => m.type === "open") && !other.focused && other.posted.length === 0 && opened.length === 0, `${ours.focused} ${JSON.stringify(ours.posted)} ${other.focused}`);
  wins = [other];
  await click();
  check("폰 알림: ddak 창이 없으면 그 채팅을 새로 엶", opened.join() === `${scope}${chat}`, opened.join());
  // 리뷰 R2: 그 채팅이 보여도 알림은 띄운다 (소리 없이). 창에 알려 실제로 다시 읽었을 때 창이 닫는다
  shown.length = 0;
  const viewing = win(`${scope}${chat}`, true);
  wins = [viewing];
  await push();
  const note = viewing.posted.find((x) => x.type === "shown");
  check(
    "폰 알림: 보고 있는 채팅이어도 알림은 띄우고 (소리 없이) 창에 종류와 그 알림 id를 알림",
    shown.length === 1 && shown[0][1].silent === true && note?.kind === "attention" && !!note.id && (shown[0][1].data as { id?: string }).id === note.id,
    `${JSON.stringify(shown)} ${JSON.stringify(viewing.posted)}`,
  );
}

// 모바일 연결 (src/MobileDialog.tsx, src-tauri/src/mobile.rs). Tailscale 대신 정한 이름·로그인(scripts/selftest.sh
// DDAK_MOBILE_IDENTITY)으로 켜고, 폰 대신 Rust에서 HTTP를 보낸다 (Origin·신원 헤더를 넣으려고, selftest_mobile_http).
async function testMobile(root: string) {
  const ORIGIN = "https://screen.example";
  const LOGIN = "selftest@example.com";
  const http = (method: string, path: string, headers: Record<string, string> = {}, body = "") =>
    invoke<[number, string]>("selftest_mobile_http", { method, path, headers: Object.entries({ Origin: ORIGIN, "Tailscale-User-Login": LOGIN, ...headers }), body });
  const dialog = () => document.querySelector<HTMLElement>(".mobile-dialog");
  const enable = () => dialog()!.querySelector<HTMLInputElement>("[data-action=mobile-enable]")!;
  await waitMenu((m) => m.includes("ddak/Mobile Connection…"));
  await clickMenu("ddak", "Mobile Connection…");
  await waitFor("모바일 연결 창", () => dialog()?.querySelector("[data-action=mobile-enable]"), 5000);
  check("모바일 연결: 앱 메뉴로 창을 열고 처음엔 꺼짐", !enable().checked, dialog()!.textContent ?? "");
  enable().click();
  const ready = await waitFor("켜짐", () => dialog()!.querySelector("[data-mobile-ready=true]"), 10000).then(() => true, () => false);
  check("모바일 연결: 켜면 서버가 뜨고 준비됨 (HTTPS 인증서·serve)", ready && enable().checked, dialog()!.textContent ?? "");
  dialog()!.querySelector<HTMLElement>("[data-action=mobile-pair]")!.click();
  const codeEl = await waitFor("페어링 코드", () => dialog()!.querySelector<HTMLElement>("[data-pair-code]"), 5000);
  const code = codeEl.dataset.pairCode!;
  check("모바일 연결: 페어링 코드와 QR", /^\d{6}$/.test(code) && !!dialog()!.querySelector("svg.mobile-qr path[d^='M']"), dialog()!.textContent ?? "");

  // 다른 Tailscale 로그인은 맞는 코드여도 거절, 같은 로그인이면 기기 토큰
  const [other] = await http("POST", "/api/pair", { "Tailscale-User-Login": "someone@example.com" }, JSON.stringify({ code, device: "Selftest Phone" }));
  const [paired, pairBody] = await http("POST", "/api/pair", {}, JSON.stringify({ code, device: "Selftest Phone" }));
  const token = paired === 200 ? (JSON.parse(pairBody).token as string) : "";
  check("모바일 연결: 다른 로그인 거절, 코드로 페어링", other === 403 && paired === 200 && token.length === 64, `${other} ${paired} ${pairBody}`);
  const auth = { Authorization: `Bearer ${token}` };

  // 폰에 보일 이름 (mobile.rs set_name): 창의 칸에서 바꾸고 칸을 벗어나면 저장, 폰은 /api/info로 받는다. 비우면 이 맥 이름으로
  const infoName = async () => JSON.parse((await http("GET", "/api/info", auth))[1]).name as string;
  const nameInput = () => dialog()!.querySelector<HTMLInputElement>("[data-action=mobile-name]")!;
  // 저장을 시작하면 응답까지 칸을 잠그는지 (그 사이 고친 것을 응답이 지우지 않게. 리뷰 R1)
  let lockedWhileSaving = true;
  const typeName = async (value: string) => {
    nameInput().focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameInput(), value);
    nameInput().dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(50);
    nameInput().blur();
    // React는 이벤트 뒤 마이크로태스크에서 다시 그린다 (저장 응답은 IPC라 그보다 늦다)
    await Promise.resolve();
    lockedWhileSaving &&= nameInput().disabled;
  };
  // 저장은 비동기라 폰 정보가 그 이름이 될 때까지 본다
  const nameBecomes = async (want: string) => {
    for (const end = Date.now() + 5000; Date.now() < end; await sleep(100)) if ((await infoName()) === want) return true;
    return false;
  };
  const defaultName = await infoName();
  await typeName("  Selftest Studio  ");
  const renamed = await nameBecomes("Selftest Studio");
  const shown = await waitFor("칸에 다듬은 이름", () => nameInput().value === "Selftest Studio" && nameInput().value, 3000).catch(() => nameInput().value);
  await typeName("");
  const restored = await nameBecomes(defaultName);
  // 칸은 창이 저장 결과를 받은 뒤 되돌아간다
  await waitFor("칸 되돌림", () => nameInput().value === defaultName, 3000).catch(() => null);
  check(
    "모바일 연결: 폰에 보일 이름을 창에서 바꾸면 저장되어 폰 정보에 (앞뒤 공백 뺌), 비우면 이 맥 이름으로. 저장하는 동안 칸은 잠김",
    !!defaultName && renamed && shown === "Selftest Studio" && restored && nameInput().value === defaultName && lockedWhileSaving && !nameInput().disabled,
    `${defaultName} ${renamed} ${shown} ${restored} ${nameInput().value} 잠김=${lockedWhileSaving} 지금=${nameInput().disabled}`,
  );
  const [listed, listBody] = await http("GET", "/api/projects", auth);
  const project = listed === 200 ? (JSON.parse(listBody).projects as { id: string; name: string }[]).find((p) => p.name === root.split("/").pop()) : undefined;
  check("모바일 연결: 프로젝트 목록", !!project, `${listed} ${listBody}`);
  // 받는 사람이 없으면 보내지 않는다 (예전 폰 화면이 멘션 없이 보내도). 받을 참여자를 넣은 뒤 @all로 보낸다
  const [refused, refusedBody] = await http("POST", `/api/projects/${project?.id}/messages`, auth, JSON.stringify({ text: "hello from the phone" }));
  const reader = await invoke<string>("selftest_chat_join", { project: root, name: "origin/phone-reader" });
  const [posted, postBody] = await http("POST", `/api/projects/${project?.id}/messages`, auth, JSON.stringify({ text: "@all hello from the phone" }));
  await invoke("selftest_chat_leave", { token: reader });
  const stored = await invoke<{ text: string; from: string; to: string[]; via?: string }[]>("chat_messages", { project: root });
  const last = stored.at(-1);
  check(
    "모바일 연결: 받는 사람이 없으면 거절, 폰에서 보낸 메시지는 사용자로, 기기 이름과 함께",
    refused === 400 && JSON.parse(refusedBody).error === "no-recipient" && !stored.some((m) => m.text === "hello from the phone") &&
      posted === 200 && last?.from === "user" && last.text === "@all hello from the phone" && last.to.join() === "origin/phone-reader" && last.via === "Selftest Phone",
    `${refused} ${refusedBody} ${posted} ${postBody} ${JSON.stringify(last)}`,
  );

  // 채팅 패널에 "폰에서" 표시
  const ws = document.querySelector<HTMLElement>(`.project-workspace[data-project="${root}"]`);
  const panel = () => ws?.querySelector<HTMLElement>(".chat-panel");
  const wasOpen = !!panel() && panel()!.style.display !== "none";
  // 창은 닫고 본다 (패널 버튼이 대화상자에 가리지 않게)
  dialog()!.querySelector<HTMLElement>(".modal-actions button")!.click();
  if (!wasOpen) ws?.querySelector<HTMLElement>("[data-action=chat]")?.click();
  const via = await waitFor("폰 표시", () => panel()?.querySelector<HTMLElement>(".chat-msg:last-of-type [data-via]"), 5000).catch(() => null);
  check("모바일 연결: 채팅 패널에 보낸 기기 표시", via?.textContent === "from Selftest Phone", via?.textContent ?? panel()?.innerHTML.slice(-300) ?? "패널 없음");
  if (!wasOpen) ws?.querySelector<HTMLElement>("[data-action=chat]")?.click();

  // 폰 알림 (src-tauri/src/push.rs): 폰이 넘긴 구독(폰이 만든 키)을 기기에 두고, 맥이 알릴 때 같은 생략 조건으로 폰에도 보낸다
  // (자체 테스트는 보내지 않고 기록한다)
  const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const sub = {
    endpoint: "https://push.example/sub/1",
    p256dh: b64u(await crypto.subtle.exportKey("raw", ua.publicKey)),
    auth: b64u(crypto.getRandomValues(new Uint8Array(16))),
    publicKey: b64u(await crypto.subtle.exportKey("raw", vapid.publicKey)),
    privateKey: (await crypto.subtle.exportKey("jwk", vapid.privateKey)).d!,
  };
  const [mismatched] = await http("POST", "/api/push", auth, JSON.stringify({ ...sub, publicKey: sub.p256dh }));
  const [subscribed, subBody] = await http("POST", "/api/push", auth, JSON.stringify(sub));
  const [, infoBody] = await http("GET", "/api/info", auth);
  check("모바일 알림: 폰의 구독을 받고 (VAPID 키 짝이 안 맞으면 거절) 정보에 그 주소", mismatched === 400 && subscribed === 200 && JSON.parse(infoBody).push?.endpoint === sub.endpoint, `${mismatched} ${subscribed} ${subBody} ${infoBody}`);
  const pushes = () => invoke<[string, { title: string; body: string; kind: string; computer: string; project: string }][]>("selftest_mobile_pushes");
  await pushes();
  await invoke("selftest_set_focused", { focused: false });
  await invoke("selftest_notify", { project: root, kind: "message", body: "dev: done" });
  const sent = await pushes();
  const computerId = paired === 200 ? JSON.parse(pairBody).id : "";
  check(
    "모바일 알림: 맥이 알릴 때 폰에도 (제목 컴퓨터 · 프로젝트, 누르면 열 채팅)",
    sent.length === 1 && sent[0][0] === "Selftest Phone" && sent[0][1].body === "dev: done" && sent[0][1].kind === "message" && sent[0][1].title.endsWith(` · ${root.split("/").pop()}`) && sent[0][1].computer === computerId && sent[0][1].project === project?.id,
    JSON.stringify(sent),
  );
  // 맥에서 그 프로젝트를 보고 있으면 폰에도 보내지 않는다 (권한 확인은 그 프로젝트만 보고 있어도 생략, notify.rs)
  await invoke("selftest_set_focused", { focused: true });
  await invoke("selftest_notify", { project: root, kind: "attention", body: "dev is waiting" });
  const quiet = await pushes();
  await invoke("selftest_set_focused", { focused: false });
  await invoke("selftest_notifications");
  check("모바일 알림: 맥에서 보고 있으면 폰에도 보내지 않음", quiet.length === 0, JSON.stringify(quiet));

  // 모바일 3단계 (chat.rs unread): 세션이 사용자에게 보낸 메시지는 맥의 사이드바 배지와 폰 목록에 같은 수, 폰에서 읽으면 맥 배지도
  // 지운다. 창은 뒤로 보내 둔다 (채팅을 보고 있으면 맥이 바로 읽은 것으로 친다)
  const rowOf = (p: string) => document.querySelector<HTMLElement>(`.project-row[data-project="${CSS.escape(p)}"]`);
  const badge = () => rowOf(root)?.querySelector<HTMLElement>(".project-unread")?.dataset.unread ?? "0";
  type Listed = { id: string; name: string; open?: boolean; unread?: number };
  const projectNamed = async (name: string) => (JSON.parse((await http("GET", "/api/projects", auth))[1]).projects as Listed[]).find((p) => p.name === name);
  window.dispatchEvent(new Event("blur"));
  const poster = await invoke<string>("selftest_chat_join", { project: root, name: "origin/phone-poster" });
  const toUser = await invoke<{ id: number }>("selftest_chat_post", { project: root, from: "origin/phone-poster", text: "@user done" });
  const counted = await waitFor("맥 배지", () => badge() === "1", 5000).then(() => true, () => false);
  const phoneCount = (await projectNamed(root.split("/").pop()!))?.unread;
  await http("POST", `/api/projects/${project?.id}/read`, auth, JSON.stringify({ id: toUser.id }));
  const cleared = await waitFor("폰에서 읽으면 맥 배지 지움", () => badge() === "0", 5000).then(() => true, () => false);
  const phoneAfter = (await projectNamed(root.split("/").pop()!))?.unread;
  await invoke("selftest_chat_leave", { token: poster });
  window.dispatchEvent(new Event("focus"));
  check("모바일 3단계: 사용자에게 온 메시지는 맥 배지와 폰 목록에 같은 수, 폰에서 읽으면 맥 배지도 지움", counted && phoneCount === 1 && cleared && phoneAfter === 0, `${counted} ${phoneCount} ${cleared} ${phoneAfter} badge=${badge()}`);

  // 폰에서 프로젝트 열기: 목록에만 있고 열리지 않은 프로젝트는 폰 목록에 열리지 않음으로, "맥에서 열기"면 맥이 그 프로젝트를 연다
  // (보고 있는 프로젝트는 그대로)
  const otherRoot = root.replace(/\/proj$/, "/other");
  const confirmBefore = devHooks.confirm;
  devHooks.confirm = async () => true;
  const removeOther = async () => {
    rowOf(otherRoot)?.querySelector<HTMLElement>("[data-action=remove]")?.click();
    await waitFor("다른 프로젝트 빼기", () => !rowOf(otherRoot), 3000).catch(() => null);
  };
  await removeOther();
  await devHooks.addProject!(otherRoot, false);
  await waitFor("목록에만 넣기", () => rowOf(otherRoot), 3000).catch(() => null);
  const closed = await waitAsync("폰 목록에 열리지 않음", async () => (await projectNamed("other"))?.open === false, 5000).then(() => true, () => false);
  const otherId = (await projectNamed("other"))?.id;
  const [opened] = await http("POST", `/api/projects/${otherId}/open`, auth, "{}");
  const workspace = await waitFor("맥에서 열림", () => document.querySelector(`.project-workspace[data-project="${CSS.escape(otherRoot)}"]`), 10000).then(() => true, () => false);
  const nowOpen = await waitAsync("폰 목록에 열림", async () => (await projectNamed("other"))?.open === true, 5000).then(() => true, () => false);
  const stayed = rowOf(root)?.classList.contains("active") === true;
  await removeOther();
  devHooks.confirm = confirmBefore;
  check("모바일 3단계: 열리지 않은 프로젝트를 폰에서 열면 맥이 연다 (보고 있는 프로젝트는 그대로)", closed && opened === 200 && workspace && nowOpen && stayed, `${closed} ${opened} ${workspace} ${nowOpen} ${stayed}`);

  // 기기 목록에서 연결을 끊으면 그 토큰은 거절
  await clickMenu("ddak", "Mobile Connection…");
  const device = await waitFor("기기 목록", () => dialog()?.querySelector<HTMLElement>("[data-device]"), 5000).catch(() => null);
  check("모바일 연결: 페어링한 기기를 보임", device?.querySelector(".mobile-device-name")?.textContent === "Selftest Phone", dialog()?.textContent ?? "");
  check("모바일 알림: 기기 목록에 알림 켜짐", !!device?.textContent?.includes("notifications on"), device?.textContent ?? "");
  device?.querySelector<HTMLElement>("button")?.click();
  await waitFor("기기 지움", () => !dialog()!.querySelector("[data-device]"), 5000).catch(() => null);
  const [after] = await http("GET", "/api/info", auth);
  check("모바일 연결: 연결을 끊은 기기는 401", after === 401, String(after));
  // 끄면 서버도 멈춘다
  enable().click();
  await waitFor("꺼짐", () => !enable().checked && !dialog()!.querySelector("[data-mobile-ready]"), 5000).catch(() => null);
  const stopped = await http("GET", "/api/info", auth).then(() => false, () => true);
  check("모바일 연결: 끄면 서버가 멈춤", stopped && !enable().checked, "");
  dialog()!.querySelector<HTMLElement>(".modal-actions button")!.click();
  await waitFor("창 닫힘", () => !dialog(), 3000).catch(() => null);
  // 뒤 단계(채팅 패널)는 방이 비어 있다고 본다 (첫 메시지가 세션의 것)
  await invoke("chat_clear", { project: root });
}

// 고정폭 글꼴 (src/monoFont.ts): 앱이 넣은 D2Coding 두 면(400·700)이 불러와졌는지 그 FontFace를 직접 본다
// (document.fonts.check는 맞는 면이 없어도 true라 쓸 수 없다, 리뷰 R4). 그리고 xterm이 그 글꼴로 칸 폭을 쟀는지:
// xterm은 "W" 폭에 화면 비율을 곱해 내린 값을 칸 폭으로 쓴다 (floor(w·dpr)/dpr). D2Coding은 0.5em(13px에서 6.5px)이라
// Menlo(약 7.8)·Consolas(약 7.15)와 갈린다. 한글은 영문 두 칸 폭이어야 터미널 칸에 맞는다 (보통·굵게 각각).
async function testTerminalFont(term: Terminal) {
  const faces = monoFaces.map((f) => `${f.weight}:${f.status}:${document.fonts.has(f)}`);
  check("글꼴: 앱이 넣은 D2Coding 보통·굵게를 불러옴", monoFaces.every((f) => f.status === "loaded" && document.fonts.has(f)), faces.join(" "));
  const ctx = document.createElement("canvas").getContext("2d")!;
  const width = (text: string, weight: string, family = MONO_FONT) => {
    ctx.font = `${weight} ${term.options.fontSize}px ${family}`;
    return ctx.measureText(text).width;
  };
  const dpr = window.devicePixelRatio;
  const cell = (term as unknown as { _core: { _renderService: { dimensions: { css: { cell: { width: number } } } } } })._core._renderService.dimensions.css.cell.width;
  const w = width("W", "400");
  const expected = Math.floor(w * dpr) / dpr;
  check(
    "글꼴: 터미널 칸 폭이 D2Coding 폭",
    Math.abs(cell - expected) < 0.01 && Math.abs(w - term.options.fontSize! / 2) < 0.01,
    `cell=${cell} expected=${expected} W=${w} dpr=${dpr} fallback=${width("W", "400", "Menlo, monospace")}`,
  );
  const sizes = ["400", "700"].map((weight) => [width("W", weight), width("한", weight)]);
  check(
    "글꼴: 한글은 영문 두 칸 폭 (보통·굵게)",
    sizes.every(([en, ko]) => Math.abs(en - w) < 0.01 && Math.abs(ko - 2 * w) < 0.01),
    JSON.stringify(sizes),
  );
}

// 터미널 글자 대비 (Terminal.tsx MIN_CONTRAST): Solarized Light의 brightCyan(#93A1A1)은 배경 대비 2.5:1이라 흐렸다.
// 그 색으로 글자를 써서 실제로 그려진 가장 진한 픽셀이 배경 대비 얼마인지 본다. 블록 문자(█)는 xterm이 대비 보정에서
// 빼서 쓸 수 없다. 글자 픽셀은 안티앨리어싱으로 실제 색보다 연하게 나와 기준을 4.5보다 낮게(3.5) 두되, 보정 전(2.48)과는
// 확실히 갈린다. 메뉴 클릭(맥 전용) 없이 터미널 색만 잠시 바꾼다.
async function testTerminalContrast(term: Terminal) {
  const before = term.options.theme;
  const theme = THEMES["solarized-light"].terminal;
  const luminance = (rgb: number[]) => {
    const c = rgb.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  try {
    term.options.theme = theme;
    term.write("\x1b[2J\x1b[H\x1b[96m" + "MWMWMW" + "\x1b[0m\r\n");
    await sleep(300);
    // WebGL 캔버스는 그린 직후(같은 작업 안)에만 읽힌다
    const pixel = await new Promise<number[]>((resolve) => {
      const d = term.onRender(() => {
        d.dispose();
        const canvas = term.element!.querySelector<HTMLCanvasElement>(".xterm-screen > canvas:not(.xterm-link-layer)")!;
        const copy = document.createElement("canvas");
        [copy.width, copy.height] = [canvas.width, canvas.height];
        const ctx = copy.getContext("2d")!;
        ctx.drawImage(canvas, 0, 0);
        // 첫 줄 앞 여섯 칸에서 가장 진한 픽셀
        const data = ctx.getImageData(0, 0, Math.ceil((canvas.width / term.cols) * 6), Math.floor(canvas.height / term.rows)).data;
        let darkest = [255, 255, 255];
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 255) continue; // 투명한 곳(그리지 않은 칸)은 0,0,0으로 읽힌다
          const px = [data[i], data[i + 1], data[i + 2]];
          if (luminance(px) < luminance(darkest)) darkest = px;
        }
        resolve(darkest);
      });
      term.refresh(0, term.rows - 1);
    });
    const got = ratio(pixel, hex(theme.background!));
    check(
      "터미널 대비: 흐린 색(Solarized brightCyan 2.5:1)도 진하게 그림",
      term.options.minimumContrastRatio === MIN_CONTRAST && got >= 3.5,
      `pixel=rgb(${pixel}) ratio=${got.toFixed(2)} option=${term.options.minimumContrastRatio}`,
    );
  } finally {
    term.options.theme = before;
    term.write("\x1b[2J\x1b[H");
  }
}

// 배율과 한글 조합 박스 (src/zoom.ts): xterm이 아는 칸 폭이 캔버스에 실제로 그려진 칸 폭과 같아야 조합 박스(.composition-view,
// 커서 열 × 칸 폭에 놓임)가 커서 자리에 뜬다. Windows WebView2는 배율을 devicePixelRatio에 이미 넣는데 한 번 더 곱해서
// 배율만큼 어긋났다. 보기 메뉴 클릭(selftest_click_menu)이 맥에만 있어 웹뷰 배율을 직접 바꾼다.
async function testZoomIme(term: Terminal) {
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const zoom = async (z: number) => {
    setZoomFactor(z);
    await getCurrentWebview().setZoom(z);
  };
  const ta = term.textarea!;
  try {
    for (const z of [1.5, 0.8]) {
      const before = term.cols;
      await zoom(z);
      await waitFor("칸 수 바뀜", () => term.cols !== before, 3000).catch(() => null);
      await sleep(300);
      const d = (term as unknown as { _core: { _renderService: { dimensions: { css: { cell: { width: number } }; device: { cell: { width: number } } } } } })._core._renderService.dimensions;
      const canvas = term.element!.querySelector<HTMLCanvasElement>(".xterm-screen > canvas:not(.xterm-link-layer)")!;
      const shown = (d.device.cell.width * canvas.getBoundingClientRect().width) / canvas.width;
      ta.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: "한" }));
      const x = term.buffer.active.cursorX;
      const left = parseFloat(term.element!.querySelector<HTMLElement>(".composition-view")!.style.left);
      ta.dispatchEvent(new CompositionEvent("compositionend", { data: "" }));
      ta.value = "";
      check(
        `배율 ${z}: 터미널 칸 폭이 그려진 대로라 한글 조합 박스가 커서 자리에`,
        Math.abs(shown - d.css.cell.width) < 0.05 && Math.abs(left - x * shown) < 0.5,
        `dpr=${window.devicePixelRatio} cell=${d.css.cell.width} shown=${shown} x=${x} left=${left}`,
      );
    }
  } finally {
    await zoom(Number(localStorage.getItem("ddak.zoom") ?? 1));
  }
}

// 화면 배율: 보기 메뉴(⌘= ⌘- ⌘0)로 웹뷰 전체를 키우고 줄인다.
// 배율을 바꾸면 CSS 픽셀 기준 창 폭(innerWidth)이 반비례로 바뀌고, 터미널 칸 수도 따라 바뀐다.
async function testZoom(term: Terminal) {
  const width = window.innerWidth;
  const cols = term.cols;
  const zoomed = (z: number) => Math.abs(window.innerWidth - width / z) < 3;
  const viewMenu = await waitMenu((m) => m.includes("View/Zoom In"));
  check("배율: 보기 메뉴에 확대·축소·실제 크기", ["View/Zoom In", "View/Zoom Out", "View/Actual Size"].every((x) => viewMenu.includes(x)));

  await clickMenu("View", "Zoom In");
  await waitFor("확대", () => zoomed(1.1), 3000).then(
    () => check("배율: 확대하면 화면 전체가 1.1배", true),
    (e) => check("배율: 확대하면 화면 전체가 1.1배", false, `${String(e)} ${window.innerWidth} vs ${width}`),
  );
  await waitFor("터미널 칸 수 줄어듦", () => term.cols < cols, 3000).then(
    () => check("배율: 확대하면 터미널 글자도 커짐 (칸 수 줄어듦)", true, `${term.cols} < ${cols}`),
    (e) => check("배율: 확대하면 터미널 글자도 커짐 (칸 수 줄어듦)", false, String(e)),
  );
  // 번짐 방지: 화면에 보이는 터미널 캔버스의 크기(CSS 크기 × 배율 × 화면 픽셀 비율)가 캔버스 픽셀 수와 똑같고, 위치가 화면
  // 픽셀 경계에 있어야 늘어나거나 밀리지 않고 그려진다 (src/zoom.ts alignToPixels. 전에는 1~2픽셀 어긋나도 통과시켰다).
  const sharp = () => {
    const canvas = term.element!.querySelector<HTMLCanvasElement>(".xterm-screen > canvas:not(.xterm-link-layer)");
    if (!canvas) return "WebGL 캔버스 없음";
    const k = Number(localStorage.getItem("ddak.zoom") ?? 1) * screenPixelRatio();
    const r = canvas.getBoundingClientRect();
    const off = (x: number) => Math.abs(x - Math.round(x)) > 0.02;
    const bad = Math.abs(r.width * k - canvas.width) > 0.02 || Math.abs(r.height * k - canvas.height) > 0.02 || off(r.left * k) || off(r.top * k);
    const f = (x: number) => (x * k).toFixed(2);
    return bad ? `canvas ${canvas.width}x${canvas.height}, shown ${f(r.width)}x${f(r.height)} at ${f(r.left)},${f(r.top)}` : "";
  };
  await waitFor("캔버스 해상도", () => sharp() === "", 3000).then(
    () => check("배율: 터미널 캔버스가 배율만큼 높은 해상도로 그려짐 (번지지 않음)", true),
    () => check("배율: 터미널 캔버스가 배율만큼 높은 해상도로 그려짐 (번지지 않음)", false, sharp()),
  );
  // 리뷰 지적 3: 모니터 변경 감지는 실제 화면 비율 기준 쿼리여야 한다 (덮어쓴 값의 쿼리는 늘 안 맞음).
  const q = (v: number) => matchMedia(`screen and (resolution: ${v}dppx)`).matches;
  check("배율: CSS 해상도는 실제 화면 비율을 따름 (모니터 감시는 실제 값으로)", q(screenPixelRatio()) && !q(window.devicePixelRatio), `real=${screenPixelRatio()} dpr=${window.devicePixelRatio}`);
  const size = await run(term, "stty size");
  check("배율: 바뀐 칸 수가 PTY에 반영", size.some((l) => l.trim() === `${term.rows} ${term.cols}`), size.join("|"));
  check("배율: 저장", localStorage.getItem("ddak.zoom") === "1.1");

  await clickMenu("View", "Zoom Out");
  await clickMenu("View", "Zoom Out");
  await waitFor("축소", () => zoomed(0.9), 3000).then(
    () => check("배율: 축소 두 번이면 0.9배", localStorage.getItem("ddak.zoom") === "0.9"),
    (e) => check("배율: 축소 두 번이면 0.9배", false, `${String(e)} ${window.innerWidth} vs ${width}`),
  );
  await waitFor("0.9 해상도", () => sharp() === "", 3000).then(
    () => check("배율: 축소해도 해상도 맞춤", true),
    () => check("배율: 축소해도 해상도 맞춤", false, sharp()),
  );
  // 2배: 줄 높이가 커서 마지막 줄 아래 남는 공간이 크다. 그 공간(xterm-viewport)이 테마 배경색이어야 한다.
  // xterm.css가 이 배경을 #000으로 고정해 둬서, 밝은 테마에서 검은 띠로 보였다.
  for (let i = 0; i < 6; i++) await clickMenu("View", "Zoom In");
  await waitFor("2배", () => zoomed(2) && sharp() === "", 3000).then(
    () => check("배율: 최대 2배에서도 해상도 맞춤", localStorage.getItem("ddak.zoom") === "2"),
    () => check("배율: 최대 2배에서도 해상도 맞춤", false, `${localStorage.getItem("ddak.zoom")} ${sharp()}`),
  );
  const pane = term.element!.closest(".pane")!.getBoundingClientRect();
  const gap = pane.bottom - term.element!.querySelector(".xterm-screen")!.getBoundingClientRect().bottom;
  const below = document.elementFromPoint(pane.left + pane.width / 2, pane.bottom - 3)!;
  check(
    "배율: 마지막 줄 아래 빈 공간도 터미널 배경색",
    gap > 5 && below.classList.contains("xterm-viewport") && getComputedStyle(below).backgroundColor === "rgb(31, 31, 31)",
    `gap=${Math.round(gap)} ${below.className} ${getComputedStyle(below).backgroundColor}`,
  );
  for (let i = 0; i < 10; i++) await clickMenu("View", "Zoom Out");
  await waitFor("최소 배율", () => zoomed(0.5), 3000).then(
    () => check("배율: 최소 0.5배에서 멈춤", localStorage.getItem("ddak.zoom") === "0.5"),
    (e) => check("배율: 최소 0.5배에서 멈춤", false, `${String(e)} ${localStorage.getItem("ddak.zoom")}`),
  );
  // 모든 배율에서 화면 픽셀에 맞음 (배율이 정수가 아니면 xterm이 반올림한 CSS 크기 때문에 어긋났다)
  const blurry: string[] = [];
  for (const z of ZOOM_LEVELS) {
    if (z > 0.5) await clickMenu("View", "Zoom In");
    await waitFor(`${z}배`, () => zoomed(z) && sharp() === "", 3000).catch(() => blurry.push(`${z}: ${localStorage.getItem("ddak.zoom")} ${sharp()}`));
  }
  check("배율: 0.5~2배 모든 단계에서 캔버스가 화면 픽셀에 맞음 (번지지 않음)", blurry.length === 0, blurry.join(" | "));

  await clickMenu("View", "Actual Size");
  await waitFor("원래 크기", () => zoomed(1) && term.cols === cols, 3000).then(
    () => check("배율: 실제 크기로 돌아오면 화면·터미널 원래대로", localStorage.getItem("ddak.zoom") === "1" && sharp() === "", sharp()),
    (e) => check("배율: 실제 크기로 돌아오면 화면·터미널 원래대로", false, `${String(e)} ${window.innerWidth}/${width} ${term.cols}/${cols}`),
  );
}

async function testTabsAndSplits(root: string, first: Terminal) {
  await run(first, "echo FIRST_TAB_MARK");
  const fullCols = first.cols;

  // 새 탭
  await menu("new_tab");
  await waitFor("새 탭", () => tabCount() === 2);
  // 빈 배열도 참이라 창 수까지 본다 (새 창의 xterm이 등록되기 전에는 목록이 비어 있다)
  const [second] = await waitFor("새 탭 터미널", () => visiblePanes().length === 1 && visiblePanes()[0].term !== first && visiblePanes());
  check("탭: ⌘T로 새 탭이 열리고 활성화", activeTabIndex() === 1 && visiblePanes().length === 1);
  await waitFor("새 탭 포커스", () => document.activeElement === second.term.textarea, 3000).then(
    () => check("탭: 새 터미널에 포커스", true),
    (e) => check("탭: 새 터미널에 포커스", false, String(e)),
  );
  await ready(second.term);
  const pwd = await run(second.term, "pwd");
  check("탭: 새 탭도 루트에서 시작", pwd.some((l) => l.trim() === root), pwd.join("|"));
  // 세션이 아닌 창은 Shift+Enter를 xterm이 바로 보내지 않고, 앞에서 도는 프로그램을 보고 고른다 (셸이면 Enter, Vim 등도 그대로.
  // 리뷰 지적 7). 실제로 무엇이 가는지는 testProgramShiftEnter가 본다.
  const se = keySends(second.term, { key: "Enter", shiftKey: true });
  check("탭: 세션이 아닌 창의 ⇧↩는 앞의 프로그램을 보고 따로 보냄 (xterm이 바로 보내지 않음)", se === "", JSON.stringify(se));

  // 오른쪽 분할
  await menu("split_right");
  const row = await waitFor("오른쪽 분할", () => visiblePanes().length === 2 && visiblePanes());
  const body = document.querySelector<HTMLElement>(".tab-body:not([style*='none'])")!.getBoundingClientRect();
  check(
    "분할: ⌘D로 좌우 반반",
    near(row[0].rect.width / body.width, 0.5) && near(row[1].rect.left - body.left, body.width / 2),
    `${Math.round(row[0].rect.width)}/${Math.round(body.width)}`,
  );
  await waitFor("분할 후 폭 맞춤", () => row[0].term.cols < fullCols * 0.6 && row[1].term.cols < fullCols * 0.6);
  check("분할: 두 터미널 모두 폭이 줄어듦", true, `${row[0].term.cols}, ${row[1].term.cols} < ${fullCols}`);
  await ready(row[1].term);
  check("분할: 새 터미널에 포커스", document.activeElement === row[1].term.textarea);
  const sz = await run(row[0].term, "stty size");
  check("분할: 줄어든 크기가 PTY에 반영", sz.some((l) => l.trim() === `${row[0].term.rows} ${row[0].term.cols}`), sz.join("|"));

  // 아래 분할 (포커스된 오른쪽 터미널을 위아래로)
  await menu("split_down");
  const three = await waitFor("아래 분할", () => visiblePanes().length === 3 && visiblePanes());
  const [left, rightTop, rightBottom] = [three.find((p) => p.term === row[0].term)!, three.find((p) => p.term === row[1].term)!, three.find((p) => p.term !== row[0].term && p.term !== row[1].term)!];
  check(
    "분할: ⇧⌘D로 오른쪽이 위아래로 나뉨",
    near(rightTop.rect.left, rightBottom.rect.left) && rightBottom.rect.top > rightTop.rect.top && near(left.rect.height / body.height, 1),
  );

  // 구분선 끌기: 왼쪽 터미널을 30%로
  const divider = document.querySelector<HTMLElement>(".tab-body:not([style*='none']) .divider.row")!;
  divider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: body.left + body.width / 2, clientY: body.top + 10 }));
  window.dispatchEvent(new PointerEvent("pointermove", { buttons: 1, clientX: body.left + body.width * 0.3, clientY: body.top + 10 }));
  window.dispatchEvent(new PointerEvent("pointerup", {}));
  await waitFor("구분선 이동", () => near(left.el.getBoundingClientRect().width / body.width, 0.3)).then(
    () => check("분할: 구분선을 끌면 크기 변경", true),
    (e) => check("분할: 구분선을 끌면 크기 변경", false, String(e)),
  );

  // 포커스 유지 (리뷰 지적 1)
  const tabs = () => document.querySelectorAll<HTMLElement>(".tab");
  check("포커스: 활성 탭 mousedown 기본 동작 막음", mouseDown(tabs()[1]));
  check("포커스: 비활성 탭 × mousedown 기본 동작 막음", mouseDown(tabs()[0].querySelector(".tab-close")!));
  check("포커스: 탭 바 버튼 mousedown 기본 동작 막음", [...document.querySelectorAll(".tabbar-btn")].every(mouseDown));
  check("포커스: 구분선 mousedown 기본 동작 막음", mouseDown(divider));
  blur();
  mouseDown(tabs()[1]);
  check("포커스: 활성 탭을 누르면 포커스된 터미널로 복원", document.activeElement === rightBottom.term.textarea);
  blur();
  check("포커스: 터미널 여백 mousedown 기본 동작 막음", mouseDown(left.el));
  check("포커스: 터미널 여백을 누르면 그 터미널로", document.activeElement === left.term.textarea);
  await waitFor("포커스 상태", () => left.el.classList.contains("focused")).then(
    () => check("포커스: 여백 클릭이 포커스 상태(테두리)에도 반영", true),
    (e) => check("포커스: 여백 클릭이 포커스 상태(테두리)에도 반영", false, String(e)),
  );
  mouseDown(rightBottom.el); // 아래 닫기 테스트를 위해 되돌린다
  await waitFor("포커스 되돌리기", () => rightBottom.el.classList.contains("focused"));

  // 탭 전환: 숨겨져 있던 첫 탭의 셸이 살아 있고 내용도 그대로여야 한다.
  key("1", "Digit1");
  await waitFor("⌘1", () => activeTabIndex() === 0);
  check("탭: ⌘1로 첫 탭", visiblePanes()[0]?.term === first);
  check("탭: 전환해도 이전 출력 유지", screen(first).some((l) => l.trim() === "FIRST_TAB_MARK"));
  await waitFor("첫 탭 폭 복원", () => first.cols === fullCols).then(
    () => check("탭: 다시 보이면 폭 복원", true),
    () => check("탭: 다시 보이면 폭 복원", false, `${first.cols} vs ${fullCols}`),
  );
  const alive = await run(first, "echo alive");
  check("탭: 숨겨졌던 셸도 살아 있음", alive.some((l) => l.trim() === "alive"));
  key("}", "BracketRight", true);
  await waitFor("⇧⌘]", () => activeTabIndex() === 1).then(
    () => check("탭: ⇧⌘]로 다음 탭", true),
    (e) => check("탭: ⇧⌘]로 다음 탭", false, String(e)),
  );

  // 닫기: ⌘W는 포커스된 터미널만, exit도 그 터미널만, 마지막 터미널을 닫으면 탭이 닫힌다.
  await menu("close_pane");
  await waitFor("⌘W", () => visiblePanes().length === 2).then(
    () => check("닫기: ⌘W는 포커스된 터미널만 닫음", !visiblePanes().some((p) => p.term === rightBottom.term)),
    (e) => check("닫기: ⌘W는 포커스된 터미널만 닫음", false, String(e)),
  );
  rightTop.term.input("exit\r");
  await waitFor("exit", () => visiblePanes().length === 1).then(
    () => check("닫기: exit 하면 그 터미널이 닫힘", visiblePanes()[0].term === left.term),
    (e) => check("닫기: exit 하면 그 터미널이 닫힘", false, String(e)),
  );
  check("닫기: 남은 터미널이 전체를 차지", near(visiblePanes()[0].rect.width / body.width, 1));
  await menu("close_pane");
  await waitFor("마지막 터미널 닫기", () => tabCount() === 1).then(
    () => check("닫기: 마지막 터미널을 닫으면 탭도 닫히고 남은 탭으로", activeTabIndex() === 0 && visiblePanes()[0]?.term === first),
    (e) => check("닫기: 마지막 터미널을 닫으면 탭도 닫히고 남은 탭으로", false, String(e)),
  );

  // 탭의 × 버튼
  await menu("new_tab");
  await waitFor("새 탭", () => tabCount() === 2);
  document.querySelectorAll<HTMLElement>(".tab-close")[1].click();
  await waitFor("× 닫기", () => tabCount() === 1).then(
    () => check("닫기: 탭의 ×로 탭 닫기", true),
    (e) => check("닫기: 탭의 ×로 탭 닫기", false, String(e)),
  );

  // 닫은 터미널의 셸이 좀비로 남지 않아야 한다. 셸의 부모가 ddak 프로세스다.
  await sleep(1000);
  const zombies = await run(first, "ps -A -o stat=,ppid= | awk -v p=$PPID '$1 ~ /^Z/ && $2 == p' | wc -l");
  check("닫기: 좀비 프로세스 없음", zombies.some((l) => l.trim() === "0"), zombies.join("|"));
}

// .xterm-screen 바로 아래 캔버스 중 링크 표시용(2D)을 뺀 것이 WebGL 렌더러의 캔버스다.
// getContext를 아무 캔버스에나 부르면 새 컨텍스트가 생기므로 위치로 골라서 부른다.
const webglState = (term: Terminal) => {
  const canvas = term.element!.querySelector<HTMLCanvasElement>(".xterm-screen > canvas:not(.xterm-link-layer)");
  const gl = canvas?.getContext("webgl2");
  return { gl, dom: term.element!.querySelector(".xterm-rows") };
};

// WebGL 컨텍스트를 강제로 잃게 해서 기본 렌더러로 넘어가는지 본다 (리뷰 지적 2)
async function testWebglLoss(term: Terminal) {
  const before = webglState(term);
  if (!before.gl || before.dom) {
    check("WebGL: 처음에는 WebGL 렌더러 사용", false, `gl=${!!before.gl} dom=${!!before.dom}`);
    return;
  }
  check("WebGL: 처음에는 WebGL 렌더러 사용", true);
  // 이미 컨텍스트를 잃었으면 (WebKit이 페이지당 컨텍스트 수 제한으로 오래된 것을 거둔다) getExtension이 null이다
  // (WebGL 규격). 그때는 강제로 잃게 하지 않고 그 손실로 전환을 본다. 확장이 정말 없으면 예외 대신 진단을 남긴다.
  const alreadyLost = before.gl.isContextLost();
  const lose = alreadyLost ? null : before.gl.getExtension("WEBGL_lose_context");
  if (!alreadyLost && !lose) {
    check("WebGL: 컨텍스트를 강제로 잃게 하는 확장", false, `terms=${liveTerms.size}`);
    return;
  }
  lose?.loseContext();
  if (alreadyLost) log.push(`INFO  WebGL: 컨텍스트를 이미 잃은 상태라 강제 손실을 건너뜀 (terms=${liveTerms.size})`);
  // xterm은 3초 동안 복구를 기다린 뒤 onContextLoss를 보낸다.
  await waitFor("기본 렌더러 전환", () => webglState(term).dom, 8000).then(
    () => check("WebGL: 컨텍스트를 잃으면 기본 렌더러로 전환", true),
    (e) => check("WebGL: 컨텍스트를 잃으면 기본 렌더러로 전환", false, String(e)),
  );
  await run(term, "echo AFTER_LOSS");
  // 버퍼에 들어온 뒤 DOM 렌더러가 다음 화면 갱신 때 그리므로 기다린다.
  const rows = () => term.element!.querySelector(".xterm-rows")?.textContent ?? "";
  await waitFor("DOM에 그려짐", () => rows().includes("AFTER_LOSS"), 10000).then(
    () => check("WebGL: 전환 후에도 새 출력이 화면에 그려짐", true),
    async (e) => check("WebGL: 전환 후에도 새 출력이 화면에 그려짐", false, `${e} ${await frameInfo()}`),
  );
}

// 터미널을 많이 열어도 모두 그려지는지 본다. WebKit은 페이지당 WebGL 컨텍스트 수에 제한이 있다.
async function testManyTerminals(count: number) {
  const startTabs = tabCount();
  for (let i = 0; i < count; i++) {
    await menu("new_tab");
    await waitFor("새 탭", () => tabCount() === startTabs + i + 1);
  }
  await sleep(4000); // 잃은 컨텍스트가 있다면 onContextLoss까지 기다린다
  const terms = [...liveTerms.values()];
  const states = terms.map(webglState);
  const webgl = states.filter((st) => st.gl && !st.gl.isContextLost() && !st.dom).length;
  const dom = states.filter((st) => st.dom).length;
  const broken = terms.length - webgl - dom;
  log.push(`INFO  터미널 ${terms.length}개: WebGL ${webgl}, 기본 렌더러 ${dom}, 멈춤 ${broken}`);
  check(`많은 터미널: ${terms.length}개 모두 그려짐`, broken === 0);
  for (let i = 0; i < count; i++) await menu("close_pane");
  await waitFor("탭 정리", () => tabCount() === startTabs, 15000);
}

// 프로젝트 두 개 사이를 오간다. 각 프로젝트의 터미널은 따로 살아 있어야 한다.
async function testProjects(root: string, first: Terminal) {
  const other = root.replace(/\/proj$/, "/other");
  // 저장한 상태를 읽는 동안에는 새 작업그룹을 만들지 않는다 (만들어도 결과를 읽은 상태가 덮는다. 리뷰 P2).
  // other에는 저장소가 없어서 만들기를 부르면 "저장소 없음" 오류가 난다.
  devHooks.workspaceLoad = () => new Promise((r) => setTimeout(() => r(null), 1500));
  // 채팅 패널은 이벤트를 등록한 뒤 처음 상태를 읽는다 (리뷰 P2: 그 사이 온 메시지를 놓쳤다). 등록을 늦추고 그 사이 보낸다.
  devHooks.chatListenDelay = 1500;
  await devHooks.addProject!(other);
  const otherChat = () => document.querySelector<HTMLElement>(`.project-workspace[data-project="${CSS.escape(other)}"] .chat-panel`);
  const otherBtn = await waitFor("두 번째 프로젝트 탭 바", () => document.querySelector<HTMLElement>(`.project-workspace[data-project="${CSS.escape(other)}"] [data-action=new-group]`));
  otherBtn.click();
  devHooks.workspaceLoad = undefined;
  // 패널이 뜬 뒤 등록하기 전 (1.5초 안)에 보낸다
  await waitFor("두 번째 프로젝트 채팅 패널", otherChat, 1000);
  // 사용자 메시지는 받을 참여자가 있어야 보낸다 (터미널 없이 넣는다. 아래 "@all after removal"까지 둔다)
  const reader = await invoke<string>("selftest_chat_join", { project: other, name: "origin/reader" });
  await invoke("chat_post", { project: other, text: "@all early message" });
  devHooks.chatListenDelay = undefined;
  await waitFor("처음 읽기 전에 온 메시지", () => [...otherChat()!.querySelectorAll(".chat-text")].some((el) => el.textContent === "@all early message"), 4000).then(
    () => check("채팅 패널: 이벤트를 등록하기 전에 온 메시지도 보임", true),
    () => check("채팅 패널: 이벤트를 등록하기 전에 온 메시지도 보임", false, otherChat()!.textContent ?? ""),
  );
  await waitFor("읽기 끝", () => tabsIn(other) === 1, 5000);
  await sleep(500);
  const noRepos = [...document.querySelectorAll(".sidebar-error")].some((e) => e.textContent?.includes("no git repository"));
  check("프로젝트: 저장한 상태를 읽는 동안 새 작업그룹은 만들지 않음", !noRepos);
  await waitFor("두 번째 프로젝트 활성", () => projectRow(other)?.classList.contains("active"));
  // other를 나중에 넣었지만 이름순이라 앞이다
  check("프로젝트: 이름순 목록", projectRows().map((el) => el.dataset.project).join(",") === `${other},${root}`, projectRows().map((el) => el.dataset.project).join(","));
  check("프로젝트: 이전 프로젝트는 활성 해제", !projectRow(root)!.classList.contains("active"));
  const [o] = await waitFor("두 번째 프로젝트 터미널", () => visiblePanes().length === 1 && visiblePanes()[0].term !== first && visiblePanes());
  await ready(o.term);
  const pwd = await run(o.term, "pwd");
  check("프로젝트: 터미널이 그 프로젝트 폴더에서 시작", pwd.some((l) => l.trim() === other), pwd.join("|"));
  check("프로젝트: 이전 프로젝트 터미널은 숨겨짐", !visiblePanes().some((p) => p.term === first));
  await waitFor("두 번째 프로젝트 포커스", () => document.activeElement === o.term.textarea, 3000).then(
    () => check("프로젝트: 옮겨 간 프로젝트의 터미널에 포커스", true),
    (e) => check("프로젝트: 옮겨 간 프로젝트의 터미널에 포커스", false, String(e)),
  );

  // 단축키는 보이는 프로젝트에만
  await menu("new_tab");
  await waitFor("새 탭", () => tabsIn(other) === 2).then(
    () => check("프로젝트: ⌘T는 보이는 프로젝트에만 탭 추가", tabsIn(root) === 1, `${tabsIn(root)}`),
    (e) => check("프로젝트: ⌘T는 보이는 프로젝트에만 탭 추가", false, String(e)),
  );
  await menu("close_pane");
  await waitFor("탭 닫기", () => tabsIn(other) === 1);
  check("프로젝트: ⌘W도 보이는 프로젝트에만", tabsIn(root) === 1);

  // 첫 프로젝트로 돌아가기
  projectRow(root)!.click();
  await waitFor("첫 프로젝트로", () => visiblePanes()[0]?.term === first);
  check("프로젝트: 행을 누르면 그 프로젝트로", projectRow(root)!.classList.contains("active"));
  await waitFor("첫 프로젝트 포커스", () => document.activeElement === first.textarea, 3000).then(
    () => check("프로젝트: 돌아오면 그 터미널에 포커스", true),
    (e) => check("프로젝트: 돌아오면 그 터미널에 포커스", false, String(e)),
  );
  const alive = await run(first, "echo alive");
  check("프로젝트: 숨겨졌던 셸도 살아 있음", alive.some((l) => l.trim() === "alive"));

  await devHooks.addProject!(root);
  check("프로젝트: 같은 폴더는 다시 추가되지 않음", projectRows().length === 2);
  const store = await waitStore((s) => s.projects.length === 2 && s.active === root);
  check("프로젝트: 목록과 활성 프로젝트 저장", store.projects.map((p) => p.path).join(",") === `${other},${root}` && store.active === root, JSON.stringify(store));

  // 대소문자 무시: 대문자로 시작하는 Zeta도 소문자 이름들 뒤 (글자 코드 순이면 맨 앞)
  const zeta = root.replace(/\/proj$/, "/Zeta");
  await run(first, `mkdir -p '${zeta}'`);
  await devHooks.addProject!(zeta, false);
  await waitFor("Zeta 추가", () => projectRow(zeta));
  check("프로젝트: 이름순은 대소문자 무시", projectRows().map((el) => el.dataset.project).join(",") === `${other},${root},${zeta}`, projectRows().map((el) => el.dataset.project).join(","));
  projectRow(zeta)!.querySelector<HTMLElement>("[data-action=remove]")!.click();
  await waitFor("Zeta 빼기", () => !projectRow(zeta));
  await waitStore((s) => s.projects.length === 2);

  // 화살표는 접고 펼치기만, 활성 프로젝트는 그대로
  // other는 빈 폴더라 펼쳐도 행이 없다. 화살표 모양으로 본다.
  const twisty = (path: string) => projectRow(path)!.querySelector<HTMLElement>(".tree-twisty")!;
  const otherWas = twisty(other).dataset.open;
  twisty(other).click();
  await waitFor("두 번째 프로젝트 접고 펼치기", () => twisty(other).dataset.open !== otherWas);
  check("프로젝트: 화살표로는 활성 프로젝트가 바뀌지 않음", projectRow(root)!.classList.contains("active"));
  projectRow(root)!.querySelector<HTMLElement>(".tree-twisty")!.click();
  await waitFor("첫 프로젝트 접기", () => !rowNames().includes("server"));
  check("프로젝트: 화살표로 접힘", true);
  projectRow(root)!.querySelector<HTMLElement>(".tree-twisty")!.click();
  await waitFor("첫 프로젝트 펼치기", () => rowNames().includes("server"));
  check("프로젝트: 화살표로 다시 펼침", true);

  // 열려 있는 프로젝트를 제거하면 먼저 묻는다
  projectRow(other)!.click();
  await waitFor("두 번째 프로젝트로", () => visiblePanes()[0]?.term === o.term);
  const realConfirm = devHooks.confirm;
  let asked = "";
  devHooks.confirm = async (m) => ((asked = m), false);
  projectRow(other)!.querySelector<HTMLElement>("[data-action=remove]")!.click();
  await waitFor("확인 질문", () => asked);
  await sleep(200);
  check("프로젝트: 열린 프로젝트 제거 전에 확인", asked.includes("other") && !!projectRow(other), asked);
  devHooks.confirm = async () => true;
  projectRow(other)!.querySelector<HTMLElement>("[data-action=remove]")!.click();
  await waitFor("제거", () => !projectRow(other));
  devHooks.confirm = realConfirm;
  check("프로젝트: 제거하면 터미널도 닫힘", ![...liveTerms.values()].includes(o.term) && !document.querySelector(`.project-workspace[data-project="${CSS.escape(other)}"]`));
  await waitFor("남은 프로젝트로", () => visiblePanes()[0]?.term === first).then(
    () => check("프로젝트: 활성 프로젝트를 제거하면 남은 프로젝트로", projectRow(root)!.classList.contains("active")),
    (e) => check("프로젝트: 활성 프로젝트를 제거하면 남은 프로젝트로", false, String(e)),
  );
  const after = await waitStore((s) => s.projects.length === 1);
  check("프로젝트: 제거도 저장", after.projects.map((p) => p.path).join(",") === root && after.active === root, JSON.stringify(after));

  const data = root.replace(/\/proj$/, "/data-main");
  const stateFile = `"${data}"/workspaces/other-*.json`;
  const savedTabs = async () =>
    (await run(first, `python3 -c 'import json,glob;print("SAVED", len(json.load(open(glob.glob("${data}/workspaces/other-*.json")[0]))["tabs"]))'`))
      .map((l) => l.trim())
      .find((l) => l.startsWith("SAVED ")) ?? "SAVED none";
  const removeOther = async () => {
    devHooks.confirm = async () => true;
    projectRow(other)!.querySelector<HTMLElement>("[data-action=remove]")!.click();
    await waitFor("빼기", () => !projectRow(other));
    devHooks.confirm = realConfirm;
  };

  // 정리된 Workspace의 읽기는 파일을 치우지 않는다 (리뷰 후속 P2): 개발 모드는 효과를 두 번 돌린다. 첫 읽기를 늦추고
  // 모양이 틀린 내용을 돌려주면, 남은 Workspace의 읽기만 파일을 한 번 치우고 새로 저장해야 한다 (파일이 남아 있음).
  let loads = 0;
  devHooks.workspaceLoad = () => (loads++ === 0 ? new Promise((r) => setTimeout(() => r('{"version":99}'), 1500)) : Promise.resolve('{"version":99}'));
  await devHooks.addProject!(other);
  await waitFor("다시 열림", () => tabsIn(other) === 1, 5000);
  await sleep(2500);
  devHooks.workspaceLoad = undefined;
  const files = (await run(first, `ls "${data}/workspaces" | grep -c '^other-.*\\.json$'; ls "${data}/workspaces" | grep -c '^other-.*\\.json\\.bad$'`)).map((l) => l.trim()).filter((l) => /^\d+$/.test(l));
  const loadError = [...document.querySelectorAll(".sidebar-error")].some((e) => e.textContent?.startsWith("Could not read the saved tabs"));
  check("프로젝트: 정리된 Workspace의 늦은 읽기는 파일을 치우지 않음", files.join(",") === "1,1" && !loadError, `${files.join(",")} ${loadError}`);

  // 이전 Workspace의 늦은 저장이 새 Workspace의 상태를 덮지 않는다 (리뷰 후속 P2): 첫 저장을 늦춘 채 탭을 둘 더 열고 바로
  // 뺐다가 다시 넣는다. 새 Workspace는 이전 저장이 끝난 뒤에 읽으므로 탭 셋으로 열리고, 그 뒤 저장도 덮이지 않는다.
  let saves = 0;
  devHooks.workspaceSaveDelay = () => (saves++ === 0 ? 1500 : 0);
  await menu("new_tab");
  await waitFor("탭 둘", () => tabsIn(other) === 2);
  await menu("new_tab");
  await waitFor("탭 셋", () => tabsIn(other) === 3);
  await removeOther();
  await devHooks.addProject!(other);
  await waitFor("이전 마지막 상태로", () => tabsIn(other) === 3, 5000).catch(() => {});
  const reopened = tabsIn(other);
  await menu("new_tab");
  await waitFor("탭 넷", () => tabsIn(other) === reopened + 1);
  await sleep(2500);
  devHooks.workspaceSaveDelay = undefined;
  const onDisk = await savedTabs();
  check("프로젝트: 다시 연 Workspace는 이전 저장 뒤에 읽고, 그 뒤 저장이 덮이지 않음", reopened === 3 && onDisk === `SAVED ${tabsIn(other)}`, `${reopened} ${onDisk} ${tabsIn(other)}`);
  await removeOther();

  // 목록에서 빼도 상태는 남는다. 다시 넣을 때 읽기가 실패하면 기본으로 열되 저장하지 않는다 (리뷰 P1: 덮어썼다)
  const hash = async () => (await run(first, `shasum ${stateFile} | cut -c1-12`)).map((l) => l.trim()).find((l) => /^[0-9a-f]{12}$/.test(l)) ?? "none";
  const before = await hash();
  devHooks.workspaceLoad = () => Promise.reject("injected read failure");
  await devHooks.addProject!(other);
  const failed = await waitFor("읽기 실패 알림", () => [...document.querySelectorAll(".sidebar-error")].find((e) => e.textContent?.startsWith("Could not read the saved tabs")), 5000).catch(() => null);
  devHooks.workspaceLoad = undefined;
  await waitFor("기본으로 열림", () => tabsIn(other) === 1, 5000);
  await menu("new_tab");
  await waitFor("탭 추가", () => tabsIn(other) === 2);
  await sleep(1000);
  check("프로젝트: 저장한 상태를 읽지 못하면 알리고, 그 상태를 덮어쓰지 않음", !!failed && before !== "none" && (await hash()) === before, `${before} ${failed?.textContent}`);
  await removeOther();

  // 채팅 이벤트 등록이 하나만 실패해도 (chat-members) 처음 읽기는 하고 오류를 보이며, 성공한 등록(chat)은 풀어서 패널이
  // 사라진 뒤 남지 않는다 (리뷰 후속 P2)
  devHooks.chatListenFail = "chat-members";
  await devHooks.addProject!(other);
  const otherPanel = () => document.querySelector<HTMLElement>(`.project-workspace[data-project="${CSS.escape(other)}"] .chat-panel`);
  const shownError = await waitFor("등록 실패 알림", () => otherPanel()?.querySelector("[data-listen-error]"), 5000).catch(() => null);
  const firstRead = await waitFor("처음 읽기", () => [...(otherPanel()?.querySelectorAll(".chat-text") ?? [])].some((el) => el.textContent === "@all early message"), 3000).catch(() => false);
  devHooks.chatListenFail = undefined;
  await removeOther();
  await sleep(300);
  const reads = () => devHooks.chatLoads?.[other] ?? 0;
  const readsBefore = reads();
  await invoke("chat_post", { project: other, text: "@all after removal" });
  await invoke("selftest_chat_leave", { token: reader });
  await sleep(500);
  check(
    "채팅 패널: 이벤트 등록이 일부 실패하면 알리고 처음 읽기는 하고, 사라진 뒤 남은 리스너가 없음",
    !!shownError && !!firstRead && readsBefore > 0 && reads() === readsBefore,
    `${shownError?.textContent} ${firstRead} ${readsBefore}→${reads()}`,
  );
  await waitFor("남은 프로젝트로", () => visiblePanes()[0]?.term === first);
}

// 터미널에서 바꾼 폴더 내용이 펼쳐진 트리에 바로 반영되는지 본다.
async function testWatch(root: string, term: Terminal) {
  // 트리가 감시하는 프로젝트 안 폴더만 본다 (앱 데이터 폴더는 작업그룹 설정 때문에 따로 감시된다)
  const watched = () => invoke<string[]>("selftest_watched").then((all) => all.filter((p) => p === root || p.startsWith(`${root}/`)));
  await run(term, "mkdir watched_new");
  await waitFor("새 폴더 표시", () => rowNames().includes("watched_new"), 3000).then(
    () => check("감시: 터미널에서 만든 폴더가 트리에 나타남", rowNames().indexOf("watched_new") < rowNames().indexOf("a.txt")),
    (e) => check("감시: 터미널에서 만든 폴더가 트리에 나타남", false, String(e)),
  );
  await run(term, "rmdir watched_new");
  await waitFor("지운 폴더 사라짐", () => !rowNames().includes("watched_new"), 3000).then(
    () => check("감시: 지운 폴더가 트리에서 사라짐", true),
    (e) => check("감시: 지운 폴더가 트리에서 사라짐", false, String(e)),
  );

  fileRow("A_dir")!.click();
  await waitFor("A_dir 펼치기", () => rowNames().includes("inner.txt"));
  await run(term, "touch A_dir/new.txt");
  await waitFor("하위 폴더 새 파일", () => rowNames().includes("new.txt"), 3000).then(
    () => check("감시: 펼친 하위 폴더도 반영", rowNames().indexOf("new.txt") === rowNames().indexOf("inner.txt") + 1),
    (e) => check("감시: 펼친 하위 폴더도 반영", false, String(e)),
  );
  check("감시: 펼친 폴더만 감시", (await watched()).join(",") === `${root},${root}/A_dir`, (await watched()).join(","));
  await run(term, "rm A_dir/new.txt");
  fileRow("A_dir")!.click();
  await waitFor("A_dir 접기", () => !rowNames().includes("inner.txt"));
  await sleep(200);
  check("감시: 접으면 감시 해제", (await watched()).join(",") === root, (await watched()).join(","));

  await run(term, "git init -q gitnew");
  await waitFor("새 저장소 아이콘", () => fileRow("gitnew")?.dataset.git === "repo", 3000).then(
    () => check("감시: git init 한 폴더에 저장소 아이콘", true),
    (e) => check("감시: git init 한 폴더에 저장소 아이콘", false, `${String(e)} git=${fileRow("gitnew")?.dataset.git}`),
  );
  await run(term, "rm -rf gitnew");
  await waitFor("새 저장소 지움", () => !fileRow("gitnew"), 3000);
}

// React가 관리하는 입력란은 value만 바꾸면 상태가 안 바뀐다. 네이티브 setter + input 이벤트로 넣는다.
function setInput(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
const modal = () => document.querySelector<HTMLFormElement>(".modal");
const modalInput = (name: string) => modal()!.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
const modalError = () => modal()?.querySelector(".modal-error")?.textContent ?? "";
const contextMenu = () => document.querySelector<HTMLElement>(".context-menu");
const menuLabels = () => [...document.querySelectorAll(".context-menu > *")].map((el) => (el.classList.contains("context-sep") ? "-" : el.textContent));
const rightClick = (el: Element) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
async function pickMenu(label: string) {
  const find = () => [...document.querySelectorAll<HTMLElement>(".context-item")].find((el) => el.textContent === label);
  const item = await waitFor(`메뉴 항목 ${label}`, find, 3000).catch(() => {
    throw new Error(`메뉴 항목 없음: ${label} (${menuLabels().join(",")})`);
  });
  item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  item.click();
  await waitFor("메뉴 닫힘", () => !contextMenu());
}
async function openAddRepo(root: string) {
  projectRow(root)!.querySelector<HTMLElement>("[data-action=add]")!.click();
  await waitFor("추가 메뉴", contextMenu);
  await pickMenu("Add Repository…");
  return waitFor("저장소 추가 창", modal);
}
async function submitModal() {
  const failures = modal()!.dataset.failures;
  modal()!.querySelector<HTMLButtonElement>("button[type=submit]")!.click();
  // 창이 닫히거나 새로 실패할 때까지 (이전 시도의 오류가 남아 있을 수 있다)
  await waitFor("저장소 추가 결과", () => !modal() || modal()!.dataset.failures !== failures, 30000);
}

async function testRepos(root: string, term: Terminal) {
  const base = root.replace(/\/proj$/, "");
  const linkedSrc = `${base}/linked`;

  // clone
  await openAddRepo(root);
  check("저장소: 추가 창이 열리고 입력란에 포커스", document.activeElement === modalInput("source"));
  setInput(modalInput("source"), "git@example.com:org/linked.git");
  check("저장소: URL에서 폴더 이름을 만듦", modalInput("name").value === "linked", modalInput("name").value);
  setInput(modalInput("source"), linkedSrc);
  setInput(modalInput("name"), "cloned");
  await submitModal();
  check("저장소: clone 하면 창이 닫힘", !modal(), modalError());
  await waitFor("clone 한 저장소 표시", () => fileRow("cloned")?.dataset.git === "repo", 3000).then(
    () => check("저장소: clone 한 저장소가 트리에 나타남", true),
    (e) => check("저장소: clone 한 저장소가 트리에 나타남", false, String(e)),
  );
  const log = await run(term, "git --no-pager -C cloned log --format=%s");
  check("저장소: clone 내용", log.some((l) => l.trim() === "init"), log.join("|"));

  await openAddRepo(root);
  setInput(modalInput("source"), `${base}/no-such-remote`);
  await submitModal();
  check("저장소: clone 실패는 창에 오류 표시", modalError().startsWith("git clone failed"), modalError());
  const leftover = await run(term, "test -e no-such-remote && echo left || echo none");
  check("저장소: 실패한 clone은 폴더를 남기지 않음", leftover.some((l) => l.trim() === "none"), leftover.join("|"));
  modal()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor("Esc로 닫기", () => !modal());
  check("저장소: Esc로 창 닫기", true);

  // 링크
  await openAddRepo(root);
  modal()!.querySelector<HTMLElement>("[data-mode=link]")!.click();
  await waitFor("연결 모드", () => modal()!.querySelector(".modal-hint"));
  setInput(modalInput("source"), `${base}/other`);
  await submitModal();
  check("저장소: 저장소가 아닌 폴더는 연결 안 됨", modalError().startsWith("Not a git repository"), modalError());
  setInput(modalInput("source"), linkedSrc);
  check("저장소: 폴더 경로에서 이름을 만듦", modalInput("name").value === "linked", modalInput("name").value);
  await submitModal();
  check("저장소: 연결하면 창이 닫힘", !modal(), modalError());
  const linked = await waitFor("연결한 저장소 표시", () => fileRow("linked"), 3000);
  check("저장소: 연결한 저장소에 저장소 아이콘과 링크 표시", linked.dataset.git === "repo" && linked.dataset.link === linkedSrc && !!linked.querySelector(".tree-link"), `${linked.dataset.git} ${linked.dataset.link}`);
  const target = await run(term, "readlink linked");
  check("저장소: 프로젝트 안에 링크 생성", target.some((l) => l.trim() === linkedSrc), target.join("|"));

  await openAddRepo(root);
  modal()!.querySelector<HTMLElement>("[data-mode=link]")!.click();
  setInput(modalInput("source"), linkedSrc);
  await submitModal();
  check("저장소: 같은 이름이 있으면 오류", modalError() === "“linked” already exists in this project.", modalError());
  modal()!.querySelector<HTMLElement>("button.secondary")!.click();
  await waitFor("취소로 닫기", () => !modal());

  // 링크로 연결한 폴더를 펼치면, 원래 위치에서 바꾼 내용도 반영된다 (실제 경로 ↔ 트리 경로 변환).
  linked.click();
  await run(term, `touch "${linkedSrc}/from_outside.txt"`);
  await waitFor("링크 폴더 감시", () => rowNames().includes("from_outside.txt"), 3000).then(
    () => check("감시: 링크로 연결한 폴더도 반영", true),
    (e) => check("감시: 링크로 연결한 폴더도 반영", false, String(e)),
  );
  fileRow("linked")!.click();
}

// 오른쪽 클릭 메뉴로 파일·폴더 만들기
async function testCreate(root: string, term: Terminal) {
  const treeInput = () => document.querySelector<HTMLInputElement>(".tree-input");
  const treeError = () => document.querySelector(".tree-input-row + .tree-error")?.textContent ?? "";
  const enter = (el: HTMLElement, key: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  const exists = async (test: string, path: string) => (await run(term, `test ${test} "${path}" && echo yes || echo no`)).some((l) => l.trim() === "yes");

  // + 버튼 메뉴와 프로젝트 오른쪽 클릭 메뉴
  projectRow(root)!.querySelector<HTMLElement>("[data-action=add]")!.click();
  await waitFor("+ 메뉴", contextMenu);
  check("만들기: + 메뉴 항목", menuLabels().join(",") === "New File…,New Folder…,-,Add Repository…", menuLabels().join(","));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await waitFor("Esc로 메뉴 닫기", () => !contextMenu());
  rightClick(projectRow(root)!);
  await waitFor("오른쪽 클릭 메뉴", contextMenu);
  check("만들기: 프로젝트 오른쪽 클릭 메뉴", menuLabels().join(",") === "New File…,New Folder…,-,Add Repository…,-,Work Group Setup…,-,Remove from List", menuLabels().join(","));
  document.querySelector<HTMLElement>(".panel")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await waitFor("바깥 클릭으로 메뉴 닫기", () => !contextMenu());
  check("만들기: 바깥을 누르면 메뉴 닫힘", true);

  // 프로젝트에 새 폴더
  rightClick(projectRow(root)!);
  await pickMenu("New Folder…");
  const input = await waitFor("이름 입력란", treeInput);
  check("만들기: 프로젝트 맨 위에 입력란, 포커스", document.activeElement === input && input.dataset.kind === "dir" && !!projectRow(root)!.nextElementSibling?.contains(input));
  setInput(input, "made_dir");
  enter(input, "Enter");
  await waitFor("새 폴더 표시", () => !treeInput() && rowNames().includes("made_dir"), 3000).then(
    () => check("만들기: 새 폴더가 트리에 나타남", rowNames().indexOf("made_dir") < rowNames().indexOf("a.txt")),
    (e) => check("만들기: 새 폴더가 트리에 나타남", false, String(e)),
  );
  check("만들기: 디스크에 폴더 생성", await exists("-d", `${root}/made_dir`));

  // 접힌 폴더에 새 파일 → 펼쳐지고 그 안에 생김
  rightClick(fileRow("A_dir")!);
  await pickMenu("New File…");
  const fileInput = await waitFor("파일 이름 입력란", treeInput);
  check("만들기: 접힌 폴더는 펼쳐지고 그 안에 입력란", rowNames().includes("inner.txt") && fileInput.dataset.kind === "file");
  setInput(fileInput, "made.txt");
  enter(fileInput, "Enter");
  await waitFor("새 파일 표시", () => !treeInput() && rowNames().includes("made.txt"), 3000).then(
    () => check("만들기: 폴더 안에 새 파일", rowNames().indexOf("made.txt") > rowNames().indexOf("A_dir") && rowNames().indexOf("made.txt") < rowNames().indexOf("b_dir")),
    (e) => check("만들기: 폴더 안에 새 파일", false, String(e)),
  );
  check("만들기: 디스크에 파일 생성", await exists("-f", `${root}/A_dir/made.txt`));
  fileRow("A_dir")!.click();

  // 한글 조합을 확정하는 Enter는 만들기가 아니다 (리뷰 지적 5). WebKit은 isComposing 대신 keyCode 229만 주기도 한다.
  rightClick(fileRow("z.txt")!);
  await pickMenu("New File…");
  const ime = await waitFor("입력란", treeInput);
  setInput(ime, "한글");
  ime.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
  const enter229 = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
  Object.defineProperty(enter229, "keyCode", { get: () => 229 });
  ime.dispatchEvent(enter229);
  await sleep(300);
  check("만들기: 한글 조합 확정 Enter로는 만들지 않음", treeInput() === ime && !(await exists("-e", `${root}/한글`)));
  enter(ime, "Enter");
  await waitFor("조합 뒤 Enter로 만들기", () => !treeInput() && rowNames().includes("한글"), 3000).then(
    () => check("만들기: 조합이 끝난 뒤 Enter로 만듦 (한글 이름)", true),
    (e) => check("만들기: 조합이 끝난 뒤 Enter로 만듦 (한글 이름)", false, String(e)),
  );
  await run(term, "rm 한글");

  // 파일을 오른쪽 클릭하면 그 파일이 든 폴더에. 이미 있는 이름·잘못된 이름은 입력란에 오류
  rightClick(fileRow("z.txt")!);
  await pickMenu("New File…");
  const again = await waitFor("입력란", treeInput);
  setInput(again, "a.txt");
  enter(again, "Enter");
  await waitFor("이미 있음 오류", treeError).then(
    () => check("만들기: 이미 있는 이름은 오류, 입력란 유지", treeError() === "“a.txt” already exists here." && treeInput() === again),
    (e) => check("만들기: 이미 있는 이름은 오류, 입력란 유지", false, String(e)),
  );
  setInput(again, "x/y");
  check("만들기: 고치면 오류 사라짐", treeError() === "");
  enter(again, "Enter");
  await waitFor("잘못된 이름 오류", treeError).then(
    () => check("만들기: “/” 들어간 이름은 오류", treeError() === "Enter a name without “/”."),
    (e) => check("만들기: “/” 들어간 이름은 오류", false, String(e)),
  );
  enter(again, "Escape");
  await waitFor("Esc로 취소", () => !treeInput());
  check("만들기: Esc로 취소", !(await exists("-e", `${root}/x`)));

  rightClick(fileRow("z.txt")!);
  await pickMenu("New File…");
  const blurred = await waitFor("입력란", treeInput);
  setInput(blurred, "never.txt");
  blurred.blur();
  await waitFor("다른 곳을 누르면 취소", () => !treeInput());
  check("만들기: 다른 곳을 누르면 만들지 않고 취소", !(await exists("-e", `${root}/never.txt`)));

  await run(term, "rm -r made_dir A_dir/made.txt");
  await waitFor("정리", () => !rowNames().includes("made_dir"), 3000);
}

// scripts/selftest.sh가 main에 넣은 테스트 설정 (설정을 바꾸는 검사가 끝나면 되돌린다)
// shiftEnterFor: 세션 구성이 없는 터미널에서 cat이 앞이면 ⇧↩을 ESC CR로 (testProgramShiftEnter)
const TEST_GROUPS = `{"default":"test","shiftEnterFor":{"cat":"\\u001b\\r"},"groups":[{"id":"test","name":"Test","sessions":[{"name":"shell","shiftEnter":"\\u001b\\r"}]}]}`;
const groupsFile = async () => `${await invoke<string>("groups_dir")}/groups.json`;

// 작업그룹 설정 파일: 고치면 다시 읽기, 잘못되면 오류 표시 + 마지막 올바른 설정 유지.
// 시작 설정은 scripts/selftest.sh가 넣은 테스트용 그룹 "test" (셸 하나). 기본 설정 생성은 corrupt 시나리오가 본다.
async function testGroups(term: Terminal) {
  const file = `${await invoke<string>("groups_dir")}/groups.json`;
  const sidebarErrors = () => [...document.querySelectorAll(".sidebar .sidebar-error")].map((el) => el.textContent ?? "");
  const write = (json: string) => run(term, `printf '%s' '${json}' > "${file}"`);
  const testConfig = TEST_GROUPS;

  const g = await waitFor("작업그룹 설정", () => devHooks.groups);
  check("작업그룹: 설정 파일을 읽음", g.default === "test" && sidebarErrors().length === 0, sidebarErrors().join("|"));
  check("작업그룹: 앱 메뉴에 설정 항목", (await nativeMenu()).includes("ddak/Work Groups…"));
  const firstTab = document.querySelector(".project-workspace:not([style*='none']) .tab .tab-title")?.textContent;
  check("작업그룹: 첫 탭 제목은 기본 그룹 이름", firstTab === "Test", firstTab ?? "");

  // 아래에서 진짜 claude가 든 설정과 기본 설정(claude·codex)을 거친다. 중간에 예외가 나도 테스트 설정으로 되돌린다
  // (리뷰 R1: 단계가 예외로 끝나도 다음 단계로 가므로, 되돌리지 않으면 뒤 단계가 진짜 CLI를 띄웠다)
  try {
    await write("{");
    const bad = await waitFor("형식 오류 표시", () => sidebarErrors().find((e) => e.startsWith("Work group settings have an error")), 3000);
    check("작업그룹: 형식이 깨지면 오류 표시", bad.includes("Invalid settings file"), bad);
    check("작업그룹: 오류 동안 마지막 올바른 설정 유지", devHooks.groups?.default === "test");

    const one = (id: string) => `{"id":"${id}","name":"X","sessions":[{"name":"s"}]}`;
    await write(`{"default":"a","groups":[${one("a")},${one("a")}]}`);
    await waitFor("중복 id 오류", () => sidebarErrors().some((e) => e.includes("“a” is used more than once")), 3000).then(
      () => check("작업그룹: 중복 id 오류", true),
      () => check("작업그룹: 중복 id 오류", false, sidebarErrors().join("|")),
    );
    await write(`{"default":"a","groups":[{"id":"a","name":"X","sessions":[{"name":"s","readonly":true}]}]}`);
    await waitFor("모르는 키 오류", () => sidebarErrors().some((e) => e.includes("readonly")), 3000).then(
      () => check("작업그룹: 오타 난 키(readonly)도 오류", true),
      () => check("작업그룹: 오타 난 키(readonly)도 오류", false, sidebarErrors().join("|")),
    );

    await write(`{"default":"solo","groups":[{"id":"solo","name":"Solo","sessions":[{"name":"dev","command":"claude","args":["--model","opus"]}]}]}`);
    await waitFor("고친 설정 반영", () => devHooks.groups?.default === "solo", 3000).then(
      () => check("작업그룹: 고친 설정을 다시 읽고 오류 사라짐", devHooks.groups!.groups[0].sessions[0].args.join(" ") === "--model opus" && sidebarErrors().length === 0, sidebarErrors().join("|")),
      (e) => check("작업그룹: 고친 설정을 다시 읽고 오류 사라짐", false, String(e)),
    );
    check("작업그룹: 이미 열린 탭은 설정이 바뀌어도 그대로", document.querySelector(".project-workspace:not([style*='none']) .tab .tab-title")?.textContent === "Test");

    await run(term, `rm "${file}"`);
    await waitFor("기본 설정 복구", () => devHooks.groups?.default === "dev-review", 3000).then(
      () => check("작업그룹: 파일을 지우면 기본 설정으로 다시 만듦", true),
      (e) => check("작업그룹: 파일을 지우면 기본 설정으로 다시 만듦", false, String(e)),
    );
  } finally {
    // 뒤의 시나리오가 새 프로젝트를 열 때 진짜 claude·codex가 뜨지 않게 테스트 설정으로 되돌린다.
    await write(testConfig);
    await waitFor("테스트 설정 복귀", () => devHooks.groups?.default === "test", 3000);
  }
}

// ⇧↩ (Terminal.tsx): 세션 구성에 shiftEnter가 없는 터미널(그냥 셸 탭)은 누를 때 앞에서 도는 프로그램을 보고 groups.json
// shiftEnterFor에서 찾는다 (테스트 설정: cat → ESC CR, src-tauri/src/pty.rs pty_foreground). 셸이 앞이면 그냥 Enter.
async function testProgramShiftEnter(first: Terminal) {
  const before = tabCount();
  await menu("new_tab");
  await waitFor("새 탭", () => tabCount() === before + 1 && visiblePanes().length === 1);
  const term = visiblePanes()[0].term;
  await ready(term);
  const shiftEnter = () => term.textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
  term.input("echo SE-SHELL");
  await sleep(200);
  shiftEnter();
  const shellRan = await waitFor("셸에서 ⇧↩ = Enter", () => screen(term).some((l) => l.trim() === "SE-SHELL"), 3000).then(() => true, () => false);
  term.input("cat -v\r");
  await sleep(700);
  shiftEnter();
  const escaped = await waitFor("cat 앞에서 ⇧↩ = ESC CR", () => screen(term).some((l) => l.trim() === "^["), 3000).then(() => true, () => false);
  term.input("\x03");
  await sleep(300);
  check("⇧↩: 세션 구성이 없는 터미널은 앞에서 도는 프로그램으로 고른다 (cat → ESC CR, 셸 → Enter)", shellRan && escaped, `${shellRan} ${escaped} | ${screen(term).filter((l) => l.trim()).slice(-4).join(" ⏎ ")}`);
  // 입력기 조합 중의 ⇧↩ (keyCode 229, isComposing)은 조합 확정이라 보내지 않는다 (리뷰 R1). 세션 구성이 있는 창(첫 터미널)도 같다
  const composing = (init: { keyCode?: number; isComposing?: boolean }) => {
    const ev = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true, isComposing: !!init.isComposing });
    if (init.keyCode) Object.defineProperty(ev, "keyCode", { get: () => init.keyCode });
    term.textarea!.dispatchEvent(ev);
  };
  term.input("echo SE-IME");
  await sleep(200);
  composing({ keyCode: 229 });
  composing({ isComposing: true });
  await sleep(1000);
  const imeHeld = !screen(term).some((l) => l.trim() === "SE-IME");
  shiftEnter();
  const thenRan = await waitFor("조합이 끝난 ⇧↩", () => screen(term).some((l) => l.trim() === "SE-IME"), 3000).then(() => true, () => false);
  // 세션 구성(ESC CR)이 있는 창: WebKit은 조합 중 keydown에 keyCode 229를 준다
  const sessionGot: string[] = [];
  const sub = first.onData((x) => sessionGot.push(x));
  const imeEv = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(imeEv, "keyCode", { get: () => 229 });
  first.textarea!.dispatchEvent(imeEv);
  sub.dispose();
  const sessionIme = sessionGot.join("");
  check(
    "⇧↩: 입력기 조합 중이면 보내지 않음 (프로그램 조회도, 세션 구성의 ESC CR도), 조합이 끝난 ⇧↩은 보냄",
    imeHeld && thenRan && sessionIme === "",
    `${imeHeld} ${thenRan} ${JSON.stringify(sessionIme)}`,
  );
  const n = tabCount();
  await menu("close_pane");
  await waitFor("탭 닫기", () => tabCount() === n - 1, 5000);
}

// 패널 크기·파일 트리 숨기기 (src/Resizer.tsx, prefs.tsx): 파일 트리 오른쪽 끝·채팅 패널 왼쪽 끝을 끌어 폭을 바꾸고 (최소·최대로
// 자르고 저장), 더블클릭하면 그 패널만 기본값, 보기 메뉴 "패널 크기 초기화"는 둘 다. "파일 트리 보이기"(⌘B)로 숨기고 다시 보인다.
async function testPanels() {
  const sidebar = () => document.querySelector<HTMLElement>(".sidebar")!;
  const ws = () => document.querySelector<HTMLElement>(".project-workspace:not([style*='none'])")!;
  const chat = () => ws().querySelector<HTMLElement>(".chat-panel")!;
  const w = (el: HTMLElement) => parseInt(el.style.width);
  const bar = (el: HTMLElement) => el.querySelector<HTMLElement>(":scope > .panel-resizer")!;
  const dragBy = async (el: HTMLElement, dx: number) => {
    const r = el.getBoundingClientRect();
    const [x, y] = [r.left + r.width / 2, r.top + 10];
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: 1 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: x + dx, clientY: y, buttons: 1 }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: x + dx, clientY: y }));
    await sleep(100);
  };
  // 끌기가 끝난 뒤의 움직임은 폭을 바꾸지 않는다 (리뷰 R1): 취소(pointercancel), 창 밖에서 뗌(버튼 없는 pointermove)
  const endedBy = async (el: HTMLElement, end: "cancel" | "released") => {
    const r = el.getBoundingClientRect();
    const [x, y] = [r.left + r.width / 2, r.top + 10];
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: 1 }));
    if (end === "cancel") window.dispatchEvent(new PointerEvent("pointercancel", { clientX: x, clientY: y }));
    else window.dispatchEvent(new PointerEvent("pointermove", { clientX: x + 30, clientY: y, buttons: 0 }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: x + 120, clientY: y, buttons: 1 }));
    await sleep(100);
    return document.body.classList.contains("resizing");
  };
  const sizes: number[] = [w(sidebar())];
  await dragBy(bar(sidebar()), 100);
  sizes.push(w(sidebar()));
  const saved = localStorage.getItem("ddak.sidebarWidth");
  await dragBy(bar(sidebar()), 1000);
  sizes.push(w(sidebar()));
  await dragBy(bar(sidebar()), -2000);
  sizes.push(w(sidebar()));
  bar(sidebar()).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await sleep(100);
  sizes.push(w(sidebar()));
  check("패널: 파일 트리 폭을 끌어 바꾸고 (160~600으로 자름, 저장), 더블클릭하면 기본 260", sizes.join(",") === "260,360,600,160,260" && saved === "360", `${sizes} ${saved}`);
  const stuckAfterCancel = await endedBy(bar(sidebar()), "cancel");
  const afterCancel = w(sidebar());
  const stuckAfterRelease = await endedBy(bar(sidebar()), "released");
  const afterRelease = w(sidebar());
  // 끝나지 않은 끌기를 새 끌기로 바꿔도 끄는 중 표시(크기 조절 커서·선택 막기)는 남는다 (리뷰 R2)
  const down = () => bar(sidebar()).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, buttons: 1 }));
  down();
  down();
  const stillResizing = document.body.classList.contains("resizing");
  window.dispatchEvent(new PointerEvent("pointerup", { clientX: 10, clientY: 10 }));
  check(
    "패널: 끌기를 취소하거나 창 밖에서 떼면 끝나고, 그 뒤 움직임은 폭을 바꾸지 않음. 새 끌기로 바꿔도 끄는 중 표시는 남음",
    stillResizing && !document.body.classList.contains("resizing") &&
    afterCancel === 260 && afterRelease === 260 && !stuckAfterCancel && !stuckAfterRelease,
    `${afterCancel} ${stuckAfterCancel} ${afterRelease} ${stuckAfterRelease} ${stillResizing}`,
  );

  ws().querySelector<HTMLElement>("[data-action=chat]")!.click();
  await waitFor("채팅 열기", () => chat().style.display !== "none", 2000);
  const chat0 = w(chat());
  await dragBy(bar(chat()), -100);
  const chat1 = w(chat());
  await dragBy(bar(sidebar()), 50);
  const side1 = w(sidebar());
  await clickMenu("View", "Reset Panel Sizes");
  const reset = await waitFor("패널 크기 초기화", () => w(sidebar()) === 260 && w(chat()) === 340, 3000).then(() => true, () => false);
  check("패널: 채팅 패널은 왼쪽 끝을 끌어 넓히고, 보기 메뉴 초기화는 둘 다 기본값", chat0 === 340 && chat1 === 440 && side1 === 310 && reset, `${chat0} ${chat1} ${side1} ${w(sidebar())} ${w(chat())}`);
  ws().querySelector<HTMLElement>("[data-action=chat]")!.click();

  await clickMenu("View", "Show File Tree");
  const hidden = await waitFor("파일 트리 숨김", () => sidebar().style.display === "none", 3000).then(() => true, () => false);
  const offMenu = await waitMenu((m) => m.includes("View/Show File Tree"));
  await clickMenu("View", "Show File Tree");
  const back = await waitFor("파일 트리 다시", () => sidebar().style.display === "", 3000).then(() => true, () => false);
  const onMenu = await waitMenu((m) => m.includes("View/Show File Tree [x]"));
  check(
    "패널: 보기 메뉴 파일 트리 보이기로 숨기고 다시 보임 (메뉴 체크도 따라감)",
    hidden && offMenu.includes("View/Show File Tree") && back && onMenu.includes("View/Show File Tree [x]") && localStorage.getItem("ddak.sidebar") === "true",
    `${hidden} ${back} ${offMenu.filter((m) => m.includes("File Tree"))} ${onMenu.filter((m) => m.includes("File Tree"))}`,
  );
}

// 한글 보정(src/hangul.ts)만 따로: 화면 밖 xterm에 붙여서 나가는 입력을 본다.
// 저장한 작업 화면 읽기 (workspaceState.ts): 같은 창 번호가 두 번 나오면 (같은 탭 안이라도) 깨진 것으로 본다 (리뷰 P2)
function testWorkspaceStateUnit() {
  const session = { name: "s", command: "", args: [], resume: null, readOnly: false, shiftEnter: null };
  const saved = (layout: unknown, tabs = 1) =>
    JSON.stringify({ version: 1, active: 1, tabs: Array.from({ length: tabs }, (_, i) => ({ id: 1 + i * 10, layout, focus: 2, cwd: "/x" })), sessions: { 2: session } });
  const split = (a: number, b: number) => ({ dir: "row", ratio: 0.5, a: { pane: a }, b: { pane: b } });
  check("복원 상태: 올바른 상태는 읽음", fromSaved(saved(split(2, 3)), "/x")?.tabs.length === 1);
  check("복원 상태: 같은 탭 안 중복 창 번호는 거부", fromSaved(saved(split(2, 2)), "/x") === null);
  check("복원 상태: 다른 탭과 중복 창 번호는 거부", fromSaved(saved(split(2, 3), 2), "/x") === null);
  check("복원 상태: 탭 번호와 창 번호 중복도 거부", fromSaved(saved(split(1, 2)), "/x") === null);
  const gitTab = (git: unknown) => JSON.stringify({ version: 1, active: 1, tabs: [{ id: 1, layout: { pane: 2 }, focus: 2, cwd: "/x", git }], sessions: {} });
  check("복원 상태: Git Graph 탭과 고른 저장소를 읽음", fromSaved(gitTab({ repo: "server" }), "/x")?.tabs[0].git?.repo === "server");
  check("복원 상태: Git Graph 탭 모양이 틀리면 거부", fromSaved(gitTab({ repo: 3 }), "/x") === null);
  const docTab = (doc: unknown) => JSON.stringify({ version: 1, active: 1, tabs: [{ id: 1, layout: { pane: 2 }, focus: 2, cwd: "/x", doc }], sessions: {} });
  check("복원 상태: 문서 탭과 그 파일을 읽음", fromSaved(docTab({ path: "/x/README.md" }), "/x")?.tabs[0].doc?.path === "/x/README.md");
  check("복원 상태: 문서 탭 모양이 틀리면 거부", fromSaved(docTab({}), "/x") === null && fromSaved(docTab("/x/a.md"), "/x") === null);

  // 대화 ID 따라가기 (docs/reviews/2026-10-31-claude-session-follow.md): cur는 저장·복원되고 모양이 틀리면 거부. 이어서 하기는 cur
  // (없으면 sid). fallback의 새 ID는 처음 인자에 {sessionStart}가 있는 창만 (리뷰 R1). 알림은 창 키(sid)로 창을 찾는다
  const withCur = (cur: unknown) => JSON.stringify({ version: 1, active: 1, tabs: [{ id: 1, layout: { pane: 2 }, focus: 2, cwd: "/x" }], sessions: { 2: { ...session, sid: "S", cur } } });
  check("복원 상태: 창의 지금 대화 ID(cur)를 읽고 모양이 틀리면 거부", fromSaved(withCur("C"), "/x")?.sessions[2].cur === "C" && fromSaved(withCur(3), "/x") === null);
  const claude = (args: string[], cur?: string): PaneSession => ({ ...session, command: "claude", args, resume: ["--resume", "{session}"], sid: "S", cur, prompt: "P", resumed: true });
  const reporting = commandOf(claude(["--session-id", "{session}", "--settings", "{sessionStart}"], "C"));
  const silent = commandOf(claude(["--session-id", "{session}"], "C"));
  const fresh = commandOf({ ...claude(["--session-id", "{session}", "{sessionStart}"]), resumed: false });
  check(
    "대화 ID: 이어서 하기는 cur(없으면 sid), 알려 오는 창만 fallback에 새 ID, 처음 띄우기는 sid",
    reporting.vars?.session === "C" && reporting.command?.join(" ") === "claude --resume {session}" && UUID.test(reporting.fallbackVars?.session ?? "") &&
      silent.vars?.session === "C" && silent.fallbackVars === undefined && fresh.vars?.session === "S" && fresh.fallback === undefined &&
      commandOf(claude(["x"])).vars?.session === "S",
    JSON.stringify({ reporting, silent, fresh }),
  );
  const panes: Record<number, PaneSession> = { 2: claude(["a"]), 3: { ...claude(["a"]), sid: "T" }, 4: { ...claude(["a"]), sid: "U", setup: true } };
  const moved = followSession(panes, "T", "N");
  check(
    "대화 ID: 알린 창 키의 창만 cur를 바꾸고, 같은 ID·모르는 키·준비 창은 그대로",
    moved[3].cur === "N" && moved[2] === panes[2] && followSession(moved, "T", "N") === moved && followSession(panes, "S", "S") === panes &&
      followSession(panes, "nope", "N") === panes && followSession(panes, "U", "N") === panes,
    JSON.stringify(moved),
  );
}

// 터미널 자동 응답 판별 (깨우기의 사용자 입력에서 뺀다, src/Terminal.tsx isTerminalReply)
// 터미널 검색 (⌘F, 터미널 메뉴 "찾기", src/TerminalSearch.tsx): 입력하면 찾고 몇 번째인지 센다. ↩ 다음, ⇧↩ 이전,
// 대소문자 구분·정규식, 결과 없음. Esc나 ×로 닫으면 터미널로 포커스
async function testTerminalSearch(term: Terminal) {
  const pane = visiblePanes().find((p) => p.term === term)!;
  // 찾을 말이 명령 줄에는 없게 (명령 줄도 화면에 남는다): xq-a, XQ-B, xq-c
  await run(term, String.raw`p=xq; printf '%s-a\n%s-B\n%s-c\n' $p $(echo $p | tr a-z A-Z) $p`);
  const bar = () => pane.el.querySelector<HTMLElement>(".terminal-search");
  await clickMenu("Terminal", "Find…");
  await waitFor("검색 막대", bar, 3000).catch(() => null);
  const input = () => bar()!.querySelector("input")!;
  check("검색: 터미널 메뉴 찾기(⌘F)로 막대가 열리고 입력란에 포커스", !!bar() && document.activeElement === input());
  const type = (text: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const key = (k: string, shift = false) => input().dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
  const count = () => bar()?.querySelector("[data-count]")?.textContent ?? "";
  const counted = (what: string, ok: (c: string) => boolean) => waitFor(what, () => ok(count()), 3000).then(() => true, () => false);
  type("xq-");
  const all = await counted("3개", (c) => / of 3$/.test(c));
  const first = count();
  key("Enter");
  const moved = await counted("다음", (c) => / of 3$/.test(c) && c !== first);
  const second = count();
  key("Enter", true);
  const back = await counted("이전", (c) => c === first);
  check(
    "검색: 대소문자 무시로 3개, ↩ 다음·⇧↩ 이전, 지금 결과를 선택",
    all && moved && back && term.getSelection().toLowerCase() === "xq-",
    `${first} → ${second} → ${count()} sel=${JSON.stringify(term.getSelection())}`,
  );
  bar()!.querySelector<HTMLElement>("[data-option='case']")!.click();
  const cased = await counted("대소문자 구분", (c) => / of 2$/.test(c));
  const casedText = count();
  bar()!.querySelector<HTMLElement>("[data-option='case']")!.click();
  bar()!.querySelector<HTMLElement>("[data-option='regex']")!.click();
  type("xq-[ac]");
  const regexed = await counted("정규식", (c) => / of 2$/.test(c));
  const regexText = count();
  // 잘못된 정규식은 결과 없음 (이전 수가 남지 않게, 리뷰 R1)
  type("xq-[");
  const badRegex = await counted("잘못된 정규식", (c) => c === "No results");
  const badText = count();
  type("zz-not-there");
  const none = await counted("결과 없음", (c) => c === "No results");
  check("검색: 대소문자 구분 2개, 정규식 2개, 잘못된 정규식·없으면 결과 없음", cased && regexed && badRegex && none, `${casedText} | ${regexText} | ${badText} | ${count()}`);
  key("Escape");
  await waitFor("Esc로 닫힘", () => !bar(), 2000).catch(() => null);
  check("검색: Esc로 닫으면 터미널로 포커스", !bar() && term.textarea === document.activeElement);
  await clickMenu("Terminal", "Find…");
  await waitFor("다시 열림", bar, 3000).catch(() => null);
  const reopened = !!bar() && input().value === "";
  const reopenedInfo = `bar=${!!bar()} value=${JSON.stringify(bar() ? input().value : null)}`;
  bar()?.querySelector<HTMLElement>("[data-action='close']")?.click();
  await waitFor("×로 닫힘", () => !bar() && term.textarea === document.activeElement, 2000).catch(() => null);
  check(
    "검색: 다시 열면 빈 입력, ×로 닫힘",
    reopened && !bar() && term.textarea === document.activeElement,
    `${reopenedInfo} | after: bar=${!!bar()} active=${document.activeElement?.className} hasFocus=${document.hasFocus()} retry=${(term.focus(), document.activeElement === term.textarea)} hidden=${pane.el.offsetParent === null}`,
  );

  // 분할 창: A에서 검색을 연 채 B로 옮겼다가 A의 검색 입력란을 누르면 A가 고른 창이 되고 포커스는 입력란에 남는다.
  // 그 상태의 ⌘F는 A의 입력란을 고르고 B에는 막대를 열지 않는다 (리뷰 R2)
  await clickMenu("Terminal", "Find…");
  await waitFor("A 검색", bar, 3000).catch(() => null);
  const panes = visiblePanes().length;
  await menu("split_right");
  const b = await waitFor("B 창", () => visiblePanes().length === panes + 1 && visiblePanes().find((p) => p.term !== term), 5000);
  await ready(b.term);
  b.term.focus();
  await waitFor("B 고름", () => b.el.classList.contains("focused"), 2000).catch(() => null);
  input().focus();
  await waitFor("A 고름", () => pane.el.classList.contains("focused"), 2000).catch(() => null);
  await sleep(200);
  const picked = pane.el.classList.contains("focused") && !b.el.classList.contains("focused") && document.activeElement === input();
  await clickMenu("Terminal", "Find…");
  await sleep(300);
  const stayed = document.activeElement === input() && !b.el.querySelector(".terminal-search");
  check("검색: 다른 창의 검색 입력란을 누르면 그 창을 고르고 입력란에 포커스, ⌘F도 그 창", picked && stayed, `${picked} ${stayed} ${document.activeElement?.className}`);
  key("Escape");
  b.term.focus();
  await waitFor("B 고름", () => b.el.classList.contains("focused"), 2000).catch(() => null);
  await menu("close_pane");
  await waitFor("B 닫힘", () => visiblePanes().length === panes, 5000).catch(() => null);
}

// 알림을 누르면 갈 프로젝트 (src/notifyClick.ts): 알림은 실제 경로, 등록은 링크 경로일 수 있다 (리뷰 R1)
async function testNotifyClickUnit() {
  const real = async (p: string) => ({ "/tmp/a": "/private/tmp/a", "/l/b": "/r/b" })[p] ?? p;
  const got = [
    await projectForClick(["/tmp/a", "/r/b"], "/r/b", real),
    await projectForClick(["/tmp/a", "/r/b"], "/private/tmp/a", real),
    await projectForClick(["/l/b"], "/r/b", real),
    await projectForClick(["/tmp/a"], "/nope", real),
    await projectForClick(["/x"], "/y", async () => Promise.reject(new Error("no"))),
  ];
  check("알림 누르기: 등록 경로와 같거나 등록 경로의 실제 경로가 같은 프로젝트 (등록 경로로)", JSON.stringify(got) === JSON.stringify(["/r/b", "/tmp/a", "/l/b", null, null]), JSON.stringify(got));
}

// 앞에서 도는 프로그램의 상태 (src/programStatus.ts): OSC 7501 해석과 화면의 선택 창 판단
function testProgramStatusUnit() {
  const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
  const cases: [string, unknown][] = [
    ["?", "query"],
    [" ? ", "query"],
    ["state=idle:app=claude-code", { state: "idle" }],
    [`state=blocked:app=claude-code:kind=permission:msg=${b64("approve Bash: ls")}`, { state: "blocked", kind: "permission", msg: "approve Bash: ls" }],
    ["state=working:kind=permission", { state: "working" }],
    ["state=blocked:kind=nope", { state: "blocked" }],
    ["state=clear", "clear"],
    ["state=blocked:id=sub/1", null],
    ["state=sleeping", null],
    ["kind=permission", null],
    [`state=done:msg=${b64("a\u0007b")}`, { state: "done" }],
    [`state=done:msg=${b64("한글 요약")}`, { state: "done", msg: "한글 요약" }],
  ];
  const bad = cases.filter(([body, want]) => JSON.stringify(parseProgramStatus(body)) !== JSON.stringify(want)).map(([b]) => b);
  check("프로그램 상태: OSC 7501 본문 해석 (물음, 상태·종류·msg, 지움, 하위 기록·모르는 상태는 버림)", bad.length === 0, bad.join(" | "));
  check("프로그램 상태: 물음의 답", PROGRAM_STATUS_REPLY === "\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\");
  // 실제 화면에서 본 모양 (claude 2.1.310 폴더 신뢰 창, codex 승인 창)과 선택 창이 아닌 것
  const dialogs: string[][] = [
    ["Quick safety check: Is this a project you created or one you trust?", "", "❯ 1. Yes, I trust this folder", "  2. No, exit", "", "Enter to confirm · Esc to cancel"],
    ["Do you want to proceed?", "❯ 1. Yes", "  2. No"],
    ["Would you like to run the following command?", "› 1. Yes, proceed (y)", "  2. No (esc)", "Press enter to confirm or esc to cancel"],
  ];
  const plain: string[][] = [
    ["$ ls", "1. first item", "2. second item", "$ "],
    ["❯ 1. lonely option", "", "", "text"],
    ["Enter the folder name", "$ "],
  ];
  check(
    "프로그램 상태: 화면 아래쪽의 선택 창 (claude·codex) / 번호 목록·안내문은 아님",
    dialogs.every((d) => dialogOnScreen(d)) && plain.every((p) => !dialogOnScreen(p)),
    `${dialogs.map((d) => dialogOnScreen(d))} ${plain.map((p) => dialogOnScreen(p))}`,
  );
  // 선택 창 읽기 (채팅에서 답하기): 질문 줄(가로줄·빈 줄 셋 위는 뺌), 선택지(상자 테두리 빼고, 넘친 줄은 이어 붙임), 커서
  const claude = [
    "earlier output",
    "────────────────────────────",
    " Bash command",
    "",
    "   npm test",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for npm test commands in",
    "      /Users/me/project",
    "   3. No, and tell Claude what to do differently (esc)",
    "",
    " Esc to cancel · Tab to add additional instructions",
  ];
  const boxed = ["╭────────────────────────────╮", "│ Allow this?                │", "│   1. Yes                    │", "│ › 2. No                     │", "│ Press enter to confirm      │"];
  // 위 경계 없이 화면 맨 위까지 오면 질문이 잘렸을 수 있다
  const cut = ["  rm -rf project", "Do you want to proceed?", "❯ 1. Yes", "  2. No"];
  const read = [readDialog(claude), readDialog(boxed), readDialog(["$ ls", "1. first", "2. second"]), readDialog(["❯ 1. only one"]), readDialog(cut)];
  check(
    "선택 창 읽기: 질문·선택지·커서 (claude 모양, 상자 테두리, 넘친 선택지) / 커서 없는 목록·선택지 하나는 아님",
    JSON.stringify(read) ===
      JSON.stringify([
        { question: ["Bash command", "npm test", "Do you want to proceed?"], options: ["Yes", "Yes, and don't ask again for npm test commands in /Users/me/project", "No, and tell Claude what to do differently (esc)"], cursor: 0, complete: true },
        { question: ["Allow this?"], options: ["Yes", "No"], cursor: 1, complete: true },
        null,
        null,
        { question: ["rm -rf project", "Do you want to proceed?"], options: ["Yes", "No"], cursor: 0, complete: false },
      ]),
    JSON.stringify(read),
  );
  // codex 선택 창(아래에 confirm·cancel 안내)은 경계 없이 화면 맨 위에 닿으면 가장 위 제목 줄부터가 질문: 화면 맨 윗줄부터 차도,
  // 위에 경계 없이 대화 기록이 붙어 있어도 답할 수 있다. 명령 본문에 제목과 같은 줄이 있어도 위의 진짜 제목부터라 명령이 빠지지 않고,
  // 그 위 명령만 다른 두 창은 다르다 (리뷰 R1). codex 안내가 없거나(claude 모양) 제목이 없으면 예전처럼 답하지 않는다
  const footer = "Press enter to confirm or esc to cancel";
  const codexTop = ["Would you like to run the following command?", "", "Environment: local", "", "$ node <<'NODE'", "[… 43 lines] ⌃a view all", "› 1. Yes, proceed (y)", "  2. No, and tell Codex what to do differently (esc)", "", footer];
  const codexHistory = ["› [ddak] New chat message from origin/dev.", "• Ran node <<'NODE'", "Would you like to run the following command?", "", "$ rm -rf build", "› 1. Yes, proceed (y)", "  2. No (esc)", footer];
  const network = ["• Working", 'Do you want to approve network access to "example.com"?', "", "Reason: fetch", "› 1. Yes", "  2. No", footer];
  const heredoc = (cmd: string) => ["• Ran ls", "Would you like to run the following command?", "", `$ ${cmd}cat <<'TXT'`, "Would you like to run the following command?", "", "$ echo looks like a header", "TXT", "› 1. Yes, proceed (y)", "  2. No (esc)", footer];
  const claudeTitled = (cmd: string) => [`  ${cmd}`, "Would you like to run the following command?", "Do you want to proceed?", "❯ 1. Yes", "  2. No", "Enter to confirm · Esc to cancel"];
  const titled = [codexTop, codexHistory, network, heredoc(""), claudeTitled("rm -rf project"), ["  rm -rf project", "Do you want to proceed?", "❯ 1. Yes", "  2. No", footer]].map((l) => readDialog(l));
  check(
    "선택 창 읽기: codex 창은 경계 없이 화면 맨 위에 닿으면 가장 위 제목부터 (화면 맨 위·대화 기록 아래·본문의 제목 줄), codex 안내나 제목이 없으면 아님",
    JSON.stringify(titled.map((d) => d && [d.question, d.complete])) ===
      JSON.stringify([
        [["Would you like to run the following command?", "Environment: local", "$ node <<'NODE'", "[… 43 lines] ⌃a view all"], true],
        [["Would you like to run the following command?", "$ rm -rf build"], true],
        [['Do you want to approve network access to "example.com"?', "Reason: fetch"], true],
        [["Would you like to run the following command?", "$ cat <<'TXT'", "Would you like to run the following command?", "$ echo looks like a header", "TXT"], true],
        [["rm -rf project", "Would you like to run the following command?", "Do you want to proceed?"], false],
        [["rm -rf project", "Do you want to proceed?"], false],
      ]),
    JSON.stringify(titled.map((d) => d && [d.question, d.complete])),
  );
  // 화면 위의 줄(above, 일반 화면의 스크롤 기록)로 이어 올라간다. 처음(start)까지 경계 없이 다 읽으면 잘린 것이 없다 (대체 화면은
  // 맨 윗줄이 처음). 처음이 아니면 예전처럼 답하지 않는다. 선택지는 화면 안에서만 찾는다
  const update = ["Update available · 0.164.0 → 0.165.0", "", "Release notes: https://example.com", "", "› 1. Update now", "  2. Skip", "  3. Skip until next version", "", "Press enter to continue"];
  const above = [
    readDialog(cut, ["earlier output", "────────", " Bash command"]),
    readDialog(cut, ["earlier output", " Bash command"]),
    readDialog(cut, [" Bash command"], true),
    readDialog(update, [], true),
    readDialog(update),
    readDialog(["$ ls"], ["› 1. Yes", "  2. No"]),
  ];
  check(
    "선택 창 읽기: 질문이 화면 위로 넘치면 위의 줄에서 이어 읽고, 처음까지 다 읽거나(대체 화면 맨 윗줄 포함) 경계를 찾으면 답할 수 있음",
    JSON.stringify(above.map((d) => d && [d.question, d.complete])) ===
      JSON.stringify([
        [["Bash command", "rm -rf project", "Do you want to proceed?"], true],
        [["earlier output", "Bash command", "rm -rf project", "Do you want to proceed?"], false],
        [["Bash command", "rm -rf project", "Do you want to proceed?"], true],
        [["Update available · 0.164.0 → 0.165.0", "Release notes: https://example.com"], true],
        [["Update available · 0.164.0 → 0.165.0", "Release notes: https://example.com"], false],
        null,
      ]),
    JSON.stringify(above.map((d) => d && [d.question, d.complete])),
  );
  const [plainCat, rmCat] = [readDialog(heredoc("")), readDialog(heredoc("rm -rf project; "))];
  check("선택 창 읽기: 본문에 제목 줄이 있어도 그 위 명령만 다른 두 codex 창은 다름 (리뷰 R1)", !!rmCat?.question.includes("$ rm -rf project; cat <<'TXT'") && !sameDialog(plainCat, rmCat), JSON.stringify(rmCat?.question));
  // claude 안내("Enter to confirm · Esc to cancel")는 codex 안내가 아니다: 본문에 codex 제목 글이 있어도 위가 잘렸으면 답하지 않고,
  // 그 위 명령만 다른 두 창을 같게 보지 않는다 (재리뷰 R1)
  const [claudeLs, claudeRm] = [readDialog(claudeTitled("ls")), readDialog(claudeTitled("rm -rf project"))];
  check("선택 창 읽기: claude 안내(Enter to confirm · Esc to cancel)인 창은 본문에 codex 제목 글이 있어도 위가 잘렸으면 답하지 않음 (재리뷰 R1)", claudeLs?.complete === false && claudeRm?.complete === false && !sameDialog(claudeLs, claudeRm), JSON.stringify([claudeLs, claudeRm]));
  // 질문이 길어도 줄 수를 자르지 않아 위쪽 명령만 다른 두 선택 창은 다르다 (리뷰 R2)
  const long = (cmd: string) => ["────────", " Bash command", `   ${cmd}`, ...Array.from({ length: 8 }, (_, i) => ` Details ${i}`), " Do you want to proceed?", " ❯ 1. Yes", "   2. No"];
  const [harmless, harmful] = [readDialog(long("echo harmless")), readDialog(long("rm -rf project"))];
  check("선택 창 읽기: 질문은 줄 수를 자르지 않음 (위쪽 명령만 다른 두 선택 창은 다름)", !!harmless && !!harmful && harmful.question.includes("rm -rf project") && !sameDialog(harmless, harmful), JSON.stringify(harmful?.question));
  // 선택 창이 오래 남으면 (DIALOG_CAP) 풀린다. blocked는 상한 없음
  const now = 1_000_000_000;
  check(
    "프로그램 상태: 기다림 = blocked 또는 상한 안의 선택 창",
    awaitingUser({ state: "blocked" }, undefined, now) && !awaitingUser({ state: "working" }, undefined, now) &&
      awaitingUser(undefined, now - 1000, now) && !awaitingUser(undefined, now - DIALOG_CAP_MS, now),
  );
}

// 앞에서 도는 프로그램의 상태 (src/programStatus.ts, Terminal.tsx): 물음에 답하고, 보고와 화면의 선택 창으로 이름표의 상태와
// Rust의 "기다림"(깨우기를 미룸, pty_awaiting)이 바뀐다
async function testProgramStatus(root: string, term: Terminal) {
  const pane = visiblePanes().find((p) => p.term === term)!;
  const ptyId = Number(pane.el.querySelector<HTMLElement>(".terminal")?.dataset.pty);
  const awaiting = () => invoke<boolean | null>("selftest_pty_awaiting", { id: ptyId });
  const badge = () => pane.el.querySelector<HTMLElement>(".pane-label .pane-badge.status");
  const shows = (what: string | null, wait: boolean) => async () => (badge()?.textContent ?? null) === what && (await awaiting()) === wait;
  // 본문은 셸 따옴표 안에 넣을 수 있는 글자만 쓴다 (msg는 base64)
  const report = (body: string) => run(term, `printf '\\033]7501;%s\\033\\\\' '${body}'`);
  // 물음: 다른 입력처럼 PTY로 답이 간다 (head가 받아 cat -v로 보인다)
  const reply = await run(term, String.raw`stty -icanon -echo min 0 time 20; printf '\033]7501;?\033\\'; head -c 200 | cat -v; echo; stty sane`, 15000);
  check(
    "프로그램 상태: OSC 7501 물음에 답함 (받는 상태·종류)",
    reply.some((l) => l.includes("^[]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth^[\\")),
    reply.filter((l) => l.includes("7501")).join(" | "),
  );
  await report(`state=blocked:kind=permission:msg=${btoa("approve Bash: ls")}`);
  const blocked = await waitAsync("권한 대기 표시", shows("waiting for permission", true), 3000).then(() => true, () => false);
  check("프로그램 상태: blocked(permission)이면 이름표에 권한 확인 대기, 깨우기 미룸", blocked && badge()?.title.startsWith("approve Bash: ls") === true, `${badge()?.textContent} ${await awaiting()} ${badge()?.title}`);
  // 기다리는 채 종류만 바뀌어도 Rust가 안다 (폰의 참여자 상태, 리뷰 R4)
  const kindOf = () => invoke<string | null>("selftest_pty_awaiting_kind", { id: ptyId });
  const permissionKind = await kindOf();
  await report("state=blocked:kind=question");
  const questionKind = await waitAsync("답 기다림 종류", async () => (await kindOf()) === "question", 3000).then(() => "question", async () => await kindOf());
  check("프로그램 상태: 기다리는 채 종류가 바뀌면 Rust에도 (권한 확인 → 답 기다림)", permissionKind === "permission" && questionKind === "question", `${permissionKind} ${questionKind}`);
  await report(`state=blocked:kind=permission:msg=${btoa("approve Bash: ls")}`);
  await waitAsync("다시 권한 대기", async () => (await kindOf()) === "permission", 3000).catch(() => null);
  // 기다림은 색을 채운 칩 (다른 상태·배지와 구분, 상태 표시 가독성)
  const looks = () => {
    const css = getComputedStyle(badge()!);
    return { color: css.color, bg: css.backgroundColor, border: css.borderTopStyle };
  };
  const awaitLook = blocked ? looks() : null;
  check(
    "프로그램 상태: 기다림은 색을 채운 칩 (--status-awaiting-bg·fg)",
    awaitLook?.bg === tokenRgb("--status-awaiting-bg") && awaitLook?.color === tokenRgb("--status-awaiting-fg"),
    JSON.stringify(awaitLook),
  );
  await report("state=working");
  const working = await waitAsync("작업 중 표시", shows("working", false), 3000).then(() => true, () => false);
  check("프로그램 상태: working이면 작업 중, 깨우기 미루지 않음", working, `${badge()?.textContent} ${await awaiting()}`);
  // 작업 중·완료는 테두리 없이 색 점 + 글자 (테두리 칩인 깨우기·준비 배지와 구분)
  const workLook = working ? looks() : null;
  await report("state=done");
  const done = await waitAsync("완료 표시", shows("done", false), 3000).then(() => true, () => false);
  const doneLook = done ? looks() : null;
  await report("state=working");
  await waitAsync("다시 작업 중", shows("working", false), 3000).catch(() => null);
  check(
    "프로그램 상태: 작업 중(--status-working)·완료(--status-done)는 테두리·배경 없는 색 글자",
    workLook?.color === tokenRgb("--status-working") && doneLook?.color === tokenRgb("--status-done") &&
      [workLook, doneLook].every((l) => l?.border === "none" && l?.bg === "rgba(0, 0, 0, 0)"),
    JSON.stringify({ workLook, doneLook }),
  );
  // 작업 중인 터미널이 있으면 잠자기를 막는다 (caffeinate, src-tauri/src/pty.rs keep_awake. 0.25초마다 맞춘다)
  const awake = () => invoke<boolean>("selftest_keep_awake");
  const kept = await waitAsync("잠자기 막음", async () => await awake(), 3000).then(() => true, () => false);
  check("잠자기 막기: 작업 중인 터미널이 있으면 caffeinate", kept);
  // 하위 기록(id)은 보지 않는다
  await report("state=blocked:id=sub1");
  await sleep(300);
  check("프로그램 상태: 하위 기록(id)은 무시", (await shows("working", false)()), `${badge()?.textContent} ${await awaiting()}`);
  // 상태를 알리지 않는 선택 창 (폴더 신뢰 등): 화면으로 본다
  await run(term, String.raw`printf 'Allow this?\n\342\235\257 1. Yes\n  2. No\nEnter to confirm \302\267 Esc to cancel\n'`);
  const dialog = await waitAsync("선택 대기 표시", shows("waiting for a choice", true), 3000).then(() => true, () => false);
  check("프로그램 상태: 화면에 선택 창이 보이면 선택 대기, 깨우기 미룸", dialog, `${badge()?.textContent} ${await awaiting()}`);
  // 선택 창을 기다리는 동안은 작업 중이 아니다 (리뷰 R2)
  const dialogSleeps = await waitAsync("선택 창 동안 잠자기 허용", async () => !(await awake()), 3000).then(() => true, () => false);
  term.input("clear\r");
  const cleared = await waitAsync("선택 창 사라짐", shows("working", false), 5000).then(() => true, () => false);
  check("프로그램 상태: 선택 창이 사라지면 풀림", cleared, `${badge()?.textContent} ${await awaiting()}`);
  const keptAgain = await waitAsync("다시 잠자기 막음", async () => await awake(), 3000).then(() => true, () => false);
  check("잠자기 막기: 선택 창을 기다리는 동안 풀고, 닫혀 작업이 이어지면 다시 막음", dialogSleeps && keptAgain, `${dialogSleeps} ${keptAgain}`);
  await report("state=idle");
  const idle = await waitAsync("상태 없음", async () => !badge() && (await awaiting()) === false, 3000).then(() => true, () => false);
  check("프로그램 상태: idle이면 이름표에 상태 없음", idle, `${badge()?.textContent}`);
  const released = await waitAsync("잠자기 막기 풂", async () => !(await awake()), 3000).then(() => true, () => false);
  check("잠자기 막기: 작업 중인 터미널이 없어지면 풂", released);
  // 보낸 순서대로 도착한다: 먼저 보낸 "작업 중"을 늦게 보내도 뒤의 "작업 끝"이 남는다 (리뷰 R3)
  devHooks.statusDelay = (cmd, args) => (cmd === "pty_working" && args.working === true ? 800 : 0);
  await report("state=working");
  await report("state=idle");
  await sleep(1800);
  const ordered = !(await awake());
  devHooks.statusDelay = undefined;
  check("잠자기 막기: 상태는 보낸 순서대로 (먼저 보낸 것이 늦어도 마지막 상태)", ordered);
  // 링크의 실제 경로 (알림의 프로젝트와 등록한 링크 경로를 맞춘다, 리뷰 R1)
  const link = `${root}-ddak-link`;
  await run(term, `ln -sfn "${root}" "${link}"`);
  const resolved = await invoke<string>("real_path", { path: link });
  await run(term, `rm -f "${link}"`);
  check("알림 누르기: 링크 경로의 실제 경로", resolved === root && (await invoke<string>("real_path", { path: "/no/such/ddak" })) === "/no/such/ddak", resolved);
}

// 테마 토큰(#RRGGBB)의 계산된 색 모양 ("rgb(r, g, b)")
function tokenRgb(name: string) {
  const hex = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

// 상태·오류·git 추가·수정 글자의 대비: 모든 테마에서 그 바탕 위 작은 글자 4.5:1 이상 (WCAG AA, 리뷰 R3, 라이트 테마 리뷰 R1)
function testStatusContrastUnit() {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const low = Object.entries(THEMES).flatMap(([name, theme]) => {
    const ui = theme.ui;
    const pairs: [string, string, string][] = [
      ["working", ui["--status-working"], ui["--sidebar-bg"]],
      ["done", ui["--status-done"], ui["--sidebar-bg"]],
      ["awaiting", ui["--status-awaiting-fg"], ui["--status-awaiting-bg"]],
      // 오류 글자(이름표의 오류 상태, 메시지), Git Graph 파일 목록의 추가·삭제 글자, 파일 트리의 git 표시는 화면·사이드바 바탕 위에 쓴다
      ...(["--bg", "--sidebar-bg"] as const).flatMap((bg): [string, string, string][] => [
        [`error on ${bg}`, ui["--error"], ui[bg]],
        [`git-added on ${bg}`, ui["--git-added"], ui[bg]],
        [`git-modified on ${bg}`, ui["--git-modified"], ui[bg]],
      ]),
    ];
    return pairs.filter(([, fg, bg]) => ratio(fg, bg) < 4.5).map(([what, fg, bg]) => `${name} ${what} ${ratio(fg, bg).toFixed(2)}`);
  });
  check("상태 표시: 모든 테마에서 상태·오류·git 추가·수정 글자 대비 4.5:1 이상", low.length === 0, low.join(" | "));
}

// 터미널 링크 후보 (src/terminalLinks.ts findLinks): URL, 경로(줄 번호·문장 부호·조사), 경로가 아닌 것
function testTerminalLinksUnit() {
  const got = (text: string) => findLinks(text).map((f) => `${f.kind}:${f.target}@${text.slice(f.start, f.end)}`);
  const cases: [string, string[]][] = [
    ["see https://example.com/a?b=1. ok", ["url:https://example.com/a?b=1@https://example.com/a?b=1"]],
    ["open docs/spec.md에 적었습니다", ["path:docs/spec.md에@docs/spec.md에", "path:docs/spec.md@docs/spec.md"]],
    ["at src/x.ts:42:7, done", ["path:src/x.ts@src/x.ts:42:7"]],
    ["(report.html) and `/tmp/a b`", ["path:report.html@report.html", "path:/tmp/a@/tmp/a"]],
    ["version 2.1.310 and v1.0 then 10:41 PM", []],
    ["mailto:x@y.z and file://x", []],
  ];
  const bad = cases.filter(([text, want]) => JSON.stringify(got(text)) !== JSON.stringify(want)).map(([text]) => `${text} → ${JSON.stringify(got(text))}`);
  check("터미널 링크: 글자에서 URL·경로 후보 찾기 (줄 번호·문장 부호·조사, 버전·시각은 아님)", bad.length === 0, bad.join(" | "));
}

// Windows에서 다른 화면 쪽 규칙 (src/platform.ts, docs/windows-plan.md): 키 표시, 경로(\ 구분자·드라이브·UNC), 문서 안 링크,
// 터미널 링크 후보, 터미널 복사·붙여넣기. 맥에서도 Windows 쪽 값을 넣어 시험한다
function testPlatformUnit() {
  const bad: string[] = [];
  const eq = (what: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${what}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
  };
  eq("키 Windows", keyLabels("New Work Group (⇧⌘T) · ⌘-click to open · (⌘D)", true), "New Work Group (Ctrl+Shift+T) · Ctrl+click to open · (Ctrl+D)");
  eq("키 맥", keyLabels("(⇧⌘T)", false), "(⇧⌘T)");
  eq("이름", [platformBaseName("C:\\a\\b.md", true), platformBaseName("/a/b/", true), platformBaseName("C:\\", true)], ["b.md", "b", "C:"]);
  eq("폴더", [platformDirName("C:\\a\\b.md", true), platformDirName("C:\\b.md", true), platformDirName("/a/b.md", true), platformDirName("/b.md", true)], [
    "C:\\a", "C:\\", "/a", "/",
  ]);
  eq("정리", [normalizePath("C:\\a\\..\\..\\b/./c.md"), normalizePath("\\\\srv\\share\\x\\..\\y"), normalizePath("/a/../b")], ["C:\\b\\c.md", "\\\\srv\\share\\y", "/b"]);
  eq("상대", [relativeTo("C:\\p\\src\\a.ts", "C:\\p", true), relativeTo("C:\\pp\\a", "C:\\p", true), relativeTo("/p/a", "/p", true), relativeTo("/p", "/p", true)], [
    "src\\a.ts", undefined, "a", undefined,
  ]);
  eq("끝 구분자", [trimTrailingSep("C:\\p\\", true), trimTrailingSep("C:\\", true), trimTrailingSep("/p/", true)], ["C:\\p", "C:\\", "/p"]);
  // 맥에서 \ 는 이름의 일부다 (리뷰 R2: Finder의 "a\b.png", "project\" 폴더)
  eq("맥 \\ 이름", [
    platformBaseName("/p/a\\b.png", false),
    platformDirName("/x/a\\b", false),
    trimTrailingSep("/tmp/project\\", false),
    trimTrailingSep("/tmp/project/", false),
    normalizePath("/a/b\\c/../d\\e"),
    relativeTo("/p/a\\b", "/p", false),
  ], ["a\\b.png", "/x", "/tmp/project\\", "/tmp/project", "/a/d\\e", "a\\b"]);
  // file 주소 (리뷰 R3: Windows의 file:///C:/… 는 /C:/… 가 아니다)
  eq("file 주소", [
    fileUrlPath("file:///C:/Users/me/doc.md", true),
    fileUrlPath("file://localhost/C:/Users/%ED%95%9C/a%20b.md", true),
    fileUrlPath("file://srv/share/x.md", true),
    fileUrlPath("file:///Users/me/doc.md", false),
    fileUrlPath("file://localhost/Users/me/a%20b.md", false),
    fileUrlPath("file://srv/x.md", false),
  ], ["C:\\Users\\me\\doc.md", "C:\\Users\\한\\a b.md", "\\\\srv\\share\\x.md", "/Users/me/doc.md", "/Users/me/a b.md", null]);
  eq("문서 링크", [resolveHref("C:\\d\\docs\\spec.md", "../README.md#x"), resolveHref("C:\\d\\a.md", "C:\\e\\b.md")], [
    { kind: "file", path: "C:\\d\\README.md", anchor: "x" },
    { kind: "file", path: "C:\\e\\b.md", anchor: "" },
  ]);
  const links = (text: string, windows: boolean) => findLinks(text, windows).map((f) => `${f.kind}:${f.target}`);
  eq("링크 Windows", links("see C:\\Users\\me\\spec.md:12 and src\\x.ts", true), ["path:C:\\Users\\me\\spec.md", "path:src\\x.ts"]);
  eq("링크 맥", links("see C:\\Users\\me and src\\x", false), []);
  const key = (code: string, mods: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { code, ctrlKey: true, ...mods });
  eq("복사·붙여넣기", [
    clipboardKey(key("KeyC"), true, true),
    clipboardKey(key("KeyC"), false, true),
    clipboardKey(key("KeyV"), false, true),
    clipboardKey(key("KeyC", { shiftKey: true }), true, true),
    clipboardKey(key("KeyC"), true, false),
  ], ["copy", undefined, "paste", undefined, undefined]);
  check("Windows 규칙: 키 표시·경로·문서 링크·터미널 링크·복사 붙여넣기", bad.length === 0, bad.join(" | "));
}

// 넘친 줄의 링크: 넓은 글자가 줄 끝 한 칸에 못 들어가 다음 줄로 넘어가도 링크가 끊기지 않는다 (리뷰 R1).
// 화면 밖의 xterm에 직접 써서 링크 제공자에 줄마다 묻는다 (경로는 실제 파일로 link_targets)
async function testTerminalLinkWrap(root: string, shell: Terminal) {
  const dir = `${root}/lkw`;
  const box = document.createElement("div");
  box.style.cssText = "position:fixed; left:-3000px; top:0; width:900px; height:300px";
  document.body.appendChild(box);
  const results: string[] = [];
  const cases: { cols: number; text: string; cwd: string; want: string; rows: number[] }[] = [
    { cols: 80, text: `https://example.com/${"a".repeat(58)}/한글`, cwd: root, want: `https://example.com/${"a".repeat(58)}/한글`, rows: [1, 2] },
    { cols: 3, text: "a/한.md", cwd: dir, want: "a/한.md", rows: [1, 2, 3] },
    // 스스로 줄을 잘라 그리는 프로그램(claude): 별개의 두 줄에 이어 그린 경로. 앞 조각(a/)도 있는 폴더지만 이어 붙인 것 하나만
    { cols: 20, text: "  x a/\r\n  한.md에 끝", cwd: dir, want: "a/한.md", rows: [1, 2] },
    // 경로가 끝난 줄 다음에 설명·프롬프트가 와도 (리뷰 R1)
    { cols: 20, text: "  x a/\r\n  한.md\r\nNext step", cwd: dir, want: "a/한.md", rows: [1, 2] },
    { cols: 20, text: "  x a/\r\n  한.md\r\n❯", cwd: dir, want: "a/한.md", rows: [1, 2] },
  ];
  try {
    await run(shell, `mkdir -p "${dir}/a" && printf x > "${dir}/a/한.md"`);
    for (const c of cases) {
      const term = new Terminal({ cols: c.cols, rows: 6 });
      term.open(box);
      await new Promise<void>((r) => term.write(`${c.text}\r\n`, r));
      const provider = linkProvider(term, { id: () => undefined, cwd: () => c.cwd, hint: () => "" });
      for (const y of c.rows) {
        const links = await new Promise<ILink[] | undefined>((r) => provider.provideLinks(y, r));
        const got = links?.map((l) => `${l.text}@${l.range.start.x},${l.range.start.y}-${l.range.end.x},${l.range.end.y}`).join(" ") ?? "none";
        results.push(`${c.cols}열 ${y}줄: ${got}`);
        if (links?.length !== 1 || links[0].text !== c.want || links[0].range.start.y !== 1 || links[0].range.end.y !== c.rows.length) results.push("BAD");
      }
      term.dispose();
    }
  } finally {
    box.remove();
    await run(shell, `rm -rf "${dir}"`);
  }
  check("터미널 링크: 넓은 글자가 줄 끝에서 넘어가거나 프로그램이 다음 줄에 이어 그려도 한 링크 (모든 줄에서 같은 범위)", !results.includes("BAD"), results.join(" | "));
}

// 터미널 링크 (src/terminalLinks.ts, src-tauri/src/links.rs): 실제 화면에서 올리면 안내, ⌘+클릭하면 연다(자체 테스트는 기록).
// 상대 경로는 셸이 cd 한 폴더 기준 (창을 띄운 폴더에는 없는 파일), 없는 파일은 링크가 아님, 실행될 수 있는 것은 Finder에서 보이기만
async function testTerminalLinks(root: string, term: Terminal) {
  const dir = `${root}/lk`;
  await run(term, `mkdir -p "${dir}/sub" "${dir}/repo/.git" "${dir}/repo/docs" && printf x > "${dir}/report.html" && printf x > "${dir}/sub/notes.txt" && printf x > "${dir}/run.sh" && printf x > "${dir}/repo/docs/guide.txt" && cd "${dir}"`);
  await invoke("selftest_opened_links");
  await run(term, String.raw`printf '%s %s %s %s %s %s\n' 'LK report.html에' sub/notes.txt:12 https://example.com/a. missing.md run.sh docs/guide.txt`);
  const buf = term.buffer.active;
  let row = -1;
  for (let y = buf.length - 1; y >= 0 && row < 0; y--) if (buf.getLine(y)?.translateToString(true).startsWith("LK report")) row = y;
  // 그 줄에서 글자의 칸 (넓은 글자 뒤는 한 칸씩 밀린다)
  const columnOf = (text: string) => {
    const line = buf.getLine(row)!;
    let s = "";
    const xs: number[] = [];
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x)!;
      if (cell.getWidth() === 0) continue;
      for (const ch of cell.getChars() || " ") (s += ch), xs.push(x);
    }
    return xs[s.indexOf(text)];
  };
  const screenEl = term.element!.querySelector<HTMLElement>(".xterm-screen")!;
  const mouse = (type: string, x: number, meta = false) => {
    const r = screenEl.getBoundingClientRect();
    const [w, h] = [r.width / term.cols, r.height / term.rows];
    const init = { bubbles: true, cancelable: true, button: 0, metaKey: meta, clientX: r.left + (x + 0.5) * w, clientY: r.top + (row - buf.viewportY + 0.5) * h };
    screenEl.dispatchEvent(new MouseEvent(type, init));
  };
  const hint = "⌘-click to open";
  const hovered = async (text: string) => {
    mouse("mousemove", term.cols - 1);
    await sleep(100);
    mouse("mousemove", columnOf(text) + 1);
    return waitFor(`링크 안내: ${text}`, () => term.element!.getAttribute("title") === hint, 2000).then(() => true, () => false);
  };
  const click = async (text: string, meta: boolean) => {
    mouse("mousedown", columnOf(text) + 1, meta);
    mouse("mouseup", columnOf(text) + 1, meta);
    mouse("click", columnOf(text) + 1, meta);
    await sleep(200);
    return invoke<[string, string][]>("selftest_opened_links");
  };
  const results: Record<string, unknown> = {};
  for (const text of ["report.html", "sub/notes.txt", "https://example.com", "run.sh", "docs/guide.txt"]) {
    const shown = await hovered(text);
    const plain = await click(text, false);
    const opened = await click(text, true);
    results[text] = { shown, plain: plain.length, opened };
  }
  const missingShown = await hovered("missing.md");
  const opened = (text: string) => (results[text] as { opened: [string, string][] }).opened;
  const one = (text: string, kind: string, end: string) => {
    const r = results[text] as { shown: boolean; plain: number; opened: [string, string][] };
    return r.shown && r.plain === 0 && r.opened.length === 1 && r.opened[0][0] === kind && r.opened[0][1].endsWith(end);
  };
  check(
    "터미널 링크: 올리면 안내, ⌘+클릭으로 연다 (그냥 클릭은 아님). 상대 경로는 셸의 현재 폴더 기준, 조사·줄 번호·마침표는 뺌",
    one("report.html", "open", "/lk/report.html") && one("sub/notes.txt", "open", "/lk/sub/notes.txt") && opened("https://example.com")[0]?.[1] === "https://example.com/a" && one("https://example.com", "url", "/a"),
    JSON.stringify(results),
  );
  check("터미널 링크: 실행될 수 있는 파일은 열지 않고 Finder에서 보이기, 없는 파일은 링크 아님", one("run.sh", "reveal", "/lk/run.sh") && !missingShown, JSON.stringify({ run: results["run.sh"], missingShown }));
  check("터미널 링크: 그 폴더에 없는 상대 경로는 바로 아래 git 저장소에서 찾음", one("docs/guide.txt", "open", "/lk/repo/docs/guide.txt"), JSON.stringify(results["docs/guide.txt"]));
  mouse("mousemove", term.cols - 1);
  await run(term, `cd "${root}" && rm -rf "${dir}"`);
}

// 문서 탭 (src/DocView.tsx, src/docs.ts): 터미널의 .md를 ⌘+클릭하거나 파일 트리에서 더블클릭하면 앱 안 탭으로 읽기 전용으로 본다.
// 문서의 HTML은 글자로, 체크박스·표·제목 앵커, 로컬 그림은 data: 주소로, 웹 그림은 링크로. 링크는 웹은 브라우저, 다른 문서는
// 문서 탭. 같은 파일은 한 탭. 파일이 바뀌면 다시 그린다
async function testDocView(root: string, term: Terminal) {
  const dir = `${root}/dv`;
  const lines = [
    "# Doc Title",
    "- [ ] todo",
    "- [x] done",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "<script>window.__docScript = 1</script>",
    "",
    "[next](docs-b.md) [web](https://example.com/doc) [jump](#second-part) [detail](docs-b.md#detail-part)",
    "",
    "![pic](pic.png) ![remote](https://example.com/x.png)",
    "",
    "## Second Part",
  ];
  // 1×1 PNG
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  await run(term, `mkdir -p "${dir}" && cd "${dir}" && printf '%s\\n' ${lines.map((l) => `'${l}'`).join(" ")} > docs-a.md && { printf '# B\\n'; seq 1 200 | sed 's/^/filler /;s/$/\\n/'; printf '## Detail Part\\n'; seq 1 200 | sed 's/^/after /;s/$/\\n/'; } > docs-b.md && printf '%s' '${png}' | base64 -D > pic.png`);
  const ws = () => document.querySelector<HTMLElement>(".project-workspace:not([style*='none'])")!;
  const startTab = activeTabEl()!.dataset.tab;
  const tabs = () => tabCount();
  const before = tabs();
  const view = (name: string) => [...ws().querySelectorAll<HTMLElement>(".doc-view")].find((v) => v.dataset.doc?.endsWith(`/${name}`) && v.offsetParent !== null);
  const activeTitle = () => activeTabEl()?.querySelector(".tab-title")?.textContent;

  // 터미널에서 ⌘+클릭: 기본 앱이 아니라 문서 탭
  await invoke("selftest_opened_links");
  await run(term, `printf 'DOCLK %s\\n' docs-a.md`);
  const buf = term.buffer.active;
  let row = -1;
  for (let y = buf.length - 1; y >= 0 && row < 0; y--) if (buf.getLine(y)?.translateToString(true).startsWith("DOCLK docs-a.md")) row = y;
  const screenEl = term.element!.querySelector<HTMLElement>(".xterm-screen")!;
  const mouse = (type: string, x: number, meta = false) => {
    const r = screenEl.getBoundingClientRect();
    const [w, h] = [r.width / term.cols, r.height / term.rows];
    screenEl.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, metaKey: meta, clientX: r.left + (x + 0.5) * w, clientY: r.top + (row - buf.viewportY + 0.5) * h }));
  };
  mouse("mousemove", term.cols - 1);
  await sleep(100);
  mouse("mousemove", 8);
  await waitFor("링크 안내", () => term.element!.getAttribute("title") === "⌘-click to open", 2000).catch(() => null);
  for (const type of ["mousedown", "mouseup", "click"]) mouse(type, 8, true);
  const a = await waitFor("문서 탭", () => view("docs-a.md")?.querySelector("h1"), 5000).catch(() => null);
  const external = await invoke<[string, string][]>("selftest_opened_links");
  check("문서 탭: 터미널의 .md를 ⌘+클릭하면 기본 앱이 아니라 앱 안 문서 탭", !!a && tabs() === before + 1 && activeTitle() === "docs-a.md" && external.length === 0, `${a?.textContent} ${tabs()}/${before} ${activeTitle()} ${JSON.stringify(external)}`);

  // 만든 HTML에 그림의 바깥·로컬 주소가 없다 (화면에 넣는 순간 요청이 나가므로, 리뷰 R1). 다른 컴퓨터의 file:// 은 문서 탭 아님 (R3)
  const made = renderMarkdown("![r](https://example.com/b.png?x) ![l](pic.png) ![d](data:image/png;base64,AA==)", (n) => `[${n}]`);
  check(
    "문서 탭: 그림은 만든 HTML에 바깥·로컬 주소 없이 (웹은 링크 글자, 로컬은 data-src, data:만 src), 다른 컴퓨터의 file:// 은 문서 탭 아님",
    !/[^-]src="(?!data:)/.test(made) && made.includes('<a href="https://example.com/b.png?x">[r]</a>') && made.includes('data-src="pic.png"') && made.includes('src="data:image/png;base64,AA=="') &&
      docPathOf("file:///p/a.md") === "/p/a.md" && docPathOf("file://localhost/p/a%20b.md") === "/p/a b.md" && docPathOf("file://other/p/a.md") === null && docPathOf("/p/a.txt") === null && docPathOf("/p/A.MD") === "/p/A.MD",
    `${made} | ${JSON.stringify(["file:///p/a.md", "file://localhost/p/a%20b.md", "file://other/p/a.md", "/p/a.txt", "/p/A.MD"].map(docPathOf))}`,
  );
  const v = view("docs-a.md")!;
  const body = v.querySelector<HTMLElement>(".doc-body")!;
  const boxes = [...body.querySelectorAll<HTMLInputElement>("input.doc-task")];
  check(
    "문서 탭: 제목 앵커·체크박스(읽기 전용)·표를 그리고, 문서의 HTML은 실행하지 않고 글자로",
    body.querySelector("h1")?.id === "doc-title" && body.querySelector("h2")?.id === "second-part" && boxes.length === 2 && boxes.every((b) => b.disabled) && !boxes[0].checked && boxes[1].checked &&
      body.querySelectorAll("td").length === 2 && !body.querySelector("script") && body.textContent!.includes("<script>window.__docScript = 1</script>") && !(window as unknown as { __docScript?: number }).__docScript,
    body.innerHTML.slice(0, 400),
  );
  const pic = await waitFor("로컬 그림", () => body.querySelector<HTMLImageElement>("img[alt=pic]")?.naturalWidth === 1 && body.querySelector<HTMLImageElement>("img[alt=pic]"), 3000).catch(() => null);
  const webImage = [...body.querySelectorAll("a")].find((el) => el.textContent === "[Image: remote]");
  check(
    "문서 탭: 로컬 그림은 data: 주소로 보이고, 웹 그림은 불러오지 않고 링크로",
    !!pic?.src.startsWith("data:image/png;base64,") && !!webImage && webImage.getAttribute("href") === "https://example.com/x.png" && !body.querySelector("img[src^='http']"),
    `${pic?.src.slice(0, 30)} ${webImage?.outerHTML} ${body.querySelectorAll("img").length}`,
  );

  // 링크: 웹은 브라우저 (앱 화면은 그대로), #은 이 문서 안, 다른 문서는 문서 탭
  const link = (text: string) => [...body.querySelectorAll<HTMLElement>("a")].find((el) => el.textContent === text)!;
  const href = location.href;
  link("web").click();
  link("jump").click();
  await sleep(200);
  const web = await invoke<[string, string][]>("selftest_opened_links");
  link("next").click();
  const b = await waitFor("다른 문서 탭", () => view("docs-b.md")?.querySelector("h1"), 5000).catch(() => null);
  check(
    "문서 탭: 웹 링크는 브라우저로, #제목은 문서 안에서, 다른 .md는 문서 탭으로 (앱 화면은 떠나지 않음)",
    JSON.stringify(web) === JSON.stringify([["url", "https://example.com/doc"]]) && location.href === href && b?.textContent === "B" && activeTitle() === "docs-b.md" && tabs() === before + 2,
    `${JSON.stringify(web)} ${location.href === href} ${b?.textContent} ${activeTitle()} ${tabs()}`,
  );

  // 다른 문서의 #제목 링크: 그 문서 탭을 열고 그 제목으로 (리뷰 R2)
  const backToA = [...ws().querySelectorAll<HTMLElement>(".tab")].find((el) => el.querySelector(".tab-title")?.textContent === "docs-a.md");
  backToA?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await waitFor("a 탭", () => activeTitle() === "docs-a.md", 2000).catch(() => null);
  link("detail").click();
  const bBody = () => view("docs-b.md")?.querySelector<HTMLElement>(".doc-body");
  const scrolled = await waitFor("제목으로", () => activeTitle() === "docs-b.md" && (bBody()?.scrollTop ?? 0) > 0, 3000).then(() => true, () => false);
  const heading = bBody()?.querySelector("#detail-part")?.getBoundingClientRect().top ?? -1;
  const top = bBody()?.getBoundingClientRect().top ?? 0;
  check("문서 탭: 다른 문서의 #제목 링크는 그 문서를 열고 그 제목으로", scrolled && Math.abs(heading - top) < 40, `${scrolled} ${activeTitle()} ${bBody()?.scrollTop} ${heading - top}`);
  backToA?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await waitFor("a 탭", () => activeTitle() === "docs-a.md", 2000).catch(() => null);

  // 파일 트리에서 더블클릭: 이미 열린 파일은 그 탭으로 (새 탭 없음)
  const dvRow = await waitFor("트리의 폴더", () => fileRow("dv"), 5000).catch(() => null);
  dvRow?.click();
  const treeRow = await waitFor("트리의 문서", () => fileRow("docs-a.md"), 5000).catch(() => null);
  treeRow?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await waitFor("그 탭으로", () => activeTitle() === "docs-a.md", 3000).catch(() => null);
  check("문서 탭: 파일 트리에서 더블클릭하면 열고, 이미 열린 파일은 그 탭으로", !!treeRow && activeTitle() === "docs-a.md" && tabs() === before + 2, `${!!treeRow} ${activeTitle()} ${tabs()}`);

  // 파일이 바뀌면 다시 그린다
  await run(term, `printf 'UPDATED_LINE\\n' >> "${dir}/docs-a.md"`);
  const updated = await waitFor("다시 그림", () => view("docs-a.md")?.querySelector(".doc-body")?.textContent?.includes("UPDATED_LINE"), 5000).then(() => true, () => false);
  check("문서 탭: 파일이 바뀌면 다시 그림", updated);

  // 오른쪽 클릭 메뉴의 미리 보기 (다른 탭에 있다가 고르면 그 탭으로)
  ws().querySelector<HTMLElement>(`.tab[data-tab="${startTab}"]`)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  rightClick(fileRow("docs-b.md")!);
  await waitFor("메뉴", contextMenu);
  const docMenu = menuLabels().join(",");
  await pickMenu("Open Preview");
  await waitFor("메뉴로 연 탭", () => activeTitle() === "docs-b.md", 3000).catch(() => null);
  check("문서 탭: 트리 메뉴에 미리 보기·기본 앱으로 열기, 미리 보기는 문서 탭으로", docMenu.startsWith("Open Preview,Open in Default App,-,") && activeTitle() === "docs-b.md" && tabs() === before + 2, `${docMenu} ${activeTitle()} ${tabs()}`);

  // 정리: 문서 탭을 닫고 처음 탭으로
  for (const name of ["docs-a.md", "docs-b.md"]) {
    const tab = [...ws().querySelectorAll<HTMLElement>(".tab")].find((el) => el.querySelector(".tab-title")?.textContent === name);
    tab?.querySelector<HTMLElement>(".tab-close")?.click();
  }
  await waitFor("문서 탭 닫힘", () => tabs() === before, 3000).catch(() => null);
  ws().querySelector<HTMLElement>(`.tab[data-tab="${startTab}"]`)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  fileRow("dv")?.click();
  await run(term, `cd "${root}" && rm -rf "${dir}"`);
}

// 채팅에서 고른 답 넣기 (src/programStatus.ts driveAnswer): 가짜 선택 창에 화살표를 하나씩 보내 커서가 따라온 뒤에만 Enter.
// 화면이 바뀌거나 커서가 따라오지 않으면 Enter 없이 끝난다
// 대체 화면의 위 사라짐 따라가기 (programStatus.ts watchAltLoss): 화면에 붙이지 않은 실제 xterm에 써 본다.
// 넘침·위로 밀기(CSI S)·줄 지우기(CSI M)·크기 바꾸기는 사라짐, 화면 지우기(CSI 2 J, 맨 앞 CSI J)·화면 바꾸기는 처음부터,
// CSI 3 J는 화면을 지우지 않으므로 그대로 (재리뷰 R1). 일반 화면에서는 늘 아님
// 권한 모드 (src/programStatus.ts readMode·driveMode): 맨 아래 모드 줄만 읽고 (대화 중의 같은 글은 아님), Shift+Tab을 하나씩 보내
// 모드 줄이 바뀌는 것을 확인하며 고른 모드까지. 바뀌지 않거나 지난 모드로 돌아오거나 줄이 사라지거나 쓰는 차례에 줄이 바뀌면 멈춘다
async function testPermissionModeUnit() {
  const read = [
    readMode(["hi", "", "  ⏵⏵ auto mode on (shift+tab to cycle)", ""]),
    readMode(["  ⏸ manual mode on · ? for shortcuts"]),
    readMode(["x", "  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt"]),
    readMode(["  ⏸ plan mode on (shift+tab to cycle)", "  ⚠ some notice"]),
    readMode(["  ⏵⏵ bypass permissions on"]),
    readMode(["  ⏸ plan mode on (shift+tab to cycle)", "a", "b"]),
    readMode(["> tell me about ⏵⏵ auto mode on", ""]),
    readMode(["? for shortcuts"]),
  ];
  check(
    "권한 모드: 맨 아래 두 줄의 모드 줄만 읽음 (자동·수동·편집 허용·계획·bypass, 그 위나 대화 안의 글은 아님)",
    JSON.stringify(read) === JSON.stringify(["auto", "manual", "acceptEdits", "plan", "bypass", null, null, null]),
    JSON.stringify(read),
  );
  const CYCLE: PermissionMode[] = ["auto", "manual", "acceptEdits", "plan"];
  // stuck: 키에 모드가 바뀌지 않음, back: 이 번째 키에 첫 모드로 돌아감, blink: 이 번째 키 뒤 한 번만 모드 줄이 사라졌다 돌아옴,
  // queueChange: 이 번째 키가 쓰는 차례를 기다리는 동안 모드가 바뀜, failAt: 이 번째 쓰기가 실패, cycle: 실제로 도는 순서
  const run = async (o: { from: PermissionMode; target: PermissionMode; stuck?: boolean; back?: number; blink?: number; queueChange?: number; failAt?: number; cycle?: PermissionMode[] }) => {
    const cycle = o.cycle ?? CYCLE;
    let mode: PermissionMode = o.from;
    let hidden = false;
    let tries = 0;
    let keys = 0;
    let clock = 0;
    const result = await driveMode({
      target: o.target,
      read: () => {
        if (!hidden) return mode;
        hidden = false;
        return null;
      },
      send: async (data, ok) => {
        tries++;
        if (tries === o.queueChange) mode = "plan";
        if (!ok(mode)) return "skipped";
        if (tries === o.failAt) return "error";
        keys++;
        if (data !== "\x1b[Z" || o.stuck) return "sent";
        mode = keys === o.back ? o.from : cycle[(cycle.indexOf(mode) + 1) % cycle.length];
        hidden = keys === o.blink;
        return "sent";
      },
      sleep: async () => void (clock += 100),
      now: () => clock,
    });
    return `${result}:${keys}:${mode}`;
  };
  const got = [
    await run({ from: "auto", target: "manual" }),
    await run({ from: "auto", target: "plan" }),
    await run({ from: "manual", target: "auto" }),
    await run({ from: "plan", target: "plan" }),
    await run({ from: "auto", target: "manual", stuck: true }),
    await run({ from: "auto", target: "plan", back: 2 }),
    await run({ from: "auto", target: "plan", blink: 1 }),
    await run({ from: "auto", target: "acceptEdits", queueChange: 2 }),
    await run({ from: "auto", target: "manual", failAt: 1 }),
    await run({ from: "auto", target: "acceptEdits", cycle: ["auto", "plan", "bypass", "acceptEdits", "manual"] }),
    await run({ from: "bypass", target: "manual" }),
  ];
  const want = ["sent:1:manual", "sent:3:plan", "sent:3:auto", "sent:0:plan", "failed:1:auto", "failed:2:auto", "changed:1:manual", "changed:1:plan", "failed:0:auto", "failed:1:plan", "failed:0:bypass"];
  check(
    "권한 모드: Shift+Tab을 하나씩 보내 순서의 바로 다음 모드로 바뀐 것을 확인하며 고른 모드까지 (이미 그 모드면 보내지 않음). 바뀌지 않음·다음이 아닌 모드·순서에 없는 모드에서 시작·쓰기 실패는 failed, 모드 줄이 한 번이라도 사라지거나 쓰는 차례에 바뀌면 changed (리뷰 R2)",
    JSON.stringify(got) === JSON.stringify(want),
    JSON.stringify(got),
  );
}

async function testAltLossUnit() {
  const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
  const loss = watchAltLoss(term);
  const w = (data: string) => new Promise<void>((r) => term.write(data, r));
  const ten = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\r\n");
  const seen: string[] = [];
  const note = (what: string) => seen.push(`${what}=${loss.lost()}`);
  await w("\x1b[?1049h\x1b[2J\x1b[H" + ten);
  note("fit");
  await w("\r\nmore");
  note("overflow");
  await w("\x1b[2J\x1b[H" + ten);
  note("ED2");
  await w("\r\nx\x1b[3J");
  note("ED3");
  await w("\x1b[2J\x1b[H" + ten + "\x1b[S");
  note("SU");
  await w("\x1b[H\x1b[J" + ten);
  note("ED0home");
  await w("\x1b[H\x1b[M");
  note("DL");
  await w("\x1b[2J\x1b[H" + ten);
  term.resize(40, 8);
  note("resize");
  await w("\x1b[?1049l");
  note("normal");
  await w("\x1b[?1049h");
  note("reenter");
  loss.dispose();
  term.dispose();
  const expected = "fit=false,overflow=true,ED2=false,ED3=true,SU=true,ED0home=false,DL=true,resize=true,normal=false,reenter=false";
  check("선택 창 읽기: 대체 화면의 위 사라짐 (넘침·CSI S·CSI M·크기 바꾸기) / 지우기·화면 바꾸기는 처음부터, CSI 3 J는 아님", seen.join() === expected, seen.join());
}

export async function testPromptAnswerUnit(ok: (name: string, pass: boolean, detail?: string) => void = check) {
  // 가짜 선택 창. 키를 쓰면 커서가 움직인다 (stuck이면 안 움직임). changeAfter: 그만큼 쓴 뒤 질문이 바뀜.
  // queueChange: 그 번째 키가 쓰는 차례를 기다리는 동안 질문이 바뀜 (리뷰 R1). cancelAfter: 그만큼 쓴 뒤 취소 (새 답이 옴, 리뷰 R3).
  // failAt: 그 번째 쓰기가 실패 (리뷰 R4)
  const run = async (o: { cursor: number; option: number; app?: boolean; changeAfter?: number; queueChange?: number; cancelAfter?: number; failAt?: number; stuck?: boolean; expected?: Dialog }) => {
    const shown: Dialog = { question: ["Do you want to proceed?"], options: ["Yes", "Yes, always", "No"], cursor: o.cursor, complete: true };
    const sent: string[] = [];
    let tries = 0;
    let clock = 0;
    const result = await driveAnswer({
      option: o.option,
      expected: o.expected ?? { ...shown },
      read: () => ({ ...shown }),
      send: async (data, check) => {
        tries++;
        if (tries === o.queueChange) shown.question = ["Something else?"];
        if (!check({ ...shown })) return "skipped";
        if (tries === o.failAt) return "error";
        sent.push(data);
        if (o.changeAfter !== undefined && sent.length >= o.changeAfter) shown.question = ["Something else?"];
        if (!o.stuck && /[AB]$/.test(data)) shown.cursor += data.endsWith("B") ? 1 : -1;
        return "sent";
      },
      appCursor: () => !!o.app,
      cancelled: () => o.cancelAfter !== undefined && sent.length >= o.cancelAfter,
      sleep: async () => void (clock += 100),
      now: () => clock,
    });
    return `${result}:${sent.map((s) => JSON.stringify(s)).join(",")}`;
  };
  const got = [
    await run({ cursor: 0, option: 2 }),
    await run({ cursor: 2, option: 0, app: true }),
    await run({ cursor: 1, option: 1 }),
    await run({ cursor: 0, option: 2, changeAfter: 1 }),
    await run({ cursor: 0, option: 1, stuck: true }),
    await run({ cursor: 0, option: 1, expected: { question: ["Other?"], options: ["Yes", "Yes, always", "No"], cursor: 0, complete: true } }),
    await run({ cursor: 0, option: 3 }),
    await run({ cursor: 0, option: 1, queueChange: 2 }),
    await run({ cursor: 0, option: 1, cancelAfter: 1 }),
    await run({ cursor: 0, option: 1, failAt: 2 }),
    await run({ cursor: 0, option: 0, expected: { question: ["Do you want to proceed?"], options: ["Yes", "Yes, always", "No"], cursor: 0, complete: false } }),
  ];
  const want = [
    String.raw`sent:"\u001b[B","\u001b[B","\r"`,
    String.raw`sent:"\u001bOA","\u001bOA","\r"`,
    String.raw`sent:"\r"`,
    String.raw`changed:"\u001b[B"`,
    String.raw`failed:"\u001b[B"`,
    "changed:",
    "changed:",
    String.raw`changed:"\u001b[B"`,
    String.raw`changed:"\u001b[B"`,
    String.raw`failed:"\u001b[B"`,
    "changed:",
  ];
  // 한 터미널의 답 처리: 늦게 온 앞 요청(2 다음 1)·재전달(2 다시)은 버리고 지금 것을 건드리지 않음, 더 새 요청(3)은 지금 것을 취소
  const runs = new AnswerRuns();
  const two = runs.start(2);
  const late = runs.start(1);
  const again = runs.start(2);
  const twoAlive = !!two && !two.cancelled;
  const three = runs.start(3);
  ok(
    "선택 창 답 넣기: 늦게 온 앞 요청·재전달은 버리고 지금 처리를 건드리지 않음, 더 새 요청은 지금 처리를 취소",
    late === null && again === null && twoAlive && !!three && two!.cancelled && !three.cancelled,
    JSON.stringify({ late, again, twoAlive, two, three }),
  );
  ok(
    "선택 창 답 넣기: 화살표를 하나씩 보내 커서가 따라온 뒤에만 Enter (응용 커서 키 모드는 ESC O). 화면이 바뀌거나(쓰는 차례를 기다리는 동안 포함) 취소되거나 커서가 안 따라오거나 쓰기가 실패하거나 알린 것과 다르거나 질문이 잘렸으면 Enter 없음",
    JSON.stringify(got) === JSON.stringify(want),
    got.join(" | "),
  );
}

function testTerminalReplyUnit() {
  // xterm 6.0이 만드는 응답 전부 (src/Terminal.tsx 주석)
  const replies = [
    "\x1b[?1;2c", "\x1b[?6c", "\x1b[>0;276;0c", "\x1b[>85;95;0c", "\x1b[>83;40003;0c", "\x1b[0n", "\x1b[12;40R", "\x1b[?12;40R",
    "\x1b[8;24;80t", "\x1b[4;600;800t", "\x1b[6;17;8t", "\x1b[?2004;1$y", "\x1b[4;2$y", "\x1bP1$r0m\x1b\\",
    "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\", "\x1b]10;rgb:0/0/0\x07", "\x1b[I", "\x1b[O",
  ];
  // 키·붙여넣기 (xterm 키보드: 화살표·Home·End·F1-F12·⇧Tab·수식 키, src/common/input/Keyboard.ts)
  const keys = [
    "a", "abc", "\r", "\x1b\r", "\x1b[A", "\x1bOA", "\x1b[1;5C", "\x1b[H", "\x1b[F", "\x1bOP", "\x1b[1;2P", "\x1b[15~", "\x1b[24;5~",
    "\x1b[Z", "\x7f", "\x03", "한글", "\x1b[200~pasted\x1b[201~",
  ];
  const wrongReplies = replies.filter((r) => !isTerminalReply(r));
  const wrongKeys = keys.filter((k) => isTerminalReply(k));
  check("깨우기: 터미널 자동 응답과 사용자 키를 구분", !wrongReplies.length && !wrongKeys.length, JSON.stringify({ wrongReplies, wrongKeys }));
}

// 실제 키 이벤트로 친다 (keydown, 그것으로 글자가 나오지 않으면 keypress). \r은 Enter 키. 프로그램 입력(term.input)은
// 사용자 입력으로 보지 않는다 (깨우기). 보낸 것을 돌려준다.
function typeKeys(term: Terminal, text: string) {
  const sent: string[] = [];
  const d = term.onData((x) => sent.push(x));
  for (const ch of text) {
    const before = sent.length;
    for (const type of ["keydown", "keypress"]) {
      if (type === "keypress" && sent.length > before) break;
      const key = ch === "\r" ? "Enter" : ch;
      const ev = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
      const code = ch === "\r" ? 13 : type === "keydown" ? ch.toUpperCase().charCodeAt(0) : ch.charCodeAt(0);
      for (const prop of ["keyCode", "which"]) Object.defineProperty(ev, prop, { get: () => code });
      Object.defineProperty(ev, "charCode", { get: () => (type === "keypress" ? code : 0) });
      term.textarea!.dispatchEvent(ev);
    }
  }
  d.dispose();
  return sent.join("");
}

async function testImeUnit() {
  const box = document.createElement("div");
  box.style.cssText = "position:fixed; left:-2000px; top:0; width:400px; height:200px";
  document.body.appendChild(box);
  const term = new Terminal();
  term.open(box);
  const ta = term.textarea!;
  const undo = fixImeInput(term, box, ta);
  const out: string[] = [];
  const d = term.onData((x) => out.push(x));
  const input = (inputType: string, data: string, value: string) => {
    ta.dispatchEvent(new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true, composed: true }));
    ta.value = value;
    ta.dispatchEvent(new InputEvent("input", { inputType, data, bubbles: true, composed: true }));
  };
  try {
    // 키 구간(입력기 keydown 직후)에 키와 무관한 전송(터미널 응답 등)이 있어도 다음 첫 자모는 나가야 한다 (리뷰 지적 3)
    const k = new KeyboardEvent("keydown", { key: "ㄴ", bubbles: true, cancelable: true });
    Object.defineProperty(k, "keyCode", { get: () => 229 });
    ta.dispatchEvent(k);
    term.input("\x1b[0n", false); // 상태 보고 응답 같은 자동 전송
    input("insertText", "ㅎ", "ㅎ");
    check("한글 보정: 키 구간의 자동 응답 뒤에도 첫 자모를 보냄", out.includes("ㅎ"), JSON.stringify(out));
    await sleep(20);

    // 이모지 바꾸기: 코드 포인트 단위로 바꿔야 한다 (리뷰 지적 4)
    ta.value = "x😀";
    out.length = 0;
    input("insertReplacementText", "😁", "x😁");
    check("한글 보정: 이모지 바꾸기를 코드 포인트 단위로", out.join("") === "\x7f😁", JSON.stringify(out));
  } finally {
    d.dispose();
    undo();
    term.dispose();
    box.remove();
  }
}

// 오른쪽 클릭 → 이름 바꾸기
// 휴지통·끌어 놓기 (FileTree.tsx, dragPath.ts): 오른쪽 클릭 "Move to Trash"는 확인을 받고 휴지통으로 옮긴다 (자체 테스트는
// 앱 데이터의 trash 폴더, src-tauri/src/fs.rs fs_trash). 취소하면 그대로. 트리 항목을 터미널에 놓으면 셸용으로 감싼 절대 경로,
// 채팅 입력란에는 트리 루트 기준 상대 경로. 끌기는 합성 DragEvent라 실제 마우스 끌기는 직접 확인해야 한다.
async function testTrashAndDrag(root: string, term: Terminal) {
  await run(term, `printf x > "${root}/trash me.txt" && printf y > "${root}/keep.txt" && printf z > "${root}/d d's.txt"`);
  await waitFor("새 파일", () => fileRow("trash me.txt") && fileRow("keep.txt") && fileRow("d d's.txt"), 3000);
  const realConfirm = devHooks.confirm;
  let asked = "";
  devHooks.confirm = async (m) => ((asked = m), false);
  rightClick(fileRow("keep.txt")!);
  await waitFor("메뉴", contextMenu);
  await pickMenu("Move to Trash");
  await sleep(500);
  const kept = !!fileRow("keep.txt") && asked.includes("keep.txt");
  devHooks.confirm = async () => true;
  rightClick(fileRow("trash me.txt")!);
  await waitFor("메뉴", contextMenu);
  await pickMenu("Move to Trash");
  const gone = await waitFor("휴지통으로", () => !fileRow("trash me.txt"), 3000).then(() => true, () => false);
  devHooks.confirm = realConfirm;
  const dataDir = await invoke<string>("groups_dir");
  const inTrash = (await run(term, `ls "${dataDir}/trash" | grep -c "trash me.txt"`)).some((l) => l.trim() === "1");
  check("휴지통: 취소하면 그대로, 확인하면 트리와 디스크에서 사라져 휴지통으로 (시험에서는 앱 데이터 trash)", kept && gone && inTrash, `${kept} ${gone} ${inTrash} ${asked}`);

  const drag = (name: string, target: Element) => {
    const dt = new DataTransfer();
    fileRow(name)!.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(over);
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return over.defaultPrevented;
  };
  // 놓은 경로를 printf로 돌려 셸이 받은 그대로 찍는다 (화면의 입력 줄은 길면 셸이 다시 그려서 그대로 읽기 어렵다)
  const termEl = [...liveTerms].find(([, x]) => x === term)![0];
  term.input("printf 'GOT[%s]\\n' ");
  const accepted = drag("d d's.txt", termEl);
  await sleep(200);
  term.input("\r");
  const expected = `GOT[${root}/d d's.txt]`;
  const line = await waitFor("놓은 경로", () => screen(term).find((l) => l.includes(expected)), 3000).catch(() => screen(term).at(-1) ?? "");
  const chatInput = document.querySelector<HTMLTextAreaElement>(".project-workspace:not([style*='none']) .chat-input")!;
  drag("keep.txt", chatInput);
  const relDropped = await waitFor("채팅에 놓은 경로", () => chatInput.value === "keep.txt " && chatInput.value, 3000).catch(() => chatInput.value);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(chatInput, "");
  chatInput.dispatchEvent(new Event("input", { bubbles: true }));
  check(
    "끌어 놓기: 터미널에는 셸용으로 감싼 절대 경로, 채팅 입력란에는 트리 루트 기준 상대 경로",
    accepted && line.includes(expected) && relDropped === "keep.txt ",
    `${accepted} ${line} | ${JSON.stringify(relDropped)}`,
  );
  await run(term, `rm -f "${root}/keep.txt" "${root}/d d's.txt"`);

  // Finder 등 앱 밖에서 끌어 온 파일: 터미널에는 감싼 절대 경로, 채팅 입력란에는 절대 경로, 그 밖의 곳은 받지 않는다
  // (놓을 수 없게 표시, 기본 동작 없음. 기본 동작은 웹뷰가 그 파일로 이동해 작업 화면이 사라지는 것이었다).
  // 경로는 Rust가 끌기 대지에서 읽는다: 시험에서는 이름 붙인 대지에 Finder처럼 파일 참조 주소로 싣는다 (fs.rs)
  await run(term, `printf x > "${root}/사진 1.png" && printf y > "${root}/b.txt"`);
  const outsidePaths = [`${root}/사진 1.png`, `${root}/b.txt`];
  // 실제 끌기처럼 dragover와 drop 사이를 둔다 (끌기 중에 받은 대지 번호만 쓴다)
  const outside = async (target: Element, names: string[]) => {
    const dt = new DataTransfer();
    for (const n of names) dt.items.add(new File(["x"], n));
    const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(over);
    await sleep(100);
    const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(drop);
    // 합성 DataTransfer는 dropEffect를 바꿔도 남지 않아 (늘 none) 기본 동작을 막았는지만 본다
    return over.defaultPrevented && drop.defaultPrevented;
  };
  await invoke("selftest_drag_files", { paths: outsidePaths });
  term.input("printf 'GOT[%s]\\n' ");
  const onTerm = await outside(termEl, ["사진 1.png", "b.txt"]);
  await sleep(300);
  term.input("\r");
  const termExpected = `GOT[${root}/사진 1.png]`;
  const termLines = await waitFor("놓은 파일 경로", () => screen(term).some((l) => l.includes(termExpected)) && screen(term), 3000).catch(() => screen(term));
  const termGot = termLines.includes(termExpected) && termLines.includes(`GOT[${root}/b.txt]`);
  const onChat = await outside(chatInput, ["사진 1.png", "b.txt"]);
  const chatGot = await waitFor("채팅에 놓은 파일 경로", () => chatInput.value !== "" && chatInput.value, 3000).catch(() => chatInput.value);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(chatInput, "");
  chatInput.dispatchEvent(new Event("input", { bubbles: true }));
  check(
    "끌어 놓기: Finder에서 놓은 파일은 터미널에 감싼 절대 경로, 채팅 입력란에 절대 경로 (여러 개, 한글·공백 이름)",
    onTerm && termGot && onChat && chatGot === `${outsidePaths.join(" ")} `,
    `${onTerm} ${termGot} ${onChat} ${JSON.stringify(chatGot)} | ${termLines.filter((l) => l.includes("GOT[")).join(" / ")}`,
  );
  // 끌기 대지가 이 끌기의 것이 아니면 아무것도 넣지 않는다: 이름이 다름, 대지에 더 있음, 이름 수가 다름(같은 이름 둘),
  // 이름은 같아도 끌기 중에 본 뒤 대지가 바뀜 (새 끌기)
  const setChat = (v: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(chatInput, v);
    chatInput.dispatchEvent(new Event("input", { bubbles: true }));
  };
  // quick: dragover 바로 뒤에 놓는다 (대지 번호를 아직 묻는 중)
  const chatAfter = async (names: string[], board: string[], between?: () => Promise<unknown>, quick = false) => {
    await invoke("selftest_drag_files", { paths: board });
    const dt = new DataTransfer();
    for (const n of names) dt.items.add(new File(["x"], n));
    chatInput.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    if (!quick) await sleep(100);
    await between?.();
    const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
    chatInput.dispatchEvent(drop);
    await sleep(500);
    const v = chatInput.value;
    setChat("");
    return drop.defaultPrevented ? v : "(not taken)";
  };
  const bTxt = `${root}/b.txt`;
  const stale = [
    await chatAfter(["다른 파일.png"], [bTxt]),
    await chatAfter(["b.txt"], [bTxt, `${root}/사진 1.png`]),
    await chatAfter(["b.txt", "b.txt"], [bTxt]),
    await chatAfter(["b.txt"], [bTxt], () => invoke("selftest_drag_files", { paths: [bTxt] })),
    // 새 끌기(대지를 다시 실음) 바로 뒤라 이 끌기 중의 번호를 아직 받지 못함: 앞 끌기 때 받은 번호와 달라 쓰지 않는다
    await chatAfter(["b.txt"], [bTxt], undefined, true),
  ];
  const fresh = await chatAfter(["b.txt"], [bTxt]);
  const refused = [await outside(document.querySelector(".sidebar .tree") ?? document.body, ["b.txt"]), await outside(document.body, ["b.txt"])];
  check(
    "끌어 놓기: 끌기 대지가 이 끌기의 것이 아니면(이름 다름·더 있음·수 다름·끌기 중 바뀜·끌기 중 번호를 받기 전) 넣지 않고, 터미널·채팅 입력란 밖에는 받지 않음",
    stale.every((v) => v === "") && fresh === `${bTxt} ` && refused.every(Boolean),
    `${JSON.stringify(stale)} ${JSON.stringify(fresh)} ${refused}`,
  );
  // 경로를 묻는 동안 채팅 초안을 고치면 늦게 온 경로를 넣지 않는다 (고친 글을 지우지 않는다)
  setChat("abcd");
  chatInput.setSelectionRange(1, 3);
  await invoke("selftest_drag_files", { paths: [bTxt] });
  const editDt = new DataTransfer();
  editDt.items.add(new File(["x"], "b.txt"));
  chatInput.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: editDt }));
  await sleep(100);
  chatInput.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: editDt }));
  setChat("NEW TEXT");
  await sleep(500);
  const edited = chatInput.value;
  setChat("");
  check("끌어 놓기: 경로를 묻는 동안 채팅 초안을 고치면 경로를 넣지 않고 고친 글을 그대로 둠", edited === "NEW TEXT", JSON.stringify(edited));
  // React가 한 배치로 적용하는 갱신 순서: 보내기의 비우기 다음 늦은 삽입이 와도 새 초안에 넣지 않는다 (ChatPanel의 갱신 그대로)
  const sent = "abcd";
  const queue = (fns: ((d: string) => string)[]) => fns.reduce((d, f) => f(d), sent);
  const batched = [queue([(d) => (d === sent ? "" : d), insertAt(sent, 1, 3, "/p ")]), queue([insertAt(sent, 1, 3, "/p ")])];
  check("끌어 놓기: 채팅 초안 비우기와 늦은 삽입이 한 번에 적용돼도 비운 초안에 넣지 않음 (그대로면 넣음)", batched[0] === "" && batched[1] === "a/p d", JSON.stringify(batched));
  await run(term, `rm -f "${root}/사진 1.png" "${root}/b.txt"`);

  // 웹뷰는 앱 화면 밖으로 이동하지 않는다 (lib.rs stay_in_app). 창 전체로 시험하면 실패할 때 테스트가 멈추므로 액자(iframe)로:
  // 앱 안 빈 화면(srcdoc)은 열려 알려 오고, 바깥 주소(data:)는 열리지 않아야 한다
  const framed = async (set: (f: HTMLIFrameElement) => void) => {
    const f = document.createElement("iframe");
    f.style.display = "none";
    let got = false;
    const onMessage = (e: MessageEvent) => e.source === f.contentWindow && e.data === "ddak-frame" && (got = true);
    window.addEventListener("message", onMessage);
    set(f);
    document.body.appendChild(f);
    await waitFor("액자", () => got, 1500).catch(() => {});
    window.removeEventListener("message", onMessage);
    f.remove();
    return got;
  };
  const script = `<script>parent.postMessage("ddak-frame", "*")</script>`;
  const inApp = await framed((f) => (f.srcdoc = script));
  const away = await framed((f) => (f.src = `data:text/html,${encodeURIComponent(script)}`));
  check("웹뷰: 앱 화면 밖 주소로는 이동하지 않음 (앱 안 빈 화면은 열림)", inApp && !away, `${inApp} ${away}`);
}

async function testRename(root: string, term: Terminal) {
  const input = () => document.querySelector<HTMLInputElement>("input[data-rename]");
  const error = () => document.querySelector(".tree-input-error")?.textContent ?? "";
  const press = (el: HTMLElement, key: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  const onDisk = async (path: string) => (await run(term, `ls -d "${path}" 2>/dev/null || echo none`)).map((l) => l.trim());
  const startRename = async (name: string) => {
    rightClick(fileRow(name)!);
    await pickMenu("Rename…");
    return waitFor("이름 입력란", input);
  };

  rightClick(fileRow("a.txt")!);
  await waitFor("메뉴", contextMenu);
  // 파일은 기본 앱으로 열기가 맨 위 (마크다운이면 그 위에 미리 보기, docView)
  check("이름 바꾸기: 파일 메뉴에 항목", menuLabels().join(",") === "Open in Default App,-,New File…,New Folder…,-,Rename…,Move to Trash", menuLabels().join(","));
  await pickMenu("Rename…");
  const a = await waitFor("이름 입력란", input);
  check("이름 바꾸기: 그 자리에 입력란, 포커스, 확장자 앞까지 선택", document.activeElement === a && a.value === "a.txt" && a.selectionStart === 0 && a.selectionEnd === 1, `${a.value} ${a.selectionStart}-${a.selectionEnd}`);
  setInput(a, "renamed.txt");
  press(a, "Enter");
  await waitFor("바뀐 이름", () => !input() && rowNames().includes("renamed.txt") && !rowNames().includes("a.txt"), 3000).then(
    () => check("이름 바꾸기: Enter로 바뀌고 트리에 반영", true),
    (e) => check("이름 바꾸기: Enter로 바뀌고 트리에 반영", false, String(e)),
  );
  check("이름 바꾸기: 디스크에서 바뀜", (await onDisk(`${root}/renamed.txt`)).includes(`${root}/renamed.txt`) && (await onDisk(`${root}/a.txt`)).includes("none"));

  const z = await startRename("z.txt");
  setInput(z, "renamed.txt");
  press(z, "Enter");
  await waitFor("이미 있음 오류", error).then(
    () => check("이름 바꾸기: 이미 있는 이름은 오류, 입력란 유지", error() === "“renamed.txt” already exists here." && input() === z),
    (e) => check("이름 바꾸기: 이미 있는 이름은 오류, 입력란 유지", false, String(e)),
  );
  // 입력하는 중에 트리가 다시 읽혀도 선택·커서가 그대로여야 한다 (리뷰 지적 6)
  setInput(z, "new-name.txt");
  z.setSelectionRange(12, 12);
  await run(term, `touch "${root}/reload_probe"`);
  await waitFor("트리 다시 읽기", () => rowNames().includes("reload_probe"), 3000);
  await sleep(100);
  check("이름 바꾸기: 트리가 다시 읽혀도 입력·커서 유지", input() === z && z.value === "new-name.txt" && z.selectionStart === 12 && z.selectionEnd === 12, `${z.value} ${z.selectionStart}-${z.selectionEnd}`);
  await run(term, `rm "${root}/reload_probe"`);
  press(z, "Escape");
  await waitFor("Esc로 취소", () => !input());
  check("이름 바꾸기: Esc로 취소, 원래 이름 그대로", rowNames().includes("z.txt") && rowNames().includes("renamed.txt"));

  const r = await startRename("renamed.txt");
  setInput(r, "Renamed.txt");
  press(r, "Enter");
  await waitFor("대소문자만", () => !input() && rowNames().includes("Renamed.txt"), 3000).then(
    () => check("이름 바꾸기: 대소문자만 바꾸기", !rowNames().includes("renamed.txt"), error()),
    () => check("이름 바꾸기: 대소문자만 바꾸기", false, `${error()} ${rowNames().join(",")}`),
  );

  const dir = await startRename("b_dir");
  check("이름 바꾸기: 폴더는 이름 전체 선택", dir.selectionStart === 0 && dir.selectionEnd === 5, `${dir.selectionStart}-${dir.selectionEnd}`);
  dir.click();
  check("이름 바꾸기: 입력란을 눌러도 폴더가 펼쳐지지 않음", dir.closest(".tree-row")?.querySelector(".tree-twisty")?.getAttribute("data-open") === "false");
  setInput(dir, "b_dir2");
  press(dir, "Enter");
  await waitFor("폴더 이름", () => !input() && rowNames().includes("b_dir2"), 3000).then(
    () => check("이름 바꾸기: 폴더", !rowNames().includes("b_dir")),
    (e) => check("이름 바꾸기: 폴더", false, String(e)),
  );

  const blurred = await startRename("z.txt");
  setInput(blurred, "never.txt");
  blurred.blur();
  await waitFor("다른 곳을 누르면 취소", () => !input());
  check("이름 바꾸기: 다른 곳을 누르면 바꾸지 않고 취소", rowNames().includes("z.txt") && !rowNames().includes("never.txt"));

  // 뒤의 시나리오를 위해 되돌린다
  await run(term, `mv "${root}/Renamed.txt" "${root}/a.txt" && mv "${root}/b_dir2" "${root}/b_dir"`);
  await waitFor("되돌리기", () => rowNames().includes("a.txt") && rowNames().includes("b_dir"), 3000);
}

// 새 작업그룹 (⇧⌘T): 저장소마다 worktree를 만들고 그 폴더에서 기본 그룹(테스트 설정 "test" = 셸 하나)을 띄운다.
// 이때 프로젝트: server(저장소), web(server의 worktree), cloned(저장소), linked(링크한 저장소), 나머지는 일반 항목.
async function testGroupWorktree(root: string, first: Terminal) {
  const tabTitles = () => [...document.querySelectorAll(".project-workspace:not([style*='none']) .tab .tab-title")].map((el) => el.textContent);
  const worktreeLabel = () => projectRow(root)?.querySelector(".project-worktree")?.textContent ?? "";
  const before = tabCount();
  // 준비 스크립트: 메뉴로 처음 열면 안내(주석)만 써 둔다. 명령이 없으니 test-1에는 setup 창이 없어야 한다.
  // 자체 테스트에서는 편집기를 띄우지 않고 경로만 받는다.
  const setupPath = await invoke<string>("setup_script_edit", { project: root });
  check("작업그룹 준비: 앱 데이터의 setup/<프로젝트>-<해시>.sh", /\/data-main\/setup\/proj-[0-9a-f]{6}\.sh$/.test(setupPath), setupPath);
  const template = (await run(first, `grep -c '^#' "${setupPath}"; grep -vc '^#' "${setupPath}"`)).map((l) => l.trim()).filter((l) => /^\d+$/.test(l));
  check("작업그룹 준비: 처음엔 주석(안내)만", Number(template[0]) > 0 && template[1] === "0", template.join("|"));
  // 트리 루트가 바뀌는 순간 이전 폴더의 항목이 남아 있으면 안 된다 (리뷰 지적 2: 그 항목으로 원본 파일을 바꿀 수 있었다).
  // React가 그린 직후마다 본다: 작업그룹 표시와 다른 폴더의 행이 함께 있으면 기록한다.
  const stale: string[] = [];
  const watchStale = new MutationObserver(() => {
    const label = worktreeLabel();
    const rows = fileRows().map((el) => el.title);
    const wrong = label ? rows.filter((r) => r.startsWith(`${root}/`)) : rows.filter((r) => r.includes("/worktrees/") && !r.includes("\n"));
    if (wrong.length) stale.push(`${label || "원본"}: ${wrong[0]}`);
  });
  watchStale.observe(document.querySelector(".sidebar")!, { childList: true, subtree: true, characterData: true, attributes: true });
  await clickMenu("Terminal", "New Work Group");
  await waitFor("작업그룹 탭", () => tabCount() === before + 1, 15000);
  check("작업그룹 추가: ⇧⌘T(메뉴)로 새 탭, 이름은 <그룹>-1", tabTitles().at(-1) === "test-1" && activeTabIndex() === before, tabTitles().join(","));
  const [g] = await waitFor("작업그룹 터미널", () => visiblePanes().length >= 1 && visiblePanes()[0].term !== first && visiblePanes());
  await sleep(200);
  check("작업그룹 준비: 스크립트에 명령이 없으면 setup 창 없음", visiblePanes().length === 1, `${visiblePanes().length}`);
  await ready(g.term);
  const pwd = (await run(g.term, "pwd")).map((l) => l.trim()).find((l) => l.startsWith("/")) ?? "";
  check("작업그룹 추가: 터미널이 worktree 폴더에서 시작 (DDAK_HOME/worktrees/<프로젝트>-<해시>/test-1)", /\/home-main\/worktrees\/proj-[0-9a-f]{6}\/test-1$/.test(pwd), pwd);
  // claude 폴더 신뢰 (src-tauri/src/claude_trust.rs, 자체 테스트는 DDAK_HOME/claude.json): 원본 프로젝트를 신뢰했으니
  // (scripts/selftest.sh) 작업그룹 폴더도 신뢰로 적히고, 다른 항목은 남는다
  const trust = (await run(g.term, `tr -d ' \\n' < "$DDAK_HOME/claude.json"; echo`)).join("");
  check(
    "작업그룹 추가: 원본을 claude가 신뢰하면 작업그룹 폴더도 신뢰로 적음",
    trust.includes(`"${pwd}":{"hasTrustDialogAccepted":true}`) && trust.includes(`"${root}":{"hasTrustDialogAccepted":true,"keep":1}`),
    trust.slice(0, 400),
  );

  const out = async (cmd: string) => (await run(g.term, cmd)).map((l) => l.trim()).filter(Boolean);
  const branches = await out("for d in server web cloned linked; do printf '%s=' $d; git -C $d branch --show-current; done");
  check(
    "작업그룹 추가: 저장소마다 worktree, 브랜치 ddak/test-1 (같은 저장소의 두 번째는 이름을 붙임)",
    ["server=ddak/test-1", "web=ddak/test-1-web", "cloned=ddak/test-1", "linked=ddak/test-1"].every((x) => branches.includes(x)),
    branches.join("|"),
  );
  const links = await out("readlink A_dir a.txt");
  check("작업그룹 추가: 저장소가 아닌 항목은 원본으로 링크", links.includes(`${root}/A_dir`) && links.includes(`${root}/a.txt`), links.join("|"));
  const origin = await out(`git -C "${root}/server" branch --show-current`);
  check("작업그룹 추가: 원본 저장소의 브랜치는 그대로", !origin.includes("ddak/test-1"), origin.join("|"));

  // 파일 트리는 보고 있는 탭의 폴더를 따라간다
  await waitFor("트리가 worktree로", () => worktreeLabel() === "test-1" && fileRow("server")?.title === `${pwd}/server`, 3000).then(
    () => check("작업그룹 추가: 파일 트리가 작업그룹 폴더를 보여 줌 (프로젝트 행에 그룹 이름)", true),
    () => check("작업그룹 추가: 파일 트리가 작업그룹 폴더를 보여 줌 (프로젝트 행에 그룹 이름)", false, `${worktreeLabel()} ${fileRow("server")?.title}`),
  );
  check("작업그룹 추가: 트리에서 worktree 저장소 아이콘", fileRow("server")?.dataset.git === "worktree");
  key("1", "Digit1");
  await waitFor("원본 탭으로", () => worktreeLabel() === "" && fileRow("server")?.title === `${root}/server`, 3000).then(
    () => check("작업그룹 추가: 원본 탭으로 가면 트리도 원본", true),
    () => check("작업그룹 추가: 원본 탭으로 가면 트리도 원본", false, `${worktreeLabel()} ${fileRow("server")?.title}`),
  );
  watchStale.disconnect();
  check("작업그룹 추가: 트리 루트가 바뀔 때 이전 폴더 항목이 남지 않음", stale.length === 0, stale.slice(0, 2).join(" | "));
  // 오른쪽 클릭 메뉴도 루트가 바뀌면 닫는다. 메뉴 항목은 이전 폴더 경로로 만들어져 있다.
  // (이름 입력란은 탭을 바꾸면 터미널이 포커스를 가져가 blur로 이미 닫힌다)
  key("2", "Digit2");
  await waitFor("작업그룹 탭으로", () => worktreeLabel() === "test-1" && fileRow("a.txt")?.title.startsWith(pwd), 3000);
  rightClick(fileRow("a.txt")!);
  await waitFor("메뉴", contextMenu, 3000);
  key("1", "Digit1");
  await waitFor("원본으로", () => worktreeLabel() === "" && fileRow("a.txt")?.title.startsWith(`${root}/`), 3000);
  check("작업그룹 추가: 트리 루트가 바뀌면 오른쪽 클릭 메뉴를 닫음", !contextMenu());


  // 두 번째는 -2. 탭 바 버튼으로
  const groupBtn = document.querySelector<HTMLElement>(".project-workspace:not([style*='none']) [data-action=new-group]")!;
  // 탭 바 버튼은 모두 아이콘이고 세로 가운데에 (인라인 SVG는 글자 기준선에 놓여 위로 쏠렸었다)
  const offs = [...groupBtn.parentElement!.querySelectorAll<HTMLElement>(".tabbar-btn")].map((btn) => {
    const [br, ir] = [btn.getBoundingClientRect(), btn.querySelector("svg")?.getBoundingClientRect()];
    return ir ? ir.top + ir.height / 2 - (br.top + br.height / 2) : NaN;
  });
  check("작업그룹 추가: 탭 바 버튼 아이콘 여섯(Git Graph·채팅 포함)이 세로 가운데", offs.length === 6 && offs.every((o) => Math.abs(o) <= 0.5), offs.map((o) => o.toFixed(1)).join(","));
  // 준비 스크립트에 명령을 넣으면 다음 작업그룹부터 세션 아래 setup 창에서 돌고, 세션은 준비가 성공한 뒤에 뜬다.
  // 플래그 파일로 멈춰 두거나(hold) 실패하게(fail) 한다.
  const flags = setupPath.replace(/\/[^/]+$/, "");
  const script = [
    'echo "SETUP_RAN $DDAK_GROUP $(pwd) $DDAK_ORIGIN"',
    `while [ -f "${flags}/hold" ]; do sleep 0.1; done`,
    `[ -f "${flags}/fail" ] && exit 7`,
    "echo SETUP_OK",
  ];
  await run(first, `printf '%s\\n' ${script.map((l) => `'${l.replace(/'/g, "'\\''")}'`).join(" ")} >> "${setupPath}"; touch "${flags}/hold" "${flags}/fail"`);
  groupBtn.click();
  await waitFor("두 번째 작업그룹", () => tabCount() === before + 2, 15000);
  check("작업그룹 추가: 탭 바 버튼으로 두 번째는 test-2", tabTitles().at(-1) === "test-2", tabTitles().join(","));
  const [setup] = await waitFor("setup 창", () => visiblePanes().length === 1 && visiblePanes(), 5000);
  const wait = await waitFor("기다리는 세션 창", () => paneEls().find((el) => el.querySelector(".setup-wait")), 3000);
  check(
    "작업그룹 준비: 세션 아래에 setup 창 (이름표 setup), 포커스는 setup 창",
    setup.rect.top > wait.getBoundingClientRect().top && setup.el.querySelector(".pane-label")?.firstChild?.textContent === "setup" && setup.el.classList.contains("focused"),
    `${setup.el.querySelector(".pane-label")?.textContent} ${setup.el.className}`,
  );
  const waitText = wait.querySelector(".setup-wait")?.textContent ?? "";
  check("작업그룹 준비: 준비 중에는 세션(CLI)을 띄우지 않고 안내", !wait.querySelector(".terminal") && waitText === "Starts when the work group setup finishes.", waitText);
  check("작업그룹 준비: setup 창에 실행 중 표시", setupStatus(setup.el) === "running");
  const ran = await waitFor("준비 스크립트 출력", () => screen(setup.term).find((l) => l.startsWith("SETUP_RAN")), 10000).catch(() => "");
  check("작업그룹 준비: 새 작업그룹 폴더에서 DDAK_GROUP·DDAK_ORIGIN과 함께 실행", ran.includes("SETUP_RAN test-2 ") && /\/worktrees\/proj-[0-9a-f]{6}\/test-2 /.test(ran) && ran.trim().endsWith(root), ran);

  // 실패하면 세션은 계속 기다리고 다시 준비 / 그래도 시작을 보인다. 탭에 실패 표시.
  await run(first, `rm "${flags}/hold"`);
  const failed = await waitFor("준비 실패", () => wait.querySelector(".setup-wait-error")?.textContent, 10000).catch(() => "");
  check("작업그룹 준비: 실패하면 종료 코드와 함께 다시 준비 / 그래도 시작", failed === "Failed (exit 7)" && !!wait.querySelector("[data-action=setup-retry]") && !!wait.querySelector("[data-action=setup-start]"), failed);
  check("작업그룹 준비: 실패 표시 (setup 창, 탭)", setupStatus(setup.el) === "failed" && !!activeTabEl()?.querySelector(".tab-warn") && !wait.querySelector(".terminal"));
  // 다시 준비: 새 터미널에서 다시 돌고, 성공하면 세션이 뜨고 포커스가 세션으로.
  // 생성 응답을 늦춰서, 응답(id)보다 먼저 끝난 스크립트의 종료도 받는지 본다 (리뷰 지적 3).
  await run(first, `rm "${flags}/fail"`);
  devHooks.spawnDelay = 1500;
  wait.querySelector<HTMLElement>("[data-action=setup-retry]")!.click();
  const [session, setup2] = await waitFor("준비 성공 뒤 세션", () => visiblePanes().length === 2 && visiblePanes(), 10000).finally(() => {
    devHooks.spawnDelay = undefined;
  });
  const ok = await waitFor("다시 준비 출력", () => screen(setup2.term).find((l) => l === "SETUP_OK"), 3000).catch(() => "");
  check("작업그룹 준비: 다시 준비하면 새로 돌고, 성공하면 세션 시작", setup2.term !== setup.term && ok === "SETUP_OK" && session.rect.top < setup2.rect.top);
  check(
    "작업그룹 준비: 성공하면 포커스는 세션, 완료 표시, 탭 실패 표시 없음",
    session.el.classList.contains("focused") && setupStatus(setup2.el) === "ok" && !activeTabEl()?.querySelector(".tab-warn"),
    `${session.el.className} ${setupStatus(setup2.el)}`,
  );

  // 실패하면 되돌린다: 커밋 없는 저장소가 있으면 worktree를 만들 수 없다
  await run(first, `git init -q "${root}/zempty"`);
  await clickMenu("Terminal", "New Work Group");
  const err = await waitFor("실패 오류", () => [...document.querySelectorAll(".sidebar .sidebar-error")].map((e) => e.textContent ?? "").find((e) => e.startsWith("Could not create the work group")), 15000);
  check("작업그룹 추가: 실패하면 오류 표시, 탭은 그대로", err.includes("zempty") && tabCount() === before + 2, err);
  const left = (await run(first, `git -C "${root}/server" branch --list 'ddak/test-3*' | wc -l; ls "${pwd.replace(/test-1$/, "")}"`)).map((l) => l.trim()).filter(Boolean);
  check("작업그룹 추가: 실패하면 만든 worktree·브랜치를 지움", left.includes("0") && !left.includes("test-3"), left.join("|"));
  await run(first, `rm -rf "${root}/zempty"`);

  // 돌던 setup 창을 닫으면 중단으로 보고 기다린다. 그래도 시작을 누르면 세션이 뜨고 실패 표시는 남는다.
  await run(first, `touch "${flags}/hold"`);
  await clickMenu("Terminal", "New Work Group");
  await waitFor("세 번째 작업그룹", () => tabCount() === before + 3 && visiblePanes().length === 1, 15000);
  await menu("close_pane"); // 포커스가 setup 창
  const stopped = await waitFor("준비 중단", () => paneEls().find((el) => el.querySelector(".setup-wait-error")), 5000);
  check("작업그룹 준비: setup 창을 닫으면 중단 표시, 세션은 기다림", stopped.querySelector(".setup-wait-error")?.textContent === "Stopped" && visiblePanes().length === 0);
  // 작업 폴더가 사라진 채 다시 준비: 홈 폴더에서 돌지 않고 준비 실패로 (리뷰 지적 4. portable-pty는 없는 폴더면 홈에서 띄운다)
  const group3 = pwd.replace(/test-1$/, "test-3");
  await run(first, `mv "${group3}" "${group3}.away"`);
  stopped.querySelector<HTMLElement>("[data-action=setup-retry]")!.click();
  const noDir = await waitFor("준비 시작 실패", () => stopped.querySelector(".setup-wait-error")?.textContent === "Could not start the setup" && visiblePanes(), 5000).catch(() => null);
  const startErr = noDir?.[0] ? screen(noDir[0].term).join("\n") : "";
  check("작업그룹 준비: 작업 폴더가 없으면 준비를 시작하지 못함으로 표시 (홈에서 돌지 않음)", !!noDir && startErr.includes("no such folder") && !startErr.includes("SETUP_RAN"), startErr.slice(-200));
  await run(first, `mv "${group3}.away" "${group3}"`);
  stopped.querySelector<HTMLElement>("[data-action=setup-start]")!.click();
  await waitFor("그래도 시작", () => visiblePanes().length === 2, 5000).then(
    () => check("작업그룹 준비: 그래도 시작하면 세션이 뜨고 탭 실패 표시는 남음", !!activeTabEl()?.querySelector(".tab-warn")),
    (e) => check("작업그룹 준비: 그래도 시작하면 세션이 뜨고 탭 실패 표시는 남음", false, String(e)),
  );
  await run(first, `rm "${flags}/hold"`);

  // 작업그룹 탭 닫기: 작업그룹의 마지막 창을 닫으면 바로 닫지 않고 작업그룹 끝내기 창이 떠서 끝낼지 탭만 닫을지 묻는다.
  // 취소하면 그대로, "탭만 닫기"면 탭만 닫히고 worktree는 남는다 (정리는 6단계). 마지막이 아닌 창은 묻지 않는다
  const endDialog = () => document.querySelector<HTMLElement>(".end-group-dialog");
  const tabsBeforeClose = tabCount();
  await menu("close_pane"); // test-3의 두 창 중 하나
  await sleep(300);
  const notAsked = !endDialog() && tabCount() === tabsBeforeClose;
  await menu("close_pane"); // test-3의 마지막 창
  const asked = await waitFor("끝내기 창", () => endDialog()?.querySelector("[data-last-tab]") && endDialog(), 3000).catch(() => null);
  const offered = !!asked?.querySelector("[data-action=close-tab-only]") && !!asked.querySelector("[data-action=end-group]");
  asked?.querySelector<HTMLElement>("button.secondary")?.click(); // 취소
  await waitFor("창 닫힘", () => !endDialog(), 3000).catch(() => null);
  const keptOnCancel = tabCount() === tabsBeforeClose && visiblePanes().length === 1;
  await menu("close_pane");
  await waitFor("끝내기 창", () => endDialog()?.querySelector("[data-action=close-tab-only]"), 3000).catch(() => null);
  endDialog()?.querySelector<HTMLElement>("[data-action=close-tab-only]")?.click();
  const closedOnly = await waitFor("탭만 닫기", () => !endDialog() && tabCount() === tabsBeforeClose - 1, 3000).then(() => true, () => false);
  const folderLeft = (await run(first, `test -d "${group3}" && echo kept || echo gone`)).some((l) => l.trim() === "kept");
  check(
    "작업그룹 탭 닫기: 마지막 창을 닫으면 끝내기 창(끝내기·탭만 닫기)을 띄우고, 취소하면 그대로, 탭만 닫으면 worktree는 남김",
    notAsked && offered && keptOnCancel && closedOnly && folderLeft,
    `${notAsked} ${offered} ${keptOnCancel} ${closedOnly} ${folderLeft}`,
  );
  // ⌘W가 빠르게 두 번 와도 (화면이 한 번 늦은 상태) 마지막 창에서는 묻는다: test-2의 두 창
  const tabsBeforeRapid = tabCount();
  await Promise.all([menu("close_pane"), menu("close_pane")]);
  const rapidAsked = await waitFor("빠른 ⌘W의 끝내기 창", () => document.querySelector<HTMLElement>("[data-action=close-tab-only]"), 3000).catch(() => null);
  const rapidKept = tabCount() === tabsBeforeRapid;
  rapidAsked?.click();
  await waitFor("탭만 닫기", () => !endDialog() && tabCount() === tabsBeforeRapid - 1, 3000).catch(() => null);
  check("작업그룹 탭 닫기: ⌘W가 빠르게 이어져도 마지막 창에서는 묻고 탭을 닫지 않음", !!rapidAsked && rapidKept, `${!!rapidAsked} ${rapidKept}`);
  await closePaneKeepGroup(); // test-1
  await waitFor("작업그룹 탭 닫기", () => tabCount() === before, 5000);
}

// 창 닫기 (⌘W). 작업그룹의 마지막 창이면 작업그룹 끝내기 창이 뜨므로 "탭만 닫기"를 누른다 (작업그룹 폴더는 남겨 뒤 단계가 쓴다)
async function closePaneKeepGroup() {
  await menu("close_pane");
  const only = await waitFor("탭만 닫기", () => document.querySelector<HTMLElement>("[data-action=close-tab-only]"), 300).catch(() => null);
  only?.click();
  if (only) await waitFor("끝내기 창 닫힘", () => !document.querySelector(".end-group-dialog"), 3000).catch(() => null);
}

// 작업그룹 준비…: 원본의 커밋 안 된 node_modules를 골라 두면 새 작업그룹에 복제한다 (src-tauri/src/clone.rs).
// 이때 작업그룹 폴더는 test-1~3이 있고 준비 스크립트는 testGroupWorktree가 넣은 것 (SETUP_OK로 끝남).
// 터미널을 넷 더 만들므로 WebGL 검사 뒤에 둔다 (컨텍스트가 많으면 가장 오래된 첫 터미널의 것을 잃는다).
async function testGroupClone(root: string, first: Terminal) {
  const sh = async (cmd: string, ms?: number) => (await run(first, cmd, ms)).map((l) => l.trim()).filter(Boolean);
  const tabTitles = () => [...document.querySelectorAll(".project-workspace:not([style*='none']) .tab .tab-title")].map((el) => el.textContent);
  // 원본 server: package.json·lockfile(의존성 없는 npm 형식, npm ci가 내려받지 않고 끝난다)·requirements.txt를 커밋하고,
  // 무시되는 node_modules·.venv·.env를 만든다. node_modules에는 안쪽 상대 링크, 절대 링크, FIFO, 오래된 수정 시각을 둔다.
  const nm = `${root}/server/node_modules`;
  const lock = '{"name":"s","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"s","version":"1.0.0"}}}';
  await sh(
    [
      `cd "${root}/server"`,
      `printf '{"name":"s","version":"1.0.0"}' > package.json && printf '%s' '${lock}' > package-lock.json && : > requirements.txt`,
      `printf 'node_modules/\\n.venv/\\n.env\\n' > .gitignore`,
      `git add -A && git -c user.name=t -c user.email=t@example.com commit -qm deps`,
      `mkdir -p node_modules/pkg node_modules/.bin && printf 'mod' > node_modules/pkg/index.js && touch -t 200101010000 node_modules/pkg/index.js`,
      `ln -s ../pkg/index.js node_modules/.bin/run && ln -s /etc/hosts node_modules/abs && mkfifo node_modules/pipe`,
      `printf 'TOKEN=secret' > .env && python3 -m venv --without-pip .venv`,
      `cd - > /dev/null`,
    ].join(" && "),
    30000,
  );
  // 개발 모드는 효과를 두 번 돌린다. 첫 번째 읽기의 응답을 늦춰서, 고른 뒤에 와도 고른 것을 되돌리지 않는지 본다.
  let loads = 0;
  devHooks.setupLoadDelay = () => (loads++ === 0 ? 1500 : 0);
  rightClick(projectRow(root)!);
  await waitFor("오른쪽 클릭 메뉴", contextMenu);
  [...document.querySelectorAll<HTMLElement>(".context-item")].find((el) => el.textContent === "Work Group Setup…")!.click();
  const row = await waitFor("복제 후보", () => document.querySelector<HTMLElement>(".setup-dialog [data-clone='server/node_modules']"), 10000);
  const dialogRow = (attr: string, value: string) => document.querySelector<HTMLElement>(`.setup-dialog [data-${attr}='${value}']`)!;
  const rowsShown = [...document.querySelectorAll<HTMLElement>(".setup-dialog [data-clone]")].map((el) => el.dataset.clone);
  check("작업그룹 준비 창: 원본의 node_modules가 후보 (조건 안내)", row.textContent?.includes("only when package.json and the lockfile match") === true);
  check(
    "작업그룹 준비 창: .env(비밀 파일)·.venv(새로 만듦)도 후보, 아무것도 기본으로 고르지 않음",
    rowsShown.join(",") === "server/.env,server/.venv,server/node_modules" &&
      dialogRow("clone", "server/.env").textContent?.includes("may contain secrets") === true &&
      dialogRow("clone", "server/.venv").textContent?.includes("recreated with the same Python") === true &&
      [...document.querySelectorAll<HTMLInputElement>(".setup-dialog input[type=checkbox]")].every((c) => !c.checked),
    rowsShown.join(","),
  );
  const installsShown = [...document.querySelectorAll<HTMLElement>(".setup-dialog [data-install]")].map((el) => el.dataset.install);
  check(
    "작업그룹 준비 창: 커밋된 lockfile에서 설치 제안 (requirements.txt는 가상 환경의 pip)",
    installsShown.join(",") === "server: npm ci,server: .venv/bin/pip install -r requirements.txt" &&
      dialogRow("install", "server: npm ci").textContent?.includes("only when node_modules is missing") === true,
    installsShown.join(","),
  );
  check("작업그룹 준비 창: 커밋 전 변경 미포함 안내", document.querySelector(".setup-dialog")?.textContent?.includes("Uncommitted changes are not included") === true);
  // 체크박스는 늘어나지 않고 바로 옆에 글자 (입력란 규칙 flex: 1이 걸려 체크박스가 남는 폭을 차지했었다)
  const gaps = [...document.querySelectorAll<HTMLElement>(".setup-dialog .check-row")].map((rowEl) => {
    const box = rowEl.querySelector("input")!.getBoundingClientRect();
    return [Math.round(box.width), Math.round(rowEl.querySelector(".check-name")!.getBoundingClientRect().left - box.right)];
  });
  check("작업그룹 준비 창: 체크박스 바로 옆에 이름", gaps.length === 5 && gaps.every(([w, gap]) => w <= 20 && gap <= 8), JSON.stringify(gaps));
  row.querySelector<HTMLInputElement>("input")!.click();
  dialogRow("clone", "server/.env").querySelector("input")!.click();
  dialogRow("clone", "server/.venv").querySelector("input")!.click();
  dialogRow("install", "server: npm ci").querySelector("input")!.click();
  await sleep(2000);
  devHooks.setupLoadDelay = undefined;
  check("작업그룹 준비 창: 늦게 온 첫 읽기가 고른 것을 되돌리지 않음", loads === 2 && row.querySelector<HTMLInputElement>("input")!.checked, `${loads}`);
  document.querySelector<HTMLElement>(".setup-dialog button[type=submit]")!.click();
  await waitFor("창 닫힘", () => !document.querySelector(".setup-dialog"), 5000);
  const saved = (await sh(`cat "${root.replace(/\/proj$/, "")}"/data-main/setup/proj-*.json | tr -d ' \\n'; echo`)).find((l) => l.startsWith("{")) ?? "";
  check(
    "작업그룹 준비 창: 고른 항목과 설치 명령을 프로젝트 설정에 저장",
    saved === '{"clone":["server/.env","server/.venv","server/node_modules"],"install":[{"dir":"server","command":"npmci"}]}',
    saved,
  );

  // 새 작업그룹: setup 창에서 복제 → 준비 스크립트 → 세션
  const groups = `${(await sh("echo $DDAK_HOME")).at(-1)}/worktrees/${(await sh(`ls "$DDAK_HOME/worktrees"`)).at(-1)}/`;
  const before = tabCount();
  await clickMenu("Terminal", "New Work Group");
  await waitFor("네 번째 작업그룹", () => tabCount() === before + 1, 15000);
  // 탭을 닫아 남은 작업그룹(test-1~3, 고친 것·병합 안 된 커밋 없음)이 있으면 가장 작은 번호를 다시 쓴다 (worktrees.rs reuse)
  const name4 = tabTitles().at(-1) ?? "";
  check("작업그룹 다시 쓰기: 탭을 닫아 남은 작업그룹 중 가장 작은 번호를 새 작업그룹으로 다시 씀", name4 === "test-1", tabTitles().join(","));
  const [, setup] = await waitFor("복제 뒤 세션", () => visiblePanes().length === 2 && visiblePanes(), 40000);
  const out = screen(setup.term).join("\n");
  check(
    "작업그룹 복제: setup 창에 복제 결과와 뺀 항목 (밖을 가리키는 링크, FIFO), 그 뒤 준비 스크립트",
    out.includes("[ddak] cloned server/node_modules: 1 file (") && out.includes("left out abs: link pointing outside") && out.includes("left out pipe: socket") && out.includes("SETUP_OK"),
    out.slice(-400),
  );
  check(
    "작업그룹 준비: .env 복사, .venv는 같은 Python으로 새로 만듦, node_modules를 복제했으면 npm ci는 건너뜀",
    out.includes("[ddak] copied server/.env") && out.includes("[ddak] creating server/.venv with the same Python") && out.includes("[ddak] skipped server: npm ci: node_modules is already there"),
    out.slice(-600),
  );
  const g4 = `${groups}${name4}/server/node_modules`;
  const env = await sh(`cat "${groups}${name4}/server/.env"; echo; grep '^home' "${groups}${name4}/server/.venv/pyvenv.cfg"; grep '^home' "${root}/server/.venv/pyvenv.cfg"; test -x "${groups}${name4}/server/.venv/bin/python" && echo py-ok`);
  check("작업그룹 준비: 새 작업그룹의 .env 내용, .venv의 Python이 원본과 같음", env[0] === "TOKEN=secret" && env[1] === env[2] && env[1]?.startsWith("home") === true && env[3] === "py-ok", env.join("|"));
  const facts = await sh(
    `cd "${g4}" && cat pkg/index.js; echo; readlink .bin/run; test -e abs -o -L abs && echo abs-there; test -e pipe && echo pipe-there; ` +
      `[ "$(stat -f %m pkg/index.js)" = "$(stat -f %m "${nm}/pkg/index.js")" ] && echo same-mtime; ls -a .. "${groups}" | grep -c ddak-clone; cd - > /dev/null`,
  );
  check(
    "작업그룹 복제: 내용, 안쪽 링크, 수정 시각이 그대로이고 뺀 항목·임시 폴더는 없음",
    facts.includes("mod") && facts.includes("../pkg/index.js") && facts.includes("same-mtime") && !facts.includes("abs-there") && !facts.includes("pipe-there") && facts.at(-1) === "0",
    facts.join("|"),
  );

  // 원본의 lockfile이 커밋과 다르면 (커밋 안 한 설치) 복제하지 않고 알린다. 실패가 아니라 세션은 뜬다.
  await sh(`printf 'lock2' > "${root}/server/package-lock.json"`);
  await clickMenu("Terminal", "New Work Group");
  await waitFor("다섯 번째 작업그룹", () => tabCount() === before + 2, 15000);
  const name5 = tabTitles().at(-1) ?? "";
  const [, setup5] = await waitFor("건너뛴 뒤 세션", () => visiblePanes().length === 2 && visiblePanes(), 40000);
  const out5 = screen(setup5.term).join("\n");
  const left = await sh(`test -e "${groups}${name5}/server/node_modules" && echo there || echo none`);
  check(
    "작업그룹 복제: lockfile이 다르면 건너뛰고 알림, 세션은 뜸",
    out5.includes("skipped server/node_modules: server/package-lock.json differs") && left.includes("none"),
    `${out5.slice(-300)} ${left.join("|")}`,
  );
  check("작업그룹 준비: 복제를 건너뛰었으면 npm ci를 돌림", out5.includes("[ddak] running server: npm ci") && out5.includes("up to date"), out5.slice(-300));
  await sh(`cd "${root}/server" && git checkout -q package-lock.json && rm -rf node_modules .venv .env && cd - > /dev/null`);
  for (let i = 0; i < 4; i++) await closePaneKeepGroup(); // 두 작업그룹 (세션 + setup)
  await waitFor("복제 작업그룹 탭 닫기", () => tabCount() === before, 5000);
}

// 작업그룹 끝내기 (worktrees.rs end): 커밋 안 한 변경이 있으면 끝내지 않고, 병합 안 된 브랜치는 남기고 나머지는 지운다.
async function testGroupEnd(root: string, first: Terminal) {
  const sh = async (cmd: string) => (await run(first, cmd, 20000)).map((l) => l.trim()).filter(Boolean);
  const openMenu = async (tab: HTMLElement) => {
    rightClick(tab);
    await waitFor("탭 메뉴", contextMenu);
    return menuLabels();
  };
  const firstTab = document.querySelectorAll<HTMLElement>(".project-workspace:not([style*='none']) .tab")[0];
  const originItems = await openMenu(firstTab);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await waitFor("메뉴 닫기", () => !contextMenu());
  check("작업그룹 끝내기: 원본 탭에는 끝내기 없음", !originItems.includes("End Work Group…"), originItems.join(","));

  const before = tabCount();
  await clickMenu("Terminal", "New Work Group");
  await waitFor("끝낼 작업그룹", () => tabCount() === before + 1 && visiblePanes().length >= 2, 60000);
  const tab = activeTabEl()!;
  const name = tab.querySelector(".tab-title")!.textContent!;
  const path = tab.querySelector<HTMLElement>(".tab-title")!.title;
  const dialog = () => document.querySelector<HTMLElement>(".end-group-dialog");
  const repoState = (repo: string) => dialog()?.querySelector(`[data-repo='${repo}'] .end-state`)?.textContent ?? "";
  const endButton = () => dialog()?.querySelector<HTMLButtonElement>("[data-action=end-group]");
  const openDialog = async () => {
    await openMenu(activeTabEl()!);
    [...document.querySelectorAll<HTMLElement>(".context-item")].find((el) => el.textContent === "End Work Group…")!.click();
    await waitFor("상태", () => dialog()?.querySelector("[data-repo]"), 10000);
  };

  await sh(`echo x > "${path}/server/end-new.txt"`);
  await openDialog();
  check(
    "작업그룹 끝내기: 커밋 안 한 변경이 있으면 보이고 끝낼 수 없음",
    repoState("server") === "1 uncommitted changes" && repoState("cloned") === "merged · branch deleted" && !!endButton()?.disabled && !!dialog()?.querySelector(".modal-error"),
    `${repoState("server")} | ${repoState("cloned")} | ${endButton()?.disabled}`,
  );
  dialog()!.querySelector<HTMLElement>("button.secondary")!.click();
  await waitFor("창 닫기", () => !dialog());

  // 작업그룹 폴더에 모르는 항목이 있으면 끝내지 않는다 (지우는 기능이라 아는 것만 지운다)
  await sh(`mv "${path}/server/end-new.txt" "${path}/todo.md"`);
  await openDialog();
  const unknownMsg = dialog()?.querySelector(".modal-error")?.textContent ?? "";
  check("작업그룹 끝내기: 작업그룹 폴더의 모르는 항목이 있으면 끝낼 수 없음", unknownMsg.includes("todo.md") && !!endButton()?.disabled, unknownMsg);
  dialog()!.querySelector<HTMLElement>("button.secondary")!.click();
  await waitFor("창 닫기", () => !dialog());

  await sh(`mv "${path}/todo.md" "${path}/server/end-new.txt" && cd "${path}/server" && git add -A && git -c user.name=t -c user.email=t@example.com commit -qm end-test && cd - > /dev/null`);
  await openDialog();
  check("작업그룹 끝내기: 병합 안 된 커밋은 브랜치를 남긴다고 보임", repoState("server") === "1 commits not merged · branch kept" && !endButton()?.disabled, repoState("server"));
  dialog()!.querySelector<HTMLElement>("button.secondary")!.click();
  await waitFor("창 닫기", () => !dialog());

  // 확인한 뒤 지우기 전에 세션이 바꾼 것을 잃지 않는다 (리뷰 P1): 이 폴더의 세션을 끝내고 기다린 뒤 다시 확인한다.
  // 셸이 SIGHUP을 받으면 worktree에 파일을 만들게 해 두면, 세션을 끝낸 뒤 확인에서 멈추고 세션을 다시 띄운다.
  const shellTerm = () => visiblePanes().find((p) => !p.el.querySelector("[data-setup-status]"))?.term;
  const old = shellTerm()!;
  await run(old, `trap 'echo x > "${path}/server/late.txt"' HUP`);
  await openDialog();
  endButton()!.click();
  const stopError = () => dialog()?.querySelector(".modal-error")?.textContent ?? "";
  await waitFor("세션을 끝낸 뒤 멈춤", () => !endButton()?.disabled && stopError(), 20000);
  const restartHint = [...dialog()!.querySelectorAll(".modal-hint")].some((el) => el.textContent?.includes("started again"));
  await waitFor("다시 띄운 터미널", () => shellTerm() && shellTerm() !== old, 10000);
  const alive = await sh(`test -e "${path}/server/late.txt" && echo late-there`);
  const again = await run(shellTerm()!, "echo alive-$((1+1))");
  check(
    "작업그룹 끝내기: 세션을 끝낸 뒤 생긴 변경이면 지우지 않고 멈추고, 세션을 다시 띄움",
    stopError().startsWith("Uncommitted changes appeared in: server") && restartHint && tabCount() === before + 1 && alive.includes("late-there") && again.some((l) => l.trim() === "alive-2"),
    `${stopError()} | ${restartHint} | ${tabCount()} | ${alive.join(",")} | ${again.join(",")}`,
  );
  dialog()!.querySelector<HTMLElement>("button.secondary")!.click();
  await waitFor("창 닫기", () => !dialog());

  // 끝내면 SIGHUP을 무시하는 백그라운드 작업(대화형 셸은 그룹을 따로 만든다)까지 끝낸 뒤 지운다. 남았다면 8초 뒤에 표시를
  // 남긴다. 끝내기를 누르기 전에 표시가 이미 있으면 (창을 여는 데 8초 넘게 걸림) 이 검사는 무효다 (전에 3초로 두었다가
  // 느린 실행에서 끝내기 전에 표시가 생겨 실패했다).
  const marker = `${root}/../late-marker-${name}`;
  const LATE = 8;
  await sh(`rm "${path}/server/late.txt"`);
  await run(shellTerm()!, `(trap '' HUP; sleep ${LATE}; echo late > "${marker}") &`);
  const started = Date.now();
  await openDialog();
  const early = (await sh(`test -e "${marker}" && echo late-early`)).includes("late-early");
  check("작업그룹 끝내기: (검사 준비) 끝내기 전에 백그라운드 작업이 아직 돌고 있음", !early, `${Date.now() - started}ms`);
  endButton()!.click();
  await waitFor("끝냄", () => tabCount() === before && dialog()?.querySelector(".end-row code"), 20000);
  const kept = [...dialog()!.querySelectorAll(".end-row")].map((el) => el.textContent);
  check("작업그룹 끝내기: 탭을 닫고 남긴 브랜치를 이유와 함께 알림", kept.join(",") === `serverddak/${name}not merged`, kept.join(","));
  dialog()!.querySelector<HTMLElement>("button")!.click();
  await waitFor("창 닫기", () => !dialog());

  await sleep(Math.max(0, started + LATE * 1000 + 500 - Date.now()));
  const facts = await sh(
    `test -e "${marker}" && echo late-there; test -e "${path}" && echo dir-there; for r in server cloned linked; do printf '%s=' $r; git -C "${root}/$r" branch --list "ddak/${name}*" | tr -d ' *\\n'; echo; done; ` +
      `ls -a "${path.replace(/\/[^/]+$/, "")}" | grep -c "ddak-group-${name}"; git -C "${root}/server" worktree list | grep -c "/${name}/"`,
  );
  check(
    "작업그룹 끝내기: 세션을 모두 끝내고, 폴더·worktree·병합된 브랜치·기록을 지우고 병합 안 된 브랜치만 남김",
    !facts.includes("late-there") && !facts.includes("dir-there") && facts.includes(`server=ddak/${name}`) && facts.includes("cloned=") && facts.includes("linked=") && facts.slice(-2).join(",") === "0,0",
    facts.join("|"),
  );
}

// 세션 추가 (Terminal 메뉴, 탭 오른쪽 클릭): 작업그룹 설정의 세션을 골라 지금 탭에 분할 창으로 띄운다. 쓰기 가능한 세션이
// 이미 있는 탭에 쓰기 가능한 세션을 또 더하면 경고하고 (취소 / 새 작업그룹 / 그래도 추가), 읽기 전용은 경고하지 않는다.
async function testAddSession(root: string, first: Terminal) {
  const file = await groupsFile();
  // poster: 자기 채팅방 주소({chat})로 MCP post_message를 보낸다 (claude·codex 대신 curl)
  const rpc = `{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"tools/call\\",\\"params\\":{\\"name\\":\\"post_message\\",\\"arguments\\":{\\"text\\":\\"@user hello from poster\\"}}}`;
  const poster = `{"name":"poster","command":"curl","args":["-s","-H","Content-Type: application/json","-d","${rpc}","{chat}"],"readOnly":true}`;
  // listener: 받은 줄을 GOT:으로 찍는다 (깨우기가 입력한 알림을 본다)
  // 시작할 때 커서 위치를 물어서 xterm이 자동 응답(ESC[행;열R)을 보내게 한다 (사용자 입력이 아니다. 리뷰 P2)
  // 줄을 받을 때마다 상태(ESC[5n)·DEC 커서 위치(ESC[?6n)도 물어서, Enter 직후에 응답이 오게 한다 (리뷰 후속 P2)
  const listener = `{"name":"listener","command":"sh","args":["-c","stty -echo; printf \\"\\\\033[6n\\"; while read l; do echo GOT:$l; printf \\"\\\\033[5n\\\\033[?6n\\"; done"],"readOnly":true}`;
  // chatter: 같은 작업그룹(origin)의 listener를 멘션한 메시지를 MCP로 7개 보낸다 (자동 깨우기 제한 WAKE_LIMIT=6). $0은 주소, $1은 요청
  const chatRpc = `{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"tools/call\\",\\"params\\":{\\"name\\":\\"post_message\\",\\"arguments\\":{\\"text\\":\\"@origin/listener ping\\"}}}`;
  const chatter = `{"name":"chatter","command":"sh","args":["-c","for i in 1 2 3 4 5 6 7; do curl -s -H Content-Type:application/json -d \\"$1\\" \\"$0\\"; echo; done","{chat}","${chatRpc}"],"readOnly":true}`;
  // prompter: 역할(role) + 그룹 규약(rules)이 인자의 {prompt}·{prompt:toml}로 들어가는지 찍는다. 역할 안의 {chat}은 바뀌면 안 된다
  const prompter = `{"name":"prompter","role":"R {chat}","command":"sh","args":["-c","printf \\"A:%s|B:%s|\\" \\"$0\\" \\"$1\\"","{prompt}","v={prompt:toml}"],"readOnly":true}`;
  // attn: claude 권한 확인 훅처럼 자기 {attention} 주소로 사용자를 기다린다는 신호를 보낸다 (알림)
  const attn = `{"name":"attn","command":"curl","args":["-s","-X","POST","{attention}"],"readOnly":true}`;
  // asker: 프로그램 상태(OSC 7501)로 답변을 기다린다고 알리고, 1초 뒤 claude 훅처럼 {attention}도 보낸다 (알림은 한 번, 상태의 문구).
  // 설정은 셸 작은따옴표로 쓰므로 명령에 작은따옴표를 쓰지 않는다 ($1이 printf 형식)
  // hookfirst: 반대 순서 — {attention}을 먼저 보내고 1초 뒤 상태로 기다림 (알림은 한 번, 훅의 문구)
  const hookfirst = `{"name":"hookfirst","command":"sh","args":["-c","curl -s -X POST \\"$0\\"; sleep 1; printf \\"$1\\"; sleep 30","{attention}","\\\\033]7501;state=blocked:kind=question\\\\033\\\\\\\\"],"readOnly":true}`;
  // twice: 답변 대기 → (답함) 작업 중 → 1초 뒤 권한 확인 대기. 10초 안이어도 새 대기라 알림 두 번 (리뷰 R4)
  const twice = `{"name":"twice","command":"sh","args":["-c","printf \\"$0\\"; sleep 1; printf \\"$1\\"; sleep 1; printf \\"$2\\"; sleep 30","\\\\033]7501;state=blocked:kind=question\\\\033\\\\\\\\","\\\\033]7501;state=working\\\\033\\\\\\\\","\\\\033]7501;state=blocked:kind=permission\\\\033\\\\\\\\"],"readOnly":true}`;
  const asker = `{"name":"asker","command":"sh","args":["-c","printf \\"$1\\"; sleep 1; curl -s -X POST \\"$0\\"; sleep 30","{attention}","\\\\033]7501;state=blocked:kind=question\\\\033\\\\\\\\"],"readOnly":true}`;
  // lateposter: 2초 뒤에 "@user ..."를 보낸다 (그 사이 다른 프로젝트로 옮겨 가서 받는다)
  const lateposter = `{"name":"lateposter","command":"sh","args":["-c","sleep 2; curl -s -H Content-Type:application/json -d \\"$1\\" \\"$0\\"","{chat}","${rpc}"],"readOnly":true}`;
  // picker: 선택 창 흉내 (testChatPrompt가 picker.py를 만든다)
  const picker = `{"name":"picker","command":"python3","args":["${root}/picker.py"],"readOnly":true}`;
  // moder: claude 모드 줄 흉내 (testChatMode가 moder.py를 만든다)
  const moder = `{"name":"moder","command":"python3","args":["${root}/moder.py"],"readOnly":true}`;
  const pick = `{"name":"writer","command":"echo","args":["WRITER-UP"]},{"name":"reviewer","command":"echo","args":["REVIEWER-UP"],"readOnly":true},${poster},${listener},${chatter},${prompter},${attn},${asker},${hookfirst},${twice},${lateposter},${picker},${moder}`;
  // 터미널에 보내는 명령은 900바이트까지라 (run) 500자씩 나눠 붙인 뒤 옮긴다 (쓰는 도중의 반쪽 파일을 읽지 않게)
  const content = TEST_GROUPS.replace(/]}$/, `,{"id":"pick","name":"Pick","rules":"S2","sessions":[${pick}]}]}`);
  await run(first, `: > "${file}.part"`);
  for (let i = 0; i < content.length; i += 500) await run(first, `printf '%s' '${content.slice(i, i + 500)}' >> "${file}.part"`);
  await run(first, `mv "${file}.part" "${file}"`);
  await waitFor("세션 고르기 설정", () => devHooks.groups?.groups.some((g) => g.id === "pick"), 3000);
  const before = tabCount();
  await menu("new_tab");
  await waitFor("셸 탭", () => tabCount() === before + 1 && visiblePanes().length === 1);
  const dialog = () => document.querySelector<HTMLElement>(".add-session-dialog");
  const choices = () => [...(dialog()?.querySelectorAll<HTMLElement>("[data-session]") ?? [])];
  const open = async (how: "menu" | "tab") => {
    if (how === "menu") await clickMenu("Terminal", "Add Session…");
    else {
      rightClick(activeTabEl()!);
      await waitFor("탭 메뉴", contextMenu);
      await pickMenu("Add Session…");
    }
    await waitFor("세션 추가 창", () => choices().length);
  };
  const choose = (id: string) => choices().find((el) => el.dataset.session === id)!.click();
  const labels = () => paneEls().map((el) => el.querySelector(".pane-label")?.firstChild?.textContent ?? "-").join(",");
  const warning = () => dialog()?.querySelector("[data-warning]")?.textContent ?? "";

  await open("menu");
  const listed = choices().map((el) => el.dataset.session).join(",");
  choose("pick/writer");
  await waitFor("쓰는 세션 추가", () => !dialog() && paneEls().length === 2, 5000);
  const writer = visiblePanes()[1];
  await waitFor("쓰는 세션 실행", () => screen(writer.term).some((l) => l.includes("WRITER-UP")), 10000);
  check(
    "세션 추가: 메뉴에서 설정의 세션을 골라 지금 탭 오른쪽 창으로 띄움, 포커스",
    listed === "test/shell,pick/writer,pick/reviewer,pick/poster,pick/listener,pick/chatter,pick/prompter,pick/attn,pick/asker,pick/hookfirst,pick/twice,pick/lateposter,pick/picker,pick/moder" && labels() === "-,writer" && writer.el.contains(document.activeElement) && writer.rect.left > visiblePanes()[0].rect.left,
    `${listed} | ${labels()}`,
  );

  await open("tab");
  choose("pick/reviewer");
  await waitFor("읽기 전용 추가", () => !dialog() && paneEls().length === 3, 5000);
  check("세션 추가: 탭 메뉴에서, 읽기 전용은 경고 없이 추가", labels() === "-,writer,reviewer", labels());

  await open("menu");
  choose("pick/writer");
  await waitFor("경고", warning, 3000);
  const warned = warning();
  dialog()!.querySelector<HTMLElement>("button.secondary")!.click();
  await waitFor("취소", () => !dialog(), 3000);
  check("세션 추가: 쓰는 세션이 있으면 또 더할 때 경고, 취소하면 그대로", warned.includes(": writer.") && warned.includes("“writer”") && paneEls().length === 3, warned);

  await open("menu");
  choose("pick/writer");
  await waitFor("경고", warning, 3000);
  dialog()!.querySelector<HTMLElement>("[data-action=add-anyway]")!.click();
  await waitFor("그래도 추가", () => !dialog() && paneEls().length === 4, 5000);
  // 포커스는 마지막에 더한 reviewer라 그 오른쪽에 붙는다
  check("세션 추가: 그래도 추가 (포커스된 창 오른쪽)", labels() === "-,writer,reviewer,writer", labels());

  // 채팅방: 명령이 있는 세션은 "작업그룹/역할"로 참여하고 (같은 이름은 -2), 인자의 {chat}으로 MCP에 보낼 수 있다
  await open("menu");
  choose("pick/poster");
  const posted = await waitAsync(
    "MCP로 보낸 메시지",
    async () => (await invoke<{ from: string; text: string; to: string[] }[]>("chat_messages", { project: root })).find((m) => m.text === "@user hello from poster"),
    10000,
  ).catch(() => null);
  const members = await invoke<string[]>("chat_members", { project: root });
  check(
    "채팅방: 세션이 작업그룹/역할로 참여하고, {chat} 주소로 보낸 메시지가 그 이름으로 기록됨",
    posted?.from === "origin/poster" && posted.to.join(",") === "user" && members.join(",") === "user,origin/poster,origin/reviewer,origin/writer,origin/writer-2",
    `${JSON.stringify(posted)} | ${members.join(",")}`,
  );

  // 역할·규약: 세션의 role과 그 세션이 든 그룹(pick)의 rules가 빈 줄로 이어져 {prompt}로, {prompt:toml}은 TOML 문자열로
  // 들어간다. 자리표시자는 한 번에 바꿔서 넣은 역할 안의 {chat}은 그대로다. 확인한 뒤 닫는다 (뒤 검사의 참여자 목록)
  await open("menu");
  choose("pick/prompter");
  const prompterPane = await waitFor("prompter 창", () => visiblePanes().find((p) => p.el.querySelector(".pane-label")?.firstChild?.textContent === "prompter"), 5000);
  const promptLines = await waitFor("prompter 출력", () => {
    const lines = screen(prompterPane.term);
    return lines.some((l) => l.includes("|B:")) && lines;
  }, 10000).catch(() => screen(prompterPane.term));
  check(
    "역할·규약: {prompt}는 역할 + 그룹 규약, {prompt:toml}은 TOML 문자열, 넣은 값 안의 {chat}은 그대로",
    promptLines.includes("A:R {chat}") && promptLines.some((l) => l.includes('S2|B:v="R {chat}\\n\\nS2"|')),
    promptLines.filter((l) => l.trim()).slice(-4).join(" ⏎ "),
  );
  // 세션 다시 시작 (이름 줄 ↻): 확인을 받고 그 창의 터미널만 새로 띄워 세션을 다시 띄운다. 취소하면 그대로, 채팅 이름도 그대로
  const realConfirm = devHooks.confirm;
  let restartAsked = "";
  devHooks.confirm = async (m) => ((restartAsked = m), false);
  prompterPane.el.querySelector<HTMLElement>("[data-action=pane-restart]")?.click();
  await sleep(300);
  const kept = visiblePanes().find((p) => p.el === prompterPane.el)?.term === prompterPane.term;
  devHooks.confirm = async () => true;
  prompterPane.el.querySelector<HTMLElement>("[data-action=pane-restart]")?.click();
  const restarted = await waitFor("다시 띄운 prompter", () => {
    const p = visiblePanes().find((x) => x.el === prompterPane.el);
    return p && p.term !== prompterPane.term && screen(p.term).some((l) => l.includes("|B:")) && p;
  }, 10000).catch(() => undefined);
  devHooks.confirm = realConfirm;
  const afterRestart = await waitAsync("다시 참여", async () => {
    const m = await invoke<string[]>("chat_members", { project: root });
    return m.includes("origin/prompter") && m;
  }, 5000).catch(() => [] as string[]);
  check(
    "세션 다시 시작: 확인을 받고(취소하면 그대로) 그 창의 터미널을 새로 띄워 세션을 다시 띄움, 채팅 이름은 그대로",
    kept && restartAsked.includes("prompter") && !!restarted && paneEls().includes(prompterPane.el) && !afterRestart.some((n) => n.startsWith("origin/prompter-")),
    `${kept} ${JSON.stringify(restartAsked)} ${!!restarted} ${afterRestart.join(",")}`,
  );
  // 창 닫기 (이름 줄 ×): 묻지 않고 그 창을 닫는다
  const panesBeforeClose = paneEls().length;
  prompterPane.el.querySelector<HTMLElement>("[data-action=pane-close]")?.click();
  await waitFor("× 닫기", () => paneEls().length === panesBeforeClose - 1, 3000).catch(() => null);
  check("창 닫기: 이름 줄 ×로 묻지 않고 그 창을 닫음", paneEls().length === panesBeforeClose - 1 && !paneEls().includes(prompterPane.el), `${panesBeforeClose} → ${paneEls().length}`);
  await waitAsync("prompter 나감", async () => !(await invoke<string[]>("chat_members", { project: root })).includes("origin/prompter"), 5000).catch(() => null);

  await testChatPanel(root, open, choose);
  await testChatPrompt(root, first, open, choose);
  await testChatMode(root, first, open, choose);

  // 경고에서 새 작업그룹을 고르면 별도 worktree의 작업그룹을 연다 (기본 그룹)
  await open("menu");
  choose("pick/writer");
  await waitFor("경고", warning, 3000);
  dialog()!.querySelector<HTMLElement>("[data-action=new-group]")!.click();
  await waitFor("새 작업그룹", () => tabCount() === before + 2, 60000);
  const made = activeTabEl()!;
  check("세션 추가: 경고에서 새 작업그룹을 열 수 있음", !dialog() && !!made.querySelector(".tab-title")?.getAttribute("title")?.includes("/worktrees/"), made.textContent ?? "");

  for (const tab of [made, document.querySelectorAll<HTMLElement>(".project-workspace:not([style*='none']) .tab")[before]]) {
    tab.querySelector<HTMLElement>("[title='Close Tab']")!.click();
    // 작업그룹의 마지막 탭이면 끝내기 창이 뜬다: 탭만 닫는다
    const only = await waitFor("탭만 닫기", () => document.querySelector<HTMLElement>("[data-action=close-tab-only]"), 500).catch(() => null);
    only?.click();
  }
  await waitFor("탭 정리", () => tabCount() === before, 5000);
  const left = await waitAsync("참여자 정리", async () => {
    const m = await invoke<string[]>("chat_members", { project: root });
    return m.every((n) => !n.startsWith("origin/")) && m;
  }, 5000).catch(() => null);
  check("채팅방: 터미널을 닫으면 참여자에서 빠짐", left?.join(",") === "user", String(left));
  await run(first, `printf '%s' '${TEST_GROUPS}' > "${file}"`);
  await waitFor("테스트 설정 복귀", () => devHooks.groups?.groups.length === 1, 3000);
}

// 대화 ID 따라가기 (docs/reviews/2026-10-31-claude-session-follow.md): claude SessionStart 훅 대신 curl로 그 창의 {sessionStart}에
// 훅 입력을 보낸다. follower는 알려 오는 창(처음 인자에 {sessionStart}), plain은 알려 오지 않는 창(리뷰 R1). 처음 인자는 받은
// {session}(과 주소)을 파일에 쓰고, follower는 claude처럼 그 ID를 startup으로 알린다. 이어서 하기는 받은 {session}을 파일에 쓰고
// 실패한다 → [y/N]에 y → 처음 인자.
// (창이 좁아 긴 줄이 접히므로 값은 파일로 받는다. 설정은 셸 작은따옴표로 쓰므로 작은따옴표를 쓰지 않는다)
async function testSessionFollow(root: string, first: Terminal) {
  const file = await groupsFile();
  const [ff, fr, pf] = ["follow-first", "follow-resumed", "plain-first"].map((n) => `${root}/${n}.txt`);
  const startup = `printf "{\\"session_id\\":\\"%s\\",\\"source\\":\\"startup\\"}" "$0" | curl -s -o /dev/null --data-binary @- "$1"`;
  const follower = JSON.stringify({
    name: "follower",
    command: "sh",
    args: ["-c", `echo "$0" > "$2"; echo "$1" >> "$2"; ${startup}`, "{session}", "{sessionStart}", ff],
    resume: ["-c", `echo "$0" > "$1"; exit 1`, "{session}", fr],
  });
  // (읽기 전용 표시: 쓰는 세션이 둘이면 더할 때 경고 창이 뜬다)
  const plain = `{"name":"plain","command":"sh","args":["-c","echo \\"$0\\" > \\"$1\\"","{session}","${pf}"],"resume":["-c","exit 1"],"readOnly":true}`;
  const content = TEST_GROUPS.replace(/]}$/, `,{"id":"follow","name":"Follow","sessions":[${follower},${plain}]}]}`);
  await run(first, `rm -f "${ff}" "${fr}" "${pf}"; : > "${file}.part"`);
  for (let i = 0; i < content.length; i += 500) await run(first, `printf '%s' '${content.slice(i, i + 500)}' >> "${file}.part"`);
  await run(first, `mv "${file}.part" "${file}"`);
  await waitFor("대화 ID 설정", () => devHooks.groups?.groups.some((g) => g.id === "follow"), 3000);
  const lines = async (path: string) => (await run(first, `cat "${path}" 2>/dev/null`)).map((l) => l.trim()).filter(Boolean);
  // 파일 내용이 cond를 만족할 때까지
  const fileWhen = (path: string, cond: (l: string[]) => boolean) => waitAsync(path, async () => ((l) => cond(l) && l)(await lines(path)), 10000).catch(() => [] as string[]);
  const before = tabCount();
  await menu("new_tab");
  await waitFor("셸 탭", () => tabCount() === before + 1 && visiblePanes().length === 1);
  const dialog = () => document.querySelector<HTMLElement>(".add-session-dialog");
  for (const id of ["follow/follower", "follow/plain"]) {
    // 탭의 오른쪽 클릭 메뉴로 연다 (앱 메뉴 클릭은 맥에만 있다)
    rightClick(activeTabEl()!);
    await waitFor("탭 메뉴", contextMenu);
    await pickMenu("Add Session…");
    const choice = await waitFor("세션 추가 창", () => dialog()?.querySelector<HTMLElement>(`[data-session="${id}"]`));
    choice.click();
    await waitFor("세션 추가", () => !dialog(), 5000);
  }
  const paneOf = (name: string) => paneEls().find((el) => el.querySelector(".pane-label")?.firstChild?.textContent === name);
  const termOf = (name: string) => visiblePanes().find((p) => p.el === paneOf(name))?.term;
  const saved = async () => {
    const text = await invoke<string | null>("workspace_load", { project: root });
    const sessions = Object.values((JSON.parse(text ?? "{}").sessions ?? {}) as Record<string, PaneSession>);
    return (name: string) => sessions.find((x) => x.name === name);
  };
  const realConfirm = devHooks.confirm;
  devHooks.confirm = async () => true;
  try {
    const [sid, url] = await fileWhen(ff, (l) => l.length === 2);
    const [plainSid] = await fileWhen(pf, (l) => l.length === 1);
    check("대화 ID: 처음에는 창 키(sid)로 시작하고 {sessionStart}는 그 창의 /session/ 주소", UUID.test(sid ?? "") && /^http:\/\/127\.0\.0\.1:\d+\/session\/\S+$/.test(url ?? "") && UUID.test(plainSid ?? ""), `${sid} ${url} ${plainSid}`);

    // 훅 입력을 보내면 그 창의 cur가 바뀌어 저장된다 (sid·채팅 이름은 그대로)
    const next = crypto.randomUUID();
    const posted = await run(first, `curl -s -o /dev/null -w "CODE%{http_code}" --data-binary '{"session_id":"${next}","source":"clear"}' "${url}"; echo`);
    const stored = await waitAsync("cur 저장", async () => ((s) => s?.cur === next && s)((await saved())("follower")), 5000).catch(() => undefined);
    check("대화 ID: SessionStart 입력을 받으면(204) 그 창의 cur를 바꿔 저장, sid는 그대로", posted.some((l) => l.trim() === "CODE204") && stored?.sid === sid, `${posted.join("|")} ${JSON.stringify(stored && { sid: stored.sid, cur: stored.cur })}`);

    // ↻: 이어서 하기가 cur로. 실패하면 묻고, y면 알려 오는 창은 새 ID로 처음 인자 (앞 ID로 시작하면 "already in use")
    paneOf("follower")!.querySelector<HTMLElement>("[data-action=pane-restart]")!.click();
    const [resumedWith] = await fileWhen(fr, (l) => l.length === 1);
    const asked = await waitFor("새로 시작할지 묻기", () => termOf("follower") && screen(termOf("follower")!).join("").includes("Start a new conversation instead? [y/N]"), 10000).catch(() => false);
    termOf("follower")?.input("y\r");
    const [fresh] = await fileWhen(ff, (l) => l.length === 2 && l[0] !== sid);
    check(
      "대화 ID: 다시 시작하면 cur로 이어서 하기, 실패 뒤 y면 새 대화 ID로 시작 (알려 오는 창)",
      resumedWith === next && asked && UUID.test(fresh ?? "") && fresh !== sid && fresh !== next,
      `${resumedWith} ${asked} ${fresh}`,
    );
    // 새로 시작한 ID를 알려 오면 그것이 cur가 되고, 다음 ↻는 그 ID로 이어 간다 (리뷰 R2)
    const freshStored = await waitAsync("새 ID 저장", async () => ((s) => s?.cur === fresh && s)((await saved())("follower")), 5000).catch(() => undefined);
    await run(first, `rm -f "${fr}"`);
    paneOf("follower")!.querySelector<HTMLElement>("[data-action=pane-restart]")!.click();
    const [resumedAgain] = await fileWhen(fr, (l) => l.length === 1);
    await waitFor("다시 묻기", () => termOf("follower") && screen(termOf("follower")!).join("").includes("[y/N]"), 10000).catch(() => false);
    termOf("follower")?.input("\r");
    check("대화 ID: 새로 시작한 ID를 알리면 cur로 저장되고 다음 다시 시작은 그 ID로", freshStored?.sid === sid && resumedAgain === fresh, `${freshStored?.cur} ${resumedAgain} ${fresh}`);
    const members = await invoke<string[]>("chat_members", { project: root });
    check("대화 ID: 다시 시작해도 채팅 이름은 그대로 (창 키가 그대로)", members.includes("origin/follower") && !members.some((m) => m.startsWith("origin/follower-")), members.join(","));

    // 알려 오지 않는 창 (리뷰 R1): 새 ID를 저장할 길이 없으니 y면 지금처럼 같은 ID로
    await run(first, `rm -f "${pf}"`);
    paneOf("plain")!.querySelector<HTMLElement>("[data-action=pane-restart]")!.click();
    const plainAsked = await waitFor("새로 시작할지 묻기 (plain)", () => termOf("plain") && screen(termOf("plain")!).join("").includes("[y/N]"), 10000).catch(() => false);
    termOf("plain")?.input("y\r");
    const [plainAgain] = await fileWhen(pf, (l) => l.length === 1);
    check("대화 ID: 알려 오지 않는 창은 실패 뒤 y면 같은 ID로 시작 (리뷰 R1)", plainAsked && plainAgain === plainSid, `${plainAsked} ${plainAgain} ${plainSid}`);
  } finally {
    devHooks.confirm = realConfirm;
  }
  const tab = document.querySelectorAll<HTMLElement>(".project-workspace:not([style*='none']) .tab")[before];
  tab.querySelector<HTMLElement>("[title='Close Tab']")!.click();
  await waitFor("탭 정리", () => tabCount() === before, 5000);
  await run(first, `rm -f "${ff}" "${fr}" "${pf}"; printf '%s' '${TEST_GROUPS}' > "${file}"`);
  await waitFor("테스트 설정 복귀", () => devHooks.groups?.groups.length === 1, 3000);
}

// 선택 창 답하기 (src-tauri/src/prompts.rs, src/PromptChoices.tsx, Terminal.tsx answerPrompt): 세션이 선택 창을 띄우면 그 이름으로
// 채팅에 질문·선택지가 올라오고 (채팅 알림은 내지 않음), 누르면 (승인일 수 있으면 확인 뒤) 화살표로 커서를 옮겨 확인한 다음 Enter.
// 알린 뒤 화면이 바뀌었으면 넣지 않고 "바뀜"으로 기록한다. picker.py가 claude 권한 확인 모양을 흉내 낸다 (두 번 묻고, x면 질문이 바뀜)
async function testChatPrompt(root: string, first: Terminal, openAdd: (how: "menu" | "tab") => Promise<void>, choose: (id: string) => void) {
  const script = String.raw`import os, sys, time, tty
R = [["Bash command", "", "  npm test", "", "Do you want to proceed?"], ["Yes", "Yes, always", "No"]]
S = [["Second?"], ["Allow", "Deny"]]
X = [["Changed?"], ["Allow", "Deny"]]
L = [["Long question %d" % i for i in range(1, 61)], ["Allow", "Deny"]]
V = [["Alt long %d" % i for i in range(1, 81)], ["Allow", "Deny"]]
U = [["Update available 1 -> 2", "", "Release notes: none"], ["Update now", "Skip", "Skip until next version"]]
def ask(d, alt=False):
    c = 0
    while True:
        q, o = d
        w = sys.stdout.write
        w(("\x1b[?1049h\x1b[2J\x1b[H" if alt else "\x1b[2J\x1b[H" + "\u2500" * 20 + "\r\n") + "\r\n".join(q) + "\r\n")
        for i, x in enumerate(o):
            w(("❯ " if i == c else "  ") + str(i + 1) + ". " + x + "\r\n")
        w("Enter to confirm · Esc to cancel\r\n")
        sys.stdout.flush()
        k = os.read(0, 16)
        if k in (b"\x1b[B", b"\x1bOB"):
            c = min(c + 1, len(o) - 1)
        elif k in (b"\x1b[A", b"\x1bOA"):
            c = max(c - 1, 0)
        elif k == b"x":
            d = X
        elif k == b"\r":
            return o[c]
tty.setraw(0)
a = ask(R)
b = ask(S)
l = ask(L)
v = ask(V, True)
u = ask(U, True)
sys.stdout.write("\x1b[?1049l\x1b[2J\x1b[HCHOSE:" + a + "|" + b + "|" + l + "|" + v + "|" + u + "\r\n")
sys.stdout.flush()
time.sleep(60)`;
  await run(first, `: > "${root}/picker.py"`);
  for (const line of script.split("\n")) await run(first, `printf '%s\\n' '${line}' >> "${root}/picker.py"`);

  const ws = () => document.querySelector<HTMLElement>(".project-workspace:not([style*='none'])")!;
  const panel = () => ws().querySelector<HTMLElement>(".chat-panel")!;
  const shown = () => !!ws().querySelector(".chat-panel") && panel().style.display !== "none";
  if (!shown()) ws().querySelector<HTMLElement>("[data-action=chat]")!.click();
  await waitFor("채팅 패널", shown, 3000);
  type Stored = { id: number; from: string; to: string[]; prompt?: { id: string; question: string[]; options: { label: string; confirm: boolean }[]; answerable?: boolean }; answer?: { prompt: string; option: number; result: string } };
  const stored = () => invoke<Stored[]>("chat_messages", { project: root });
  const promptAsking = async (q: string) => (await stored()).find((m) => m.prompt?.question.includes(q));
  const card = (id: string) => panel().querySelector<HTMLElement>(`[data-prompt="${id}"]`);
  const option = (id: string, i: number) => card(id)?.querySelector<HTMLButtonElement>(`[data-option="${i}"]`) ?? null;

  // 새 탭에 띄운다: 지금 탭에는 앞 검사의 창이 많아 폭이 몇 칸뿐이라 선택 창의 줄이 접혀 화면을 넘친다
  const tabsBefore = tabCount();
  await menu("new_tab");
  await waitFor("picker 탭", () => tabCount() === tabsBefore + 1 && paneEls().length === 1, 5000);
  const panesBefore = paneEls().length;
  await openAdd("menu");
  choose("pick/picker");
  await waitFor("picker 창", () => paneEls().length === panesBefore + 1, 5000);
  const pickerPane = visiblePanes().find((p) => p.el.querySelector(".pane-label")?.textContent?.startsWith("picker"))!;
  const pickerScreen = () => screen(pickerPane.term).join("\n");

  const firstAsk = await waitAsync("선택 창 메시지", () => promptAsking("Do you want to proceed?"), 10000).catch(() => undefined);
  const firstId = firstAsk?.prompt?.id ?? "";
  await waitFor("선택지 버튼", () => !!option(firstId, 2) && !option(firstId, 0)!.disabled, 3000).catch(() => null);
  const notes = (await invoke<[[string, string][], number, string | null]>("selftest_notifications"))[0];
  check(
    "선택 창 답하기: 세션의 선택 창이 그 이름으로 채팅에 (질문·선택지, 승인일 수 있는 것만 확인), 누를 수 있음, 채팅 알림은 내지 않음",
    firstAsk?.from === "origin/picker" && firstAsk.to.join() === "user" && firstAsk.prompt!.question.join("|") === "Bash command|npm test|Do you want to proceed?" &&
      firstAsk.prompt!.options.map((o) => `${o.label}:${o.confirm}`).join(",") === "Yes:true,Yes, always:true,No:false" && !!option(firstId, 2) && !option(firstId, 0)!.disabled &&
      !notes.some(([, body]) => body.startsWith("origin/picker:")),
    `${JSON.stringify(firstAsk)} notes=${JSON.stringify(notes.slice(-3))} members=${await invoke<string[]>("chat_members", { project: root })} screen=${JSON.stringify(pickerScreen().slice(0, 300))}`,
  );

  // 승인일 수 있는 선택지는 확인을 받는다: 취소하면 아무것도 보내지 않는다
  option(firstId, 0)!.click();
  await waitFor("확인 줄", () => card(firstId)?.querySelector("[data-confirm='0']"), 2000).catch(() => null);
  const asked = !!card(firstId)?.querySelector("[data-confirm='0']");
  card(firstId)?.querySelector<HTMLElement>("[data-action=prompt-cancel]")?.click();
  await sleep(500);
  const untouched = !card(firstId)?.querySelector("[data-confirm]") && pickerScreen().includes("\u276f 1. Yes") && !(await stored()).some((m) => m.answer);
  check("선택 창 답하기: 승인일 수 있는 선택지는 확인 줄, 취소하면 그대로", asked && untouched, `${asked} ${untouched} ${pickerScreen().slice(0, 200)}`);

  // 2번(Yes, always)을 확인하고 보낸다: 커서를 두 칸이 아니라 한 칸 옮긴 뒤 Enter, 보냄 기록, 버튼은 닫힘
  option(firstId, 1)!.click();
  await waitFor("확인 줄", () => card(firstId)?.querySelector("[data-action=prompt-send]"), 2000).catch(() => null);
  card(firstId)?.querySelector<HTMLElement>("[data-action=prompt-send]")?.click();
  const sent = await waitAsync("보냄 기록", async () => (await stored()).find((m) => m.answer?.prompt === firstId), 8000).catch(() => undefined);
  const secondAsk = await waitAsync("두 번째 선택 창", () => promptAsking("Second?"), 8000).catch(() => undefined);
  await waitFor("고른 것 표시", () => option(firstId, 1)?.classList.contains("chosen") && option(firstId, 0)?.disabled, 3000).catch(() => null);
  check(
    "선택 창 답하기: 확인하고 보내면 그 선택지로 커서를 옮겨 Enter, 보냄 기록, 그 선택 창은 닫힘",
    sent?.answer?.result === "sent" && sent.answer.option === 1 && sent.from === "user" && sent.to.length === 0 && !!secondAsk && !!option(firstId, 1)?.classList.contains("chosen") && !!option(firstId, 0)?.disabled,
    `${JSON.stringify(sent)} second=${!!secondAsk} ${card(firstId)?.textContent}`,
  );

  // 알린 뒤 화면이 바뀌었으면 넣지 않는다: 바뀐 것을 Rust에 늦게 알리게 하고 그 사이에 앞 선택 창에 답한다
  const secondId = secondAsk?.prompt?.id ?? "";
  devHooks.statusDelay = (cmd) => (cmd === "pty_dialog" ? 2000 : 0);
  pickerPane.term.input("x");
  await waitFor("화면이 바뀜", () => pickerScreen().includes("Changed?"), 3000).catch(() => null);
  const accepted = await invoke("chat_answer", { project: root, prompt: secondId, option: 0 }).then(() => true, (e) => String(e));
  const changed = await waitAsync("바뀜 기록", async () => (await stored()).find((m) => m.answer?.prompt === secondId), 5000).catch(() => undefined);
  devHooks.statusDelay = undefined;
  const thirdAsk = await waitAsync("바뀐 선택 창", () => promptAsking("Changed?"), 8000).catch(() => undefined);
  check(
    "선택 창 답하기: 알린 뒤 화면의 선택 창이 바뀌었으면 넣지 않고 바뀜으로 기록, 바뀐 것은 새 메시지",
    accepted === true && changed?.answer?.result === "changed" && pickerScreen().includes("Changed?") && !!thirdAsk,
    `${accepted} ${JSON.stringify(changed)} third=${!!thirdAsk}`,
  );

  // 거절 쪽(Deny)은 확인 없이 바로 보낸다
  const thirdId = thirdAsk?.prompt?.id ?? "";
  await waitFor("세 번째 버튼", () => !!option(thirdId, 1) && !option(thirdId, 1)!.disabled, 3000).catch(() => null);
  option(thirdId, 1)?.click();

  // 질문이 화면 위로 넘어가도 답할 수 있다: 일반 화면은 스크롤 기록에서 이어 읽고 (가로줄까지 60줄), 대체 화면은 맨 윗줄이
  // 처음이다 (codex 업데이트 안내처럼 경계 없이 맨 윗줄부터 그린 짧은 질문. 2026-10-28 폰에서 답하지 못했다)
  const longAsk = await waitAsync("긴 질문", () => promptAsking("Long question 60"), 8000).catch(() => undefined);
  const longOk = await invoke("chat_answer", { project: root, prompt: longAsk?.prompt?.id ?? "", option: 1 }).then(() => true, (e) => String(e));
  // 대체 화면도 화면보다 긴 출력은 위가 사라진다: 맨 윗줄을 처음으로 보지 않고 답하지 않는다 (리뷰 R1). 맥에서 Enter로 넘긴다
  const lostAsk = await waitAsync("대체 화면에서 넘친 질문", () => promptAsking("Alt long 80"), 8000).catch(() => undefined);
  const lostRefused = await invoke("chat_answer", { project: root, prompt: lostAsk?.prompt?.id ?? "", option: 1 }).then(() => "accepted", (e) => String(e));
  pickerPane.term.input("\r");
  const altAsk = await waitAsync("대체 화면 질문", () => promptAsking("Update available 1 -> 2"), 8000).catch(() => undefined);
  const altOk = await invoke("chat_answer", { project: root, prompt: altAsk?.prompt?.id ?? "", option: 1 }).then(() => true, (e) => String(e));
  check(
    "선택 창 답하기: 화면 위로 넘친 긴 질문(스크롤 기록에서 이어 읽음)과 대체 화면 맨 윗줄부터의 질문도 답할 수 있음",
    longAsk?.prompt?.question.length === 60 && longAsk.prompt.question[0] === "Long question 1" && longOk === true &&
      altAsk?.prompt?.question.join("|") === "Update available 1 -> 2|Release notes: none" && altOk === true,
    `${JSON.stringify(longAsk?.prompt?.question.slice(0, 2))} ${longAsk?.prompt?.question.length} ${longOk} ${JSON.stringify(altAsk?.prompt?.question)} ${altOk}`,
  );
  check(
    "선택 창 답하기: 대체 화면에서 화면보다 길어 위가 밀려난 질문은 답하지 않음 (리뷰 R1)",
    !!lostAsk && lostAsk.prompt?.answerable === false && lostRefused !== "accepted" && !lostAsk.prompt.question.includes("Alt long 1"),
    `${!!lostAsk} ${lostAsk?.prompt?.answerable} ${lostRefused} ${JSON.stringify(lostAsk?.prompt?.question.slice(0, 2))}`,
  );
  const done = await waitFor("고름", () => pickerScreen().includes("CHOSE:Yes, always|Deny|Deny|Allow|Skip"), 8000).then(() => true, () => false);
  const closed = await waitAsync("열린 선택 창 없음", async () => (await invoke<string[]>("chat_prompts", { project: root })).length === 0, 3000).then(() => true, () => false);
  check("선택 창 답하기: 거절 쪽은 확인 없이 보냄, 끝나면 열린 선택 창 없음", done && closed, `${done} ${closed} ${pickerScreen().slice(0, 120)}`);

  // 세션 다시 시작 (이름 줄 ↻)과 옛 터미널의 것들: 다시 띄운 picker가 선택 창을 다시 띄워 채팅에 올라오고 대기 배지가 선다.
  // 그 채로 다시 시작하면 옛 터미널이 끝나기를 기다리는 동안 터미널 대신 안내만 (배지 지움, 리뷰 R2), 옛 선택 창은 닫혀 채팅에
  // 알림 (리뷰 R3), 옛 터미널이 끝나지 않으면 띄우지 않음 (리뷰 R1). 다시 누르면 새로 띄운다
  const realConfirm = devHooks.confirm;
  devHooks.confirm = async () => true;
  const pickerEl = pickerPane.el;
  const pickerTerm = () => visiblePanes().find((p) => p.el === pickerEl)?.term;
  const freshAsk = async (not: string[]) =>
    waitAsync("다시 띄운 선택 창", async () => (await stored()).find((m) => m.prompt?.question.includes("Do you want to proceed?") && !not.includes(m.prompt.id)), 10000).catch(() => undefined);
  const seenAsks = (await stored()).flatMap((m) => (m.prompt ? [m.prompt.id] : []));
  pickerEl.querySelector<HTMLElement>("[data-action=pane-restart]")?.click();
  const again = await freshAsk(seenAsks);
  await waitFor("대기 배지", () => pickerEl.querySelector(".pane-label [data-status]"), 3000).catch(() => null);
  const before = { again: !!again && pickerTerm() !== pickerPane.term, badge: !!pickerEl.querySelector(".pane-label [data-status]"), open: (await invoke<string[]>("chat_prompts", { project: root })).includes(again?.prompt?.id ?? "-") };
  let promptEvents = 0;
  const unlistenPrompts = await listen("chat-prompts", () => promptEvents++);
  let finishWait: (ended: boolean) => void = () => {};
  devHooks.paneWaitClosed = () => new Promise<boolean>((r) => (finishWait = r));
  pickerEl.querySelector<HTMLElement>("[data-action=pane-restart]")?.click();
  await waitFor("기다리는 안내", () => pickerEl.querySelector("[data-restarting=waiting]"), 3000).catch(() => null);
  const whileWaiting = {
    notice: !!pickerEl.querySelector("[data-restarting=waiting]"),
    noTerminal: !pickerEl.querySelector(".xterm"),
    noBadge: !pickerEl.querySelector(".pane-label [data-status]"),
    noRestart: !pickerEl.querySelector("[data-action=pane-restart]"),
  };
  const promptClosed = await waitAsync("옛 선택 창 닫힘", async () => promptEvents > 0 && !(await invoke<string[]>("chat_prompts", { project: root })).includes(again?.prompt?.id ?? "-") && true, 3000).catch(() => false);
  await waitFor("닫힌 선택 창 단추", () => option(again?.prompt?.id ?? "-", 0)?.disabled, 3000).catch(() => null);
  const cardClosed = !!option(again?.prompt?.id ?? "-", 0)?.disabled;
  finishWait(false);
  await waitFor("끝나지 않음 안내", () => pickerEl.querySelector("[data-restarting=failed]"), 3000).catch(() => null);
  await sleep(300);
  const notEnded = !!pickerEl.querySelector("[data-restarting=failed]") && !pickerEl.querySelector(".xterm");
  unlistenPrompts();
  devHooks.paneWaitClosed = undefined;
  const seenAsks2 = (await stored()).flatMap((m) => (m.prompt ? [m.prompt.id] : []));
  pickerEl.querySelector<HTMLElement>("[data-action=pane-restart]")?.click();
  const third = await freshAsk(seenAsks2);
  // 새 터미널의 PTY 번호가 오기 전(만드는 중)에는 ↻가 없다: 그때 다시 시작하면 이미 떠 있을 수 있는 옛 프로세스를 기다릴 수
  // 없다 (재리뷰 R1). 번호가 오면 생긴다
  const termBefore = pickerTerm();
  devHooks.spawnDelay = 2000;
  pickerEl.querySelector<HTMLElement>("[data-action=pane-restart]")?.click();
  await waitFor("만드는 중인 새 터미널", () => !pickerEl.querySelector("[data-restarting]") && pickerTerm() && pickerTerm() !== termBefore, 5000).catch(() => null);
  const spawning = { newTerm: !!pickerTerm() && pickerTerm() !== termBefore, noRestart: !pickerEl.querySelector("[data-action=pane-restart]") };
  devHooks.spawnDelay = undefined;
  const restartBack = await waitFor("번호가 온 뒤 ↻", () => pickerEl.querySelector("[data-action=pane-restart]"), 5000).then(() => true, () => false);
  // 겹친 두 요청은 하나만: 두 번 눌러도 기다림은 한 번 (재리뷰 R1)
  let waits = 0;
  let finishBoth: (ended: boolean) => void = () => {};
  devHooks.paneWaitClosed = () => {
    waits++;
    return new Promise<boolean>((r) => (finishBoth = r));
  };
  const termBeforeDouble = pickerTerm();
  pickerEl.querySelector<HTMLElement>("[data-action=pane-restart]")?.click();
  pickerEl.querySelector<HTMLElement>("[data-action=pane-restart]")?.click();
  await waitFor("기다리는 안내", () => pickerEl.querySelector("[data-restarting=waiting]"), 3000).catch(() => null);
  await sleep(300);
  const oneWait = waits === 1 && !!pickerEl.querySelector("[data-restarting=waiting]") && !pickerEl.querySelector(".xterm");
  finishBoth(true);
  const afterDouble = await waitFor("겹친 요청 뒤 새 터미널", () => !pickerEl.querySelector("[data-restarting]") && pickerTerm() && pickerTerm() !== termBeforeDouble, 5000).then(() => true, () => false);
  await sleep(300);
  devHooks.paneWaitClosed = undefined;
  // ↻가 아닌 길로 터미널이 바뀌어도 (작업그룹 끝내기 실패 뒤 다시 띄우기) 새 터미널의 번호가 오기 전에는 ↻가 없고, 누르면 옛
  // 번호가 아니라 지금 터미널의 번호를 기다린다 (재리뷰 2회 R4)
  const termBeforeRelaunch = pickerTerm();
  devHooks.spawnDelay = 2000;
  devHooks.relaunchActiveTab?.();
  await waitFor("다시 띄운 터미널", () => pickerTerm() && pickerTerm() !== termBeforeRelaunch, 5000).catch(() => null);
  const relaunchSpawning = !!pickerTerm() && pickerTerm() !== termBeforeRelaunch && !pickerEl.querySelector("[data-action=pane-restart]");
  devHooks.spawnDelay = undefined;
  await waitFor("번호가 온 뒤 ↻", () => pickerEl.querySelector("[data-action=pane-restart]"), 5000).catch(() => null);
  const relaunchedPty = Number(pickerEl.querySelector<HTMLElement>("[data-pty]")?.dataset.pty);
  let waitedFor: number | undefined;
  devHooks.paneWaitClosed = async (pty) => ((waitedFor = pty), true);
  const termBeforeR4 = pickerTerm();
  pickerEl.querySelector<HTMLElement>("[data-action=pane-restart]")?.click();
  const afterR4 = await waitFor("R4 다시 시작", () => !pickerEl.querySelector("[data-restarting]") && pickerTerm() && pickerTerm() !== termBeforeR4, 5000).then(() => true, () => false);
  devHooks.paneWaitClosed = undefined;
  const relaunchOk = relaunchSpawning && relaunchedPty > 0 && waitedFor === relaunchedPty && afterR4;
  check(
    "세션 다시 시작: 새 터미널을 만드는 중(PTY 번호 전)에는 ↻가 없고, 겹쳐 누른 두 요청은 한 번만 기다려 한 번 띄움, ↻ 밖의 길로 다시 띄운 뒤에도 지금 터미널의 번호만 씀",
    Object.values(spawning).every(Boolean) && restartBack && oneWait && afterDouble && waits === 1 && relaunchOk,
    `${JSON.stringify(spawning)} ${restartBack} ${oneWait} ${afterDouble} waits=${waits} relaunch=${relaunchSpawning} ${relaunchedPty} waited=${waitedFor} ${afterR4}`,
  );
  devHooks.confirm = realConfirm;
  check(
    "세션 다시 시작: 옛 터미널이 끝나기를 기다리는 동안 터미널 대신 안내(상태 배지 지움), 옛 선택 창은 닫혀 채팅에 알림, 끝나지 않으면 띄우지 않고 다시 누르면 띄움",
    Object.values(before).every(Boolean) && Object.values(whileWaiting).every(Boolean) && promptClosed === true && cardClosed && notEnded && !!third,
    `${JSON.stringify(before)} ${JSON.stringify(whileWaiting)} ${promptClosed} ${cardClosed} ${notEnded} ${!!third}`,
  );

  pickerPane.term.focus();
  await menu("close_pane");
  await waitFor("picker 닫힘", () => paneEls().length === panesBefore, 5000).catch(() => null);
  await menu("close_pane");
  await waitFor("picker 탭 닫힘", () => tabCount() === tabsBefore, 5000).catch(() => null);
  ws().querySelector<HTMLElement>("[data-action=chat]")!.click();
  await waitFor("채팅 닫기", () => !shown(), 2000).catch(() => null);
  await run(first, `rm -f "${root}/picker.py"`);
}

// 권한 모드 바꾸기 (src-tauri/src/modes.rs, Terminal.tsx setMode, programStatus.ts readMode·driveMode): 화면 맨 아래 claude 모드
// 줄을 읽어 참여자의 모드로 알리고, 고르면 Shift+Tab을 하나씩 보내 모드 줄이 따라오는 것을 확인하며 그 모드까지 간다. 결과는
// 사용자 이름의 기록. moder.py: Shift+Tab마다 자동 → 수동 → 편집 허용 → 계획으로 돌고, 받은 Shift+Tab 수를 화면에 쓴다.
// d: 선택 창을 띄움 (Enter로 닫음), p: 다음 Shift+Tab에 모드를 바꾸며 선택 창도 띄움, s: 이 뒤로 Shift+Tab에 모드가 바뀌지 않음
async function testChatMode(root: string, first: Terminal, openAdd: (how: "menu" | "tab") => Promise<void>, choose: (id: string) => void) {
  const script = String.raw`import os, sys, tty
M = [("⏵⏵", "auto mode"), ("⏸", "manual mode"), ("⏵⏵", "accept edits"), ("⏸", "plan mode")]
i = 0
n = 0
stuck = False
dialog = False
pop = False
def draw():
    w = sys.stdout.write
    w("\x1b[2J\x1b[HKEYS:%d\r\n" % n)
    if dialog:
        w("Allow?\r\n❯ 1. Yes\r\n  2. No\r\nEnter to confirm · Esc to cancel\r\n")
    else:
        w("\r\n❯ \r\n\r\n  %s %s on (shift+tab to cycle)" % M[i])
    sys.stdout.flush()
tty.setraw(0)
draw()
while True:
    k = os.read(0, 16)
    if k == b"\x1b[Z":
        n += 1
        if not stuck and not dialog:
            i = (i + 1) % len(M)
            dialog = pop
            pop = False
    elif k == b"p":
        pop = True
    elif k == b"s":
        stuck = True
    elif k == b"d":
        dialog = True
    elif k == b"\r":
        dialog = False
    draw()`;
  await run(first, `: > "${root}/moder.py"`);
  for (const line of script.split("\n")) await run(first, `printf '%s\\n' '${line}' >> "${root}/moder.py"`);
  const ws = () => document.querySelector<HTMLElement>(".project-workspace:not([style*='none'])")!;
  const panel = () => ws().querySelector<HTMLElement>(".chat-panel");
  const tabsBefore = tabCount();
  await menu("new_tab");
  await waitFor("moder 탭", () => tabCount() === tabsBefore + 1 && paneEls().length === 1, 5000);
  const panesBefore = paneEls().length;
  await openAdd("menu");
  choose("pick/moder");
  await waitFor("moder 창", () => paneEls().length === panesBefore + 1, 5000);
  const pane = visiblePanes().find((p) => p.el.querySelector(".pane-label")?.textContent?.startsWith("moder"))!;
  const text = () => screen(pane.term).join("\n");
  const modes = () => invoke<[string, string][]>("selftest_chat_modes", { project: root });
  const modeIs = (m: string) => waitAsync(`모드 ${m}`, async () => (await modes()).some(([n, x]) => n === "origin/moder" && x === m), 5000).then(() => true, () => false);
  type Stored = { id: number; from: string; to: string[]; mode?: { member: string; mode: string; result: string } };
  const records = async () => (await invoke<Stored[]>("chat_messages", { project: root })).filter((m) => m.mode);
  const set = (mode: string) => invoke("chat_set_mode", { project: root, member: "origin/moder", mode }).then(() => "ok", (e) => String(e));
  const nextRecord = async (count: number) => waitAsync("모드 기록", async () => (await records()).length > count && (await records())[count], 8000).catch(() => undefined);

  const auto = await modeIs("auto");
  // 수동으로: 한 번 눌러 바뀜. 계획으로: 두 번 (수동 → 편집 허용 → 계획)
  let count = (await records()).length;
  const toManual = await set("manual");
  const manualRecord = await nextRecord(count);
  const manualShown = (await modeIs("manual")) && text().includes("KEYS:1") && text().includes("manual mode on");
  count++;
  const toPlan = await set("plan");
  const planRecord = await nextRecord(count);
  const planShown = (await modeIs("plan")) && text().includes("KEYS:3") && text().includes("plan mode on");
  count++;
  check(
    "권한 모드: 화면 맨 아래 모드 줄을 참여자의 모드로 알리고, 고르면 Shift+Tab을 하나씩 보내 그 모드까지 (수동 1번, 계획 2번), 사용자 이름으로 기록",
    auto && toManual === "ok" && manualRecord?.mode?.result === "sent" && manualRecord.mode.mode === "manual" && manualRecord.from === "user" && manualRecord.to.length === 0 && manualShown &&
      toPlan === "ok" && planRecord?.mode?.result === "sent" && planShown,
    `${auto} ${toManual} ${JSON.stringify(manualRecord)} ${manualShown} ${toPlan} ${JSON.stringify(planRecord)} ${planShown} ${JSON.stringify(await modes())} ${JSON.stringify(text())}`,
  );
  // 권한 확인을 모두 끄는 모드는 고를 수 없고, 선택 창이 떠 있는 동안은 바꾸지 않는다 (모드는 지난 것 그대로 보인다)
  const bypass = await set("bypass");
  pane.term.input("d");
  await waitFor("선택 창", () => text().includes("Enter to confirm"), 3000).catch(() => null);
  await sleep(500);
  const whileDialog = await set("auto");
  const keptMode = await modeIs("plan");
  const noKey = text().includes("KEYS:3");
  pane.term.input("\r");
  await waitFor("선택 창 닫힘", () => text().includes("plan mode on"), 3000).catch(() => null);
  check(
    "권한 모드: bypass는 고를 수 없음, 선택 창이 떠 있으면 바꾸지 않고 (키를 보내지 않음) 모드는 그대로 보임",
    bypass === "mode" && whileDialog === "awaiting" && keptMode && noKey && (await records()).length === count,
    `${bypass} ${whileDialog} ${keptMode} ${noKey} ${JSON.stringify(text())}`,
  );
  // bypass를 켤 수 있는 세션(여기서는 작업 폴더의 claude 설정)은 바꾸지 않는다 (리뷰 R1)
  await run(first, `mkdir -p "${root}/.claude" && printf '%s' '{"permissions":{"defaultMode":"bypassPermissions"}}' > "${root}/.claude/settings.local.json"`);
  const bypassable = await set("manual");
  await run(first, `rm -f "${root}/.claude/settings.local.json"; rmdir "${root}/.claude" 2>/dev/null; true`);
  // 바꾸는 중에 선택 창이 뜨면 (모드 줄이 사라짐) 더 누르지 않고 멈춘다 (리뷰 R2): 계획 → 자동에서 선택 창, 수동까지 가지 않음
  pane.term.input("p");
  await sleep(300);
  const toManualAgain = await set("manual");
  const popRecord = await nextRecord(count);
  const popKeys = text().includes("KEYS:4") && text().includes("Enter to confirm");
  pane.term.input("\r");
  const popMode = await modeIs("auto");
  count = (await records()).length;
  check(
    "권한 모드: bypass를 켤 수 있는 세션은 바꾸지 않음, 바꾸는 중 선택 창이 뜨면 더 누르지 않고 화면이 바뀜으로 기록 (리뷰 R1·R2)",
    bypassable === "bypass" && toManualAgain === "ok" && popRecord?.mode?.result === "changed" && popKeys && popMode,
    `${bypassable} ${toManualAgain} ${JSON.stringify(popRecord)} ${popKeys} ${popMode} ${JSON.stringify(text())}`,
  );
  // 모드 줄이 따라오지 않으면 한 번만 누르고 멈춰 실패로 기록
  pane.term.input("s");
  await sleep(300);
  const toPlanStuck = await set("plan");
  const stuckRecord = await nextRecord(count);
  check(
    "권한 모드: Shift+Tab에 모드 줄이 바뀌지 않으면 더 누르지 않고 바꾸지 못함으로 기록",
    toPlanStuck === "ok" && stuckRecord?.mode?.result === "failed" && text().includes("KEYS:5") && text().includes("auto mode on"),
    `${toPlanStuck} ${JSON.stringify(stuckRecord)} ${JSON.stringify(text())}`,
  );

  pane.term.focus();
  await menu("close_pane");
  await waitFor("moder 닫힘", () => paneEls().length === panesBefore, 5000).catch(() => null);
  await menu("close_pane");
  await waitFor("moder 탭 닫힘", () => tabCount() === tabsBefore, 5000).catch(() => null);
  if (panel() && panel()!.style.display !== "none") ws().querySelector<HTMLElement>("[data-action=chat]")!.click();
  await run(first, `rm -f "${root}/moder.py"`);
}

// 채팅 패널 (src/ChatPanel.tsx): 탭 바 버튼으로 연다. 세션이 보낸 메시지와 참여자를 보이고, 참여자를 누르면 멘션을
// 넣고, Enter로 사용자(user)로 보낸다 (한글 조합 Enter는 아님). 닫혀 있는 동안 나에게 온 메시지는 버튼에 점으로 알린다.
// 이때 지금 탭에는 poster(MCP로 "@user hello from poster"를 보냄)가 떠 있다.
async function testChatPanel(root: string, openAdd: (how: "menu" | "tab") => Promise<void>, choose: (id: string) => void) {
  const ws = () => document.querySelector<HTMLElement>(".project-workspace:not([style*='none'])")!;
  const panel = () => ws().querySelector<HTMLElement>(".chat-panel");
  const toggle = () => ws().querySelector<HTMLElement>("[data-action=chat]")!;
  const shown = () => !!panel() && panel()!.style.display !== "none";
  const input = () => panel()!.querySelector<HTMLTextAreaElement>(".chat-input")!;
  const type = (text: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const enter = (keyCode: number) => {
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(ev, "keyCode", { get: () => keyCode });
    input().dispatchEvent(ev);
  };
  const stored = () => invoke<{ from: string; text: string; to: string[] }[]>("chat_messages", { project: root });

  // 창이 앞에 있다고 알린다: 채팅은 실제로 보고 있을 때만 읽은 것으로 친다 (테스트 창은 포커스가 없을 수 있다)
  window.dispatchEvent(new Event("focus"));
  toggle().click();
  await waitFor("채팅 패널", () => shown() && panel()!.querySelector(".chat-msg"), 5000);
  const first = panel()!.querySelector<HTMLElement>(".chat-msg")!;
  const chips = [...panel()!.querySelectorAll<HTMLElement>(".chat-member")].map((el) => el.dataset.member).join(",");
  check(
    "채팅 패널: 탭 바 버튼으로 열고, 세션이 보낸 메시지(나에게)와 참여자를 보임, 입력란에 포커스",
    first.querySelector(".chat-from")?.textContent === "origin/poster" && /^\d\d:\d\d( [AP]M)?$/.test(first.querySelector("time")?.textContent ?? "") && first.classList.contains("to-me") && first.querySelector(".chat-text")?.textContent === "@user hello from poster" &&
      chips === "all,origin/poster,origin/reviewer,origin/writer,origin/writer-2" && document.activeElement === input(),
    `${first.textContent} | ${chips}`,
  );
  // 참여자 칩은 메시지 목록 아래, 입력란 바로 위에 있다 (멘션을 넣는 곳 가까이)
  const chipRow = panel()!.querySelector<HTMLElement>(".chat-members")!;
  const [listBox, chipBox, inputBox] = [panel()!.querySelector(".chat-list")!, chipRow, input()].map((el) => el.getBoundingClientRect());
  check(
    "채팅 패널: 참여자 칩은 입력란 바로 위",
    chipRow.nextElementSibling === input() && listBox.bottom <= chipBox.top && chipBox.bottom <= inputBox.top,
    `${listBox.bottom} ${chipBox.top}-${chipBox.bottom} ${inputBox.top}`,
  );

  panel()!.querySelector<HTMLElement>("[data-member='origin/poster']")!.click();
  await waitFor("멘션 넣기", () => input().value === "@origin/poster ", 2000);
  type(`${input().value}hi poster`);
  const before = (await stored()).length;
  enter(229);
  await sleep(300);
  const notYet = (await stored()).length === before;
  enter(13);
  const sent = await waitAsync("보낸 메시지", async () => (await stored()).find((m) => m.text === "@origin/poster hi poster"), 5000).catch(() => null);
  await waitFor("패널에 보임", () => panel()!.querySelectorAll(".chat-msg.mine").length === 1, 3000).catch(() => null);
  check(
    "채팅 패널: 참여자를 누르면 멘션, Enter로 사용자로 보냄 (한글 조합 Enter는 아님), 입력란 비움",
    notYet && sent?.from === "user" && sent.to.join(",") === "origin/poster" && input().value === "" && panel()!.querySelectorAll(".chat-msg.mine").length === 1,
    `${notYet} ${JSON.stringify(sent)} "${input().value}"`,
  );

  // 보내는 동안 새로 쓴 초안은 응답이 와도 남는다 (리뷰 P2)
  devHooks.chatPostDelay = 1000;
  type("@all slow one");
  enter(13);
  await sleep(100);
  type("next draft");
  await waitAsync("늦게 보낸 메시지", async () => (await stored()).some((m) => m.text === "@all slow one"), 5000).catch(() => null);
  await sleep(200);
  devHooks.chatPostDelay = undefined;
  check("채팅 패널: 보내는 동안 새로 쓴 초안은 남음", input().value === "next draft", input().value);
  // @all은 모두에게
  const slow = (await stored()).find((m) => m.text === "@all slow one");
  const sessions = chips.split(",").filter((c) => c !== "all").join(",");
  check("채팅 패널: @all은 모두에게", slow?.to.join(",") === sessions, `${slow?.to.join(",")} / ${sessions}`);
  // 아무도 멘션하지 않으면 보내지 않고 받는 사람을 고르라고 알린다 (초안은 남음). @all 칩을 누르면 넣어지고 보내진다
  type("");
  const beforeNone = (await stored()).length;
  type("to nobody");
  enter(13);
  const hint = await waitFor("받는 사람 안내", () => panel()!.querySelector(".chat-error")?.textContent?.startsWith("Not sent: choose who gets it"), 3000).then(() => true, () => false);
  const keptDraft = input().value === "to nobody" && (await stored()).length === beforeNone;
  type("");
  panel()!.querySelector<HTMLElement>("[data-member='all']")!.click();
  await waitFor("@all 넣기", () => input().value === "@all ", 2000).catch(() => null);
  const allChip = input().value;
  type(`${input().value}to everyone`);
  enter(13);
  const toAll = await waitAsync("@all 칩으로 보냄", async () => (await stored()).find((m) => m.text === "@all to everyone"), 5000).catch(() => undefined);
  await waitFor("안내 사라짐", () => !panel()!.querySelector(".chat-error"), 2000).catch(() => null);
  check(
    "채팅 패널: 멘션 없으면 보내지 않고 안내·초안 남김, @all 칩으로 모두에게 보내면 안내가 사라짐",
    hint && keptDraft && allChip === "@all " && toAll?.to.join(",") === sessions && !panel()!.querySelector(".chat-error"),
    `${hint} ${keptDraft} "${allChip}" ${JSON.stringify(toAll?.to)} ${panel()!.querySelector(".chat-error")?.textContent}`,
  );
  type("");

  // 닫으면 선택된 터미널로 포커스가 돌아간다 (리뷰 P2: 숨은 입력란에 남았다)
  const terminalFocused = () => !!document.activeElement?.classList.contains("xterm-helper-textarea") && !!ws().querySelector(".tab-body:not([style*='none'])")?.contains(document.activeElement);
  input().focus();
  panel()!.querySelector<HTMLElement>(".chat-close")!.click();
  await waitFor("채팅 닫기", () => !shown(), 2000);
  await waitFor("터미널 포커스", terminalFocused, 2000).catch(() => null);
  check("채팅 패널: × 로 닫으면 터미널로 포커스", terminalFocused(), document.activeElement?.className ?? "");

  // 닫아 두고 새 poster를 더하면 그 poster가 "@user ..."를 보낸다 → 버튼에 점, 열면 사라짐.
  // 알림 (src-tauri/src/notify.rs, 자체 테스트는 보내지 않고 기록): 세션이 사용자에게 보낸 메시지는 알리고, 사이드바 프로젝트와
  // Dock에 안 읽은 수. 창이 앞에 있고 그 프로젝트의 채팅 패널을 보고 있으면 알리지 않는다.
  const notes = () => invoke<[[string, string][], number]>("selftest_notifications");
  const unreadBadge = () => document.querySelector<HTMLElement>(`.project-row[data-project="${CSS.escape(root)}"] .project-unread`);
  await invoke("selftest_set_focused", { focused: false });
  await notes();
  await openAdd("menu");
  choose("pick/poster");
  await waitFor("나에게 온 메시지 표시", () => toggle().classList.contains("unread"), 10000).then(
    () => check("채팅 패널: 닫혀 있는 동안 나에게 온 메시지는 버튼에 점", true),
    () => check("채팅 패널: 닫혀 있는 동안 나에게 온 메시지는 버튼에 점", false, toggle().className),
  );
  await waitFor("사이드바 배지", unreadBadge, 3000).catch(() => null);
  // 기록은 가져가면 비워지므로 모아 가며 기다린다
  const noted: [string, string][] = [];
  let dock = 0;
  await waitAsync("알림 기록", async () => {
    const [n, d] = await notes();
    noted.push(...n);
    dock = d;
    return noted.length > 0 && dock === 1;
  }, 3000).catch(() => null);
  const projectName = root.split("/").pop();
  check(
    "알림: 세션이 사용자에게 보낸 메시지는 알림 (제목 ddak · 프로젝트, 본문 보낸 사람: 첫 줄), 사이드바·Dock 배지",
    noted.length === 1 && noted[0][0] === `ddak · ${projectName}` && /^origin\/poster-\d: @user hello from poster$/.test(noted[0][1]) && unreadBadge()?.dataset.unread === "1" && dock === 1,
    `${JSON.stringify(noted)} ${unreadBadge()?.dataset.unread} ${dock}`,
  );
  // 창이 앞에 있다고 알린다 (테스트 창은 포커스가 없을 수 있다. 채팅은 실제로 보고 있을 때만 읽은 것으로 친다)
  window.dispatchEvent(new Event("focus"));
  toggle().click();
  await waitFor("다시 열기", shown, 2000);
  check("채팅 패널: 열면 점이 사라짐", !toggle().classList.contains("unread"), toggle().className);
  await sleep(300);
  const [, badgeAfter] = await notes();
  check("알림: 채팅을 열면 사이드바·Dock 배지가 사라짐", !unreadBadge() && badgeAfter === 0, `${unreadBadge()?.dataset.unread} ${badgeAfter}`);
  // 닫기는 비동기라 창이 실제로 줄 때까지 기다린다 (뒤 검사가 창 수를 센다)
  const closeAdded = async () => {
    const n = paneEls().length;
    await menu("close_pane");
    await waitFor("더한 창 닫기", () => paneEls().length === n - 1, 5000);
  };
  // 실제로 보고 있을 때만 읽은 것으로 친다 (리뷰 R2): 채팅을 열어 둔 채 창이 뒤로 가거나 다른 프로젝트로 가면 배지에 센다
  window.dispatchEvent(new Event("blur"));
  const beforeBlur = (await stored()).length;
  await openAdd("menu");
  choose("pick/poster");
  await waitAsync("뒤에 있을 때 온 메시지", async () => (await stored()).length > beforeBlur, 10000).catch(() => null);
  const blurBadge = await waitFor("뒤에 있을 때 배지", () => unreadBadge()?.dataset.unread === "1", 3000).then(() => true, () => false);
  window.dispatchEvent(new Event("focus"));
  const focusCleared = await waitFor("앞으로 오면 지움", () => !unreadBadge(), 3000).then(() => true, () => false);
  await closeAdded();
  const other = root.replace(/\/proj$/, "/other");
  await openAdd("menu");
  choose("pick/lateposter");
  await devHooks.addProject!(other);
  const awayBadge = await waitFor("다른 프로젝트에 있을 때 배지", () => unreadBadge()?.dataset.unread === "1", 10000).then(() => true, () => false);
  projectRow(root)!.click();
  const backCleared = await waitFor("돌아오면 지움", () => !unreadBadge(), 3000).then(() => true, () => false);
  const confirmBefore = devHooks.confirm;
  devHooks.confirm = async () => true;
  projectRow(other)!.querySelector<HTMLElement>("[data-action=remove]")!.click();
  await waitFor("다른 프로젝트 빼기", () => !projectRow(other), 3000);
  devHooks.confirm = confirmBefore;
  await waitFor("돌아온 프로젝트", () => document.querySelector(".project-workspace:not([style*='none'])")?.getAttribute("data-project") === root, 3000);
  await closeAdded();
  check(
    "알림: 채팅을 열어 둬도 창이 뒤에 있거나 다른 프로젝트에 있으면 배지에 세고, 보게 되면 지움",
    blurBadge && focusCleared && awayBadge && backCleared,
    `${blurBadge} ${focusCleared} ${awayBadge} ${backCleared}`,
  );
  // 창이 앞에 있고 이 프로젝트의 채팅 패널을 보고 있으면 알리지 않는다. 사용자를 기다린다는 신호({attention})는 알린다
  // (그 프로젝트를 보고 있지 않을 때)
  await notes(); // 앞 검사의 알림은 비운다
  await invoke("selftest_set_focused", { focused: true });
  const beforeQuiet = (await stored()).length;
  await openAdd("menu");
  choose("pick/poster");
  await waitAsync("보고 있을 때 온 메시지", async () => (await stored()).length > beforeQuiet, 10000).catch(() => null);
  await sleep(300);
  const [quiet] = await notes();
  await closeAdded();
  await invoke("selftest_set_focused", { focused: false });
  await openAdd("menu");
  choose("pick/attn");
  const attention = await waitAsync("권한 확인 알림", async () => {
    const [n] = await notes();
    return n.find(([, body]) => /^origin\/attn(-\d)? is waiting for your permission$/.test(body));
  }, 10000).catch(() => null);
  await closeAdded();
  check("알림: 보고 있으면 알리지 않음, 사용자를 기다린다는 신호({attention})는 알림", quiet.length === 0 && !!attention, `${JSON.stringify(quiet)} ${JSON.stringify(attention)}`);
  // 프로그램 상태로 기다림을 알리면 알림 (claude·codex 모두). 그 뒤 온 훅 신호는 이미 알린 것이라 건너뛴다
  await openAdd("menu");
  choose("pick/asker");
  const asked: [string, string][] = [];
  await waitAsync("상태로 온 알림", async () => (asked.push(...(await notes())[0]), asked.some(([, b]) => /^origin\/asker(-\d)? is waiting for your answer$/.test(b))), 10000).catch(() => null);
  await sleep(2500); // 훅 신호(1초 뒤)가 오고 처리될 때까지
  asked.push(...(await notes())[0]);
  // 알림을 누르면 그 세션의 탭과 창으로 (src-tauri/src/notify.rs clicked → Terminal onReveal): 새 탭으로 옮겨 갔다가 누른다
  const wsTabs = () => [...document.querySelectorAll<HTMLElement>(".project-workspace:not([style*='none']) .tab")];
  const askerPane = () => paneEls().find((el) => el.querySelector(".pane-label")?.firstChild?.textContent?.startsWith("asker"));
  const tabAt = activeTabIndex();
  const tabsBefore = wsTabs().length;
  await menu("new_tab");
  await waitFor("새 탭", () => wsTabs().length === tabsBefore + 1 && !askerPane(), 5000).catch(() => null);
  // 새 탭은 지금 탭 바로 뒤에 생긴다
  const newAt = activeTabIndex();
  const clickedOk = await invoke<boolean>("selftest_click_notification", { prefix: "origin/asker" });
  const revealed = await waitFor("알림 누름", () => activeTabIndex() === tabAt && askerPane()?.classList.contains("focused"), 3000).then(() => true, () => false);
  check("알림: 누르면 그 세션의 탭으로 가서 그 창을 고름", clickedOk && revealed, `${clickedOk} tab=${activeTabIndex()}/${tabAt} focused=${askerPane()?.className}`);
  // 누르면 창을 앞으로 가져와 "창이 앞에 있음"이 켜진다. 뒤 검사는 다른 앱을 보는 중이어야 알림이 나온다
  await invoke("selftest_set_focused", { focused: false });
  // 새 탭을 그 탭의 ×로 닫는다 (탭은 포인터를 누를 때 골라져서 click()으로는 고르지 못한다). 지금 탭은 그대로
  wsTabs()[newAt]?.querySelector<HTMLElement>(".tab-close")?.click();
  await waitFor("새 탭 닫힘", () => wsTabs().length === tabsBefore && activeTabIndex() === tabAt, 5000).catch(() => null);
  check("알림 누르기 검사 뒤 정리: 새 탭 닫힘, 원래 탭", wsTabs().length === tabsBefore && activeTabIndex() === tabAt && !!askerPane()?.classList.contains("focused"), `${wsTabs().length}/${tabsBefore} ${activeTabIndex()}/${tabAt}`);
  await closeAdded();
  // 터미널이 없는 알림(세션이 사용자에게 보낸 메시지)을 누르면 그 프로젝트의 채팅 패널을 연다
  const wasShown = shown();
  if (wasShown) toggle().click();
  await waitFor("채팅 닫기", () => !shown(), 2000).catch(() => null);
  const chatClicked = await invoke<boolean>("selftest_click_notification", { prefix: "origin/poster" });
  const chatOpened = await waitFor("채팅 열림", shown, 3000).then(() => true, () => false);
  check("알림: 메시지 알림을 누르면 채팅 패널을 엶", chatClicked && chatOpened, `${chatClicked} ${chatOpened}`);
  await invoke("selftest_set_focused", { focused: false });
  if (!wasShown) toggle().click();
  await waitFor("채팅 원래대로", () => shown() === wasShown, 2000).catch(() => null);
  const askerNotes = asked.filter(([, b]) => b.startsWith("origin/asker"));
  check("알림: 프로그램 상태로 기다림을 알리면 알림, 뒤따른 훅 신호는 한 번 더 알리지 않음", askerNotes.length === 1 && /is waiting for your answer$/.test(askerNotes[0][1]), JSON.stringify(askerNotes));
  // 훅이 먼저 와도 한 번 (리뷰 R3)
  await openAdd("menu");
  choose("pick/hookfirst");
  const hooked: [string, string][] = [];
  await waitAsync("훅으로 온 알림", async () => (hooked.push(...(await notes())[0]), hooked.some(([, b]) => b.startsWith("origin/hookfirst"))), 10000).catch(() => null);
  await sleep(2500); // 상태(1초 뒤)가 오고 처리될 때까지
  hooked.push(...(await notes())[0]);
  await closeAdded();
  const hookNotes = hooked.filter(([, b]) => b.startsWith("origin/hookfirst"));
  check("알림: 훅 신호가 먼저 오고 상태가 뒤에 와도 한 번", hookNotes.length === 1 && /is waiting for your permission$/.test(hookNotes[0][1]), JSON.stringify(hookNotes));
  // 답한 뒤 새로 뜬 대기는 10초 안이어도 또 알린다 (리뷰 R4)
  await openAdd("menu");
  choose("pick/twice");
  const twiced: [string, string][] = [];
  await waitAsync("두 번째 대기 알림", async () => (twiced.push(...(await notes())[0]), twiced.filter(([, b]) => b.startsWith("origin/twice")).length >= 2), 10000).catch(() => null);
  await sleep(500);
  twiced.push(...(await notes())[0]);
  await closeAdded();
  const twiceNotes = twiced.filter(([, b]) => b.startsWith("origin/twice")).map(([, b]) => b.replace(/^origin\/twice(-\d)? /, ""));
  check("알림: 답한 뒤 새로 뜬 대기는 또 알림 (답변 → 권한 확인)", twiceNotes.join("|") === "is waiting for your answer|is waiting for your permission", JSON.stringify(twiceNotes));

  // 늦게 온 이전 참여자 응답이 최신 목록을 되돌리지 않는다 (리뷰 P2): 들어올 때의 첫 읽기를 늦추고 바로 닫는다
  let calls = 0;
  devHooks.chatMembersDelay = () => (calls++ === 0 ? 1500 : 0);
  const panes = paneEls().length;
  await openAdd("menu");
  choose("pick/reviewer");
  await waitFor("잠깐 더한 창", () => paneEls().length === panes + 1, 5000);
  await menu("close_pane");
  await waitFor("잠깐 더한 창 닫기", () => paneEls().length === panes, 5000);
  await sleep(2500);
  devHooks.chatMembersDelay = undefined;
  const after = [...panel()!.querySelectorAll<HTMLElement>(".chat-member")].map((el) => el.dataset.member);
  check("채팅 패널: 늦게 온 이전 참여자 응답이 최신 목록을 되돌리지 않음", calls >= 2 && !after.includes("origin/reviewer-2"), `${calls} ${after.join(",")}`);

  input().focus();
  toggle().click();
  await waitFor("닫기", () => !shown(), 2000);
  await waitFor("터미널 포커스", terminalFocused, 2000).catch(() => null);
  check("채팅 패널: 버튼으로 닫아도 터미널로 포커스", terminalFocused(), document.activeElement?.className ?? "");

  // 깨우기: 멘션된 세션의 터미널에 알림을 입력하고 Enter. 한 번도 치지 않은 창은 바로, 초안이 있으면 배지만 띄우고
  // 기다렸다가, 배지를 누르면 바로 깨운다.
  await openAdd("menu");
  choose("pick/listener");
  const listenerPane = await waitFor("listener 창", () => visiblePanes().find((p) => p.el.querySelector(".pane-label")?.firstChild?.textContent === "listener"), 5000);
  await sleep(1000);
  const got = () => screen(listenerPane.term).filter((l) => l.startsWith("GOT:"));
  await invoke("chat_post", { project: root, text: "@origin/listener hello" });
  const woke = await waitFor("깨운 알림", () => got().find((l) => l.includes("New chat message from user")), 6000).catch(() => null);
  check(
    "깨우기: 멘션된 세션의 터미널에 알림을 입력하고 Enter (한 번도 치지 않은 창은 바로)",
    !!woke && woke.startsWith("GOT:[ddak] New chat message from user. Read it with the ddak read_messages tool"),
    woke ?? got().join("|"),
  );
  // Enter를 친 직후 프로그램이 질의해 온 응답은 입력 중으로 보지 않는다: 다음 멘션은 조용해지면 (누르지 않아도) 깨운다
  const enterTyped = typeKeys(listenerPane.term, "hi\r");
  await waitFor("친 줄", () => got().some((l) => l === "GOT:hi"), 3000).catch(() => null);
  await sleep(500);
  const beforeEnter = got().length;
  await invoke("chat_post", { project: root, text: "@origin/listener after enter" });
  const afterEnter = await waitFor("Enter 뒤 깨움", () => got().length > beforeEnter && got().at(-1)!.includes("[ddak] New chat message from user"), WAKE_IDLE_MS + 4000).catch(() => null);
  check("깨우기: Enter 직후 온 터미널 응답(ESC[0n, ESC[?…R)은 입력 중으로 보지 않음", enterTyped === "hi\r" && !!afterEnter, `${JSON.stringify(enterTyped)} ${got().slice(-2).join(" | ")}`);

  // 치는 중이면 배지를 띄우고 기다린다. 누르면 3초를 기다리지 않고 바로 깨운다
  const typed = typeKeys(listenerPane.term, "abc");
  const typedAt = performance.now();
  const beforeDraft = got().length;
  await invoke("chat_post", { project: root, text: "@origin/listener again" });
  const badge = () => listenerPane.el.querySelector<HTMLElement>("[data-wake]");
  await waitFor("알림 대기 배지", badge, 2000).catch(() => null);
  const waited = !!badge() && got().length === beforeDraft;
  badge()?.click();
  const forced = await waitFor("바로 깨움", () => got().find((l) => l.startsWith("GOT:abc[ddak] New chat message")), 5000).catch(() => null);
  const forcedIn = performance.now() - typedAt;
  await waitFor("배지 사라짐", () => !badge(), 3000).catch(() => null);
  check(
    "깨우기: 치는 중이면 배지만 띄우고 기다림, 누르면 바로 깨우고 배지가 사라짐",
    typed === "abc" && waited && !!forced && forcedIn < WAKE_IDLE_MS && !badge(),
    `${JSON.stringify(typed)} ${waited} ${forced} ${Math.round(forcedIn)}ms ${!!badge()} | ${got().join(" | ")}`,
  );

  // 쓰다 남긴 초안(마지막 키가 Enter가 아님)이 있어도 3초 동안 입력이 없으면 스스로 깨운다 (쓰다가 지운 창도 영원히
  // 기다리지 않게). 알림은 초안 뒤에 붙는다
  const left = typeKeys(listenerPane.term, "ghi");
  const leftAt = performance.now();
  await invoke("chat_post", { project: root, text: "@origin/listener left draft" });
  await sleep(1000);
  const heldWhileTyping = got().every((l) => !l.startsWith("GOT:ghi"));
  const selfWoke = await waitFor("남긴 초안 뒤 깨움", () => got().find((l) => l.startsWith("GOT:ghi[ddak] New chat message")), WAKE_IDLE_MS + 4000).catch(() => null);
  const selfIn = performance.now() - leftAt;
  check(
    "깨우기: 남긴 초안이 있어도 3초 동안 입력이 없으면 스스로 깨움",
    left === "ghi" && heldWhileTyping && !!selfWoke && selfIn >= WAKE_IDLE_MS - 300,
    `${heldWhileTyping} ${selfWoke} ${Math.round(selfIn)}ms`,
  );

  // 채팅 패널에도 대기를 보인다 (참여자 칩 옆 "대기"). 누르면 바로 깨우고 표시가 사라진다
  const waitingMark = () => panel()!.querySelector<HTMLElement>("[data-waiting='origin/listener']");
  const typedAgain = typeKeys(listenerPane.term, "def");
  const typedAgainAt = performance.now();
  const beforePanel = got().length;
  await invoke("chat_post", { project: root, text: "@origin/listener from panel" });
  await waitFor("패널 대기 표시", waitingMark, 2000).catch(() => null);
  const marked = !!waitingMark() && !!panel()!.querySelector(".chat-member.waiting[data-member='origin/listener']") && got().length === beforePanel;
  waitingMark()?.click();
  const fromPanel = await waitFor("패널에서 바로 깨움", () => got().find((l) => l.startsWith("GOT:def[ddak] New chat message")), 5000).catch(() => null);
  const fromPanelIn = performance.now() - typedAgainAt;
  await waitFor("패널 대기 표시 사라짐", () => !waitingMark(), 3000).catch(() => null);
  check(
    "채팅 패널: 깨우기를 기다리는 참여자는 칩 옆에 대기 표시, 누르면 바로 깨우고 사라짐",
    typedAgain === "def" && marked && !!fromPanel && fromPanelIn < WAKE_IDLE_MS && !waitingMark(),
    `${marked} ${fromPanel} ${Math.round(fromPanelIn)}ms ${!!waitingMark()}`,
  );

  // 세션 창의 이름 줄은 터미널 화면과 구분된다: 다른 배경, 아래 경계선, 터미널보다 위
  const label = listenerPane.el.querySelector<HTMLElement>(".pane-label")!;
  const labelStyle = getComputedStyle(label);
  const termBg = getComputedStyle(listenerPane.el.querySelector<HTMLElement>(".xterm-viewport") ?? listenerPane.el).backgroundColor;
  const termTop = listenerPane.el.querySelector(".terminal")!.getBoundingClientRect().top;
  check(
    "세션 창: 이름 줄은 터미널과 다른 배경·아래 경계선으로 구분",
    labelStyle.backgroundColor !== termBg && labelStyle.borderBottomWidth === "1px" && label.getBoundingClientRect().bottom <= termTop,
    `${labelStyle.backgroundColor} / ${termBg} ${labelStyle.borderBottomWidth} ${label.getBoundingClientRect().bottom} ${termTop}`,
  );

  // 변경 번호가 더 오래된 상태는 버린다 (리뷰 P2: 앞 깨우기의 해제가 새 대기를 지웠다). 순서가 바뀐 이벤트를 직접 보낸다.
  const pty = Number(listenerPane.el.querySelector<HTMLElement>(".terminal")!.dataset.pty);
  const big = 1e12;
  await emit("chat-wake", { pty, pending: true, seq: big });
  await waitFor("대기 배지", badge, 2000).catch(() => null);
  await emit("chat-wake", { pty, pending: false, seq: big - 1 });
  await sleep(300);
  const kept = !!badge();
  await emit("chat-wake", { pty, pending: false, seq: big + 1 });
  await waitFor("배지 사라짐", () => !badge(), 2000).catch(() => null);
  check("깨우기: 늦게 온 이전 해제가 새 대기 배지를 지우지 않음", kept && !badge(), `${kept} ${!!badge()}`);

  // 터미널은 깨우기 이벤트 등록이 끝난 뒤에 뜬다 (리뷰 P2: 등록 전에 온 대기 상태를 놓쳤다)
  devHooks.wakeListenDelay = 1500;
  const existing = new Set(visiblePanes().map((p) => p.term));
  const t0 = performance.now();
  await openAdd("menu");
  choose("pick/listener");
  const spawned = await waitFor("늦게 등록한 터미널", () => visiblePanes().find((p) => !existing.has(p.term) && p.el.querySelector<HTMLElement>(".terminal")?.dataset.pty), 8000).catch(() => null);
  const elapsed = performance.now() - t0;
  devHooks.wakeListenDelay = undefined;
  check("깨우기: 터미널은 깨우기 이벤트 등록이 끝난 뒤에 뜸", !!spawned && elapsed >= 1400, `${Math.round(elapsed)}ms`);
  await menu("close_pane");

  // 자동 깨우기 제한: 같은 작업그룹의 세션끼리 사용자 없이 6개를 주고받으면 7번째부터는 저장만 하고 깨우지 않는다.
  // 패널에 멈춤과 재개 버튼, 깨우지 않은 메시지 표시. 보낸 세션은 도구 결과로 안다. 재개하면 받는 사람을 한 번 깨운다.
  const fromChatter = () => got().filter((l) => l.includes("New chat message from origin/chatter")).length;
  const pausedBar = () => panel()!.querySelector<HTMLElement>("[data-paused='origin']");
  await openAdd("menu");
  choose("pick/chatter");
  const chatterPane = await waitFor("chatter 창", () => visiblePanes().find((p) => p.el.querySelector(".pane-label")?.firstChild?.textContent === "chatter"), 5000);
  const pings = async () => (await stored()).filter((m) => m.from === "origin/chatter") as { held?: boolean }[];
  await waitAsync("chatter 메시지 7개", async () => (await pings()).length === 7, 10000).catch(() => null);
  const sent7 = await pings();
  const pausedNote = (await invoke<[[string, string][], number]>("selftest_notifications"))[0].find(([, b]) => b.startsWith("origin: sessions exchanged 6 messages"));
  await waitFor("멈춤 표시", pausedBar, 3000).catch(() => null);
  await waitFor("허용된 알림", () => fromChatter() > 0, WAKE_IDLE_MS + 4000).catch(() => null);
  await sleep(WAKE_IDLE_MS + 1000);
  const beforeResume = fromChatter();
  const toldChatter = screen(chatterPane.term).some((l) => l.includes("nobody was notified: automatic notifications for your work group are paused"));
  // 깨우지 않음 표시는 7번째 메시지에만
  const heldTag = panel()!.querySelectorAll(".chat-msg [data-held]").length === 1 && !!panel()!.querySelector(".chat-msg:last-of-type [data-held]");
  check(
    "깨우기 제한: 세션끼리 6개까지 깨우고 7번째는 저장만 (보낸 세션에 알림, 패널에 멈춤·깨우지 않음 표시)",
    sent7.length === 7 && sent7.filter((m) => m.held).length === 1 && !!sent7[6].held && beforeResume > 0 && toldChatter && heldTag && !!pausedBar() && !!pausedNote,
    `${sent7.map((m) => !!m.held).join(",")} told=${toldChatter} tag=${heldTag} bar=${!!pausedBar()} wakes=${beforeResume} note=${JSON.stringify(pausedNote)}`,
  );
  pausedBar()?.querySelector("button")?.click();
  const resumed = await waitFor("재개 뒤 깨움", () => fromChatter() === beforeResume + 1, WAKE_IDLE_MS + 4000).then(() => true, () => false);
  await sleep(1000);
  check(
    "깨우기 제한: 재개하면 멈춤 표시가 사라지고 보류된 알림을 받는 사람에게 한 번 알림",
    resumed && fromChatter() === beforeResume + 1 && !pausedBar(),
    `${beforeResume}→${fromChatter()} bar=${!!pausedBar()}`,
  );

  // 사용자가 그 작업그룹 세션의 터미널에 입력해도 다시 센다 (재개와 같다): chatter를 한 번 더 띄워 멈춘 뒤 listener 창에 친다
  await openAdd("menu");
  choose("pick/chatter");
  const pausedAgain = await waitFor("다시 멈춤", pausedBar, 10000).then(() => true, () => false);
  const typedIn = typeKeys(listenerPane.term, "abc");
  const unpaused = await waitFor("입력으로 풀림", () => !pausedBar(), 3000).then(() => true, () => false);
  typeKeys(listenerPane.term, "\x15");
  const backendPaused = await invoke<string[]>("chat_paused", { project: root });
  const listenerPty = listenerPane.el.querySelector<HTMLElement>(".terminal")!.dataset.pty;
  check("깨우기 제한: 그 작업그룹 세션의 터미널에 사용자가 입력하면 다시 센다", pausedAgain && typedIn === "abc" && unpaused, `${pausedAgain} ${JSON.stringify(typedIn)} ${unpaused} backend=${backendPaused} pty=${listenerPty}`);

  // 멈춘 작업그룹이 많아도 알림 목록은 높이가 정해진 스크롤 영역이고, 참여자 칩과 입력란은 패널 안에 남는다 (리뷰 2단계 R2)
  devHooks.chatPausedExtra = Array.from({ length: 12 }, (_, i) => `group-${i + 1}`);
  toggle().click();
  await waitFor("채팅 열기", shown, 2000);
  await emit("chat-limit", { project: root });
  const pausedList = await waitFor("멈춘 그룹 12개", () => panel()!.querySelectorAll("[data-paused]").length === 12 && panel()!.querySelector<HTMLElement>(".chat-paused-list"), 3000).catch(() => null);
  const panelBox = panel()!.getBoundingClientRect();
  const inputRect = input().getBoundingClientRect();
  const chipsBox = panel()!.querySelector(".chat-members")!.getBoundingClientRect();
  check(
    "깨우기 제한: 멈춘 그룹이 많아도 알림은 스크롤 영역, 칩과 입력란은 패널 안에 보임",
    !!pausedList && pausedList.scrollHeight > pausedList.clientHeight && pausedList.clientHeight <= 104 && inputRect.height >= 40 && inputRect.bottom <= panelBox.bottom && chipsBox.top >= pausedList.getBoundingClientRect().bottom - 1,
    `${pausedList?.clientHeight}/${pausedList?.scrollHeight} input=${Math.round(inputRect.top)}-${Math.round(inputRect.bottom)} panel=${Math.round(panelBox.bottom)} chips=${Math.round(chipsBox.top)}`,
  );
  devHooks.chatPausedExtra = undefined;
  await emit("chat-limit", { project: root });
  await waitFor("가짜 멈춤 지움", () => !panel()!.querySelector("[data-paused]"), 3000).catch(() => null);

  // 대화 지우기: 확인을 받고 모두 지운다 (취소하면 그대로). 번호는 이어서 매긴다 (세션이 읽은 위치를 번호로 기억한다)
  const all = () => invoke<{ id: number }[]>("chat_messages", { project: root });
  const maxId = Math.max(...(await all()).map((m) => m.id));
  const clearBtn = () => panel()!.querySelector<HTMLButtonElement>("[data-action=chat-clear]")!;
  const realConfirm = devHooks.confirm;
  devHooks.confirm = async () => false;
  clearBtn().click();
  await sleep(300);
  const keptAll = (await all()).length > 0 && panel()!.querySelectorAll(".chat-msg").length > 0;
  devHooks.confirm = async () => true;
  clearBtn().click();
  const emptied = await waitFor("대화 지움", () => panel()!.querySelectorAll(".chat-msg").length === 0 && clearBtn().disabled, 3000).then(() => true, () => false);
  devHooks.confirm = realConfirm;
  const next = await invoke<{ id: number }>("chat_post", { project: root, text: "@origin/listener after clear" });
  const shownAgain = await waitFor("지운 뒤 새 메시지", () => panel()!.querySelectorAll(".chat-msg").length === 1, 3000).then(() => true, () => false);
  check(
    "대화 지우기: 취소하면 그대로, 확인하면 모두 지우고 (버튼 끔), 번호는 이어서",
    keptAll && emptied && next.id === maxId + 1 && shownAgain,
    `${keptAll} ${emptied} ${maxId}→${next.id} ${shownAgain}`,
  );

  toggle().click();
  await waitFor("채팅 닫기", () => !shown(), 2000);
  await menu("close_pane");
}

// Git Graph 탭 (src/GitGraph.tsx): 프로젝트마다 하나. 저장소를 골라 커밋 그래프를 보인다. 참조·HEAD와 작업그룹(터미널 탭의
// 이름·세션)을 커밋에 붙이고, 참조가 바뀌면 다시 읽고, 커밋을 누르면 메시지와 바뀐 파일을 보인다. 채팅과 함께 쓴다.
async function testGitGraph(root: string, first: Terminal) {
  const ws = () => document.querySelector<HTMLElement>(".project-workspace:not([style*='none'])")!;
  const gitBtn = () => ws().querySelector<HTMLElement>("[data-action=git]")!;
  const view = () => ws().querySelector<HTMLElement>(".tab-body:not([style*='none']) .git-graph");
  const rows = () => [...(view()?.querySelectorAll<HTMLElement>(".git-row") ?? [])];
  const row = (subject: string) => rows().find((r) => r.querySelector(".git-subject")?.lastChild?.textContent === subject);
  const chips = (r: HTMLElement | undefined, kind: string) => [...(r?.querySelectorAll<HTMLElement>(`.git-ref.${kind}`) ?? [])].map((c) => c.textContent);
  const before = tabCount();
  // 그래프 첫 읽기만 실패시킨다: 다음 확인(3초) 때 다시 읽어야 한다 (리뷰 P2)
  let graphCalls = 0;
  devHooks.gitGraphFail = () => graphCalls++ === 0;
  gitBtn().click();
  await waitFor("Git Graph 탭", () => view() && tabCount() === before + 1, 5000);
  const retried = await waitFor("실패 뒤 다시 읽기", () => rows().length > 0 && !view()!.querySelector(".git-error"), 8000).then(() => true, () => false);
  devHooks.gitGraphFail = undefined;
  check("Git Graph: 그래프 읽기가 한 번 실패해도 다음 확인 때 다시 읽음", retried && graphCalls >= 2, `${retried} ${graphCalls}`);
  // 지문 조회가 한 번 실패하면 오류를 보이고, 다음 조회가 성공하면 (지문이 같아도) 지운다 (리뷰 후속 P3)
  let printCalls = 0;
  devHooks.gitFingerprintFail = () => printCalls++ === 0;
  const shown = await waitFor("지문 오류", () => view()!.querySelector(".git-error"), 5000).then(() => true, () => false);
  const cleared = await waitFor("오류 지움", () => !view()!.querySelector(".git-error") && printCalls >= 2, 5000).then(() => true, () => false);
  devHooks.gitFingerprintFail = undefined;
  check("Git Graph: 지문 조회 오류는 다음 조회가 성공하면 지움", shown && cleared && rows().length > 0, `${shown} ${cleared} ${printCalls}`);
  gitBtn().click();
  await clickMenu("View", "Git Graph");
  await sleep(300);
  const splitOff = [...ws().querySelectorAll<HTMLButtonElement>(".tabbar-btn")].filter((b) => b.disabled).length === 2;
  check(
    "Git Graph: 탭 바 버튼·보기 메뉴로 열고, 프로젝트마다 하나 (다시 누르면 그 탭), 분할은 끔",
    tabCount() === before + 1 && activeTabEl()?.querySelector(".tab-title")?.textContent === "Git Graph" && splitOff,
    `${tabCount()} ${activeTabEl()?.textContent} ${splitOff}`,
  );

  const repos = await invoke<{ name: string }[]>("git_repos", { project: root });
  const select = () => view()!.querySelector<HTMLSelectElement>("select")!;
  await waitFor("저장소 목록", () => select().options.length === repos.length && repos.length > 0, 5000);
  check("Git Graph: 프로젝트의 저장소를 고를 수 있음", [...select().options].map((o) => o.value).join(",") === repos.map((r) => r.name).join(","), [...select().options].map((o) => o.value).join(","));
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select(), "server");
  select().dispatchEvent(new Event("change", { bubbles: true }));
  const kept = await waitFor("그래프", () => row("end-test"), 8000).catch(() => undefined);
  // 작업그룹 끝내기가 남긴 병합 안 된 브랜치 (번호는 남은 작업그룹을 다시 쓰는지에 따라 달라서 git으로 찾는다)
  const keptBranch = (await run(first, `git --no-pager -C "${root}/server" branch --no-merged HEAD --list 'ddak/test-*' --format='%(refname:short)'`)).map((l) => l.trim()).find((l) => l.startsWith("ddak/"));
  const headRow = rows().find((r) => r.querySelector(".git-ref.head"));
  check(
    "Git Graph: 커밋과 참조(브랜치·HEAD), 원본 탭(작업그룹)과 세션을 HEAD 커밋에 표시",
    !!keptBranch && chips(kept, "branch").includes(keptBranch) && !!headRow && chips(headRow, "group").some((g) => g?.startsWith("Test · shell")),
    `${keptBranch} ${chips(kept, "branch")} | ${chips(headRow, "group")}`,
  );

  // 원본에 커밋하면 다시 읽는다 (참조가 바뀜)
  await run(first, `git -C "${root}/server" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m graph-live`);
  const live = await waitFor("새 커밋", () => row("graph-live"), 8000).catch(() => undefined);
  check("Git Graph: 참조가 바뀌면 다시 읽어 새 커밋을 보임 (HEAD)", !!live && chips(live, "head").length === 1, rows()[0]?.textContent ?? "");

  // 커밋하지 않은 변경: 맨 위 행에 수(참조가 그대로여도 몇 초 안에), 누르면 바뀐 파일, 커밋을 고르면 그 상세로, 없어지면 행도 없음
  const uncommitted = () => view()!.querySelector<HTMLElement>(".git-uncommitted");
  const cleanAtFirst = !uncommitted();
  await run(first, `cd "${root}/server" && echo u > graph-new.txt && echo m >> "$(git ls-files | head -1)"; cd - >/dev/null`);
  const dirty = await waitFor("커밋하지 않은 변경 행", () => uncommitted()?.dataset.uncommitted === "2" && uncommitted(), 3000 + 5000).catch(() => null);
  const firstRow = view()!.querySelector(".git-list")?.querySelector(".git-row") === dirty;
  dirty?.click();
  const changedFiles = () => [...view()!.querySelectorAll<HTMLElement>(".git-detail[data-detail=uncommitted] .git-file")].map((f) => `${f.querySelector(".git-status")?.textContent}${f.dataset.file === "graph-new.txt" ? ":new" : ""}`).sort().join(",");
  const listed = await waitFor("바뀐 파일", () => changedFiles() === "M,U:new" && changedFiles(), 2000).catch(() => changedFiles());
  row("graph-live")?.click();
  const switched = await waitFor("커밋 상세로", () => !view()!.querySelector(".git-detail[data-detail=uncommitted]") && view()!.querySelector(".git-detail .git-message")?.textContent === "graph-live", 3000).then(() => true, () => false);
  row("graph-live")?.click();
  await run(first, `cd "${root}/server" && rm graph-new.txt && git checkout -q -- . ; cd - >/dev/null`);
  const gone = await waitFor("변경 없어짐", () => !uncommitted(), 3000 + 5000).then(() => true, () => false);
  // 조회가 폴링 주기(3초)보다 오래 걸려도 응답을 반영한다 (겹친 요청이 서로를 버리지 않게. 리뷰 R1)
  devHooks.gitStatusDelay = () => 4000;
  await run(first, `cd "${root}/server" && echo u > graph-slow.txt; cd - >/dev/null`);
  const slow = await waitFor("느린 조회", () => uncommitted()?.dataset.uncommitted === "1", 4000 + 3000 + 4000 + 3000).then(() => true, () => false);
  devHooks.gitStatusDelay = undefined;
  await run(first, `rm "${root}/server/graph-slow.txt"`);
  const slowGone = await waitFor("느린 조회 뒤 없어짐", () => !uncommitted(), 4000 + 3000 + 5000).then(() => true, () => false);
  check("Git Graph: 커밋하지 않은 변경 조회가 폴링 주기보다 오래 걸려도 반영됨", slow && slowGone, `${slow} ${slowGone} ${uncommitted()?.dataset.uncommitted}`);
  check(
    "Git Graph: 커밋하지 않은 변경은 맨 위 행에 수, 누르면 바뀐 파일(M·U), 커밋을 고르면 그 상세, 변경이 없어지면 행도 없음",
    cleanAtFirst && !!dirty && firstRow && dirty.textContent === "Uncommitted Changes (2)" && listed === "M,U:new" && switched && gone,
    `${cleanAtFirst} ${dirty?.textContent} ${firstRow} ${listed} ${switched} ${gone}`,
  );

  // 새 worktree로 만든 작업그룹: 그 worktree가 있는 커밋(원본 HEAD에서 시작)에 그 탭 이름과 세션을 붙인다
  const tabsBefore = tabCount();
  await clickMenu("Terminal", "New Work Group");
  await waitFor("새 작업그룹", () => tabCount() === tabsBefore + 1 && !view(), 60000);
  const groupTab = activeTabEl()!;
  const groupName = groupTab.querySelector(".tab-title")!.textContent!;
  gitBtn().click();
  const tagged = await waitFor("작업그룹 표시", () => rows().find((r) => chips(r, "group").includes(`${groupName} · shell`)), 8000).catch(() => undefined);
  check("Git Graph: 새 worktree 작업그룹의 탭 이름·세션을 그 worktree의 커밋에 표시", tagged === row("graph-live") && chips(tagged, "branch").includes(`ddak/${groupName}`), `${groupName} ${chips(tagged, "group")} ${chips(tagged, "branch")}`);
  // 작업그룹의 마지막 탭이라 ×를 누르면 끝내기 창이 뜬다: 탭만 닫는다
  groupTab.querySelector<HTMLElement>("[title='Close Tab']")!.click();
  const askedOnTabX = await waitFor("탭 ×의 끝내기 창", () => document.querySelector<HTMLElement>("[data-action=close-tab-only]"), 3000).catch(() => null);
  askedOnTabX?.click();
  check("작업그룹 탭 닫기: 탭 ×도 마지막 탭이면 끝내기 창을 띄움", !!askedOnTabX);
  await waitFor("작업그룹 탭 닫기", () => tabCount() === tabsBefore, 3000);
  await waitFor("Git Graph로", () => view(), 3000).catch(() => null);

  // end-test 상세를 읽은 뒤 graph-live를 고르고 그 응답을 늦춘다: 기다리는 동안 end-test 상세가 남아 보이지 않고, 응답이
  // 오면 graph-live 상세 (리뷰 P2)
  const liveSha = row("graph-live")?.dataset.sha;
  const message = () => view()!.querySelector(".git-detail .git-message")?.textContent;
  row("end-test")?.click();
  await waitFor("end-test 상세", () => message() === "end-test", 5000).catch(() => null);
  devHooks.gitDetailDelay = (sha) => (sha === liveSha ? 1500 : 0);
  row("graph-live")?.click();
  await sleep(300);
  const waiting = message();
  await waitFor("graph-live 상세", () => message() === "graph-live", 4000).catch(() => null);
  devHooks.gitDetailDelay = undefined;
  check("Git Graph: 다른 커밋을 고르면 응답을 기다리는 동안 이전 상세를 보이지 않음", waiting === undefined && message() === "graph-live", `${waiting} → ${message()}`);
  // 상세 읽기가 실패하면 이전 상세(graph-live)를 남기지 않고 오류를 보인다
  const endSha = row("end-test")?.dataset.sha;
  devHooks.gitDetailFail = (sha) => sha === endSha;
  row("end-test")?.click();
  await waitFor("상세 실패", () => view()!.querySelector(".git-detail .git-error"), 3000).catch(() => null);
  const failedPane = view()!.querySelector(".git-detail")?.textContent ?? "";
  devHooks.gitDetailFail = undefined;
  check("Git Graph: 상세 읽기가 실패하면 이전 상세 대신 오류", failedPane.includes("injected failure") && !failedPane.includes("graph-live"), failedPane);

  // 커밋을 누르면 메시지와 바뀐 파일 (지금 고른 것이 end-test라 다른 커밋을 먼저 고른다. 같은 행을 다시 누르면 선택이 풀린다)
  row("graph-live")?.click();
  await sleep(300);
  row("end-test")?.click();
  const detail = () => view()!.querySelector<HTMLElement>(".git-detail");
  // 누른 직후에는 이전 커밋(graph-live)의 상세가 아직 DOM에 남아 있어서 end-test 메시지를 기다린다
  await waitFor("커밋 상세", () => detail()?.querySelector(".git-message")?.textContent === "end-test", 5000).catch(() => null);
  const files = [...(detail()?.querySelectorAll<HTMLElement>("[data-file]") ?? [])].map((f) => f.dataset.file);
  check("Git Graph: 커밋을 누르면 메시지와 바뀐 파일", detail()?.querySelector(".git-message")?.textContent === "end-test" && files.join(",") === "end-new.txt", `${detail()?.textContent}`);

  // 채팅 패널과 함께 쓴다
  ws().querySelector<HTMLElement>("[data-action=chat]")!.click();
  const chat = () => ws().querySelector<HTMLElement>(".chat-panel");
  await waitFor("채팅", () => chat()?.style.display !== "none", 2000).catch(() => null);
  const both = chat()?.style.display !== "none" && !!view() && view()!.getBoundingClientRect().width > 200;
  check("Git Graph: 채팅 패널과 함께 보임", both, `${chat()?.style.display} ${view()?.getBoundingClientRect().width}`);
  ws().querySelector<HTMLElement>("[data-action=chat]")!.click();
  await waitFor("채팅 닫기", () => chat()?.style.display === "none", 2000).catch(() => null);
  activeTabEl()!.querySelector<HTMLElement>("[title='Close Tab']")!.click();
  await waitFor("Git Graph 탭 닫기", () => tabCount() === before, 3000);
}

// 탭 이름 바꾸기: 더블클릭이나 오른쪽 클릭 메뉴. 이때 활성 탭은 첫 탭(기본 그룹 "Test")이다.
// WebView 기본 오른쪽 클릭 메뉴는 contextmenu의 기본 동작을 막으면 뜨지 않는다 (실제로 안 뜨는지는 화면으로 확인).
async function testNativeMenu() {
  const ws = document.querySelector<HTMLElement>(".project-workspace:not([style*='none'])")!;
  const blocked = (el: Element | null) => el !== null && !rightClick(el);
  const closeMenu = async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await waitFor("앱 메뉴 닫힘", () => !contextMenu(), 3000);
  };
  check("기본 메뉴: 파일 트리에서 막음", blocked(document.querySelector(".tree-row")));
  await waitFor("트리 메뉴", contextMenu, 3000); // 트리는 앱 메뉴를 연다
  await closeMenu();
  check("기본 메뉴: 터미널 화면에서 막음", blocked(ws.querySelector(".xterm-screen")));
  check("기본 메뉴: 터미널 숨은 입력란에서도 막음", blocked(ws.querySelector(".xterm-helper-textarea")));
  check("기본 메뉴: 빈 곳에서 막음", blocked(document.body));

  // 글 입력란은 기본 메뉴(잘라내기·붙여넣기·맞춤법)를 남긴다. 체크 상자는 글 입력란이 아니다.
  const fields = [document.createElement("input"), document.createElement("textarea"), Object.assign(document.createElement("input"), { type: "checkbox" })];
  document.body.append(...fields);
  check("기본 메뉴: 글 입력란(input)은 그대로", !blocked(fields[0]));
  check("기본 메뉴: 글 입력란(textarea)은 그대로", !blocked(fields[1]));
  check("기본 메뉴: 체크 상자에서는 막음", blocked(fields[2]));
  fields.forEach((el) => el.remove());

  // 앱이 그리는 메뉴는 그대로 열린다
  check("기본 메뉴: 확인 전 열린 앱 메뉴 없음", !contextMenu());
  rightClick(ws.querySelector(".tab.active")!);
  await waitFor("탭 메뉴", contextMenu, 3000).then(
    () => check("기본 메뉴: 막아도 앱 메뉴(탭)는 열림", menuLabels()[0] === "Rename Tab…", menuLabels().join(",")),
    (e) => check("기본 메뉴: 막아도 앱 메뉴(탭)는 열림", false, String(e)),
  );

  // 앱 메뉴를 여는 행 안의 이름 입력란도 기본 메뉴를 남기고 앱 메뉴를 열지 않는다 (리뷰 R1)
  const escape = (el: HTMLElement) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const keepsNative = async (name: string, el: HTMLInputElement) => {
    const native = !blocked(el);
    await sleep(100); // 앱 메뉴가 열렸다면 React가 그릴 때까지
    check(`기본 메뉴: ${name} 입력란은 그대로, 앱 메뉴 안 열림`, native && !contextMenu(), `기본 메뉴 ${native ? "남음" : "막힘"}, 앱 메뉴 ${menuLabels().join(",") || "없음"}`);
    if (contextMenu()) await closeMenu();
    escape(el);
  };
  await pickMenu("Rename Tab…");
  const tabInput = await waitFor("탭 이름 입력란", () => ws.querySelector<HTMLInputElement>(".tab.active .tab-input"), 3000);
  await keepsNative("탭 이름", tabInput);
  await waitFor("탭 이름 입력란 닫힘", () => !ws.querySelector(".tab-input"), 3000);
  rightClick(await waitFor("파일 행", () => fileRows()[0], 3000));
  await pickMenu("Rename…");
  const fileInput = await waitFor("파일 이름 입력란", () => document.querySelector<HTMLInputElement>("input[data-rename]"), 3000);
  await keepsNative("파일 이름", fileInput);
  await waitFor("파일 이름 입력란 닫힘", () => !document.querySelector("input[data-rename]"), 3000);
}

async function testTabRename() {
  const tab = () => document.querySelector<HTMLElement>(".project-workspace:not([style*='none']) .tab.active")!;
  const title = () => tab().querySelector(".tab-title")?.textContent ?? "";
  const input = () => tab().querySelector<HTMLInputElement>(".tab-input");
  const press = (el: HTMLElement, key: string, keyCode = 0) => {
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    Object.defineProperty(ev, "keyCode", { get: () => keyCode });
    el.dispatchEvent(ev);
  };
  const terminalFocused = () => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false;
  const original = title();

  tab().querySelector(".tab-title")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const a = await waitFor("탭 이름 입력란", input, 3000);
  check("탭 이름: 더블클릭하면 입력란, 포커스, 지금 이름 전체 선택", document.activeElement === a && a.value === original && a.selectionStart === 0 && a.selectionEnd === original.length, `${a.value} ${a.selectionStart}-${a.selectionEnd}`);
  check("탭 이름: 입력란을 눌러도 기본 동작을 막지 않음 (커서 옮기기)", !mouseDown(a));
  setInput(a, "내 작업");
  // 한글 조합을 확정하는 Enter(keyCode 229)는 확정이 아니다
  press(a, "Enter", 229);
  await sleep(100); // 끝났다면 React가 입력란을 지울 때까지
  check("탭 이름: 조합 확정 Enter로는 끝나지 않음", input() === a && title() === "", title());
  press(a, "Enter", 13);
  await waitFor("바뀐 탭 이름", () => !input() && title() === "내 작업", 3000).then(
    () => check("탭 이름: Enter로 확정, 터미널로 포커스", terminalFocused(), document.activeElement?.className ?? ""),
    () => check("탭 이름: Enter로 확정, 터미널로 포커스", false, title()),
  );

  rightClick(tab());
  await waitFor("탭 메뉴", contextMenu);
  check("탭 이름: 오른쪽 클릭 메뉴에 항목", menuLabels().join(",") === "Rename Tab…,Add Session…", menuLabels().join(","));
  await pickMenu("Rename Tab…");
  const b = await waitFor("탭 이름 입력란", input, 3000);
  setInput(b, "never");
  press(b, "Escape");
  await waitFor("Esc로 취소", () => !input(), 3000);
  check("탭 이름: Esc로 취소, 이름 그대로", title() === "내 작업", title());

  tab().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const c = await waitFor("탭 이름 입력란", input, 3000);
  setInput(c, "blurred");
  c.blur();
  await waitFor("다른 곳을 누르면 확정", () => !input(), 3000);
  check("탭 이름: 다른 곳을 누르면 확정", title() === "blurred", title());

  tab().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const d = await waitFor("탭 이름 입력란", input, 3000);
  setInput(d, "  ");
  press(d, "Enter", 13);
  await waitFor("비우면 원래 이름", () => !input(), 3000);
  check("탭 이름: 비우면 원래 이름으로", title() === original, title());
}

// 탭을 끌어서 순서 바꾸기
async function testTabMove() {
  const tabs = document.querySelector<HTMLElement>(".project-workspace:not([style*='none']) .tabs")!;
  const ids = () => [...tabs.querySelectorAll<HTMLElement>(".tab")].map((el) => el.dataset.tab!);
  const tabEl = (id: string) => tabs.querySelector<HTMLElement>(`.tab[data-tab="${id}"]`)!;
  const center = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  // 실제 끌기처럼 누르고, 몇 번에 나눠 움직이고, 뗀다
  const drag = async (id: string, toX: number, steps = 5) => {
    const from = center(tabEl(id));
    tabEl(id).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: from.x, clientY: from.y }));
    for (let i = 1; i <= steps; i++) {
      window.dispatchEvent(new PointerEvent("pointermove", { buttons: 1, clientX: from.x + ((toX - from.x) * i) / steps, clientY: from.y }));
      await sleep(30);
    }
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: toX, clientY: from.y }));
    await sleep(50);
  };

  const before = tabCount();
  for (let i = 0; i < 2; i++) await menu("new_tab");
  await waitFor("탭 셋 이상", () => tabCount() === before + 2, 5000);
  const start = ids();
  const [first, last] = [start[0], start.at(-1)!];

  await drag(last, tabEl(first).getBoundingClientRect().left + 2);
  check("탭 순서: 마지막 탭을 맨 앞으로 끌기", ids().join() === [last, ...start.slice(0, -1)].join(), `${start.join()} → ${ids().join()}`);
  check("탭 순서: 끈 탭이 활성", tabEl(last).classList.contains("active"));
  check("탭 순서: 끝나면 끄는 표시가 사라짐", !tabs.querySelector(".tab.dragging"));

  const moved = ids();
  await drag(moved[1], center(tabEl(moved[1])).x + 2, 1);
  check("탭 순서: 4px 안쪽 움직임은 끌기가 아님", ids().join() === moved.join(), ids().join());

  await drag(last, tabEl(ids().at(-1)!).getBoundingClientRect().right - 2);
  check("탭 순서: 다시 맨 뒤로", ids().join() === start.join(), ids().join());

  // 끌기가 끝나는 다른 경우들 (리뷰 지적 5). 끝난 뒤의 움직임으로 순서가 바뀌면 안 된다.
  const farLeft = tabEl(first).getBoundingClientRect().left + 2;
  const press = (id: string) => {
    const c = center(tabEl(id));
    tabEl(id).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: c.x, clientY: c.y }));
    return c;
  };
  let c = press(last);
  window.dispatchEvent(new PointerEvent("pointercancel", {}));
  window.dispatchEvent(new PointerEvent("pointermove", { buttons: 1, clientX: farLeft, clientY: c.y }));
  await sleep(50);
  check("탭 순서: pointercancel 뒤 움직임은 끌기가 아님", ids().join() === start.join(), ids().join());
  window.dispatchEvent(new PointerEvent("pointerup", {})); // 수정 전 코드에서도 다음 검사가 섞이지 않게

  // 창 밖에서 버튼을 떼면 pointerup이 오지 않는다. 버튼이 눌려 있지 않은 움직임이 오면 끝난 것으로 본다.
  c = press(last);
  window.dispatchEvent(new PointerEvent("pointermove", { buttons: 0, clientX: farLeft, clientY: c.y }));
  await sleep(50);
  check("탭 순서: 버튼을 뗀 뒤 움직임은 끌기가 아님", ids().join() === start.join(), ids().join());
  window.dispatchEvent(new PointerEvent("pointerup", {}));

  for (const id of start.slice(-2)) tabEl(id).querySelector<HTMLElement>(".tab-close")!.click();
  await waitFor("추가한 탭 닫기", () => tabCount() === before, 5000);
}

// 탭이 많으면 탭 영역만 스크롤하고 버튼은 늘 보인다. 활성 탭은 보이게 스크롤한다.
async function testTabScroll() {
  const bar = document.querySelector<HTMLElement>(".project-workspace:not([style*='none']) .tabbar")!;
  const tabs = bar.querySelector<HTMLElement>(".tabs")!;
  const before = tabCount();
  const added = 15;
  for (let i = 0; i < added; i++) await menu("new_tab");
  await waitFor("탭 여럿", () => tabCount() === before + added, 5000);
  await sleep(100);
  const inside = (el: Element, box: Element) => {
    const [r, b] = [el.getBoundingClientRect(), box.getBoundingClientRect()];
    return r.left >= b.left - 0.5 && r.right <= b.right + 0.5;
  };
  const active = () => tabs.querySelector(".tab.active")!;
  check("탭 스크롤: 탭 영역이 넘침", tabs.scrollWidth > tabs.clientWidth, `${tabs.scrollWidth} > ${tabs.clientWidth}`);
  check("탭 스크롤: 탭 바 전체는 스크롤되지 않음", bar.scrollWidth <= bar.clientWidth, `${bar.scrollWidth} ${bar.clientWidth}`);
  check("탭 스크롤: 버튼 넷이 모두 보임", [...bar.querySelectorAll(".tabbar-btn")].every((b) => inside(b, bar)));
  const diag = async () => {
    const el = active() as HTMLElement;
    return `scroll=${tabs.scrollLeft} active=${activeTabIndex()} left=${el.offsetLeft} w=${el.offsetWidth} box=${tabs.clientWidth}/${tabs.scrollWidth} ${await frameInfo()}`;
  };
  // 스크롤 맞추기는 ResizeObserver(화면 갱신)로 오므로 고정 시간이 아니라 조건을 기다린다
  const visibleCheck = (name: string) =>
    waitFor(name, () => tabs.scrollLeft > 0 && inside(active(), tabs), 3000).then(
      () => check(name, true),
      async () => check(name, false, await diag()),
    );
  await visibleCheck("탭 스크롤: 새 탭(활성)이 보이게 스크롤됨");
  // 뒤늦게 터미널 제목이 와서 앞 탭이 넓어져도 활성 탭은 계속 보인다 (예전에 밀려나 실패했다)
  tabs.querySelector<HTMLElement>(".tab:first-child .tab-title")!.textContent += " a much longer title";
  await sleep(100);
  await visibleCheck("탭 스크롤: 앞 탭이 넓어져도 활성 탭이 보임");
  check("탭 스크롤: 탭 높이에 스크롤바 자리 없음", tabs.clientHeight === tabs.offsetHeight, `${tabs.clientHeight} ${tabs.offsetHeight}`);
  key("1", "Digit1");
  await waitFor("첫 탭으로", () => activeTabIndex() === 0 && inside(active(), tabs), 3000).then(
    () => check("탭 스크롤: ⌘1로 첫 탭이 보이게 스크롤됨", tabs.scrollLeft === 0, `${tabs.scrollLeft}`),
    () => check("탭 스크롤: ⌘1로 첫 탭이 보이게 스크롤됨", false, `${activeTabIndex()} ${tabs.scrollLeft}`),
  );
  tabs.dispatchEvent(new WheelEvent("wheel", { deltaY: 200, bubbles: true }));
  await sleep(50);
  check("탭 스크롤: 마우스 휠로 가로 스크롤", tabs.scrollLeft > 0, `${tabs.scrollLeft}`);
  // 활성 탭(첫 탭)을 밀어낸 상태에서 탭 크기가 바뀌어도 (터미널 제목 등) 되돌아오지 않는다
  const last = tabs.querySelector<HTMLElement>(".tab:last-child .tab-title")!;
  last.textContent += " longer title";
  await sleep(100);
  check("탭 스크롤: 휠로 넘긴 뒤 탭 크기가 바뀌어도 그대로", tabs.scrollLeft === 200, `${tabs.scrollLeft}`);
  // 다른 탭을 닫아도 넘겨 둔 자리 그대로 (리뷰 지적 6)
  tabs.querySelector<HTMLElement>(".tab:last-child .tab-close")!.click();
  await waitFor("탭 하나 닫기", () => tabCount() === before + added - 1, 3000);
  await frameInfo();
  await sleep(50);
  check("탭 스크롤: 휠로 넘긴 뒤 다른 탭을 닫아도 그대로", activeTabIndex() === 0 && tabs.scrollLeft === 200, `${activeTabIndex()} ${tabs.scrollLeft}`);

  key("9", "Digit9");
  await waitFor("마지막 탭으로", () => activeTabIndex() === before + added - 2, 3000);
  for (let i = 0; i < added - 1; i++) await menu("close_pane");
  await waitFor("추가한 탭 닫기", () => tabCount() === before, 5000);
}

async function testLastExit(first: Terminal) {
  first.input("exit\r");
  // 시간 초과면 남은 창(이름표)을 함께 남긴다 (앞 테스트가 창을 닫지 않았는지)
  const left = () => paneEls().map((el) => el.querySelector(".pane-label")?.firstChild?.textContent ?? "-").join(",");
  await waitFor("빈 화면", () => document.querySelector(".workspace-empty"), 10000).catch((e) => {
    throw new Error(`${e.message} (남은 창: ${left()}, 탭 ${tabCount()})`);
  });
  check("닫기: 모든 터미널을 닫으면 빈 화면", true);
  const ws = document.querySelector<HTMLElement>(".project-workspace:not([style*='none'])")!;
  const buttons = [...ws.querySelectorAll(".workspace-empty button")].map((b) => b.textContent);
  check(
    "닫기: 빈 화면에서 원본 작업그룹·새 작업그룹·새 터미널을 열 수 있음",
    buttons.join("|") === "Open Test in Project Folder|New Work Group (⇧⌘T)|New Terminal (⌘T)",
    buttons.join("|"),
  );
  const btns = [...ws.querySelectorAll<HTMLButtonElement>(".tabbar-btn")];
  // 순서: 터미널, 작업그룹, 분할 둘, Git Graph, 구분선, 채팅
  const order = [...ws.querySelectorAll<HTMLElement>(".tabbar-btn, .tabbar-sep")]
    .map((b) => (b.classList.contains("tabbar-sep") ? "|" : (b.dataset.action ?? ((b as HTMLButtonElement).disabled ? "split" : "terminal"))))
    .join();
  check(
    "닫기: 빈 화면에도 탭 바 (분할 버튼만 비활성), 순서는 만드는 버튼 왼쪽·보는 버튼 오른쪽 끝",
    btns.length === 6 && btns.map((b) => b.disabled).join() === "false,false,true,true,false,false" && order === "terminal,new-group,split,split,git,|,chat",
    `${btns.map((b) => b.disabled).join()} ${order}`,
  );
  ws.querySelector<HTMLElement>("[data-action=origin-group]")!.click();
  const term = await waitFor("다시 열기", () => visiblePanes()[0]?.term);
  await ready(term);
  const pwd = (await run(term, "pwd")).map((l) => l.trim());
  check("닫기: 빈 화면에서 원본 폴더의 기본 작업그룹", tabCount() === 1 && ws.querySelector(".tab-title")?.textContent === "Test" && pwd.includes(ws.dataset.project!), `${ws.querySelector(".tab-title")?.textContent} ${pwd.join("|")}`);
}

// 프로젝트를 열면 기본 작업그룹(scripts/selftest.sh의 "trio")의 세션들이 첫 탭에 나란히 뜬다.
async function testGroupStart(root: string) {
  const panes = await waitFor("세 세션", () => visiblePanes().length === 3 && visiblePanes());
  const body = document.querySelector<HTMLElement>(".project-workspace:not([style*='none']) .tab-body:not([style*='none'])")!.getBoundingClientRect();
  check(
    "작업그룹: 세션 셋이 같은 폭으로 나란히",
    panes.every((p) => near(p.rect.width / body.width, 1 / 3) && near(p.rect.height / body.height, 1)),
    panes.map((p) => Math.round(p.rect.width)).join(","),
  );
  check("작업그룹: 탭이 하나이고 제목은 그룹 이름", tabCount() === 1 && document.querySelector(".tab-title")?.textContent === "Trio");
  const labels = panes.map((p) => paneLabel(p.el));
  check("작업그룹: 창마다 역할 이름, 읽기 전용 표시", labels.join(",") === "alpha,betaRead-only,gamma", labels.join(","));

  const [alpha, beta, gamma] = panes.map((p) => p.term);
  const shows = (term: Terminal, text: string) => waitFor(text, () => screen(term).some((l) => l.includes(text)), 10000).then(() => true, () => false);
  check("작업그룹: 인자가 그대로 전달됨 (작은따옴표)", await shows(alpha, "ALPHA it's quoted|"), screen(alpha).filter(Boolean).join("|"));
  check("작업그룹: 인자가 그대로 전달됨 (공백)", await shows(beta, "BETA x  y"), screen(beta).filter(Boolean).join("|"));
  check("작업그룹: 없는 명령은 오류를 보여 줌", await shows(gamma, "ddak-no-such-cli"), screen(gamma).filter(Boolean).join("|"));
  // 명령이 끝나면 그 자리에 셸이 남는다 (창이 닫히지 않음)
  // 명령 출력이 보인 직후에는 셸(exec $SHELL -l)이 아직 뜨는 중일 수 있다. 그때 보낸 입력을 셸이 버리는지
  // 한 번 시간 초과가 났다 (2026-10-23, 원인 미확인). 다시 나면 화면을 기록하고 한 번 더 보낸다.
  for (const [name, term] of [["alpha", alpha], ["beta", beta], ["gamma", gamma]] as const) {
    await ready(term);
    const pwd = await run(term, "pwd", 5000).catch(() => {
      log.push(`INFO  ${name}: 첫 pwd 시간 초과, 다시 보냄. 화면 끝: ${screen(term).filter(Boolean).slice(-4).join(" | ")}`);
      return run(term, "pwd");
    });
    check(`작업그룹: ${name} 명령이 끝난 뒤 그 프로젝트 폴더의 셸`, pwd.some((l) => l.trim() === root), pwd.join("|"));
  }
  check("작업그룹: 세 창 모두 그대로", visiblePanes().length === 3);
}

// 앱을 다시 켠 상황: scripts/selftest.sh가 목록 파일에 [proj, gone(없는 폴더)]을 넣고 gone을 활성으로 저장해 둔다.
async function testRestart(root: string) {
  const gone = root.replace(/\/proj$/, "/gone");
  const row = await waitFor("저장된 목록", () => projectRow(gone));
  // 저장된 순서는 proj, gone이지만 이름순으로 보이고 그 순서로 다시 저장한다 (폰 목록도 이 순서)
  check("다시 켜기: 저장된 목록을 이름순으로 불러옴", projectRows().map((el) => el.dataset.project).join(",") === `${gone},${root}`, projectRows().map((el) => el.dataset.project).join(","));
  const order = (s: Store) => s.projects.map((p) => p.path).join(",");
  const resorted = await waitStore((s) => order(s) === `${gone},${root}`);
  check("다시 켜기: 이름순으로 다시 저장", order(resorted) === `${gone},${root}`, JSON.stringify(resorted));
  check("다시 켜기: 없는 폴더는 취소선 표시", row.classList.contains("missing") && row.title === `Folder not found: ${gone}`, row.title);
  check("다시 켜기: 없는 폴더가 활성이었으면 다른 프로젝트로", projectRow(root)!.classList.contains("active") && !row.classList.contains("active"));
  await testGroupStart(root);
  row.click();
  await sleep(300);
  check("다시 켜기: 없는 폴더는 눌러도 열리지 않음", projectRow(root)!.classList.contains("active") && !document.querySelector(`.project-workspace[data-project="${CSS.escape(gone)}"]`));
  rightClick(row);
  await waitFor("메뉴", contextMenu);
  check("다시 켜기: 없는 폴더의 메뉴는 목록에서 제거만", menuLabels().join(",") === "Remove from List", menuLabels().join(","));
  await pickMenu("Remove from List");
  const store = await waitStore((s) => s.projects.length === 1);
  check("다시 켜기: 없는 폴더를 목록에서 빼고 저장", store.projects[0]?.path === root && store.active === root, JSON.stringify(store));
}

// 복원 (두 시나리오가 같은 앱 데이터·DDAK_HOME을 쓴다, scripts/selftest.sh). 기본 그룹 "Duo":
// keeps = 처음 "FIRST {session}", 복원하면 "RESUMED {session}" / fresh = 복원 인자가 실패해 처음 인자로 ("FRESH {session}")
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// 저장된 상태 파일에서 필요한 것만 한 줄씩 꺼낸다 (긴 JSON은 터미널에서 줄이 접혀서)
const SAVED_FACTS = `python3 -c 'import json,glob,sys
d=json.load(open(glob.glob(sys.argv[1]+"/workspaces/*.json")[0]))
print("TABS", len(d["tabs"]), d["active"] == d["tabs"][0]["id"], d["tabs"][0].get("name"))
for s in d["sessions"].values():
  print("SID", s["name"], s.get("sid"))'`;
const savedFacts = async (term: Terminal, root: string) =>
  (await run(term, `${SAVED_FACTS} "${root.replace(/\/proj$/, "")}/data-resume"`)).map((l) => l.trim()).filter((l) => /^(TABS|SID) /.test(l));

async function testResumeSave(root: string) {
  const [keeps, fresh] = await waitFor("기본 작업그룹 세션", () => visiblePanes().length === 2 && visiblePanes(), 15000);
  const first = await waitFor("처음 인자", () => screen(keeps.term).find((l) => l.startsWith("FIRST ")), 10000);
  const fresh1 = await waitFor("처음 인자 (fresh)", () => screen(fresh.term).find((l) => l.startsWith("FRESH ")), 10000);
  const [sidKeeps, sidFresh] = [first.split(" ")[1]?.trim(), fresh1.split(" ")[1]?.trim()];
  check("복원 준비: 창마다 세션 ID(UUID)를 정해 {session}에 넣음", UUID.test(sidKeeps) && UUID.test(sidFresh) && sidKeeps !== sidFresh, `${sidKeeps} ${sidFresh}`);
  // 분할(포커스는 keeps) → 셸 창, 탭 이름 바꾸기, 셸 탭, 준비 중인 작업그룹, 첫 탭으로
  // 저장은 앞 저장이 끝난 뒤에 보낸다 (리뷰 P2): 첫 저장을 늦춰도 마지막 상태가 남아야 한다
  let saves = 0;
  devHooks.workspaceSaveDelay = () => (saves++ === 0 ? 1500 : 0);
  await menu("new_tab");
  await waitFor("잠깐 연 탭", () => tabCount() === 2);
  await menu("close_pane");
  await waitFor("잠깐 연 탭 닫기", () => tabCount() === 1);
  await sleep(2500);
  devHooks.workspaceSaveDelay = undefined;
  const order = await savedFacts(keeps.term, root);
  check("복원 준비: 늦게 끝난 앞 저장이 마지막 상태를 덮지 않음", saves >= 2 && order.some((l) => l.startsWith("TABS 1 ")), `${saves} ${order.join("|")}`);
  await menu("split_right");
  await waitFor("분할", () => visiblePanes().length === 3);
  const tab = () => document.querySelector<HTMLElement>(".project-workspace:not([style*='none']) .tab.active")!;
  tab().querySelector(".tab-title")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const input = await waitFor("탭 이름 입력란", () => tab().querySelector<HTMLInputElement>(".tab-input"), 3000);
  setInput(input, "saved tab");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await waitFor("탭 이름", () => tab().querySelector(".tab-title")?.textContent === "saved tab", 3000);
  await menu("new_tab");
  await waitFor("셸 탭", () => tabCount() === 2);
  await ready(keeps.term);
  const setupPath = await invoke<string>("setup_script_edit", { project: root });
  await run(keeps.term, `printf 'sleep 600\\n' >> "${setupPath}"`);
  await clickMenu("Terminal", "New Work Group");
  await waitFor("준비 중인 작업그룹", () => tabCount() === 3 && document.querySelector(".project-workspace:not([style*='none']) .setup-wait"), 15000);
  key("1", "Digit1");
  await waitFor("첫 탭으로", () => activeTabIndex() === 0);
  await sleep(1000); // 저장은 0.3초 모았다가
  const facts = await savedFacts(keeps.term, root);
  check(
    "복원 준비: 탭·활성 탭·이름·세션 ID를 앱 데이터에 저장",
    facts.includes("TABS 3 True saved tab") && facts.includes(`SID keeps ${sidKeeps}`) && facts.includes(`SID fresh ${sidFresh}`),
    facts.join("|"),
  );
}

async function testResumeCheck(root: string) {
  const titles = () => [...document.querySelectorAll(".project-workspace:not([style*='none']) .tab .tab-title")].map((el) => el.textContent);
  await waitFor("복원한 탭", () => tabCount() === 3, 15000);
  check("복원: 탭 셋, 이름과 활성 탭", titles()[0] === "saved tab" && titles()[2] === "duo-1" && activeTabIndex() === 0, `${titles().join(",")} ${activeTabIndex()}`);
  const panes = await waitFor("복원한 창", () => visiblePanes().length === 3 && visiblePanes(), 15000);
  const [keeps, shell, fresh] = panes;
  const label = (p: (typeof panes)[number]) => paneLabel(p.el) ?? "";
  check("복원: 분할과 세션 자리 (keeps | 셸 | fresh)", label(keeps) === "keeps" && label(shell) === "" && label(fresh) === "fresh", panes.map(label).join(","));
  await ready(shell.term);
  const facts = await savedFacts(shell.term, root);
  const sid = (name: string) => facts.find((l) => l.startsWith(`SID ${name} `))?.split(" ")[2] ?? "?";
  // 프롬프트는 세션을 만들 때 저장한 것 (KP1). scripts/selftest.sh가 그 사이 설정의 역할을 KP2로 바꿨다
  await waitFor("이어서 하기", () => screen(keeps.term).some((l) => l.trim() === `RESUMED ${sid("keeps")} KP1`), 10000).then(
    () => check("복원: 세션을 이어서 하기 인자(같은 세션 ID, 만들 때 저장한 프롬프트)로 띄움", true),
    () => check("복원: 세션을 이어서 하기 인자(같은 세션 ID, 만들 때 저장한 프롬프트)로 띄움", false, screen(keeps.term).join("|").slice(-200)),
  );
  // 이어서 하기가 실패하면 새로 시작할지 묻고, y일 때만 처음 인자로 (리뷰 P2: 쓰다가 끝난 것과 구분할 수 없어서)
  // 문구가 길어 여러 줄로 접히므로 화면을 이어 붙여 본다
  const asked = await waitFor("새로 시작할지 묻기", () => [screen(fresh.term).join("")].find((l) => l.includes("Start a new conversation instead? [y/N]")), 10000).catch(() => "");
  check("복원: 이어서 하기가 실패하면 새로 시작할지 묻고 바로 시작하지 않음", asked.includes("(exit 1)") && !screen(fresh.term).some((l) => l.startsWith("FRESH ")), asked);
  fresh.term.input("y\r");
  await waitFor("처음처럼", () => screen(fresh.term).some((l) => l.trim() === `FRESH ${sid("fresh")}`), 10000).then(
    () => check("복원: y면 처음 인자로 (같은 세션 ID)", true),
    () => check("복원: y면 처음 인자로 (같은 세션 ID)", false, screen(fresh.term).join("|").slice(-200)),
  );
  const alive = await run(shell.term, "echo alive");
  check("복원: 셸 창은 새 셸", alive.some((l) => l.trim() === "alive"));
  // 준비를 마치기 전에 닫힌 작업그룹: 준비 창 없이 중단으로, 그래도 시작하면 세션은 처음처럼 (뜬 적이 없어서)
  key("3", "Digit3");
  const stopped = await waitFor("중단된 준비", () => document.querySelector<HTMLElement>(".project-workspace:not([style*='none']) .setup-wait-error"), 5000);
  check("복원: 준비 중이던 작업그룹은 준비 창 없이 중단 표시", stopped.textContent === "Stopped" && visiblePanes().length === 0, stopped.textContent ?? "");
  stopped.parentElement!.querySelector<HTMLElement>("[data-action=setup-start]")!.click();
  const started = await waitFor("그래도 시작", () => visiblePanes().length === 2 && visiblePanes(), 5000);
  await waitFor("처음 인자로", () => screen(started[0].term).some((l) => l.startsWith("FIRST ")), 10000).then(
    () => check("복원: 뜬 적 없는 세션은 처음 인자로", true),
    () => check("복원: 뜬 적 없는 세션은 처음 인자로", false, screen(started[0].term).join("|").slice(-200)),
  );
}

// 목록 파일이 깨진 상황 (리뷰 지적 4): 오류를 계속 보여 주고, 목록을 바꾸지도 저장하지도 않는다.
async function testCorrupt(root: string) {
  const err = await waitFor("오류 표시", () => document.querySelector(".empty-box .sidebar-error")?.textContent);
  check("깨진 목록: 오류 표시", err.startsWith("Could not read the project list"), err);
  check("깨진 목록: 추가 버튼 비활성", !!document.querySelector<HTMLButtonElement>(".empty-box button")?.disabled);
  await devHooks.addProject!(root);
  await sleep(500);
  check("깨진 목록: 추가해도 목록이 바뀌지 않음", !projectRow(root) && !!document.querySelector(".empty-box"));
  check("깨진 목록: 오류가 지워지지 않음", (document.querySelector(".empty-box .sidebar-error")?.textContent ?? "") === err);
  const still = await loadStore().then(() => "읽힘", (e) => String(e));
  check("깨진 목록: 파일을 덮어쓰지 않음", still !== "읽힘", still);

  // 이 시나리오는 groups.json 없이 시작한다 → 기본 설정이 만들어진다 (프로젝트가 없어서 CLI는 뜨지 않는다).
  const g = await waitFor("작업그룹 기본 설정", () => devHooks.groups);
  check("작업그룹: 파일이 없으면 기본 설정을 만듦", g.default === "dev-review" && g.groups.map((x) => x.id).join(",") === "dev-review,shell");
  const [dev, reviewer] = g.groups[0].sessions;
  check(
    "작업그룹: 기본은 claude 개발 + 읽기 전용 codex 리뷰어",
    dev.command === "claude" && reviewer.command === "codex" && reviewer.readOnly && reviewer.args.includes("read-only") && !dev.readOnly,
    JSON.stringify(g.groups[0].sessions.map((x) => [x.name, x.command, x.readOnly])),
  );
  check(
    "작업그룹: 기본 설정의 규약·역할은 필드에, 인자는 {prompt}·{prompt:toml}",
    !!g.groups[0].rules && !!dev.role && !!reviewer.role && dev.args.includes("{prompt}") && reviewer.args.includes("developer_instructions={prompt:toml}"),
    JSON.stringify([g.groups[0].rules?.slice(0, 20), dev.role?.slice(0, 20), dev.args.slice(-1), reviewer.args.slice(-1)]),
  );
  check("작업그룹: 명령 없는 세션(셸)", g.groups[1].sessions[0].command === "" && g.groups[1].sessions[0].args.length === 0);
}

// main 시나리오의 단계. 앞 단계가 만든 상태(터미널 first, 탭, 세션, 설정)를 뒤 단계가 이어 쓴다.
// 단계마다 예외를 따로 잡아 FAIL로 남기고 다음 단계로 간다 (하나가 죽어도 나머지 결과를 얻게). 걸린 시간은 INFO로 남긴다.
// only(scripts/selftest.sh의 SELFTEST_ONLY)를 주면 기본 단계(BASE_STEPS)와 고른 단계만 순서대로 돈다. 앞 단계가 만든 상태에
// 기대는 단계는 혼자 돌면 실패할 수 있다: 고칠 때는 관련 단계만 돌리고, 리뷰 전에는 전체를 돌린다.
const BASE_STEPS = ["projectStart", "terminalReady"];
// 한 단계가 이 시간 안에 끝나지 않으면 멈춘 것으로 보고 FAIL로 남긴 뒤, 뒤 단계는 돌지 않고 결과를 보고한다 (멈춘 단계가
// 뒤에서 계속 돌아 섞이지 않게). 없으면 멈춘 단계 하나로 전체가 보고 없이 끝나지 않아 어디서 멈췄는지 알 수 없었다.
// 가장 긴 단계가 25초 남짓 (2026-10-25)이라 넉넉히 둔다.
const STEP_TIMEOUT_MS = 300_000;
// 진짜 CLI. 작업그룹 설정에 이것이 있으면 새 작업그룹·세션이 실제로 띄운다.
const REAL_CLIS = ["claude", "codex"];
const usesRealCli = (g: Groups | null | undefined) => !!g?.groups.some((x) => x.sessions.some((s) => REAL_CLIS.includes(s.command)));
// 혼자 돌면 실패하는 단계가 기대는 앞 단계 (고르면 함께 돈다). scripts/selftest-plan.json의 deps (이유는 depsWhy).
// 고르기(scripts/selftest-changed.mjs)와 같은 표를 쓴다.
const STEP_DEPS: Record<string, string[]> = selftestPlan.deps;

// 고른 단계와 그 앞 단계를 끝까지 펼친다. 표에 없는 단계, 앞 단계가 뒤에 있음, 순환은 오류로 알린다 (말없이 넘기면
// 고른 실행이 엉뚱하게 통과한다). 도는 순서는 늘 단계 목록 순서다.
export function expandSteps(order: string[], only: string[], deps: Record<string, string[]>) {
  const errors: string[] = [];
  for (const [name, ds] of Object.entries(deps)) {
    for (const d of ds) {
      if (!order.includes(name) || !order.includes(d)) errors.push(`앞 단계 표에 없는 단계: ${order.includes(name) ? d : name}`);
      else if (order.indexOf(d) > order.indexOf(name)) errors.push(`앞 단계가 뒤에 있음: ${name} → ${d}`);
    }
  }
  const chosen = new Set<string>();
  const visit = (name: string, path: string[]) => {
    if (path.includes(name)) return void errors.push(`앞 단계 순환: ${[...path, name].join(" → ")}`);
    if (chosen.has(name)) return;
    if (!order.includes(name)) return void errors.push(`없는 단계: ${name}`);
    for (const d of deps[name] ?? []) visit(d, [...path, name]);
    chosen.add(name);
  };
  for (const name of only) visit(name, []);
  return { chosen, errors };
}

// 단계 펼치기 (expandSteps): 앞 단계를 끝까지 따라가고, 표의 잘못은 오류로
function testStepPlanUnit() {
  const order = ["a", "b", "c", "d", "e"];
  const deep = expandSteps(order, ["d"], { b: ["a"], c: ["b"], d: ["c"] });
  check("단계 고르기: 앞 단계를 끝까지 펼침", [...deep.chosen].sort().join(",") === "a,b,c,d" && !deep.errors.length, `${[...deep.chosen]} ${deep.errors}`);
  const bad = [
    expandSteps(order, ["x"], {}).errors,
    expandSteps(order, ["b"], { b: ["c"] }).errors,
    expandSteps(order, ["b"], { b: ["zz"] }).errors,
    expandSteps(order, ["b"], { b: ["a"], a: ["b"] }).errors,
  ];
  check(
    "단계 고르기: 없는 단계·앞 단계가 뒤에 있음·표에 없는 앞 단계·순환은 오류",
    bad.every((e) => e.length > 0) && bad[0][0].includes("x") && bad[1].some((e) => e.includes("b → c")) && bad[3].some((e) => e.includes("순환")),
    JSON.stringify(bad),
  );
}

export async function runSelftest(root: string, scenario: string, only: string[] = []) {
  const single: Record<string, (root: string) => Promise<void>> = {
    restart: testRestart,
    corrupt: testCorrupt,
    "resume-save": testResumeSave,
    "resume-check": testResumeCheck,
  };
  if (single[scenario]) {
    try {
      await single[scenario](root);
    } catch (e) {
      check("예외", false, String(e));
    }
    await invoke("selftest_report", { ok: !failed, log: log.join("\n") });
    return;
  }
  let first: Terminal | undefined;
  const t = () => first!;
  const steps: [string, () => Promise<unknown> | void][] = [
    ["projectStart", () => testProjectStart(root)],
    ["tree", testTree],
    ["terminalReady", async () => (first = await openFirstTerminal())],
    ["terminal", () => testTerminal(root, t())],
    ["watch", () => testWatch(root, t())],
    ["treeGit", () => testTreeGit(t())],
    ["repos", () => testRepos(root, t())],
    ["create", () => testCreate(root, t())],
    ["rename", () => testRename(root, t())],
    ["trashDrag", () => testTrashAndDrag(root, t())],
    ["imeUnit", testImeUnit],
    ["terminalReplyUnit", testTerminalReplyUnit],
    ["workspaceStateUnit", testWorkspaceStateUnit],
    ["stepPlanUnit", testStepPlanUnit],
    ["groups", () => testGroups(t())],
    ["groupWorktree", () => testGroupWorktree(root, t())],
    ["tabRename", testTabRename],
    ["nativeMenu", testNativeMenu],
    ["prefs", testPrefs],
    ["notifySound", testNotifySound],
    ["mobile", () => testMobile(root)],
    ["mobileSyncUnit", testMobileSyncUnit],
    ["mobilePushUnit", testMobilePushUnit],
    ["mobileThemeUnit", testMobileThemeUnit],
    ["mobileChatUnit", testMobileChatUnit],
    ["mobileSettingsUnit", testMobileSettingsUnit],
    ["panels", testPanels],
    ["zoom", () => testZoom(t())],
    ["zoomIme", () => testZoomIme(t())],
    ["terminalContrast", () => testTerminalContrast(t())],
    ["terminalFont", () => testTerminalFont(t())],
    ["claude", () => testClaude(t())],
    ["shiftEnterProgram", () => testProgramShiftEnter(t())],
    ["terminalSearch", () => testTerminalSearch(t())],
    ["terminalLinksUnit", testTerminalLinksUnit],
    ["platformUnit", testPlatformUnit],
    ["statusContrastUnit", testStatusContrastUnit],
    ["terminalLinkWrap", () => testTerminalLinkWrap(root, t())],
    ["terminalLinks", () => testTerminalLinks(root, t())],
    ["docView", () => testDocView(root, t())],
    ["programStatusUnit", testProgramStatusUnit],
    ["promptAnswerUnit", () => testPromptAnswerUnit()],
    ["altLossUnit", testAltLossUnit],
    ["permissionModeUnit", testPermissionModeUnit],
    ["notifyClickUnit", testNotifyClickUnit],
    ["programStatus", () => testProgramStatus(root, t())],
    ["tabsAndSplits", () => testTabsAndSplits(root, t())],
    ["webglLoss", () => testWebglLoss(t())],
    // 탭을 많이 열면 앞 터미널의 WebGL 컨텍스트가 밀려나므로 WebGL·배율 검사 뒤에 둔다
    ["groupClone", () => testGroupClone(root, t())],
    ["groupEnd", () => testGroupEnd(root, t())],
    ["addSession", () => testAddSession(root, t())],
    ["sessionFollow", () => testSessionFollow(root, t())],
    ["gitGraph", () => testGitGraph(root, t())],
    ["tabMove", testTabMove],
    ["tabScroll", testTabScroll],
    ["manyTerminals", () => testManyTerminals(20)],
    ["projects", () => testProjects(root, t())],
    ["lastExit", () => testLastExit(t())],
  ];
  const order = steps.map(([n]) => n);
  const { chosen, errors } = expandSteps(order, [...BASE_STEPS, ...only], STEP_DEPS);
  // 고르기 표(scripts/selftest-plan.json)의 단계 이름도 실제 단계와 맞아야 한다
  const unplanned = selftestPlan.rules.flatMap((r) => r.steps).filter((n) => !order.includes(n));
  if (unplanned.length) errors.push(`고르기 표에 없는 단계: ${[...new Set(unplanned)].join(", ")}`);
  if (errors.length) check("단계 이름·앞 단계", false, `${errors.join("; ")} (있는 단계: ${order.join(", ")})`);
  const terminalAt = order.indexOf("terminalReady");
  let stopped = "";
  for (const [i, [name, step]] of steps.entries()) {
    if (only.length && !chosen.has(name)) continue;
    // 첫 터미널을 못 띄웠으면 그 뒤 단계는 돌지 않는다 (같은 원인의 실패가 줄줄이 나지 않게)
    if (i > terminalAt && !first) {
      log.push(`SKIP  ${name}: 첫 터미널 없음`);
      continue;
    }
    if (stopped) {
      log.push(`SKIP  ${name}: ${stopped}`);
      continue;
    }
    const start = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const hung = await Promise.race([
        Promise.resolve().then(step).then(() => false),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(true), STEP_TIMEOUT_MS))),
      ]);
      if (hung) {
        stopped = `${name}이(가) ${STEP_TIMEOUT_MS / 1000}초 안에 끝나지 않음`;
        check(`시간 초과 (${name})`, false, stopped);
      }
    } catch (e) {
      check(`예외 (${name})`, false, String(e));
    } finally {
      clearTimeout(timer);
    }
    log.push(`INFO  단계 ${name}: ${((performance.now() - start) / 1000).toFixed(1)}초`);
    // 단계가 끝난 뒤 설정이 진짜 CLI를 띄우면 (되돌리지 못함) 뒤 단계는 돌지 않는다 (리뷰 R1). 파일과 앱이 쓰는 설정을 모두 본다
    // (파일이 깨졌으면 앱은 마지막 올바른 설정을 쓴다).
    const onDisk = await invoke<Groups>("groups_load").catch(() => null);
    if (usesRealCli(onDisk) || usesRealCli(devHooks.groups)) {
      stopped = `${name} 뒤 작업그룹 설정이 테스트 설정이 아님 (진짜 claude·codex)`;
      check("테스트 설정 유지", false, stopped);
    }
  }
  await invoke("selftest_report", { ok: !failed, log: log.join("\n") });
}
