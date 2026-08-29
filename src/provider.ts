import type { PickGroup, PickValue } from "./picker.ts";

export type Provider = "claude" | "codex";

export function parseProvider(raw: string): Provider | undefined {
  const value = raw.trim().toLowerCase();
  return value === "claude" || value === "codex" ? value : undefined;
}

export const providerLabel = (provider: Provider): string =>
  provider === "codex" ? "Codex" : "Claude";

export const asProvider = (value: PickValue, fallback: Provider): Provider =>
  value === "codex" || value === "claude" ? value : fallback;

export function providerGroup(initial: Provider, fallback: Provider): PickGroup {
  return {
    key: "p",
    options: [
      { value: "claude", label: "Claude" },
      { value: "codex", label: "Codex" },
    ],
    perRow: 2,
    initial,
    fallback,
    summary: (value) => `🧠 agent: ${providerLabel(asProvider(value, fallback))}`,
  };
}
