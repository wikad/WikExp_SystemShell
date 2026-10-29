// Dokument planu: tablica kanban + kalendarz w jednym pliku (plan.json). Tu są operacje łączące oba,
// np. zaplanowanie karty na dzień albo powiązanie jej z wydarzeniem. Czyste funkcje bez Reacta.
import * as K from "./kanban";
import * as C from "./calendar";

export const PLAN_VERSION = 1;
export type PlanDoc = { version: number; board: K.Board; calendar: C.Calendar };

export const defaultPlan = (): PlanDoc => ({ version: PLAN_VERSION, board: K.defaultBoard(), calendar: C.defaultCalendar() });

/** Naprawia dokument z dysku. Powiązania z nieistniejącymi wydarzeniami są zerowane. */
export function normalizePlan(raw: unknown): PlanDoc {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<PlanDoc>;
  const board = K.normalize(r.board);
  const calendar = C.normalizeCalendar(r.calendar);
  const ids = new Set(calendar.events.map((e) => e.id));
  const cards = Object.fromEntries(Object.entries(board.cards).map(([id, c]) => [id, c.link && !ids.has(c.link.eventId) ? { ...c, link: null } : c]));
  return { version: PLAN_VERSION, board: { ...board, cards }, calendar };
}

export const serialize = (doc: PlanDoc) => JSON.stringify(doc, null, 2) + "\n";

// ---------- karty ↔ kalendarz ----------

/** Zaplanuj kartę na dzień (date = null zdejmuje z kalendarza). Zaplanowanie czyści powiązanie z wydarzeniem. */
export function scheduleCard(doc: PlanDoc, cardId: string, date: string | null, time: string | null = null): PlanDoc {
  if (!doc.board.cards[cardId]) return doc;
  if (date !== null && !C.isISO(date)) return doc;
  return { ...doc, board: K.patchCard(doc.board, cardId, { scheduled: date ? { date, time: C.isTime(time) ? time : null } : null, link: date ? null : doc.board.cards[cardId].link }) };
}
/** Powiąż kartę z wydarzeniem (date = konkretne wystąpienie). Powiązanie zastępuje zaplanowanie na dzień. */
export function linkCard(doc: PlanDoc, cardId: string, eventId: string | null, date: string | null = null): PlanDoc {
  if (!doc.board.cards[cardId]) return doc;
  if (eventId === null) return { ...doc, board: K.patchCard(doc.board, cardId, { link: null }) };
  if (!doc.calendar.events.some((e) => e.id === eventId)) return doc;
  return { ...doc, board: K.patchCard(doc.board, cardId, { link: { eventId, date: C.isISO(date) ? date : null }, scheduled: null }) };
}

function clearLinks(board: K.Board, pred: (l: K.Link) => boolean): K.Board {
  const cards = Object.fromEntries(Object.entries(board.cards).map(([id, c]) => [id, c.link && pred(c.link) ? { ...c, link: null } : c]));
  return { ...board, cards };
}
export const removeEvent = (doc: PlanDoc, id: string): PlanDoc =>
  ({ ...doc, calendar: C.removeEventOnly(doc.calendar, id), board: clearLinks(doc.board, (l) => l.eventId === id) });
export function skipOccurrence(doc: PlanDoc, id: string, day: string): PlanDoc {
  const ev = doc.calendar.events.find((e) => e.id === id);
  if (!ev) return doc;
  if (!ev.repeat) return removeEvent(doc, id);
  return { ...doc, calendar: C.skipOccurrence(doc.calendar, id, day), board: clearLinks(doc.board, (l) => l.eventId === id && l.date === day) };
}

/** Karty zaplanowane na dany dzień (kolejność: z godziną po godzinie, potem bez godziny). */
export function tasksOnDay(doc: PlanDoc, day: string): K.Card[] {
  return Object.values(doc.board.cards)
    .filter((c) => c.scheduled?.date === day)
    .sort((a, b) => (a.scheduled!.time ?? "99:99").localeCompare(b.scheduled!.time ?? "99:99") || a.title.localeCompare(b.title));
}
/** Karty powiązane z wystąpieniem wydarzenia w danym dniu. */
export const tasksOfOccurrence = (doc: PlanDoc, eventId: string, day: string): K.Card[] =>
  Object.values(doc.board.cards).filter((c) => c.link?.eventId === eventId && c.link.date === day);
/** Karty powiązane z całą serią (bez konkretnej daty). */
export const tasksOfSeries = (doc: PlanDoc, eventId: string): K.Card[] =>
  Object.values(doc.board.cards).filter((c) => c.link?.eventId === eventId && c.link.date === null);
/** Wszystkie karty powiązane z wydarzeniem (seria i wystąpienia), do listy w oknie wydarzenia. */
export const tasksOfEvent = (doc: PlanDoc, eventId: string): K.Card[] =>
  Object.values(doc.board.cards).filter((c) => c.link?.eventId === eventId).sort((a, b) => (a.link!.date ?? "").localeCompare(b.link!.date ?? ""));
export const laneOfCard = (doc: PlanDoc, cardId: string) => doc.board.lanes.find((l) => l.cards.includes(cardId));
