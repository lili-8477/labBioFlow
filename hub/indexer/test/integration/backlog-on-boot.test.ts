import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
  pool = new Pool({ connectionString: pg.getConnectionUri(), max: 20 });
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

describe("backlog on boot", () => {
  it("pre-populates 50 JSONL files totalling 10k lines, processes them all", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-bl-"));
    const FILES = 50;
    const LINES_PER_FILE = 200; // 50 * 200 = 10_000

    const paths: string[] = [];
    for (let f = 0; f < FILES; f++) {
      const idx = String(f).padStart(2, "0");
      // Valid UUIDs: 8-4-4-4-12 hex chars each.
      const SID = `bbbb${idx}bb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`;
      const user = `u${idx}`;
      const dir = path.join(root, user, ".claude", "claude-projects", "-w");
      await mkdir(dir, { recursive: true });
      const full = path.join(dir, `${SID}.jsonl`);
      const lines: string[] = [];
      for (let k = 0; k < LINES_PER_FILE; k++) {
        lines.push(JSON.stringify({
          type: k % 2 === 0 ? "user" : "assistant",
          uuid: `${idx}${idx}${idx}${idx}-bbbb-bbbb-bbbb-${String(k).padStart(12, "0")}`,
          sessionId: SID,
          timestamp: `2026-04-22T${String(10 + Math.floor(k / 60)).padStart(2, "0")}:${String(k % 60).padStart(2, "0")}:00.000Z`,
          message: k % 2 === 0
            ? { content: "u" }
            : { model: "m", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        }));
      }
      await writeFile(full, lines.join("\n") + "\n");
      paths.push(full);
    }

    // Simulate boot: process every file once, like chokidar "add" would.
    for (const full of paths) {
      await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });
    }

    const s = await pool.query("SELECT count(*)::int AS c FROM sessions");
    expect(s.rows[0].c).toBe(FILES);
    const t = await pool.query("SELECT count(*)::int AS c FROM token_usage_log");
    expect(t.rows[0].c).toBe(FILES * LINES_PER_FILE / 2);
    const msg = await pool.query("SELECT SUM(message_count)::int AS total FROM sessions");
    expect(msg.rows[0].total).toBe(FILES * LINES_PER_FILE);

    await rm(root, { recursive: true, force: true });
  }, 120_000);
});
