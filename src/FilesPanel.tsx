import { useEffect, useReducer, useRef, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { formatSize, openPath, parentDir, readDir, readTextFile, writeTextFile, type FileEntry } from "./api";
import { Editor, type Jump } from "./Editor";
import { MdPreview } from "./MdPreview";
import { PdfView } from "./PdfView";
import { useSettings } from "./settings";
import { useGit, gitStatusOf } from "./useGit";

export type OpenFile = { path: string; dirty: boolean };

// Historia nawigacji jednego panelu plików (wstecz / naprzód jak w przeglądarce)
type Nav = { back: string[]; cwd: string | null; forward: string[] };
type NavAction =
  | { type: "init"; path: string }
  | { type: "go"; path: string }
  | { type: "back" }
  | { type: "forward" };

function navReducer(s: Nav, a: NavAction): Nav {
  switch (a.type) {
    case "init":
      return { back: [], cwd: a.path, forward: [] };
    case "go":
      if (!s.cwd || a.path === s.cwd) return { ...s, cwd: a.path };
      return { back: [...s.back, s.cwd].slice(-50), cwd: a.path, forward: [] };
    case "back":
      if (!s.cwd || s.back.length === 0) return s;
      return { back: s.back.slice(0, -1), cwd: s.back[s.back.length - 1], forward: [...s.forward, s.cwd] };
    case "forward":
      if (!s.cwd || s.forward.length === 0) return s;
      return { back: [...s.back, s.cwd], cwd: s.forward[s.forward.length - 1], forward: s.forward.slice(0, -1) };
  }
}

/**
 * Samodzielny panel plików: każda instancja ma własny folder, historię i zaznaczenie.
 * - initialPath: folder startowy (null = folder domowy)
 * - goTo: żądanie z zewnątrz (np. z drzewa albo wyszukiwania): wejdź do folderu albo otwórz plik,
 *   opcjonalnie na konkretnej linii; `n` rośnie przy każdym żądaniu
 * - onCwd: zgłasza zmianę folderu do App (tytuł panelu, drzewo, zapis)
 * - onOpenFile: zgłasza otwarty plik (podświetlenie w drzewie, tytuł) albo null
 */
// pliki bez podglądu w panelu (PDF i Markdown mają własny): Enter / dwuklik otwiera je domyślnym programem Windows
// (exe, bat itp. celowo nie: przypadkowy Enter nie może niczego uruchamiać; do tego jest `o`)
const EXTERNAL_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "zip", "7z", "rar", "mp3", "wav", "flac", "ogg", "mp4", "mkv", "avi", "mov", "webm",
]);
const extOf = (p: string) => (p.includes(".") ? p.slice(p.lastIndexOf(".") + 1).toLowerCase() : "");

export function FilesPanel({ active, initialPath, goTo, onCwd, onOpenFile }: {
  active: boolean;
  initialPath: string | null;
  goTo: { path: string; n: number; file?: boolean; line?: number; col?: number; len?: number } | null;
  onCwd: (cwd: string) => void;
  onOpenFile: (f: OpenFile | null) => void;
}) {
  const [nav, dispatch] = useReducer(navReducer, { back: [], cwd: null, forward: [] });
  const cwd = nav.cwd;
  const [allFiles, setFiles] = useState<FileEntry[]>([]);
  const { showHidden } = useSettings().settings;
  const files = showHidden ? allFiles : allFiles.filter((f) => !f.hidden);
  const git = useGit(cwd);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  // tryb edytora: otwarty plik zamiast listy
  const [editor, setEditor] = useState<{ path: string; content: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [closeArmed, setCloseArmed] = useState(false);
  const [pdf, setPdf] = useState<string | null>(null);            // otwarty podgląd PDF
  const [showPreview, setShowPreview] = useState(false);          // podgląd .md obok edytora
  const [liveText, setLiveText] = useState("");                   // bieżący tekst edytora dla podglądu .md
  const pendingText = useRef("");
  const [previewTick, setPreviewTick] = useState(0);
  const [jump, setJump] = useState<Jump | null>(null); // linia, na którą skoczyć w edytorze

  useEffect(() => {
    onOpenFile(editor ? { path: editor.path, dirty } : pdf ? { path: pdf, dirty: false } : null);
  }, [editor?.path, dirty, pdf]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!closeArmed) return;
    const id = setTimeout(() => setCloseArmed(false), 3000);
    return () => clearTimeout(id);
  }, [closeArmed]);

  // domyślny program Windows (with_dialog = „Otwórz za pomocą…”)
  const openExternal = (path: string, withDialog = false) => {
    openPath(path, withDialog)
      .then(() => setNotice(null))
      .catch((e) => setNotice(String(e)));
  };

  // podgląd .md: tekst z edytora z lekkim opóźnieniem, żeby nie renderować przy każdym klawiszu
  useEffect(() => {
    if (!showPreview) return;
    const id = setTimeout(() => setLiveText(pendingText.current), 150);
    return () => clearTimeout(id);
  }, [showPreview, previewTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // preview = otwórz od razu z podglądem (.md); PDF zawsze w podglądzie
  const openFile = (path: string, at?: { line: number; col: number; len: number }, preview = false) => {
    const ext = extOf(path);
    if (!at && ext === "pdf") {
      if (editor && dirty) { setNotice("niezapisane zmiany: ctrl+s zapisz albo ctrl+w ×2 zamknij bez zapisu"); return; }
      setEditor(null); setDirty(false); setNotice(null); setPdf(path);
      return;
    }
    if (!at && EXTERNAL_EXT.has(ext)) { openExternal(path); return; }
    const pos = at ? { ...at, n: (jump?.n ?? 0) + 1 } : null;
    if (editor?.path === path) { if (pos) setJump(pos); return; }
    if (editor && dirty) {
      setNotice("niezapisane zmiany: ctrl+s zapisz albo ctrl+w ×2 zamknij bez zapisu");
      return;
    }
    readTextFile(path)
      .then((content) => {
        setPdf(null); setEditor({ path, content }); setJump(pos); setDirty(false); setNotice(null);
        pendingText.current = content; setLiveText(content); setShowPreview(preview && ext === "md");
      })
      .catch((e) => setNotice(String(e)));
  };

  const closeEditor = () => {
    if (dirty && !closeArmed) {
      setCloseArmed(true);
      setNotice("niezapisane zmiany: ctrl+w jeszcze raz = zamknij bez zapisu");
      return;
    }
    setEditor(null); setDirty(false); setCloseArmed(false); setNotice(null);
  };

  const saveFile = (content: string) => {
    if (!editor) return Promise.resolve();
    return writeTextFile(editor.path, content)
      .then(() => setNotice(null))
      .catch((e) => { setNotice(String(e)); throw e; });
  };

  useEffect(() => {
    if (initialPath) dispatch({ type: "init", path: initialPath });
    else homeDir().then((p) => dispatch({ type: "init", path: p }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!goTo) return;
    if (goTo.file) openFile(goTo.path, goTo.line ? { line: goTo.line, col: goTo.col ?? 0, len: goTo.len ?? 0 } : undefined);
    else dispatch({ type: "go", path: goTo.path });
  }, [goTo?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!cwd) return;
    onCwd(cwd);
    readDir(cwd)
      .then((f) => { setFiles(f); setError(null); setSelected(0); })
      .catch((e) => setError(String(e)));
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active || editor || pdf) return;   // w edytorze klawisze idą do tekstu
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, files.length - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "l") {
        e.preventDefault();
        const f = files[selected];
        if (f?.isDir) dispatch({ type: "go", path: f.path });
        else if (f) openFile(f.path);
      } else if ((e.key === "Backspace" || e.key === "h") && cwd) {
        e.preventDefault();
        parentDir(cwd).then((p) => { if (p) dispatch({ type: "go", path: p }); });
      } else if (e.key === "p") {
        // p = podgląd: PDF w panelu, .md w edytorze z podglądem obok
        e.preventDefault();
        const f = files[selected];
        if (f && !f.isDir) openFile(f.path, undefined, true);
      } else if (e.key === "o" || e.key === "O") {
        // o = domyślny program, O (Shift+o) = „Otwórz za pomocą…”; działa na każdym pliku i folderze
        e.preventDefault();
        const f = files[selected];
        if (f) openExternal(f.path, e.key === "O");
      } else if (e.key === "H") {
        e.preventDefault();
        dispatch({ type: "back" });
      } else if (e.key === "L") {
        e.preventDefault();
        dispatch({ type: "forward" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, files, selected, cwd, editor, pdf, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  // podgląd PDF: Esc / q / Ctrl+W zamyka, o = zewnętrzny program (gdy fokus jest poza ramką PDF)
  useEffect(() => {
    if (!active || !pdf) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey) return;
      if (e.key === "Escape" || (!e.ctrlKey && e.key === "q") || (e.ctrlKey && e.key === "w")) {
        e.preventDefault(); setPdf(null);
      } else if (!e.ctrlKey && (e.key === "o" || e.key === "O")) {
        e.preventDefault(); openExternal(pdf, e.key === "O");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, pdf]); // eslint-disable-line react-hooks/exhaustive-deps

  if (pdf) {
    const name = pdf.slice(pdf.lastIndexOf("\\") + 1);
    return (
      <div className="editor-wrap">
        <div className="editor-bar">
          <span className="accent">{name}</span>
          <span className="spacer" />
          <span className="muted">esc zamknij · o zewnętrzny program · O otwórz za pomocą…</span>
          <span className="pdf-close" onClick={() => setPdf(null)}>✕</span>
        </div>
        {notice && <div className="row yellow">{notice}</div>}
        <PdfView path={pdf} />
      </div>
    );
  }

  if (editor) {
    const name = editor.path.slice(editor.path.lastIndexOf("\\") + 1);
    const isMd = extOf(editor.path) === "md" || extOf(editor.path) === "markdown";
    return (
      <div className="editor-wrap">
        <div className="editor-bar">
          <span className="accent">{name}</span>
          {dirty && <span className="yellow"> ●</span>}
          <span className="spacer" />
          <span className="muted">
            ctrl+f szukaj · ctrl+s zapisz · {isMd ? "ctrl+shift+v podgląd · " : ""}ctrl+w zamknij
          </span>
        </div>
        {notice && <div className="row yellow">{notice}</div>}
        <div className="editor-split">
          <Editor
            key={editor.path}
            path={editor.path}
            initialContent={editor.content}
            active={active}
            jump={jump}
            onDirty={setDirty}
            onSave={saveFile}
            onClose={closeEditor}
            onChange={isMd ? (t) => { pendingText.current = t; setPreviewTick((n) => n + 1); } : undefined}
            onTogglePreview={isMd ? () => { setLiveText(pendingText.current); setShowPreview((v) => !v); } : undefined}
          />
          {isMd && showPreview && <MdPreview text={liveText} />}
        </div>
      </div>
    );
  }

  return (
    <>
      {notice && <div className="row yellow">{notice}</div>}
      <div className="row head">
        <span className="c-name">NAME</span><span className="c-type">TYPE</span><span className="c-size">SIZE</span>
      </div>
      {error && <div className="row red">{error}</div>}
      {files.map((f, i) => (
        <div
          key={f.path}
          className={`row ${i === selected && active ? "sel" : ""}`}
          onClick={() => setSelected(i)}
          onDoubleClick={() => (f.isDir ? dispatch({ type: "go", path: f.path }) : openFile(f.path))}
        >
          <span className={`c-name ellipsis ${f.isDir ? "accent" : ""} git-${gitStatusOf(git, f.path, f.isDir)}`}>{f.isDir ? f.name + "\\" : f.name}</span>
          <span className="c-type">{f.isDir ? "dir" : f.name.split(".").pop()}</span>
          <span className="c-size">{f.isDir ? "—" : formatSize(f.size)}</span>
        </div>
      ))}
    </>
  );
}
