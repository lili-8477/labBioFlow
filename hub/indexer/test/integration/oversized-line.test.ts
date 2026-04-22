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

describe("oversized-line skipping", () => {
  it("skips past a single line larger than maxPassBytes and ingests subsequent lines", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-os-"));
    const SID = "aaaaaaaa-0000-0000-0000-000000000abc";
    const dir = path.join(root, "hank", ".pantheon", "claude-projects", "-w");
    await mkdir(dir, { recursive: true });
    const full = path.join(dir, `${SID}.jsonl`);

    // Use a tiny maxPassBytes so we don't have to write megabytes to trigger
    // the oversized-line path.
    const MAX_PASS = 1024;

    // Build a single line whose total byte length exceeds MAX_PASS.
    const hugePayload = "x".repeat(MAX_PASS * 2);
    const hugeLine = JSON.stringify({
      type: "user",
      uuid: "11111111-1111-1111-1111-111111111111",
      sessionId: SID,
      timestamp: "2026-04-22T10:00:00.000Z",
      message: { content: hugePayload },
    }) + "\n";

    const normalLine = JSON.stringify({
      type: "assistant",
      uuid: "22222222-2222-2222-2222-222222222222",
      sessionId: SID,
      timestamp: "2026-04-22T10:00:01.000Z",
      message: {
        model: "m",
        usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }) + "\n";

    await writeFile(full, hugeLine + normalLine);

    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: MAX_PASS });

    // Exactly one message landed — the normal line. The huge one was parsed
    // and skipped (the huge line is itself valid JSON and would normally count
    // as 1 message, but we're asserting total=1 regardless: either the huge
    // line is consumed as part of a large chunk, or skipped. Either way, the
    // normal line MUST be reflected in the DB.)
    //
    // Under the fix, the huge line's slice [0, MAX_PASS) contains no newline,
    // so readChunk scans forward, finds the newline at the end of the huge
    // line, and commits that advance with empty upserts. The next iteration
    // parses the normal line. message_count = 1.
    const s = await pool.query("SELECT message_count, token_usage FROM sessions WHERE session_id=$1", [SID]);
    expect(s.rowCount).toBe(1);
    expect(s.rows[0].message_count).toBe(1);
    expect(s.rows[0].token_usage).toEqual({ input: 3, output: 2, cache_read: 0, cache_write: 0 });

    const t = await pool.query("SELECT count(*)::int AS c FROM token_usage_log WHERE session_id=$1", [SID]);
    expect(t.rows[0].c).toBe(1);

    // Offset advanced all the way to EOF.
    const off = await pool.query("SELECT byte_offset FROM file_offsets WHERE username=$1 AND jsonl_path=$2",
      ["hank", full]);
    expect(Number(off.rows[0].byte_offset)).toBe(hugeLine.length + normalLine.length);

    await rm(root, { recursive: true, force: true });
  });

  it("leaves offset stuck when the only content is a partial in-progress line at EOF", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-partial-"));
    const SID = "bbbbbbbb-0000-0000-0000-000000000abc";
    const dir = path.join(root, "ivy", ".pantheon", "claude-projects", "-w");
    await mkdir(dir, { recursive: true });
    const full = path.join(dir, `${SID}.jsonl`);

    // Partial JSON with no trailing newline — looks like a mid-write.
    await writeFile(full, '{"type":"user","uuid":"11111111-1111-1111-1111-111111111111","sessio');

    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 1024 });

    // No session row; no offset row (nothing committed).
    const s = await pool.query("SELECT count(*)::int AS c FROM sessions WHERE session_id=$1", [SID]);
    expect(s.rows[0].c).toBe(0);
    const off = await pool.query("SELECT count(*)::int AS c FROM file_offsets WHERE username=$1",
      ["ivy"]);
    expect(off.rows[0].c).toBe(0);

    await rm(root, { recursive: true, force: true });
  });
});
