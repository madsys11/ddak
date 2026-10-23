import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { codeError, type CodeError } from "./errors";
import { watchDir } from "./watchDir";

// 작업그룹 설정 (src-tauri/src/groups.rs). 명령이 비어 있는 세션은 그냥 셸이다.
export type Session = { name: string; command: string; args: string[]; readOnly: boolean; shiftEnter: string | null };
export type Group = { id: string; name: string; sessions: Session[] };
export type Groups = { default: string; groups: Group[] };

// 설정 파일을 고치면 다시 읽는다. 고친 내용이 잘못됐으면 오류를 보여 주고 마지막으로 읽은 올바른 설정을 계속 쓴다
// (편집 중 잠깐 깨진 상태 때문에 쓰던 설정이 사라지지 않게).
export function useGroups() {
  const [groups, setGroups] = useState<Groups | null>(null);
  const [error, setError] = useState<CodeError | null>(null);

  useEffect(() => {
    let alive = true;
    let unwatch: (() => void) | undefined;
    // 다시 읽기가 겹치면 늦게 끝난 이전 요청이 최신 설정을 되돌릴 수 있다. 마지막 요청의 결과만 쓴다 (리뷰 지적 5).
    let latest = 0;
    const load = () => {
      const n = ++latest;
      const current = () => alive && n === latest;
      return invoke<Groups>("groups_load").then(
        (g) => current() && (setGroups(g), setError(null)),
        (e) => current() && setError(codeError(e)),
      );
    };
    load();
    invoke<string>("groups_dir").then(
      (dir) => {
        if (alive) unwatch = watchDir(dir, load, { contents: true });
      },
      (e) => alive && setError(codeError(e)),
    );
    return () => {
      alive = false;
      unwatch?.();
    };
  }, []);

  return { groups, error };
}
