import type { Terminal } from "@xterm/xterm";
import { ask } from "@tauri-apps/plugin-dialog";

// 자체 테스트(src/selftest.ts)가 화면에 떠 있는 터미널의 버퍼를 읽기 위한 목록.
// 키는 터미널을 담은 .terminal 요소. 개발 빌드에서만 채워진다.
export const liveTerms = new Map<HTMLElement, Terminal>();

export const devHooks: {
  // 확인 대화상자. 네이티브 대화상자는 자체 테스트가 누를 수 없어서 테스트가 바꿔 끼운다.
  confirm: (message: string, labels: { okLabel: string; cancelLabel: string }) => Promise<boolean>;
  // 폴더 선택 대화상자 없이 프로젝트를 추가한다 (개발 빌드에서 App이 채운다).
  addProject?: (path: string) => Promise<void>;
} = {
  confirm: (message, labels) => ask(message, { kind: "warning", ...labels }),
};
