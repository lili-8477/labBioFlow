import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
}, 90_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

describe("real migrations apply cleanly", () => {
  it("applies 0001, 0002, 0003 against a fresh PG", async () => {
    await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });

    const v = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(v.rows.map((r) => r.version)).toEqual([1, 2, 3]);

    const tables = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    );
    const names = tables.rows.map((r) => r.tablename);
    expect(names).toContain("sessions");
    expect(names).toContain("token_usage_log");
    expect(names).toContain("file_offsets");
    expect(names).toContain("schema_migrations");

    // Verify FK constraint on token_usage_log.session_id exists.
    const fk = await pool.query(`
      SELECT conname FROM pg_constraint
      WHERE contype='f' AND conrelid = 'token_usage_log'::regclass
    `);
    expect(fk.rowCount).toBeGreaterThan(0);
  });
});
