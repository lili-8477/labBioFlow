import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
}, 90_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

describe("migration 0009 memory_audit_log", () => {
  it("applies migrations through 0009 and creates memory_audit_log table with indexes and constraints", async () => {
    await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });

    // Verify migrations 1..9 are present (later migrations may be added on top
    // and that's fine — this test asserts the 0009 audit-log work landed).
    const v = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    const versions = v.rows.map((r) => r.version);
    for (const expected of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(versions).toContain(expected);
    }

    // Verify memory_audit_log table exists
    const tables = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='memory_audit_log'",
    );
    expect(tables.rowCount).toBe(1);

    // Verify the two indexes exist
    const idx = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename='memory_audit_log' ORDER BY indexname`,
    );
    const idxNames = idx.rows.map((r) => r.indexname).sort();
    expect(idxNames).toEqual(
      ['memory_audit_actor_idx', 'memory_audit_log_pkey', 'memory_audit_memory_idx'].sort()
    );

    // Verify action CHECK constraint exists with correct values
    const constraint = await pool.query(`
      SELECT pg_get_constraintdef(oid) as def
      FROM pg_constraint
      WHERE contype = 'c'
        AND conrelid = 'memory_audit_log'::regclass
    `);
    expect(constraint.rowCount).toBeGreaterThan(0);
    const constraintDef = constraint.rows[0].def;
    // PostgreSQL may translate "IN (...)" to "= ANY (ARRAY[...])", so check for the values
    expect(constraintDef).toContain("'write'");
    expect(constraintDef).toContain("'update'");
    expect(constraintDef).toContain("'forget'");
    expect(constraintDef).toContain("'restore'");

    // Verify FK constraint on memory_id exists
    const fk = await pool.query(`
      SELECT conname FROM pg_constraint
      WHERE contype='f' AND conrelid = 'memory_audit_log'::regclass
    `);
    expect(fk.rowCount).toBeGreaterThan(0);
  });
});
