import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { commitPass, readOffset } from "../src/db.js";
import type { SessionUpsert, TokenUsageRow } from "../src/session-projector.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({
    pool,
    migrationsDir: MIGRATIONS_DIR,
    lockKey: 0x62696f666c77n,
  });
}, 90_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

const SID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TOKEN_UUID = (n: number): string =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

function upsert(overrides: Partial<SessionUpsert> = {}): SessionUpsert {
  return {
    session_id: SID,
    username: "alice",
    encoded_project_dir: "-w",
    project_display: "/w",
    model: "m",
    message_count_delta: 1,
    token_usage_delta: { input: 10, output: 2, cache_read: 0, cache_write: 0 },
    first_active_candidate: "2026-04-22T10:00:00.000Z",
    last_active: "2026-04-22T10:00:00.000Z",
    is_sidechain: false,
    title_candidate: null,
    ...overrides,
  };
}

function tokenRow(n: number, overrides: Partial<TokenUsageRow> = {}): TokenUsageRow {
  return {
    username: "alice",
    session_id: SID,
    entry_uuid: TOKEN_UUID(n),
    model: "m",
    input_tokens: 10,
    output_tokens: 2,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    created_at: "2026-04-22T10:00:00.000Z",
    ...overrides,
  };
}

describe("commitPass", () => {
  it("inserts session + tokens + offset atomically", async () => {
    await commitPass(pool, {
      sessionUpserts: [upsert()],
      tokenRows: [tokenRow(1)],
      offset: { username: "alice", jsonlPath: "/wp/a.jsonl", byteOffset: 123, inode: 42 },
    });

    const s = await pool.query("SELECT * FROM sessions WHERE session_id=$1", [SID]);
    expect(s.rowCount).toBe(1);
    expect(s.rows[0].message_count).toBe(1);
    expect(s.rows[0].token_usage).toEqual({ input: 10, output: 2, cache_read: 0, cache_write: 0 });

    const t = await pool.query("SELECT count(*)::int AS c FROM token_usage_log WHERE session_id=$1", [SID]);
    expect(t.rows[0].c).toBe(1);

    const off = await readOffset(pool, "alice", "/wp/a.jsonl");
    expect(off).toEqual({ byteOffset: 123, inode: 42 });
  });

  it("merges deltas on repeated session and deduplicates token rows", async () => {
    await commitPass(pool, {
      sessionUpserts: [upsert({
        message_count_delta: 2,
        token_usage_delta: { input: 5, output: 1, cache_read: 0, cache_write: 0 },
        last_active: "2026-04-22T10:00:10.000Z",
      })],
      tokenRows: [tokenRow(1), tokenRow(2, { input_tokens: 5, output_tokens: 1 })],
      offset: { username: "alice", jsonlPath: "/wp/a.jsonl", byteOffset: 200, inode: 42 },
    });

    const s = await pool.query("SELECT * FROM sessions WHERE session_id=$1", [SID]);
    expect(s.rows[0].message_count).toBe(3);
    expect(s.rows[0].token_usage).toEqual({ input: 15, output: 3, cache_read: 0, cache_write: 0 });

    // tokenRow(1) was already inserted in the previous test, so ON CONFLICT DO NOTHING: total = 2.
    const t = await pool.query("SELECT count(*)::int AS c FROM token_usage_log WHERE session_id=$1", [SID]);
    expect(t.rows[0].c).toBe(2);

    const off = await readOffset(pool, "alice", "/wp/a.jsonl");
    expect(off!.byteOffset).toBe(200);
  });

  it("readOffset returns null for unknown (username, path)", async () => {
    const r = await readOffset(pool, "alice", "/nonexistent.jsonl");
    expect(r).toBeNull();
  });

  it("rolls back the whole pass if a token insert fails", async () => {
    // Force a FK violation by using a session_id whose session row isn't in the upsert set.
    const rogue: TokenUsageRow = tokenRow(99, { session_id: "ffffffff-ffff-ffff-ffff-ffffffffffff" });
    await expect(commitPass(pool, {
      sessionUpserts: [upsert({ session_id: "cccccccc-cccc-cccc-cccc-cccccccccccc" })],
      tokenRows: [rogue],
      offset: { username: "alice", jsonlPath: "/wp/b.jsonl", byteOffset: 1, inode: 1 },
    })).rejects.toThrow();

    const s = await pool.query("SELECT count(*)::int AS c FROM sessions WHERE session_id=$1",
      ["cccccccc-cccc-cccc-cccc-cccccccccccc"]);
    expect(s.rows[0].c).toBe(0);
    const off = await readOffset(pool, "alice", "/wp/b.jsonl");
    expect(off).toBeNull();
  });
});
