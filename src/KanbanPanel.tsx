import { createPortal } from "react-dom";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as K from "./kanban";
import * as C from "./calendar";
import * as P from "./plan";
import type { Board, Card, Color, Field, Lane } from "./kanban";
import { calTargetAt, overwritePlan, reloadPlan, setCalHover, updateBoard, updatePlan, usePlan } from "./planStore";

const col = (c: Color) => `var(--${c})`;
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

type ModalState = null | { kind: "card"; id: string } | { kind: "cats" } | { kind: "fields" } | { kind: "archive" };
type Drag = { id: string; x: number; y: number; w: number; title: string };
type Drop = { laneId: string; index: number };

/** Chipy kalendarza: dzień, na który zaplanowano kartę, albo wydarzenie, do którego należy. */
function planChips(doc: P.PlanDoc, c: Card): { key: string; text: string; tone?: "red" | "yellow" | "blue" }[] {
  if (c.scheduled) {
    const d = K.daysUntil(c.scheduled.date);
    const tone = !c.done && d !== null && d < 0 ? "red" : undefined;
    return [{ key: "sched", text: `📅 ${C.fmtDay(c.scheduled.date)}${c.scheduled.time ? " " + c.scheduled.time : ""}`, tone }];
  }
  if (c.link) {
    const ev = doc.calendar.events.find((e) => e.id === c.link!.eventId);
    if (ev) return [{ key: "link", text: `🔗 ${ev.title}${c.link.date ? " · " + K.fmtDate(c.link.date) : ""}`, tone: "blue" }];
  }
  return [];
}

/** Tekst chipów z wartościami własnych pól karty (puste pola pomijamy). */
function fieldChips(b: Board, c: Card): { key: string; text: string; tone?: "red" | "yellow" }[] {
  const out: { key: string; text: string; tone?: "red" | "yellow" }[] = [];
  for (const f of b.fields) {
    const v = c.values[f.id];
    if (v === undefined || v === "" || v === false) continue;
    if (f.type === "checkbox") out.push({ key: f.id, text: `✓ ${f.name}` });
    else if (f.type === "date") {
      const d = K.daysUntil(String(v));
      const tone = !c.done && d !== null ? (d < 0 ? "red" : d <= 2 ? "yellow" : undefined) : undefined;
      out.push({ key: f.id, text: `${f.name} ${K.fmtDate(String(v))}`, tone });
    } else out.push({ key: f.id, text: `${f.name}: ${v}` });
  }
  return out;
}

/**
 * Tablica kanban do planowania (jak wtyczka Kanban w Obsidianie): listy, karty przeciągane myszką,
 * kategorie (kolorowe etykiety) i własne pola. Dane zapisują się na bieżąco, osobno dla każdego panelu.
 * Klawisze: h/l listy, j/k karty, Enter edycja, a nowa karta, N nowa lista, H/L przenieś kartę,
 * J/K zmień kolejność, Spacja ukończ, x archiwizuj, / filtr, c kategorie, f pola, z archiwum.
 */
export function KanbanPanel({ id, active }: { id: string; active: boolean }) {
  void id;
  const { doc, status, error } = usePlan();
  const board = doc.board;
  const boardRef = useRef(board);
  boardRef.current = board;
  const docRef = useRef(doc);
  docRef.current = doc;
  const setBoard = useCallback((b: Board) => updateBoard(() => b), []);
  const upd = updateBoard;

  const [query, setQuery] = useState("");
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const filtering = query.trim() !== "" || catFilter !== null;
  const [sel, setSel] = useState({ lane: 0, card: 0 });
  const [modal, setModal] = useState<ModalState>(null);
  const [adding, setAdding] = useState<string | null>(null);   // id listy z otwartym polem "nowa karta"
  const [draft, setDraft] = useState("");
  const [addingLane, setAddingLane] = useState(false);
  const [laneDraft, setLaneDraft] = useState("");
  const [laneMenu, setLaneMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const boardElRef = useRef<HTMLDivElement>(null);

  const visibleCards = useCallback((l: Lane) => l.cards.map((cid) => board.cards[cid]).filter((c): c is Card => !!c && K.matches(board, c, query, catFilter)), [board, query, catFilter]);

  // zaznaczenie zawsze w granicach
  const laneIdx = Math.min(sel.lane, board.lanes.length - 1);
  const curLane = board.lanes[laneIdx];
  const curCards = curLane ? visibleCards(curLane) : [];
  const cardIdx = Math.min(sel.card, Math.max(0, curCards.length - 1));
  const curCard: Card | undefined = curCards[cardIdx];

  useEffect(() => {
    if (!active || !curCard) return;
    rootRef.current?.querySelector(`[data-card="${curCard.id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, curCard?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!confirm) return; const t = setTimeout(() => setConfirm(null), 3000); return () => clearTimeout(t); }, [confirm]);

  const focusCard = (cardId: string, b: Board = boardRef.current) => {
    const li = b.lanes.findIndex((l) => l.cards.includes(cardId));
    if (li >= 0) setSel({ lane: li, card: Math.max(0, b.lanes[li].cards.indexOf(cardId)) });
  };

  // ---------- przeciąganie kart (zdarzenia wskaźnika: HTML5 drag&drop nie działa w oknie Tauri z włączonym przeciąganiem plików) ----------
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const dropRef = useRef<Drop | null>(null);
  const suppressClick = useRef(false);

  const onCardDown = (e: React.PointerEvent, c: Card) => {
    if (e.button !== 0 || filtering || (e.target as HTMLElement).closest("button, input, a")) return;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, offX: e.clientX - rect.left, offY: e.clientY - rect.top, active: false };
    const move = (ev: PointerEvent) => {
      if (!start.active && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      start.active = true;
      setDrag({ id: c.id, x: ev.clientX - start.offX, y: ev.clientY - start.offY, w: rect.width, title: c.title });
      const calT = calTargetAt(ev.clientX, ev.clientY);
      setCalHover(calT);
      if (calT) { dropRef.current = null; setDrop(null); return; }
      const root = rootRef.current;
      if (!root) return;
      const bel = boardElRef.current;
      if (bel) {            // przewijanie tablicy przy krawędzi
        const br = bel.getBoundingClientRect();
        if (ev.clientX < br.left + 40) bel.scrollLeft -= 14; else if (ev.clientX > br.right - 40) bel.scrollLeft += 14;
      }
      const lanes = [...root.querySelectorAll<HTMLElement>("[data-lane]")];
      let best: HTMLElement | null = null, bestD = Infinity;
      for (const l of lanes) {
        const r = l.getBoundingClientRect();
        const d = ev.clientX < r.left ? r.left - ev.clientX : ev.clientX > r.right ? ev.clientX - r.right : 0;
        if (d < bestD) { bestD = d; best = l; }
      }
      if (!best) return;
      let index = 0;
      for (const ce of best.querySelectorAll<HTMLElement>("[data-card]")) {
        if (ce.dataset.card === c.id) continue;
        const r = ce.getBoundingClientRect();
        if (ev.clientY > r.top + r.height / 2) index++; else break;
      }
      const next = { laneId: best.dataset.lane!, index };
      dropRef.current = next;
      setDrop((d) => (d && d.laneId === next.laneId && d.index === next.index ? d : next));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (start.active) {
        suppressClick.current = true;
        setTimeout(() => { suppressClick.current = false; }, 0);
        const d = dropRef.current;
        const calT = ev.type === "pointerup" ? calTargetAt(ev.clientX, ev.clientY) : null;
        if (calT) {
          updatePlan((p) => (calT.kind === "day" ? P.scheduleCard(p, c.id, calT.day) : P.linkCard(p, c.id, calT.eventId, calT.day)));
        } else if (d) {
          const nb = K.moveCard(boardRef.current, c.id, d.laneId, d.index);
          setBoard(nb);
          focusCard(c.id, nb);
        }
      }
      dropRef.current = null;
      setCalHover(null);
      setDrag(null);
      setDrop(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const onCardClick = (c: Card) => {
    if (suppressClick.current) return;
    focusCard(c.id);
    setModal({ kind: "card", id: c.id });
  };

  // ---------- operacje ----------
  const commitCard = (laneId: string) => {
    const r = K.addCard(boardRef.current, laneId, draft);
    if (!r.id) return;
    setBoard(r.board);
    setDraft("");
  };
  const commitLane = () => {
    if (laneDraft.trim()) {
      const nb = K.addLane(boardRef.current, laneDraft);
      setBoard(nb);
      setSel({ lane: nb.lanes.length - 1, card: 0 });
    }
    setLaneDraft(""); setAddingLane(false);
  };
  const askConfirm = (what: string, run: () => void) => { if (confirm === what) { setConfirm(null); run(); } else setConfirm(what); };

  // ---------- klawiatura ----------
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (modal) { if (e.key === "Escape") { e.preventDefault(); setModal(null); } return; }
      if (isTyping(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
      const b = boardRef.current;
      const nLanes = b.lanes.length;
      const moveSel = (dl: number, dc: number) => {
        const li = Math.min(Math.max(laneIdx + dl, 0), nLanes - 1);
        const cards = visibleCards(b.lanes[li]);
        setSel({ lane: li, card: Math.min(Math.max((dl ? cardIdx : cardIdx + dc), 0), Math.max(0, cards.length - 1)) });
      };
      switch (e.key) {
        case "h": case "ArrowLeft": e.preventDefault(); moveSel(-1, 0); break;
        case "l": case "ArrowRight": e.preventDefault(); moveSel(1, 0); break;
        case "j": case "ArrowDown": e.preventDefault(); moveSel(0, 1); break;
        case "k": case "ArrowUp": e.preventDefault(); moveSel(0, -1); break;
        case "Enter": case "e": if (curCard) { e.preventDefault(); setModal({ kind: "card", id: curCard.id }); } break;
        case "a": if (curLane) { e.preventDefault(); setAdding(curLane.id); setDraft(""); } break;
        case "N": e.preventDefault(); setAddingLane(true); break;
        case " ": if (curCard) { e.preventDefault(); setBoard(K.patchCard(b, curCard.id, { done: !curCard.done })); } break;
        case "x": if (curCard) { e.preventDefault(); setBoard(K.archiveCard(b, curCard.id)); } break;
        case "H": case "L": if (curCard && !filtering) {
          e.preventDefault();
          const to = laneIdx + (e.key === "H" ? -1 : 1);
          if (to >= 0 && to < nLanes) {
            const at = Math.min(b.lanes[laneIdx].cards.indexOf(curCard.id), b.lanes[to].cards.length);
            const nb = K.moveCard(b, curCard.id, b.lanes[to].id, at);
            setBoard(nb); focusCard(curCard.id, nb);
          }
        } break;
        case "J": case "K": if (curCard && !filtering) {
          e.preventDefault();
          const i = b.lanes[laneIdx].cards.indexOf(curCard.id);
          const to = i + (e.key === "J" ? 1 : -1);
          if (to >= 0 && to < b.lanes[laneIdx].cards.length) {
            const nb = K.moveCard(b, curCard.id, b.lanes[laneIdx].id, to);
            setBoard(nb); focusCard(curCard.id, nb);
          }
        } break;
        case "/": e.preventDefault(); filterRef.current?.focus(); break;
        case "c": e.preventDefault(); setModal({ kind: "cats" }); break;
        case "f": e.preventDefault(); setModal({ kind: "fields" }); break;
        case "z": e.preventDefault(); setModal({ kind: "archive" }); break;
        case "Escape": if (filtering) { e.preventDefault(); setQuery(""); setCatFilter(null); } setLaneMenu(null); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, modal, laneIdx, cardIdx, curCard, curLane, filtering, visibleCards]);

  const catById = useMemo(() => new Map(board.categories.map((c) => [c.id, c])), [board.categories]);
  const total = Object.keys(board.cards).length;

  return (
    <div className="kanban" ref={rootRef} onContextMenu={(e) => e.preventDefault()} onPointerDown={(e) => { if (!(e.target as HTMLElement).closest(".kb-menu, .kb-menu-btn")) setLaneMenu(null); }}>
      <div className="kb-bar">
        <input ref={filterRef} className="kb-filter" placeholder="filtruj kartę… (/)" value={query} spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); setCatFilter(null); (e.target as HTMLElement).blur(); } }} />
        <div className="kb-catfilter">
          {board.categories.map((c) => (
            <button key={c.id} className={`kb-pill ${catFilter === c.id ? "on" : ""}`} style={{ "--pc": col(c.color) } as React.CSSProperties}
              title="filtruj po kategorii" onClick={() => setCatFilter(catFilter === c.id ? null : c.id)}>{c.name}</button>
          ))}
        </div>
        <span className="spacer" />
        <button className="kb-btn" title="nowa lista (N)" onClick={() => setAddingLane(true)}>+ lista</button>
        <button className="kb-btn" title="kategorie (c)" onClick={() => setModal({ kind: "cats" })}>kategorie</button>
        <button className="kb-btn" title="własne pola (f)" onClick={() => setModal({ kind: "fields" })}>pola</button>
        <button className="kb-btn" title="archiwum (z)" onClick={() => setModal({ kind: "archive" })}>archiwum{board.archive.length ? ` ${board.archive.length}` : ""}</button>
      </div>
      {filtering && <div className="kb-hint muted">filtr aktywny: przeciąganie i zmiana kolejności wyłączone · Esc czyści</div>}

      <div className="kb-board" ref={boardElRef}>
        {board.lanes.map((l, li) => {
          const cards = visibleCards(l);
          const over = l.limit !== null && l.cards.length > l.limit;
          let n = 0;
          return (
            <div key={l.id} data-lane={l.id} className={`kb-lane ${l.collapsed ? "collapsed" : ""} ${drop?.laneId === l.id ? "over" : ""}`}
              style={{ "--lc": col(l.color) } as React.CSSProperties}>
              <div className="kb-lane-head">
                {renaming === l.id ? (
                  <input className="kb-input" autoFocus defaultValue={l.title} onFocus={(e) => e.target.select()}
                    onBlur={(e) => { upd((b) => K.patchLane(b, l.id, { title: e.target.value.trim() || l.title })); setRenaming(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLElement).blur(); if (e.key === "Escape") setRenaming(null); }} />
                ) : (
                  <button className="kb-lane-title" title="dwuklik: zmień nazwę · klik: zwiń/rozwiń"
                    onDoubleClick={() => setRenaming(l.id)} onClick={() => upd((b) => K.patchLane(b, l.id, { collapsed: !l.collapsed }))}>{l.title}</button>
                )}
                <span className={`kb-count ${over ? "red" : "muted"}`}>{l.cards.length}{l.limit !== null ? `/${l.limit}` : ""}</span>
                <button className="kb-menu-btn" title="opcje listy" onClick={() => setLaneMenu(laneMenu === l.id ? null : l.id)}>⋯</button>
                {laneMenu === l.id && (
                  <div className="kb-menu">
                    <div className="kb-swatches">
                      {K.COLORS.map((c) => (
                        <button key={c} className={`kb-sw ${l.color === c ? "on" : ""}`} style={{ background: col(c) }} title={c}
                          onClick={() => upd((b) => K.patchLane(b, l.id, { color: c }))} />
                      ))}
                    </div>
                    <label className="kb-row-inline">limit kart
                      <input type="number" min={0} className="kb-input sm" defaultValue={l.limit ?? ""} placeholder="brak"
                        onBlur={(e) => upd((b) => K.patchLane(b, l.id, { limit: +e.target.value > 0 ? Math.floor(+e.target.value) : null }))} />
                    </label>
                    <div className="kb-menu-row">
                      <button className="kb-btn" disabled={li === 0} onClick={() => upd((b) => K.moveLane(b, l.id, -1))}>← w lewo</button>
                      <button className="kb-btn" disabled={li === board.lanes.length - 1} onClick={() => upd((b) => K.moveLane(b, l.id, 1))}>w prawo →</button>
                    </div>
                    <button className="kb-btn wide" onClick={() => setRenaming(l.id)}>zmień nazwę</button>
                    <button className="kb-btn wide" disabled={l.cards.length === 0} onClick={() => askConfirm(`arch-${l.id}`, () => upd((b) => K.archiveLaneCards(b, l.id)))}>
                      {confirm === `arch-${l.id}` ? "na pewno? przenieś do archiwum" : "archiwizuj wszystkie karty"}</button>
                    <button className="kb-btn wide danger" disabled={board.lanes.length <= 1} onClick={() => askConfirm(`del-${l.id}`, () => { upd((b) => K.removeLane(b, l.id)); setLaneMenu(null); })}>
                      {confirm === `del-${l.id}` ? "na pewno? karty trafią do archiwum" : "usuń listę"}</button>
                  </div>
                )}
              </div>
              {!l.collapsed && (
                <>
                  <div className="kb-cards">
                    {cards.map((c) => {
                      const isDragged = drag?.id === c.id;
                      const slot = !isDragged ? n++ : -1;
                      const chips = [...planChips(doc, c), ...fieldChips(board, c)];
                      const selected = active && li === laneIdx && curCard?.id === c.id;
                      return (
                        <Fragment key={c.id}>
                          {drop?.laneId === l.id && !isDragged && drop.index === slot && <div className="kb-drop" />}
                          <div data-card={c.id} className={`kb-card ${selected ? "sel" : ""} ${c.done ? "done" : ""} ${isDragged ? "ghosted" : ""}`}
                            onPointerDown={(e) => onCardDown(e, c)} onClick={() => onCardClick(c)}>
                            {c.categories.length > 0 && (
                              <div className="kb-cats">
                                {c.categories.map((cid) => catById.get(cid)).filter(Boolean).map((cat) => (
                                  <span key={cat!.id} className="kb-pill sm" style={{ "--pc": col(cat!.color) } as React.CSSProperties}>{cat!.name}</span>
                                ))}
                              </div>
                            )}
                            <div className="kb-title">{c.done && <span className="green">✓ </span>}{c.title}{c.notes && <span className="muted" title="ma notatkę"> ≡</span>}</div>
                            {chips.length > 0 && (
                              <div className="kb-chips">
                                {chips.map((ch) => <span key={ch.key} className={`kb-chip ${ch.tone ?? ""}`}>{ch.text}</span>)}
                              </div>
                            )}
                          </div>
                        </Fragment>
                      );
                    })}
                    {drop?.laneId === l.id && drop.index === n && <div className="kb-drop" />}
                    {cards.length === 0 && !drop && <div className="kb-empty muted">{filtering ? "brak pasujących kart" : "pusto"}</div>}
                  </div>
                  {adding === l.id ? (
                    <div className="kb-add">
                      <input className="kb-input" autoFocus placeholder="tytuł karty, Enter dodaje, Esc kończy" value={draft} spellCheck={false}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => { if (!draft.trim()) setAdding(null); }}
                        onKeyDown={(e) => { if (e.key === "Enter") commitCard(l.id); if (e.key === "Escape") { setAdding(null); setDraft(""); } }} />
                    </div>
                  ) : (
                    <button className="kb-addbtn" onClick={() => { setAdding(l.id); setDraft(""); }}>+ dodaj kartę</button>
                  )}
                </>
              )}
            </div>
          );
        })}
        <div className="kb-lane kb-newlane">
          {addingLane ? (
            <input className="kb-input" autoFocus placeholder="nazwa listy" value={laneDraft} spellCheck={false}
              onChange={(e) => setLaneDraft(e.target.value)} onBlur={commitLane}
              onKeyDown={(e) => { if (e.key === "Enter") commitLane(); if (e.key === "Escape") { setLaneDraft(""); setAddingLane(false); } }} />
          ) : (
            <button className="kb-addbtn" onClick={() => setAddingLane(true)}>+ nowa lista</button>
          )}
        </div>
      </div>
      {status === "error" && error && (
        <div className="plan-error">
          <span>{error}</span>
          <button className="kb-btn" onClick={() => void reloadPlan()}>wczytaj z pliku</button>
          <button className="kb-btn danger" onClick={() => overwritePlan()}>nadpisz plik tym, co widzę</button>
        </div>
      )}
      <div className="kb-foot muted">{total} kart · a nowa · Enter edytuj · Spacja ukończ · HJKL przenieś · x archiwizuj · / filtr</div>

      {drag && <div className="kb-ghost" style={{ left: drag.x, top: drag.y, width: drag.w }}>{drag.title}</div>}

      {modal?.kind === "card" && board.cards[modal.id] && (
        <CardEditor board={board} cardId={modal.id} onBoard={setBoard} onClose={() => setModal(null)} />
      )}
      {modal?.kind === "cats" && <CategoriesModal board={board} onBoard={setBoard} onClose={() => setModal(null)} />}
      {modal?.kind === "fields" && <FieldsModal board={board} onBoard={setBoard} onClose={() => setModal(null)} />}
      {modal?.kind === "archive" && <ArchiveModal board={board} onBoard={setBoard} onClose={() => setModal(null)} />}
    </div>
  );
}

// ---------- okna dialogowe w panelu ----------

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  // portal do body: okno ma się pokazać nad całym ekranem, a nie być przycięte do małego panelu
  return createPortal(
    <div className="kb-modal" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`kb-dialog ${wide ? "wide" : ""}`} role="dialog">
        <div className="kb-dialog-head"><span>{title}</span><button className="kb-x" title="zamknij (Esc)" onClick={onClose}>×</button></div>
        <div className="kb-dialog-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

type Props = { board: Board; onBoard: (b: Board) => void; onClose: () => void };

function CardEditor({ board, cardId, onBoard, onClose }: Props & { cardId: string }) {
  const card = board.cards[cardId];
  const [confirmDel, setConfirmDel] = useState(false);
  const laneId = board.lanes.find((l) => l.cards.includes(cardId))?.id ?? "";
  const set = (patch: Partial<Card>) => onBoard(K.patchCard(board, cardId, patch));
  return (
    <Modal title="Karta" onClose={onClose}>
      <input className="kb-input big" autoFocus value={card.title} spellCheck={false} placeholder="tytuł"
        onChange={(e) => set({ title: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") onClose(); }} />
      <textarea className="kb-input notes" value={card.notes} placeholder="notatki (opis, kroki, linki)…" spellCheck={false}
        onChange={(e) => set({ notes: e.target.value })} />
      <div className="kb-field-label muted">kategorie</div>
      <div className="kb-cats">
        {board.categories.length === 0 && <span className="muted">brak kategorii (dodaj w „kategorie”)</span>}
        {board.categories.map((c) => (
          <button key={c.id} className={`kb-pill ${card.categories.includes(c.id) ? "on" : ""}`} style={{ "--pc": col(c.color) } as React.CSSProperties}
            onClick={() => onBoard(K.toggleCategory(board, cardId, c.id))}>{c.name}</button>
        ))}
      </div>
      {board.fields.map((f) => <FieldInput key={f.id} field={f} value={card.values[f.id]} onChange={(v) => onBoard(K.setValue(board, cardId, f.id, v))} />)}
      <ScheduleSection card={card} />
      <div className="kb-grid">
        <label className="kb-row-inline">lista
          <select className="kb-input" value={laneId} onChange={(e) => onBoard(K.moveCard(board, cardId, e.target.value, 9999))}>
            {board.lanes.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
          </select>
        </label>
        <label className="kb-row-inline"><input type="checkbox" checked={card.done} onChange={(e) => set({ done: e.target.checked })} /> ukończone</label>
      </div>
      <div className="kb-actions">
        <button className="kb-btn" onClick={() => { onBoard(K.archiveCard(board, cardId)); onClose(); }}>archiwizuj</button>
        <button className="kb-btn danger" onClick={() => { if (confirmDel) { onBoard(K.deleteCard(board, cardId)); onClose(); } else setConfirmDel(true); }}>
          {confirmDel ? "na pewno usuń" : "usuń"}</button>
        <span className="spacer" />
        <button className="kb-btn primary" onClick={onClose}>gotowe</button>
      </div>
    </Modal>
  );
}

/** Planowanie karty w kalendarzu: konkretny dzień (z godziną) albo wydarzenie z wybranym wystąpieniem. */
function ScheduleSection({ card }: { card: Card }) {
  const { doc } = usePlan();
  const events = doc.calendar.events;
  const link = card.link;
  const ev = link ? events.find((e) => e.id === link.eventId) : undefined;
  const occ = useMemo(() => {
    if (!ev) return [] as string[];
    const from = C.todayISO();
    const list = C.occurrences(ev, from, C.addDays(from, 200)).slice(0, 40);
    if (link?.date && !list.includes(link.date)) list.unshift(link.date);
    return list;
  }, [ev, link?.date]);
  return (
    <>
      <div className="kb-field-label muted">kalendarz</div>
      <div className="kb-grid">
        <label className="kb-row-inline">dzień
          <span className="kb-date">
            <input className="kb-input" type="date" value={card.scheduled?.date ?? ""}
              onChange={(e) => updatePlan((p) => P.scheduleCard(p, card.id, e.target.value || null, card.scheduled?.time ?? null))} />
            {card.scheduled && <button className="kb-x" title="zdejmij z kalendarza" onClick={() => updatePlan((p) => P.scheduleCard(p, card.id, null))}>×</button>}
          </span>
        </label>
        <label className="kb-row-inline">godzina
          <input className="kb-input" type="time" value={card.scheduled?.time ?? ""} disabled={!card.scheduled}
            onChange={(e) => updatePlan((p) => P.scheduleCard(p, card.id, card.scheduled!.date, e.target.value || null))} />
        </label>
      </div>
      <div className="kb-grid">
        <label className="kb-row-inline">wydarzenie
          <select className="kb-input" value={link?.eventId ?? ""} onChange={(e) => updatePlan((p) => P.linkCard(p, card.id, e.target.value || null, null))}>
            <option value="">—</option>
            {events.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
          </select>
        </label>
        <label className="kb-row-inline">termin
          <select className="kb-input" value={link?.date ?? ""} disabled={!ev}
            onChange={(e) => updatePlan((p) => P.linkCard(p, card.id, link!.eventId, e.target.value || null))}>
            <option value="">cała seria</option>
            {occ.map((d) => <option key={d} value={d}>{C.fmtDay(d, true)}</option>)}
          </select>
        </label>
      </div>
    </>
  );
}

function FieldInput({ field, value, onChange }: { field: Field; value: K.Value | undefined; onChange: (v: K.Value | null) => void }) {
  const v = value ?? "";
  return (
    <label className="kb-row-inline field">
      <span className="kb-field-label muted">{field.name}</span>
      {field.type === "checkbox" ? (
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      ) : field.type === "select" ? (
        <select className="kb-input" value={String(v)} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : field.type === "number" ? (
        <input className="kb-input" type="number" value={String(v)} onChange={(e) => onChange(e.target.value === "" ? null : +e.target.value)} />
      ) : field.type === "date" ? (
        <span className="kb-date">
          <input className="kb-input" type="date" value={String(v)} onChange={(e) => onChange(e.target.value)} />
          {value !== undefined && <button className="kb-x" title="wyczyść" onClick={(e) => { e.preventDefault(); onChange(null); }}>×</button>}
        </span>
      ) : (
        <input className="kb-input" value={String(v)} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

function CategoriesModal({ board, onBoard, onClose }: Props) {
  const [name, setName] = useState("");
  const add = () => { if (name.trim()) { onBoard(K.addCategory(board, name)); setName(""); } };
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const used = (id: string) => Object.values(board.cards).filter((c) => c.categories.includes(id)).length;
  return (
    <Modal title="Kategorie" onClose={onClose}>
      <p className="muted">Kolorowe etykiety na kartach. Klik w kropkę zmienia kolor.</p>
      {board.categories.map((c) => (
        <div key={c.id} className="kb-manage-row">
          <button className="kb-dot" style={{ background: col(c.color) }} title="zmień kolor" onClick={() => onBoard(K.patchCategory(board, c.id, { color: K.cycleColor(c.color) }))} />
          <input className="kb-input" value={c.name} spellCheck={false} onChange={(e) => onBoard(K.patchCategory(board, c.id, { name: e.target.value }))} />
          <span className="muted">{used(c.id)} kart</span>
          <button className="kb-btn danger" onClick={() => { if (confirmId === c.id) { onBoard(K.removeCategory(board, c.id)); setConfirmId(null); } else setConfirmId(c.id); }}>
            {confirmId === c.id ? "na pewno" : "usuń"}</button>
        </div>
      ))}
      <div className="kb-manage-row">
        <input className="kb-input" placeholder="nowa kategoria" value={name} spellCheck={false} autoFocus
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <button className="kb-btn primary" onClick={add}>dodaj</button>
      </div>
    </Modal>
  );
}

function FieldsModal({ board, onBoard, onClose }: Props) {
  const [name, setName] = useState("");
  const [type, setType] = useState<K.FieldType>("text");
  const add = () => { if (name.trim()) { onBoard(K.addField(board, name, type)); setName(""); } };
  const [confirmId, setConfirmId] = useState<string | null>(null);
  return (
    <Modal title="Własne pola" onClose={onClose} wide>
      <p className="muted">Pola pojawiają się w każdej karcie i jako chipy na kartach. Dla listy wyboru wpisz opcje po przecinku.</p>
      {board.fields.map((f) => (
        <div key={f.id} className="kb-manage-row">
          <input className="kb-input" value={f.name} spellCheck={false} onChange={(e) => onBoard(K.patchField(board, f.id, { name: e.target.value }))} />
          <select className="kb-input sm" value={f.type} onChange={(e) => onBoard(K.patchField(board, f.id, { type: e.target.value as K.FieldType }))}>
            {K.FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          {f.type === "select" && (
            <input className="kb-input" key={f.id + f.options.join()} defaultValue={f.options.join(", ")} placeholder="opcje, po przecinku" spellCheck={false}
              onBlur={(e) => onBoard(K.patchField(board, f.id, { options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }))} />
          )}
          <button className="kb-btn danger" onClick={() => { if (confirmId === f.id) { onBoard(K.removeField(board, f.id)); setConfirmId(null); } else setConfirmId(f.id); }}>
            {confirmId === f.id ? "na pewno" : "usuń"}</button>
        </div>
      ))}
      <div className="kb-manage-row">
        <input className="kb-input" placeholder="nowe pole" value={name} spellCheck={false} autoFocus
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <select className="kb-input sm" value={type} onChange={(e) => setType(e.target.value as K.FieldType)}>
          {K.FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <button className="kb-btn primary" onClick={add}>dodaj</button>
      </div>
    </Modal>
  );
}

function ArchiveModal({ board, onBoard, onClose }: Props) {
  return (
    <Modal title={`Archiwum (${board.archive.length})`} onClose={onClose}>
      {board.archive.length === 0 && <p className="muted">Archiwum jest puste. Zarchiwizowane karty można stąd przywrócić.</p>}
      {board.archive.map((c) => (
        <div key={c.id} className="kb-manage-row">
          <span className="kb-arch-title">{c.title}</span>
          <button className="kb-btn" onClick={() => onBoard(K.restoreCard(board, c.id))}>przywróć</button>
          <button className="kb-btn danger" onClick={() => onBoard(K.deleteArchived(board, c.id))}>usuń</button>
        </div>
      ))}
    </Modal>
  );
}
