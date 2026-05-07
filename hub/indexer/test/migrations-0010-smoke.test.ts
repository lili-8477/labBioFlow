// hub/indexer/test/migrations-0010-smoke.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('migration 0010 share_requests', () => {
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

  it('applies all 10 migrations and creates share_requests with constraints + indexes', async () => {
    const t = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name='share_requests'`,
    );
    expect(t.rowCount).toBe(1);

    const idx = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname='public' AND tablename='share_requests'
        ORDER BY indexname`,
    );
    expect(idx.rows.map(r => r.indexname).sort()).toEqual([
      'share_requests_pkey',
      'share_requests_requester_idx',
      'share_requests_reviewer_pending_idx',
      'share_requests_status_created_idx',
    ]);

    // CHECK constraint rejects bad kinds.
    await expect(pool.query(
      `INSERT INTO share_requests (artifact_kind, artifact_ref, snapshot_meta, requester, reviewer)
       VALUES ('garbage','x','{}','alice','li86')`,
    )).rejects.toThrow(/share_requests_artifact_kind_check/);

    // CHECK constraint rejects bad statuses.
    await expect(pool.query(
      `INSERT INTO share_requests (artifact_kind, artifact_ref, snapshot_meta, requester, reviewer, status)
       VALUES ('memory','x','{}','alice','li86','garbage')`,
    )).rejects.toThrow(/share_requests_status_check/);
  });
});
