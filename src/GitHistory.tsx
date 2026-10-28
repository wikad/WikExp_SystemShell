import { useEffect, useMemo, useState } from "react";
import { gitCheckout, gitLog, gitShow, type GitCommit } from "./api";
import { layoutGraph, type GraphRow } from "./gitGraph";

const LANE_W = 12;   // szerokość toru w pikselach
const ROW_H = 22;    // wysokość wiersza
// kolory torów: zmienne motywu, więc graf zmienia się razem z motywem
const COLORS = ["var(--accent)", "var(--blue)", "var(--green)", "var(--yellow)", "var(--pink)", "var(--cyan)", "var(--orange)", "var(--red)"];
const color = (i: number) => COLORS[i % COLORS.length];
const x = (i: number) => i * LANE_W + LANE_W / 2;

function GraphCell({ row, width, merge }: { row: GraphRow; width: number; merge: boolean }) {
  const mid = ROW_H / 2;
  // linia między kolumnami: prosta albo łagodny łuk
  const path = (a: number, b: number, y1: number, y2: number) =>
    a === b ? `M${x(a)} ${y1} L${x(b)} ${y2}` : `M${x(a)} ${y1} C${x(a)} ${(y1 + y2) / 2} ${x(b)} ${(y1 + y2) / 2} ${x(b)} ${y2}`;
  return (
    <svg width={width * LANE_W} height={ROW_H} className="gh-graph">
      {row.top.map(([a, b], i) => <path key={`t${i}`} d={path(a, b, 0, mid)} stroke={color(a)} />)}
      {row.bottom.map(([a, b], i) => <path key={`b${i}`} d={path(a, b, mid, ROW_H)} stroke={color(b)} />)}
      <circle cx={x(row.col)} cy={mid} r={merge ? 3 : 4} fill={merge ? "var(--base)" : color(row.col)} stroke={color(row.col)} strokeWidth={merge ? 2 : 0} />
    </svg>
  );
}

/** Historia repozytorium jako graf branchy; klik w commit = szczegóły, klik w branch = checkout. */
export function GitHistory({ cwd, onChanged }: { cwd: string; onChanged: () => void }) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [details, setDetails] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => gitLog(cwd, 300).then(setCommits).catch((e) => setMsg(String(e)));
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (sel) gitShow(cwd, sel).then(setDetails).catch((e) => setDetails(String(e))); else setDetails(""); }, [cwd, sel]);

  const { rows, maxWidth } = useMemo(() => layoutGraph(commits), [commits]);
  const width = Math.min(maxWidth, 12); // bardzo szerokie grafy przycinamy

  const checkout = (ref: string) => {
    const name = ref.replace(/^HEAD -> /, "").replace(/^origin\//, "");
    gitCheckout(cwd, name).then(() => { setMsg(`przełączono na ${name}`); load(); onChanged(); }).catch((e) => setMsg(String(e)));
  };

  if (!commits.length) return <div className="row muted">{msg ?? "brak commitów"}</div>;

  return (
    <div className="gh">
      {msg && <div className="row yellow" onClick={() => setMsg(null)}>{msg}</div>}
      <div className="gh-list">
        {commits.map((c, i) => (
          <div key={c.hash} className={`gh-row ${sel === c.hash ? "sel" : ""}`} onClick={() => setSel(sel === c.hash ? null : c.hash)} style={{ height: ROW_H }}>
            <GraphCell row={rows[i]} width={width} merge={c.parents.length > 1} />
            <span className="gh-refs">
              {c.refs.filter((r) => !r.startsWith("tag: ") || true).map((r) => {
                const isHead = r.startsWith("HEAD");
                const isTag = r.startsWith("tag: ");
                const isRemote = !isHead && !isTag && r.includes("/");
                return (
                  <button key={r} className={`gh-ref ${isHead ? "head" : isTag ? "tag" : isRemote ? "remote" : ""}`}
                    title={isTag ? r : `przełącz na ${r.replace(/^HEAD -> /, "")}`}
                    onClick={(e) => { e.stopPropagation(); if (!isTag && !isHead) checkout(r); }}>
                    {r.replace(/^HEAD -> /, "● ").replace(/^tag: /, "🏷 ")}
                  </button>
                );
              })}
            </span>
            <span className="gh-subject ellipsis" title={c.subject}>{c.subject}</span>
            <span className="gh-meta muted">{c.author.split(" ")[0]} · {c.date}</span>
          </div>
        ))}
      </div>
      {sel && <pre className="gh-details">{details}</pre>}
    </div>
  );
}
