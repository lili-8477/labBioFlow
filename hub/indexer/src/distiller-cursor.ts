import type { Pool } from "pg";

export async function getCursor(pool: Pool, username: string): Promise<Date> {
  const r = await pool.query<{ ts: Date }>(
    `SELECT last_seen_session_last_active AS ts
       FROM memory_distill_cursor WHERE username = $1`,
    [username],
  );
  if (r.rowCount === 0) return new Date("1970-01-01T00:00:00.000Z");
  return r.rows[0]!.ts;
}

export async function setCursor(
  pool: Pool,
  username: string,
  ts: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO memory_distill_cursor (username, last_seen_session_last_active)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE
       SET last_seen_session_last_active =
             GREATEST(memory_distill_cursor.last_seen_session_last_active, EXCLUDED.last_seen_session_last_active)`,
    [username, ts.toISOString()],
  );
}
