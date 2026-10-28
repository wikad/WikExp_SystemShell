import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { search } from "@codemirror/search";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";
import { fontStack, useSettings, type Palette } from "./settings";

// Wygląd edytora budowany z palety aktualnego motywu (settings.tsx)
function buildTheme(p: Palette, font: string, fontSize: number) {
  const view = EditorView.theme({
    "&": { height: "100%", backgroundColor: p.base, color: p.text },
    ".cm-scroller": { fontFamily: fontStack(font), fontSize: `${fontSize}px` },
    ".cm-content": { caretColor: p.accent },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: p.accent, borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: p.overlay },
    ".cm-gutters": { backgroundColor: p.base, color: p.muted, border: "none" },
    ".cm-activeLine": { backgroundColor: `${p.surface}66` },
    ".cm-activeLineGutter": { backgroundColor: `${p.surface}66`, color: p.text },
    ".cm-matchingBracket": { backgroundColor: p.overlay, outline: `1px solid ${p.muted}` },
    ".cm-searchMatch": { backgroundColor: `${p.yellow}44` },
    ".cm-panels": { backgroundColor: p.mantle, color: p.text },
    ".cm-tooltip": { backgroundColor: p.mantle, border: `1px solid ${p.overlay}` },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: p.surface, color: p.text },
  }, { dark: !p.light });
  const hl = HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: p.accent },
    { tag: [t.string, t.special(t.string)], color: p.green },
    { tag: [t.comment, t.lineComment, t.blockComment], color: p.muted, fontStyle: "italic" },
    { tag: [t.number, t.bool, t.null], color: p.orange },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: p.blue },
    { tag: [t.typeName, t.className, t.namespace], color: p.yellow },
    { tag: [t.propertyName, t.attributeName], color: p.cyan },
    { tag: [t.operator, t.punctuation], color: p.cyan },
    { tag: [t.tagName], color: p.red },
    { tag: [t.heading], color: p.accent, fontWeight: "bold" },
    { tag: [t.link, t.url], color: p.blue, textDecoration: "underline" },
    { tag: [t.meta, t.annotation], color: p.pink },
  ]);
  return [view, syntaxHighlighting(hl)];
}

/**
 * Edytor jednego pliku. Ctrl+S zapisuje, Ctrl+W zamyka.
 * Zachowuje końce linii pliku (CRLF z Windowsa zostają CRLF).
 */
// Ctrl+F: wbudowane szukanie CodeMirror, przetłumaczone na polski
const PHRASES = {
  "Find": "Szukaj", "Replace": "Zamień na", "next": "następny", "previous": "poprzedni", "all": "wszystkie",
  "match case": "wielkość liter", "by word": "całe słowa", "regexp": "regex", "replace": "zamień",
  "replace all": "zamień wszystkie", "close": "zamknij", "Go to line": "Idź do linii", "go": "idź",
  "current match": "bieżące", "on line": "w linii", "replaced match on line $": "zamieniono w linii $",
  "replaced $ matches": "zamieniono $", "Folded lines": "Zwinięte linie", "Unfolded lines": "Rozwinięte linie",
};

export type Jump = { line: number; col: number; len: number; n: number };

/**
 * Ctrl+F szuka w pliku (wbudowane w CodeMirror, z polem zamiany), Ctrl+Alt+G idzie do linii.
 * - jump: przejdź do linii i zaznacz trafienie (z wyszukiwania w projekcie); `n` rośnie przy każdym żądaniu
 */
export function Editor({ path, initialContent, active, jump, onDirty, onSave, onClose }: {
  path: string;
  initialContent: string;
  active: boolean;
  jump?: Jump | null;
  onDirty: (dirty: boolean) => void;
  onSave: (content: string) => Promise<void>;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment());
  const { palette, settings } = useSettings();
  const look = useRef({ palette, settings });
  look.current = { palette, settings };
  // aktualne callbacki dla keymapy (bez odtwarzania edytora przy każdym renderze)
  const cb = useRef({ onDirty, onSave, onClose });
  cb.current = { onDirty, onSave, onClose };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const lineSep = initialContent.includes("\r\n") ? "\r\n" : "\n";
    const language = new Compartment();
    let saved = initialContent;

    const save = () => {
      const view = viewRef.current;
      if (!view) return true;
      const text = view.state.sliceDoc(); // łączy linie separatorem pliku
      cb.current.onSave(text).then(() => {
        saved = text;
        cb.current.onDirty(false);
      }).catch(() => {});
      return true;
    };

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialContent,
        extensions: [
          basicSetup,
          EditorState.lineSeparator.of(lineSep),
          EditorState.phrases.of(PHRASES),
          search({ top: true }),
          keymap.of([indentWithTab]),
          Prec.highest(keymap.of([
            { key: "Mod-s", run: save, preventDefault: true },
            { key: "Mod-w", run: () => { cb.current.onClose(); return true; }, preventDefault: true },
          ])),
          themeComp.current.of(buildTheme(look.current.palette, look.current.settings.font, look.current.settings.fontSize)),
          language.of([]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onDirty(u.state.sliceDoc() !== saved);
          }),
        ],
      }),
    });
    viewRef.current = view;

    // kolorowanie składni dobierane po nazwie pliku, ładowane w tle
    const name = path.slice(path.lastIndexOf("\\") + 1);
    const desc = LanguageDescription.matchFilename(languages, name);
    desc?.load().then((support) => {
      if (viewRef.current === view) view.dispatch({ effects: language.reconfigure(support) });
    }).catch(() => {});

    return () => { view.destroy(); viewRef.current = null; };
  }, [path, initialContent]);

  // zmiana motywu / fontu → przebuduj tylko wygląd, bez utraty tekstu i historii cofania
  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeComp.current.reconfigure(buildTheme(palette, settings.font, settings.fontSize)) });
  }, [palette, settings.font, settings.fontSize]);

  useEffect(() => {
    if (active) viewRef.current?.focus();
  }, [active, path]);

  // skok do trafienia: zaznacz je i przewiń tak, żeby linia była na środku
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !jump) return;
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(jump.line, 1), doc.lines));
    const from = Math.min(line.from + jump.col, line.to);
    const to = Math.min(from + jump.len, line.to);
    view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
    if (active) view.focus();
  }, [jump?.n, path]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={hostRef} className="editor-host" />;
}
