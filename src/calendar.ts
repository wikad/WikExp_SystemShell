// Model kalendarza: typy wydarzeń (kolory), wydarzenia z powtarzaniem, daty jako tekst "RRRR-MM-DD".
// Czyste funkcje bez Reacta. Dni tygodnia: 0 = poniedziałek ... 6 = niedziela.
import { COLORS, uid, type Color } from "./kanban";

export type Kind = { id: string; name: string; color: Color };
export type Freq = "daily" | "weekly" | "monthly" | "yearly";
export type Repeat = {
  freq: Freq;
  interval: number;          // co ile jednostek: 1 = co tydzień, 2 = co drugi tydzień
  weekdays: number[];        // tylko weekly: w które dni (puste = dzień tygodnia daty początkowej)
  until: string | null;      // ostatni dzień powtarzania (włącznie)
  count: number | null;      // albo łączna liczba wystąpień
  exceptions: string[];      // dni, w których to wystąpienie jest pominięte
};
export type CalEvent = {
  id: string; title: string; kind: string;
  date: string;              // dzień pierwszego wystąpienia
  allDay: boolean; start: string | null; end: string | null;   // "HH:MM"
  location: string; notes: string;
  repeat: Repeat | null;
};
export type Calendar = { kinds: Kind[]; events: CalEvent[] };

export const WEEKDAYS = ["pon", "wt", "śr", "czw", "pt", "sob", "nd"];
export const WEEKDAYS_LONG = ["poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"];
export const MONTHS = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
export const FREQS: { value: Freq; label: string; unit: string }[] = [
  { value: "daily", label: "codziennie", unit: "dni" }, { value: "weekly", label: "co tydzień", unit: "tygodni" },
  { value: "monthly", label: "co miesiąc", unit: "miesięcy" }, { value: "yearly", label: "co rok", unit: "lat" },
];

// ---------- daty ----------

export const isISO = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && toISO(utc(s)) === s;
export const isTime = (s: unknown): s is string => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const utc = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const toISO = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => toISO(utc(iso) + n * 86400000);
export const daysBetween = (a: string, b: string) => Math.round((utc(b) - utc(a)) / 86400000);
export const weekday = (iso: string) => (new Date(utc(iso)).getUTCDay() + 6) % 7;
export const mondayOf = (iso: string) => addDays(iso, -weekday(iso));
export const todayISO = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
export const ymd = (iso: string) => ({ y: +iso.slice(0, 4), m: +iso.slice(5, 7), d: +iso.slice(8, 10) });
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m: 1-12
const mk = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
/** Dodaje miesiące do daty, przycinając dzień do długości miesiąca (31.01 + 1 m-c = 28.02). */
export function addMonths(iso: string, n: number): string {
  const { y, m, d } = ymd(iso);
  const t = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(t / 12), nm = (t % 12 + 12) % 12 + 1;
  return mk(ny, nm, Math.min(d, lastDayOfMonth(ny, nm)));
}
/** Siatka miesiąca: 6 tygodni po 7 dni, od poniedziałku. */
export function monthGrid(iso: string): string[][] {
  const { y, m } = ymd(iso);
  const start = mondayOf(mk(y, m, 1));
  return Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)));
}
export const weekDays = (iso: string): string[] => Array.from({ length: 7 }, (_, d) => addDays(mondayOf(iso), d));
/** "Czw 05.11" albo z rokiem. */
export const fmtDay = (iso: string, year = false) => `${WEEKDAYS[weekday(iso)]} ${iso.slice(8, 10)}.${iso.slice(5, 7)}${year ? "." + iso.slice(0, 4) : ""}`;

// ---------- powtarzanie ----------

/** Dni, w których wydarzenie się odbywa, w zakresie [from, to] (włącznie). Posortowane, bez wyjątków. */
export function occurrences(ev: CalEvent, from: string, to: string): string[] {
  if (!isISO(ev.date) || from > to) return [];
  const r = ev.repeat;
  const out: string[] = [];
  const push = (d: string) => { if (d >= from && d <= to && !(r?.exceptions ?? []).includes(d)) out.push(d); };
  if (!r) { push(ev.date); return out; }
  const step = Math.max(1, Math.floor(r.interval) || 1);
  const last = r.until && isISO(r.until) ? r.until : null;
  const stop = last && last < to ? last : to;
  let generated = 0;
  const limit = r.count && r.count > 0 ? Math.floor(r.count) : Infinity;
  // zwraca false, gdy trzeba skończyć
  const emit = (d: string): boolean => {
    if (d < ev.date) return true;
    if (d > stop) return false;
    if (generated >= limit) return false;
    generated++;
    push(d);
    return true;
  };
  let guard = 0;
  if (r.freq === "daily") {
    for (let d = ev.date; guard++ < 20000; d = addDays(d, step)) if (!emit(d)) break;
  } else if (r.freq === "weekly") {
    const wds = (r.weekdays.length ? [...new Set(r.weekdays)] : [weekday(ev.date)]).filter((w) => w >= 0 && w <= 6).sort((a, b) => a - b);
    for (let mon = mondayOf(ev.date); guard++ < 5000; mon = addDays(mon, 7 * step)) {
      if (mon > stop) break;
      let done = false;
      for (const w of wds) if (!emit(addDays(mon, w))) { done = true; break; }
      if (done) break;
    }
  } else if (r.freq === "monthly") {
    for (let i = 0; guard++ < 2000; i += step) if (!emit(addMonths(ev.date, i))) break;
  } else {
    for (let i = 0; guard++ < 500; i += step) if (!emit(addMonths(ev.date, i * 12))) break;
  }
  return out;
}

export const hasOccurrence = (ev: CalEvent, day: string) => occurrences(ev, day, day).length === 1;

// ---------- wydarzenia ----------

export function defaultCalendar(): Calendar {
  return {
    kinds: [
      { id: uid(), name: "Wykład", color: "blue" }, { id: uid(), name: "Laboratorium", color: "green" },
      { id: uid(), name: "Ćwiczenia", color: "yellow" }, { id: uid(), name: "Projekt", color: "accent" },
      { id: uid(), name: "Egzamin / kolokwium", color: "red" }, { id: uid(), name: "Inne", color: "muted" },
    ],
    events: [],
  };
}

export function newEvent(cal: Calendar, date: string, partial: Partial<CalEvent> = {}): CalEvent {
  return {
    id: uid(), title: "Nowe wydarzenie", kind: cal.kinds[0]?.id ?? "", date, allDay: false, start: "10:00", end: "11:30",
    location: "", notes: "", repeat: null, ...partial,
  };
}
export const addEvent = (cal: Calendar, ev: CalEvent): Calendar => ({ ...cal, events: [...cal.events, ev] });
export const patchEvent = (cal: Calendar, id: string, patch: Partial<Omit<CalEvent, "id">>): Calendar =>
  ({ ...cal, events: cal.events.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
export const removeEventOnly = (cal: Calendar, id: string): Calendar => ({ ...cal, events: cal.events.filter((e) => e.id !== id) });
/** Pomija jedno wystąpienie serii. Dla zwykłego wydarzenia usuwa je całe. */
export function skipOccurrence(cal: Calendar, id: string, day: string): Calendar {
  const ev = cal.events.find((e) => e.id === id);
  if (!ev) return cal;
  if (!ev.repeat) return removeEventOnly(cal, id);
  return patchEvent(cal, id, { repeat: { ...ev.repeat, exceptions: [...new Set([...ev.repeat.exceptions, day])].sort() } });
}
export const addKind = (cal: Calendar, name: string): Calendar => {
  const n = name.trim();
  if (!n) return cal;
  const used = cal.kinds.map((k) => k.color);
  const color = COLORS.find((c) => !used.includes(c) && c !== "muted") ?? "accent";
  return { ...cal, kinds: [...cal.kinds, { id: uid(), name: n, color }] };
};
export const patchKind = (cal: Calendar, id: string, patch: Partial<Omit<Kind, "id">>): Calendar =>
  ({ ...cal, kinds: cal.kinds.map((k) => (k.id === id ? { ...k, ...patch } : k)) });
/** Usunięcie typu: jego wydarzenia przechodzą na pierwszy pozostały typ. Ostatniego typu nie usuwamy. */
export function removeKind(cal: Calendar, id: string): Calendar {
  if (cal.kinds.length <= 1) return cal;
  const kinds = cal.kinds.filter((k) => k.id !== id);
  return { kinds, events: cal.events.map((e) => (e.kind === id ? { ...e, kind: kinds[0].id } : e)) };
}

/** Wydarzenia danego dnia, posortowane: całodniowe, potem po godzinie. */
export function eventsOnDay(cal: Calendar, day: string): CalEvent[] {
  return cal.events.filter((e) => hasOccurrence(e, day)).sort((a, b) => (a.allDay === b.allDay ? (a.start ?? "").localeCompare(b.start ?? "") : a.allDay ? -1 : 1) || a.title.localeCompare(b.title));
}
export const kindOf = (cal: Calendar, ev: CalEvent): Kind => cal.kinds.find((k) => k.id === ev.kind) ?? cal.kinds[0] ?? { id: "", name: "?", color: "muted" };
export const timeRange = (ev: CalEvent) => (ev.allDay ? "cały dzień" : `${ev.start ?? ""}${ev.end ? "–" + ev.end : ""}`);

/** Czytelny opis powtarzania: "co 2 tyg. (pon, śr) do 20.12.2026". */
export function describeRepeat(r: Repeat | null): string {
  if (!r) return "jednorazowo";
  const f = FREQS.find((x) => x.value === r.freq)!;
  const every = r.interval > 1 ? `co ${r.interval} ${f.unit}` : f.label;
  const days = r.freq === "weekly" && r.weekdays.length ? ` (${[...r.weekdays].sort().map((w) => WEEKDAYS[w]).join(", ")})` : "";
  const end = r.until ? ` do ${r.until.slice(8, 10)}.${r.until.slice(5, 7)}.${r.until.slice(0, 4)}` : r.count ? `, ${r.count}×` : "";
  return `${every}${days}${end}`;
}

// ---------- naprawa danych z dysku ----------

export function normalizeCalendar(raw: unknown): Calendar {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Calendar>;
  const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
  const color = (v: unknown): Color => (COLORS as readonly string[]).includes(v as string) ? (v as Color) : "accent";
  let kinds: Kind[] = (Array.isArray(r.kinds) ? r.kinds : []).filter((k) => k && typeof k === "object").map((k) => ({ id: str(k.id) || uid(), name: str(k.name, "typ"), color: color(k.color) }));
  if (kinds.length === 0) kinds = defaultCalendar().kinds;
  const freqs = FREQS.map((f) => f.value);
  const events: CalEvent[] = [];
  const seen = new Set<string>();
  for (const e of Array.isArray(r.events) ? r.events : []) {
    if (!e || typeof e !== "object" || !isISO(e.date)) continue;     // wydarzenie bez poprawnej daty nie ma sensu
    const id = str(e.id) || uid();
    if (seen.has(id)) continue;
    seen.add(id);
    const rep = e.repeat && typeof e.repeat === "object" ? e.repeat : null;
    const allDay = !!e.allDay;
    events.push({
      id, title: str(e.title, "(bez tytułu)"), kind: kinds.some((k) => k.id === e.kind) ? e.kind : kinds[0].id, date: e.date,
      allDay, start: !allDay && isTime(e.start) ? e.start : null, end: !allDay && isTime(e.end) ? e.end : null,
      location: str(e.location), notes: str(e.notes),
      repeat: rep ? {
        freq: freqs.includes(rep.freq) ? rep.freq : "weekly",
        interval: Number.isFinite(rep.interval) && rep.interval >= 1 ? Math.floor(rep.interval) : 1,
        weekdays: (Array.isArray(rep.weekdays) ? rep.weekdays : []).filter((w) => Number.isInteger(w) && w >= 0 && w <= 6),
        until: isISO(rep.until) ? rep.until : null,
        count: Number.isFinite(rep.count) && (rep.count as number) >= 1 ? Math.floor(rep.count as number) : null,
        exceptions: (Array.isArray(rep.exceptions) ? rep.exceptions : []).filter(isISO),
      } : null,
    });
  }
  return { kinds, events };
}
