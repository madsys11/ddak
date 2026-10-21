import type { Terminal } from "@xterm/xterm";

// 자체 테스트(src/selftest.ts)가 화면에 떠 있는 터미널의 버퍼를 읽기 위한 목록.
// 키는 터미널을 담은 .terminal 요소. 개발 빌드에서만 채워진다.
export const liveTerms = new Map<HTMLElement, Terminal>();
