#!/usr/bin/env node
// 데스크톱 빌드 결과(dist/assets/*.js) 검사. `npm run build`가 vite build 뒤에 돌린다 (tauri build의 beforeBuildCommand).
// 자체 테스트는 개발판(tauri dev, 압축하지 않음)이라 압축한 번들에서만 생기는 문제를 잡지 못해서 여기서 본다.
//
// esbuild 0.25의 압축(minifySyntax)이 ||= 를 es2020 이하로 낮출 때 선언(let r)을 지워서 `void 0||(r={})`(선언 안 된 변수에
// 대입)를 만든다. xterm.js 6 requestMode(DECRQM 응답)가 이 모양이 되어, codex 0.172처럼 시작할 때 DECRQM을 묻는 프로그램을
// 띄우면 ReferenceError로 그 터미널이 멈췄다 (docs/reviews/2026-11-25-bundle-target.md). 빌드 목표를 es2021로 두어
// ||= 를 낮추지 않는다 (vite.config.ts build.target). 아래 둘을 본다:
//   1. 깨진 모양 `(void 0||(` 또는 `,void 0||(`가 없다 (정상 코드는 `x===void 0||(…)`처럼 앞에 비교가 온다).
//   2. xterm requestMode의 ||= 가 낮춰지지 않고 남아 있다 (빌드 목표가 적용됐는지).
// 공백은 무시한다 (압축 안 한 번들에도 쓸 수 있게).
// 사용: node scripts/check-bundle.mjs [dist 폴더, 기본 dist]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.argv[2] ?? "dist", "assets");
const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
const problems = [];
let requestMode = false;
for (const f of files) {
  const text = readFileSync(join(dir, f), "utf8");
  for (const m of text.matchAll(/[(,]\s*void 0\s*\|\|\s*\(/g)) {
    problems.push(`${f}: 선언이 지워진 ||= 낮추기: …${text.slice(Math.max(0, m.index - 60), m.index + 40)}…`);
  }
  // xterm requestMode: DECRQM 응답 값(enum)을 ||= 로 만드는 자리
  const at = text.search(/=\s*"PERMANENTLY_RESET"/);
  if (at >= 0) {
    const near = text.slice(at, at + 100);
    if (/^=\s*"PERMANENTLY_RESET"\s*\)\s*\)\s*\(\s*[A-Za-z_$][\w$]*\s*\|\|=\s*\{\s*\}\s*\)/.test(near)) requestMode = true;
    else problems.push(`${f}: xterm requestMode의 ||= 가 낮춰짐 (빌드 목표 확인): …${near}…`);
  }
}
if (files.length === 0) problems.push(`${dir}: js 파일이 없음`);
else if (!requestMode && !problems.some((p) => p.includes("requestMode"))) problems.push("xterm requestMode 자리를 찾지 못함 (검사를 고쳐야 함)");

if (problems.length) {
  console.error("번들 검사 실패 (scripts/check-bundle.mjs):");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`번들 검사 통과: ${files.length}개 파일, xterm requestMode의 ||= 남음`);
