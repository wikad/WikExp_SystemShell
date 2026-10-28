import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ALL_KINDS, COLS, PANEL_NAMES, ROWS,
  largestFreeRect, moveTo, newId, resizeEdge,
  type Edge, type PanelId, type PanelKind, type Rect,
} from "./layout";

const GAP = 8; // musi się zgadzać z `gap` w .workspace w App.css

type Drag =
  | { kind: "move"; id: PanelId; offX: number; offY: number; preview: Rect; ok: boolean; moved: boolean }
  | { kind: "resize"; id: PanelId; edge: Edge; result: Rect[] | null; linked: boolean };

type Menu =
  | { kind: "add"; px: number; py: number; rect: Omit<Rect, "id" | "kind"> }
  | { kind: "panel"; px: number; py: number; id: PanelId };

const gridPos = (r: Omit<Rect, "id" | "kind">) => ({
  gridColumn: `${r.x + 1} / span ${r.w}`,
  gridRow: `${r.y + 1} / span ${r.h}`,
});

export function Workspace({ layout, onLayout, active, onActivate, render }: {
  layout: Rect[];
  onLayout: (l: Rect[]) => void;
  active: PanelId;
  onActivate: (id: PanelId) => void;
  render: (r: Rect) => { title: string; body: ReactNode };
}) {
  const wsRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // menu przy krawędzi okna → przesuń je, żeby całe było widoczne
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(menu.px, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(menu.py, window.innerHeight - r.height - 4))}px`;
  }, [menu]);
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

  // menu znika po kliknięciu gdziekolwiek albo po Esc
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

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

  // prawy klik na pustym miejscu → menu z zamkniętymi panelami
  const onContextMenu = (e: React.MouseEvent) => {
    if (e.target !== wsRef.current) return;
    e.preventDefault();
    const g = toGrid(e.clientX, e.clientY);
    const rect = largestFreeRect(layout, g.cx, g.cy);
    if (rect) setMenu({ kind: "add", px: e.clientX, py: e.clientY, rect });
  };

  // podczas zmiany rozmiaru pokazujemy układ na żywo (terminal od razu się dopasowuje)
  const shown = drag?.kind === "resize" && drag.result ? drag.result : layout;
  // dodanie nowej instancji panelu w wolne miejsce
  const place = (kind: PanelKind, rect: Omit<Rect, "id" | "kind">) => {
    const id = newId(layout, kind);
    onLayout([...layout, { id, kind, ...rect }]);
    onActivate(id);
  };
  const label = (kind: PanelKind) => PANEL_NAMES[kind];
  const resizeCursor = drag?.kind === "resize"
    ? (drag.edge === "left" || drag.edge === "right" ? "ew-resize" : "ns-resize") : undefined;

  return (
    <div
      ref={wsRef}
      className={`workspace ${drag ? "dragging" : ""}`}
      style={resizeCursor ? { cursor: resizeCursor } : undefined}
      onContextMenu={onContextMenu}
    >
      {shown.map((r) => (
        <section
          key={r.id}
          data-panel={r.id}
          className={`panel ${active === r.id ? "active" : ""} ${drag?.kind === "move" && drag.id === r.id && drag.moved ? "lifted" : ""}`}
          style={gridPos(r)}
          onMouseDown={() => onActivate(r.id)}
        >
          <header
            className="panel-title"
            onMouseDown={(e) => startMove(e, r)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ kind: "panel", px: e.clientX, py: e.clientY, id: r.id });
            }}
          >
            {render(r).title}
          </header>
          <div className="panel-body">{render(r).body}</div>
          {(["left", "right", "top", "bottom"] as Edge[]).map((edge) => (
            <div key={edge} className={`edge edge-${edge}`} onMouseDown={(e) => startResize(e, r.id, edge)} />
          ))}
        </section>
      ))}

      {drag?.kind === "move" && drag.moved && (
        <div className={`ghost ${drag.ok ? "ok" : "bad"}`} style={gridPos(drag.preview)} />
      )}

      {menu && (
        <div
          ref={menuRef}
          className="ctx-menu"
          style={{ left: menu.px, top: menu.py }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menu.kind === "add" ? (
            <>
              <div className="ctx-head">nowy panel tutaj</div>
              {ALL_KINDS.map((kind) => (
                <div key={kind} className="ctx-item" onClick={() => { place(kind, menu.rect); setMenu(null); }}>
                  {label(kind)}
                </div>
              ))}
            </>
          ) : (
            <>
              <div className="ctx-head">{layout.find((r) => r.id === menu.id) ? render(layout.find((r) => r.id === menu.id)!).title : ""}</div>
              <div className="ctx-item red" onClick={() => {
                onLayout(layout.filter((r) => r.id !== menu.id));
                setMenu(null);
              }}>
                zamknij panel
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
