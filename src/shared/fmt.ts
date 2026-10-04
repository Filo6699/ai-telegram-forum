/** Human-readable duration: `42s`, `1m 42s`. */
export function humanMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/** Status-summary duration: `47s`, `1:39`, `1:02:03`. */
export function compactMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const s = String(seconds % 60).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${s}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${s}`;
}

/** Coarse countdown to a timestamp: `4d 2h`, `1h 20m`, `9m`, `now`. */
export function humanUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Block-drawing meter: `███████░░░░░░░░`. Only lines up in a monospace block. */
export function bar(pct: number | null, width = 12): string {
  if (pct === null || !Number.isFinite(pct)) return "─".repeat(width);
  const clamped = Math.min(100, Math.max(0, pct));
  let filled = Math.round((clamped / 100) * width);
  // A window that has been touched at all should look touched.
  if (filled === 0 && clamped > 0) filled = 1;
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Compact token count: `812`, `12.3k`. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
