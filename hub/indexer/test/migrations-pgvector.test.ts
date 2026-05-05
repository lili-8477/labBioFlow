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
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

describe("migration 0006 — memories", () => {
  it("creates memories table with all columns and constraints", async () => {
    const cols = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'memories' ORDER BY ordinal_position`,
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
    expect(byName.memory_id).toMatchObject({ data_type: "uuid", is_nullable: "NO" });
    expect(byName.username).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(byName.project_dir).toMatchObject({ is_nullable: "YES" });
    expect(byName.type).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(byName.source).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(byName.content_hash).toMatchObject({ data_type: "bytea", is_nullable: "NO" });
    expect(byName.hit_count).toMatchObject({ data_type: "integer", is_nullable: "NO" });
    expect(byName.deleted_at).toMatchObject({ is_nullable: "YES" });
  });

  it("rejects unknown type via CHECK constraint", async () => {
    await expect(
      pool.query(
        `INSERT INTO memories (memory_id, username, type, source, name, description, body, content_hash)
         VALUES (gen_random_uuid(), 'alice', 'unknown', 'user', 'n', 'd', 'b', '\\x00'::bytea)`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("enforces UNIQUE(username, project_dir, type, content_hash)", async () => {
    const h = "\\xdeadbeef";
    await pool.query(
      `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'alice', '-w-p', 'observation', 'distilled', 'n', 'd', 'b', $1::bytea)`,
      [h],
    );
    const dup = await pool.query(
      `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'alice', '-w-p', 'observation', 'distilled', 'n2', 'd2', 'b2', $1::bytea)
       ON CONFLICT (username, project_dir, type, content_hash) DO NOTHING
       RETURNING memory_id`,
      [h],
    );
    expect(dup.rowCount).toBe(0);
  });

  it("dedups across NULL project_dir (user-scope memories)", async () => {
    const h = "\\xcafebabe";
    await pool.query(
      `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'bob', NULL, 'user', 'user', 'n', 'd', 'b', $1::bytea)`,
      [h],
    );
    const dup = await pool.query(
      `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'bob', NULL, 'user', 'user', 'n2', 'd2', 'b2', $1::bytea)
       ON CONFLICT (username, project_dir, type, content_hash) DO NOTHING
       RETURNING memory_id`,
      [h],
    );
    expect(dup.rowCount).toBe(0);
  });

  it("registers in schema_migrations as version 6", async () => {
    const v = await pool.query("SELECT version FROM schema_migrations WHERE version = 6");
    expect(v.rowCount).toBe(1);
  });
});
