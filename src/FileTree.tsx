import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Entry = { name: string; path: string; is_dir: boolean };

function useEntries(path: string) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    invoke<Entry[]>("list_dir", { path }).then(setEntries, (e) => setError(String(e)));
  }, [path]);
  return { entries, error };
}

function Children({ path, depth }: { path: string; depth: number }) {
  const { entries, error } = useEntries(path);
  if (error) return <div className="tree-error" style={{ paddingLeft: indent(depth) }}>{error}</div>;
  if (!entries) return null;
  return (
    <>
      {entries.map((e) => (
        <Node key={e.path} entry={e} depth={depth} />
      ))}
    </>
  );
}

function Node({ entry, depth }: { entry: Entry; depth: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        className="tree-row"
        style={{ paddingLeft: indent(depth) }}
        onClick={() => entry.is_dir && setOpen(!open)}
        title={entry.path}
      >
        <span className="tree-twisty">{entry.is_dir ? (open ? "▾" : "▸") : ""}</span>
        {entry.name}
      </div>
      {/* 펼칠 때 처음으로 읽는다. 큰 폴더(node_modules 등)를 미리 읽지 않기 위해서다. */}
      {open && <Children path={entry.path} depth={depth + 1} />}
    </>
  );
}

const indent = (depth: number) => 8 + depth * 12;

export function FileTree({ root }: { root: string }) {
  return (
    <div className="tree">
      <div className="tree-title">{root.split("/").pop()}</div>
      <Children path={root} depth={0} />
    </div>
  );
}
