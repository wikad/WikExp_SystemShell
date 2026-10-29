import { useEffect, useState } from "react";
import { Menu } from "@tauri-apps/api/menu";
import { emit } from "@tauri-apps/api/event";
import { batteryStatus, listWindows, showMain, toggleFlyout, toggleLauncher, windowAction, type Battery, type WinInfo } from "./api";

const fmtLeft = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
};

/** Pionowa ikona baterii z poziomem naładowania i błyskawicą przy ładowaniu. */
function BatteryIcon({ b }: { b: Battery }) {
  const color = b.charging || b.plugged ? "var(--green)"
    : b.percent <= 15 ? "var(--red)" : b.percent <= 30 ? "var(--yellow)" : "var(--green)";
  const h = Math.max(1.5, (b.percent / 100) * 17);   // wysokość wypełnienia (wnętrze 17 jednostek)
  return (
    <svg width="13" height="21" viewBox="0 0 16 26" className={b.percent <= 15 && !b.plugged ? "bar-bat-low" : ""}>
      <rect x="5" y="0.5" width="6" height="2.5" rx="1" fill="var(--muted)" />
      <rect x="1" y="3" width="14" height="22" rx="3" fill="none" stroke="var(--muted)" strokeWidth="1.5" />
      <rect x="3.5" y={5.5 + (17 - h)} width="9" height={h} rx="1.5" fill={color} />
      {b.charging && <path d="M9.2 7.5 5.5 14.6h2.6l-1.2 5.4 4-7.4H8.3l.9-5.1z" fill="var(--yellow)" stroke="var(--base)" strokeWidth="1" strokeLinejoin="round" paintOrder="stroke" />}
    </svg>
  );
}

const REFRESH_MS = 700;
const exeName = (path: string) => path.slice(path.lastIndexOf("\\") + 1).replace(/\.exe$/i, "");

/**
 * Wąski pasek z lewej strony ekranu, zamiast paska zadań Windows:
 * przycisk WikExp, otwarte programy, zegar i data.
 * Osobne okno Tauri (label "bar"), zarezerwowane jako AppBar w shell.rs.
 */
export function Bar() {
  const [wins, setWins] = useState<WinInfo[]>([]);
  const [now, setNow] = useState(new Date());
  const [battery, setBattery] = useState<Battery | null>(null);
  // kolejność jak na pasku Windows: według pierwszego pojawienia się, nie według fokusu
  const [order, setOrder] = useState<number[]>([]);

  const refresh = () =>
    listWindows()
      .then((w) => {
        setWins(w);
        setOrder((o) => {
          const alive = o.filter((h) => w.some((x) => x.hwnd === h));
          const fresh = w.map((x) => x.hwnd).filter((h) => !alive.includes(h));
          return [...alive, ...fresh];
        });
      })
      .catch(() => {});

  useEffect(() => {
    refresh();
    const a = setInterval(refresh, REFRESH_MS);
    const b = setInterval(() => setNow(new Date()), 1000);
    const readBattery = () => batteryStatus().then(setBattery).catch(() => setBattery(null));
    readBattery();
    const c = setInterval(readBattery, 10000);
    return () => { clearInterval(a); clearInterval(b); clearInterval(c); };
  }, []);

  const sorted = order.map((h) => wins.find((w) => w.hwnd === h)).filter((w): w is WinInfo => !!w);

  // jak w Windows: klik w aktywne okno = minimalizuj, w inne = przełącz; środkowy przycisk = zamknij
  const onClick = (w: WinInfo) => windowAction(w.hwnd, w.active && !w.minimized ? "minimize" : "focus").then(refresh);
  // prawy klik: natywne menu (pasek ma 40 px, własne menu by się nie zmieściło)
  const onMenu = async (e: React.MouseEvent, w: WinInfo) => {
    e.preventDefault();
    const menu = await Menu.new({
      items: [
        { id: "dock", text: "Włóż w panel WikExp", action: () => { emit("dock-request", w); } },
        { item: "Separator" },
        { id: "min", text: w.minimized ? "Przywróć" : "Minimalizuj",
          action: () => { windowAction(w.hwnd, w.minimized ? "focus" : "minimize").then(refresh); } },
        { id: "close", text: "Zamknij okno", action: () => { windowAction(w.hwnd, "close").then(() => setTimeout(refresh, 300)); } },
      ],
    });
    await menu.popup();
  };
  const onAux = (e: React.MouseEvent, w: WinInfo) => {
    if (e.button === 1) { e.preventDefault(); windowAction(w.hwnd, "close").then(() => setTimeout(refresh, 300)); }
  };

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const date = `${String(now.getDate()).padStart(2, "0")}.${String(now.getMonth() + 1).padStart(2, "0")}`;
  const day = now.toLocaleDateString("pl-PL", { weekday: "short" }).replace(".", "");

  return (
    <div className="bar" onContextMenu={(e) => e.preventDefault()}>
      <button className="bar-start" title="WikExp" onClick={() => showMain()}>W</button>
      <button className="bar-search" title="szukaj programu (Alt+Spacja)" onClick={() => toggleLauncher()}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
        </svg>
      </button>
      <div className="bar-sep" />

      <div className="bar-apps">
        {sorted.map((w) => (
          <button
            key={w.hwnd}
            className={`bar-app ${w.active && !w.minimized ? "active" : ""} ${w.minimized ? "min" : ""}`}
            title={`${w.title}\n${exeName(w.exe)} · prawy przycisk = opcje · środkowy = zamknij`}
            onClick={() => onClick(w)}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            onAuxClick={(e) => onAux(e, w)}
            onContextMenu={(e) => onMenu(e, w)}
          >
            {w.icon
              ? <img src={w.icon} alt="" draggable={false} />
              : <span className="bar-letter">{(exeName(w.exe) || w.title).slice(0, 1).toUpperCase()}</span>}
          </button>
        ))}
      </div>

      <div className="bar-sep" />
      <button className="bar-power" title="zasilanie" onClick={() => toggleFlyout()}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M12 3v9" /><path d="M6.4 6.6a8 8 0 1 0 11.2 0" />
        </svg>
      </button>
      {battery && (
        <div
          className="bar-battery"
          title={`bateria ${battery.percent}%`
            + (battery.charging ? " · ładowanie" : battery.plugged ? " · podłączona" : "")
            + (!battery.plugged && battery.secondsLeft != null ? ` · zostało ${fmtLeft(battery.secondsLeft)}` : "")
            + (battery.saver ? " · oszczędzanie baterii" : "")}
        >
          <BatteryIcon b={battery} />
          <span className={battery.percent <= 15 && !battery.plugged ? "red" : ""}>{battery.percent}%</span>
        </div>
      )}
      <div className="bar-clock" title={now.toLocaleString("pl-PL")}>
        <span className="bar-hh">{hh}</span>
        <span className="bar-mm">{mm}</span>
        <span className="bar-date">{date}</span>
        <span className="bar-day">{day}</span>
      </div>
      <button className="bar-desktop" title="pokaż WikExp" onClick={() => showMain()} />
    </div>
  );
}
