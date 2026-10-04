/**
 * Markdown → Telegram HTML.
 *
 * MarkdownV2 is unforgiving: a single unescaped `(`, `.` or `-` anywhere in the
 * message aborts the whole send. Telegram's HTML mode only reserves `&`, `<`
 * and `>`, so escaping is total and the result parses as long as we emit
 * balanced tags — which a generator, unlike a passthrough escaper, always does.
 *
 * This covers the subset Telegram supports (bold, italic, strike, inline code,
 * fenced code, links); everything else degrades to escaped plain text.
 */

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Only http(s) and tg links; anything else renders as plain text. */
const isSafeUrl = (url: string): boolean => /^(https?:\/\/|tg:\/\/)/i.test(url);

/**
 * Inline spans, applied to already-escaped text.
 *
 * Links and bare URLs are lifted out first: `https://a.co/_foo_bar_` is not
 * emphasis, and an emphasis tag opened inside an href attribute is exactly the
 * kind of malformed markup Telegram rejects.
 */
function inline(escaped: string): string {
  // NUL-delimited index: toTelegramHtml() strips NULs from the input, so a
  // placeholder can never collide with real text.
  const held: string[] = [];
  const hold = (html: string): string => `\u0000${held.push(html) - 1}\u0000`;

  const text = escaped
    // [text](url) — the label still gets emphasis, so hold only the tags.
    .replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, label: string, url: string) =>
      isSafeUrl(url)
        ? `${hold(`<a href="${url.replace(/"/g, "&quot;")}">`)}${label}${hold("</a>")}`
        : m,
    )
    // Bare URLs: Telegram auto-links them, we just keep them intact.
    .replace(/(?:https?|tg):\/\/[^\s<>"']+/g, (m) => hold(m));

  return (
    text
      // ***bold italic***
      .replace(/\*\*\*(?!\s)([^*\n]+?)\*\*\*/g, "<b><i>$1</i></b>")
      // **bold**
      .replace(/\*\*(?!\s)([^*\n]+?)\*\*/g, "<b>$1</b>")
      // ~~strike~~
      .replace(/~~(?!\s)([^~\n]+?)~~/g, "<s>$1</s>")
      // *italic* — the remaining single asterisks
      .replace(/\*(?!\s)([^*\n]+?)\*/g, "<i>$1</i>")
      // _italic_ — word boundaries only, so snake_case survives
      .replace(/(^|[^\w\\])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1<i>$2</i>")
      .replace(/\u0000(\d+)\u0000/g, (_m, n: string) => held[Number(n)] ?? "")
  );
}

/** One non-code line: headings and list bullets, then inline spans. */
function line(raw: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(raw);
  if (heading) return `<b>${inline(escapeHtml((heading[1] ?? "").replace(/\s*#+\s*$/, "")))}</b>`;

  // Horizontal rules have no HTML equivalent in Telegram.
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) return "———";

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
  if (bullet) return `${bullet[1] ?? ""}• ${inline(escapeHtml(bullet[2] ?? ""))}`;

  // Blockquotes: Telegram has <blockquote>, but nesting it across chunk
  // boundaries is fragile — keep the marker as text.
  return inline(escapeHtml(raw));
}

/**
 * Render markdown as Telegram-flavoured HTML. Never throws: unparseable input
 * comes back as escaped plain text.
 */
export function toTelegramHtml(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\u0000/g, "").split("\n");

  let i = 0;
  while (i < lines.length) {
    const cur = lines[i] ?? "";
    const fence = /^\s*```(.*)$/.exec(cur);
    if (fence) {
      const lang = (fence[1] ?? "").trim().split(/\s+/)[0] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
      i++; // closing fence (or EOF — an unterminated block still closes cleanly)
      const cls = /^[\w+#.-]+$/.test(lang) ? ` class="language-${lang}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // Inline code is handled per line so a stray backtick can't swallow the rest
    // of the message: split on `…` pairs, format the gaps, escape the spans.
    const parts = cur.split(/(`+)/);
    let rendered = "";
    let j = 0;
    while (j < parts.length) {
      const part = parts[j] ?? "";
      if (/^`+$/.test(part)) {
        const close = parts.indexOf(part, j + 1);
        if (close > j) {
          rendered += `<code>${escapeHtml(parts.slice(j + 1, close).join(""))}</code>`;
          j = close + 1;
          continue;
        }
      }
      // Block prefixes (headings, bullets) only count at the start of a line.
      rendered += j === 0 ? line(part) : inline(escapeHtml(part));
      j++;
    }
    out.push(rendered);
    i++;
  }

  return out.join("\n");
}
