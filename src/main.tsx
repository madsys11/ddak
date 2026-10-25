import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { PrefsProvider } from "./prefs";

async function main() {
  const selftest = import.meta.env.DEV ? await invoke<{ root: string; scenario: string; only: string[] } | null>("selftest_config") : null;
  // 지난 자체 테스트가 중간에 멈췄어도 기본 언어·테마·배율·패널·알림 소리로 시작한다.
  if (selftest) for (const key of ["ddak.locale", "ddak.theme", "ddak.zoom", "ddak.sidebar", "ddak.sidebarWidth", "ddak.chatWidth", "ddak.notifySound"]) localStorage.removeItem(key);
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {/* 자체 테스트의 프로젝트 목록은 scripts/selftest.sh가 DDAK_DATA_DIR로 따로 둔다. */}
      <PrefsProvider>
        <App />
      </PrefsProvider>
    </React.StrictMode>,
  );

  // 테스트 모듈을 불러오지 못하면 (문법 오류 등) 결과 없이 기다리지 않게 바로 실패로 보고한다
  if (selftest) {
    import("./selftest").then(
      (m) => m.runSelftest(selftest.root, selftest.scenario, selftest.only),
      (e) => invoke("selftest_report", { ok: false, log: `FAIL  자체 테스트를 불러오지 못함  (${String(e)})` }),
    );
  }
}

main();
