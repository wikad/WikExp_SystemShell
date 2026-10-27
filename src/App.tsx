import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readDir, formatSize, type FileEntry, parentDir } from "./api";
import { useEffect, useState, useReducer, type ReactNode } from "react";
import "./App.css";

function Panel({ title, area, active, children }: {
  title: string; area: string; active?: boolean; children?: ReactNode;
}) {
  return (
    <section className={`panel ${active ? "active" : ""}`} style={{ gridArea: area }}>
      <header className="panel-title">{title}</header>
      <div className="panel-body">{children}</div>
    </section>
  );
}


type Nav = { back: string[]; cwd: string | null; forward: string[] };
type NavAction =
  | { type: "init"; path: string }
  | { type: "go"; path: string }
  | { type: "back" }
  | { type: "forward" };

function navReducer(s: Nav, a: NavAction): Nav {
  switch (a.type) {
    case "init":
      return { back: [], cwd: a.path, forward: [] };
    case "go":
      if (!s.cwd || a.path === s.cwd) return { ...s, cwd: a.path };
      return { back: [...s.back, s.cwd].slice(-50), cwd: a.path, forward: [] };
    case "back":
      if (!s.cwd || s.back.length === 0) return s;
      return {
        back: s.back.slice(0, -1),
        cwd: s.back[s.back.length - 1],
        forward: [...s.forward, s.cwd],
      };
    case "forward":
      if (!s.cwd || s.forward.length === 0) return s;
      return {
        back: [...s.back, s.cwd],
        cwd: s.forward[s.forward.length - 1],
        forward: s.forward.slice(0, -1),
      };
  }
}

export default function App() {

 const [nav, dispatch] = useReducer(navReducer, { back: [], cwd: null, forward: [] });
  const cwd = nav.cwd;
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);


   // 1) start: folder domowy (raz, przy uruchomieniu)
  useEffect(() => {
    homeDir().then((p) => dispatch({ type: "init", path: p }));
  }, []);

  // 2) wczytywanie plików przy każdej zmianie cwd
  useEffect(() => {
    if (!cwd) return;
    readDir(cwd)
      .then((f) => { setFiles(f); setError(null); })
      .catch((e) => setError(String(e)));
  }, [cwd]);

  // 3) klawiatura
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "q") {
        getCurrentWindow().close();
        return;
      }
      if (e.key === "Backspace" && cwd) {
        e.preventDefault();
        parentDir(cwd).then((p) => { if (p) dispatch({ type: "go", path: p }); });
        return;
      }
      if ((e.altKey && e.key === "ArrowRight") || e.key === "H") {
        e.preventDefault();
        dispatch({ type: "back" });
        return;
      }
      if ((e.altKey && e.key === "ArrowLeft") || e.key === "L") {
        e.preventDefault();
        dispatch({ type: "forward" });
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cwd]);

  return (
    <div className="shell">
      <Panel title="wikexp" area="tree">
        <div className="row muted">C:\</div>
        <div className="row">  devWikExp</div>
        <div className="row sel">    WikExp</div>
        <div className="row">  Users</div>
      </Panel>

      <Panel title={cwd ?? "..."} area="main" active>
        <div className="row head">
          <span className="c-name">NAME</span><span className="c-type">TYPE</span><span>SIZE</span>
        </div>
        {error && <div className="row red">{error}</div>}
        {files.map((f) => (
          <div
            key={f.path}
            className="row"
            onDoubleClick={() => f.isDir && dispatch({ type: "go", path: f.path })}
          >
            <span className={`c-name ${f.isDir ? "accent" : ""}`}>{f.isDir ? f.name + "\\" : f.name}</span>
            <span className="c-type">{f.isDir ? "dir" : f.name.split(".").pop()}</span>
            <span>{f.isDir ? "—" : formatSize(f.size)}</span>
          </div>
        ))}
      </Panel>

      <Panel title="terminal" area="term">
        <div className="row"><span className="accent">PS C:\devWikExp\WikExp&gt;</span> _</div>
      </Panel>

      <Panel title="procesy" area="side">
        <div className="row"><span className="green">▶</span> docker-desktop</div>
        <div className="row"><span className="green">▶</span> code</div>
        <div className="row"><span className="muted">■</span> postgres</div>
      </Panel>

      <footer className="status">
        <span className="mode">NORMAL</span>
        <span>WikExp › src</span>
        <span className="spacer" />
        <span>ctrl+q quit</span>
      </footer>
    </div>
  );
}