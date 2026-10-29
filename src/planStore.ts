// Wspólny magazyn planu (kanban + kalendarz). Jeden dokument w pamięci, zapis do pliku plan.json
// (przez Rust), odczyt zmian zrobionych poza WikExp (np. przez Claude Code) co ~2 s.
import { useSyncExternalStore } from "react";
import * as api from "./api";
import { defaultPlan, normalizePlan, serialize, type PlanDoc } from "./plan";
import * as K from "./kanban";

export type PlanState = {
  doc: PlanDoc;
  status: "loading" | "ok" | "error";
  error: string | null;
  path: string;
  dir: string;
};

const SAVE_DELAY = 300;
const POLL_MS = 2000;

let state: PlanState = { doc: defaultPlan(), status: "loading", error: null, path: "", dir: "" };
const listeners = new Set<() => void>();
let started = false;
let dirty = false;          // zmiany w pamięci, których jeszcze nie zapisano
let saving = false;
let blocked = false;        // plik na dysku jest uszkodzony: nie zapisujemy, dopóki użytkownik nie zdecyduje
let lastMtime = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function set(patch: Partial<PlanState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** Przenosi stare dane kanbanu z localStorage (przed wprowadzeniem pliku planu). */
function migrateBoard(): K.Board | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("wikexp.kanban.") && k.endsWith(".v1")) {
        const raw = localStorage.getItem(k);
        if (raw) return K.normalize(JSON.parse(raw));
      }
    }
  } catch { /* brak dostępu: pomijamy */ }
  return null;
}

async function load(initial: boolean) {
  try {
    const f = await api.planLoad();
    lastMtime = f.mtime;
    if (f.text === null) {
      const doc = defaultPlan();
      const migrated = migrateBoard();
      if (migrated) doc.board = migrated;
      blocked = false;
      set({ doc, status: "ok", error: null, path: f.path, dir: f.dir });
      if (migrated || initial) scheduleSave();
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(f.text); } catch (e) {
      blocked = true;
      set({ status: "error", error: `plan.json jest uszkodzony (${e instanceof Error ? e.message : e}). Nic nie zapisuję, dopóki nie zdecydujesz.`, path: f.path, dir: f.dir });
      return;
    }
    blocked = false;
    set({ doc: normalizePlan(parsed), status: "ok", error: null, path: f.path, dir: f.dir });
  } catch (e) {
    blocked = true;
    set({ status: "error", error: `Nie można odczytać planu: ${e}`, });
  }
}

function scheduleSave() {
  dirty = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, SAVE_DELAY);
}

async function flush() {
  timer = null;
  if (!dirty || blocked || saving) { if (dirty && saving) scheduleSave(); return; }
  saving = true;
  dirty = false;
  try {
    lastMtime = await api.planSave(serialize(state.doc), today());
    if (state.status === "error") set({ status: "ok", error: null });
  } catch (e) {
    dirty = true;
    set({ status: "error", error: `Zapis planu nie powiódł się: ${e}` });
  } finally {
    saving = false;
  }
}

async function poll() {
  if (dirty || saving || timer) return;
  try {
    const m = await api.planStat();
    if (m !== lastMtime && !dirty && !saving) await load(false);
  } catch { /* chwilowy błąd: następna próba za 2 s */ }
}

export function startPlanStore() {
  if (started) return;
  started = true;
  void load(true);
  setInterval(poll, POLL_MS);
  window.addEventListener("beforeunload", () => { if (dirty && !blocked) void flush(); });
}

/** Zmienia dokument i zapisuje. Funkcja dostaje aktualny stan, nie zapamiętany z renderu. */
export function updatePlan(fn: (d: PlanDoc) => PlanDoc) {
  if (state.status === "loading") return;
  const next = fn(state.doc);
  if (next === state.doc) return;
  set({ doc: next });
  scheduleSave();
}
export const updateBoard = (fn: (b: K.Board) => K.Board) =>
  updatePlan((d) => { const b = fn(d.board); return b === d.board ? d : { ...d, board: b }; });

/** Po błędzie: wczytaj plik z dysku jeszcze raz (porzuca zmiany w pamięci). */
export async function reloadPlan() { dirty = false; if (timer) { clearTimeout(timer); timer = null; } await load(false); }
/** Po błędzie: zapisz bieżący stan z pamięci na plik (nadpisuje uszkodzony). */
export function overwritePlan() { blocked = false; set({ status: "ok", error: null }); scheduleSave(); }

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const usePlan = (): PlanState => {
  startPlanStore();
  return useSyncExternalStore(subscribe, () => state);
};

// ---------- przeciąganie kart nad kalendarzem ----------

export type CalTarget = { kind: "day"; day: string } | { kind: "event"; eventId: string; day: string };
let hover: CalTarget | null = null;
const hoverListeners = new Set<() => void>();
export function setCalHover(t: CalTarget | null) {
  const same = (a: CalTarget | null, b: CalTarget | null) => JSON.stringify(a) === JSON.stringify(b);
  if (same(hover, t)) return;
  hover = t;
  hoverListeners.forEach((l) => l());
}
export const useCalHover = () => useSyncExternalStore((l) => { hoverListeners.add(l); return () => { hoverListeners.delete(l); }; }, () => hover);

/** Co jest pod wskaźnikiem w kalendarzu: wystąpienie wydarzenia (ma pierwszeństwo) albo sam dzień. */
export function calTargetAt(x: number, y: number): CalTarget | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (!(el instanceof HTMLElement)) continue;
    const ev = el.closest<HTMLElement>("[data-cal-event]");
    if (ev?.dataset.calEvent && ev.dataset.calDate) return { kind: "event", eventId: ev.dataset.calEvent, day: ev.dataset.calDate };
    const day = el.closest<HTMLElement>("[data-cal-day]");
    if (day?.dataset.calDay) return { kind: "day", day: day.dataset.calDay };
  }
  return null;
}
