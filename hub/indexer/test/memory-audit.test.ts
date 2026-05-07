import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { writeUserMemory, forgetMemory } from "../src/memory-repo.js";

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

beforeEach(async () => {
  await pool.query("TRUNCATE memories CASCADE");
});

describe("memory_audit_log", () => {
  it("writeUserMemory produces exactly one audit row with action='write'", async () => {
    const name = "audit write test";
    const { memory_id } = await writeUserMemory({
      pool,
      username:    "alice",
      scope:       "user",
      project_dir: null,
      type:        "user",
      name,
      description: "an audited user memory",
      body:        "the body of the audited write",
    });
    expect(memory_id).not.toBeNull();

    const rows = await pool.query<{
      audit_id:  number;
      memory_id: string;
      actor:     string;
      action:    string;
      before:    unknown;
      after:     Record<string, unknown>;
    }>(
      `SELECT audit_id, memory_id, actor, action, before, after
         FROM memory_audit_log
        WHERE memory_id = $1`,
      [memory_id],
    );

    expect(rows.rowCount).toBe(1);
    const row = rows.rows[0]!;
    expect(row.action).toBe("write");
    expect(row.actor).toBe("alice");
    expect(row.memory_id).toBe(memory_id);
    expect(row.before).toBeNull();
    expect(row.after).not.toBeNull();
    expect(row.after.name).toBe(name);
  });

  it("forgetMemory produces an audit row with action='forget' and before.deleted_at=null", async () => {
    const name = "audit forget test";
    const { memory_id } = await writeUserMemory({
      pool,
      username:    "alice",
      scope:       "user",
      project_dir: null,
      type:        "user",
      name,
      description: "memory that will be forgotten",
      body:        "body to forget",
    });
    expect(memory_id).not.toBeNull();

    const res = await forgetMemory({ pool, username: "alice", memoryId: memory_id! });
    expect(res).toEqual({ ok: true });

    const rows = await pool.query<{
      audit_id:  number;
      memory_id: string;
      actor:     string;
      action:    string;
      before:    Record<string, unknown>;
      after:     unknown;
    }>(
      `SELECT audit_id, memory_id, actor, action, before, after
         FROM memory_audit_log
        WHERE memory_id = $1 AND action = 'forget'`,
      [memory_id],
    );

    expect(rows.rowCount).toBe(1);
    const row = rows.rows[0]!;
    expect(row.action).toBe("forget");
    expect(row.actor).toBe("alice");
    expect(row.memory_id).toBe(memory_id);
    expect(row.after).toBeNull();
    expect(row.before).not.toBeNull();
    expect(row.before.deleted_at).toBeNull();
    expect(row.before.name).toBe(name);
  });
});
