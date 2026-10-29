// Prosty renderer Markdown → HTML na potrzeby podglądu w WikExp.
// Bezpieczeństwo: cały tekst ze źródła jest escapowany (surowy HTML z pliku .md się nie wykona),
// linki tylko http(s) / mailto / względne, obrazki pokazywane jako opis (bez ładowania).
// Obsługa: nagłówki, akapity, **pogrubienie**, *kursywa*, ~~skreślenie~~, `kod`, bloki kodu,
// listy (zagnieżdżone, numerowane, zadania), cytaty, tabele, linie poziome, linki.

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// adres już po escapowaniu; zwraca "" dla niebezpiecznych schematów (javascript:, data: itd.)
function safeHref(escaped: string): string {
  const u = escaped.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^(https?|mailto):/i.test(u)) return "";
  return u;
}

function inline(src: string): string {
  const codes: string[] = [];
  let s = src.replace(/\0/g, "");
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _t, c: string) => {
    codes.push(`<code>${esc(c.trim())}</code>`);
    return `\0${codes.length - 1}\0`;
  });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]*)(?:\s+&quot;[^)]*&quot;)?\)/g, (_m, alt: string) => `<span class="md-img">[obraz: ${alt || "bez opisu"}]</span>`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]*)(?:\s+&quot;[^)]*&quot;)?\)/g, (_m, text: string, url: string) => {
    const href = safeHref(url);
    return href ? `<a href="${href}">${text}</a>` : text;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,;:!?)\]])/g, '$1<a href="$2">$2</a>');
  s = s.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(?=\S)(.+?)(?<=\S)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "<del>$1</del>");
  s = s.replace(/(?: {2,}|\\)\n/g, "<br>\n");
  return s.replace(/\0(\d+)\0/g, (_m, i: string) => codes[Number(i)]);
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const isBlank = (l: string) => /^\s*$/.test(l);
const indentOf = (l: string) => l.match(/^\s*/)![0].replace(/\t/g, "    ").length;

const splitRow = (row: string) =>
  row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

function isBlockStart(lines: string[], i: number): boolean {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || LIST.test(l) ||
    (l.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-"));
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    // blok kodu
    const fence = line.match(FENCE);
    if (fence) {
      const mark = fence[1], lang = fence[2];
      const closer = new RegExp(`^\\s*${mark[0]}{${mark.length},}\\s*$`);
      const buf: string[] = [];
      i++;
      while (i < lines.length && !closer.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ""}>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    const h = line.match(HEADING);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

    if (HR.test(line)) { out.push("<hr>"); i++; continue; }

    // cytat (rekurencyjnie, bo w środku może być cokolwiek)
    if (QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}> ?/, ""));
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    // tabela
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "");
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      const cell = (tag: string, c: string, n: number) =>
        `<${tag}${align[n] ? ` style="text-align:${align[n]}"` : ""}>${inline(c)}</${tag}>`;
      out.push(
        `<table><thead><tr>${head.map((c, n) => cell("th", c, n)).join("")}</tr></thead><tbody>` +
        rows.map((r) => `<tr>${head.map((_c, n) => cell("td", r[n] ?? "", n)).join("")}</tr>`).join("") +
        `</tbody></table>`,
      );
      continue;
    }

    // lista (płaska lista pozycji z wcięciami → zagnieżdżone <ul>/<ol>)
    if (LIST.test(line)) {
      type Item = { indent: number; ordered: boolean; start: number; text: string };
      const items: Item[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST);
        if (m) {
          items.push({ indent: indentOf(lines[i]), ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] });
          i++;
        } else if (isBlank(lines[i])) {
          // pusta linia nie kończy listy, jeśli zaraz po niej jest kolejna pozycja
          let j = i;
          while (j < lines.length && isBlank(lines[j])) j++;
          if (j < lines.length && LIST.test(lines[j])) i = j; else break;
        } else if (items.length && !isBlockStart(lines, i)) {
          items[items.length - 1].text += " " + lines[i].trim();   // ciąg dalszy pozycji
          i++;
        } else break;
      }
      const stack: { indent: number; tag: string }[] = [];
      let html = "";
      for (const it of items) {
        while (stack.length && it.indent < stack[stack.length - 1].indent) {
          html += `</li></${stack.pop()!.tag}>`;
        }
        // ta sama głębokość, ale inny rodzaj listy (np. po - przychodzi 1.): zamknij starą, otwórz nową
        const top = stack[stack.length - 1];
        if (top && it.indent === top.indent && top.tag !== (it.ordered ? "ol" : "ul")) {
          html += `</li></${stack.pop()!.tag}>`;
        }
        if (!stack.length || it.indent > stack[stack.length - 1].indent) {
          const tag = it.ordered ? "ol" : "ul";
          html += `<${tag}${it.ordered && it.start !== 1 ? ` start="${it.start}"` : ""}>`;
          stack.push({ indent: it.indent, tag });
        } else {
          html += "</li>";
        }
        const task = it.text.match(/^\[([ xX])\]\s+(.*)$/);
        html += task
          ? `<li class="md-task"><input type="checkbox" disabled${task[1] !== " " ? " checked" : ""}> ${inline(task[2])}`
          : `<li>${inline(it.text)}`;
      }
      while (stack.length) html += `</li></${stack.pop()!.tag}>`;
      out.push(html);
      continue;
    }

    // akapit: do pustej linii albo początku innego bloku
    const buf = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !isBlockStart(lines, i)) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join("\n"))}</p>`);
  }
  return out.join("\n");
}
