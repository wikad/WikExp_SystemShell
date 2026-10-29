import { useEffect, useRef, useState } from "react";
import * as C from "./calendar";
import * as K from "./kanban";
import * as P from "./plan";
import { Modal } from "./KanbanPanel";
import { calTargetAt, overwritePlan, reloadPlan, setCalHover, updatePlan, useCalHover, usePlan } from "./planStore";

const col = (c: K.Color) => `var(--${c})`;
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

type View = "month" | "week";
type Dlg = null | { kind: "event"; id: string; day: string } | { kind: "kinds" };
type TaskDrag = { id: string; x: number; y: number; title: string };

/**
 * Kalendarz: widok miesiąca i tygodnia, wydarzenia (wykłady, laby…) w kolorach typów, powtarzanie
 * (np. co 2 tygodnie), zadania z kanbana zaplanowane na dni. Karty z panelu „plan” przeciągasz na dzień
 * (zaplanowanie) albo na wydarzenie (powiązanie z wystąpieniem). Dane w tym samym pliku co kanban.
 * Klawisze: h/l poprzedni/następny, t dziś, m/w miesiąc/tydzień, n nowe wydarzenie, Enter edytuj pierwsze w dniu.
 */
export function CalendarPanel({ id, active }: { id: string; active: boolean }) {
  void id;
  const { doc, status, error } = usePlan();
  const cal = doc.calendar;
  const hover = useCalHover();
  const [view, setView] = useState<View>("month");
  const [day, setDay] = useState(C.todayISO());           // zaznaczony dzień (agenda i nawigacja)
  const [dlg, setDlg] = useState<Dlg>(null);
  const [tdrag, setTdrag] = useState<TaskDrag | null>(null);
  const suppress = useRef(false);

  const step = (n: number) => setDay((d) => (view === "month" ? C.addMonths(d, n) : C.addDays(d, 7 * n)));
  const addEventOn = (date: string) => {
    const ev = C.newEvent(doc.calendar, date);
    updatePlan((p) => ({ ...p, calendar: C.addEvent(p.calendar, ev) }));
    setDlg({ kind: "event", id: ev.id, day: date });
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (dlg) { if (e.key === "Escape") { e.preventDefault(); setDlg(null); } return; }
      if (isTyping(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
      switch (e.key) {
        case "h": case "ArrowLeft": e.preventDefault(); step(-1); break;
        case "l": case "ArrowRight": e.preventDefault(); step(1); break;
        case "j": case "ArrowDown": e.preventDefault(); setDay((d) => C.addDays(d, 7)); break;
        case "k": case "ArrowUp": e.preventDefault(); setDay((d) => C.addDays(d, -7)); break;
        case "t": setDay(C.todayISO()); break;
        case "m": setView("month"); break;
        case "w": setView("week"); break;
        case "n": e.preventDefault(); addEventOn(day); break;
        case "Enter": { const ev = C.eventsOnDay(doc.calendar, day)[0]; if (ev) { e.preventDefault(); setDlg({ kind: "event", id: ev.id, day }); } break; }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // bez zależności: handler zawsze widzi aktualny stan

  // przeciąganie zadania (chip w kalendarzu) na inny dzień albo wydarzenie
  const onTaskDown = (e: React.PointerEvent, c: K.Card) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY, active: false };
    const move = (ev: PointerEvent) => {
      if (!start.active && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      start.active = true;
      setTdrag({ id: c.id, x: ev.clientX + 8, y: ev.clientY + 8, title: c.title });
      setCalHover(calTargetAt(ev.clientX, ev.clientY));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (start.active) {
        suppress.current = true;
        setTimeout(() => { suppress.current = false; }, 0);
        const t = ev.type === "pointerup" ? calTargetAt(ev.clientX, ev.clientY) : null;
        if (t) updatePlan((p) => (t.kind === "day" ? P.scheduleCard(p, c.id, t.day, c.scheduled?.time ?? null) : P.linkCard(p, c.id, t.eventId, t.day)));
      }
      setCalHover(null);
      setTdrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const today = C.todayISO();
  const { y, m } = C.ymd(day);
  const weeks = view === "month" ? C.monthGrid(day) : [C.weekDays(day)];
  const title = view === "month" ? `${C.MONTHS[m - 1]} ${y}` : `${C.fmtDay(C.mondayOf(day))} – ${C.fmtDay(C.addDays(C.mondayOf(day), 6), true)}`;
  const maxEv = view === "month" ? 3 : 99;

  const renderDay = (d: string) => {
    const events = C.eventsOnDay(cal, d);
    const tasks = P.tasksOnDay(doc, d);
    const shown = events.slice(0, maxEv);
    const more = events.length - shown.length;
    const inMonth = view === "week" || C.ymd(d).m === m;
    const hoverDay = hover?.day === d && hover.kind === "day";
    return (
      <div key={d} data-cal-day={d}
        className={`cal-cell ${d === today ? "today" : ""} ${d === day ? "sel" : ""} ${inMonth ? "" : "out"} ${hoverDay ? "drop" : ""}`}
        onClick={() => setDay(d)} onDoubleClick={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("cal-num")) addEventOn(d); }}>
        <div className="cal-num">{C.ymd(d).d}{view === "week" && <span className="muted"> {C.WEEKDAYS[C.weekday(d)]}</span>}</div>
        {shown.map((ev) => {
          const k = C.kindOf(cal, ev);
          const n = P.tasksOfOccurrence(doc, ev.id, d).length;
          const hov = hover?.kind === "event" && hover.eventId === ev.id && hover.day === d;
          return (
            <div key={ev.id} data-cal-event={ev.id} data-cal-date={d} className={`cal-ev ${hov ? "drop" : ""}`} style={{ "--ec": col(k.color) } as React.CSSProperties}
              title={`${ev.title} · ${C.timeRange(ev)}${ev.location ? " · " + ev.location : ""}`}
              onClick={(e) => { e.stopPropagation(); setDay(d); setDlg({ kind: "event", id: ev.id, day: d }); }}>
              {!ev.allDay && <span className="cal-time">{ev.start}</span>} {ev.title}{ev.repeat && <span className="muted"> ↻</span>}{n > 0 && <span className="cal-n"> ·{n}</span>}
            </div>
          );
        })}
        {more > 0 && <div className="cal-more muted">+{more} więcej</div>}
        {tasks.slice(0, view === "month" ? 3 : 99).map((c) => (
          <div key={c.id} className={`cal-task ${c.done ? "done" : ""}`} title={`${c.title}${c.scheduled?.time ? " · " + c.scheduled.time : ""} (przeciągnij na inny dzień)`}
            onPointerDown={(e) => onTaskDown(e, c)} onClick={(e) => e.stopPropagation()}>
            {c.done ? "✓" : "☐"} {c.scheduled?.time && <span className="cal-time">{c.scheduled.time}</span>} {c.title}
          </div>
        ))}
        {tasks.length > 3 && view === "month" && <div className="cal-more muted">+{tasks.length - 3} zadań</div>}
      </div>
    );
  };

  // agenda wybranego dnia
  const dayEvents = C.eventsOnDay(cal, day);
  const dayTasks = P.tasksOnDay(doc, day);

  return (
    <div className="cal">
      <div className="cal-head">
        <button className="kb-btn" onClick={() => step(-1)} title="poprzedni (h)">‹</button>
        <button className="kb-btn" onClick={() => step(1)} title="następny (l)">›</button>
        <button className="kb-btn" onClick={() => setDay(today)} title="dziś (t)">dziś</button>
        <span className="cal-title">{title}</span>
        <span className="spacer" />
        <button className={`kb-btn ${view === "month" ? "primary" : ""}`} onClick={() => setView("month")} title="m">miesiąc</button>
        <button className={`kb-btn ${view === "week" ? "primary" : ""}`} onClick={() => setView("week")} title="w">tydzień</button>
        <button className="kb-btn" onClick={() => setDlg({ kind: "kinds" })}>typy</button>
        <button className="kb-btn primary" onClick={() => addEventOn(day)} title="n">+ wydarzenie</button>
      </div>
      {status === "error" && error && (
        <div className="plan-error">
          <span>{error}</span>
          <button className="kb-btn" onClick={() => void reloadPlan()}>wczytaj z pliku</button>
          <button className="kb-btn danger" onClick={() => overwritePlan()}>nadpisz plik tym, co widzę</button>
        </div>
      )}
      <div className="cal-dow">{C.WEEKDAYS.map((w) => <div key={w}>{w}</div>)}</div>
      <div className={`cal-grid ${view}`} style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
        {weeks.map((wk) => <div key={wk[0]} className="cal-week">{wk.map(renderDay)}</div>)}
      </div>
      <div className="cal-agenda">
        <div className="cal-agenda-title">{C.WEEKDAYS_LONG[C.weekday(day)]} {C.fmtDay(day, true).slice(4)}</div>
        {dayEvents.length === 0 && dayTasks.length === 0 && <div className="muted">nic zaplanowanego (n: nowe wydarzenie, przeciągnij tu kartę z panelu „plan”)</div>}
        {dayEvents.map((ev) => {
          const k = C.kindOf(cal, ev);
          const tasks = P.tasksOfOccurrence(doc, ev.id, day);
          return (
            <div key={ev.id} className="cal-ag-row" style={{ "--ec": col(k.color) } as React.CSSProperties} onClick={() => setDlg({ kind: "event", id: ev.id, day })}>
              <span className="cal-dot" /> <span className="cal-time">{C.timeRange(ev)}</span> <b>{ev.title}</b> <span className="muted">{k.name}{ev.location ? " · " + ev.location : ""}</span>
              {tasks.map((c) => <div key={c.id} className="cal-ag-sub">↳ {c.done ? "✓ " : ""}{c.title}</div>)}
            </div>
          );
        })}
        {dayTasks.map((c) => (
          <div key={c.id} className="cal-ag-row task">
            <input type="checkbox" checked={c.done} onChange={(e) => updatePlan((p) => ({ ...p, board: K.patchCard(p.board, c.id, { done: e.target.checked }) }))} />
            {c.scheduled?.time && <span className="cal-time">{c.scheduled.time}</span>} <span className={c.done ? "muted" : ""}>{c.title}</span>
            <button className="kb-x" title="zdejmij z kalendarza" onClick={() => updatePlan((p) => P.scheduleCard(p, c.id, null))}>×</button>
          </div>
        ))}
      </div>
      {tdrag && <div className="kb-ghost" style={{ left: tdrag.x, top: tdrag.y, width: 180 }}>{tdrag.title}</div>}
      {dlg?.kind === "event" && cal.events.some((e) => e.id === dlg.id) && <EventDialog eventId={dlg.id} day={dlg.day} onClose={() => setDlg(null)} />}
      {dlg?.kind === "kinds" && <KindsDialog onClose={() => setDlg(null)} />}
    </div>
  );
}

// ---------- okno wydarzenia ----------

function EventDialog({ eventId, day, onClose }: { eventId: string; day: string; onClose: () => void }) {
  const { doc } = usePlan();
  const ev = doc.calendar.events.find((e) => e.id === eventId)!;
  const [confirm, setConfirm] = useState<"one" | "all" | null>(null);
  const patch = (p: Partial<Omit<C.CalEvent, "id">>) => updatePlan((d) => ({ ...d, calendar: C.patchEvent(d.calendar, eventId, p) }));
  const rep = ev.repeat;
  const setRep = (r: Partial<C.Repeat> | null) => patch({ repeat: r === null ? null : { ...(rep ?? { freq: "weekly", interval: 1, weekdays: [], until: null, count: null, exceptions: [] }), ...r } });
  const linked = P.tasksOfEvent(doc, eventId);
  const unit = C.FREQS.find((f) => f.value === rep?.freq)?.unit ?? "";
  const endMode = rep ? (rep.until ? "until" : rep.count ? "count" : "none") : "none";
  return (
    <Modal title="Wydarzenie" onClose={onClose} wide>
      <input className="kb-input big" autoFocus value={ev.title} spellCheck={false} placeholder="nazwa (np. AKO wykład)"
        onChange={(e) => patch({ title: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") onClose(); }} />
      <div className="kb-cats">
        {doc.calendar.kinds.map((k) => (
          <button key={k.id} className={`kb-pill ${ev.kind === k.id ? "on" : ""}`} style={{ "--pc": col(k.color) } as React.CSSProperties} onClick={() => patch({ kind: k.id })}>{k.name}</button>
        ))}
      </div>
      <div className="kb-grid">
        <label className="kb-row-inline">data{rep ? " pierwszego" : ""}
          <input className="kb-input" type="date" value={ev.date} onChange={(e) => { if (C.isISO(e.target.value)) patch({ date: e.target.value }); }} />
        </label>
        <label className="kb-row-inline"><input type="checkbox" checked={ev.allDay} onChange={(e) => patch(e.target.checked ? { allDay: true, start: null, end: null } : { allDay: false, start: "10:00", end: "11:30" })} /> cały dzień</label>
      </div>
      {!ev.allDay && (
        <div className="kb-grid">
          <label className="kb-row-inline">od <input className="kb-input" type="time" value={ev.start ?? ""} onChange={(e) => patch({ start: e.target.value || "00:00" })} /></label>
          <label className="kb-row-inline">do <input className="kb-input" type="time" value={ev.end ?? ""} onChange={(e) => patch({ end: e.target.value || null })} /></label>
        </div>
      )}
      <input className="kb-input" value={ev.location} spellCheck={false} placeholder="miejsce (sala, budynek)" onChange={(e) => patch({ location: e.target.value })} />
      <textarea className="kb-input notes" value={ev.notes} spellCheck={false} placeholder="notatki" onChange={(e) => patch({ notes: e.target.value })} />

      <div className="kb-field-label muted">powtarzanie</div>
      <div className="kb-grid">
        <select className="kb-input" value={rep?.freq ?? ""} onChange={(e) => (e.target.value ? setRep({ freq: e.target.value as C.Freq }) : setRep(null))}>
          <option value="">nie powtarza się</option>
          {C.FREQS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        {rep && (
          <label className="kb-row-inline">co
            <input className="kb-input sm" type="number" min={1} value={rep.interval} onChange={(e) => setRep({ interval: Math.max(1, Math.floor(+e.target.value) || 1) })} /> {unit}
          </label>
        )}
      </div>
      {rep?.freq === "weekly" && (
        <div className="kb-cats">
          {C.WEEKDAYS.map((w, i) => (
            <button key={w} className={`kb-pill ${rep.weekdays.includes(i) ? "on" : ""}`} style={{ "--pc": "var(--accent)" } as React.CSSProperties}
              onClick={() => setRep({ weekdays: rep.weekdays.includes(i) ? rep.weekdays.filter((x) => x !== i) : [...rep.weekdays, i].sort() })}>{w}</button>
          ))}
          <span className="muted">{rep.weekdays.length === 0 ? "puste = dzień tygodnia z daty" : ""}</span>
        </div>
      )}
      {rep && (
        <div className="kb-grid">
          <select className="kb-input" value={endMode} onChange={(e) => {
            const v = e.target.value;
            setRep(v === "none" ? { until: null, count: null } : v === "until" ? { until: C.addDays(ev.date, 7 * 15), count: null } : { until: null, count: 10 });
          }}>
            <option value="none">bez końca</option><option value="until">do dnia</option><option value="count">liczba wystąpień</option>
          </select>
          {endMode === "until" && <input className="kb-input" type="date" value={rep.until ?? ""} onChange={(e) => setRep({ until: C.isISO(e.target.value) ? e.target.value : null })} />}
          {endMode === "count" && <input className="kb-input sm" type="number" min={1} value={rep.count ?? 1} onChange={(e) => setRep({ count: Math.max(1, Math.floor(+e.target.value) || 1) })} />}
        </div>
      )}
      {rep && <div className="muted">{C.describeRepeat(rep)}{rep.exceptions.length ? ` · odwołane: ${rep.exceptions.map((d) => K.fmtDate(d)).join(", ")}` : ""}</div>}

      <div className="kb-field-label muted">przypisane zadania ({linked.length})</div>
      {linked.length === 0 && <div className="muted">przeciągnij kartę z panelu „plan” na to wydarzenie w kalendarzu albo wybierz je w edycji karty</div>}
      {linked.map((c) => (
        <div key={c.id} className="cal-ag-row task">
          <input type="checkbox" checked={c.done} onChange={(e) => updatePlan((p) => ({ ...p, board: K.patchCard(p.board, c.id, { done: e.target.checked }) }))} />
          <span className={c.done ? "muted" : ""}>{c.title}</span> <span className="muted">{c.link?.date ? K.fmtDate(c.link.date) : "cała seria"}</span>
          <button className="kb-x" title="odepnij od wydarzenia" onClick={() => updatePlan((p) => P.linkCard(p, c.id, null))}>×</button>
        </div>
      ))}

      <div className="kb-actions">
        {rep && <button className="kb-btn danger" onClick={() => { if (confirm === "one") { updatePlan((d) => P.skipOccurrence(d, eventId, day)); onClose(); } else setConfirm("one"); }}>
          {confirm === "one" ? `na pewno odwołaj ${K.fmtDate(day)}` : `odwołaj tylko ${K.fmtDate(day)}`}</button>}
        <button className="kb-btn danger" onClick={() => { if (confirm === "all") { updatePlan((d) => P.removeEvent(d, eventId)); onClose(); } else setConfirm("all"); }}>
          {confirm === "all" ? "na pewno usuń" : rep ? "usuń całą serię" : "usuń"}</button>
        <span className="spacer" />
        <button className="kb-btn primary" onClick={onClose}>gotowe</button>
      </div>
    </Modal>
  );
}

// ---------- typy wydarzeń ----------

function KindsDialog({ onClose }: { onClose: () => void }) {
  const { doc } = usePlan();
  const [name, setName] = useState("");
  const upd = (fn: (c: C.Calendar) => C.Calendar) => updatePlan((d) => ({ ...d, calendar: fn(d.calendar) }));
  return (
    <Modal title="Typy wydarzeń" onClose={onClose}>
      {doc.calendar.kinds.map((k) => (
        <div key={k.id} className="kb-row-inline">
          <input className="kb-input" value={k.name} spellCheck={false} onChange={(e) => upd((c) => C.patchKind(c, k.id, { name: e.target.value }))} />
          <span className="kb-swatches">
            {K.COLORS.map((c) => <button key={c} className={`kb-sw ${k.color === c ? "on" : ""}`} style={{ background: col(c) }} title={c} onClick={() => upd((cc) => C.patchKind(cc, k.id, { color: c }))} />)}
          </span>
          <button className="kb-x" disabled={doc.calendar.kinds.length <= 1} title="usuń typ (wydarzenia przejdą na pierwszy)" onClick={() => upd((c) => C.removeKind(c, k.id))}>×</button>
        </div>
      ))}
      <div className="kb-row-inline">
        <input className="kb-input" value={name} placeholder="nowy typ (np. Seminarium)" spellCheck={false} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { upd((c) => C.addKind(c, name)); setName(""); } }} />
        <button className="kb-btn" disabled={!name.trim()} onClick={() => { upd((c) => C.addKind(c, name)); setName(""); }}>dodaj</button>
      </div>
      <div className="kb-actions"><span className="spacer" /><button className="kb-btn primary" onClick={onClose}>gotowe</button></div>
    </Modal>
  );
}
