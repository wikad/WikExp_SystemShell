import { useEffect, useRef, useState } from "react";
import { readDir } from "./api";
import { TerminalPanel } from "./TerminalPanel";

// "C:\foo\" i "\"C:\foo\"" (skopiowane jako ścieżka z Eksploratora) → "C:\foo"
const clean = (s: string) => {
  let p = s.trim().replace(/^"(.*)"$/, "$1").trim();
  if (p.length > 3) p = p.replace(/[\\/]+$/, "");
  return p.replace(/\//g, "\\");
};

/**
 * Panel Claude Code. Bez wybranego folderu pokazuje ekran startowy (folder z panelu plików,
 * ostatnie foldery, własna ścieżka); po wyborze uruchamia `claude` w tym folderze.
 * Ctrl+Shift+O w działającym panelu = zabij sesję i wybierz folder od nowa.
 */
export function ClaudePanel({ sessionId, active, dir, linkedDir, recent, onPick, onForget, onReset }: {
  sessionId: string;
  active: boolean;
  dir: string | null;
  linkedDir: string | null;
  recent: string[];
  onPick: (dir: string) => void;
  onForget: (dir: string) => void;
  onReset: () => void;
}) {
  useEffect(() => {
    if (!active || !dir) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyO") {
        e.preventDefault();
        e.stopPropagation();
        onReset();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, dir, onReset]);

  if (!dir) {
    return <ClaudePicker active={active} linkedDir={linkedDir} recent={recent} onPick={onPick} onForget={onForget} />;
  }
  return <TerminalPanel key={dir} sessionId={sessionId} active={active} autorun="claude" cwd={dir} />;
}

function ClaudePicker({ active, linkedDir, recent, onPick, onForget }: {
  active: boolean;
  linkedDir: string | null;
  recent: string[];
  onPick: (dir: string) => void;
  onForget: (dir: string) => void;
}) {
  const items = [
    ...(linkedDir ? [{ path: linkedDir, tag: "folder z panelu plików" }] : []),
    ...recent.filter((p) => p !== linkedDir).map((p) => ({ path: p, tag: "" })),
  ];
  const [sel, setSel] = useState(0);          // items.length = pole ze ścieżką
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onInput = sel >= items.length;

  useEffect(() => { if (sel > items.length) setSel(items.length); }, [items.length, sel]);
  useEffect(() => {
    if (active) (onInput ? inputRef : rootRef).current?.focus();
  }, [active, onInput]);

  // sprawdza, czy folder istnieje (readDir odrzuca nieistniejące), potem startuje
  const start = (raw: string) => {
    const p = clean(raw);
    if (!p || busy) return;
    setBusy(true);
    setError(null);
    readDir(p).then(() => onPick(p)).catch(() => { setError(`Nie ma takiego folderu: ${p}`); setBusy(false); });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;   // Alt+h/j/k/l obsługuje App
    const inInput = e.target === inputRef.current;
    if (e.key === "Enter") {
      e.preventDefault();
      start(inInput ? text : items[sel]?.path ?? "");
    } else if (e.key === "ArrowDown" || (!inInput && e.key === "j")) {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length));
    } else if (e.key === "ArrowUp" || (!inInput && e.key === "k")) {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Escape" && inInput) {
      setSel(Math.max(items.length - 1, 0));
    } else if (!inInput && (e.key === "i" || e.key === "/")) {
      e.preventDefault();
      setSel(items.length);
    } else if (!inInput && e.key === "x" && sel < items.length && items[sel].path !== linkedDir) {
      onForget(items[sel].path);
    }
  };

  return (
    <div ref={rootRef} className="cl-pick" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="accent cl-head">Gdzie uruchomić Claude Code?</div>
      {items.map((it, i) => (
        <div key={it.path} className={`cl-item ${i === sel ? "sel" : ""}`} onClick={() => { setSel(i); start(it.path); }}>
          <span className="ellipsis">{it.path}</span>
          {it.tag && <span className="muted cl-tag">{it.tag}</span>}
        </div>
      ))}
      {items.length === 0 && <div className="muted cl-item">brak ostatnich folderów, wpisz ścieżkę poniżej</div>}
      <div className={`cl-item ${onInput ? "sel" : ""}`} onClick={() => setSel(items.length)}>
        <input
          ref={inputRef}
          className="sr-input"
          value={text}
          placeholder="wpisz lub wklej ścieżkę…"
          spellCheck={false}
          onChange={(e) => { setText(e.target.value); setError(null); }}
          onFocus={() => setSel(items.length)}
        />
      </div>
      {error && <div className="cl-item" style={{ color: "var(--red)" }}>{error}</div>}
      <div className="muted cl-hint">j/k ↑↓ wybór · Enter start · i ścieżka · x usuń z listy · w działającym panelu Ctrl+Shift+O = zmień folder</div>
    </div>
  );
}
