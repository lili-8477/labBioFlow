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

describe("real migrations apply cleanly", () => {
  it("applies 0001, 0002, 0003, 0004, 0005, 0006, 0007, 0008, 0009 against a fresh PG", async () => {
    await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });

    const v = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(v.rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const tables = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    );
    const names = tables.rows.map((r) => r.tablename);
    expect(names).toContain("sessions");
    expect(names).toContain("token_usage_log");
    expect(names).toContain("file_offsets");
    expect(names).toContain("chats");
    expect(names).toContain("memories");
    expect(names).toContain("memory_chunks");
    expect(names).toContain("memory_facets");
    expect(names).toContain("embedder_queue");
    expect(names).toContain("memory_distill_cursor");
    expect(names).toContain("memory_audit_log");
    expect(names).toContain("schema_migrations");

    // Verify FK constraint on token_usage_log.session_id exists.
    const fk = await pool.query(`
      SELECT conname FROM pg_constraint
      WHERE contype='f' AND conrelid = 'token_usage_log'::regclass
    `);
    expect(fk.rowCount).toBeGreaterThan(0);

    const idx = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND tablename='chats'
      ORDER BY indexname
    `);
    const idxNames = idx.rows.map((r) => r.indexname);
    expect(idxNames).toContain("chats_username_last_used_idx");
    expect(idxNames).toContain("chats_session_id_idx");
  });
});
