import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { getCursor, setCursor } from "../src/distiller-cursor.js";

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
  await pool.query("DELETE FROM memory_distill_cursor");
});

describe("distiller-cursor", () => {
  it("returns 1970-01-01 when no row exists", async () => {
    const c = await getCursor(pool, "alice");
    expect(c.toISOString()).toBe("1970-01-01T00:00:00.000Z");
  });

  it("round-trips a set value", async () => {
    const t = new Date("2026-05-01T12:00:00.000Z");
    await setCursor(pool, "alice", t);
    const c = await getCursor(pool, "alice");
    expect(c.toISOString()).toBe(t.toISOString());
  });

  it("setCursor only advances forward (never moves back)", async () => {
    const a = new Date("2026-05-01T12:00:00.000Z");
    const b = new Date("2026-05-01T11:00:00.000Z");
    await setCursor(pool, "alice", a);
    await setCursor(pool, "alice", b);
    const c = await getCursor(pool, "alice");
    expect(c.toISOString()).toBe(a.toISOString());
  });

  it("isolates per-user", async () => {
    const t = new Date("2026-05-01T12:00:00.000Z");
    await setCursor(pool, "alice", t);
    const bob = await getCursor(pool, "bob");
    expect(bob.toISOString()).toBe("1970-01-01T00:00:00.000Z");
  });
});
