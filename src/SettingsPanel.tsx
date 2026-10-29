import { useEffect, useRef, useState } from "react";
import { DEFAULTS, FONTS, SHELLS, THEMES, useSettings, type Settings } from "./settings";
import { autostartList, emergencyExplorer, getLogPath, openPath, shellSet, shellStatus, type ShellStatus } from "./api";

type Item =
  | { kind: "choice"; key: keyof Settings; label: string; options: { value: unknown; label: string }[] }
  | { kind: "toggle"; key: keyof Settings; label: string }
  | { kind: "action"; label: string; run: () => void; danger?: boolean; button?: string; armKey?: string }
  | { kind: "info"; label: string; value: string }
  | { kind: "section"; label: string };

const range = (from: number, to: number, step: number, fmt: (n: number) => string) =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step).map((v) => ({ value: v, label: fmt(v) }));

export function SettingsPanel({ active, onResetLayout }: { active: boolean; onResetLayout: () => void }) {
  const { settings, set, reset } = useSettings();
  const [confirm, setConfirm] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [shell, setShell] = useState<ShellStatus | null>(null);
  const [shellErr, setShellErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [auto, setAuto] = useState<string>("…");
  useEffect(() => {
    autostartList()
      .then((l) => setAuto(`${l.filter((e) => e.enabled).length} włączonych, ${l.filter((e) => !e.enabled).length} wyłączonych w Menedżerze zadań`))
      .catch(() => setAuto("błąd odczytu"));
  }, []);
  const refreshShell = () => shellStatus().then((s) => { setShell(s); setShellErr(null); }).catch((e) => setShellErr(String(e)));
  useEffect(() => { refreshShell(); }, []);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 8000);
    return () => clearTimeout(t);
  }, [note]);
  const report = (p: Promise<unknown>, ok: string) =>
    p.then(() => setNote(ok)).catch((e) => setNote(String(e))).finally(refreshShell);

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
    { kind: "section", label: "powłoka" },
    { kind: "toggle", key: "hideTaskbar", label: "ukryj pasek zadań Windows (WikExp na cały ekran)" },
    { kind: "toggle", key: "desktopLayer", label: "WikExp jako pulpit (pod programami; przycisk W chowa programy)" },
    { kind: "section", label: "powłoka systemu i bezpieczeństwo" },
    { kind: "info", label: "WikExp jako powłoka (zamiast explorer.exe)",
      value: shellErr ? "błąd odczytu" : !shell ? "…" : shell.enabled ? "TAK, od następnego logowania" : shell.value ? `nie (Shell = ${shell.value})` : "nie (explorer.exe)" },
    { kind: "info", label: "autostart programów (robi WikExp, gdy jest powłoką)", value: auto },
    ...(shell?.dev ? [{ kind: "info" as const, label: "build developerski", value: "ustawienie powłoki zablokowane (użyj wersji release)" }] : []),
    { kind: "action", label: "ustaw WikExp jako powłokę (po wylogowaniu i zalogowaniu)", button: "ustaw", armKey: "shell-on", danger: true,
      run: armed("shell-on", () => report(shellSet(true), "Powłoka ustawiona. Zadziała po wylogowaniu i ponownym zalogowaniu. Awaryjnie: Ctrl+Alt+F12.")) },
    { kind: "action", label: "przywróć explorer.exe jako powłokę", button: "przywróć", armKey: "shell-off",
      run: armed("shell-off", () => report(shellSet(false), "Wpis powłoki usunięty: po zalogowaniu wróci explorer.exe.")) },
    { kind: "action", label: "uruchom explorer.exe teraz (awaryjnie, skrót Ctrl+Alt+F12)", button: "uruchom", armKey: "explorer-now",
      run: armed("explorer-now", () => report(emergencyExplorer(), "Uruchomiono explorer.exe, pasek Windows przywrócony.")) },
    { kind: "action", label: "otwórz log (%APPDATA%\\WikExp\\log.txt)", button: "otwórz",
      run: () => getLogPath().then((p) => (p ? openPath(p) : Promise.reject("brak ścieżki logu"))).catch((e) => setNote(String(e))) },
    { kind: "section", label: "reset" },
    { kind: "action", label: "domyślny układ paneli", run: armed("layout", onResetLayout), danger: true, armKey: "layout" },
    { kind: "action", label: "domyślne ustawienia", run: armed("settings", reset), danger: true, armKey: "settings" },
  ];
  const selectable = items.map((it, i) => (it.kind === "section" || it.kind === "info" ? -1 : i)).filter((i) => i >= 0);
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
      if (!it) return;
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
        ) : it.kind === "info" ? (
          <div key={i} className="set-row set-info">
            <span className="set-label">{it.label}</span>
            <span className={it.value.startsWith("TAK") ? "yellow" : "muted"}>{it.value}</span>
          </div>
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
              <button className={`btn ${it.danger ? "danger" : ""} ${it.armKey && confirm === it.armKey ? "armed" : ""}`}
                onClick={(e) => { e.stopPropagation(); setSel(i); it.run(); }}>
                {it.armKey && confirm === it.armKey ? "na pewno?" : it.button ?? "przywróć"}
              </button>
            )}
          </div>
        ),
      )}
      {note && <div className="row yellow">{note}</div>}
      <div className="muted set-hint">j/k wybór · h/l zmiana · enter akcja · zmieniona wartość ma kolor akcentu</div>
    </div>
  );
}
