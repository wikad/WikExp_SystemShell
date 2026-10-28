import { useEffect, useMemo, useRef, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { readDir, type FileEntry } from "./api";
import { useSettings } from "./settings";

// "C:\Users\wikto" → ["C:\", "C:\Users", "C:\Users\wikto"]
function ancestors(path: string): string[] {
  const parts = path.split("\\").filter(Boolean);
  if (parts.length === 0) return [];
  const out = [parts[0] + "\\"];
  let acc = out[0];
  for (const p of parts.slice(1)) {
    acc = acc.endsWith("\\") ? acc + p : acc + "\\" + p;
    out.push(acc);
  }
  return out;
}

const baseName = (path: string) =>
  path.endsWith("\\") ? path : path.slice(path.lastIndexOf("\\") + 1);

type Row = { path: string; name: string; depth: number; kind: "chain" | "dir" | "file" };

/**
 * Drzewo pokazuje folder `linkedCwd` (panelu plików, z którym jest połączone)
 * i przy otwarciu folderu woła `onOpen`. Bez połączonego panelu plików
 * (linkedCwd === null) chodzi po folderach samodzielnie.
 */
export function TreePanel({ linkedCwd, active, onOpen, onOpenFile, openPaths }: {
  linkedCwd: string | null;
  active: boolean;
  onOpen: ((path: string) => void) | null;
  onOpenFile: ((path: string) => void) | null;   // plik → edytor w panelu plików
  openPaths: string[];                            // pliki otwarte w edytorach (podświetlenie)
}) {
  const [ownCwd, setOwnCwd] = useState<string | null>(null);
  const cwd = linkedCwd ?? ownCwd;
  // lista razem z folderem, z którego pochodzi: stara lista nie miesza się z nową ścieżką
  const [listing, setListing] = useState<{ dir: string; files: FileEntry[] } | null>(null);
  const files = listing && listing.dir === cwd ? listing.files : [];
  const [selected, setSelected] = useState(0);
  const { showHidden } = useSettings().settings;

  useEffect(() => {
    if (linkedCwd) setOwnCwd(linkedCwd);          // po odłączeniu zostań tam, gdzie był panel plików
    else if (!ownCwd) homeDir().then(setOwnCwd);
  }, [linkedCwd]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!cwd) return;
    readDir(cwd)
      .then((f) => setListing({ dir: cwd, files: f }))
      .catch(() => setListing({ dir: cwd, files: [] }));
  }, [cwd]);

  const go = (path: string) => {
    setOwnCwd(path);
    onOpen?.(path);
  };
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<Row[]>(() => {
    if (!cwd) return [];
    // 1) sama ścieżka: C:\ → Users → wikto (bez rodzeństwa)
    const chain = ancestors(cwd);
    const out: Row[] = chain.map((p, i) => ({ path: p, name: baseName(p), depth: i, kind: "chain" }));
    // 2) zawartość bieżącego folderu: foldery i pliki, bez ukrytych
    for (const f of files) {
      if (f.hidden && !showHidden) continue;
      out.push({ path: f.path, name: f.name, depth: chain.length, kind: f.isDir ? "dir" : "file" });
    }
    return out;
  }, [cwd, files, showHidden]);

  // po zmianie folderu zaznacz bieżący folder (ostatni element ścieżki)
  useEffect(() => {
    if (cwd) setSelected(ancestors(cwd).length - 1);
  }, [cwd]);

  const open = (r: Row | undefined) => {
    if (!r) return;
    if (r.kind === "file") onOpenFile?.(r.path);
    else if (r.path !== cwd) go(r.path);
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, rows.length - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
      } else if (e.key === "l" || e.key === "Enter" || e.key === "ArrowRight") {
        e.preventDefault();
        open(rows[selected]);
      } else if (e.key === "h" || e.key === "ArrowLeft" || e.key === "Backspace") {
        e.preventDefault();
        const chain = cwd ? ancestors(cwd) : [];
        if (chain.length > 1) go(chain[chain.length - 2]);   // folder wyżej
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, rows, selected, cwd, onOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    listRef.current?.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
  }, [selected, active]);

  return (
    <div ref={listRef}>
      {rows.map((r, i) => {
        const isCwd = r.path === cwd;
        const icon = r.kind === "file" ? "  " : isCwd ? "▾ " : r.kind === "chain" ? "▾ " : "▸ ";
        const color = isCwd ? "accent" : r.kind === "file" ? "" : r.kind === "chain" ? "muted" : "accent";
        // otwarty plik i foldery, w których leży (żeby było widać drogę do niego)
        const isOpen = openPaths.includes(r.path);
        const prefix = r.path.endsWith("\\") ? r.path : r.path + "\\";
        const holdsOpen = !isOpen && r.kind !== "file" && openPaths.some((p) => p.startsWith(prefix));
        return (
          <div
            key={`${r.kind}:${r.path}`}
            className={`row ${i === selected && active ? "sel" : ""} ${isOpen ? "open-file" : ""} ${holdsOpen ? "holds-open" : ""}`}
            onClick={() => { setSelected(i); open(r); }}
          >
            <span className="muted">{"  ".repeat(r.depth)}{icon}</span>
            <span className={color}>{r.name}{r.kind === "dir" ? "\\" : ""}</span>
          </div>
        );
      })}
    </div>
  );
}
