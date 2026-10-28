import { useEffect, useRef, useState } from "react";
import { dockWindow, listWindows, styleDocked, undockWindow, windowAction, type WinInfo } from "./api";
import { useSettings } from "./settings";

export type Docked = { hwnd: number; title: string; exe: string };

const KEY = "wikexp.apps.v1"; // id panelu → ścieżka .exe (żeby po restarcie wrócił ten sam program)
const loadMap = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } };
const saveExe = (id: string, exe: string | null) => {
  try {
    const m = loadMap();
    if (exe) m[id] = exe; else delete m[id];
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch { /* ignoruj */ }
};
const exeName = (p: string) => p.slice(p.lastIndexOf("\\") + 1).replace(/\.exe$/i, "");

/**
 * Panel z oknem innego programu (np. przeglądarki). Okno zostaje osobnym programem,
 * ale Rust (shell::dock_window) trzyma je dokładnie na obszarze tego panelu.
 */
export function AppPanel({ id, active, preset, onDocked, onClose, onNeedSize }: {
  id: string;
  preset?: WinInfo | null;                // okno wskazane z paska („włóż w panel WikExp”)
  active: boolean;
  onDocked: (d: Docked | null) => void;
  onClose: () => void;                    // × w programie → zamknij panel
  onNeedSize: (needW: number, needH: number, curW: number, curH: number) => void; // program większy niż panel (px CSS)
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState<Docked | null>(() => {
    if (!preset) return null;
    saveExe(id, preset.exe);
    return { hwnd: preset.hwnd, title: preset.title, exe: preset.exe };
  });
  const { palette } = useSettings();

  // ramka okna w kolorach WikExp: akcent, gdy panel aktywny, kolor ramek paneli, gdy nie
  useEffect(() => {
    if (!docked) return;
    styleDocked(docked.hwnd, active ? palette.accent : palette.overlay, palette.mantle, palette.text, !palette.light).catch(() => {});
  }, [docked, active, palette]);
  const [wins, setWins] = useState<WinInfo[]>([]);
  const [sel, setSel] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  // aktualne callbacki dla interwału (bez restartu dokowania przy każdym renderze)
  const cb = useRef({ onClose, onNeedSize });
  cb.current = { onClose, onNeedSize };

  useEffect(() => { onDocked(docked); }, [docked]); // eslint-disable-line react-hooks/exhaustive-deps

  const attach = (w: WinInfo) => {
    setDocked({ hwnd: w.hwnd, title: w.title, exe: w.exe });
    saveExe(id, w.exe);
    setMsg(null);
  };

  // wybór okna: lista odświeżana, dopóki nic nie jest zadokowane;
  // po restarcie automatycznie bierze okno tego samego programu co poprzednio
  useEffect(() => {
    if (docked) return;
    let alive = true;
    const want = loadMap()[id];
    const tick = () => listWindows().then((w) => {
      if (!alive) return;
      setWins(w);
      const again = want && w.find((x) => x.exe === want);
      if (again) attach(again);
    }).catch(() => {});
    tick();
    const t = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [docked, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // zadokowane: okno podąża za panelem (rozmiar, przesunięcie), co 2 s wymuszamy pozycję
  // (gdyby użytkownik zminimalizował / zmaksymalizował okno) i sprawdzamy, czy jeszcze żyje
  useEffect(() => {
    if (!docked) return;
    const host = hostRef.current;
    if (!host) return;
    let last = "";
    let ticks = 0;
    let lastNeed = "";
    let closed = false;
    const sync = (force: boolean) => {
      const r = host.getBoundingClientRect();
      const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
      if (!force && key === last) return;
      last = key;
      dockWindow(docked.hwnd, r.left, r.top, r.width, r.height).then((st) => {
        if (closed) return;
        // × w programie: okno zniknęło albo schowało się do zasobnika → zamknij panel
        if (!st.alive || !st.visible) { closed = true; cb.current.onClose(); return; }
        // — w programie: panel pokazuje „przywróć”, okna nie ruszamy
        setMinimized(st.minimized);
        if (st.minimized) { last = ""; return; }
        // maksymalizacja: Rust już cofnął ją do panelu. Nie przełączamy powiększenia panelu,
        // bo część programów (np. Discord) maksymalizuje się sama, co dawało pętlę.
        // Powiększenie na całą przestrzeń jest w menu pod prawym klikiem na uchwycie.
        if (st.maximized) last = ""; // przy następnym tyknięciu ustaw jeszcze raz (gdyby znów się zmaksymalizował)
        // program nie zmieścił się (ma minimalny rozmiar) → panel ma się powiększyć
        if (st.w > r.width + 4 || st.h > r.height + 4) {
          const need = `${Math.round(st.w)}x${Math.round(st.h)}`;
          if (need !== lastNeed) { lastNeed = need; cb.current.onNeedSize(st.w, st.h, r.width, r.height); }
        }
      }).catch(() => {});
    };
    sync(true);
    const t = setInterval(() => sync(++ticks % 8 === 0), 250);
    const onResize = () => sync(true);
    window.addEventListener("resize", onResize);
    return () => {
      clearInterval(t);
      window.removeEventListener("resize", onResize);
      undockWindow(docked.hwnd).catch(() => {});   // zamknięty panel = okno wraca do normalności
    };
  }, [docked, id]);

  // Enter w panelu ze zminimalizowanym programem → przywróć
  useEffect(() => {
    if (!active || !docked || !minimized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); windowAction(docked.hwnd, "focus").then(() => setMinimized(false)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, docked, minimized]);

  // klawiatura w trybie wyboru
  useEffect(() => {
    if (!active || docked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(i + 1, wins.length - 1)); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
      else if (e.key === "Enter" && wins[sel]) { e.preventDefault(); attach(wins[sel]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  if (docked) {
    // widać to tylko na moment, zanim okno programu przykryje panel
    return (
      <div ref={hostRef} className="app-host">
        {minimized ? (
          <div className="app-min">
            <div><span className="accent">{exeName(docked.exe)}</span> <span className="muted">zminimalizowany</span></div>
            <div className="app-min-btns">
              <button className="btn" onClick={() => windowAction(docked.hwnd, "focus").then(() => setMinimized(false))}>przywróć</button>
              <button className="btn danger" onClick={() => { windowAction(docked.hwnd, "close").catch(() => {}); cb.current.onClose(); }}>zamknij</button>
            </div>
          </div>
        ) : (
          <div className="app-placeholder muted">{exeName(docked.exe)} · {docked.title}</div>
        )}
      </div>
    );
  }

  return (
    <div ref={hostRef} className="app-host app-pick">
      <div className="set-section">wybierz okno do włożenia w panel</div>
      {msg && <div className="row yellow">{msg}</div>}
      {wins.length === 0 && <div className="row muted">brak otwartych okien</div>}
      {wins.map((w, i) => (
        <div key={w.hwnd} className={`row app-row ${i === sel && active ? "sel" : ""}`}
          onClick={() => setSel(i)} onDoubleClick={() => attach(w)}>
          {w.icon ? <img src={w.icon} alt="" /> : <span className="app-row-dot" />}
          <span className="c-name ellipsis">{w.title}</span>
          <span className="muted">{exeName(w.exe)}</span>
        </div>
      ))}
      <div className="muted set-hint">j/k wybór · enter albo dwuklik włóż · zamknięcie panelu oddaje okno</div>
    </div>
  );
}
