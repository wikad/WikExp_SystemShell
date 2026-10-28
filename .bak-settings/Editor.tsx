import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";

// Wygląd edytora w kolorach Catppuccin Mocha (jak reszta WikExp)
const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "#1e1e2e", color: "#cdd6f4" },
  ".cm-scroller": { fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace', fontSize: "13px" },
  ".cm-content": { caretColor: "#cba6f7" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#cba6f7", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "#45475a" },
  ".cm-gutters": { backgroundColor: "#1e1e2e", color: "#6c7086", border: "none" },
  ".cm-activeLine": { backgroundColor: "#31324466" },
  ".cm-activeLineGutter": { backgroundColor: "#31324466", color: "#cdd6f4" },
  ".cm-matchingBracket": { backgroundColor: "#45475a", outline: "1px solid #6c7086" },
  ".cm-searchMatch": { backgroundColor: "#f9e2af44" },
  ".cm-panels": { backgroundColor: "#181825", color: "#cdd6f4" },
  ".cm-tooltip": { backgroundColor: "#181825", border: "1px solid #45475a" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "#313244", color: "#cdd6f4" },
}, { dark: true });

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: "#cba6f7" },
  { tag: [t.string, t.special(t.string)], color: "#a6e3a1" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6c7086", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null], color: "#fab387" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#89b4fa" },
  { tag: [t.typeName, t.className, t.namespace], color: "#f9e2af" },
  { tag: [t.propertyName, t.attributeName], color: "#89dceb" },
  { tag: [t.operator, t.punctuation], color: "#94e2d5" },
  { tag: [t.tagName], color: "#f38ba8" },
  { tag: [t.heading], color: "#cba6f7", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#89b4fa", textDecoration: "underline" },
  { tag: [t.meta, t.annotation], color: "#f5c2e7" },
]);

/**
 * Edytor jednego pliku. Ctrl+S zapisuje, Ctrl+W zamyka.
 * Zachowuje końce linii pliku (CRLF z Windowsa zostają CRLF).
 */
export function Editor({ path, initialContent, active, onDirty, onSave, onClose }: {
  path: string;
  initialContent: string;
  active: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: (content: string) => Promise<void>;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
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
          keymap.of([indentWithTab]),
          Prec.highest(keymap.of([
            { key: "Mod-s", run: save, preventDefault: true },
            { key: "Mod-w", run: () => { cb.current.onClose(); return true; }, preventDefault: true },
          ])),
          theme,
          syntaxHighlighting(highlight),
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

  useEffect(() => {
    if (active) viewRef.current?.focus();
  }, [active, path]);

  return <div ref={hostRef} className="editor-host" />;
}
