// Model tablicy kanban (jak wtyczka Kanban w Obsidianie): listy, karty, kategorie, własne pola, archiwum.
// Same czyste funkcje bez Reacta: każda zwraca nową tablicę, nie zmienia starej.

export const COLORS = ["accent", "blue", "green", "yellow", "orange", "red", "muted"] as const;
export type Color = (typeof COLORS)[number];
export type FieldType = "text" | "number" | "date" | "select" | "checkbox";
export const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "tekst" }, { value: "number", label: "liczba" }, { value: "date", label: "data" },
  { value: "select", label: "lista wyboru" }, { value: "checkbox", label: "tak/nie" },
];

export type Category = { id: string; name: string; color: Color };
export type Field = { id: string; name: string; type: FieldType; options: string[] };
export type Value = string | number | boolean;
export type Schedule = { date: string; time: string | null };          // zaplanowane na dzień (i godzinę) w kalendarzu
export type Link = { eventId: string; date: string | null };           // powiązanie z wydarzeniem (date = konkretne wystąpienie, null = cała seria)
export type Card = {
  id: string; title: string; notes: string; categories: string[];
  values: Record<string, Value>; created: number; done: boolean;
  scheduled: Schedule | null; link: Link | null;
};
export type Lane = { id: string; title: string; color: Color; limit: number | null; collapsed: boolean; cards: string[] };
export type Board = { lanes: Lane[]; cards: Record<string, Card>; categories: Category[]; fields: Field[]; archive: Card[] };

let counter = 0;
export const uid = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const nextColor = (used: Color[]): Color => COLORS.find((c) => !used.includes(c) && c !== "muted") ?? COLORS[used.length % COLORS.length];
export const cycleColor = (c: Color): Color => COLORS[(COLORS.indexOf(c) + 1) % COLORS.length];

export function defaultBoard(): Board {
  const mk = (title: string, color: Color): Lane => ({ id: uid(), title, color, limit: null, collapsed: false, cards: [] });
  const cats: Category[] = [
    { id: uid(), name: "funkcja", color: "blue" },
    { id: uid(), name: "błąd", color: "red" },
    { id: uid(), name: "pomysł", color: "yellow" },
  ];
  const fields: Field[] = [
    { id: uid(), name: "Termin", type: "date", options: [] },
    { id: uid(), name: "Priorytet", type: "select", options: ["niski", "średni", "wysoki"] },
  ];
  return {
    lanes: [mk("Pomysły", "yellow"), mk("Do zrobienia", "blue"), mk("W realizacji", "accent"), mk("Zrobione", "green")],
    cards: {}, categories: cats, fields, archive: [],
  };
}

const isDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);               // 2026-13-40 i 2026-02-30 odpadają
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const isHHMM = (s: unknown): s is string => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** Naprawia dane odczytane z dysku (stara wersja, ręczna edycja): nigdy nie zwraca niepoprawnej tablicy. */
export function normalize(raw: unknown): Board {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Board>;
  const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
  const color = (v: unknown): Color => (COLORS as readonly string[]).includes(v as string) ? (v as Color) : "accent";
  const cards: Record<string, Card> = {};
  for (const [id, c] of Object.entries(r.cards && typeof r.cards === "object" ? r.cards : {})) {
    const x = c as Partial<Card>;
    cards[id] = {
      id, title: str(x.title, "(bez tytułu)"), notes: str(x.notes),
      categories: Array.isArray(x.categories) ? x.categories.filter((s) => typeof s === "string") : [],
      values: x.values && typeof x.values === "object" ? { ...x.values } : {},
      created: typeof x.created === "number" ? x.created : Date.now(), done: !!x.done,
      scheduled: x.scheduled && isDate(x.scheduled.date) ? { date: x.scheduled.date, time: isHHMM(x.scheduled.time) ? x.scheduled.time : null } : null,
      link: x.link && typeof x.link.eventId === "string" && x.link.eventId ? { eventId: x.link.eventId, date: isDate(x.link.date) ? x.link.date : null } : null,
    };
  }
  const lanes: Lane[] = (Array.isArray(r.lanes) ? r.lanes : []).map((l) => ({
    id: str(l.id) || uid(), title: str(l.title, "Lista"), color: color(l.color),
    limit: typeof l.limit === "number" && l.limit > 0 ? l.limit : null, collapsed: !!l.collapsed,
    cards: (Array.isArray(l.cards) ? l.cards : []).filter((id) => typeof id === "string" && cards[id]),
  }));
  if (lanes.length === 0) return defaultBoard();
  // karta w dwóch listach albo w żadnej: zostaje w pierwszej, w której jest; sieroty trafiają do pierwszej listy
  const seen = new Set<string>();
  for (const l of lanes) l.cards = l.cards.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  for (const id of Object.keys(cards)) if (!seen.has(id)) lanes[0].cards.push(id);
  const categories: Category[] = (Array.isArray(r.categories) ? r.categories : []).map((c) => ({ id: str(c.id) || uid(), name: str(c.name, "kategoria"), color: color(c.color) }));
  const types = FIELD_TYPES.map((t) => t.value);
  const fields: Field[] = (Array.isArray(r.fields) ? r.fields : []).map((f) => ({
    id: str(f.id) || uid(), name: str(f.name, "pole"), type: types.includes(f.type) ? f.type : "text",
    options: Array.isArray(f.options) ? f.options.filter((s) => typeof s === "string") : [],
  }));
  const archive: Card[] = (Array.isArray(r.archive) ? r.archive : []).filter((c) => c && typeof c.id === "string" && typeof c.title === "string")
    .map((c) => ({ ...c, categories: Array.isArray(c.categories) ? c.categories : [], values: c.values && typeof c.values === "object" ? c.values : {}, notes: str(c.notes), created: typeof c.created === "number" ? c.created : Date.now(), done: !!c.done, scheduled: null, link: null }));
  return { lanes, cards, categories, fields, archive };
}

// ---------- listy ----------

export const addLane = (b: Board, title: string): Board => {
  const lane: Lane = { id: uid(), title: title.trim() || "Lista", color: nextColor(b.lanes.map((l) => l.color)), limit: null, collapsed: false, cards: [] };
  return { ...b, lanes: [...b.lanes, lane] };
};
export const patchLane = (b: Board, id: string, patch: Partial<Omit<Lane, "id" | "cards">>): Board =>
  ({ ...b, lanes: b.lanes.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
export function moveLane(b: Board, id: string, delta: number): Board {
  const i = b.lanes.findIndex((l) => l.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= b.lanes.length) return b;
  const lanes = [...b.lanes];
  [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
  return { ...b, lanes };
}
/** Usunięcie listy nie gubi kart: trafiają do archiwum. Ostatniej listy nie da się usunąć. */
export function removeLane(b: Board, id: string): Board {
  const lane = b.lanes.find((l) => l.id === id);
  if (!lane || b.lanes.length <= 1) return b;
  let next: Board = { ...b, lanes: b.lanes.filter((l) => l.id !== id) };
  for (const cid of lane.cards) next = archiveFrom(next, cid);
  return next;
}
export function archiveLaneCards(b: Board, id: string): Board {
  const lane = b.lanes.find((l) => l.id === id);
  if (!lane) return b;
  let next = b;
  for (const cid of lane.cards) next = archiveFrom(next, cid);
  return next;
}

// ---------- karty ----------

export function addCard(b: Board, laneId: string, title: string): { board: Board; id: string | null } {
  const t = title.trim();
  if (!t || !b.lanes.some((l) => l.id === laneId)) return { board: b, id: null };
  const card: Card = { id: uid(), title: t, notes: "", categories: [], values: {}, created: Date.now(), done: false, scheduled: null, link: null };
  return {
    id: card.id,
    board: { ...b, cards: { ...b.cards, [card.id]: card }, lanes: b.lanes.map((l) => (l.id === laneId ? { ...l, cards: [...l.cards, card.id] } : l)) },
  };
}
export const patchCard = (b: Board, id: string, patch: Partial<Omit<Card, "id">>): Board =>
  b.cards[id] ? { ...b, cards: { ...b.cards, [id]: { ...b.cards[id], ...patch } } } : b;

/** Przenosi kartę na listę `toLane` na pozycję `index` (liczoną już po wyjęciu karty z dotychczasowej listy). */
export function moveCard(b: Board, cardId: string, toLane: string, index: number): Board {
  if (!b.cards[cardId] || !b.lanes.some((l) => l.id === toLane)) return b;
  const lanes = b.lanes.map((l) => ({ ...l, cards: l.cards.filter((c) => c !== cardId) }));
  const target = lanes.find((l) => l.id === toLane)!;
  const at = Math.max(0, Math.min(index, target.cards.length));
  target.cards = [...target.cards.slice(0, at), cardId, ...target.cards.slice(at)];
  return { ...b, lanes };
}

function archiveFrom(b: Board, cardId: string): Board {
  const card = b.cards[cardId];
  if (!card) return b;
  const { [cardId]: _gone, ...rest } = b.cards;
  return { ...b, cards: rest, lanes: b.lanes.map((l) => ({ ...l, cards: l.cards.filter((c) => c !== cardId) })), archive: [{ ...card, scheduled: null, link: null }, ...b.archive] };
}
export const archiveCard = archiveFrom;

export function restoreCard(b: Board, cardId: string, laneId?: string): Board {
  const card = b.archive.find((c) => c.id === cardId);
  if (!card) return b;
  const lane = b.lanes.find((l) => l.id === laneId) ?? b.lanes[0];
  return {
    ...b, archive: b.archive.filter((c) => c.id !== cardId), cards: { ...b.cards, [card.id]: card },
    lanes: b.lanes.map((l) => (l.id === lane.id ? { ...l, cards: [...l.cards, card.id] } : l)),
  };
}
export const deleteArchived = (b: Board, cardId: string): Board => ({ ...b, archive: b.archive.filter((c) => c.id !== cardId) });
export function deleteCard(b: Board, cardId: string): Board {
  const { [cardId]: _gone, ...rest } = b.cards;
  return { ...b, cards: rest, lanes: b.lanes.map((l) => ({ ...l, cards: l.cards.filter((c) => c !== cardId) })) };
}

export function toggleCategory(b: Board, cardId: string, catId: string): Board {
  const c = b.cards[cardId];
  if (!c) return b;
  const has = c.categories.includes(catId);
  return patchCard(b, cardId, { categories: has ? c.categories.filter((x) => x !== catId) : [...c.categories, catId] });
}
export function setValue(b: Board, cardId: string, fieldId: string, v: Value | null): Board {
  const c = b.cards[cardId];
  if (!c) return b;
  const values = { ...c.values };
  if (v === null || v === "" || v === false) delete values[fieldId]; else values[fieldId] = v;
  return patchCard(b, cardId, { values });
}

// ---------- kategorie i pola ----------

export const addCategory = (b: Board, name: string): Board => {
  const n = name.trim();
  if (!n) return b;
  return { ...b, categories: [...b.categories, { id: uid(), name: n, color: nextColor(b.categories.map((c) => c.color)) }] };
};
export const patchCategory = (b: Board, id: string, patch: Partial<Omit<Category, "id">>): Board =>
  ({ ...b, categories: b.categories.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
export function removeCategory(b: Board, id: string): Board {
  const strip = (c: Card): Card => ({ ...c, categories: c.categories.filter((x) => x !== id) });
  return {
    ...b, categories: b.categories.filter((c) => c.id !== id),
    cards: Object.fromEntries(Object.entries(b.cards).map(([k, c]) => [k, strip(c)])), archive: b.archive.map(strip),
  };
}
export const addField = (b: Board, name: string, type: FieldType): Board => {
  const n = name.trim();
  if (!n) return b;
  return { ...b, fields: [...b.fields, { id: uid(), name: n, type, options: [] }] };
};
export const patchField = (b: Board, id: string, patch: Partial<Omit<Field, "id">>): Board =>
  ({ ...b, fields: b.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
export function removeField(b: Board, id: string): Board {
  const strip = (c: Card): Card => { const { [id]: _g, ...values } = c.values; return { ...c, values }; };
  return {
    ...b, fields: b.fields.filter((f) => f.id !== id),
    cards: Object.fromEntries(Object.entries(b.cards).map(([k, c]) => [k, strip(c)])), archive: b.archive.map(strip),
  };
}

// ---------- widok ----------

/** Czy karta pasuje do filtra tekstowego (tytuł, notatki, nazwy kategorii, wartości pól) i kategorii. */
export function matches(b: Board, c: Card, query: string, cat: string | null): boolean {
  if (cat && !c.categories.includes(cat)) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [c.title, c.notes, ...c.categories.map((id) => b.categories.find((x) => x.id === id)?.name ?? ""), ...Object.values(c.values).map(String)];
  return hay.some((s) => s.toLowerCase().includes(q));
}

/** "2026-11-03" → "03.11". */
export const fmtDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : iso);
/** -1 = po terminie, 0 = dziś, 1+ = za tyle dni; null = zła data. */
export function daysUntil(iso: string, today = new Date()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((d - t) / 86400000);
}
