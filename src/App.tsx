import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyShellLayout, focusMain, setDesktopLayer, windowAction, type WinInfo } from "./api";
import { useSettings } from "./settings";
import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { TerminalPanel } from "./TerminalPanel";
import { ClaudePanel } from "./ClaudePanel";
import { WslPanel } from "./WslPanel";
import { KanbanPanel } from "./KanbanPanel";
import { CalendarPanel } from "./CalendarPanel";
import { TreePanel } from "./TreePanel";
import { FilesPanel, type OpenFile } from "./FilesPanel";
import { ProcessesPanel } from "./ProcessesPanel";
import { DockerPanel } from "./DockerPanel";
import { MonitorPanel } from "./MonitorPanel";
import { SettingsPanel } from "./SettingsPanel";
import { AppPanel, type Docked } from "./AppPanel";
import { GitPanel } from "./GitPanel";
import { SearchPanel } from "./SearchPanel";
import { listen } from "@tauri-apps/api/event";
import { Workspace, type PanelView } from "./Workspace";
import { loadLayout, saveLayout, growTo, largestFreeAnywhere, newId, removePanel, splitPanel, DEFAULT_LAYOUT, PANEL_NAMES, type PanelId, type PanelKind, type Rect } from "./layout";

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
    tree: "NORMAL", files: "NORMAL", terminal: "TERMINAL", side: "PROCESY", docker: "DOCKER", monitor: "MONITOR", settings: "USTAWIENIA", app: "PROGRAM", git: "GIT", search: "SZUKAJ", claude: "CLAUDE", wsl: "WSL", wslmgr: "WSL", kanban: "PLAN", calendar: "KALENDARZ",
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

  // pełny ekran: z ukrytym paskiem Windows całe miejsce poza paskiem bocznym, bez = obszar roboczy
  const { hideTaskbar, desktopLayer } = useSettings().settings;
  useEffect(() => { applyShellLayout(hideTaskbar).catch(() => {}); }, [hideTaskbar]);
  useEffect(() => { setDesktopLayer(desktopLayer).catch(() => {}); }, [desktopLayer]);
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

  // źródło paneli docker i procesy (id → "win" | "wsl" | "wsl:Nazwa"), pamiętane między restartami
  const [sources, setSources] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("wikexp.sources.v1") ?? "{}"); } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem("wikexp.sources.v1", JSON.stringify(sources)); } catch { /* ignoruj */ }
  }, [sources]);
  useEffect(() => {
    setSources((s) => {
      const keep = Object.fromEntries(Object.entries(s).filter(([id]) => layout.some((r) => r.id === id)));
      return Object.keys(keep).length === Object.keys(s).length ? s : keep;
    });
  }, [layout]);
  const setSourceOf = useCallback((id: string, src: string) => setSources((s) => ({ ...s, [id]: src })), []);
  const toneOf = (r: Rect): "wsl" | undefined => (sources[r.id] && sources[r.id] !== "win" ? "wsl" : undefined);
  const srcTitle = (r: Rect) => (sources[r.id] && sources[r.id] !== "win" ? `${instanceTitle(r)} · ${sources[r.id].replace(/^wsl:?/, "") || "WSL"}` : instanceTitle(r));

  // panele claude: wybrany folder każdego (id → ścieżka) i lista ostatnich folderów
  const [claudeDirs, setClaudeDirs] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("wikexp.claude.dirs.v1") ?? "{}"); } catch { return {}; }
  });
  const [claudeRecent, setClaudeRecent] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("wikexp.claude.recent.v1") ?? "[]"); } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem("wikexp.claude.dirs.v1", JSON.stringify(claudeDirs)); } catch { /* ignoruj */ }
  }, [claudeDirs]);
  useEffect(() => {
    try { localStorage.setItem("wikexp.claude.recent.v1", JSON.stringify(claudeRecent)); } catch { /* ignoruj */ }
  }, [claudeRecent]);
  // zamknięty panel zapomina folder: nowy panel claude zawsze pyta
  useEffect(() => {
    setClaudeDirs((d) => {
      const keep = Object.fromEntries(Object.entries(d).filter(([id]) => layout.some((r) => r.id === id)));
      return Object.keys(keep).length === Object.keys(d).length ? d : keep;
    });
  }, [layout]);
  const pickClaude = useCallback((id: string, dir: string) => {
    setClaudeDirs((d) => ({ ...d, [id]: dir }));
    setClaudeRecent((r) => [dir, ...r.filter((p) => p !== dir)].slice(0, 10));
  }, []);
  const resetClaude = useCallback((id: string) => {
    setClaudeDirs((d) => { const { [id]: _, ...rest } = d; return rest; });
  }, []);
  const forgetClaude = useCallback((dir: string) => {
    setClaudeRecent((r) => r.filter((p) => p !== dir));
  }, []);

  // drzewo steruje ostatnio aktywnym panelem plików
  const [lastFiles, setLastFiles] = useState<PanelId | null>(null);
  useEffect(() => { if (activeKind === "files") setLastFiles(active); }, [active, activeKind]);
  const filesIds = layout.filter((r) => r.kind === "files").map((r) => r.id);
  const linkedFiles = lastFiles && filesIds.includes(lastFiles) ? lastFiles : filesIds[0] ?? null;

  // żądania z drzewa do panelu plików: wejdź do folderu / otwórz plik w edytorze
  type GoTo = { path: string; n: number; file?: boolean; line?: number; col?: number; len?: number };
  const [goTo, setGoTo] = useState<Record<string, GoTo>>({});
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

  // okna programów włożone w panele (id panelu → okno)
  const [docked, setDocked] = useState<Record<string, Docked | null>>({});
  const [zoomed, setZoomed] = useState<PanelId | null>(null);       // panel powiększony na całą przestrzeń
  const [tooSmall, setTooSmall] = useState<Record<string, boolean>>({}); // program nie mieści się nawet po powiększeniu
  const [presets, setPresets] = useState<Record<string, WinInfo>>({});  // okna wskazane z paska do włożenia w nowy panel

  // zamknięty panel z programem: zapomnij, jaki program w nim był (żeby nowy panel go nie przejął)
  useEffect(() => {
    try {
      const m = JSON.parse(localStorage.getItem("wikexp.apps.v1") ?? "{}");
      const kept = Object.fromEntries(Object.entries(m).filter(([id]) => layout.some((r) => r.id === id)));
      if (Object.keys(kept).length !== Object.keys(m).length) localStorage.setItem("wikexp.apps.v1", JSON.stringify(kept));
    } catch { /* ignoruj */ }
  }, [layout]);

  // „włóż w panel WikExp” z menu paska: nowy panel w największym wolnym miejscu,
  // a gdy brak miejsca, aktywny panel dzieli się na pół
  const activeRef = useRef(active);
  activeRef.current = active;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const dockFromBar = useCallback((w: WinInfo) => {
    const l = layoutRef.current;
    const id = newId(l, "app");
    let base = l;
    let rect = largestFreeAnywhere(l);
    let from: PanelId | undefined;
    if (!rect) {
      const target = l.find((r) => r.id === activeRef.current) ?? [...l].sort((a, b) => b.w * b.h - a.w * a.h)[0];
      const split = target && splitPanel(l, target.id);
      if (!split) return;
      base = split.layout;
      rect = split.rect;
      from = target.id;
    }
    setPresets((p) => ({ ...p, [id]: w }));
    setLayout([...base, { id, kind: "app", ...rect, from }]);
    setActive(id);
  }, []);

  // nowy panel danego rodzaju: w największym wolnym miejscu, a gdy go brak, aktywny panel dzieli się na pół
  const addPanel = useCallback((kind: PanelKind): PanelId | null => {
    const l = layoutRef.current;
    const id = newId(l, kind);
    let base = l;
    let rect = largestFreeAnywhere(l);
    let from: PanelId | undefined;
    if (!rect) {
      const target = l.find((r) => r.id === activeRef.current) ?? [...l].sort((a, b) => b.w * b.h - a.w * a.h)[0];
      const split = target && splitPanel(l, target.id);
      if (!split) return null;
      base = split.layout;
      rect = split.rect;
      from = target.id; // przy zamknięciu ten panel odzyska miejsce
    }
    const next = [...base, { id, kind, ...rect, from }];
    layoutRef.current = next; // dwa wywołania pod rząd widzą już nowy panel
    setLayout(next);
    return id;
  }, []);

  // wynik wyszukiwania → plik w panelu plików na tej linii (gdy nie ma panelu plików, powstaje nowy)
  const [searchFocus, setSearchFocus] = useState<{ n: number; text?: string } | null>(null);
  const openAt = useCallback((path: string, line: number, col: number, len: number) => {
    let id: PanelId | null = linkedFiles;
    if (!id) {
      id = addPanel("files");
      if (!id) return;
      const newFiles = id;
      setCwds((c) => ({ ...c, [newFiles]: path.slice(0, path.lastIndexOf("\\")) }));
    }
    const target = id;
    setGoTo((g) => ({ ...g, [target]: { path, file: true, line, col, len, n: (g[target]?.n ?? 0) + 1 } }));
    setActive(target);
  }, [linkedFiles, addPanel]);

  useEffect(() => {
    const un = listen<WinInfo>("dock-request", (e) => dockFromBar(e.payload));
    return () => { un.then((f) => f()); };
  }, [dockFromBar]);
  useEffect(() => { if (zoomed && !layout.some((r) => r.id === zoomed)) setZoomed(null); }, [layout, zoomed]);
  // przejście na inny panel (Alt+hjkl, klik) zwija powiększony panel z powrotem do siatki
  useEffect(() => { setZoomed((z) => (z && z !== active ? null : z)); }, [active]);

  // program w panelu ma minimalny rozmiar większy niż panel → powiększ panel w siatce
  const fitPanel = useCallback((id: string, needW: number, needH: number, curW: number, curH: number) => {
    setLayout((l) => {
      const r = l.find((x) => x.id === id);
      if (!r) return l;
      // liczymy tylko wymiar, w którym program się nie zmieścił (drugi zostaje swobodny)
      const cellsW = needW > curW + 4 ? Math.ceil(r.w * needW / Math.max(curW, 1) - 0.05) : 0;
      const cellsH = needH > curH + 4 ? Math.ceil(r.h * needH / Math.max(curH, 1) - 0.05) : 0;
      // growTo powiększa tylko tam, gdzie trzeba; minimum = tyle, ile program naprawdę potrzebuje
      // inne panele z programami są chronione: dwa programy nie przeciągają się o miejsce
      const res = growTo(l, id, cellsW, cellsH, (x) => x.kind === "app" && x.id !== id);
      setTooSmall((t) => ({ ...t, [id]: !res.ok }));
      return res.layout;
    });
  }, []);
  const reportDocked = useCallback((id: string, d: Docked | null) => setDocked((m) => ({ ...m, [id]: d })), []);

  // fokus podąża za aktywnym panelem: panel z programem → fokus do programu,
  // każdy inny → z powrotem do WikExp (jeśli fokus był w programie)
  useEffect(() => {
    const d = docked[active];
    if (d) windowAction(d.hwnd, "focus").catch(() => {});
    else if (!document.hasFocus()) focusMain().catch(() => {});
  }, [active, docked[active]?.hwnd]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // Ctrl+Shift+F: przełącznik panelu „szukaj”. Nie ma go → otwiera nowy
      // (zaznaczony tekst, np. w edytorze, od razu trafia do pola); jest → zamyka go
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyF") {
        e.preventDefault();
        e.stopPropagation();
        const l = layoutRef.current;
        const open = l.filter((r) => r.kind === "search").map((r) => r.id);
        if (open.length) {
          setLayout(open.reduce(removePanel, l)); // panel, z którego wziął miejsce, wraca do dawnego rozmiaru; fokus wraca sam
          return;
        }
        const picked = window.getSelection()?.toString().trim() ?? "";
        const text = picked && !picked.includes("\n") && picked.length <= 200 ? picked : undefined;
        const id = addPanel("search");
        if (id) {
          setActive(id);
          setSearchFocus((f) => ({ n: (f?.n ?? 0) + 1, text }));
        }
        return;
      }

      // e.code = fizyczny klawisz: działa z CapsLockiem i Shiftem.
      // !ctrlKey: AltGr (Ctrl+Alt) zostaje do pisania polskich znaków.
      // Delete zamyka aktywny panel (też terminal, razem z jego shellem).
      // Wyjątek: otwarty edytor pliku, tam Delete kasuje znak.
      // To samo w polach tekstowych (szukaj, wiadomość commita); terminal (xterm) się nie liczy.
      const el = e.target as HTMLElement | null;
      const inField = !!el && (el.tagName === "INPUT" || (el.tagName === "TEXTAREA" && !el.classList.contains("xterm-helper-textarea")));
      const typing = inField || (activeKind === "files" && !!openFiles[active]);
      if (e.key === "Delete" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && !typing) {
        e.preventDefault();
        e.stopPropagation();
        setLayout((l) => removePanel(l, active));
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
  }, [active, activeKind, openFiles, addPanel]);

  // globalne Alt+H/J/K/L z Rusta: działają też, gdy fokus jest w zadokowanym programie
  useEffect(() => {
    const un = listen<string>("global-nav", (e) => {
      const next = findNeighbor(activeRef.current, e.payload as Dir, recent.current);
      if (next) setActive(next);
    });
    return () => { un.then((f) => f()); };
  }, []);

  const render = (r: Rect): PanelView => {
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
      case "git":
        return {
          title: instanceTitle(r),
          body: <GitPanel cwd={linkedFiles ? cwds[linkedFiles] ?? null : null} active={isActive} />,
        };
      case "search":
        return {
          title: instanceTitle(r),
          body: (
            <SearchPanel
              cwd={linkedFiles ? cwds[linkedFiles] ?? null : null}
              active={isActive}
              focus={searchFocus}
              onOpen={openAt}
            />
          ),
        };
      case "wsl":
        // wsl.exe startuje w folderze z panelu plików (WSL sam zamienia C:\x na /mnt/c/x)
        return {
          title: instanceTitle(r),
          body: <TerminalPanel sessionId={r.id} active={isActive} shell="wsl.exe" cwd={linkedFiles ? cwds[linkedFiles] ?? null : null} />,
        };
      case "claude":
        return {
          title: claudeDirs[r.id] ? `${instanceTitle(r)} · ${claudeDirs[r.id]}` : instanceTitle(r),
          body: (
            <ClaudePanel
              sessionId={r.id}
              active={isActive}
              dir={claudeDirs[r.id] ?? null}
              linkedDir={linkedFiles ? cwds[linkedFiles] ?? null : null}
              recent={claudeRecent}
              onPick={(d) => pickClaude(r.id, d)}
              onForget={forgetClaude}
              onReset={() => resetClaude(r.id)}
            />
          ),
        };
      case "terminal":
        return { title: instanceTitle(r), body: <TerminalPanel sessionId={r.id} active={isActive} /> };
      case "side":
        return { title: srcTitle(r), tone: toneOf(r), body: <ProcessesPanel active={isActive} source={sources[r.id] ?? "win"} onSource={(s) => setSourceOf(r.id, s)} /> };
      case "docker":
        return { title: srcTitle(r), tone: toneOf(r), body: <DockerPanel active={isActive} source={sources[r.id] ?? "win"} onSource={(s) => setSourceOf(r.id, s)} /> };
      case "kanban":
        return { title: instanceTitle(r), body: <KanbanPanel id={r.id} active={isActive} /> };
      case "calendar":
        return { title: instanceTitle(r), body: <CalendarPanel id={r.id} active={isActive} /> };
      case "wslmgr":
        return { title: instanceTitle(r), body: <WslPanel active={isActive} /> };
      case "app":
        return {
          title: (tooSmall[r.id] ? "⚠ za mało miejsca · " : "") + (docked[r.id] ? docked[r.id]!.title : instanceTitle(r)),
          compact: true, // bez nagłówka: cienki uchwyt, program do samej krawędzi panelu
          // opcje pod prawym klikiem na uchwycie (natywne menu, zawsze nad programem)
          menu: docked[r.id] ? [
            { text: "Minimalizuj program", action: () => { windowAction(docked[r.id]!.hwnd, "minimize"); } },
            { text: zoomed === r.id ? "Przywróć do siatki" : "Powiększ na całą przestrzeń", action: () => setZoomed((z) => (z === r.id ? null : r.id)) },
            { text: "Wyjmij okno z panelu", action: () => setLayout((l) => removePanel(l, r.id)) },
            "separator",
            { text: "Zamknij program", action: () => {
              const hwnd = docked[r.id]!.hwnd;
              setLayout((l) => removePanel(l, r.id));   // panel znika, okno wraca do normalności…
              setTimeout(() => windowAction(hwnd, "close").catch(() => {}), 150); // …i dostaje polecenie zamknięcia
            } },
          ] : undefined,
          body: (
            <AppPanel
              id={r.id}
              active={isActive}
              preset={presets[r.id] ?? null}
              onDocked={(d) => reportDocked(r.id, d)}
              onClose={() => setLayout((l) => removePanel(l, r.id))}
              onNeedSize={(nw, nh, cw, ch) => fitPanel(r.id, nw, nh, cw, ch)}
            />
          ),
        };
      case "settings":
        return { title: instanceTitle(r), body: <SettingsPanel active={isActive} onResetLayout={() => setLayout(DEFAULT_LAYOUT)} /> };
      case "monitor":
        return { title: instanceTitle(r), body: <MonitorPanel id={r.id} active={isActive} /> };
    }
  };

  return (
    <div className="shell">
      <Workspace layout={layout} onLayout={setLayout} active={active} onActivate={setActive} render={render} zoomed={zoomed} onPreset={setSourceOf} />

      <footer className="status">
        <span className="mode">{activeKind === "files" && openFiles[active] ? MODE.editor : MODE[activeKind]}</span>
        <span>{linkedFiles && cwds[linkedFiles] ? cwds[linkedFiles] : "WikExp"}</span>
        <span className="spacer" />
        <span>{activeKind === "files" && openFiles[active] ? "ctrl+f szukaj · ctrl+s zapisz · ctrl+w zamknij · " : activeKind === "files" ? "enter otwórz · " : activeKind === "search" ? "↑↓ wybierz · enter otwórz · " : activeKind === "side" ? "s sort · xx kill · " : activeKind === "docker" ? "s start/stop · r restart · xx rm · " : ""}{activeKind === "files" && openFiles[active] ? "" : "del zamknij panel · "}ctrl+shift+f szukaj w projekcie · przeciągnij tytuł · shift+krawędź = przerwa · ctrl+q quit · alt+hjkl panel</span>
      </footer>
    </div>
  );
}
