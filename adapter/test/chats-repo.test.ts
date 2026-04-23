import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { applyIndexerMigrations } from "./helpers/apply-migrations.js";
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

beforeEach(async () => {
  await pool.query("DELETE FROM chats");
  await pool.query("DELETE FROM sessions");
});

describe("ChatsRepo", () => {
  it("create + read round-trip", async () => {
    const repo = new ChatsRepo(pool, "alice");
    const chatId = "11111111-1111-1111-1111-111111111111";
    await repo.create(chatId, "My first chat");
    const chat = await repo.read(chatId);
    expect(chat).not.toBeNull();
    expect(chat!.name).toBe("My first chat");
    expect(chat!.chat_id).toBe(chatId);
    expect(chat!.username).toBe("alice");
  });

  it("create is idempotent (ON CONFLICT DO NOTHING)", async () => {
    const repo = new ChatsRepo(pool, "alice");
    const chatId = "11111111-1111-1111-1111-111111111111";
    await repo.create(chatId, "first");
    await repo.create(chatId, "second");
    const chat = await repo.read(chatId);
    expect(chat!.name).toBe("first");
  });

  it("list returns only this tenant's chats, newest first", async () => {
    const alice = new ChatsRepo(pool, "alice");
    const bob = new ChatsRepo(pool, "bob");
    const c1 = "11111111-1111-1111-1111-111111111111";
    const c2 = "22222222-2222-2222-2222-222222222222";
    const c3 = "33333333-3333-3333-3333-333333333333";
    await alice.create(c1, "alice-older");
    await new Promise((r) => setTimeout(r, 10));
    await alice.create(c2, "alice-newer");
    await bob.create(c3, "bob-private");

    const list = await alice.list();
    expect(list.map((c) => c.id)).toEqual([c2, c1]);
    expect(list.every((c) => c.name.startsWith("alice-"))).toBe(true);
  });

  it("updateName updates name + last_used_at", async () => {
    const repo = new ChatsRepo(pool, "alice");
    const chatId = "11111111-1111-1111-1111-111111111111";
    await repo.create(chatId, "orig");
    const before = (await repo.read(chatId))!.last_used_at;
    await new Promise((r) => setTimeout(r, 10));
    await repo.updateName(chatId, "renamed");
    const after = await repo.read(chatId);
    expect(after!.name).toBe("renamed");
    expect(new Date(after!.last_used_at).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("setActiveAgent persists", async () => {
    const repo = new ChatsRepo(pool, "alice");
    const chatId = "11111111-1111-1111-1111-111111111111";
    await repo.create(chatId, "x");
    await repo.setActiveAgent(chatId, "scientist");
    const c = await repo.read(chatId);
    expect(c!.active_agent).toBe("scientist");
  });

  it("setSessionUuid updates mapping", async () => {
    const repo = new ChatsRepo(pool, "alice");
    const chatId = "11111111-1111-1111-1111-111111111111";
    const sessionId = "22222222-2222-2222-2222-222222222222";
    await repo.create(chatId, "x");
    await repo.setSessionUuid(chatId, sessionId);
    const c = await repo.read(chatId);
    expect(c!.session_id).toBe(sessionId);
  });

  it("delete removes the chat and cannot affect other tenants", async () => {
    const alice = new ChatsRepo(pool, "alice");
    const bob = new ChatsRepo(pool, "bob");
    const c1 = "11111111-1111-1111-1111-111111111111";
    await alice.create(c1, "alice-chat");
    await bob.delete(c1);
    const after = await alice.read(c1);
    expect(after).not.toBeNull();
    await alice.delete(c1);
    expect(await alice.read(c1)).toBeNull();
  });

  it("touch advances last_used_at without other changes", async () => {
    const repo = new ChatsRepo(pool, "alice");
    const chatId = "11111111-1111-1111-1111-111111111111";
    await repo.create(chatId, "x");
    const before = (await repo.read(chatId))!.last_used_at;
    await new Promise((r) => setTimeout(r, 10));
    await repo.touch(chatId);
    const after = (await repo.read(chatId))!.last_used_at;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("list joins sessions for project_display and is_sidechain filtering", async () => {
    const repo = new ChatsRepo(pool, "alice");
    const chatId = "11111111-1111-1111-1111-111111111111";
    const sessionId = "22222222-2222-2222-2222-222222222222";
    await repo.create(chatId, "x");
    await repo.setSessionUuid(chatId, sessionId);

    await pool.query(
      `INSERT INTO sessions (session_id, username, encoded_project_dir, project_display, is_sidechain)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, "alice", "-w-pbmc3k", "/w/pbmc3k", false],
    );
    const list = await repo.list();
    expect(list[0]!.project_name).toBe("/w/pbmc3k");

    await pool.query("UPDATE sessions SET is_sidechain = true WHERE session_id = $1", [sessionId]);
    const list2 = await repo.list();
    expect(list2).toHaveLength(0);
  });

  it("list prefers user-set name, falls back to session.title when name is generic", async () => {
    const repo = new ChatsRepo(pool, "alice");
    const genericChat = "11111111-1111-1111-1111-111111111111";
    const renamedChat = "22222222-2222-2222-2222-222222222222";
    const genericSession = "33333333-3333-3333-3333-333333333333";
    const renamedSession = "44444444-4444-4444-4444-444444444444";

    await repo.create(genericChat, "New chat");
    await repo.setSessionUuid(genericChat, genericSession);
    await pool.query(
      `INSERT INTO sessions (session_id, username, encoded_project_dir, title)
       VALUES ($1, 'alice', '-w', 'AI-derived title here')`,
      [genericSession],
    );

    await new Promise((r) => setTimeout(r, 5));
    await repo.create(renamedChat, "My pretty name");
    await repo.setSessionUuid(renamedChat, renamedSession);
    await pool.query(
      `INSERT INTO sessions (session_id, username, encoded_project_dir, title)
       VALUES ($1, 'alice', '-w', 'AI-derived unused title')`,
      [renamedSession],
    );

    const list = await repo.list();
    const renamed = list.find((c) => c.id === renamedChat);
    const generic = list.find((c) => c.id === genericChat);
    expect(renamed!.name).toBe("My pretty name");
    expect(generic!.name).toBe("AI-derived title here");
  });
});
