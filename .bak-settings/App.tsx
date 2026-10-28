import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./App.css";
import { TerminalPanel } from "./TerminalPanel";
import { TreePanel } from "./TreePanel";
import { FilesPanel, type OpenFile } from "./FilesPanel";
import { ProcessesPanel } from "./ProcessesPanel";
import { DockerPanel } from "./DockerPanel";
import { MonitorPanel } from "./MonitorPanel";
import { Workspace } from "./Workspace";
import { loadLayout, saveLayout, PANEL_NAMES, type PanelId, type PanelKind, type Rect } from "./layout";

type Dir = "h" | "j" | "k" | "l";
const DIR_BY_CODE: Record<string, Dir> = { KeyH: "h", KeyJ: "j", KeyK: "k", KeyL: "l" };

// Nawigacja przestrzenna: szuka panelu w danym kierunku na podstawie
// faktycznych pozycji na ekranie, więc działa przy każdym układzie grida.
function findNeighbor(from: PanelId, dir: Dir, recent: PanelId[]): PanelId | null {
  const rectOf = (id: string) =>
    document.querySelector(`[data-panel="${id}"]`)?.getBoundingClientRect();
  const a = rectOf(from);
  if (!a) return null;

  let best: { id: PanelId; dist: number; rank: number } | null = null;
  for (const el of document.querySelectorAll<HTMLElement>("[data-panel]")) {
    const id = el.dataset.panel as PanelId;
    if (id === from) continue;
    const b = el.getBoundingClientRect();

    // panel musi leżeć w danym kierunku i nachodzić na nas w osi prostopadłej
    const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    let dist: number;
    if (dir === "h" && b.right <= a.left + 1 && overlapY > 0) dist = a.left - b.right;
    else if (dir === "l" && b.left >= a.right - 1 && overlapY > 0) dist = b.left - a.right;
    else if (dir === "k" && b.bottom <= a.top + 1 && overlapX > 0) dist = a.top - b.bottom;
    else if (dir === "j" && b.top >= a.bottom - 1 && overlapX > 0) dist = b.top - a.bottom;
    else continue;

    // remis odległości → wygrywa panel, który był aktywny ostatnio
    const r = recent.indexOf(id);
    const rank = r === -1 ? Infinity : r;
    if (!best || dist < best.dist - 1 || (Math.abs(dist - best.dist) <= 1 && rank < best.rank)) {
      best = { id, dist, rank };
    }
  }
  if (best) return best.id;

  // Zawijanie: w tym kierunku nic nie ma → przeskocz na przeciwną krawędź,
  // do najdalszego panelu, który nachodzi na nas w osi prostopadłej.
  let wrap: { id: PanelId; dist: number; rank: number } | null = null;
  for (const el of document.querySelectorAll<HTMLElement>("[data-panel]")) {
    const id = el.dataset.panel as PanelId;
    if (id === from) continue;
    const b = el.getBoundingClientRect();
    const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    let dist: number;
    if (dir === "l" && b.right <= a.left + 1 && overlapY > 0) dist = a.left - b.left;
    else if (dir === "h" && b.left >= a.right - 1 && overlapY > 0) dist = b.right - a.right;
    else if (dir === "j" && b.bottom <= a.top + 1 && overlapX > 0) dist = a.top - b.top;
    else if (dir === "k" && b.top >= a.bottom - 1 && overlapX > 0) dist = b.bottom - a.bottom;
    else continue;
    const r = recent.indexOf(id);
    const rank = r === -1 ? Infinity : r;
    if (!wrap || dist > wrap.dist + 1 || (Math.abs(dist - wrap.dist) <= 1 && rank < wrap.rank)) {
      wrap = { id, dist, rank };
    }
  }
  return wrap?.id ?? null;
}

const MODE: Record<PanelKind | "editor", string> = {
    editor: "EDYCJA",
    tree: "NORMAL", files: "NORMAL", terminal: "TERMINAL", side: "PROCESY", docker: "DOCKER", monitor: "MONITOR",
  };

// ostatnie foldery paneli plików, żeby po restarcie każdy wrócił tam, gdzie był
const CWD_KEY = "wikexp.cwds.v1";
const loadCwds = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem(CWD_KEY) ?? "{}"); } catch { return {}; }
};

// "files" → "pliki", "files-2" → "pliki 2"
const instanceTitle = (r: Rect) => {
  const n = r.id.slice(r.kind.length + 1);
  return n ? `${PANEL_NAMES[r.kind]} ${n}` : PANEL_NAMES[r.kind];
};

export default function App() {
  const [layout, setLayout] = useState<Rect[]>(loadLayout);
  const [active, setActive] = useState<PanelId>(() => layout[0]?.id ?? "files");
  useEffect(() => saveLayout(layout), [layout]);
  const activeKind: PanelKind = layout.find((r) => r.id === active)?.kind ?? "files";

  // aktywny panel zamknięty → fokus wraca na poprzednio używany (albo pierwszy otwarty)
  useEffect(() => {
    if (!layout.length || layout.some((r) => r.id === active)) return;
    const prev = recent.current.find((id) => layout.some((r) => r.id === id));
    setActive(prev ?? layout[0].id);
  }, [layout, active]);

  // foldery wszystkich paneli plików (id → ścieżka)
  const [cwds, setCwds] = useState<Record<string, string>>(loadCwds);
  useEffect(() => {
    try { localStorage.setItem(CWD_KEY, JSON.stringify(cwds)); } catch { /* ignoruj */ }
  }, [cwds]);
  const reportCwd = useCallback((id: string, cwd: string) => {
    setCwds((c) => (c[id] === cwd ? c : { ...c, [id]: cwd }));
  }, []);

  // drzewo steruje ostatnio aktywnym panelem plików
  const [lastFiles, setLastFiles] = useState<PanelId | null>(null);
  useEffect(() => { if (activeKind === "files") setLastFiles(active); }, [active, activeKind]);
  const filesIds = layout.filter((r) => r.kind === "files").map((r) => r.id);
  const linkedFiles = lastFiles && filesIds.includes(lastFiles) ? lastFiles : filesIds[0] ?? null;

  // żądania z drzewa do panelu plików: wejdź do folderu / otwórz plik w edytorze
  const [goTo, setGoTo] = useState<Record<string, { path: string; n: number; file?: boolean }>>({});
  const request = useCallback((path: string, file: boolean) => {
    if (!linkedFiles) return;
    setGoTo((g) => ({ ...g, [linkedFiles]: { path, file, n: (g[linkedFiles]?.n ?? 0) + 1 } }));
  }, [linkedFiles]);
  const openInFiles = useCallback((path: string) => request(path, false), [request]);
  const openFileInFiles = useCallback((path: string) => request(path, true), [request]);

  // pliki otwarte w edytorach (id panelu plików → plik)
  const [openFiles, setOpenFiles] = useState<Record<string, OpenFile | null>>({});
  const reportOpenFile = useCallback((id: string, f: OpenFile | null) => {
    setOpenFiles((o) => ({ ...o, [id]: f }));
  }, []);
  const openPaths = filesIds.map((id) => openFiles[id]?.path).filter((p): p is string => !!p);

  // historia fokusu: [aktywny, poprzedni, ...], do rozstrzygania remisów
  const recent = useRef<PanelId[]>([active]);
  useEffect(() => {
    recent.current = [active, ...recent.current.filter((p) => p !== active)];
  }, [active]);

  // skróty globalne: zawsze aktywne
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && e.code === "KeyQ") {
        e.preventDefault();
        getCurrentWindow().close();
        return;
      }
      // e.code = fizyczny klawisz: działa z CapsLockiem i Shiftem.
      // !ctrlKey: AltGr (Ctrl+Alt) zostaje do pisania polskich znaków.
      // Delete zamyka aktywny panel (też terminal, razem z jego shellem).
      // Wyjątek: otwarty edytor pliku, tam Delete kasuje znak.
      const typing = activeKind === "files" && !!openFiles[active];
      if (e.key === "Delete" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && !typing) {
        e.preventDefault();
        e.stopPropagation();
        setLayout((l) => l.filter((r) => r.id !== active));
        return;
      }

      const dir = DIR_BY_CODE[e.code];
      if (e.altKey && !e.ctrlKey && dir) {
        e.preventDefault();
        e.stopPropagation();
        const next = findNeighbor(active, dir, recent.current);
        if (next) setActive(next);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, activeKind, openFiles]);

  const render = (r: Rect): { title: string; body: ReactNode } => {
    const isActive = active === r.id;
    switch (r.kind) {
      case "files":
        return {
          title: openFiles[r.id]
            ? `${openFiles[r.id]!.path}${openFiles[r.id]!.dirty ? " ●" : ""}`
            : cwds[r.id] ?? instanceTitle(r),
          body: (
            <FilesPanel
              active={isActive}
              // nowy panel startuje w folderze ostatnio używanego panelu plików
              initialPath={cwds[r.id] ?? (linkedFiles ? cwds[linkedFiles] : null) ?? null}
              goTo={goTo[r.id] ?? null}
              onCwd={(cwd) => reportCwd(r.id, cwd)}
              onOpenFile={(f) => reportOpenFile(r.id, f)}
            />
          ),
        };
      case "tree":
        return {
          title: instanceTitle(r),
          body: (
            <TreePanel
              active={isActive}
              linkedCwd={linkedFiles ? cwds[linkedFiles] ?? null : null}
              onOpen={linkedFiles ? openInFiles : null}
              onOpenFile={linkedFiles ? openFileInFiles : null}
              openPaths={openPaths}
            />
          ),
        };
      case "terminal":
        return { title: instanceTitle(r), body: <TerminalPanel sessionId={r.id} active={isActive} /> };
      case "side":
        return { title: instanceTitle(r), body: <ProcessesPanel active={isActive} /> };
      case "docker":
        return { title: instanceTitle(r), body: <DockerPanel active={isActive} /> };
      case "monitor":
        return { title: instanceTitle(r), body: <MonitorPanel id={r.id} active={isActive} /> };
    }
  };

  return (
    <div className="shell">
      <Workspace layout={layout} onLayout={setLayout} active={active} onActivate={setActive} render={render} />

      <footer className="status">
        <span className="mode">{activeKind === "files" && openFiles[active] ? MODE.editor : MODE[activeKind]}</span>
        <span>{linkedFiles && cwds[linkedFiles] ? cwds[linkedFiles] : "WikExp"}</span>
        <span className="spacer" />
        <span>{activeKind === "files" && openFiles[active] ? "ctrl+s zapisz · ctrl+w zamknij · " : activeKind === "files" ? "enter otwórz · " : activeKind === "side" ? "s sort · xx kill · " : activeKind === "docker" ? "s start/stop · r restart · xx rm · " : ""}{activeKind === "files" && openFiles[active] ? "" : "del zamknij panel · "}przeciągnij tytuł · shift+krawędź = przerwa · ctrl+q quit · alt+hjkl panel</span>
      </footer>
    </div>
  );
}
