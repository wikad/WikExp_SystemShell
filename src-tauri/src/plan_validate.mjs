// Walidator planu WikExp. Użycie: node validate.mjs [ścieżka do plan.json]
// Wypisuje błędy (exit 1) i ostrzeżenia. Ten plik jest zarządzany przez WikExp i nadpisywany przy starcie.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const path = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "plan.json");
const errors = [], warns = [];
const err = (m) => errors.push(m), warn = (m) => warns.push(m);

let doc;
try { doc = JSON.parse(readFileSync(path, "utf8")); } catch (e) { console.error(`BŁĄD: ${path}: ${e.message}`); process.exit(1); }

const COLORS = ["accent", "blue", "green", "yellow", "orange", "red", "muted"];
const FIELD_TYPES = ["text", "number", "date", "select", "checkbox"];
const FREQS = ["daily", "weekly", "monthly", "yearly"];
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const isTime = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);
const dupes = (arr) => arr.filter((x, i) => arr.indexOf(x) !== i);

if (!isObj(doc)) { console.error("BŁĄD: główny element musi być obiektem"); process.exit(1); }
if (doc.version !== 1) warn(`version = ${JSON.stringify(doc.version)} (oczekiwane 1)`);

const b = doc.board, cal = doc.calendar;
if (!isObj(b)) err("brak obiektu board");
if (!isObj(cal)) err("brak obiektu calendar");

if (isObj(b)) {
  const lanes = Array.isArray(b.lanes) ? b.lanes : (err("board.lanes musi być tablicą"), []);
  const cards = isObj(b.cards) ? b.cards : (err("board.cards musi być obiektem (id → karta)"), {});
  const cats = Array.isArray(b.categories) ? b.categories : (err("board.categories musi być tablicą"), []);
  const fields = Array.isArray(b.fields) ? b.fields : (err("board.fields musi być tablicą"), []);
  if (lanes.length === 0) err("board.lanes jest puste (potrzebna co najmniej jedna lista)");
  for (const d of dupes(lanes.map((l) => l?.id))) err(`powtórzone id listy: ${d}`);
  for (const d of dupes(cats.map((c) => c?.id))) err(`powtórzone id kategorii: ${d}`);
  for (const d of dupes(fields.map((f) => f?.id))) err(`powtórzone id pola: ${d}`);
  const where = {};
  for (const l of lanes) {
    if (typeof l?.id !== "string" || !l.id) err(`lista bez id: ${JSON.stringify(l?.title)}`);
    if (!COLORS.includes(l?.color)) err(`lista "${l?.title}": zły kolor ${JSON.stringify(l?.color)} (dozwolone: ${COLORS.join(", ")})`);
    if (l?.limit !== null && !(Number.isInteger(l?.limit) && l.limit > 0)) err(`lista "${l?.title}": limit musi być null albo liczbą całkowitą > 0`);
    for (const cid of l?.cards ?? []) {
      if (!cards[cid]) err(`lista "${l.title}" wskazuje nieistniejącą kartę ${cid}`);
      (where[cid] ??= []).push(l.title);
    }
  }
  for (const [cid, ls] of Object.entries(where)) if (ls.length > 1) err(`karta ${cid} jest w kilku listach: ${ls.join(", ")}`);
  for (const k of cats) if (!COLORS.includes(k?.color)) err(`kategoria "${k?.name}": zły kolor ${JSON.stringify(k?.color)}`);
  for (const f of fields) {
    if (!FIELD_TYPES.includes(f?.type)) err(`pole "${f?.name}": zły typ ${JSON.stringify(f?.type)} (dozwolone: ${FIELD_TYPES.join(", ")})`);
    if (!Array.isArray(f?.options)) err(`pole "${f?.name}": options musi być tablicą (może być pusta)`);
  }
  const eventIds = new Set((cal?.events ?? []).map((e) => e?.id));
  for (const [cid, c] of Object.entries(cards)) {
    const tag = `karta ${cid} "${c?.title}"`;
    if (c?.id !== cid) err(`${tag}: pole id (${JSON.stringify(c?.id)}) musi równać się kluczowi`);
    if (!where[cid]) err(`${tag}: nie leży w żadnej liście (dodaj ją do lanes[].cards albo usuń)`);
    if (typeof c?.title !== "string" || !c.title.trim()) err(`${tag}: pusty tytuł`);
    for (const k of c?.categories ?? []) if (!cats.some((x) => x.id === k)) err(`${tag}: nieznana kategoria ${k}`);
    for (const [fid, v] of Object.entries(c?.values ?? {})) {
      const f = fields.find((x) => x.id === fid);
      if (!f) { err(`${tag}: wartość nieznanego pola ${fid}`); continue; }
      if (f.type === "date" && !isDate(v)) err(`${tag}: pole "${f.name}" wymaga daty RRRR-MM-DD`);
      if (f.type === "number" && typeof v !== "number") err(`${tag}: pole "${f.name}" wymaga liczby`);
      if (f.type === "checkbox" && v !== true) warn(`${tag}: pole "${f.name}" tak/nie: zapisuj tylko true (brak klucza = nie)`);
      if (f.type === "select" && !f.options.includes(v)) warn(`${tag}: wartość "${v}" nie ma w opcjach pola "${f.name}"`);
    }
    if (c?.scheduled != null) {
      if (!isDate(c.scheduled.date)) err(`${tag}: scheduled.date musi być datą RRRR-MM-DD`);
      if (c.scheduled.time != null && !isTime(c.scheduled.time)) err(`${tag}: scheduled.time musi być GG:MM albo null`);
    }
    if (c?.link != null) {
      if (!eventIds.has(c.link.eventId)) err(`${tag}: link.eventId ${c.link.eventId} nie istnieje w calendar.events`);
      if (c.link.date != null && !isDate(c.link.date)) err(`${tag}: link.date musi być datą albo null`);
    }
    if (c?.scheduled && c?.link) warn(`${tag}: ma jednocześnie scheduled i link (WikExp zostawia oba, ale zwykle wystarczy jedno)`);
  }
  for (const a of b.archive ?? []) if (cards[a?.id]) err(`karta ${a.id} jest jednocześnie w cards i w archive`);
}

if (isObj(cal)) {
  const kinds = Array.isArray(cal.kinds) ? cal.kinds : (err("calendar.kinds musi być tablicą"), []);
  const events = Array.isArray(cal.events) ? cal.events : (err("calendar.events musi być tablicą"), []);
  if (kinds.length === 0) err("calendar.kinds jest puste (potrzebny co najmniej jeden typ)");
  for (const d of dupes(kinds.map((k) => k?.id))) err(`powtórzone id typu: ${d}`);
  for (const d of dupes(events.map((e) => e?.id))) err(`powtórzone id wydarzenia: ${d}`);
  for (const k of kinds) if (!COLORS.includes(k?.color)) err(`typ "${k?.name}": zły kolor ${JSON.stringify(k?.color)}`);
  for (const e of events) {
    const tag = `wydarzenie ${e?.id} "${e?.title}"`;
    if (!isDate(e?.date)) err(`${tag}: date musi być RRRR-MM-DD`);
    if (!kinds.some((k) => k.id === e?.kind)) err(`${tag}: nieznany typ ${JSON.stringify(e?.kind)}`);
    if (e?.allDay) { if (e.start != null || e.end != null) warn(`${tag}: allDay=true, więc start/end powinny być null`); }
    else {
      if (!isTime(e?.start)) err(`${tag}: start musi być GG:MM (albo ustaw allDay=true)`);
      if (e?.end != null && !isTime(e.end)) err(`${tag}: end musi być GG:MM albo null`);
      if (isTime(e?.start) && isTime(e?.end) && e.end <= e.start) warn(`${tag}: koniec nie jest po początku`);
    }
    const r = e?.repeat;
    if (r != null) {
      if (!FREQS.includes(r.freq)) err(`${tag}: repeat.freq musi być jednym z: ${FREQS.join(", ")}`);
      if (!(Number.isInteger(r.interval) && r.interval >= 1)) err(`${tag}: repeat.interval musi być liczbą całkowitą >= 1`);
      if (!Array.isArray(r.weekdays) || r.weekdays.some((w) => !(Number.isInteger(w) && w >= 0 && w <= 6))) err(`${tag}: repeat.weekdays to tablica liczb 0-6 (0 = poniedziałek)`);
      if (r.until != null && !isDate(r.until)) err(`${tag}: repeat.until musi być datą albo null`);
      if (r.count != null && !(Number.isInteger(r.count) && r.count >= 1)) err(`${tag}: repeat.count musi być liczbą >= 1 albo null`);
      if (r.until != null && r.count != null) warn(`${tag}: ustawione i until, i count (obowiązuje to, co skończy się pierwsze)`);
      if (!Array.isArray(r.exceptions) || r.exceptions.some((d) => !isDate(d))) err(`${tag}: repeat.exceptions to tablica dat`);
      if (r.until == null && r.count == null) warn(`${tag}: powtarza się bez końca (ustaw until, jeśli to zajęcia semestralne)`);
    }
  }
}

for (const w of warns) console.log(`uwaga: ${w}`);
for (const e of errors) console.error(`BŁĄD: ${e}`);
console.log(errors.length ? `\n${errors.length} błędów, ${warns.length} uwag` : `OK: ${path} jest poprawny (${warns.length} uwag)`);
process.exit(errors.length ? 1 : 0);
