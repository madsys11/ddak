import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { devHooks } from "./devHooks";
import { codeError } from "./errors";
import { usePrefs } from "./prefs";

// src-tauri/src/git.rs
type Repo = { name: string; path: string };
type Commit = { sha: string; parents: string[]; author: string; time: number; subject: string; lane: number; lines: [number, number][] };
type Ref = { name: string; kind: "branch" | "remote" | "tag"; sha: string };
type Worktree = { path: string; sha: string | null; branch: string | null; place: number | null };
type Graph = { commits: Commit[]; refs: Ref[]; head: string | null; worktrees: Worktree[]; truncated: boolean; lanes: number };
type Detail = { sha: string; parents: string[]; author: string; time: number; message: string; files: { status: string; path: string }[] };
// 작업그룹 표시: 터미널 탭의 폴더, 탭 이름, 그 탭의 세션 이름
export type Place = { cwd: string; label: string; sessions: string[] };

const ROW = 24;
const LANE = 14;
const PAGE = 1000;
const POLL_MS = 3000;
const laneX = (lane: number) => LANE / 2 + 4 + lane * LANE;
const laneColor = (lane: number) => `var(--graph-${(lane % 6) + 1})`;
// 선 색: 커밋에서 나가는 선은 도착 레인 색, 지나가거나 합쳐지는 선은 출발 레인 색 (owner: 그 선을 가진 행의 커밋 레인).
// 한 선을 위아래 두 행이 반씩 그리므로 같은 규칙으로 정한다.
const lineColor = ([a, b]: [number, number], owner: number) => laneColor(a === owner ? b : a);

// Git Graph 탭 (docs/spec.md "git graph"): 프로젝트의 저장소 하나를 골라 모든 브랜치·원격·태그의 커밋 그래프를 보인다.
// 각 작업그룹(터미널 탭)의 worktree가 있는 커밋에 그 탭 이름과 세션을 붙이고, 커밋을 누르면 메시지와 바뀐 파일을 보인다.
// 읽기 전용. 보이는 동안 참조가 바뀌었는지 주기적으로 보고 바뀌면 다시 읽는다.
export function GitGraph({ project, repo, visible, places, onRepo }: {
  project: string;
  repo?: string;
  visible: boolean;
  places: Place[];
  onRepo: (name: string) => void;
}) {
  const { t, locale } = usePrefs();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });

  // 저장소 목록 (보일 때마다 다시: 저장소를 더했을 수 있다)
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    invoke<Repo[]>("git_repos", { project }).then(
      (r) => alive && setRepos(r),
      (e) => alive && setError(codeError(e).detail),
    );
    return () => {
      alive = false;
    };
  }, [project, visible]);

  const current = repos?.find((r) => r.name === repo) ?? repos?.[0] ?? null;
  const placeKey = places.map((p) => p.cwd).join("\n");

  // 그래프 읽기: 보이는 동안, 저장소·개수·탭 폴더가 바뀌면 다시, 참조가 바뀌면 다시 (마지막 요청만 쓴다)
  useEffect(() => {
    if (!visible || !current) return;
    let alive = true;
    let n = 0;
    let print = "";
    // print: 그래프를 읽는 데 성공한 지문. 읽기가 실패하면 비워서 다음 확인 때 다시 읽는다 (리뷰 P2: 시도한 지문을
    // 저장해서 한 번 실패하면 다시 읽지 않았다).
    // loading: 읽고 있는 지문 (같은 지문으로 겹쳐 읽지 않게)
    let loading = "";
    const load = (p: string) => {
      const mine = ++n;
      const fail = import.meta.env.DEV && devHooks.gitGraphFail?.();
      (fail ? Promise.reject("injected failure") : invoke<Graph>("git_graph", { repo: current.path, limit, places: placeKey ? placeKey.split("\n") : [] })).then(
        (g) => {
          if (!alive || mine !== n) return;
          print = p;
          setGraph(g);
          setError(null);
        },
        (e) => {
          if (!alive || mine !== n) return;
          print = "";
          loading = "";
          setError(codeError(e).detail);
        },
      );
    };
    const poll = () =>
      (import.meta.env.DEV && devHooks.gitFingerprintFail?.() ? Promise.reject("injected failure") : invoke<string>("git_fingerprint", { repo: current.path })).then(
        (p) => {
          if (!alive) return;
          // 읽어 둔 그래프 그대로면 앞서 난 지문 조회 오류를 지운다 (리뷰 후속 P3: 복구돼도 오류 문구가 남았다).
          // 그래프 읽기가 실패했으면 print가 비어 있어 아래에서 다시 읽고, 성공하면 그때 지운다.
          if (p === print) return setError(null);
          if (p === loading) return;
          loading = p;
          load(p);
        },
        (e) => alive && setError(codeError(e).detail),
      );
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [visible, current?.path, limit, placeKey]);

  // 저장소를 바꾸면 선택과 개수를 처음으로
  useEffect(() => {
    setSelected(null);
    setDetail(null);
    setLimit(PAGE);
    setGraph(null);
  }, [current?.path]);

  // 커밋 상세: 선택이 바뀌면 이전 상세를 바로 비우고, 지금 고른 커밋의 응답만 보인다 (리뷰 P2: 늦게 온 이전 응답이나
  // 실패 때 이전 상세가 남았다). 실패는 상세 칸에 보인다.
  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    if (!selected || !current) return;
    let alive = true;
    const delay = import.meta.env.DEV ? (devHooks.gitDetailDelay?.(selected) ?? 0) : 0;
    const fail = import.meta.env.DEV && devHooks.gitDetailFail?.(selected);
    (async () => {
      try {
        if (fail) throw "injected failure";
        const d = await invoke<Detail>("git_commit", { repo: current.path, sha: selected });
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (alive && d.sha === selected) setDetail(d);
      } catch (e) {
        if (alive) setDetailError(codeError(e).detail);
      }
    })();
    return () => {
      alive = false;
    };
  }, [selected, current?.path]);

  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [graph !== null]);

  const commits = graph?.commits ?? [];
  const refsAt = new Map<string, Ref[]>();
  for (const r of graph?.refs ?? []) refsAt.set(r.sha, [...(refsAt.get(r.sha) ?? []), r]);
  const groupsAt = new Map<string, string[]>();
  for (const w of graph?.worktrees ?? []) {
    if (!w.sha || w.place === null) continue;
    const p = places[w.place];
    if (!p) continue;
    const label = p.sessions.length ? `${p.label} · ${p.sessions.join(", ")}` : p.label;
    groupsAt.set(w.sha, [...(groupsAt.get(w.sha) ?? []), label]);
  }
  const width = Math.max(graph?.lanes ?? 1, 1) * LANE + 8;
  const first = Math.max(0, Math.floor(view.top / ROW) - 10);
  const last = Math.min(commits.length, Math.ceil((view.top + view.height) / ROW) + 10);
  const date = (s: number) => new Date(s * 1000).toLocaleString(locale, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const curve = (x1: number, y1: number, x2: number, y2: number) => `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;

  return (
    <div className="git-graph">
      <div className="git-bar">
        <label className="git-repo">
          {t("git.repo")}
          <select value={current?.name ?? ""} onChange={(e) => onRepo(e.target.value)} disabled={!repos?.length}>
            {repos?.map((r) => (
              <option key={r.path} value={r.name}>
                {r.name || t("git.projectRepo")}
              </option>
            ))}
          </select>
        </label>
        {graph && <span className="git-count">{t(graph.truncated ? "git.truncated" : "git.count", { n: commits.length })}</span>}
        {graph?.truncated && (
          <button className="secondary" onClick={() => setLimit((l) => l + PAGE)}>
            {t("git.more")}
          </button>
        )}
      </div>
      {error && <div className="git-error">{error}</div>}
      {repos?.length === 0 && <div className="git-none">{t("git.noRepos")}</div>}
      <div className="git-main">
        <div ref={list} className="git-list" onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
          {graph && commits.length === 0 && <div className="git-none">{t("git.empty")}</div>}
          <div style={{ height: commits.length * ROW, position: "relative" }}>
            {commits.slice(first, last).map((c, k) => {
              const i = first + k;
              const prev = commits[i - 1];
              const above = prev?.lines ?? [];
              return (
                <div
                  key={c.sha}
                  className={`git-row${selected === c.sha ? " selected" : ""}`}
                  data-sha={c.sha}
                  style={{ top: i * ROW, height: ROW }}
                  onClick={() => setSelected(selected === c.sha ? null : c.sha)}
                >
                  <svg className="git-lanes" width={width} height={ROW}>
                    {above.map(([a, b], j) => (
                      <path key={`u${j}`} d={curve(laneX(a), -ROW / 2, laneX(b), ROW / 2)} stroke={lineColor([a, b], prev!.lane)} />
                    ))}
                    {c.lines.map(([a, b], j) => (
                      <path key={`d${j}`} d={curve(laneX(a), ROW / 2, laneX(b), (ROW * 3) / 2)} stroke={lineColor([a, b], c.lane)} />
                    ))}
                    <circle cx={laneX(c.lane)} cy={ROW / 2} r={4} fill={laneColor(c.lane)} />
                  </svg>
                  <span className="git-subject">
                    {graph?.head === c.sha && <span className="git-ref head">HEAD</span>}
                    {groupsAt.get(c.sha)?.map((g) => (
                      <span key={g} className="git-ref group" data-group={g}>
                        {g}
                      </span>
                    ))}
                    {refsAt.get(c.sha)?.map((r) => (
                      <span key={`${r.kind}:${r.name}`} className={`git-ref ${r.kind}`} data-ref={r.name}>
                        {r.name}
                      </span>
                    ))}
                    {c.subject}
                  </span>
                  <span className="git-author">{c.author}</span>
                  <span className="git-date">{date(c.time)}</span>
                  <code className="git-sha">{c.sha.slice(0, 7)}</code>
                </div>
              );
            })}
          </div>
        </div>
        {selected && (
          <div className="git-detail" data-detail={selected}>
            {detailError ? (
              <div className="git-error">{detailError}</div>
            ) : !detail || detail.sha !== selected ? (
              <div className="git-none">{t("git.loading")}</div>
            ) : (
              <>
                <code className="git-detail-sha">{detail.sha}</code>
                <div className="git-detail-meta">
                  {detail.author} · {date(detail.time)}
                </div>
                {detail.parents.length > 0 && (
                  <div className="git-detail-meta">
                    {t("git.parents")}{" "}
                    {detail.parents.map((p) => (
                      <button key={p} className="git-parent" onClick={() => setSelected(p)}>
                        {p.slice(0, 7)}
                      </button>
                    ))}
                  </div>
                )}
                <pre className="git-message">{detail.message}</pre>
                <div className="git-files-title">{t("git.files", { n: detail.files.length })}</div>
                <div className="git-files">
                  {detail.files.map((f) => (
                    <div key={f.path} className="git-file" data-file={f.path}>
                      <span className={`git-status s-${f.status[0]}`}>{f.status[0]}</span>
                      {f.path}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
