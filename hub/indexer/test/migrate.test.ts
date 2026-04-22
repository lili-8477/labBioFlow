import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runMigrations } from "../src/migrate.js";

let pg: StartedPostgreSqlContainer;
let url: string;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:16-alpine").start();
  url = pg.getConnectionUri();
}, 60_000);

afterAll(async () => {
  await pg?.stop();
}, 30_000);

describe("runMigrations", () => {
  it("applies sql files in order, records versions, and is idempotent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "migrations-"));
    try {
      await writeFile(path.join(dir, "0001_a.sql"), "CREATE TABLE a (id int);");
      await writeFile(path.join(dir, "0002_b.sql"), "CREATE TABLE b (id int);");

      const pool = new Pool({ connectionString: url });
      try {
        await runMigrations({ pool, migrationsDir: dir, lockKey: 0x1234n });

        const v = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
        expect(v.rows.map((r) => r.version)).toEqual([1, 2]);
        const t = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
        expect(t.rows.map((r) => r.tablename)).toContain("a");
        expect(t.rows.map((r) => r.tablename)).toContain("b");

        // Second run is a no-op (should not throw on duplicate CREATE TABLE).
        await runMigrations({ pool, migrationsDir: dir, lockKey: 0x1234n });
        const v2 = await pool.query("SELECT count(*)::int AS c FROM schema_migrations");
        expect(v2.rows[0].c).toBe(2);
      } finally {
        await pool.end();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent runs via advisory lock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "migrations-"));
    try {
      await writeFile(path.join(dir, "0001_c.sql"), "CREATE TABLE c (id int);");

      const p1 = new Pool({ connectionString: url });
      const p2 = new Pool({ connectionString: url });
      try {
        await Promise.all([
          runMigrations({ pool: p1, migrationsDir: dir, lockKey: 0x5678n }),
          runMigrations({ pool: p2, migrationsDir: dir, lockKey: 0x5678n }),
        ]);
        const v = await p1.query("SELECT count(*)::int AS c FROM schema_migrations WHERE version = 1");
        expect(v.rows[0].c).toBe(1);
      } finally {
        await p1.end();
        await p2.end();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
