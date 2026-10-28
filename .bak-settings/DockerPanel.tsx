import { useCallback, useEffect, useRef, useState } from "react";
import { dockerAction, dockerList, type Container, type DockerAction } from "./api";

const REFRESH_MS = 3000;

const STATE_ICON: Record<string, [string, string]> = {
  running: ["▶", "green"],
  paused: ["‖", "yellow"],
  restarting: ["↻", "yellow"],
  exited: ["■", "muted"],
  created: ["□", "muted"],
  dead: ["✕", "red"],
};

export function DockerPanel({ active }: { active: boolean }) {
  const [items, setItems] = useState<Container[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);      // id kontenera w trakcie akcji
  const [confirmRm, setConfirmRm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(
    () => dockerList()
      .then((c) => { setItems(c); setError(null); })
      .catch((e) => { setItems([]); setError(String(e)); }),
    [],
  );

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // uruchomione na górze, potem reszta alfabetycznie
  const rows = [...items].sort((a, b) =>
    Number(b.state === "running") - Number(a.state === "running") || a.name.localeCompare(b.name));
  const selected = Math.max(0, rows.findIndex((c) => c.id === selectedId));
  const current = rows[selected];

  useEffect(() => { setConfirmRm(false); }, [selectedId, active]);
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(id);
  }, [msg]);

  const run = (c: Container, action: DockerAction) => {
    setBusy(c.id);
    dockerAction(c.id, action)
      .then(() => setMsg(`${action} ${c.name}: ok`))
      .catch((e) => setMsg(String(e)))
      .finally(() => { setBusy(null); refresh(); });
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey) return;
      const move = (d: number) => {
        const c = rows[Math.min(Math.max(selected + d, 0), rows.length - 1)];
        if (c) setSelectedId(c.id);
      };
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); return; }
      if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); return; }
      if (!current || busy) return;
      if (e.key === "s" || e.key === "Enter") {         // start / stop
        e.preventDefault();
        run(current, current.state === "running" ? "stop" : "start");
      } else if (e.key === "r") {
        e.preventDefault();
        run(current, "restart");
      } else if (e.key === "x") {  // usuń (tylko zatrzymany), dwa razy
        e.preventDefault();
        if (current.state === "running") { setMsg("najpierw zatrzymaj (s)"); return; }
        if (!confirmRm) { setConfirmRm(true); return; }
        setConfirmRm(false);
        run(current, "rm");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, rows, selected, current, busy, confirmRm]);

  useEffect(() => {
    listRef.current?.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
  }, [selected, active]);

  if (error) {
    return <div className="row muted">{error}</div>;
  }

  return (
    <div ref={listRef}>
      {confirmRm && current && <div className="row red">x jeszcze raz = usuń {current.name}</div>}
      {msg && <div className="row yellow">{msg}</div>}
      {rows.length === 0 && <div className="row muted">brak kontenerów</div>}
      {rows.map((c, i) => {
        const [icon, color] = STATE_ICON[c.state] ?? ["?", "muted"];
        return (
          <div
            key={c.id}
            className={`row ${i === selected && active ? "sel" : ""}`}
            title={`${c.image}\n${c.status}${c.ports ? "\n" + c.ports : ""}`}
            onClick={() => setSelectedId(c.id)}
          >
            <span className={color}>{busy === c.id ? "…" : icon} </span>
            <span className="c-name ellipsis">{c.name}</span>
            <span className="muted ellipsis c-status">{c.status}</span>
          </div>
        );
      })}
    </div>
  );
}
