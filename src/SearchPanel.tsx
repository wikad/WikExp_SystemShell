import { useEffect, useMemo, useRef, useState } from "react";
import { gitStatus, searchFiles, type SearchResult } from "./api";

const DEBOUNCE_MS = 250;
const baseName = (p: string) => p.slice(p.lastIndexOf("\\") + 1);

/**
 * Szukanie w całym projekcie (Ctrl+Shift+F). Projekt = repozytorium git, w którym leży
 * folder połączonego panelu plików, a gdy to nie repo: sam ten folder.
 * Wyniki pogrupowane po plikach; klik / Enter otwiera plik w panelu plików na tej linii.
 * - focus: żądanie fokusu z Ctrl+Shift+F (`n` rośnie), opcjonalnie z tekstem do wpisania
 */
export function SearchPanel({ cwd, active, focus, onOpen }: {
  cwd: string | null;
  active: boolean;
  focus: { n: number; text?: string } | null;
  onOpen: (path: string, line: number, col: number, len: number) => void;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [caseSens, setCaseSens] = useState(false);
  const [word, setWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [res, setRes] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);

  // katalog projektu: główny folder repo albo bieżący folder
  useEffect(() => {
    if (!cwd) { setRoot(null); return; }
    gitStatus(cwd).then((s) => setRoot(s.isRepo ? s.root : cwd)).catch(() => setRoot(cwd));
  }, [cwd]);

  // Ctrl+Shift+F: fokus na pole, zaznaczony tekst z edytora trafia do zapytania
  useEffect(() => {
    if (!focus) return;
    if (focus.text) setQuery(focus.text);
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
  }, [focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (active) inputRef.current?.focus(); }, [active]);

  // szukanie z opóźnieniem: nie przy każdym klawiszu, tylko gdy przestaniesz pisać
  useEffect(() => {
    if (!root || !query) { setRes(null); setError(null); setBusy(false); return; }
    const id = ++reqId.current;
    setBusy(true);
    const t = setTimeout(() => {
      searchFiles(root, query, caseSens, word, regex)
        .then((r) => {
          if (id !== reqId.current || r.cancelled) return; // przyszło nowsze zapytanie
          setRes(r); setError(null); setSel(0); setCollapsed({});
        })
        .catch((e) => { if (id === reqId.current) { setError(String(e)); setRes(null); } })
        .finally(() => { if (id === reqId.current) setBusy(false); });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [root, query, caseSens, word, regex]);

  // płaska lista widocznych trafień (do poruszania się strzałkami)
  const flat = useMemo(() => {
    const out: { path: string; line: number; col: number; len: number }[] = [];
    for (const f of res?.files ?? []) {
      if (collapsed[f.path]) continue;
      for (const h of f.hits) out.push({ path: f.path, line: h.line, col: h.col, len: h.len });
    }
    return out;
  }, [res, collapsed]);

  useEffect(() => {
    listRef.current?.querySelector(".sr-hit.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const open = (i: number) => {
    const h = flat[i];
    if (h) onOpen(h.path, h.line, h.col, h.len);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(i + 1, flat.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); open(sel); }
    else if (e.key === "Escape") { e.preventDefault(); setQuery(""); }
    else if (e.altKey && e.code === "KeyC") { e.preventDefault(); setCaseSens((v) => !v); }
    else if (e.altKey && e.code === "KeyW") { e.preventDefault(); setWord((v) => !v); }
    else if (e.altKey && e.code === "KeyR") { e.preventDefault(); setRegex((v) => !v); }
  };

  const toggle = (on: boolean, set: (f: (v: boolean) => boolean) => void, label: string, title: string) => (
    <button className={`sr-opt ${on ? "on" : ""}`} title={title} onClick={() => { set((v) => !v); inputRef.current?.focus(); }}>{label}</button>
  );

  if (!cwd) return <div className="row muted">otwórz folder w panelu plików</div>;

  let idx = -1; // numer trafienia w płaskiej liście, liczony podczas renderowania
  return (
    <div className="sr">
      <div className="sr-head">
        <input ref={inputRef} className="sr-input" placeholder="szukaj w projekcie…" value={query} spellCheck={false}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
        {toggle(caseSens, setCaseSens, "Aa", "wielkość liter (alt+c)")}
        {toggle(word, setWord, "ab", "całe słowa (alt+w)")}
        {toggle(regex, setRegex, ".*", "wyrażenie regularne (alt+r)")}
      </div>
      <div className="sr-info muted">
        <span className="ellipsis" title={root ?? ""}>{root ? baseName(root) || root : "…"}</span>
        <span className="spacer" />
        {busy ? "szukam…"
          : error ? <span className="red">{error}</span>
          : res ? `${res.total}${res.truncated ? "+" : ""} w ${res.files.length} plikach`
          : "↑↓ wybierz · enter otwórz · esc wyczyść"}
      </div>
      <div className="sr-list" ref={listRef}>
        {res && res.files.length === 0 && !busy && <div className="row muted">brak wyników</div>}
        {res?.files.map((f) => (
          <div key={f.path}>
            <div className="row sr-file" onClick={() => setCollapsed((c) => ({ ...c, [f.path]: !c[f.path] }))} title={f.path}>
              <span className="muted">{collapsed[f.path] ? "▸ " : "▾ "}</span>
              <span className="accent">{baseName(f.rel)}</span>
              <span className="muted ellipsis sr-dir">{f.rel.includes("\\") ? " " + f.rel.slice(0, f.rel.lastIndexOf("\\")) : ""}</span>
              <span className="spacer" />
              <span className="sr-count">{f.hits.length}</span>
            </div>
            {!collapsed[f.path] && f.hits.map((h) => {
              const i = ++idx;
              return (
                <div key={`${h.line}:${h.col}`} className={`row sr-hit ${i === sel ? "sel" : ""}`}
                  onClick={() => { setSel(i); open(i); }}>
                  <span className="sr-ln muted">{h.line}</span>
                  <span className="ellipsis">
                    {h.text.slice(0, h.hl)}<mark className="sr-mark">{h.text.slice(h.hl, h.hl + h.len)}</mark>{h.text.slice(h.hl + h.len)}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
