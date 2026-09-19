import type { PickGroup, PickValue } from "./picker.ts";

export type Provider = "claude" | "codex" | "openrouter";

export function parseProvider(raw: string): Provider | undefined {
  const value = raw.trim().toLowerCase();
  return value === "claude" || value === "codex" || value === "openrouter" ? value : undefined;
}

export const providerLabel = (provider: Provider): string =>
  provider === "codex" ? "Codex" : provider === "openrouter" ? "OpenRouter" : "Claude";

export const asProvider = (value: PickValue, fallback: Provider): Provider =>
  value === "codex" || value === "claude" || value === "openrouter" ? value : fallback;

export function providerGroup(
  initial: Provider,
  fallback: Provider,
  openRouterEnabled = true,
): PickGroup {
  const options = [
    { value: "claude", label: "Claude" },
    { value: "codex", label: "Codex" },
    ...(openRouterEnabled ? [{ value: "openrouter", label: "OpenRouter" }] : []),
  ];
  return {
    key: "p",
    options,
    perRow: options.length === 3 ? 3 : 2,
    initial,
    fallback,
    summary: (value) => `🧠 agent: ${providerLabel(asProvider(value, fallback))}`,
  };
}
