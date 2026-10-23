import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { PrefsProvider } from "./prefs";

async function main() {
  const selftest = import.meta.env.DEV ? await invoke<{ root: string; scenario: string } | null>("selftest_config") : null;
  // 지난 자체 테스트가 중간에 멈췄어도 기본 언어·테마·배율로 시작한다.
  if (selftest) for (const key of ["ddak.locale", "ddak.theme", "ddak.zoom"]) localStorage.removeItem(key);
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {/* 자체 테스트의 프로젝트 목록은 scripts/selftest.sh가 DDAK_DATA_DIR로 따로 둔다. */}
      <PrefsProvider>
        <App />
      </PrefsProvider>
    </React.StrictMode>,
  );

  if (selftest) (await import("./selftest")).runSelftest(selftest.root, selftest.scenario);
}

main();
