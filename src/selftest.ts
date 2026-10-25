// 실제 앱 안에서 도는 자체 테스트. scripts/selftest.sh로 실행한다.
// 테스트용 폴더 구조는 그 스크립트가 만든다.
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { devHooks, liveTerms } from "./devHooks";
import { isTerminalReply } from "./Terminal";
import { fixImeInput } from "./hangul";
import { LOCALES } from "./i18n";
import { en } from "./i18n/en";
import { fromSaved } from "./workspaceState";
import { screenPixelRatio } from "./zoom";

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
async function frameInfo() {
  const t0 = performance.now();
  await new Promise((r) => requestAnimationFrame(r));
  return `focus=${document.hasFocus()} vis=${document.visibilityState} raf=${Math.round(performance.now() - t0)}ms`;
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

async function testTerminal(root: string) {
  const term = await waitFor("터미널 생성", () => visiblePanes()[0]?.term);
  await ready(term);

  const pwd = await run(term, "pwd");
  check("터미널: 작업 폴더가 루트", pwd.some((l) => l.trim() === root), pwd.join("|"));

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

  return term;
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
  await clickMenu("View", "Theme", "Dark");
  await waitFor("기본값 복귀", () => document.documentElement.lang === "en" && document.documentElement.dataset.theme === "dark");
  await waitFor("터미널 다크", () => termBg("#1F1F1F"), 3000).catch(() => {});
  check("테마: 다크로 돌아오면 터미널도 다크", termBg("#1F1F1F"));
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
  // 번짐 방지: 터미널 캔버스 해상도가 (CSS 크기 × 배율 × 화면 픽셀 비율)이어야 늘어나지 않고 그려진다.
  const sharp = () => {
    const canvas = term.element!.querySelector<HTMLCanvasElement>(".xterm-screen > canvas:not(.xterm-link-layer)");
    if (!canvas) return "WebGL 캔버스 없음";
    const want = canvas.getBoundingClientRect().width * Number(localStorage.getItem("ddak.zoom") ?? 1) * screenPixelRatio();
    return Math.abs(canvas.width - want) <= 2 ? "" : `canvas ${canvas.width}px, want ${Math.round(want)}px`;
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
  // 세션이 아닌 창은 Shift+Enter를 바꾸지 않는다 (Vim 등에서 ESC가 모드를 바꿔서. 리뷰 지적 7)
  const se = keySends(second.term, { key: "Enter", shiftKey: true });
  check("탭: 세션이 아닌 창의 ⇧↩는 그냥 Enter", se === "\r", JSON.stringify(se));

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
  await invoke("chat_post", { project: other, text: "early message" });
  devHooks.chatListenDelay = undefined;
  await waitFor("처음 읽기 전에 온 메시지", () => [...otherChat()!.querySelectorAll(".chat-text")].some((el) => el.textContent === "early message"), 4000).then(
    () => check("채팅 패널: 이벤트를 등록하기 전에 온 메시지도 보임", true),
    () => check("채팅 패널: 이벤트를 등록하기 전에 온 메시지도 보임", false, otherChat()!.textContent ?? ""),
  );
  await waitFor("읽기 끝", () => tabsIn(other) === 1, 5000);
  await sleep(500);
  const noRepos = [...document.querySelectorAll(".sidebar-error")].some((e) => e.textContent?.includes("no git repository"));
  check("프로젝트: 저장한 상태를 읽는 동안 새 작업그룹은 만들지 않음", !noRepos);
  await waitFor("두 번째 프로젝트 활성", () => projectRow(other)?.classList.contains("active"));
  check("프로젝트: 추가 순서대로 목록", projectRows().map((el) => el.dataset.project).join(",") === `${root},${other}`);
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
  check("프로젝트: 목록과 활성 프로젝트 저장", store.projects.map((p) => p.path).join(",") === `${root},${other}` && store.active === root, JSON.stringify(store));

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
  const firstRead = await waitFor("처음 읽기", () => [...(otherPanel()?.querySelectorAll(".chat-text") ?? [])].some((el) => el.textContent === "early message"), 3000).catch(() => false);
  devHooks.chatListenFail = undefined;
  await removeOther();
  await sleep(300);
  const reads = () => devHooks.chatLoads?.[other] ?? 0;
  const readsBefore = reads();
  await invoke("chat_post", { project: other, text: "after removal" });
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
const TEST_GROUPS = `{"default":"test","groups":[{"id":"test","name":"Test","sessions":[{"name":"shell","shiftEnter":"\\u001b\\r"}]}]}`;
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
  // 뒤의 시나리오가 새 프로젝트를 열 때 진짜 claude·codex가 뜨지 않게 테스트 설정으로 되돌린다.
  await write(testConfig);
  await waitFor("테스트 설정 복귀", () => devHooks.groups?.default === "test", 3000);
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
}

// 터미널 자동 응답 판별 (깨우기의 사용자 입력에서 뺀다, src/Terminal.tsx isTerminalReply)
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
  check("이름 바꾸기: 파일 메뉴에 항목", menuLabels().join(",") === "New File…,New Folder…,-,Rename…", menuLabels().join(","));
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

  // 작업그룹 탭 닫기 (worktree는 남긴다: 정리는 6단계)
  for (let i = 0; i < 5; i++) await menu("close_pane"); // test-3 (세션 + 시작 못 한 setup), test-2 (세션 + setup), test-1
  await waitFor("작업그룹 탭 닫기", () => tabCount() === before, 5000);
}

// 작업그룹 준비…: 원본의 커밋 안 된 node_modules를 골라 두면 새 작업그룹에 복제한다 (src-tauri/src/clone.rs).
// 이때 작업그룹 폴더는 test-1~3이 있고 준비 스크립트는 testGroupWorktree가 넣은 것 (SETUP_OK로 끝남).
// 터미널을 넷 더 만들므로 WebGL 검사 뒤에 둔다 (컨텍스트가 많으면 가장 오래된 첫 터미널의 것을 잃는다).
async function testGroupClone(root: string, first: Terminal) {
  const sh = async (cmd: string, ms?: number) => (await run(first, cmd, ms)).map((l) => l.trim()).filter(Boolean);
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
  const g4 = `${groups}test-4/server/node_modules`;
  const env = await sh(`cat "${groups}test-4/server/.env"; echo; grep '^home' "${groups}test-4/server/.venv/pyvenv.cfg"; grep '^home' "${root}/server/.venv/pyvenv.cfg"; test -x "${groups}test-4/server/.venv/bin/python" && echo py-ok`);
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
  const [, setup5] = await waitFor("건너뛴 뒤 세션", () => visiblePanes().length === 2 && visiblePanes(), 40000);
  const out5 = screen(setup5.term).join("\n");
  const left = await sh(`test -e "${groups}test-5/server/node_modules" && echo there || echo none`);
  check(
    "작업그룹 복제: lockfile이 다르면 건너뛰고 알림, 세션은 뜸",
    out5.includes("skipped server/node_modules: server/package-lock.json differs") && left.includes("none"),
    `${out5.slice(-300)} ${left.join("|")}`,
  );
  check("작업그룹 준비: 복제를 건너뛰었으면 npm ci를 돌림", out5.includes("[ddak] running server: npm ci") && out5.includes("up to date"), out5.slice(-300));
  await sh(`cd "${root}/server" && git checkout -q package-lock.json && rm -rf node_modules .venv .env && cd - > /dev/null`);
  for (let i = 0; i < 4; i++) await menu("close_pane"); // test-5, test-4 (세션 + setup)
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
  const pick = `{"name":"writer","command":"echo","args":["WRITER-UP"]},{"name":"reviewer","command":"echo","args":["REVIEWER-UP"],"readOnly":true},${poster},${listener},${chatter}`;
  // tty 한 줄은 1024바이트까지라 두 번에 나눠 쓰고 옮긴다 (쓰는 도중의 반쪽 파일을 읽지 않게)
  const content = TEST_GROUPS.replace(/]}$/, `,{"id":"pick","name":"Pick","sessions":[${pick}]}]}`);
  const half = Math.ceil(content.length / 2);
  await run(first, `printf '%s' '${content.slice(0, half)}' > "${file}.part"`);
  await run(first, `printf '%s' '${content.slice(half)}' >> "${file}.part" && mv "${file}.part" "${file}"`);
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
    listed === "test/shell,pick/writer,pick/reviewer,pick/poster,pick/listener,pick/chatter" && labels() === "-,writer" && writer.el.contains(document.activeElement) && writer.rect.left > visiblePanes()[0].rect.left,
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

  await testChatPanel(root, open, choose);

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

  toggle().click();
  await waitFor("채팅 패널", () => shown() && panel()!.querySelector(".chat-msg"), 5000);
  const first = panel()!.querySelector<HTMLElement>(".chat-msg")!;
  const chips = [...panel()!.querySelectorAll<HTMLElement>(".chat-member")].map((el) => el.dataset.member).join(",");
  check(
    "채팅 패널: 탭 바 버튼으로 열고, 세션이 보낸 메시지(나에게)와 참여자를 보임, 입력란에 포커스",
    first.querySelector(".chat-from")?.textContent === "origin/poster" && /^\d\d:\d\d( [AP]M)?$/.test(first.querySelector("time")?.textContent ?? "") && first.classList.contains("to-me") && first.querySelector(".chat-text")?.textContent === "@user hello from poster" &&
      chips === "origin/poster,origin/reviewer,origin/writer,origin/writer-2" && document.activeElement === input(),
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
  type("slow one");
  enter(13);
  await sleep(100);
  type("next draft");
  await waitAsync("늦게 보낸 메시지", async () => (await stored()).some((m) => m.text === "slow one"), 5000).catch(() => null);
  await sleep(200);
  devHooks.chatPostDelay = undefined;
  check("채팅 패널: 보내는 동안 새로 쓴 초안은 남음", input().value === "next draft", input().value);
  // 아무도 멘션하지 않은 사용자 메시지는 모두에게 (매번 @all을 치지 않게)
  const slow = (await stored()).find((m) => m.text === "slow one");
  check("채팅 패널: 멘션 없는 메시지는 모두에게", slow?.to.join(",") === chips, `${slow?.to.join(",")} / ${chips}`);
  type("");

  // 닫으면 선택된 터미널로 포커스가 돌아간다 (리뷰 P2: 숨은 입력란에 남았다)
  const terminalFocused = () => !!document.activeElement?.classList.contains("xterm-helper-textarea") && !!ws().querySelector(".tab-body:not([style*='none'])")?.contains(document.activeElement);
  input().focus();
  panel()!.querySelector<HTMLElement>(".chat-close")!.click();
  await waitFor("채팅 닫기", () => !shown(), 2000);
  await waitFor("터미널 포커스", terminalFocused, 2000).catch(() => null);
  check("채팅 패널: × 로 닫으면 터미널로 포커스", terminalFocused(), document.activeElement?.className ?? "");

  // 닫아 두고 새 poster를 더하면 그 poster가 "@user ..."를 보낸다 → 버튼에 점, 열면 사라짐
  await openAdd("menu");
  choose("pick/poster");
  await waitFor("나에게 온 메시지 표시", () => toggle().classList.contains("unread"), 10000).then(
    () => check("채팅 패널: 닫혀 있는 동안 나에게 온 메시지는 버튼에 점", true),
    () => check("채팅 패널: 닫혀 있는 동안 나에게 온 메시지는 버튼에 점", false, toggle().className),
  );
  toggle().click();
  await waitFor("다시 열기", shown, 2000);
  check("채팅 패널: 열면 점이 사라짐", !toggle().classList.contains("unread"), toggle().className);

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
  await waitFor("멈춤 표시", pausedBar, 3000).catch(() => null);
  await waitFor("허용된 알림", () => fromChatter() > 0, WAKE_IDLE_MS + 4000).catch(() => null);
  await sleep(WAKE_IDLE_MS + 1000);
  const beforeResume = fromChatter();
  const toldChatter = screen(chatterPane.term).some((l) => l.includes("nobody was notified: automatic notifications for your work group are paused"));
  // 깨우지 않음 표시는 7번째 메시지에만
  const heldTag = panel()!.querySelectorAll(".chat-msg [data-held]").length === 1 && !!panel()!.querySelector(".chat-msg:last-of-type [data-held]");
  check(
    "깨우기 제한: 세션끼리 6개까지 깨우고 7번째는 저장만 (보낸 세션에 알림, 패널에 멈춤·깨우지 않음 표시)",
    sent7.length === 7 && sent7.filter((m) => m.held).length === 1 && !!sent7[6].held && beforeResume > 0 && toldChatter && heldTag && !!pausedBar(),
    `${sent7.map((m) => !!m.held).join(",")} told=${toldChatter} tag=${heldTag} bar=${!!pausedBar()} wakes=${beforeResume}`,
  );
  pausedBar()?.querySelector("button")?.click();
  const resumed = await waitFor("재개 뒤 깨움", () => fromChatter() === beforeResume + 1, WAKE_IDLE_MS + 4000).then(() => true, () => false);
  await sleep(1000);
  check(
    "깨우기 제한: 재개하면 멈춤 표시가 사라지고 보류된 알림을 받는 사람에게 한 번 알림",
    resumed && fromChatter() === beforeResume + 1 && !pausedBar(),
    `${beforeResume}→${fromChatter()} bar=${!!pausedBar()}`,
  );

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
  const headRow = rows().find((r) => r.querySelector(".git-ref.head"));
  check(
    "Git Graph: 커밋과 참조(브랜치·HEAD), 원본 탭(작업그룹)과 세션을 HEAD 커밋에 표시",
    chips(kept, "branch").includes(`ddak/${"test-6"}`) && !!headRow && chips(headRow, "group").some((g) => g?.startsWith("Test · shell")),
    `${chips(kept, "branch")} | ${chips(headRow, "group")}`,
  );

  // 원본에 커밋하면 다시 읽는다 (참조가 바뀜)
  await run(first, `git -C "${root}/server" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m graph-live`);
  const live = await waitFor("새 커밋", () => row("graph-live"), 8000).catch(() => undefined);
  check("Git Graph: 참조가 바뀌면 다시 읽어 새 커밋을 보임 (HEAD)", !!live && chips(live, "head").length === 1, rows()[0]?.textContent ?? "");

  // 새 worktree로 만든 작업그룹: 그 worktree가 있는 커밋(원본 HEAD에서 시작)에 그 탭 이름과 세션을 붙인다
  const tabsBefore = tabCount();
  await clickMenu("Terminal", "New Work Group");
  await waitFor("새 작업그룹", () => tabCount() === tabsBefore + 1 && !view(), 60000);
  const groupTab = activeTabEl()!;
  const groupName = groupTab.querySelector(".tab-title")!.textContent!;
  gitBtn().click();
  const tagged = await waitFor("작업그룹 표시", () => rows().find((r) => chips(r, "group").includes(`${groupName} · shell`)), 8000).catch(() => undefined);
  check("Git Graph: 새 worktree 작업그룹의 탭 이름·세션을 그 worktree의 커밋에 표시", tagged === row("graph-live") && chips(tagged, "branch").includes(`ddak/${groupName}`), `${groupName} ${chips(tagged, "group")} ${chips(tagged, "branch")}`);
  groupTab.querySelector<HTMLElement>("[title='Close Tab']")!.click();
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
  const labels = panes.map((p) => p.el.querySelector(".pane-label")?.textContent);
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
  check("다시 켜기: 저장된 목록을 불러옴", projectRows().map((el) => el.dataset.project).join(",") === `${root},${gone}`);
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
  const label = (p: (typeof panes)[number]) => p.el.querySelector(".pane-label")?.textContent ?? "";
  check("복원: 분할과 세션 자리 (keeps | 셸 | fresh)", label(keeps) === "keeps" && label(shell) === "" && label(fresh) === "fresh", panes.map(label).join(","));
  await ready(shell.term);
  const facts = await savedFacts(shell.term, root);
  const sid = (name: string) => facts.find((l) => l.startsWith(`SID ${name} `))?.split(" ")[2] ?? "?";
  await waitFor("이어서 하기", () => screen(keeps.term).some((l) => l.trim() === `RESUMED ${sid("keeps")}`), 10000).then(
    () => check("복원: 세션을 이어서 하기 인자(같은 세션 ID)로 띄움", true),
    () => check("복원: 세션을 이어서 하기 인자(같은 세션 ID)로 띄움", false, screen(keeps.term).join("|").slice(-200)),
  );
  // 이어서 하기가 실패하면 새로 시작할지 묻고, y일 때만 처음 인자로 (리뷰 P2: 쓰다가 끝난 것과 구분할 수 없어서)
  const asked = await waitFor("새로 시작할지 묻기", () => screen(fresh.term).find((l) => l.includes("Start a new one? [y/N]")), 10000).catch(() => "");
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
  check("작업그룹: 명령 없는 세션(셸)", g.groups[1].sessions[0].command === "" && g.groups[1].sessions[0].args.length === 0);
}

export async function runSelftest(root: string, scenario: string) {
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
  for (const step of [() => testProjectStart(root), testTree, async () => {
    const first = await testTerminal(root);
    await testWatch(root, first);
    await testRepos(root, first);
    await testCreate(root, first);
    await testRename(root, first);
    await testImeUnit();
    testTerminalReplyUnit();
    testWorkspaceStateUnit();
    await testGroups(first);
    await testGroupWorktree(root, first);
    await testTabRename();
    await testPrefs();
    await testZoom(first);
    await testClaude(first);
    await testTabsAndSplits(root, first);
    await testWebglLoss(first);
    // 탭을 많이 열면 앞 터미널의 WebGL 컨텍스트가 밀려나므로 WebGL·배율 검사 뒤에 둔다
    await testGroupClone(root, first);
    await testGroupEnd(root, first);
    await testAddSession(root, first);
    await testGitGraph(root, first);
    await testTabMove();
    await testTabScroll();
    await testManyTerminals(20);
    await testProjects(root, first);
    await testLastExit(first);
  }]) {
    try {
      await step();
    } catch (e) {
      check("예외", false, String(e));
    }
  }
  await invoke("selftest_report", { ok: !failed, log: log.join("\n") });
}
