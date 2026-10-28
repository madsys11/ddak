import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IS_WINDOWS } from "./platform";

// 파일 트리의 git 표시 (docs/spec.md "사이드바 · 파일 트리", src-tauri/src/git.rs git_status).
// 저장소마다 바뀐 파일 목록을 한 번만 읽어 그 저장소의 펼친 폴더들이 함께 쓴다. 보고 있는 동안 몇 초마다 다시 읽는다
// (파일 내용 수정·git add·commit은 폴더 감시에 안 잡힌다).

// M 수정, A 추가(스테이징), U 추적 안 함, D 삭제, R 이름 바뀜, ! 충돌
export type GitCode = "M" | "A" | "U" | "D" | "R" | "!";
type Place = { root: string; prefix: string };
type Files = [string, GitCode][];
// subs: 펼친 폴더마다 (알릴 함수 → 그 폴더 위치). 위치는 추적 안 하는 폴더 안을 더 읽는 데 쓴다 (git.rs status)
type Repo = { files: Files | null; subs: Map<(files: Files) => void, string>; timer?: ReturnType<typeof setInterval>; busy: boolean; again: boolean };

export const GIT_POLL_MS = 3000;
const repos = new Map<string, Repo>();

function load(root: string, repo: Repo) {
  // 읽는 중에 다시 부르면 끝난 뒤 한 번 더 (그동안 펼친 폴더가 늘었을 수 있다)
  if (repo.busy) return void (repo.again = true);
  repo.busy = true;
  invoke<Files>("git_status", { repo: root, open: [...new Set(repo.subs.values())] })
    .then(
      (files) => {
        // 그대로면 다시 그리지 않는다
        if (JSON.stringify(files) === JSON.stringify(repo.files)) return;
        repo.files = files;
        repo.subs.forEach((_, f) => f(files));
      },
      (e) => console.error("git 상태 읽기 실패", root, e),
    )
    .finally(() => {
      repo.busy = false;
      if (repo.again && repos.get(root) === repo) {
        repo.again = false;
        load(root, repo);
      }
    });
}

function subscribe({ root, prefix }: Place, onChange: (files: Files) => void) {
  let repo = repos.get(root);
  if (!repo) {
    repo = { files: null, subs: new Map(), busy: false, again: false };
    repos.set(root, repo);
  }
  const r = repo;
  const known = [...r.subs.values()].includes(prefix);
  r.subs.set(onChange, prefix);
  if (r.files) onChange(r.files);
  if (!r.timer) r.timer = setInterval(() => load(root, r), GIT_POLL_MS);
  if (!r.files || !known) load(root, r);
  return () => {
    r.subs.delete(onChange);
    if (r.subs.size === 0) {
      clearInterval(r.timer);
      repos.delete(root);
    }
  };
}

// 펼친 폴더들. 폴더 감시 이벤트를 받으면 저장소 위치부터 다시 찾는다 (그 폴더에서 git init이나 .git을 지운 경우, 리뷰 R2)
const folders = new Set<{ dir: string; refresh: () => void }>();

// 폴더 dir의 목록이 바뀌었다 (폴더 감시). 그 폴더와 그 아래 펼친 폴더만 저장소 위치를 다시 찾고 그 저장소를 다시 읽는다.
// 다른 저장소는 건드리지 않는다 (리뷰 R5)
export function refreshGitStatus(dir: string) {
  const seps = IS_WINDOWS ? ["/", "\\"] : ["/"];
  const under = (d: string) => d === dir || seps.some((s) => d.startsWith(dir.endsWith(s) ? dir : dir + s));
  for (const f of folders) if (under(f.dir)) f.refresh();
}

// 맥 파일 시스템은 이름을 만든 그대로(한글이면 흔히 분해형 NFD) 두고, git은 core.precomposeUnicode로 합성형(NFC)으로 준다.
// 맥에서는 양쪽을 NFC로 맞춰 비교한다. Windows는 정규형이 다르면 다른 이름이라 그대로 (리뷰 R3)
const nameKey = (name: string, windows: boolean) => (windows ? name : name.normalize("NFC"));

// 폴더(위치 prefix)의 바로 아래 항목 이름 → 표시. 폴더는 안에 바뀐 것이 있으면 그중 가장 눈에 띌 것
// (충돌 > 수정·삭제·이름 바뀜(M으로) > 추가·추적 안 함). 추적 안 하는 폴더 자체("이름/")는 그 폴더의 U.
export function gitDecorations(prefix: string, files: Files, windows = IS_WINDOWS): (name: string) => GitCode | undefined {
  const out = new Map<string, GitCode>();
  const rank = (c: GitCode) => (c === "!" ? 3 : c === "A" || c === "U" ? 1 : 2);
  const base = nameKey(prefix, windows);
  for (const [raw, code] of files) {
    const path = nameKey(raw, windows);
    if (!path.startsWith(base)) continue;
    const rest = path.slice(base.length);
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    if (!name) continue;
    const own = slash < 0 || slash === rest.length - 1;
    const c: GitCode = own || code === "!" ? code : rank(code) === 2 ? "M" : code;
    const prev = out.get(name);
    if (!prev || rank(c) > rank(prev)) out.set(name, c);
  }
  return (name: string) => out.get(nameKey(name, windows));
}

// 폴더 dir의 바로 아래 항목 이름 → 표시 (없으면 undefined)
export function useGitStatus(dir: string): (name: string) => GitCode | undefined {
  const [state, setState] = useState<{ prefix: string; files: Files } | null>(null);
  useEffect(() => {
    let alive = true;
    let seq = 0;
    let current: (Place & { unsub: () => void }) | null = null;
    const resolve = () => {
      const mine = ++seq;
      invoke<Place | null>("git_place", { dir }).then(
        (p) => {
          if (!alive || mine !== seq) return;
          // 같은 저장소면 구독은 그대로 두고 다시 읽기만
          if (p && current && p.root === current.root && p.prefix === current.prefix) {
            const repo = repos.get(p.root);
            if (repo) load(p.root, repo);
            return;
          }
          // 새 구독을 먼저 걸고 이전 것을 푼다 (같은 저장소의 목록을 버렸다 다시 읽지 않게)
          const prev = current;
          current = p && { ...p, unsub: subscribe(p, (files) => alive && setState({ prefix: p.prefix, files })) };
          prev?.unsub();
          if (!p) setState(null);
        },
        () => {},
      );
    };
    const entry = { dir, refresh: resolve };
    folders.add(entry);
    resolve();
    return () => {
      alive = false;
      folders.delete(entry);
      current?.unsub();
    };
  }, [dir]);
  return useMemo(() => (state ? gitDecorations(state.prefix, state.files) : () => undefined), [state]);
}
