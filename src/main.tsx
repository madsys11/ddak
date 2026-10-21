import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { PrefsProvider } from "./prefs";

async function main() {
  const selftestRoot = import.meta.env.DEV ? await invoke<string | null>("selftest_config") : null;
  // 지난 자체 테스트가 중간에 멈췄어도 기본 언어·테마로 시작한다.
  if (selftestRoot) for (const key of ["ddak.locale", "ddak.theme"]) localStorage.removeItem(key);
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {/* 자체 테스트는 저장된 폴더 대신 테스트용 폴더로 시작하고, 저장도 하지 않는다. */}
      <PrefsProvider>
        <App initialRoot={selftestRoot} />
      </PrefsProvider>
    </React.StrictMode>,
  );

  if (selftestRoot) (await import("./selftest")).runSelftest(selftestRoot);
}

main();
