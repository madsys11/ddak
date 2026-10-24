import type { Terminal } from "@xterm/xterm";
import { ask } from "@tauri-apps/plugin-dialog";
import type { Groups } from "./useGroups";

// 자체 테스트(src/selftest.ts)가 화면에 떠 있는 터미널의 버퍼를 읽기 위한 목록.
// 키는 터미널을 담은 .terminal 요소. 개발 빌드에서만 채워진다.
export const liveTerms = new Map<HTMLElement, Terminal>();

export const devHooks: {
  // 확인 대화상자. 네이티브 대화상자는 자체 테스트가 누를 수 없어서 테스트가 바꿔 끼운다.
  confirm: (message: string, labels: { okLabel: string; cancelLabel: string }) => Promise<boolean>;
  // 폴더 선택 대화상자 없이 프로젝트를 추가한다 (개발 빌드에서 App이 채운다).
  addProject?: (path: string) => Promise<void>;
  // 지금 쓰고 있는 작업그룹 설정 (개발 빌드에서 App이 채운다)
  groups?: Groups | null;
  // 터미널이 PTY 생성 응답을 이만큼(ms) 늦게 받은 것처럼 한다 (자체 테스트)
  spawnDelay?: number;
  // 작업그룹 준비 창이 설정을 읽을 때마다 불러서, 그 응답을 돌려준 값(ms)만큼 늦게 받은 것처럼 한다 (자체 테스트)
  setupLoadDelay?: () => number;
  // 작업 화면 상태 읽기·저장 (자체 테스트): load가 있으면 읽기를 이것으로 바꾼다 (실패·늦게 오기), saveDelay는 저장할
  // 때마다 불러서 그만큼(ms) 늦게 보낸다 (저장 순서)
  workspaceLoad?: (project: string) => Promise<string | null>;
  workspaceSaveDelay?: () => number;
  // 채팅 패널 (자체 테스트): 보내기를 이만큼(ms) 늦게 보낸다 / 참여자 응답을 부를 때마다 돌려준 값만큼 늦게 받는다 /
  // 이벤트 등록을 이만큼 늦춘다
  chatPostDelay?: number;
  chatMembersDelay?: () => number;
  chatListenDelay?: number;
  // 이 이름의 채팅 이벤트 등록을 실패시킨다 / 프로젝트마다 채팅 메시지를 읽은 횟수 (남은 리스너를 보려고)
  chatListenFail?: string;
  chatLoads?: Record<string, number>;
  // 터미널의 깨우기 이벤트 등록을 이만큼(ms) 늦춘다 (터미널은 등록이 끝난 뒤 뜬다)
  wakeListenDelay?: number;
} = {
  confirm: (message, labels) => ask(message, { kind: "warning", ...labels }),
};
