import { useCallback, useEffect, useRef, useState } from "react";
import { formatSize, wslAction, wslList, type WslInfo } from "./api";

const REFRESH_MS = 3000;

/** Dystrybucje WSL: stan, wersja, domyślna; zatrzymywanie, zmiana domyślnej, wyłączenie całego WSL. */
export function WslPanel({ active }: { active: boolean }) {
  const [info, setInfo] = useState<WslInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selName, setSelName] = useState<string | null>(null);
  const [confirmShutdown, setConfirmShutdown] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(
    () => wslList().then((i) => { setInfo(i); setError(null); }).catch((e) => { setInfo(null); setError(String(e)); }),
    [],
  );
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const rows = info?.distros ?? [];
  const selected = Math.max(0, rows.findIndex((d) => d.name === selName));
  const current = rows[selected];

  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(id);
  }, [msg]);
  useEffect(() => {
    if (!confirmShutdown) return;
    const id = setTimeout(() => setConfirmShutdown(false), 3000);
    return () => clearTimeout(id);
  }, [confirmShutdown]);
  useEffect(() => setConfirmShutdown(false), [selName, active]);

  const run = (distro: string, action: "terminate" | "default" | "shutdown", okText: string) =>
    wslAction(distro, action).then(() => setMsg(okText)).catch((e) => setMsg(String(e))).finally(refresh);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey) return;
      const move = (d: number) => {
        const r = rows[Math.min(Math.max(selected + d, 0), rows.length - 1)];
        if (r) setSelName(r.name);
      };
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "x" && current) {
        e.preventDefault();
        if (!current.running) { setMsg(`${current.name} już jest zatrzymana`); return; }
        run(current.name, "terminate", `zatrzymano ${current.name}`);
      } else if (e.key === "d" && current) {
        e.preventDefault();
        run(current.name, "default", `${current.name} jest teraz domyślna`);
      } else if (e.key === "S") {
        e.preventDefault();
        if (!confirmShutdown) { setConfirmShutdown(true); return; }   // pierwsze S = pytanie
        setConfirmShutdown(false);
        run("", "shutdown", "WSL wyłączony (wszystkie dystrybucje)");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, rows, selected, current, confirmShutdown]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    listRef.current?.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
  }, [selected, active]);

  if (error) return <div className="row muted">{error}</div>;

  return (
    <div ref={listRef}>
      <div className="row muted">
        {info && info.vmmem > 0 ? `RAM maszyny WSL: ${formatSize(info.vmmem)}` : "WSL"}
        {" · x zatrzymaj · d domyślna · S wyłącz całe WSL"}
      </div>
      {confirmShutdown && <div className="row red">S jeszcze raz = wyłącz WSL (zatrzyma też docker-desktop)</div>}
      {msg && <div className="row yellow">{msg}</div>}
      {info && rows.length === 0 && <div className="row muted">brak zainstalowanych dystrybucji (wsl --install)</div>}
      {rows.map((d, i) => (
        <div
          key={d.name}
          className={`row ${i === selected && active ? "sel" : ""}`}
          onClick={() => setSelName(d.name)}
        >
          <span className={d.running ? "green" : "muted"}>{d.running ? "▶" : "■"} </span>
          <span className="c-name ellipsis">{d.name}{d.isDefault && <span className="accent"> *</span>}</span>
          <span className="muted c-status">WSL{d.version} · {d.running ? "działa" : "zatrzymana"}</span>
        </div>
      ))}
    </div>
  );
}
