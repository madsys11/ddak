import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { FileTree } from "./FileTree";
import { Workspace } from "./Workspace";
import { useT } from "./prefs";
import "./App.css";

const ROOT_KEY = "ddak.root";

function loadRoot() {
  try {
    return localStorage.getItem(ROOT_KEY);
  } catch {
    return null;
  }
}

function App({ initialRoot }: { initialRoot: string | null }) {
  const t = useT();
  const [root, setRoot] = useState<string | null>(() => initialRoot ?? loadRoot());

  // 저장해 둔 폴더가 지워졌거나 옮겨졌으면 폴더 선택 화면으로
  useEffect(() => {
    if (root) invoke("list_dir", { path: root }).catch(() => setRoot(null));
  }, [root]);

  async function pickRoot() {
    const picked = await open({ directory: true });
    if (typeof picked !== "string") return;
    try {
      localStorage.setItem(ROOT_KEY, picked);
    } catch {
      // 저장 못 해도 이번 실행에서는 쓸 수 있다.
    }
    setRoot(picked);
  }

  if (!root) {
    return (
      <main className="empty">
        <button onClick={pickRoot}>{t("app.openFolder")}</button>
      </main>
    );
  }

  return (
    <main className="layout">
      <aside className="sidebar">
        <FileTree key={root} root={root} />
        <button className="sidebar-open" onClick={pickRoot}>
          {t("app.changeFolder")}
        </button>
      </aside>
      <section className="panel">
        <Workspace key={root} cwd={root} />
      </section>
    </main>
  );
}

export default App;
