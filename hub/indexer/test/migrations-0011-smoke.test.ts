import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('migration 0011 share status auto_rejected', () => {
  let pgc: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    pgc = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = new Pool({ connectionString: pgc.getConnectionUri() });
    await runMigrations({
      pool,
      migrationsDir: path.resolve(HERE, '..', 'migrations'),
      lockKey: 0xdeadbeefn,
    });
  }, 60_000);
  afterAll(async () => { await pool.end(); await pgc.stop(); });

  it('accepts auto_rejected status', async () => {
    const r = await pool.query(
      `INSERT INTO share_requests (artifact_kind, artifact_ref, snapshot_meta,
                                   requester, reviewer, status)
       VALUES ('memory', 'x', '{}'::jsonb, 'alice', 'li86', 'auto_rejected')
       RETURNING share_id`,
    );
    expect(r.rowCount).toBe(1);
  });

  it('still rejects garbage status', async () => {
    await expect(pool.query(
      `INSERT INTO share_requests (artifact_kind, artifact_ref, snapshot_meta,
                                   requester, reviewer, status)
       VALUES ('memory', 'x', '{}'::jsonb, 'alice', 'li86', 'never-heard-of-it')`,
    )).rejects.toThrow(/share_requests_status_check/);
  });
});
