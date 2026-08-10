/**
 * GFM tables → something Telegram can actually show.
 *
 * Telegram has no table markup, and the MarkdownV2 renderer double-escapes
 * table cells (`(` comes out as `\\(`), which the API rejects outright — so a
 * table doesn't just look wrong, it costs the whole message its formatting.
 *
 * Narrow tables become an aligned block inside a code fence, which survives
 * every rendering tier; wide ones become one `Column: value` list per row,
 * because a monospace grid wider than a phone screen wraps into noise.
 */

const MAX_GRID_WIDTH = 46; // chars that fit a phone screen in monospace

/** A `|---|:--:|` line — what separates a table's header from its body. */
const isDivider = (line: string): boolean =>
  /\|/.test(line) && /^[\s|:-]+$/.test(line) && /-/.test(line);

const isRow = (line: string): boolean => line.includes("|") && line.trim().length > 0;

/** Split a row on unescaped pipes, dropping the leading/trailing ones. */
function cells(row: string): string[] {
  const parts = row
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => plain(c.replace(/\\\|/g, "|").trim()));
  return parts;
}

/** Strip inline markup: inside a code fence it would show up as literal noise. */
const plain = (s: string): string =>
  s
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*]+)\*/g, "$1$2$3")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, "$1 $2")
    .replace(/<br\s*\/?>/gi, " ")
    .trim();

/** Render a parsed table as an aligned monospace grid. */
function grid(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const width = (i: number) => Math.max(...rows.map((r) => (r[i] ?? "").length));
  const widths = Array.from({ length: cols }, (_, i) => width(i));
  const line = (r: string[]) =>
    widths
      .map((w, i) => (r[i] ?? "").padEnd(w))
      .join("  ")
      .trimEnd();

  const [header, ...body] = rows;
  const rule = widths.map((w) => "─".repeat(w)).join("  ");
  return ["```", line(header ?? []), rule, ...body.map(line), "```"].join("\n");
}

/** Render a parsed table as one labelled block per row. */
function labelled(rows: string[][]): string {
  const [header = [], ...body] = rows;
  return body
    .map((r) =>
      r
        .map((cell, i) => {
          const label = header[i] ?? "";
          return label ? `**${label}:** ${cell}` : cell;
        })
        .filter((l) => l.trim().length > 0)
        .join("\n"),
    )
    .join("\n\n");
}

function renderTable(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? "").length)),
  );
  const total = widths.reduce((a, b) => a + b, 0) + 2 * (cols - 1);
  return total <= MAX_GRID_WIDTH ? grid(rows) : labelled(rows);
}

/** Rewrite every markdown table in `md`; code fences are left alone. */
export function flattenTables(md: string): string {
  if (!md.includes("|")) return md;

  const lines = md.split("\n");
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i] ?? "";
    if (/^\s*```/.test(cur)) inFence = !inFence;

    if (!inFence && isRow(cur) && isDivider(lines[i + 1] ?? "")) {
      const rows = [cells(cur)];
      i += 2; // header + divider
      while (i < lines.length && isRow(lines[i] ?? "") && !/^\s*```/.test(lines[i] ?? "")) {
        rows.push(cells(lines[i] ?? ""));
        i++;
      }
      i--; // the loop's own i++ consumes the line that ended the table
      out.push(renderTable(rows));
      continue;
    }

    out.push(cur);
  }

  return out.join("\n");
}
