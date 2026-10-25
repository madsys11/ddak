import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { codeError, type CodeError } from "./errors";
import { watchDir } from "./watchDir";

// 작업그룹 설정 (src-tauri/src/groups.rs). 명령이 비어 있는 세션은 그냥 셸이다.
// resume: 복원할 때 args 대신 쓸 인자 (CLI의 이어서 하기). 인자의 자리표시자({session}, {chat}, {prompt}, {prompt:toml})는
// 띄울 때 Rust가 한 번에 바꾼다 (pty.rs fill_placeholders). role: 세션의 역할, rules: 그룹의 공통 규약 (합쳐 {prompt}).
export type Session = { name: string; command: string; args: string[]; resume: string[] | null; readOnly: boolean; shiftEnter: string | null; role?: string | null };
export type Group = { id: string; name: string; rules?: string | null; sessions: Session[] };
// shiftEnterFor: 세션 설정에 shiftEnter가 없는 터미널에서 ⇧↩을 누를 때, 앞에서 도는 프로그램 이름 → 보낼 입력 (Terminal.tsx)
export type Groups = { default: string; shiftEnterFor?: Record<string, string>; groups: Group[] };

// 세션의 프롬프트 (인자의 {prompt}) = 역할 + 그 세션이 든 작업그룹의 규약. 세션을 만들 때 정해 함께 저장한다
// (설정을 고쳐도 이미 연 창과 복원은 그때의 것을 쓴다. 다른 탭에 더해도 그 세션이 든 그룹의 규약).
export const promptOf = (group: Group, session: Session) => [session.role, group.rules].filter(Boolean).join("\n\n");

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
