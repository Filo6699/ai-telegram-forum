import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

interface RolloutMetadata {
  id: string;
  parentId: string | null;
  path: string;
}

export function codexRolloutMetadata(line: string, path: string): RolloutMetadata | null {
  try {
    const record = JSON.parse(line);
    if (record.type !== "session_meta" || typeof record.payload?.id !== "string") return null;
    // A manual fork is a separate conversation. Only spawned agents belong to
    // their parent's accounting tree; forked_from_id alone is not sufficient.
    const parent = record.payload.source?.subagent?.thread_spawn?.parent_thread_id;
    return { id: record.payload.id, parentId: typeof parent === "string" ? parent : null, path };
  } catch {
    return null;
  }
}

class RolloutIndex {
  paths = new Map<string, string>();
  children = new Map<string, Set<string>>();
  private indexed = new Set<string>();
  private refreshing: Promise<void> | null = null;

  async refresh(home: string): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.scan(home);
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  private async scan(home: string): Promise<void> {
    for (const directory of ["sessions", "archived_sessions"]) {
      const root = join(home, directory);
      let entries: string[];
      try {
        entries = await readdir(root, { recursive: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      for (const entry of entries) {
        if (!basename(entry).startsWith("rollout-") || !entry.endsWith(".jsonl")) continue;
        const path = join(root, entry);
        if (this.indexed.has(path)) continue;
        // Headers are immutable. Read each once, never load the conversation.
        const input = createReadStream(path);
        const lines = createInterface({ input, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            const meta = codexRolloutMetadata(line, path);
            if (meta) {
              this.paths.set(meta.id, path);
              if (meta.parentId) {
                const children = this.children.get(meta.parentId) ?? new Set<string>();
                children.add(meta.id);
                this.children.set(meta.parentId, children);
              }
              this.indexed.add(path);
            }
            break;
          }
        } catch (err) {
          console.warn("[usage] reading Codex rollout header failed:", String(err));
        } finally {
          lines.close();
          input.destroy();
        }
      }
    }
  }
}

const indexes = new Map<string, RolloutIndex>();

/** Recent spawned agents can be absent from app-server thread/list's index.
 * Their native session_meta headers are the authoritative parent relationship. */
export async function codexRolloutIndex(path: string): Promise<RolloutIndex | null> {
  let root = dirname(path);
  while (basename(root) !== "sessions" && basename(root) !== "archived_sessions") {
    const parent = dirname(root);
    if (parent === root) return null;
    root = parent;
  }
  const home = dirname(root);
  const index = indexes.get(home) ?? new RolloutIndex();
  indexes.set(home, index);
  await index.refresh(home);
  return index;
}
