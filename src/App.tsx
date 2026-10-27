import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readDir, formatSize, type FileEntry, parentDir } from "./api";
import { useEffect, useState, useReducer, type ReactNode } from "react";
import "./App.css";
import { TerminalPanel } from "./TerminalPanel";
function Panel({ title, area, active, onActivate, children }: {
  title: string; area: string; active?: boolean; onActivate?: () => void; children?: ReactNode;
}) {
  return (
    <section
      className={`panel ${active ? "active" : ""}`}
      style={{ gridArea: area }}
      onMouseDown={onActivate}
    >
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


type PanelId = "tree" | "files" | "terminal" | "side";

const NEIGHBORS: Record<PanelId, Partial<Record<"h" | "j" | "k" | "l", PanelId>>> = {
  tree:     { l: "files" },
  files:    { h: "tree", l: "side", j: "terminal" },
  terminal: { h: "tree", l: "side", k: "files" },
  side:     { h: "files" },
};
const MODE: Record<PanelId, string> = {
    tree: "NORMAL", files: "NORMAL", terminal: "TERMINAL", side: "NORMAL",
  };

export default function App() {
  const [nav, dispatch] = useReducer(navReducer, { back: [], cwd: null, forward: [] });
  const cwd = nav.cwd;
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [active, setActive] = useState<PanelId>("files");

  // 1) start: folder domowy
  useEffect(() => {
    homeDir().then((p) => dispatch({ type: "init", path: p }));
  }, []);

  // 2) wczytywanie plików przy zmianie cwd
  useEffect(() => {
    if (!cwd) return;
    readDir(cwd)
      .then((f) => { setFiles(f); setError(null); setSelected(0); })
      .catch((e) => setError(String(e)));
  }, [cwd]);

  // 3) skróty globalne: zawsze aktywne
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "q") {
        e.preventDefault();
        getCurrentWindow().close();
        return;
      }
      if (e.altKey && ["h", "j", "k", "l"].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        const next = NEIGHBORS[active][e.key as "h" | "j" | "k" | "l"];
        if (next) setActive(next);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);

  // 4) klawisze panelu plików: tylko gdy aktywny
  useEffect(() => {
    if (active !== "files") return;

    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey) return;

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, files.length - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "l") {
        e.preventDefault();
        const f = files[selected];
        if (f?.isDir) dispatch({ type: "go", path: f.path });
      } else if ((e.key === "Backspace" || e.key === "h") && cwd) {
        e.preventDefault();
        parentDir(cwd).then((p) => { if (p) dispatch({ type: "go", path: p }); });
      } else if (e.key === "H") {
        e.preventDefault();
        dispatch({ type: "back" });
      } else if (e.key === "L") {
        e.preventDefault();
        dispatch({ type: "forward" });
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, files, selected, cwd]);

  return (
    <div className="shell">
      <Panel title="wikexp" area="tree"
        active={active === "tree"} onActivate={() => setActive("tree")}>
        <div className="row muted">C:\</div>
        <div className="row">  devWikExp</div>
        <div className="row sel">    WikExp</div>
        <div className="row">  Users</div>
      </Panel>

      <Panel title={cwd ?? "..."} area="main"
        active={active === "files"} onActivate={() => setActive("files")}>
        <div className="row head">
          <span className="c-name">NAME</span><span className="c-type">TYPE</span><span>SIZE</span>
        </div>
        {error && <div className="row red">{error}</div>}
        {files.map((f, i) => (
          <div
            key={f.path}
            className={`row ${i === selected && active === "files" ? "sel" : ""}`}
            onClick={() => setSelected(i)}
            onDoubleClick={() => f.isDir && dispatch({ type: "go", path: f.path })}
          >
            <span className={`c-name ${f.isDir ? "accent" : ""}`}>{f.isDir ? f.name + "\\" : f.name}</span>
            <span className="c-type">{f.isDir ? "dir" : f.name.split(".").pop()}</span>
            <span>{f.isDir ? "—" : formatSize(f.size)}</span>
          </div>
        ))}
      </Panel>

      <Panel title="terminal" area="term"
        active={active === "terminal"} onActivate={() => setActive("terminal")}>
          
          <TerminalPanel/>
      </Panel>

      <Panel title="procesy" area="side"
        active={active === "side"} onActivate={() => setActive("side")}>
        <div className="row"><span className="green">▶</span> docker-desktop</div>
        <div className="row"><span className="green">▶</span> code</div>
        <div className="row"><span className="muted">■</span> postgres</div>
      </Panel>

      <footer className="status">
        <span className="mode">{MODE[active]}</span>
        <span>WikExp › src</span>
        <span className="spacer" />
        <span>ctrl+q quit · alt+hjkl panel</span>
      </footer>
    </div>
  );
}