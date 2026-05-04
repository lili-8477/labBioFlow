import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { applyIndexerMigrations } from "./helpers/apply-migrations.js";
import { importSidecar } from "../src/sidecar-import.js";
import { ChatsRepo } from "../src/chats-repo.js";

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await applyIndexerMigrations(pool);
}, 90_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

describe("importSidecar", () => {
  it("imports valid sidecar files and writes a sentinel", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "adapter-imp-"));
    const chatsDir = path.join(workspaceRoot, ".claude", "chats");
    await mkdir(chatsDir, { recursive: true });

    await pool.query("DELETE FROM chats");

    const c1 = "11111111-1111-1111-1111-111111111111";
    const c2 = "22222222-2222-2222-2222-222222222222";
    const s2 = "33333333-3333-3333-3333-333333333333";
    await writeFile(
      path.join(chatsDir, `${c1}.json`),
      JSON.stringify({ id: c1, name: "orig-1", created_at: "2026-04-01T00:00:00Z", last_activity_at: "2026-04-02T00:00:00Z" }),
    );
    await writeFile(
      path.join(chatsDir, `${c2}.json`),
      JSON.stringify({ id: c2, name: "orig-2", created_at: "2026-04-01T00:00:00Z", last_activity_at: "2026-04-05T00:00:00Z", session_uuid: s2, active_agent: "scientist" }),
    );

    const result = await importSidecar({ pool, username: "alice", workspaceRoot });
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);

    const repo = new ChatsRepo(pool, "alice");
    const list = await repo.list();
    expect(list).toHaveLength(2);
    expect(list.find((c) => c.id === c2)!.active_agent).toBe("scientist");

    const c2Row = await repo.read(c2);
    expect(c2Row!.session_id).toBe(s2);

    const entries = await readdir(path.join(workspaceRoot, ".claude", "chats"));
    expect(entries).toContain(".imported");

    const second = await importSidecar({ pool, username: "alice", workspaceRoot });
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(0);
  });

  it("skips malformed json and reports it", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "adapter-imp-"));
    const chatsDir = path.join(workspaceRoot, ".claude", "chats");
    await mkdir(chatsDir, { recursive: true });

    await pool.query("DELETE FROM chats");

    await writeFile(path.join(chatsDir, "bad.json"), "{not-json");
    await writeFile(
      path.join(chatsDir, "44444444-4444-4444-4444-444444444444.json"),
      JSON.stringify({ id: "44444444-4444-4444-4444-444444444444", name: "good" }),
    );

    const result = await importSidecar({ pool, username: "alice", workspaceRoot });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("no sidecar dir → 0/0, sentinel still written", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "adapter-imp-"));
    await pool.query("DELETE FROM chats");
    const result = await importSidecar({ pool, username: "alice", workspaceRoot });
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
  });
});
