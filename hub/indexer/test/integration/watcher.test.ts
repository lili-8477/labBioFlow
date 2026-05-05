import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/migrate.js";
import { startWatcher } from "../../src/watcher.js";
import pino from "pino";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri(), max: 10 });
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

async function waitUntil(pred: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitUntil timed out");
}

describe("startWatcher", () => {
  it("picks up new files and live appends", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-w-"));
    const SID = "aaaaaaaa-0000-0000-0000-000000000001";
    const logger = pino({ level: "silent" });

    const handle = startWatcher({
      pool,
      watchRoot: root,
      maxConcurrentFiles: 4,
      maxPassBytes: 8 * 1024 * 1024,
      logger,
    });
    try {
      // Create file after watcher starts.
      const dir = path.join(root, "frank", ".claude", "claude-projects", "-w");
      await mkdir(dir, { recursive: true });
      const full = path.join(dir, `${SID}.jsonl`);
      await writeFile(full, JSON.stringify({
        type: "assistant", uuid: "aa000000-0000-0000-0000-000000000001", sessionId: SID,
        timestamp: "2026-04-22T10:00:00.000Z",
        message: { model: "m", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      }) + "\n");

      await waitUntil(async () => {
        const r = await pool.query("SELECT count(*)::int AS c FROM sessions WHERE session_id=$1", [SID]);
        return r.rows[0].c === 1;
      });

      await appendFile(full, JSON.stringify({
        type: "assistant", uuid: "aa000000-0000-0000-0000-000000000002", sessionId: SID,
        timestamp: "2026-04-22T10:00:01.000Z",
        message: { model: "m", usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      }) + "\n");

      await waitUntil(async () => {
        const r = await pool.query("SELECT message_count FROM sessions WHERE session_id=$1", [SID]);
        return r.rows[0]?.message_count === 2;
      });

      const s = await pool.query("SELECT token_usage FROM sessions WHERE session_id=$1", [SID]);
      expect(s.rows[0].token_usage).toEqual({ input: 4, output: 3, cache_read: 0, cache_write: 0 });
    } finally {
      await handle.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds files present at startup (backlog)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-w2-"));
    const SID = "aaaaaaaa-0000-0000-0000-000000000099";
    const logger = pino({ level: "silent" });
    const dir = path.join(root, "gwen", ".claude", "claude-projects", "-w");
    await mkdir(dir, { recursive: true });
    const full = path.join(dir, `${SID}.jsonl`);
    await writeFile(full, JSON.stringify({
      type: "user", uuid: "bb000000-0000-0000-0000-000000000001", sessionId: SID,
      timestamp: "2026-04-22T10:00:00.000Z", message: { content: "hi" },
    }) + "\n");

    const handle = startWatcher({
      pool,
      watchRoot: root,
      maxConcurrentFiles: 4,
      maxPassBytes: 8 * 1024 * 1024,
      logger,
    });
    try {
      await waitUntil(async () => {
        const r = await pool.query("SELECT count(*)::int AS c FROM sessions WHERE session_id=$1", [SID]);
        return r.rows[0].c === 1;
      });
    } finally {
      await handle.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
