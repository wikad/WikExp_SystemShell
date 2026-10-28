import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appIcons, hideLauncher, launchApp, listApps, type AppEntry } from "./api";

const KEY = "wikexp.launcher.v1";       // statystyki uruchomień: target → { ile razy, kiedy ostatnio }
const SHOW_EMPTY = 4;                    // ostatnie / częste przy pustym polu
const MAX_RESULTS = 8;

type Usage = Record<string, { count: number; last: number }>;
const loadUsage = (): Usage => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } };

/** Dopasowanie nazwy do wpisanego tekstu: im wyżej, tym lepiej; 0 = brak dopasowania. */
function score(name: string, q: string): number {
  const n = name.toLowerCase();
  if (n.startsWith(q)) return 100;
  if (n.split(/[\s\-_.]+/).some((w) => w.startsWith(q))) return 80; // początek słowa: "code" → "Visual Studio Code"
  if (n.includes(q)) return 60;
  // litery w kolejności, z przerwami: "vsc" → "Visual Studio Code"
  let i = 0;
  for (const c of n) if (c === q[i]) i++;
  return i === q.length ? 30 : 0;
}

type Row = { app: AppEntry; section?: string };

/**
 * Małe okienko wyszukiwania programów (osobne okno Tauri "launcher", obok paska).
 * Puste pole: 4 ostatnie i 4 najczęstsze; wpisywanie: do 8 najlepszych dopasowań.
 */
export function Launcher() {
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [usage, setUsage] = useState<Usage>(loadUsage);
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  // otwarcie launchera: czyste pole, kursor w polu, świeża lista programów
  useEffect(() => {
    listApps().then(setApps).catch(() => {});
    const un = listen("launcher-open", () => {
      setQuery(""); setSel(0); setUsage(loadUsage());
      setTimeout(() => inputRef.current?.focus(), 0);
      listApps(true).then(setApps).catch(() => {});
    });
    // kliknięcie gdziekolwiek poza launcherem = schowaj
    const blur = getCurrentWindow().onFocusChanged(({ payload: focused }) => { if (!focused) hideLauncher(); });
    return () => { un.then((f) => f()); blur.then((f) => f()); };
  }, []);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const byTarget = new Map(apps.map((a) => [a.target, a]));
    if (!q) {
      const used = Object.entries(usage).filter(([t]) => byTarget.has(t));
      const recent = [...used].sort((a, b) => b[1].last - a[1].last).slice(0, SHOW_EMPTY).map(([t]) => t);
      const frequent = [...used].sort((a, b) => b[1].count - a[1].count)
        .map(([t]) => t).filter((t) => !recent.includes(t)).slice(0, SHOW_EMPTY);
      const out: Row[] = [];
      recent.forEach((t, i) => out.push({ app: byTarget.get(t)!, section: i === 0 ? "ostatnie" : undefined }));
      frequent.forEach((t, i) => out.push({ app: byTarget.get(t)!, section: i === 0 ? "częste" : undefined }));
      return out;
    }
    return apps
      .map((a) => ({ a, s: score(a.name, q) + Math.min(usage[a.target]?.count ?? 0, 20) }))
      .filter((x) => x.s > Math.min(usage[x.a.target]?.count ?? 0, 20))
      .sort((x, y) => y.s - x.s || x.a.name.localeCompare(y.a.name))
      .slice(0, MAX_RESULTS)
      .map((x, i) => ({ app: x.a, section: i === 0 ? "programy" : undefined }));
  }, [apps, query, usage]);

  useEffect(() => { setSel(0); }, [query]);

  // ikony tylko dla widocznych pozycji (z pamięcią podręczną po obu stronach)
  useEffect(() => {
    const missing = rows.map((r) => r.app.target).filter((t) => !(t in icons));
    if (!missing.length) return;
    appIcons(missing).then((res) => setIcons((m) => {
      const n = { ...m };
      missing.forEach((t, i) => { n[t] = res[i] ?? null; });
      return n;
    })).catch(() => {});
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (a: AppEntry) => {
    const u = loadUsage();
    u[a.target] = { count: (u[a.target]?.count ?? 0) + 1, last: Date.now() };
    try { localStorage.setItem(KEY, JSON.stringify(u)); } catch { /* ignoruj */ }
    setUsage(u);
    launchApp(a.target).catch(() => {});
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); hideLauncher(); }
    else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); setSel((i) => Math.min(i + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && rows[sel]) { e.preventDefault(); run(rows[sel].app); }
  };

  return (
    <div className="launcher" onContextMenu={(e) => e.preventDefault()}>
      <div className="lc-search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
        </svg>
        <input ref={inputRef} autoFocus spellCheck={false} placeholder="szukaj programu…"
          value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
      </div>
      <div className="lc-list">
        {rows.length === 0 && (
          <div className="lc-empty muted">{query ? "nic nie znaleziono" : "uruchomione programy pojawią się tutaj"}</div>
        )}
        {rows.map((r, i) => (
          <div key={r.app.target}>
            {r.section && <div className="lc-section">{r.section}</div>}
            <div className={`lc-row ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => run(r.app)}>
              {icons[r.app.target]
                ? <img src={icons[r.app.target]!} alt="" draggable={false} />
                : <span className="lc-letter">{r.app.name.slice(0, 1).toUpperCase()}</span>}
              <span className="lc-name">{r.app.name}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="lc-foot muted">↑↓ wybór · enter uruchom · esc zamknij</div>
    </div>
  );
}
