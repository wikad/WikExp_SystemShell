import { useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { hideFlyout, powerAction, type PowerAction } from "./api";

type Opt = { id: PowerAction; label: string; hint?: string; danger?: boolean; icon: ReactNode };

const svg = (d: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);

const OPTIONS: Opt[] = [
  { id: "lock", label: "Zablokuj", hint: "programy zostają", icon: svg(<><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>) },
  { id: "sleep", label: "Uśpij", hint: "wznowienie od razu", icon: svg(<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />) },
  { id: "logoff", label: "Wyloguj", hint: "zamyka wszystkie programy", danger: true, icon: svg(<><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" /><path d="m15 8 4 4-4 4" /><path d="M19 12H9" /></>) },
  { id: "restart", label: "Uruchom ponownie", hint: "zamyka wszystkie programy", danger: true, icon: svg(<><path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20 4v5h-5" /></>) },
  { id: "shutdown", label: "Wyłącz komputer", hint: "zamyka wszystkie programy", danger: true, icon: svg(<><path d="M12 3v9" /><path d="M6.4 6.6a8 8 0 1 0 11.2 0" /></>) },
];

/**
 * Wysuwany panel obok paska (osobne okno Tauri "flyout"), otwierany przyciskiem zasilania.
 * Miejsce na kolejne sekcje (głośność, sieć) pod nagłówkiem "Zasilanie".
 * Opcje, które zamykają programy, wymagają potwierdzenia w tym samym wierszu.
 */
export function Flyout() {
  const [sel, setSel] = useState(0);
  const [confirm, setConfirm] = useState<PowerAction | null>(null);
  const [openKey, setOpenKey] = useState(0);     // zmiana klucza = animacja wysunięcia od nowa
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const open = listen("flyout-open", () => { setSel(0); setConfirm(null); setError(null); setOpenKey((k) => k + 1); rootRef.current?.focus(); });
    // kliknięcie poza panelem = schowaj
    const blur = getCurrentWindow().onFocusChanged(({ payload: focused }) => { if (!focused) hideFlyout(); });
    return () => { open.then((f) => f()); blur.then((f) => f()); };
  }, []);

  const run = (o: Opt) => {
    powerAction(o.id)
      .then(() => hideFlyout())
      .catch((e) => setError(String(e)));
  };
  const choose = (o: Opt) => { if (o.danger && confirm !== o.id) setConfirm(o.id); else run(o); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); if (confirm) setConfirm(null); else hideFlyout(); }
    else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); setConfirm(null); setSel((s) => (s + 1) % OPTIONS.length); }
    else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); setConfirm(null); setSel((s) => (s + OPTIONS.length - 1) % OPTIONS.length); }
    else if (e.key === "Enter") { e.preventDefault(); choose(OPTIONS[sel]); }
  };

  return (
    <div className="flyout" ref={rootRef} tabIndex={0} autoFocus onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
      <div className="fo-inner" key={openKey}>
        <div className="fo-title">Zasilanie</div>
        {OPTIONS.map((o, i) => (
          <div key={o.id} className={`fo-row ${i === sel ? "sel" : ""} ${o.danger ? "danger" : ""} ${confirm === o.id ? "ask" : ""}`}
            onMouseEnter={() => { setSel(i); if (confirm && confirm !== o.id) setConfirm(null); }}
            onClick={() => choose(o)}>
            <span className="fo-icon">{o.icon}</span>
            {confirm === o.id ? (
              <span className="fo-ask">
                <span className="fo-label">Na pewno?</span>
                <button className="fo-yes" onClick={(e) => { e.stopPropagation(); run(o); }}>Tak</button>
                <button className="fo-no" onClick={(e) => { e.stopPropagation(); setConfirm(null); }}>Nie</button>
              </span>
            ) : (
              <span className="fo-text">
                <span className="fo-label">{o.label}</span>
                {o.hint && <span className="fo-hint muted">{o.hint}</span>}
              </span>
            )}
          </div>
        ))}
        {error && <div className="fo-error red">{error}</div>}
        <div className="fo-foot muted">↑↓ wybór · Enter · Esc zamyka</div>
      </div>
    </div>
  );
}
