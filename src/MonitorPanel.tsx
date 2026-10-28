import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { formatSize, systemStats, type Stats } from "./api";
import { useSettings } from "./settings";

const HISTORY = 60;      // tyle próbek na wykresie (1 na sekundę)

type History = { cpu: number[]; mem: number[]; gpu: number[]; rx: number[]; tx: number[] };
const empty = (): History => ({ cpu: [], mem: [], gpu: [], rx: [], tx: [] });
const push = (a: number[], v: number) => [...a.slice(-(HISTORY - 1)), v];
const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);

const rate = (b: number) => `${formatSize(b)}/s`;
const uptime = (s: number) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
};

/** Wykres powierzchniowy historii, jak w btop. max = górna granica osi (domyślnie 100%). */
function Graph({ data, color, max = 100 }: { data: number[]; color: string; max?: number }) {
  const top = Math.max(max, 1);
  const pts = data.map((v, i) => {
    const x = HISTORY - data.length + i;
    const y = 100 - Math.min(v / top, 1) * 100;
    return `${x},${y.toFixed(1)}`;
  });
  const first = HISTORY - data.length;
  return (
    <svg className="mon-graph" viewBox={`0 0 ${HISTORY - 1} 100`} preserveAspectRatio="none">
      {[25, 50, 75].map((y) => <line key={y} x1="0" x2={HISTORY} y1={y} y2={y} className="mon-grid" />)}
      {pts.length > 1 && (
        <>
          <polygon points={`${first},100 ${pts.join(" ")} ${HISTORY - 1},100`} fill={color} fillOpacity="0.18" />
          <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  );
}

/** Pasek procentowy: zielony → żółty → czerwony, jak w btop. */
function Bar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  const color = v >= 85 ? "var(--red)" : v >= 60 ? "var(--yellow)" : "var(--green)";
  return (
    <div className="mon-bar">
      <div className="mon-bar-fill" style={{ width: `${v}%`, background: color }} />
    </div>
  );
}

type SectionId = "cpu" | "mem" | "gpu" | "net" | "disks";
const ORDER: SectionId[] = ["cpu", "mem", "gpu", "net", "disks"];
const NAMES: Record<SectionId, string> = { cpu: "cpu", mem: "pamięć", gpu: "gpu", net: "sieć", disks: "dyski" };

const COL_MIN = 280;   // minimalna szerokość kolumny sekcji
const GAP = 8;
let lineH = 17;        // wysokość jednej linii tekstu (zależy od rozmiaru fontu w ustawieniach)
const BOX = 14;        // ramka + padding sekcji
const GRAPH = 55;

type Settings = { primary: SectionId; hidden: SectionId[] };
const loadSettings = (key: string): Settings => {
  try {
    const s = JSON.parse(localStorage.getItem(key) ?? "");
    if (ORDER.includes(s.primary) && Array.isArray(s.hidden)) return s;
  } catch { /* domyślne */ }
  return { primary: "cpu", hidden: [] };
};

/** Szacowana wysokość sekcji w pikselach (potrzebna, żeby wiedzieć, co się zmieści). */
function sectionHeight(id: SectionId, s: Stats, colW: number): number {
  switch (id) {
    case "cpu": {
      const perRow = Math.max(1, Math.floor((colW - 16 + 10) / 130));
      return BOX + lineH + GRAPH + Math.ceil(s.cpus.length / perRow) * lineH + lineH;
    }
    case "mem": return BOX + lineH + GRAPH + lineH * (s.swapTotal > 0 ? 2 : 1);
    case "gpu": return BOX + lineH + GRAPH + (s.gpu ? lineH : 0);
    case "net": return BOX + lineH + GRAPH;
    case "disks": return BOX + lineH + s.disks.length * lineH;
  }
}

/**
 * Wybiera sekcje, które się zmieszczą: bierze je po kolei według ważności
 * (najpierw wybrana prawym klikiem, potem reszta) i układa w kolumny,
 * zawsze dokładając do najniższej. Gdy coś się nie mieści, odpada od końca.
 */
function pack(ids: SectionId[], s: Stats, w: number, h: number): SectionId[][] {
  const cols = Math.max(1, Math.floor((w + GAP) / (COL_MIN + GAP)));
  const colW = (w - GAP * (cols - 1)) / cols;
  for (let k = ids.length; k >= 1; k--) {
    const out: SectionId[][] = Array.from({ length: cols }, () => []);
    const heights = new Array(cols).fill(0);
    for (const id of ids.slice(0, k)) {
      const c = heights.indexOf(Math.min(...heights));
      heights[c] += (out[c].length ? GAP : 0) + sectionHeight(id, s, colW);
      out[c].push(id);
    }
    if (k === 1 || Math.max(...heights) <= h) return out.filter((c) => c.length);
  }
  return [[ids[0]]];
}

export function MonitorPanel({ id }: { id: string; active: boolean }) {
  const storageKey = `wikexp.monitor.${id}`;
  const { monitorRefresh, fontSize } = useSettings().settings;
  lineH = Math.round(fontSize * 1.3);
  const [stats, setStats] = useState<Stats | null>(null);
  const [hist, setHist] = useState<History>(empty);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(() => loadSettings(storageKey));
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* ignoruj */ }
  }, [storageKey, settings]);

  // rozmiar panelu → ile sekcji się zmieści
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      systemStats()
        .then((s) => {
          if (!alive) return;
          setStats(s);
          setError(null);
          setHist((h) => ({
            cpu: push(h.cpu, s.cpuTotal),
            mem: push(h.mem, pct(s.memUsed, s.memTotal)),
            gpu: push(h.gpu, s.gpu?.util ?? 0),
            rx: push(h.rx, s.netRx),
            tx: push(h.tx, s.netTx),
          }));
        })
        .catch((e) => alive && setError(String(e)));
    tick();
    const t = setInterval(tick, monitorRefresh);
    return () => { alive = false; clearInterval(t); };
  }, [monitorRefresh]);

  // menu: zamknij kliknięciem obok / Esc, trzymaj w granicach okna
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", onKey, true); };
  }, [menu]);
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(menu.x, innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(menu.y, innerHeight - r.height - 4))}px`;
  }, [menu]);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const setPrimary = (sid: SectionId) =>
    setSettings((s) => ({ primary: sid, hidden: s.hidden.filter((x) => x !== sid) }));
  const toggleHidden = (sid: SectionId) =>
    setSettings((s) => {
      const hidden = s.hidden.includes(sid) ? s.hidden.filter((x) => x !== sid) : [...s.hidden, sid];
      if (hidden.length === ORDER.length) return s;            // zawsze coś musi być widać
      const primary = hidden.includes(s.primary) ? ORDER.find((x) => !hidden.includes(x))! : s.primary;
      return { primary, hidden };
    });

  let content: ReactNode;
  if (error) content = <div className="row red">{error}</div>;
  else if (!stats) content = <div className="row muted">wczytywanie…</div>;
  else {
    const priority = [settings.primary, ...ORDER.filter((x) => x !== settings.primary)]
      .filter((x) => !settings.hidden.includes(x));
    // 14 px zostaje na linię "+N ukryte"
    const columns = size.w > 0 ? pack(priority, stats, size.w, size.h - 14) : [[priority[0]]];
    const shown = columns.flat().length;
    const memPct = pct(stats.memUsed, stats.memTotal);
    const netMax = Math.max(...hist.rx, ...hist.tx, 1024);
    const g = stats.gpu;

    const sections: Record<SectionId, () => ReactNode> = {
      cpu: () => (
        <section className="mon-box" key="cpu">
          <div className="mon-head">
            <span className="accent">cpu</span>
            <span className="muted ellipsis">{stats.cpuName}</span>
            <span className="spacer" />
            <span>{stats.cpuTotal.toFixed(0)}%</span>
          </div>
          <Graph data={hist.cpu} color="var(--accent)" />
          <div className="mon-cores">
            {stats.cpus.map((c, i) => (
              <div key={i} className="mon-core">
                <span className="mon-core-id">{i}</span>
                <Bar value={c} />
                <span className="mon-num">{c.toFixed(0)}%</span>
              </div>
            ))}
          </div>
          <div className="muted">uptime {uptime(stats.uptime)}</div>
        </section>
      ),
      mem: () => (
        <section className="mon-box" key="mem">
          <div className="mon-head">
            <span style={{ color: "var(--blue)" }}>pamięć</span>
            <span className="spacer" />
            <span>{formatSize(stats.memUsed)} / {formatSize(stats.memTotal)}</span>
          </div>
          <Graph data={hist.mem} color="var(--blue)" />
          <div className="mon-line"><span className="mon-label">ram</span><Bar value={memPct} /><span className="mon-num">{memPct.toFixed(0)}%</span></div>
          {stats.swapTotal > 0 && (
            <div className="mon-line">
              <span className="mon-label">swap</span>
              <Bar value={pct(stats.swapUsed, stats.swapTotal)} />
              <span className="mon-num">{pct(stats.swapUsed, stats.swapTotal).toFixed(0)}%</span>
            </div>
          )}
        </section>
      ),
      gpu: () => (
        <section className="mon-box" key="gpu">
          <div className="mon-head">
            <span className="green">gpu</span>
            <span className="muted ellipsis">{g ? g.name : "szukam karty…"}</span>
            <span className="spacer" />
            {g && <span>{g.util.toFixed(0)}%{g.temp != null ? ` · ${g.temp.toFixed(0)}°C` : ""}</span>}
          </div>
          <Graph data={hist.gpu} color="var(--green)" />
          {g && (
            <div className="mon-line">
              <span className="mon-label">vram</span>
              {g.vramTotal ? <Bar value={pct(g.vramUsed, g.vramTotal)} /> : <span className="spacer" />}
              <span className="mon-num-wide">{formatSize(g.vramUsed)}{g.vramTotal ? ` / ${formatSize(g.vramTotal)}` : ""}</span>
            </div>
          )}
        </section>
      ),
      net: () => (
        <section className="mon-box" key="net">
          <div className="mon-head">
            <span style={{ color: "var(--blue)" }}>sieć</span>
            <span className="spacer" />
            <span className="mon-rx">↓ {rate(stats.netRx)}</span>
            <span className="mon-tx">↑ {rate(stats.netTx)}</span>
          </div>
          <div className="mon-net">
            <Graph data={hist.rx} color="var(--cyan)" max={netMax} />
            <Graph data={hist.tx} color="var(--pink)" max={netMax} />
          </div>
        </section>
      ),
      disks: () => (
        <section className="mon-box" key="disks">
          <div className="mon-head"><span className="yellow">dyski</span></div>
          {stats.disks.map((d) => (
            <div key={d.mount} className="mon-line">
              <span className="mon-label">{d.mount}</span>
              <Bar value={pct(d.used, d.total)} />
              <span className="mon-num-wide">{formatSize(d.used)} / {formatSize(d.total)}</span>
            </div>
          ))}
        </section>
      ),
    };

    content = (
      <>
        <div className="mon-cols">
          {columns.map((col, i) => (
            <div key={i} className="mon-col">{col.map((sid) => sections[sid]())}</div>
          ))}
        </div>
        {shown < priority.length && (
          <div className="mon-more muted">+{priority.length - shown} ukryte · prawy klik</div>
        )}
      </>
    );
  }

  return (
    <div className="mon" ref={rootRef} onContextMenu={onContextMenu}>
      {content}
      {menu && (
        <div ref={menuRef} className="ctx-menu" style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          <div className="ctx-head">najważniejsza (zostaje w małym oknie)</div>
          {ORDER.filter((x) => !settings.hidden.includes(x)).map((sid) => (
            <div key={sid} className="ctx-item" onClick={() => { setPrimary(sid); setMenu(null); }}>
              <span className={settings.primary === sid ? "accent" : "muted"}>{settings.primary === sid ? "●" : "○"}</span> {NAMES[sid]}
            </div>
          ))}
          <div className="ctx-head">widoczne sekcje</div>
          {ORDER.map((sid) => (
            <div key={sid} className="ctx-item" onClick={() => toggleHidden(sid)}>
              <span className={settings.hidden.includes(sid) ? "muted" : "green"}>{settings.hidden.includes(sid) ? "☐" : "☑"}</span> {NAMES[sid]}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
