import { useMemo } from "react";
import { openPath } from "./api";
import { renderMarkdown } from "./markdown";

/** Podgląd Markdown (jak Ctrl+Shift+V w VS Code). Linki zewnętrzne otwierają się w przeglądarce Windows. */
export function MdPreview({ text }: { text: string }) {
  // renderMarkdown escapuje cały tekst ze źródła, więc innerHTML jest tu bezpieczne
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="md-preview"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (!a) return;
        e.preventDefault();            // webview nigdy nie nawiguje sam
        const href = a.getAttribute("href") ?? "";
        if (/^(https?|mailto):/i.test(href)) openPath(href).catch(() => {});
      }}
    />
  );
}
