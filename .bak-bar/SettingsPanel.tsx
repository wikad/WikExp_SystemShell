import { useEffect, useRef, useState } from "react";
import { DEFAULTS, FONTS, SHELLS, THEMES, useSettings, type Settings } from "./settings";

type Item =
  | { kind: "choice"; key: keyof Settings; label: string; options: { value: unknown; label: string }[] }
  | { kind: "toggle"; key: keyof Settings; label: string }
  | { kind: "action"; label: string; run: () => void; danger?: boolean }
  | { kind: "section"; label: string };

const range = (from: number, to: number, step: number, fmt: (n: number) => string) =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step).map((v) => ({ value: v, label: fmt(v) }));

export function SettingsPanel({ active, onResetLayout }: { active: boolean; onResetLayout: () => void }) {
  const { settings, set, reset } = useSettings();
  const [confirm, setConfirm] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // akcje nieodwracalne wymagają dwóch naciśnięć
  const armed = (label: string, run: () => void) => () => {
    if (confirm === label) { run(); setConfirm(null); } else setConfirm(label);
  };
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(null), 3000);
    return () => clearTimeout(t);
  }, [confirm]);

  const items: Item[] = [
    { kind: "section", label: "wygląd" },
    { kind: "choice", key: "theme", label: "motyw", options: Object.entries(THEMES).map(([k, p]) => ({ value: k, label: p.name })) },
    { kind: "choice", key: "font", label: "font", options: FONTS.map((f) => ({ value: f, label: f.replace(/"/g, "") })) },
    { kind: "choice", key: "fontSize", label: "rozmiar tekstu", options: range(11, 18, 1, (n) => `${n} px`) },
    { kind: "choice", key: "gap", label: "odstęp między panelami", options: range(2, 16, 2, (n) => `${n} px`) },
    { kind: "choice", key: "radius", label: "zaokrąglenie rogów", options: range(0, 12, 2, (n) => `${n} px`) },
    { kind: "section", label: "terminal" },
    { kind: "choice", key: "shell", label: "shell (nowe terminale)", options: SHELLS.map((s) => ({ value: s, label: s })) },
    { kind: "choice", key: "cursorStyle", label: "kursor", options: [
      { value: "bar", label: "kreska │" }, { value: "block", label: "blok █" }, { value: "underline", label: "podkreślenie _" }] },
    { kind: "toggle", key: "cursorBlink", label: "miganie kursora" },
    { kind: "choice", key: "scrollback", label: "historia linii", options: [1000, 5000, 10000, 50000].map((n) => ({ value: n, label: String(n) })) },
    { kind: "section", label: "pliki i monitor" },
    { kind: "toggle", key: "showHidden", label: "pokazuj ukryte pliki" },
    { kind: "choice", key: "monitorRefresh", label: "odświeżanie monitora", options: [500, 1000, 2000, 5000].map((n) => ({ value: n, label: `${n / 1000} s` })) },
    { kind: "section", label: "reset" },
    { kind: "action", label: "domyślny układ paneli", run: armed("layout", onResetLayout), danger: true },
    { kind: "action", label: "domyślne ustawienia", run: armed("settings", reset), danger: true },
  ];
  const selectable = items.map((it, i) => (it.kind === "section" ? -1 : i)).filter((i) => i >= 0);
  const [sel, setSel] = useState(selectable[0]);

  const change = (it: Item, dir: 1 | -1) => {
    if (it.kind === "toggle") set(it.key, !settings[it.key] as never);
    else if (it.kind === "choice") {
      const i = it.options.findIndex((o) => o.value === settings[it.key]);
      const next = it.options[(Math.max(i, 0) + dir + it.options.length) % it.options.length];
      set(it.key, next.value as never);
    } else if (it.kind === "action") it.run();
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey) return;
      const pos = selectable.indexOf(sel);
      const it = items[sel];
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setSel(selectable[Math.min(pos + 1, selectable.length - 1)]); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setSel(selectable[Math.max(pos - 1, 0)]); }
      else if (e.key === "l" || e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") { e.preventDefault(); change(it, 1); }
      else if (e.key === "h" || e.key === "ArrowLeft") { e.preventDefault(); if (it.kind !== "action") change(it, -1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    listRef.current?.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel, active]);

  const valueLabel = (it: Item) => {
    if (it.kind === "toggle") return settings[it.key] ? "włączone" : "wyłączone";
    if (it.kind === "choice") return it.options.find((o) => o.value === settings[it.key])?.label ?? String(settings[it.key]);
    return "";
  };
  const isDefault = (it: Item) => (it.kind === "choice" || it.kind === "toggle") && settings[it.key] === DEFAULTS[it.key];

  return (
    <div className="settings" ref={listRef}>
      <div className="theme-grid">
        {Object.entries(THEMES).map(([k, p]) => {
          const on = settings.theme === k;
          return (
            <button key={k} className={`theme-card ${on ? "on" : ""}`} onClick={() => set("theme", k)}
              style={{ background: `linear-gradient(135deg, ${p.base} 0%, ${p.mantle} 100%)`, color: p.text,
                borderColor: on ? p.accent : p.overlay, ["--card-accent" as string]: p.accent }}>
              <span className="theme-top">
                <span className="theme-name">{p.name}</span>
                {on && <span className="theme-check" style={{ background: p.accent, color: p.base }}>✓</span>}
              </span>
              <span className="theme-swatches">
                {[p.accent, p.blue, p.green, p.yellow, p.red, p.cyan].map((c) => <i key={c} style={{ background: c }} />)}
              </span>
            </button>
          );
        })}
      </div>

      {items.map((it, i) =>
        it.kind === "section" ? (
          <div key={i} className="set-section">{it.label}</div>
        ) : (
          <div key={i} className={`set-row ${i === sel && active ? "sel" : ""}`} onClick={() => setSel(i)}>
            <span className="set-label">{it.label}</span>
            {it.kind === "toggle" ? (
              // przełącznik jak w telefonie
              <button className={`switch ${settings[it.key] ? "on" : ""}`}
                onClick={(e) => { e.stopPropagation(); setSel(i); change(it, 1); }}>
                <span className="knob" />
              </button>
            ) : it.kind === "choice" ? (
              <span className="pill">
                <button className="pill-btn" onClick={(e) => { e.stopPropagation(); setSel(i); change(it, -1); }}>‹</button>
                <span className={`pill-value ${isDefault(it) ? "" : "changed"}`}>{valueLabel(it)}</span>
                <button className="pill-btn" onClick={(e) => { e.stopPropagation(); setSel(i); change(it, 1); }}>›</button>
              </span>
            ) : (
              <button className={`btn ${it.danger ? "danger" : ""} ${confirm && it.label.includes(confirm === "layout" ? "układ" : "ustawienia") ? "armed" : ""}`}
                onClick={(e) => { e.stopPropagation(); setSel(i); it.run(); }}>
                {confirm && it.label.includes(confirm === "layout" ? "układ" : "ustawienia") ? "na pewno?" : "przywróć"}
              </button>
            )}
          </div>
        ),
      )}
      <div className="muted set-hint">j/k wybór · h/l zmiana · enter akcja · zmieniona wartość ma kolor akcentu</div>
    </div>
  );
}
