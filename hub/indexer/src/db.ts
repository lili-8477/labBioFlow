import type { Pool, PoolClient } from "pg";
import type { SessionUpsert, TokenUsageRow } from "./session-projector.js";

export interface OffsetWrite {
  username: string;
  jsonlPath: string;
  byteOffset: number;
  inode: number | null;
}

export interface CommitPassInput {
  sessionUpserts: SessionUpsert[];
  tokenRows: TokenUsageRow[];
  offset: OffsetWrite;
  /**
   * Session ids to DELETE before the upserts run. Used on the first chunk of
   * a reset pass (inode change or truncation) so stale aggregates from the
   * file's previous incarnation don't double-count. FK cascade on
   * token_usage_log.session_id cleans up the associated log rows.
   */
  resetSessionIds?: string[];
}

const UPSERT_SESSION_SQL = `
INSERT INTO sessions (
  session_id, username, encoded_project_dir, project_display, model,
  message_count, token_usage, first_active, last_active, is_sidechain, title
) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
ON CONFLICT (session_id) DO UPDATE SET
  username            = EXCLUDED.username,
  encoded_project_dir = EXCLUDED.encoded_project_dir,
  project_display     = COALESCE(EXCLUDED.project_display, sessions.project_display),
  model               = COALESCE(EXCLUDED.model, sessions.model),
  message_count       = sessions.message_count + EXCLUDED.message_count,
  token_usage         = jsonb_build_object(
      'input',       COALESCE((sessions.token_usage->>'input')::int, 0)
                   + COALESCE((EXCLUDED.token_usage->>'input')::int, 0),
      'output',      COALESCE((sessions.token_usage->>'output')::int, 0)
                   + COALESCE((EXCLUDED.token_usage->>'output')::int, 0),
      'cache_read',  COALESCE((sessions.token_usage->>'cache_read')::int, 0)
                   + COALESCE((EXCLUDED.token_usage->>'cache_read')::int, 0),
      'cache_write', COALESCE((sessions.token_usage->>'cache_write')::int, 0)
                   + COALESCE((EXCLUDED.token_usage->>'cache_write')::int, 0)
  ),
  first_active = COALESCE(sessions.first_active, EXCLUDED.first_active),
  last_active  = GREATEST(sessions.last_active, EXCLUDED.last_active),
  is_sidechain = sessions.is_sidechain OR EXCLUDED.is_sidechain,
  title        = COALESCE(EXCLUDED.title, sessions.title)
`;

const INSERT_TOKEN_SQL = `
INSERT INTO token_usage_log (
  username, session_id, entry_uuid, model,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (session_id, entry_uuid) DO NOTHING
`;

const UPSERT_OFFSET_SQL = `
INSERT INTO file_offsets (username, jsonl_path, byte_offset, inode, updated_at)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (username, jsonl_path) DO UPDATE SET
  byte_offset = EXCLUDED.byte_offset,
  inode       = EXCLUDED.inode,
  updated_at  = EXCLUDED.updated_at
`;

export async function commitPass(pool: Pool, input: CommitPassInput): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (input.resetSessionIds && input.resetSessionIds.length > 0) {
      await c.query(
        "DELETE FROM sessions WHERE session_id = ANY($1::uuid[])",
        [input.resetSessionIds],
      );
    }
    for (const s of input.sessionUpserts) {
      await upsertSession(c, s);
    }
    for (const r of input.tokenRows) {
      await insertToken(c, r);
    }
    await upsertOffset(c, input.offset);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

async function upsertSession(c: PoolClient, s: SessionUpsert): Promise<void> {
  await c.query(UPSERT_SESSION_SQL, [
    s.session_id,
    s.username,
    s.encoded_project_dir,
    s.project_display,
    s.model,
    s.message_count_delta,
    JSON.stringify(s.token_usage_delta),
    s.first_active_candidate,
    s.last_active,
    s.is_sidechain,
    s.title_candidate,
  ]);
}

async function insertToken(c: PoolClient, r: TokenUsageRow): Promise<void> {
  await c.query(INSERT_TOKEN_SQL, [
    r.username, r.session_id, r.entry_uuid, r.model,
    r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens,
    r.created_at,
  ]);
}

async function upsertOffset(c: PoolClient, o: OffsetWrite): Promise<void> {
  await c.query(UPSERT_OFFSET_SQL, [o.username, o.jsonlPath, o.byteOffset, o.inode]);
}

export async function readOffset(
  pool: Pool,
  username: string,
  jsonlPath: string,
): Promise<{ byteOffset: number; inode: number | null } | null> {
  const r = await pool.query(
    "SELECT byte_offset, inode FROM file_offsets WHERE username=$1 AND jsonl_path=$2",
    [username, jsonlPath],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  return {
    byteOffset: Number(row.byte_offset),
    inode: row.inode === null ? null : Number(row.inode),
  };
}
