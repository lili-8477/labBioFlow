import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { Pool, PoolClient } from "pg";

export interface MigrateOptions {
  pool: Pool;
  migrationsDir: string;
  lockKey: bigint;
}

export async function runMigrations(opts: MigrateOptions): Promise<void> {
  const client = await opts.pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [opts.lockKey.toString()]);
    try {
      await ensureTable(client);
      const applied = await currentVersions(client);
      const files = await listMigrationFiles(opts.migrationsDir);
      for (const { version, file } of files) {
        if (applied.has(version)) continue;
        const sql = await readFile(path.join(opts.migrationsDir, file), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations (version, applied_at) VALUES ($1, now())",
            [version],
          );
          await client.query("COMMIT");
        } catch (e) {
          // Best-effort rollback — if it throws, we still want to surface the
          // original migration error, not the cleanup failure.
          try { await client.query("ROLLBACK"); } catch { /* swallowed */ }
          throw e;
        }
      }
    } finally {
      // Best-effort unlock — session-level advisory locks auto-release on
      // connection close, so swallowing unlock errors here cannot leak a lock.
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [opts.lockKey.toString()]);
      } catch { /* swallowed */ }
    }
  } finally {
    client.release();
  }
}

async function ensureTable(c: PoolClient): Promise<void> {
  await c.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL
    )
  `);
}

async function currentVersions(c: PoolClient): Promise<Set<number>> {
  const r = await c.query("SELECT version FROM schema_migrations");
  return new Set(r.rows.map((row) => row.version as number));
}

async function listMigrationFiles(dir: string): Promise<Array<{ version: number; file: string }>> {
  const all = await readdir(dir);
  const out: Array<{ version: number; file: string }> = [];
  for (const f of all) {
    if (!f.endsWith(".sql")) continue;
    const m = /^(\d+)_/.exec(f);
    if (!m) continue;
    out.push({ version: Number(m[1]), file: f });
  }
  out.sort((a, b) => a.version - b.version);
  return out;
}
