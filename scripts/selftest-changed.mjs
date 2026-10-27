#!/usr/bin/env node
// 바뀐 파일에 맞는 검사만 돌린다 (고치는 동안). 리뷰를 요청하기 전에는 전체 scripts/selftest.sh를 한 번 돌린다.
// 사용법: node scripts/selftest-changed.mjs [--plan] [--base <커밋>] [--files <a,b>] [--check]
//   기본: HEAD 대비 커밋 안 한 변경(스테이징·작업 트리)과 추적하지 않는 새 파일.
//   --base <커밋>: 그 커밋 대비 (이미 커밋한 변경까지). --plan: 고른 결과만 보이고 돌리지 않는다.
//   --files: 바뀐 파일 대신 이 목록으로 고른다 ("이 파일을 바꾸면 무엇이 도나". src/selftest.ts는 줄을 모르니 전체).
//   --check: 고르기 규칙과 표를 검사한다 (표나 이 스크립트를 고친 뒤).
// 고르기: scripts/selftest-plan.json (ignore → full → src/selftest.ts는 바뀐 줄의 함수로 → rules). 어디에도 없는 파일이
// 하나라도 있으면 전체. 고른 단계의 앞 단계(deps)는 끝까지 펼친다. TS가 바뀌면 tsc, src-tauri가 바뀌면 cargo test도 돈다.
// 고른 단계는 기본 단계(projectStart, terminalReady)와 함께 돈다 (src/selftest.ts runSelftest).
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELFTEST = "src/selftest.ts";
const SCENARIOS = ["restart", "corrupt", "resume"];

function fail(msg) {
  console.error(`selftest-changed: ${msg}`);
  process.exit(2);
}

const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 });
  } catch (e) {
    fail(`git ${args.join(" ")} 실패: ${e.stderr || e.message}`);
  }
};

// 인자
const argv = process.argv.slice(2);
let planOnly = false;
let checkOnly = false;
let filesArg;
let base = "HEAD";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--plan") planOnly = true;
  else if (argv[i] === "--check") checkOnly = true;
  else if (argv[i] === "--base" && argv[i + 1]) base = argv[++i];
  else if (argv[i] === "--files" && argv[i + 1]) filesArg = argv[++i].split(",").filter(Boolean);
  else fail(`모르는 인자: ${argv[i]} (--plan, --check, --base <커밋>, --files <a,b>)`);
}
const sha = git("rev-parse", "--verify", `${base}^{commit}`).trim();

// 바뀐 파일: 비교 기준 대비 작업 트리(스테이징 포함)와 추적하지 않는 새 파일. 이름 바꾸기는 이전·새 경로 모두
function changedFiles() {
  const files = new Set();
  const parts = git("diff", "--name-status", "-z", "-M", sha).split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    const n = /^[RC]/.test(status) ? 2 : 1;
    for (let k = 0; k < n; k++) files.add(parts[i++]);
  }
  for (const f of git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)) files.add(f);
  return [...files].sort();
}

// `**`는 /를 넘어, `*`는 한 조각 안에서
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")}$`);
const matches = (globs, f) => globs.some((g) => globRe(g).test(f));

const plan = JSON.parse(readFileSync(join(repo, "scripts/selftest-plan.json"), "utf8"));

// src/selftest.ts 읽기: TypeScript 구문 트리로 맨 위 문장마다 줄 범위와 이름을 얻는다 (줄 모양으로 찾으면 들여 쓴 선언 같은
// 것을 앞 함수의 몸통으로 잘못 봤다, 리뷰 R3). 문장 사이의 빈 줄·주석은 다음 문장에 붙인다 (주석만 고쳐도 그 함수의 단계를
// 고르게). 이름은 함수·클래스·하나만 선언한 const/let·타입만. 가져오기와 그 밖의 문장은 이름 없음 → 바뀌면 전체.
// 돌려주는 것: 단계 목록(순서), 단계 목록 줄·시나리오 줄, 단계·시나리오마다 쓰는 이름들(reach), 고르기의 바탕(core)
function analyze(text) {
  const src = text.split("\n");
  const sf = ts.createSourceFile(SELFTEST, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineAt = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const symbols = []; // { name (없으면 null), start, end } (1부터, end 포함)
  const shared = new Set(); // 맨 위 문장 둘이 함께 있는 줄 (어느 쪽인지 줄로는 가를 수 없어 바뀌면 전체, 재리뷰 R3)
  for (const st of sf.statements) {
    const prevEnd = symbols.at(-1)?.end;
    if (prevEnd !== undefined && lineAt(st.getStart()) <= prevEnd) shared.add(prevEnd);
    const decls = ts.isVariableStatement(st) ? st.declarationList.declarations : [];
    const name =
      (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) && st.name
        ? st.name.text
        : decls.length === 1 && ts.isIdentifier(decls[0].name)
          ? decls[0].name.text
          : null;
    symbols.push({ name, start: (symbols.at(-1)?.end ?? 0) + 1, end: lineAt(st.getEnd()) });
  }
  const body = (x) => src.slice(x.start - 1, x.end).join("\n");
  const runner = symbols.find((x) => x.name === "runSelftest") ?? fail(`${SELFTEST}에 runSelftest 없음`);
  const named = symbols.filter((x) => x.name);
  const names = new Set(named.map((x) => x.name));
  const refsIn = (t) => new Set([...t.matchAll(/\b\w+\b/g)].map((m) => m[0]).filter((w) => names.has(w)));
  const refs = new Map(named.map((x) => [x.name, refsIn(body(x))]));
  const closure = (roots) => {
    const seen = new Set();
    const visit = (n) => {
      if (seen.has(n)) return;
      seen.add(n);
      for (const r of refs.get(n) ?? []) visit(r);
    };
    roots.forEach(visit);
    return seen;
  };
  // runSelftest 안의 단계 목록 줄(["이름", ...])과 따로 띄우는 시나리오 줄(이름: 함수,)
  const stepLines = new Map(); // 줄 → 단계 (시나리오는 "scenario:이름")
  const order = [];
  const roots = new Map(); // 단계·시나리오 → 그 줄이 부르는 이름들
  for (let ln = runner.start; ln <= runner.end; ln++) {
    const line = src[ln - 1];
    const step = /^\s*\["(\w+)",/.exec(line);
    const single = /^\s*"?([\w-]+)"?:\s*(test\w+),?\s*$/.exec(line);
    if (step) {
      order.push(step[1]);
      stepLines.set(ln, step[1]);
      roots.set(step[1], refsIn(line));
    } else if (single) {
      const key = `scenario:${single[1].replace(/^resume-.*/, "resume")}`;
      stepLines.set(ln, key);
      roots.set(key, new Set([...(roots.get(key) ?? []), single[2]]));
    }
  }
  if (!order.length) fail(`${SELFTEST} runSelftest에서 단계 목록을 찾지 못함`);
  const reach = new Map([...roots].map(([k, r]) => [k, closure([...r])]));
  // 고르기의 바탕: runSelftest가 단계 목록 밖에서 쓰는 이름 (check, expandSteps, 표 등). 바뀌면 전체
  const coreText = src.slice(runner.start - 1, runner.end).filter((_, i) => !stepLines.has(runner.start + i)).join("\n");
  const core = closure([...refsIn(coreText)].filter((n) => n !== runner.name));
  return { src, symbols, shared, runner, stepLines, order, reach, core };
}
const A = analyze(readFileSync(join(repo, SELFTEST), "utf8"));
const order = A.order;

// 표 검사: 표의 단계·시나리오가 실제와 맞아야 한다 (오타·빠진 단계)
const known = new Set(order);
const tableSteps = [...Object.keys(plan.deps), ...Object.values(plan.deps).flat(), ...plan.rules.flatMap((r) => r.steps ?? [])];
const unknown = [...new Set(tableSteps.filter((n) => !known.has(n)))];
if (unknown.length) fail(`표에 없는 단계: ${unknown.join(", ")} (scripts/selftest-plan.json)`);
const badScenarios = plan.rules.flatMap((r) => r.scenarios ?? []).filter((n) => !SCENARIOS.includes(n));
if (badScenarios.length) fail(`모르는 시나리오: ${badScenarios.join(", ")} (${SCENARIOS.join(", ")})`);

// src/selftest.ts의 바뀐 줄 (비교 기준 대비 새 파일의 줄 번호)
function selftestDiffLines() {
  const lines = new Set();
  for (const m of git("diff", "-U0", sha, "--", SELFTEST).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [start, count] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2])];
    // 지우기만 한 곳(count 0)은 그 앞뒤 줄로 본다
    if (count === 0) [start, start + 1].forEach((l) => lines.add(l));
    for (let l = start; l < start + count; l++) lines.add(l);
  }
  return lines;
}

// 바뀐 줄 → 그 줄이 속한 이름 → 그 이름을 쓰는 단계·시나리오. 고르기의 바탕(runSelftest와 그것이 쓰는 이름, 가져오기)이면 전체
function selftestChoice(lines, a = A) {
  const { symbols, shared, runner, stepLines, reach, core } = a;
  const steps = new Set();
  const scenarios = new Set();
  const why = [];
  for (const ln of [...lines].sort((a, b) => a - b)) {
    const entry = stepLines.get(ln);
    if (entry) {
      entry.startsWith("scenario:") ? scenarios.add(entry.slice(9)) : steps.add(entry);
      continue;
    }
    if (shared.has(ln)) return { full: `${ln}줄은 맨 위 문장 둘이 함께 있는 줄` };
    const sym = symbols.find((s) => s.start <= ln && ln <= s.end);
    if (!sym?.name) return { full: `${ln}줄 (${sym ? "가져오기 등 이름 없는 문장" : "파일 끝"})은 단계를 알 수 없음` };
    if (sym === runner || core.has(sym.name)) return { full: `${ln}줄 (${sym.name})은 고르기의 바탕` };
    const users = [...reach].filter(([, r]) => r.has(sym.name)).map(([k]) => k);
    if (!users.length) return { full: `${ln}줄 (${sym.name})을 쓰는 단계를 찾지 못함` };
    for (const u of users) u.startsWith("scenario:") ? scenarios.add(u.slice(9)) : steps.add(u);
    why.push(sym.name);
  }
  return { steps, scenarios, why: [...new Set(why)].join(", ") || "단계 목록 줄" };
}

// 파일 하나의 분류: ignore | full | selftest | rules (맞는 규칙들) | null (표에 없음)
function classify(f) {
  if (matches(plan.ignore.files, f)) return { kind: "ignore" };
  if (matches(plan.full.files, f)) return { kind: "full" };
  if (f === SELFTEST) return { kind: "selftest" };
  const hit = plan.rules.filter((r) => matches(r.files, f));
  return hit.length ? { kind: "rules", hit } : null;
}

// 바뀐 파일들 → 고른 것. selftestLines: src/selftest.ts의 바뀐 줄 (그 파일이 바뀌었을 때)
function choose(files, selftestLines) {
  const report = [];
  let full = "";
  const steps = new Set();
  const scenarios = new Set();
  let tsc = false;
  let cargo = false;
  for (const f of files) {
    const c = classify(f);
    if (c?.kind === "ignore") {
      report.push([f, "건너뜀 (ignore)"]);
      continue;
    }
    if (/\.(ts|tsx)$/.test(f) || f === "tsconfig.json") tsc = true;
    if (f.startsWith("src-tauri/")) cargo = true;
    if (!c) {
      report.push([f, "전체: 표에 없는 파일"]);
      full ||= `${f}: 표에 없는 파일`;
    } else if (c.kind === "full") {
      report.push([f, "전체 (full)"]);
      full ||= `${f}: full`;
    } else if (c.kind === "selftest") {
      // 바뀐 줄을 모르면 (--files) 고를 수 없으니 전체 (리뷰 R4)
      const r = selftestLines ? selftestChoice(selftestLines) : { full: "바뀐 줄을 모름" };
      if (r.full) {
        report.push([f, `전체: ${r.full}`]);
        full ||= `${f}: ${r.full}`;
      } else {
        r.steps.forEach((x) => steps.add(x));
        r.scenarios.forEach((x) => scenarios.add(x));
        report.push([f, `${[...r.steps, ...[...r.scenarios].map((x) => `시나리오 ${x}`)].join(", ") || "없음"} (바뀐 곳: ${r.why})`]);
      }
    } else {
      for (const r of c.hit) {
        (r.steps ?? []).forEach((x) => steps.add(x));
        (r.scenarios ?? []).forEach((x) => scenarios.add(x));
      }
      report.push([f, [...new Set(c.hit.flatMap((r) => [...(r.steps ?? []), ...(r.scenarios ?? []).map((x) => `시나리오 ${x}`)]))].join(", ")]);
    }
  }
  return { report, full, steps, scenarios: SCENARIOS.filter((x) => scenarios.has(x)), tsc, cargo };
}

// 앞 단계를 끝까지 펼친다 (src/selftest.ts expandSteps와 같은 규칙). 도는 순서는 단계 목록 순서
function expand(steps) {
  const chosen = new Set();
  const visit = (n, path) => {
    if (path.includes(n)) fail(`앞 단계 순환: ${[...path, n].join(" → ")}`);
    if (chosen.has(n)) return;
    for (const d of plan.deps[n] ?? []) {
      if (order.indexOf(d) > order.indexOf(n)) fail(`앞 단계가 뒤에 있음: ${n} → ${d}`);
      visit(d, [...path, n]);
    }
    chosen.add(n);
  };
  steps.forEach((x) => visit(x, []));
  const only = order.filter((x) => chosen.has(x));
  return { only, added: only.filter((x) => !steps.has(x)) };
}

// 표에 없는 추적 파일 (그런 파일이 바뀌면 전체가 돈다. 새 파일을 만들면 표에 넣는다)
const uncovered = () => git("ls-files", "-z").split("\0").filter((f) => f && !classify(f));

// --check: 고르기 규칙 자체를 검사한다 (표·스크립트를 고친 뒤)
if (checkOnly) {
  const errors = [];
  const expect = (what, ok, detail) => (ok ? console.log(`PASS  ${what}`) : (errors.push(what), console.log(`FAIL  ${what}  (${detail})`)));
  const show = (c) => JSON.stringify({ full: c.full, steps: [...c.steps], scenarios: c.scenarios, tsc: c.tsc, cargo: c.cargo });
  const lineOf = (name) => {
    const at = A.src.findIndex((l) => new RegExp(`^(export )?(async )?function ${name}\\(`).test(l));
    return at >= 0 ? at + 2 : fail(`--check: ${name} 없음`);
  };
  const stepLine = (step) => [...A.stepLines].find(([, x]) => x === step)[0];
  let c = choose(["no/such/file.xyz"]);
  expect("표에 없는 파일은 전체", c.full.includes("표에 없는 파일"), show(c));
  c = choose(["docs/spec.md", "README.md"]);
  expect("문서만 바뀌면 아무것도 돌지 않음", !c.full && !c.steps.size && !c.scenarios.length && !c.tsc && !c.cargo, show(c));
  c = choose(["src/dragPath.ts"]);
  expect("규칙의 파일은 그 단계와 tsc", !c.full && [...c.steps].join() === "trashDrag" && c.tsc && !c.cargo, show(c));
  c = choose(["src-tauri/src/fs.rs"]);
  expect("Rust 파일은 그 명령을 쓰는 단계 모두와 cargo test", !c.full && ["tree", "trashDrag", "docView"].every((x) => c.steps.has(x)) && c.cargo, show(c));
  c = choose(["src-tauri/src/groups.rs"]);
  expect("시나리오도 고름", c.scenarios.join() === "restart,corrupt,resume", show(c));
  c = choose(["src/dragPath.ts", "src/App.tsx"]);
  expect("하나라도 full이면 전체", !!c.full, show(c));
  const e = expand(new Set(["gitGraph"]));
  expect("앞 단계를 끝까지 펼침 (순서는 단계 목록대로)", e.only.join() === "repos,groupWorktree,groupClone,groupEnd,gitGraph", e.only.join());
  c = choose([SELFTEST], new Set([lineOf("testTrashAndDrag")]));
  expect("src/selftest.ts: 단계 함수 안을 고치면 그 단계", !c.full && [...c.steps].join() === "trashDrag", show(c));
  c = choose([SELFTEST], new Set([stepLine("docView")]));
  expect("src/selftest.ts: 단계 목록의 한 줄이면 그 단계", !c.full && [...c.steps].join() === "docView", show(c));
  c = choose([SELFTEST], new Set([lineOf("testRestart")]));
  expect("src/selftest.ts: 따로 띄우는 시나리오 함수면 그 시나리오", !c.full && !c.steps.size && c.scenarios.join() === "restart", show(c));
  c = choose([SELFTEST], new Set([lineOf("check")]));
  expect("src/selftest.ts: 고르기의 바탕(check)이면 전체", !!c.full, show(c));
  const runnerLine = A.src.findIndex((l, i) => i + 1 > A.runner.start && l.includes("if (single[scenario])")) + 1;
  c = choose([SELFTEST], new Set([runnerLine]));
  expect("src/selftest.ts: runSelftest 안(단계 목록 밖)이면 전체", !!c.full, show(c));
  c = choose([SELFTEST], new Set([1]));
  expect("src/selftest.ts: 가져오기면 전체", !!c.full, show(c));
  c = choose([SELFTEST]);
  expect("src/selftest.ts: 바뀐 줄을 모르면(--files) 전체", !!c.full, show(c));
  // 줄 모양이 아니라 구문으로 범위를 본다 (리뷰 R3): 들여 쓴 함수 선언과 그 안의 새 줄은 그 함수의 단계, 이름 없는 맨 위
  // 문장(식 등)은 전체
  const at = A.src.findIndex((l) => l.startsWith("async function testTrashAndDrag("));
  const edited = [...A.src.slice(0, at), `  ${A.src[at]}`, '  throw new Error("x");', ...A.src.slice(at + 1)];
  let r = selftestChoice(new Set([at + 1, at + 2]), analyze(edited.join("\n")));
  expect("src/selftest.ts: 들여 쓴 선언 안을 고쳐도 그 함수의 단계", !r.full && [...r.steps].join() === "trashDrag", JSON.stringify({ ...r, steps: [...(r.steps ?? [])] }));
  // 앞 함수의 닫는 괄호와 같은 줄에 선언이 오면 (재리뷰 R3)
  const close = A.src.slice(0, at).findLastIndex((l) => l === "}");
  const joined = [...A.src.slice(0, close), `} ${A.src[at]} throw new Error("x");`, ...A.src.slice(at + 1)];
  r = selftestChoice(new Set([close + 1]), analyze(joined.join("\n")));
  expect("src/selftest.ts: 맨 위 문장 둘이 한 줄에 있으면 전체", !!r.full, JSON.stringify({ ...r, steps: [...(r.steps ?? [])] }));
  const stray = [...A.src.slice(0, at), "console.log(1);", ...A.src.slice(at)];
  r = selftestChoice(new Set([at + 1]), analyze(stray.join("\n")));
  expect("src/selftest.ts: 이름 없는 맨 위 문장이면 전체", !!r.full, JSON.stringify(r));
  c = choose(["src/Sidebar.tsx"]);
  expect("사이드바는 작업그룹 트리·안 읽은 수 배지를 보는 단계까지 (groupWorktree, addSession)", ["tree", "groupWorktree", "addSession"].every((x) => c.steps.has(x)), show(c));
  c = choose(["src/mobile/public/sw.js"]);
  expect("서비스 워커는 그것을 실행하는 단계 (mobilePushUnit)", !c.full && c.steps.has("mobilePushUnit"), show(c));
  const missing = uncovered();
  expect("추적하는 파일이 모두 표에 있음", !missing.length, missing.join(", "));
  console.log(errors.length ? `\n${errors.length}개 실패` : "\n모두 통과");
  process.exit(errors.length ? 1 : 0);
}

const files = filesArg ?? changedFiles();
const { report, full, steps, scenarios: scenarioList, tsc, cargo } = choose(files, files.includes(SELFTEST) && !filesArg ? selftestDiffLines() : undefined);
const { only, added } = expand(steps);
const missing = uncovered();
if (missing.length) console.log(`알림: 표에 없는 추적 파일 ${missing.length}개 (바뀌면 전체가 돈다): ${missing.join(", ")}`);

console.log(`비교 기준: ${base} (${sha.slice(0, 12)}), 바뀐 파일 ${files.length}개`);
for (const [f, r] of report) console.log(`  ${f} → ${r}`);
if (full) console.log(`자체 테스트: 전체 (${full})`);
else if (!only.length && !scenarioList.length) console.log("자체 테스트: 고른 단계 없음 → 건너뜀");
else {
  console.log(`자체 테스트 main 단계: ${only.length ? only.join(" ") : "(없음, main 건너뜀)"}${added.length ? ` (앞 단계로 더함: ${added.join(" ")})` : ""}`);
  console.log(`다른 시나리오: ${scenarioList.join(" ") || "없음"}`);
}
console.log(`tsc: ${tsc ? "돈다" : "안 돈다"}, cargo test: ${cargo ? "돈다" : "안 돈다"}`);
if (planOnly) process.exit(0);

const results = [];
const exec = (label, cmd, args, opts = {}) => {
  console.log(`\n=== ${label}: ${[cmd, ...args].join(" ")}`);
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: repo, stdio: "inherit", ...opts });
  results.push([label, r.status === 0, ((Date.now() - t0) / 1000).toFixed(0)]);
};
if (tsc) exec("tsc", "npx", ["tsc", "--noEmit", "-p", "."]);
if (cargo) exec("cargo test", "cargo", ["test"], { cwd: join(repo, "src-tauri") });
const env = { ...process.env };
delete env.SELFTEST_ONLY;
delete env.SELFTEST_SCENARIOS;
if (full) exec("자체 테스트 (전체)", "scripts/selftest.sh", [], { env });
else if (only.length || scenarioList.length) {
  env.SELFTEST_SCENARIOS = [...(only.length ? ["main"] : []), ...scenarioList].join(" ");
  env.SELFTEST_ONLY = only.join(" ");
  exec(`자체 테스트 (${env.SELFTEST_SCENARIOS})`, "scripts/selftest.sh", [], { env });
}
console.log("\n=== 결과");
for (const [label, ok, sec] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${label} (${sec}초)`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
