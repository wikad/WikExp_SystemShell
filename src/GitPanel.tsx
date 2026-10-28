import { useCallback, useEffect, useState } from "react";
import {
  gitBranches, gitCheckout, gitCommit, gitDiff, gitStage, gitStageAll, gitStatus, gitSync,
  type GitBranch, type GitFile, type GitStatus,
} from "./api";
import { GitHistory } from "./GitHistory";

const REFRESH_MS = 4000;
const baseName = (p: string) => p.slice(p.lastIndexOf("\\") + 1);

const STATUS_MARK: Record<string, [string, string]> = {
  modified: ["M", "yellow"], added: ["A", "green"], deleted: ["D", "red"],
  renamed: ["R", "blue"], untracked: ["U", "green"], conflict: ["!", "red"],
};

/** Prosty, kolorowany podgląd diffa (linie +/-/nagłówki). */
function Diff({ text }: { text: string }) {
  if (!text.trim()) return <div className="row muted">brak zmian do pokazania</div>;
  return (
    <div className="git-diff">
      {text.split("\n").map((line, i) => {
        const cls = line.startsWith("+") && !line.startsWith("+++") ? "add"
          : line.startsWith("-") && !line.startsWith("---") ? "del"
          : line.startsWith("@@") ? "hunk"
          : line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---") ? "meta" : "";
        return <div key={i} className={`git-diff-line ${cls}`}>{line || " "}</div>;
      })}
    </div>
  );
}

/**
 * Panel git dla repozytorium, w którym leży folder połączonego panelu plików (`cwd`).
 * Status, zmienione pliki, diff, commit, pull/push/fetch, przełączanie branchy.
 */
export function GitPanel({ cwd, active }: { cwd: string | null; active: boolean }) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [sel, setSel] = useState<string | null>(null);   // ścieżka pliku wybranego do diffa
  const [diff, setDiff] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showBranches, setShowBranches] = useState(false);
  const [tab, setTab] = useState<"changes" | "history">("changes");

  const refresh = useCallback(() => {
    if (!cwd) { setSt(null); return; }
    gitStatus(cwd).then(setSt).catch(() => setSt(null));
  }, [cwd]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // diff wybranego pliku (staged, jeśli plik jest tylko w indeksie)
  useEffect(() => {
    if (!cwd || !sel || !st) { setDiff(""); return; }
    const f = st.files.find((x) => x.path === sel);
    if (!f) { setDiff(""); return; }
    gitDiff(cwd, sel, f.staged && !f.unstaged).then(setDiff).catch((e) => setDiff(String(e)));
  }, [cwd, sel, st]);

  useEffect(() => { if (msg) { const t = setTimeout(() => setMsg(null), 4000); return () => clearTimeout(t); } }, [msg]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    if (!cwd) return;
    setBusy(true);
    try { await fn(); if (ok) setMsg(ok); } catch (e) { setMsg(String(e)); } finally { setBusy(false); refresh(); }
  };

  const toggleStage = (f: GitFile) => run(() => gitStage(cwd!, f.path, !f.staged));
  const commit = () => run(async () => {
    const out = await gitCommit(cwd!, message);
    setMessage("");
    return out;
  }, "commit utworzony");
  const sync = (action: "pull" | "push" | "fetch") => run(() => gitSync(cwd!, action), `${action}: ok`);
  const openBranches = () => { if (cwd) gitBranches(cwd).then(setBranches).catch(() => {}); setShowBranches((v) => !v); };
  const checkout = (b: string) => { setShowBranches(false); run(() => gitCheckout(cwd!, b), `przełączono na ${b}`); };

  if (!cwd) return <div className="row muted">otwórz folder w panelu plików</div>;
  if (!st) return <div className="row muted">wczytywanie…</div>;
  if (!st.isRepo) return <div className="row muted">{baseName(cwd)} nie jest repozytorium git</div>;

  const staged = st.files.filter((f) => f.staged);
  const changes = st.files.filter((f) => !f.staged || f.unstaged);

  const row = (f: GitFile) => {
    const [mark, color] = STATUS_MARK[f.status] ?? ["?", "muted"];
    return (
      <div key={f.path + (f.staged ? "s" : "u")} className={`row git-file ${sel === f.path ? "sel" : ""}`} onClick={() => setSel(f.path)}>
        <button className="git-check" title={f.staged ? "wyjmij z commita" : "dodaj do commita"}
          onClick={(e) => { e.stopPropagation(); toggleStage(f); }}>{f.staged ? "☑" : "☐"}</button>
        <span className={`git-mark ${color}`}>{mark}</span>
        <span className="c-name ellipsis" title={f.path}>{f.path}</span>
      </div>
    );
  };

  return (
    <div className="git">
      <div className="git-head">
        <button className="git-branch" onClick={openBranches} title="zmień branch">
          <span className="accent">⎇ {st.branch}</span>
          {(st.ahead > 0 || st.behind > 0) && (
            <span className="muted">{st.ahead > 0 ? ` ↑${st.ahead}` : ""}{st.behind > 0 ? ` ↓${st.behind}` : ""}</span>
          )}
        </button>
        <span className="spacer" />
        <button className="git-op" disabled={busy} onClick={() => sync("fetch")} title="fetch">⟳</button>
        <button className="git-op" disabled={busy} onClick={() => sync("pull")} title="pull">↓</button>
        <button className="git-op" disabled={busy} onClick={() => sync("push")} title="push">↑</button>
      </div>

      {showBranches && (
        <div className="git-branches">
          {branches.map((b) => (
            <div key={b.name} className={`row git-br ${b.current ? "sel" : ""}`} onClick={() => !b.current && checkout(b.name)}>
              <span className={b.current ? "accent" : ""}>{b.current ? "● " : "○ "}{b.name}</span>
              {(b.ahead > 0 || b.behind > 0) && <span className="muted">{b.ahead > 0 ? ` ↑${b.ahead}` : ""}{b.behind > 0 ? ` ↓${b.behind}` : ""}</span>}
            </div>
          ))}
        </div>
      )}
      {msg && <div className="row yellow">{msg}</div>}

      <div className="git-tabs">
        <button className={tab === "changes" ? "on" : ""} onClick={() => setTab("changes")}>
          zmiany{st.files.length ? ` (${st.files.length})` : ""}
        </button>
        <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>historia</button>
      </div>

      {tab === "history" ? <GitHistory cwd={cwd} onChanged={refresh} /> : <>
      <div className="git-files">
        {st.files.length === 0 && <div className="row muted">brak zmian · wszystko czyste</div>}
        {staged.length > 0 && <div className="git-section">do commita ({staged.length})</div>}
        {staged.map(row)}
        {changes.length > 0 && <div className="git-section">zmiany ({changes.length})</div>}
        {changes.map(row)}
      </div>

      {sel && <div className="git-diff-wrap"><Diff text={diff} /></div>}

      {staged.length > 0 && (
        <div className="git-commit">
          <input className="git-msg" placeholder="wiadomość commita (Ctrl+Enter)" value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) commit(); }} />
          <button className="btn" disabled={busy || !message.trim()} onClick={commit}>commit</button>
        </div>
      )}
      {st.files.length > 0 && staged.length === 0 && (
        <div className="git-commit">
          <button className="btn" disabled={busy} onClick={() => run(() => gitStageAll(cwd, true), "dodano wszystko")}>dodaj wszystko do commita</button>
        </div>
      )}
      </>}
      {/* `active` steruje tylko tym, czy panel ma skróty — na razie obsługa myszką */}
      <input type="hidden" value={active ? 1 : 0} readOnly />
    </div>
  );
}
