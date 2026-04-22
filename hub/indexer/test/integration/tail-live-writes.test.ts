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
let root: string;

function line(o: Record<string, unknown>): string { return JSON.stringify(o) + "\n"; }

const SID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SID2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

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

async function setupFile(): Promise<{ full: string; root: string }> {
  root = await mkdtemp(path.join(os.tmpdir(), "indexer-"));
  const dir = path.join(root, "alice", ".pantheon", "claude-projects", "-w");
  await mkdir(dir, { recursive: true });
  const full = path.join(dir, `${SID}.jsonl`);
  await writeFile(full, "");
  return { full, root };
}

describe("processFile", () => {
  it("ingests appended lines and advances the offset", async () => {
    const { full } = await setupFile();
    await appendFile(full, line({
      type: "user", uuid: "00000000-0000-0000-0000-000000000001", sessionId: SID,
      timestamp: "2026-04-22T10:00:00.000Z",
      message: { content: "hi" },
    }));
    await appendFile(full, line({
      type: "assistant", uuid: "00000000-0000-0000-0000-000000000002", sessionId: SID,
      timestamp: "2026-04-22T10:00:01.000Z",
      message: {
        model: "m",
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }));

    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    const s = await pool.query("SELECT * FROM sessions WHERE session_id=$1", [SID]);
    expect(s.rows[0].message_count).toBe(2);
    expect(s.rows[0].token_usage).toEqual({ input: 10, output: 2, cache_read: 0, cache_write: 0 });

    // Append more; second pass picks up only the new bytes.
    await appendFile(full, line({
      type: "assistant", uuid: "00000000-0000-0000-0000-000000000003", sessionId: SID,
      timestamp: "2026-04-22T10:00:02.000Z",
      message: {
        model: "m",
        usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }));

    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    const s2 = await pool.query("SELECT * FROM sessions WHERE session_id=$1", [SID]);
    expect(s2.rows[0].message_count).toBe(3);
    expect(s2.rows[0].token_usage).toEqual({ input: 15, output: 3, cache_read: 0, cache_write: 0 });

    await rm(root, { recursive: true, force: true });
  });

  it("handles a mid-write truncated last line by only committing complete lines", async () => {
    const { full, root: r2 } = await setupFile();
    await appendFile(full, line({
      type: "user", uuid: "00000000-0000-0000-0000-000000001001", sessionId: SID2,
      timestamp: "2026-04-22T10:00:00.000Z",
      message: {},
    }));
    // Partial JSON with no trailing newline.
    await appendFile(full, '{"type":"user","uuid":"00000000-0000-0000-0000-000000001002","sessionId":"bbbb');

    await processFile({ pool, watchRoot: r2, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    const s = await pool.query("SELECT message_count FROM sessions WHERE session_id=$1", [SID2]);
    expect(s.rows[0].message_count).toBe(1);
    await rm(r2, { recursive: true, force: true });
  });
});
