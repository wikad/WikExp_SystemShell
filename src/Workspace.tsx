import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu } from "@tauri-apps/api/menu";
import {
  ALL_KINDS, COLS, PANEL_NAMES, ROWS,
  largestFreeRect, moveTo, newId, removePanel, resizeEdge,
  type Edge, type PanelId, type PanelKind, type Rect,
} from "./layout";
import { useSettings } from "./settings";

type Drag =
  | { kind: "move"; id: PanelId; offX: number; offY: number; preview: Rect; ok: boolean; moved: boolean }
  | { kind: "resize"; id: PanelId; edge: Edge; result: Rect[] | null; linked: boolean };

/** Pozycja menu panelu (prawy klik): tekst + akcja albo separator. */
export type MenuEntry = { text: string; action: () => void } | "separator";

export type PanelView = {
  title: string;
  body: ReactNode;
  menu?: MenuEntry[];   // dodatkowe pozycje menu pod prawym klikiem (nad „zamknij panel”)
  compact?: boolean;    // zamiast nagłówka cienki uchwyt, treść do samej krawędzi (np. okno programu)
};

const gridPos = (r: Omit<Rect, "id" | "kind">) => ({
  gridColumn: `${r.x + 1} / span ${r.w}`,
  gridRow: `${r.y + 1} / span ${r.h}`,
});

/**
 * Natywne menu Windows (Tauri). W przeciwieństwie do menu z HTML zawsze jest na wierzchu,
 * więc nie chowa się za oknami programów włożonymi w panele.
 */
async function popup(entries: MenuEntry[]) {
  const menu = await Menu.new({
    items: entries.map((e, i) => (e === "separator" ? { item: "Separator" as const } : { id: `m${i}`, text: e.text, action: e.action })),
  });
  await menu.popup();
}

export function Workspace({ layout, onLayout, active, onActivate, render, zoomed }: {
  zoomed?: PanelId | null;   // panel rozciągnięty na całą przestrzeń
  layout: Rect[];
  onLayout: (l: Rect[]) => void;
  active: PanelId;
  onActivate: (id: PanelId) => void;
  render: (r: Rect) => PanelView;
}) {
  const wsRef = useRef<HTMLDivElement>(null);
  const GAP = useSettings().settings.gap; // ten sam odstęp co --gap w CSS
  const [drag, setDrag] = useState<Drag | null>(null);
  // ref z aktualnymi wartościami dla handlerów window (bez starych closure)
  const live = useRef({ drag, layout });
  live.current = { drag, layout };

  // piksele → komórka (cx, cy) i najbliższa linia siatki (lx, ly)
  const toGrid = (clientX: number, clientY: number) => {
    const r = wsRef.current!.getBoundingClientRect();
    const cw = (r.width + GAP) / COLS;
    const ch = (r.height + GAP) / ROWS;
    return {
      cx: Math.floor((clientX - r.left) / cw),
      cy: Math.floor((clientY - r.top) / ch),
      lx: Math.round((clientX - r.left + GAP / 2) / cw),
      ly: Math.round((clientY - r.top + GAP / 2) / ch),
    };
  };

  // ruch myszy i puszczenie przycisku nasłuchujemy na window, bo kursor wyjeżdża poza panel
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const { drag: d, layout: l } = live.current;
      if (!d) return;
      const g = toGrid(e.clientX, e.clientY);
      if (d.kind === "move") {
        const self = l.find((r) => r.id === d.id)!;
        const x = Math.min(Math.max(g.cx - d.offX, 0), COLS - self.w);
        const y = Math.min(Math.max(g.cy - d.offY, 0), ROWS - self.h);
        if (x === d.preview.x && y === d.preview.y) return;
        setDrag({ ...d, preview: { ...self, x, y }, ok: moveTo(l, d.id, x, y) !== null, moved: true });
      } else {
        const line = d.edge === "left" || d.edge === "right" ? g.lx : g.ly;
        // Shift w trakcie przeciągania = tylko ten panel (zostawia pustą przerwę)
        const linked = !e.shiftKey;
        setDrag({ ...d, linked, result: resizeEdge(l, d.id, d.edge, line, linked) });
      }
    };
    const onUp = () => {
      const { drag: d, layout: l } = live.current;
      if (d?.kind === "move" && d.moved && d.ok) {
        const next = moveTo(l, d.id, d.preview.x, d.preview.y);
        if (next) onLayout(next);
      } else if (d?.kind === "resize" && d.result) {
        onLayout(d.result);
      }
      setDrag(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const startMove = (e: React.MouseEvent, r: Rect) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const g = toGrid(e.clientX, e.clientY);
    setDrag({ kind: "move", id: r.id, offX: g.cx - r.x, offY: g.cy - r.y, preview: r, ok: true, moved: false });
  };

  const startResize = (e: React.MouseEvent, id: PanelId, edge: Edge) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onActivate(id);
    setDrag({ kind: "resize", id, edge, result: null, linked: !e.shiftKey });
  };

  // dodanie nowej instancji panelu w wolne miejsce
  const place = (kind: PanelKind, rect: Omit<Rect, "id" | "kind">) => {
    const id = newId(live.current.layout, kind);
    onLayout([...live.current.layout, { id, kind, ...rect }]);
    onActivate(id);
  };

  // prawy klik na pustym miejscu → menu „nowy panel”
  const onContextMenu = (e: React.MouseEvent) => {
    if (e.target !== wsRef.current) return;
    e.preventDefault();
    const g = toGrid(e.clientX, e.clientY);
    const rect = largestFreeRect(layout, g.cx, g.cy);
    if (!rect) return;
    popup(ALL_KINDS.map((kind) => ({ text: `Nowy panel: ${PANEL_NAMES[kind]}`, action: () => place(kind, rect) })));
  };

  // prawy klik na nagłówku / uchwycie panelu → opcje panelu
  const onPanelMenu = (e: React.MouseEvent, r: Rect) => {
    e.preventDefault();
    e.stopPropagation();
    onActivate(r.id);
    const extra = render(r).menu ?? [];
    popup([
      ...extra,
      ...(extra.length ? ["separator" as const] : []),
      { text: "Zamknij panel", action: () => onLayout(removePanel(live.current.layout, r.id)) },
    ]);
  };

  // podczas zmiany rozmiaru pokazujemy układ na żywo (terminal od razu się dopasowuje)
  const shown = drag?.kind === "resize" && drag.result ? drag.result : layout;
  const resizeCursor = drag?.kind === "resize"
    ? (drag.edge === "left" || drag.edge === "right" ? "ew-resize" : "ns-resize") : undefined;

  return (
    <div
      ref={wsRef}
      className={`workspace ${drag ? "dragging" : ""}`}
      style={resizeCursor ? { cursor: resizeCursor } : undefined}
      onContextMenu={onContextMenu}
    >
      {shown.map((r) => {
        const view = render(r);
        return (
          <section
            key={r.id}
            data-panel={r.id}
            className={`panel ${view.compact ? "compact" : ""} ${active === r.id ? "active" : ""} ${drag?.kind === "move" && drag.id === r.id && drag.moved ? "lifted" : ""}`}
            style={zoomed === r.id ? { gridColumn: "1 / -1", gridRow: "1 / -1", zIndex: 20 } : gridPos(r)}
            onMouseDown={() => onActivate(r.id)}
          >
            <header
              className={view.compact ? "panel-grip" : "panel-title"}
              title={view.compact ? `${view.title}\nprzeciągnij, aby przesunąć · prawy klik = opcje` : undefined}
              onMouseDown={(e) => startMove(e, r)}
              onContextMenu={(e) => onPanelMenu(e, r)}
            >
              {view.compact ? <span className="grip-dots" /> : <span className="panel-title-text">{view.title}</span>}
            </header>
            <div className="panel-body">{view.body}</div>
            {(["left", "right", "top", "bottom"] as Edge[]).map((edge) => (
              <div key={edge} className={`edge edge-${edge}`} onMouseDown={(e) => startResize(e, r.id, edge)} />
            ))}
          </section>
        );
      })}

      {drag?.kind === "move" && drag.moved && (
        <div className={`ghost ${drag.ok ? "ok" : "bad"}`} style={gridPos(drag.preview)} />
      )}
    </div>
  );
}
