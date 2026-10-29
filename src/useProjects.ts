import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// 프로젝트 목록. 저장은 Rust가 앱 데이터 폴더에 한다 (src-tauri/src/projects.rs).
export type Project = { path: string; missing: boolean };
type Store = { projects: { path: string }[]; active: string | null };

import { baseName, trimTrailingSep } from "./platform";
export { baseName } from "./platform";

const exists = (path: string) => invoke("list_dir", { path }).then(() => true, () => false);
// 대화상자는 끝에 /를 붙이지 않지만, 같은 폴더가 두 번 들어가지 않게 맞춰 둔다.
// Windows는 \ 도 (드라이브 루트 C:\ 는 그대로). 맥의 \ 는 이름의 일부
const normalize = (path: string) => trimTrailingSep(path);

// 목록 파일을 못 읽었을 때. 이 상태에서는 목록을 바꾸지 않는다 (바꿔도 저장할 수 없고,
// 저장하면 읽지 못한 원래 목록을 빈 목록으로 덮어쓴다).
export class StoreBroken extends Error {}

// 목록은 늘 폴더 이름순 (파일 트리처럼 대소문자 무시). 이름이 같으면 경로순.
// 맥 폴더 이름은 한글이 NFD일 수 있어 NFC로 맞춰 비교한다.
// 정렬한 채로 저장하므로 폰 목록(projects.json의 순서)도 같은 순서다.
const key = (p: Project) => baseName(p.path).normalize("NFC").toLowerCase();
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (list: Project[]) => [...list].sort((a, b) => cmp(key(a), key(b)) || cmp(a.path, b.path));

export function useProjects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 목록 파일을 못 읽었으면 그 오류. 있으면 저장도 편집도 하지 않는다.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // StrictMode에서는 효과가 두 번 돈다. 정리된 쪽의 결과는 성공·실패 모두 버린다
    // (늦게 끝난 첫 로드가 그 사이 추가한 프로젝트를 덮어쓰지 않게).
    let alive = true;
    (async () => {
      const store = await invoke<Store>("projects_load");
      const list = sorted(await Promise.all(store.projects.map(async (p) => ({ path: p.path, missing: !(await exists(p.path)) }))));
      if (!alive) return;
      const usable = list.filter((p) => !p.missing);
      setProjects(list);
      setActive(usable.find((p) => p.path === store.active)?.path ?? usable[0]?.path ?? null);
      setLoaded(true);
    })().catch((e) => {
      if (!alive) return;
      setLoadError(String(e));
      setProjects([]);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!loaded || !projects) return;
    const store: Store = { projects: projects.map((p) => ({ path: p.path })), active };
    invoke("projects_save", { store }).catch((e) => setError(String(e)));
  }, [loaded, projects, active]);

  // 이미 있는 폴더면 그 프로젝트로 옮겨 가기만 한다. activate: false면 목록에만 넣는다 (자체 테스트: 열리지 않은 프로젝트)
  const add = useCallback(
    async (raw: string, activate = true) => {
      if (!loaded) throw new StoreBroken();
      const path = normalize(raw);
      if (!(await exists(path))) throw new Error(path);
      setProjects((list) => (list?.some((p) => p.path === path) ? list : sorted([...(list ?? []), { path, missing: false }])));
      if (activate) setActive(path);
    },
    [loaded],
  );

  const remove = useCallback(
    (path: string) => {
      if (!loaded) return;
      const next = (projects ?? []).filter((p) => p.path !== path);
      setProjects(next);
      setActive((a) => (a === path ? next.find((p) => !p.missing)?.path ?? null : a));
    },
    [loaded, projects],
  );

  return { projects, active, error, loadError, setError, add, remove, activate: setActive };
}
