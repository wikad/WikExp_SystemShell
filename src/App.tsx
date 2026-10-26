import { useEffect, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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

const files = [
  ["src", "dir", "—"],
  ["src-tauri", "dir", "—"],
  ["package.json", "json", "590 B"],
  ["vite.config.ts", "ts", "891 B"],
  ["README.md", "md", "385 B"],
];

export default function App() {
  // Ctrl+Q zamyka aplikację (bo nie ma ramki z krzyżykiem)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "q") getCurrentWindow().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="shell">
      <Panel title="wikexp" area="tree">
        <div className="row muted">C:\</div>
        <div className="row">  devWikExp</div>
        <div className="row sel">    WikExp</div>
        <div className="row">  Users</div>
      </Panel>

      <Panel title="C:\devWikExp\WikExp" area="main" active>
        <div className="row head"><span className="c-name">NAME</span><span className="c-type">TYPE</span><span>SIZE</span></div>
        {files.map(([name, type, size], i) => (
          <div key={name} className={`row ${i === 0 ? "sel" : ""}`}>
            <span className="c-name">{name}</span><span className="c-type">{type}</span><span>{size}</span>
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