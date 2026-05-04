import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtemp, mkdir, writeFile, rename, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/migrate.js";
import { processFile } from "../../src/process-file.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));
const UUID = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

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

describe("rotation", () => {
  it("resets offset when the file is replaced (inode changes)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-rot-"));
    const SID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const dir = path.join(root, "dan", ".claude", "claude-projects", "-w");
    await mkdir(dir, { recursive: true });
    const full = path.join(dir, `${SID}.jsonl`);

    const assistant = (uuid: string) => JSON.stringify({
      type: "assistant", uuid, sessionId: SID,
      timestamp: "2026-04-22T10:00:00.000Z",
      message: { model: "m", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + "\n";

    await writeFile(full, assistant(UUID(1)));
    const firstIno = (await stat(full)).ino;
    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    // Simulate rotation: stage a replacement elsewhere, then rename-into-place.
    // This reliably allocates a new inode (unlike unlink+create, which can
    // reuse the freed inode on ext4).
    const replacement = path.join(dir, `${SID}.jsonl.new`);
    await writeFile(replacement, assistant(UUID(2)));
    await rename(replacement, full);
    const secondIno = (await stat(full)).ino;
    expect(secondIno).not.toBe(firstIno);

    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    // After rotation the old token row is gone (FK cascade on sessions
    // DELETE) and the session row reflects only the new content.
    const r = await pool.query("SELECT count(*)::int AS c FROM token_usage_log WHERE session_id=$1", [SID]);
    expect(r.rows[0].c).toBe(1);
    const s = await pool.query("SELECT message_count, token_usage FROM sessions WHERE session_id=$1", [SID]);
    expect(s.rows[0].message_count).toBe(1);
    expect(s.rows[0].token_usage).toEqual({ input: 1, output: 1, cache_read: 0, cache_write: 0 });

    await rm(root, { recursive: true, force: true });
  });

  it("resets offset when the file is truncated (size < stored offset)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-trunc-"));
    const SID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const dir = path.join(root, "eve", ".claude", "claude-projects", "-w");
    await mkdir(dir, { recursive: true });
    const full = path.join(dir, `${SID}.jsonl`);

    const assistant = (uuid: string) => JSON.stringify({
      type: "assistant", uuid, sessionId: SID,
      timestamp: "2026-04-22T10:00:00.000Z",
      message: { model: "m", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + "\n";

    await writeFile(full, assistant(UUID(10)) + assistant(UUID(11)));
    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    // Truncate (same inode, smaller file).
    await writeFile(full, assistant(UUID(12)));
    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    // After truncation the two original token rows are cascaded away and
    // the session aggregates reflect only the post-truncation content.
    const r = await pool.query("SELECT count(*)::int AS c FROM token_usage_log WHERE session_id=$1", [SID]);
    expect(r.rows[0].c).toBe(1);
    const s = await pool.query("SELECT message_count, token_usage FROM sessions WHERE session_id=$1", [SID]);
    expect(s.rows[0].message_count).toBe(1);
    expect(s.rows[0].token_usage).toEqual({ input: 1, output: 1, cache_read: 0, cache_write: 0 });

    await rm(root, { recursive: true, force: true });
  });
});
