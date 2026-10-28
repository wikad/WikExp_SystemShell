// Logika układu paneli: siatka COLS×ROWS, każdy panel to prostokąt w komórkach.
// Czyste funkcje bez Reacta, żeby łatwo je testować.

export type PanelKind = "tree" | "files" | "terminal" | "side" | "docker" | "monitor" | "settings" | "app";
// id = konkretna instancja ("terminal", "terminal-2"), kind = rodzaj panelu
export type PanelId = string;
export type Rect = {
  id: PanelId; kind: PanelKind; x: number; y: number; w: number; h: number;
  minW?: number; minH?: number; // własny minimalny rozmiar (np. program w panelu, który nie da się zmniejszyć)
};


export type Edge = "left" | "right" | "top" | "bottom";

export const COLS = 24;
export const ROWS = 16;
export const MIN_W = 3;
export const MIN_H = 2;

export const PANEL_NAMES: Record<PanelKind, string> = {
  tree: "drzewo", files: "pliki", terminal: "terminal", side: "procesy", docker: "docker", monitor: "monitor", settings: "ustawienia", app: "okno programu",
};
export const ALL_KINDS = Object.keys(PANEL_NAMES) as PanelKind[];

export const DEFAULT_LAYOUT: Rect[] = [
  { id: "tree", kind: "tree", x: 0, y: 0, w: 5, h: 16 },
  { id: "files", kind: "files", x: 5, y: 0, w: 13, h: 11 },
  { id: "terminal", kind: "terminal", x: 5, y: 11, w: 13, h: 5 },
  { id: "side", kind: "side", x: 18, y: 0, w: 6, h: 11 },
  { id: "docker", kind: "docker", x: 18, y: 11, w: 6, h: 5 },
];

export const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const fits = (r: Rect) =>
  r.x >= 0 && r.y >= 0 && r.x + r.w <= COLS && r.y + r.h <= ROWS &&
  r.w >= Math.max(MIN_W, r.minW ?? 0) && r.h >= Math.max(MIN_H, r.minH ?? 0);

/** Wszystkie panele w granicach, nie za małe i bez kolizji. */
export function isValid(layout: Rect[]): boolean {
  if (!layout.every(fits)) return false;
  for (let i = 0; i < layout.length; i++)
    for (let j = i + 1; j < layout.length; j++)
      if (overlaps(layout[i], layout[j])) return false;
  return true;
}

/** Przesuń panel na (x, y). null = koliduje albo wychodzi poza ekran. */
export function moveTo(layout: Rect[], id: PanelId, x: number, y: number): Rect[] | null {
  const next = layout.map((r) => (r.id === id ? { ...r, x, y } : r));
  return isValid(next) ? next : null;
}

/** Nowe id instancji: pierwsza to sam rodzaj ("files"), kolejne "files-2", "files-3"... */
export function newId(layout: Rect[], kind: PanelKind): PanelId {
  if (!layout.some((r) => r.id === kind)) return kind;
  for (let n = 2; ; n++) if (!layout.some((r) => r.id === `${kind}-${n}`)) return `${kind}-${n}`;
}

/**
 * Przeciągnięcie krawędzi panelu na linię `line`.
 * linked = false (Shift): zmienia tylko ten panel, więc może zostać pusta przerwa.
 * Panele, które dzielą tę krawędź (stykają się z nią i nachodzą na siebie w osi
 * prostopadłej), przesuwają się razem: jedne rosną, drugie maleją.
 * Gdy po drugiej stronie jest pusto, panel po prostu rośnie w wolne miejsce.
 * Gdy ruch jest za duży, krawędź zatrzymuje się na najdalszej poprawnej pozycji.
 */
export function resizeEdge(layout: Rect[], id: PanelId, edge: Edge, line: number, linked = true): Rect[] | null {
  const horiz = edge === "left" || edge === "right";
  const pos = (r: Rect) => (horiz ? r.x : r.y);
  const size = (r: Rect) => (horiz ? r.w : r.h);
  const cpos = (r: Rect) => (horiz ? r.y : r.x);
  const csize = (r: Rect) => (horiz ? r.h : r.w);
  const cross = (a: Rect, b: Rect) => cpos(a) < cpos(b) + csize(b) && cpos(b) < cpos(a) + csize(a);

  const self = layout.find((r) => r.id === id);
  if (!self) return null;
  const isEnd = edge === "right" || edge === "bottom";
  const L = isEnd ? pos(self) + size(self) : pos(self);

  // panele kończące się na linii L (before) i zaczynające na niej (after),
  // połączone ze sobą przez nachodzenie w osi prostopadłej
  const before = new Set<PanelId>();
  const after = new Set<PanelId>();
  (isEnd ? before : after).add(id);
  const byId = (pid: PanelId) => layout.find((r) => r.id === pid)!;
  let changed = linked;
  while (changed) {
    changed = false;
    for (const r of layout) {
      if (!before.has(r.id) && pos(r) + size(r) === L && [...after].some((a) => cross(r, byId(a)))) {
        before.add(r.id); changed = true;
      }
      if (!after.has(r.id) && pos(r) === L && [...before].some((b) => cross(r, byId(b)))) {
        after.add(r.id); changed = true;
      }
    }
  }

  const apply = (d: number) =>
    layout.map((r) => {
      if (before.has(r.id)) return horiz ? { ...r, w: r.w + d } : { ...r, h: r.h + d };
      if (after.has(r.id)) return horiz ? { ...r, x: r.x + d, w: r.w - d } : { ...r, y: r.y + d, h: r.h - d };
      return r;
    });

  const d = line - L;
  for (let dd = d; dd !== 0; dd -= Math.sign(d)) {
    const next = apply(dd);
    if (isValid(next)) return next;
  }
  return null;
}

/**
 * Powiększa panel do co najmniej w×h komórek: najpierw w wolne miejsce (w prawo / w dół,
 * potem w lewo / w górę), a gdy to za mało, kosztem sąsiadów, nie mniejszych niż ich minimum. Ustawia minW/minH, żeby
 * nie dało się go potem zmniejszyć. Zwraca nowy układ i informację, czy się udało.
 */
export function growTo(
  layout: Rect[], id: PanelId, w: number, h: number,
  protect: (r: Rect) => boolean = () => false, // panele, których nie wolno zmniejszać (np. inne programy)
): { layout: Rect[]; ok: boolean } {
  let l = layout;
  const get = () => l.find((r) => r.id === id)!;
  // zmiana, która zmniejszyłaby chroniony panel, jest odrzucana
  const safe = (next: Rect[] | null) => {
    if (!next) return l;
    const shrinks = next.some((n) => {
      if (n.id === id || !protect(n)) return false;
      const o = l.find((x) => x.id === n.id);
      return !!o && (n.w < o.w || n.h < o.h);
    });
    return shrinks ? l : next;
  };
  if (!get()) return { layout, ok: false };
  if (get().w < w) l = resizeEdge(l, id, "right", get().x + w, false) ?? l;
  if (get().w < w) l = resizeEdge(l, id, "left", get().x + get().w - w, false) ?? l;
  if (get().h < h) l = resizeEdge(l, id, "bottom", get().y + h, false) ?? l;
  if (get().h < h) l = resizeEdge(l, id, "top", get().y + get().h - h, false) ?? l;
  // dalej za mało: zabierz miejsce sąsiadom (wspólna krawędź, sąsiedzi maleją do swojego minimum)
  if (get().w < w) l = safe(resizeEdge(l, id, "right", get().x + w, true));
  if (get().w < w) l = safe(resizeEdge(l, id, "left", get().x + get().w - w, true));
  if (get().h < h) l = safe(resizeEdge(l, id, "bottom", get().y + h, true));
  if (get().h < h) l = safe(resizeEdge(l, id, "top", get().y + get().h - h, true));
  const r = get();
  const ok = r.w >= w && r.h >= h;
  l = l.map((x) => (x.id === id ? { ...x, minW: Math.min(w, x.w), minH: Math.min(h, x.h) } : x));
  return { layout: l, ok };
}

/** Największy wolny prostokąt zawierający komórkę (cx, cy), albo null. */
export function largestFreeRect(layout: Rect[], cx: number, cy: number): Omit<Rect, "id" | "kind"> | null {
  // sumy prefiksowe zajętości → sprawdzenie prostokąta w O(1)
  const occ = Array.from({ length: ROWS + 1 }, () => new Array(COLS + 1).fill(0));
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++) {
      const taken = layout.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) ? 1 : 0;
      occ[y + 1][x + 1] = taken + occ[y][x + 1] + occ[y + 1][x] - occ[y][x];
    }
  const sum = (x0: number, y0: number, x1: number, y1: number) =>
    occ[y1][x1] - occ[y0][x1] - occ[y1][x0] + occ[y0][x0];
  if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS || sum(cx, cy, cx + 1, cy + 1)) return null;

  let best: Omit<Rect, "id" | "kind"> | null = null;
  for (let x0 = 0; x0 <= cx; x0++)
    for (let x1 = cx + 1; x1 <= COLS; x1++)
      for (let y0 = 0; y0 <= cy; y0++)
        for (let y1 = cy + 1; y1 <= ROWS; y1++) {
          const area = (x1 - x0) * (y1 - y0);
          if ((!best || area > best.w * best.h) && sum(x0, y0, x1, y1) === 0)
            best = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        }
  return best && best.w >= MIN_W && best.h >= MIN_H ? best : null;
}

/** Największy wolny prostokąt w całej siatce (null = brak miejsca na panel). */
export function largestFreeAnywhere(layout: Rect[]): Omit<Rect, "id" | "kind"> | null {
  const occ = Array.from({ length: ROWS + 1 }, () => new Array(COLS + 1).fill(0));
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++) {
      const taken = layout.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) ? 1 : 0;
      occ[y + 1][x + 1] = taken + occ[y][x + 1] + occ[y + 1][x] - occ[y][x];
    }
  const sum = (x0: number, y0: number, x1: number, y1: number) => occ[y1][x1] - occ[y0][x1] - occ[y1][x0] + occ[y0][x0];
  let best: Omit<Rect, "id" | "kind"> | null = null;
  for (let x0 = 0; x0 < COLS; x0++)
    for (let y0 = 0; y0 < ROWS; y0++)
      for (let x1 = x0 + MIN_W; x1 <= COLS; x1++)
        for (let y1 = y0 + MIN_H; y1 <= ROWS; y1++) {
          if (sum(x0, y0, x1, y1)) break; // dalej w dół też będzie zajęte
          const area = (x1 - x0) * (y1 - y0);
          if (!best || area > best.w * best.h) best = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        }
  return best;
}

/** Dzieli panel na pół wzdłuż dłuższego boku; zwraca układ ze zmniejszonym panelem i zwolnione miejsce. */
export function splitPanel(layout: Rect[], id: PanelId): { layout: Rect[]; rect: Omit<Rect, "id" | "kind"> } | null {
  const r = layout.find((x) => x.id === id);
  if (!r) return null;
  if (r.w >= r.h * 1.4 && r.w >= MIN_W * 2) {
    const left = Math.ceil(r.w / 2);
    return { layout: layout.map((x) => (x.id === id ? { ...x, w: left, minW: undefined } : x)), rect: { x: r.x + left, y: r.y, w: r.w - left, h: r.h } };
  }
  if (r.h >= MIN_H * 2) {
    const top = Math.ceil(r.h / 2);
    return { layout: layout.map((x) => (x.id === id ? { ...x, h: top, minH: undefined } : x)), rect: { x: r.x, y: r.y + top, w: r.w, h: r.h - top } };
  }
  return null;
}

const STORAGE_KEY = "wikexp.layout.v2";

export function loadLayout(): Rect[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const l = JSON.parse(raw) as Rect[];
      const ids = new Set(l.map((r) => r.id));
      if (Array.isArray(l) && ids.size === l.length && l.every((r) => ALL_KINDS.includes(r.kind)) && isValid(l))
        return l;
    }
  } catch { /* brak albo uszkodzony zapis → domyślny układ */ }
  return DEFAULT_LAYOUT;
}

export function saveLayout(l: Rect[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(l)); } catch { /* ignoruj */ }
}
