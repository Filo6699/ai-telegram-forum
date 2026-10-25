import type { PickGroup, PickValue } from "../telegram/picker.ts";

export type ServiceTier = "default" | "fast" | null;

export const serviceTierLabel = (tier: ServiceTier): string =>
  tier === "fast" ? "fast" : tier === "default" ? "standard" : "default";

/** A launch-mode group for Codex when there are no presets to bundle it with. */
export function serviceTierGroup(initial: ServiceTier): PickGroup {
  return {
    key: "s",
    options: [
      { value: "default", label: "standard" },
      { value: "fast", label: "fast" },
    ],
    perRow: 2,
    initial,
    fallback: "default",
    summary: (value: PickValue) => `🚀 mode: ${serviceTierLabel(asServiceTier(value))}`,
  };
}

/** A picker value back into the Codex service tier. */
export const asServiceTier = (value: PickValue): ServiceTier =>
  value === "fast" || value === "default" ? value : null;
