import { useEffect, useMemo, useRef, useState } from "react";
import { formatSize, killProcesses, listProcesses, type ProcGroup } from "./api";

type Sort = "cpu" | "mem";
const REFRESH_MS = 2000;

export function ProcessesPanel({ active }: { active: boolean }) {
  const [procs, setProcs] = useState<ProcGroup[]>([]);
  const [sort, setSort] = useState<Sort>("cpu");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [confirmKill, setConfirmKill] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // odświeżanie co 2 s (pierwszy pomiar CPU zawsze wychodzi 0, to normalne)
  useEffect(() => {
    let alive = true;
    const tick = () =>
      listProcesses()
        .then((p) => { if (alive) setProcs(p); })
        .catch((e) => { if (alive) setMsg(String(e)); });
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const rows = useMemo(() => {
    const out = [...procs];
    out.sort((a, b) => sort === "cpu" ? b.cpu - a.cpu || b.memory - a.memory : b.memory - a.memory);
    return out;
  }, [procs, sort]);

  // zaznaczenie trzymamy po nazwie, bo kolejność skacze przy każdym odświeżeniu
  const selected = Math.max(0, rows.findIndex((r) => r.name === selectedName));
  useEffect(() => {
    if (selectedName === null && rows.length) setSelectedName(rows[0].name);
  }, [rows, selectedName]);

  // potwierdzenie zabicia wygasa po 3 s albo po zmianie zaznaczenia
  useEffect(() => {
    if (!confirmKill) return;
    const id = setTimeout(() => setConfirmKill(false), 3000);
    return () => clearTimeout(id);
  }, [confirmKill]);
  useEffect(() => setConfirmKill(false), [selectedName, active]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey) return;
      const move = (d: number) => {
        const r = rows[Math.min(Math.max(selected + d, 0), rows.length - 1)];
        if (r) setSelectedName(r.name);
      };
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "g") { e.preventDefault(); move(-rows.length); }
      else if (e.key === "G") { e.preventDefault(); move(rows.length); }
      else if (e.key === "s") { e.preventDefault(); setSort((s) => (s === "cpu" ? "mem" : "cpu")); }
      else if (e.key === "x") {
        e.preventDefault();
        const g = rows[selected];
        if (!g) return;
        if (!confirmKill) { setConfirmKill(true); return; }     // pierwsze x = pytanie
        setConfirmKill(false);
        killProcesses(g.pids)
          .then((n) => setMsg(`zabito ${g.name} (${n})`))
          .catch((err) => setMsg(String(err)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, rows, selected, confirmKill]);

  // komunikat znika po 4 s
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(id);
  }, [msg]);

  useEffect(() => {
    listRef.current?.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
  }, [selected, active]);

  const cpuColor = (c: number) => (c >= 25 ? "red" : c >= 5 ? "yellow" : "");

  return (
    <div className="procs" ref={listRef}>
      <div className="row head">
        <span className="c-name">NAME</span>
        <span className={`c-num ${sort === "cpu" ? "accent" : ""}`}>CPU</span>
        <span className={`c-mem ${sort === "mem" ? "accent" : ""}`}>MEM</span>
      </div>
      {confirmKill && rows[selected] && (
        <div className="row red">x jeszcze raz = zabij {rows[selected].name}</div>
      )}
      {msg && <div className="row yellow">{msg}</div>}
      {rows.map((p, i) => (
        <div
          key={p.name}
          className={`row ${i === selected && active ? "sel" : ""}`}
          onClick={() => setSelectedName(p.name)}
        >
          <span className="c-name ellipsis">
            {p.name}{p.pids.length > 1 && <span className="muted"> ×{p.pids.length}</span>}
          </span>
          <span className={`c-num ${cpuColor(p.cpu)}`}>{p.cpu.toFixed(1)}</span>
          <span className="c-mem">{formatSize(p.memory)}</span>
        </div>
      ))}
    </div>
  );
}
