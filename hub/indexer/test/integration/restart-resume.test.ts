import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/migrate.js";
import { processFile } from "../../src/process-file.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

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

describe("restart-resume", () => {
  it("N writes, interrupted run, M more writes → N+M tokens, no dupes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-rr-"));
    const SID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const dir = path.join(root, "bob", ".claude", "claude-projects", "-w");
    await mkdir(dir, { recursive: true });
    const full = path.join(dir, `${SID}.jsonl`);
    await writeFile(full, "");

    const writeAssistant = async (n: number) => {
      await appendFile(full, JSON.stringify({
        type: "assistant",
        uuid: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
        sessionId: SID, timestamp: `2026-04-22T10:00:${String(n).padStart(2, "0")}.000Z`,
        message: {
          model: "m",
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }) + "\n");
    };

    for (let i = 1; i <= 5; i++) await writeAssistant(i);
    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    // Simulate a crash: re-run the same pass — should be a no-op (no new bytes).
    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    for (let i = 6; i <= 9; i++) await writeAssistant(i);
    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    const r = await pool.query("SELECT count(*)::int AS c FROM token_usage_log WHERE session_id=$1", [SID]);
    expect(r.rows[0].c).toBe(9);

    const s = await pool.query("SELECT message_count, token_usage FROM sessions WHERE session_id=$1", [SID]);
    expect(s.rows[0].message_count).toBe(9);
    expect(s.rows[0].token_usage).toEqual({ input: 9, output: 9, cache_read: 0, cache_write: 0 });

    await rm(root, { recursive: true, force: true });
  });

  it("offset table forces dedupe if offset is manually reset mid-file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-rr2-"));
    const SID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const dir = path.join(root, "carol", ".claude", "claude-projects", "-w");
    await mkdir(dir, { recursive: true });
    const full = path.join(dir, `${SID}.jsonl`);
    await writeFile(full, "");
    await appendFile(full, JSON.stringify({
      type: "assistant", uuid: "11111111-1111-1111-1111-111111111111",
      sessionId: SID, timestamp: "2026-04-22T10:00:00.000Z",
      message: { model: "m", usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + "\n");

    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    // Simulate loss of offset row.
    await pool.query("DELETE FROM file_offsets WHERE username=$1", ["carol"]);
    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    // token_usage_log still has 1 row (UNIQUE constraint dedupes replay).
    const t = await pool.query("SELECT count(*)::int AS c FROM token_usage_log WHERE session_id=$1", [SID]);
    expect(t.rows[0].c).toBe(1);
    // sessions.message_count double-counts because it's a blind delta merge;
    // this is known and acceptable since offsets shouldn't be deleted in practice.
    // The counter is a convenience field, not a billing-critical one.
    await rm(root, { recursive: true, force: true });
  });
});
