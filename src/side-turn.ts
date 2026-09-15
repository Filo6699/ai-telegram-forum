/**
 * A side question may use a live first turn before its provider session id has
 * been persisted by the turn's end hook.
 */
export function sideTurnReady(sessionId: string | null, live: boolean): boolean {
  return Boolean(sessionId || live);
}
