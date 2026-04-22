import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/migrate.js";
import { processFile } from "../../src/process-file.js";
import { Semaphore } from "../../src/semaphore.js";

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

describe("concurrent files", () => {
  it("ingests 20 files in parallel with a semaphore bound of 4", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-conc-"));
    const sem = new Semaphore(4);
    const N = 20;
    const writes = Array.from({ length: N }, (_, i) => i);

    await Promise.all(writes.map(async (i) => {
      const idx = String(i).padStart(2, "0");
      // Valid UUID: 8-4-4-4-12 hex chars. Use the index byte to make each unique.
      const SID = `aaaa${idx}aa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
      const user = `user${idx}`;
      const dir = path.join(root, user, ".pantheon", "claude-projects", "-w");
      await mkdir(dir, { recursive: true });
      const full = path.join(dir, `${SID}.jsonl`);
      const lines = [];
      for (let k = 0; k < 5; k++) {
        lines.push(JSON.stringify({
          type: "assistant",
          uuid: `${idx}${idx}${idx}${idx}-aaaa-aaaa-aaaa-${String(k).padStart(12, "0")}`,
          sessionId: SID,
          timestamp: `2026-04-22T10:00:${String(k).padStart(2, "0")}.000Z`,
          message: { model: "m", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        }));
      }
      await writeFile(full, lines.join("\n") + "\n");
      await sem.run(() => processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 }));
    }));

    const s = await pool.query("SELECT count(*)::int AS c FROM sessions");
    expect(s.rows[0].c).toBe(N);
    const t = await pool.query("SELECT count(*)::int AS c FROM token_usage_log");
    expect(t.rows[0].c).toBe(N * 5);
    const o = await pool.query("SELECT count(*)::int AS c FROM file_offsets");
    expect(o.rows[0].c).toBe(N);

    await rm(root, { recursive: true, force: true });
  });
});
