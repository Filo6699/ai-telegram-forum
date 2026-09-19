/**
 * Accept an OpenRouter model id or a link copied from openrouter.ai. Query
 * strings and fragments are presentation details; the slash and :free suffix
 * are part of the id and deliberately survive.
 */
export function normalizeOpenRouterModel(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;

  if (/^(?:https?:\/\/)?(?:www\.)?openrouter\.ai\//i.test(value)) {
    const urlValue = value.startsWith("http") ? value : `https://${value}`;
    try {
      const url = new URL(urlValue);
      const parts = url.pathname
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
      const marker = parts.findIndex((part) => part === "models");
      if (marker >= 0) parts.splice(0, marker + 1);
      else if (parts[0] === "api" && parts[1] === "v1" && parts[2] === "models") {
        parts.splice(0, 3);
      }
      value = parts.join("/");
    } catch {
      return null;
    }
  }

  value = value.replace(/^\/+|\/+$/g, "");
  if (!value || /\s/.test(value) || value.includes("\\") || !value.includes("/")) return null;
  return value;
}
