// 실제 앱 안에서 도는 자체 테스트. scripts/selftest.sh로 실행한다.
// 테스트용 폴더 구조는 그 스크립트가 만든다.
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { Terminal } from "@xterm/xterm";
import { liveTerms } from "./devHooks";
import { LOCALES } from "./i18n";
import { en } from "./i18n/en";

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

const rowNames = () => [...document.querySelectorAll(".tree-row")].map((el) => el.lastChild!.textContent!);

async function testTree(root: string) {
  const names = await waitFor("트리 표시", () => rowNames().length > 0 && rowNames());
  check("트리: 폴더 먼저, 대소문자 무시 정렬", names.join(",") === "A_dir,b_dir,a.txt,z.txt", names.join(","));
  check("트리: 루트 이름 표시", document.querySelector(".tree-title")?.textContent === root.split("/").pop());

  const aDir = [...document.querySelectorAll<HTMLElement>(".tree-row")].find((el) => el.lastChild!.textContent === "A_dir")!;
  aDir.click();
  const opened = await waitFor("폴더 펼치기", () => rowNames().includes("inner.txt") && rowNames());
  check("트리: 클릭하면 펼쳐짐", opened.indexOf("inner.txt") === opened.indexOf("A_dir") + 1, opened.join(","));
  aDir.click();
  await waitFor("폴더 접기", () => !rowNames().includes("inner.txt"));
  check("트리: 다시 클릭하면 접힘", true);
}

// 명령을 보내고 앞뒤에 찍은 표시 사이의 출력을 돌려준다.
// 입력 줄에는 표시가 따옴표로 쪼개져 있어서 출력 줄과 구분된다.
async function run(term: Terminal, cmd: string, ms = 10000) {
  const tag = Math.random().toString(36).slice(2, 8);
  const [begin, end] = [`DDAKB${tag}`, `DDAKE${tag}`];
  const mark = (t: string) => `echo "${t.slice(0, 5)}""${t.slice(5)}"`;
  term.input(`${mark(begin)}; ${cmd}; ${mark(end)}\r`);
  const lines = await waitFor(`명령 완료: ${cmd}`, () => {
    const s = screen(term);
    return s.some((l) => l.trim() === end) && s;
  }, ms);
  return lines.slice(lines.findIndex((l) => l.trim() === begin) + 1, lines.findIndex((l) => l.trim() === end));
}

// 지금 보이는 탭의 터미널들. 화면에 놓인 순서(위→아래, 왼→오른)대로.
function visiblePanes() {
  return [...document.querySelectorAll<HTMLElement>(".pane")]
    .filter((el) => el.offsetParent !== null)
    .map((el) => ({ el, rect: el.getBoundingClientRect(), term: liveTerms.get(el.querySelector(".terminal")!)! }))
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
}
const tabCount = () => document.querySelectorAll(".tab").length;
const activeTabIndex = () => [...document.querySelectorAll(".tab")].findIndex((el) => el.classList.contains("active"));
const menu = (id: string) => emit("menu", id);
const key = (k: string, code: string, shift = false) =>
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, metaKey: true, shiftKey: shift, bubbles: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ready = (term: Terminal) => waitFor("셸 프롬프트", () => screen(term).some((l) => l.trim() !== ""), 15000);
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

  const locale = await run(term, "locale charmap");
  check("터미널: UTF-8 로캘", locale.some((l) => l.trim() === "UTF-8"), locale.join("|"));

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
  check("테마: 열린 터미널 색도 바뀜", terms.length > 0 && terms.every((tm) => tm.options.theme?.background === "#FDF6E3"));
  const sMenu = await waitMenu((m) => m.includes("보기/테마/Solarized Light [x]"));
  check("메뉴: 테마 선택 표시", sMenu.includes("보기/테마/Solarized Light [x]") && sMenu.includes("보기/테마/다크"));
  check("설정: 언어·테마 저장", localStorage.getItem("ddak.locale") === "ko" && localStorage.getItem("ddak.theme") === "solarized-light");

  await clickMenu("보기", "테마", "Solarized Light");
  const againKo = await waitMenu((m) => m.includes("보기/테마/Solarized Light [x]"));
  check("메뉴: 한국어 메뉴에서도 다시 눌러 체크 유지", againKo.includes("보기/테마/Solarized Light [x]"));

  await clickMenu("보기", "언어", "English");
  await waitMenu((m) => m.includes("View/")); // 메뉴가 영어로 다시 만들어진 뒤에 누른다
  await clickMenu("View", "Theme", "Dark");
  await waitFor("기본값 복귀", () => document.documentElement.lang === "en" && document.documentElement.dataset.theme === "dark");
  check("테마: 다크로 돌아오면 터미널도 다크", terms.every((tm) => tm.options.theme?.background === "#1F1F1F"));
}

async function testTabsAndSplits(root: string, first: Terminal) {
  await run(first, "echo FIRST_TAB_MARK");
  const fullCols = first.cols;

  // 새 탭
  await menu("new_tab");
  await waitFor("새 탭", () => tabCount() === 2);
  const [second] = await waitFor("새 탭 터미널", () => visiblePanes()[0]?.term !== first && visiblePanes());
  check("탭: ⌘T로 새 탭이 열리고 활성화", activeTabIndex() === 1 && visiblePanes().length === 1);
  await waitFor("새 탭 포커스", () => document.activeElement === second.term.textarea, 3000).then(
    () => check("탭: 새 터미널에 포커스", true),
    (e) => check("탭: 새 터미널에 포커스", false, String(e)),
  );
  await ready(second.term);
  const pwd = await run(second.term, "pwd");
  check("탭: 새 탭도 루트에서 시작", pwd.some((l) => l.trim() === root), pwd.join("|"));

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
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: body.left + body.width * 0.3, clientY: body.top + 10 }));
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
  before.gl.getExtension("WEBGL_lose_context")!.loseContext();
  // xterm은 3초 동안 복구를 기다린 뒤 onContextLoss를 보낸다.
  await waitFor("기본 렌더러 전환", () => webglState(term).dom, 8000).then(
    () => check("WebGL: 컨텍스트를 잃으면 기본 렌더러로 전환", true),
    (e) => check("WebGL: 컨텍스트를 잃으면 기본 렌더러로 전환", false, String(e)),
  );
  await run(term, "echo AFTER_LOSS");
  // 버퍼에 들어온 뒤 DOM 렌더러가 다음 화면 갱신 때 그리므로 기다린다.
  const rows = () => term.element!.querySelector(".xterm-rows")?.textContent ?? "";
  await waitFor("DOM에 그려짐", () => rows().includes("AFTER_LOSS"), 3000).then(
    () => check("WebGL: 전환 후에도 새 출력이 화면에 그려짐", true),
    (e) => check("WebGL: 전환 후에도 새 출력이 화면에 그려짐", false, String(e)),
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

async function testLastExit(first: Terminal) {
  first.input("exit\r");
  await waitFor("빈 화면", () => document.querySelector(".workspace-empty"), 10000);
  check("닫기: 모든 터미널을 닫으면 빈 화면", true);
  document.querySelector<HTMLElement>(".workspace-empty button")!.click();
  const term = await waitFor("다시 열기", () => visiblePanes()[0]?.term);
  await ready(term);
  check("닫기: 빈 화면에서 새 터미널", tabCount() === 1);
}

export async function runSelftest(root: string) {
  for (const step of [() => testTree(root), async () => {
    const first = await testTerminal(root);
    await testPrefs();
    await testClaude(first);
    await testTabsAndSplits(root, first);
    await testWebglLoss(first);
    await testManyTerminals(20);
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
