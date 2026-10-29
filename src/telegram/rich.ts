import type { Message, RichBlock, RichText } from "grammy/types";

/**
 * Rich messages are Telegram's block-structured format: headings, lists,
 * tables and code blocks that a Premium client can send, for instance by
 * pasting a Markdown document. They arrive with no `text` at all, so the agent
 * gets them rendered back into Markdown, which is what most of them started as.
 *
 * Media embedded in the blocks isn't downloaded. It is named in place, so the
 * agent knows something is there and can ask for it as a separate file.
 */
export function richText(msg: Message): string | undefined {
  const rich = msg.rich_message;
  if (!rich) return undefined;
  return renderBlocks(rich.blocks).trim();
}

function renderBlocks(blocks: readonly RichBlock[]): string {
  return blocks.map(renderBlock).filter(Boolean).join("\n\n");
}

/** One block as Markdown; unknown future kinds fall back to whatever text they hold. */
function renderBlock(block: RichBlock): string {
  switch (block.type) {
    case "paragraph":
    case "footer":
      return inline(block.text);
    case "heading":
      return `${"#".repeat(block.size)} ${inline(block.text)}`;
    case "pre":
      return `\`\`\`${block.language ?? ""}\n${inline(block.text)}\n\`\`\``;
    case "divider":
      return "---";
    case "mathematical_expression":
      return `$$\n${block.expression}\n$$`;
    case "anchor":
    case "thinking":
      return "";
    case "list":
      return block.items.map((item) => {
        const box = item.has_checkbox ? (item.is_checked ? "[x] " : "[ ] ") : "";
        const body = renderBlocks(item.blocks).replace(/\n/g, "\n  ");
        return `${item.label || "-"} ${box}${body}`;
      }).join("\n");
    case "blockquote":
      return quote(renderBlocks(block.blocks), block.credit);
    case "pullquote":
      return quote(inline(block.text), block.credit);
    case "details":
      return [`**${inline(block.summary)}**`, renderBlocks(block.blocks)].filter(Boolean).join("\n\n");
    case "table":
      return table(block.cells, block.caption);
    case "collage":
    case "slideshow":
      return withCaption(renderBlocks(block.blocks), block.caption);
    case "map": {
      const { latitude, longitude } = block.location;
      return withCaption(`[map: ${latitude}, ${longitude}]`, block.caption);
    }
    case "photo":
    case "video":
    case "animation":
    case "audio":
    case "voice_note":
      return withCaption(`[embedded ${block.type.replace("_", " ")}, not downloaded]`, block.caption);
    default: {
      const unknown = block as { text?: RichText; blocks?: RichBlock[] };
      if (unknown.text !== undefined) return inline(unknown.text);
      return unknown.blocks ? renderBlocks(unknown.blocks) : "";
    }
  }
}

function inline(text: RichText | undefined): string {
  if (text === undefined) return "";
  if (typeof text === "string") return text;
  if (Array.isArray(text)) return text.map(inline).join("");
  switch (text.type) {
    case "bold":
      return `**${inline(text.text)}**`;
    case "italic":
      return `_${inline(text.text)}_`;
    case "strikethrough":
      return `~~${inline(text.text)}~~`;
    case "code":
      return `\`${inline(text.text)}\``;
    case "url": {
      const label = inline(text.text);
      return label === text.url ? label : `[${label}](${text.url})`;
    }
    case "custom_emoji":
      return text.alternative_text;
    case "mathematical_expression":
      return `$${text.expression}$`;
    case "anchor":
      return "";
    default: {
      // Underline, spoiler, mentions, hashtags and the rest read the same as
      // the words they wrap.
      const unknown = text as { text?: RichText };
      return inline(unknown.text);
    }
  }
}

function quote(body: string, credit: RichText | undefined): string {
  const by = credit === undefined ? "" : `\n— ${inline(credit)}`;
  return `${body}${by}`.split("\n").map((line) => `> ${line}`).join("\n");
}

function withCaption(body: string, caption: { text: RichText; credit?: RichText } | undefined): string {
  if (!caption) return body;
  const credit = caption.credit === undefined ? "" : ` — ${inline(caption.credit)}`;
  return [body, `${inline(caption.text)}${credit}`].filter(Boolean).join("\n");
}

function table(
  cells: readonly (readonly { text?: RichText; is_header?: true }[])[],
  caption: RichText | undefined,
): string {
  const rows = cells.map((row) => `| ${row.map((cell) => inline(cell.text).replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`);
  const head = cells[0];
  if (head?.some((cell) => cell.is_header)) {
    rows.splice(1, 0, `|${head.map(() => " --- |").join("")}`);
  }
  return [caption === undefined ? "" : inline(caption), ...rows].filter(Boolean).join("\n");
}
