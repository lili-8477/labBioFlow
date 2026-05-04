import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Pool } from "pg";

export interface ImportOptions {
  pool: Pool;
  username: string;
  workspaceRoot: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Best-effort one-shot import of legacy `.claude/chats/*.json` sidecar
 * files into the `chats` table. Writes a `.claude/chats/.imported` sentinel
 * on completion so re-runs are no-ops. Idempotent via ON CONFLICT DO NOTHING.
 *
 * Sentinel lives INSIDE the chats dir (a dotfile — doesn't match the
 * importer's .json filter) because in production bind-mount layouts only
 * the chats subdir is writable by the adapter user; the parent .claude
 * dir is often auto-created by Docker as root and read-only.
 */
export async function importSidecar(opts: ImportOptions): Promise<ImportResult> {
  const sentinel = path.join(opts.workspaceRoot, ".claude", "chats", ".imported");
  try {
    await fs.stat(sentinel);
    return { imported: 0, skipped: 0 };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const chatsDir = path.join(opts.workspaceRoot, ".claude", "chats");
  let files: string[] = [];
  try {
    files = await fs.readdir(chatsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  let imported = 0;
  let skipped = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const full = path.join(chatsDir, f);
    let raw: string;
    try {
      raw = await fs.readFile(full, "utf8");
    } catch {
      skipped++;
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      skipped++;
      continue;
    }
    const chatId = obj.id;
    if (typeof chatId !== "string" || !UUID_RE.test(chatId)) {
      skipped++;
      continue;
    }
    const name = typeof obj.name === "string" && obj.name.length > 0 ? obj.name : "New chat";
    const createdAt = typeof obj.created_at === "string" ? obj.created_at : new Date().toISOString();
    const lastUsedAt = typeof obj.last_activity_at === "string" ? obj.last_activity_at : createdAt;
    const activeAgent = typeof obj.active_agent === "string" ? obj.active_agent : null;
    const sessionUuid = typeof obj.session_uuid === "string" && UUID_RE.test(obj.session_uuid)
      ? obj.session_uuid
      : null;

    try {
      await opts.pool.query(
        `INSERT INTO chats (chat_id, username, session_id, name, active_agent, created_at, last_used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (chat_id) DO NOTHING`,
        [chatId, opts.username, sessionUuid, name, activeAgent, createdAt, lastUsedAt],
      );
      imported++;
    } catch {
      skipped++;
    }
  }

  await fs.mkdir(path.dirname(sentinel), { recursive: true });
  await fs.writeFile(sentinel, new Date().toISOString(), "utf8");

  return { imported, skipped };
}
