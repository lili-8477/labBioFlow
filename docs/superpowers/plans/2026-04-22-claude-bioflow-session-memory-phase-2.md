# claude-bioflow Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Retire `adapter/src/sessions.ts` (JSON sidecar) and serve chat identity from Postgres; the frontend wire shape is unchanged.

**Architecture:** One new `chats` table (user-facing identity), indexer unchanged, adapter gains a `pg.Pool` wired via `PG_URL`+`USERNAME` env vars injected by `add-user.sh`. No new services, no new HTTP layer, no auth changes.

**Tech Stack:** Same as Phase 1 (TypeScript, pg, testcontainers, vitest).

**Spec reference:** `docs/superpowers/specs/2026-04-22-claude-bioflow-session-memory-phase-2-design.md`

---

## Task list overview

1. Migration 0004 — `chats` table (indexer package)
2. Adapter: add `pg` dep + `src/db-config.ts` env loader
3. Adapter: `src/chats-repo.ts` — typed repository + integration tests
4. Adapter: `src/sidecar-import.ts` — one-shot import + test
5. Adapter: rewire `list_chats` + `create_chat` + `delete_chat`
6. Adapter: rewire `update_chat_name` + `set_active_agent`
7. Adapter: rewire `get_chat_messages` + `runChat` (session_uuid + touch)
8. Adapter: `index.ts` wires pool lifecycle + importer bootstrap
9. Delete `adapter/src/sessions.ts`
10. `hub/scripts/add-user.sh` — inject `PG_URL` + `USERNAME` env
11. `docker-compose.dev.yml` — adapter joins `bioflow-net`, env vars
12. Final full-suite sanity + manual smoke

---

## Task 1: Migration 0004 — chats table

**Files:**
- Create: `hub/indexer/migrations/0004_chats.sql`
- Modify: `hub/indexer/test/migrations-smoke.test.ts`

- [ ] **Step 1: Create `migrations/0004_chats.sql`:**

```sql
CREATE TABLE chats (
  chat_id        UUID PRIMARY KEY,
  username       TEXT NOT NULL,
  session_id     UUID,
  name           TEXT NOT NULL DEFAULT 'New chat',
  active_agent   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

CREATE INDEX chats_username_last_used_idx
  ON chats (username, last_used_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX chats_session_id_idx
  ON chats (session_id) WHERE session_id IS NOT NULL;
```

- [ ] **Step 2: Extend `migrations-smoke.test.ts`.** The existing assertion lists four tables. Change `[sessions, token_usage_log, file_offsets, schema_migrations]` to `[chats, sessions, token_usage_log, file_offsets, schema_migrations]` and assert `SELECT version FROM schema_migrations ORDER BY version` returns `[1, 2, 3, 4]`.

- [ ] **Step 3: Run:** `cd hub/indexer && npx vitest run test/migrations-smoke.test.ts` → 1 pass.

- [ ] **Step 4: Commit:**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/migrations/0004_chats.sql hub/indexer/test/migrations-smoke.test.ts
git commit -m "feat(indexer): migration 0004 — chats table

Phase 2 storage for user-owned chat identity (chat_id, name, session_id
mapping). No FK to sessions — chats can exist before JSONL writes
produce a session row.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Adapter PG config loader

**Files:**
- Modify: `adapter/package.json` (add `pg`, `@types/pg`)
- Create: `adapter/src/db-config.ts`
- Create: `adapter/test/db-config.test.ts`

- [ ] **Step 1: Add dependencies.** In `adapter/package.json` add to `dependencies`: `"pg": "^8.13.1"`. To `devDependencies`: `"@types/pg": "^8.11.10"`, `"@testcontainers/postgresql": "^10.14.0"`, `"testcontainers": "^10.14.0"`. Run `cd adapter && npm install`.

- [ ] **Step 2: Failing test.** `adapter/test/db-config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadDbConfig } from "../src/db-config.js";

describe("loadDbConfig", () => {
  it("returns config when both PG_URL and USERNAME are set", () => {
    const cfg = loadDbConfig({ PG_URL: "postgres://u@h/d", USERNAME: "alice" });
    expect(cfg.pgUrl).toBe("postgres://u@h/d");
    expect(cfg.username).toBe("alice");
    expect(cfg.enabled).toBe(true);
  });

  it("returns enabled=false when PG_URL is missing", () => {
    const cfg = loadDbConfig({ USERNAME: "alice" });
    expect(cfg.enabled).toBe(false);
  });

  it("throws when PG_URL is set but USERNAME is missing", () => {
    expect(() => loadDbConfig({ PG_URL: "postgres://u@h/d" }))
      .toThrow(/USERNAME/);
  });

  it("rejects obviously-bogus usernames (path-traversal defense)", () => {
    expect(() => loadDbConfig({ PG_URL: "x", USERNAME: "../alice" }))
      .toThrow(/USERNAME/);
    expect(() => loadDbConfig({ PG_URL: "x", USERNAME: "" }))
      .toThrow(/USERNAME/);
  });
});
```

Run: `cd adapter && npx vitest run test/db-config.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `adapter/src/db-config.ts`:**

```ts
export interface DbConfig {
  enabled: boolean;
  pgUrl: string;
  username: string;
}

/**
 * Load PG_URL + USERNAME from env. Returns {enabled: false} when PG_URL is
 * absent so the adapter can boot without the hub postgres during early
 * dev/testing (no-op path). When PG_URL is set, USERNAME is required and
 * validated.
 */
export function loadDbConfig(env: Record<string, string | undefined> = process.env): DbConfig {
  const pgUrl = env.PG_URL;
  if (!pgUrl) return { enabled: false, pgUrl: "", username: "" };
  const username = env.USERNAME;
  if (!username) throw new Error("USERNAME is required when PG_URL is set");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(username)) {
    throw new Error(`USERNAME must match ^[a-z0-9][a-z0-9-]*$; got ${JSON.stringify(username)}`);
  }
  return { enabled: true, pgUrl, username };
}
```

Run tests → 4 pass.

- [ ] **Step 4: Commit:**

```bash
cd /home/lili/claude-bioflow
git add adapter/package.json adapter/package-lock.json adapter/src/db-config.ts adapter/test/db-config.test.ts
git commit -m "feat(adapter): PG config loader

Loads PG_URL + USERNAME from env, validates username shape, returns
{enabled: false} when PG_URL is absent so the adapter can still boot
against the old sidecar during the rollout window.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Adapter `ChatsRepo`

**Files:**
- Create: `adapter/src/chats-repo.ts`
- Create: `adapter/test/chats-repo.test.ts`

- [ ] **Step 0: Create `adapter/test/helpers/apply-migrations.ts`** so the adapter tests don't need to cross-import the indexer's TypeScript. This just reads the indexer's raw `.sql` files and runs them in order:

```ts
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../hub/indexer/migrations/", import.meta.url));

export async function applyIndexerMigrations(pool: Pool): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, f), "utf8");
    await pool.query(sql);
  }
}
```

- [ ] **Step 1: Failing test.** `adapter/test/chats-repo.test.ts`:

```ts
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
    await repo.create(chatId, "second");  // should not overwrite
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
    await bob.delete(c1); // bob tries to delete alice's chat
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

    // Insert a session row manually to simulate indexer output.
    await pool.query(
      `INSERT INTO sessions (session_id, username, encoded_project_dir, project_display, is_sidechain)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, "alice", "-w-pbmc3k", "/w/pbmc3k", false],
    );
    const list = await repo.list();
    expect(list[0]!.project_name).toBe("/w/pbmc3k");

    // Mark as sidechain → should disappear from list.
    await pool.query("UPDATE sessions SET is_sidechain = true WHERE session_id = $1", [sessionId]);
    const list2 = await repo.list();
    expect(list2).toHaveLength(0);
  });
});
```

Run: FAIL (module missing).

- [ ] **Step 2: Implement `adapter/src/chats-repo.ts`:**

```ts
import type { Pool } from "pg";

export interface ChatRow {
  chat_id: string;
  username: string;
  session_id: string | null;
  name: string;
  active_agent: string | null;
  created_at: string;
  last_used_at: string;
  deleted_at: string | null;
}

export interface ChatInfo {
  id: string;
  name: string;
  last_activity_date: string;
  project_name: string;
  active_agent: string | null;
}

/**
 * All chat CRUD for one tenant. Username is injected at construction and
 * every query filters on it — no path lets a crafted chat_id read or mutate
 * another tenant's data. This is the one and only query surface for chats
 * in the adapter.
 */
export class ChatsRepo {
  constructor(private pool: Pool, private username: string) {}

  async create(chatId: string, name: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO chats (chat_id, username, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (chat_id) DO NOTHING`,
      [chatId, this.username, name],
    );
  }

  async read(chatId: string): Promise<ChatRow | null> {
    const r = await this.pool.query(
      `SELECT chat_id, username, session_id, name, active_agent,
              created_at, last_used_at, deleted_at
       FROM chats
       WHERE chat_id = $1 AND username = $2 AND deleted_at IS NULL`,
      [chatId, this.username],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return {
      chat_id: row.chat_id,
      username: row.username,
      session_id: row.session_id,
      name: row.name,
      active_agent: row.active_agent,
      created_at: row.created_at.toISOString(),
      last_used_at: row.last_used_at.toISOString(),
      deleted_at: row.deleted_at ? row.deleted_at.toISOString() : null,
    };
  }

  async list(): Promise<ChatInfo[]> {
    const r = await this.pool.query(
      `SELECT
         c.chat_id        AS id,
         c.name           AS name,
         c.last_used_at   AS last_used_at,
         c.active_agent   AS active_agent,
         COALESCE(s.project_display, '') AS project_name
       FROM chats c
       LEFT JOIN sessions s ON s.session_id = c.session_id
       WHERE c.username = $1
         AND c.deleted_at IS NULL
         AND (s.is_sidechain IS DISTINCT FROM true)
       ORDER BY c.last_used_at DESC
       LIMIT 1000`,
      [this.username],
    );
    return r.rows.map((row) => ({
      id: row.id,
      name: row.name,
      last_activity_date: row.last_used_at.toISOString(),
      project_name: row.project_name,
      active_agent: row.active_agent,
    }));
  }

  async updateName(chatId: string, name: string): Promise<void> {
    await this.pool.query(
      `UPDATE chats SET name = $3, last_used_at = now()
       WHERE chat_id = $1 AND username = $2 AND deleted_at IS NULL`,
      [chatId, this.username, name],
    );
  }

  async setActiveAgent(chatId: string, agent: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE chats SET active_agent = $3
       WHERE chat_id = $1 AND username = $2 AND deleted_at IS NULL`,
      [chatId, this.username, agent],
    );
  }

  async setSessionUuid(chatId: string, sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE chats SET session_id = $3, last_used_at = now()
       WHERE chat_id = $1 AND username = $2 AND deleted_at IS NULL
         AND (session_id IS NULL OR session_id <> $3::uuid)`,
      [chatId, this.username, sessionId],
    );
  }

  async touch(chatId: string): Promise<void> {
    await this.pool.query(
      `UPDATE chats SET last_used_at = now()
       WHERE chat_id = $1 AND username = $2 AND deleted_at IS NULL`,
      [chatId, this.username],
    );
  }

  async delete(chatId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM chats WHERE chat_id = $1 AND username = $2`,
      [chatId, this.username],
    );
  }
}
```

Run tests: 8 pass.

- [ ] **Step 3: Commit:**

```bash
cd /home/lili/claude-bioflow
git add adapter/src/chats-repo.ts adapter/test/chats-repo.test.ts
git commit -m "feat(adapter): ChatsRepo — tenant-scoped chat CRUD

Every method filters on the constructor-injected username. No query path
exists that omits the tenant filter, so a crafted chat_id can't leak
another user's data.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Sidecar importer

**Files:**
- Create: `adapter/src/sidecar-import.ts`
- Create: `adapter/test/sidecar-import.test.ts`

- [ ] **Step 1: Failing test:**

```ts
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
    const chatsDir = path.join(workspaceRoot, ".pantheon", "chats");
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

    // Sentinel exists; re-run is a no-op.
    const entries = await readdir(path.join(workspaceRoot, ".pantheon"));
    expect(entries).toContain("chats.imported");

    const second = await importSidecar({ pool, username: "alice", workspaceRoot });
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(0);
  });

  it("skips malformed json and reports it", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "adapter-imp-"));
    const chatsDir = path.join(workspaceRoot, ".pantheon", "chats");
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
```

Run: FAIL.

- [ ] **Step 2: Implement `adapter/src/sidecar-import.ts`:**

```ts
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Pool } from "pg";

export interface ImportOptions {
  pool: Pool;
  username: string;
  workspaceRoot: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Best-effort one-shot import of legacy `.pantheon/chats/*.json` sidecar
 * files into the `chats` table. Writes a `.pantheon/chats.imported` sentinel
 * on completion so re-runs are no-ops. Idempotent via ON CONFLICT DO NOTHING.
 */
export async function importSidecar(opts: ImportOptions): Promise<ImportResult> {
  const sentinel = path.join(opts.workspaceRoot, ".pantheon", "chats.imported");
  try {
    await fs.stat(sentinel);
    return { imported: 0, skipped: 0 }; // already done
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const chatsDir = path.join(opts.workspaceRoot, ".pantheon", "chats");
  let files: string[] = [];
  try {
    files = await fs.readdir(chatsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  let imported = 0;
  let skipped = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const full = path.join(chatsDir, f);
    let raw: string;
    try {
      raw = await fs.readFile(full, "utf8");
    } catch {
      skipped++;
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      skipped++;
      continue;
    }
    const chatId = obj.id;
    if (typeof chatId !== "string" || !UUID_RE.test(chatId)) {
      skipped++;
      continue;
    }
    const name = typeof obj.name === "string" && obj.name.length > 0 ? obj.name : "New chat";
    const createdAt = typeof obj.created_at === "string" ? obj.created_at : new Date().toISOString();
    const lastUsedAt = typeof obj.last_activity_at === "string" ? obj.last_activity_at : createdAt;
    const activeAgent = typeof obj.active_agent === "string" ? obj.active_agent : null;
    const sessionUuid = typeof obj.session_uuid === "string" && UUID_RE.test(obj.session_uuid)
      ? obj.session_uuid
      : null;

    try {
      await opts.pool.query(
        `INSERT INTO chats (chat_id, username, session_id, name, active_agent, created_at, last_used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (chat_id) DO NOTHING`,
        [chatId, opts.username, sessionUuid, name, activeAgent, createdAt, lastUsedAt],
      );
      imported++;
    } catch {
      skipped++;
    }
  }

  await fs.mkdir(path.dirname(sentinel), { recursive: true });
  await fs.writeFile(sentinel, new Date().toISOString(), "utf8");

  return { imported, skipped };
}
```

Run tests: 3 pass.

- [ ] **Step 3: Commit:**

```bash
cd /home/lili/claude-bioflow
git add adapter/src/sidecar-import.ts adapter/test/sidecar-import.test.ts
git commit -m "feat(adapter): one-shot sidecar importer

Imports legacy .pantheon/chats/*.json files into the chats table on
first boot after Phase 2 upgrade. Writes a .pantheon/chats.imported
sentinel so subsequent boots are no-ops. Idempotent via ON CONFLICT.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Rewire `list_chats` + `create_chat` + `delete_chat`

**Files:**
- Modify: `adapter/src/rpc.ts`

This and Tasks 6–7 rewire the 8 `this.sessions.*` call sites in `rpc.ts`. `sessions.ts` stays on disk until Task 9 (kept compilable so the old sidecar path keeps working until we remove it); `rpc.ts` switches to `ChatsRepo` unconditionally — once `db-config.ts` says `enabled`, or crash with a clear error if it doesn't (Phase 2 is a cutover, not a dual-write).

- [ ] **Step 1: Modify the `RpcRouter` constructor.** In `adapter/src/rpc.ts` find:

```ts
import { SessionStore } from "./sessions.js";
```

Replace with:

```ts
import { ChatsRepo } from "./chats-repo.js";
```

Find:

```ts
export class RpcRouter {
  private sessions: SessionStore;
  private files: FileManager;
  private notebooks: NotebookManager;
  private kernel: KernelBridge;
  private mutexes = new ChatMutexRegistry();
  private aborts = new AbortRegistry();

  constructor(private deps: RpcDeps) {
    this.sessions = new SessionStore(deps.workspaceRoot);
    this.files = new FileManager(deps.workspaceRoot);
```

Replace with:

```ts
export class RpcRouter {
  private chats: ChatsRepo;
  private files: FileManager;
  private notebooks: NotebookManager;
  private kernel: KernelBridge;
  private mutexes = new ChatMutexRegistry();
  private aborts = new AbortRegistry();

  constructor(private deps: RpcDeps) {
    if (!deps.chats) throw new Error("RpcRouter requires deps.chats (PG-backed ChatsRepo)");
    this.chats = deps.chats;
    this.files = new FileManager(deps.workspaceRoot);
```

Also extend `RpcDeps`. Find:

```ts
export interface RpcDeps {
  serviceId: string;
  workspaceRoot: string;
```

Replace with:

```ts
export interface RpcDeps {
  serviceId: string;
  workspaceRoot: string;
  chats: import("./chats-repo.js").ChatsRepo;
```

- [ ] **Step 2: Rewire `list_chats`.** Find:

```ts
      case "list_chats": {
        const chats = await this.sessions.list();
        chats.sort((a, b) => (b.last_activity_date ?? "").localeCompare(a.last_activity_date ?? ""));
        return { success: true, chats };
      }
```

Replace with:

```ts
      case "list_chats": {
        const chats = await this.chats.list(); // already ORDER BY last_used_at DESC
        return { success: true, chats };
      }
```

- [ ] **Step 3: Rewire `create_chat`.** Find:

```ts
      case "create_chat": {
        const name = params.chat_name as string | undefined;
        const s = await this.sessions.create(name);
        return { success: true, chat_id: s.id };
      }
```

Replace with:

```ts
      case "create_chat": {
        const name = (params.chat_name as string | undefined) ?? "New chat";
        const chatId = crypto.randomUUID();
        await this.chats.create(chatId, name);
        return { success: true, chat_id: chatId };
      }
```

Also add at the top of the file (after other imports):

```ts
import crypto from "node:crypto";
```

- [ ] **Step 4: Rewire `delete_chat`.** Find:

```ts
      case "delete_chat": {
        const chatId = params.chat_id as string;
        await this.sessions.delete(chatId);
        this.mutexes.delete(chatId);
        return { success: true };
      }
```

Replace with:

```ts
      case "delete_chat": {
        const chatId = params.chat_id as string;
        await this.chats.delete(chatId);
        this.mutexes.delete(chatId);
        return { success: true };
      }
```

- [ ] **Step 5: Typecheck.** `cd adapter && npm run typecheck` — expect type errors only at the sites Tasks 6–7 haven't touched yet (they still reference `this.sessions`). Don't commit yet — go to Task 6.

---

## Task 6: Rewire `update_chat_name` + `set_active_agent`

- [ ] **Step 1: Rewire `update_chat_name`.** In `adapter/src/rpc.ts` find:

```ts
      case "update_chat_name": {
        const chatId = params.chat_id as string;
        const name = params.chat_name as string;
        await this.sessions.update(chatId, { name });
        return { success: true };
      }
```

Replace with:

```ts
      case "update_chat_name": {
        const chatId = params.chat_id as string;
        const name = params.chat_name as string;
        await this.chats.updateName(chatId, name);
        return { success: true };
      }
```

- [ ] **Step 2: Rewire `set_active_agent`.** Find:

```ts
      case "set_active_agent": {
        const chatId = (params.chat_name as string) || (params.chat_id as string);
        const agentName = params.agent_name as string;
        await this.sessions.update(chatId, { active_agent: agentName });
        return { success: true };
      }
```

Replace with:

```ts
      case "set_active_agent": {
        const chatId = (params.chat_name as string) || (params.chat_id as string);
        const agentName = params.agent_name as string;
        await this.chats.setActiveAgent(chatId, agentName);
        return { success: true };
      }
```

Typecheck will still fail on `get_chat_messages` + `runChat` — proceed to Task 7.

---

## Task 7: Rewire `get_chat_messages` + `runChat`

- [ ] **Step 1: Rewire `get_chat_messages`.** Find:

```ts
      case "get_chat_messages": {
        const chatId = params.chat_id as string;
        const sidecar = await this.sessions.read(chatId);
        // Use the real SDK session UUID if we have one, else fall back to chat_id.
        const sessionUuid = sidecar?.session_uuid ?? chatId;
        const messages = await readSessionMessages(
          this.deps.home,
          this.deps.defaultProjectCwd,
          sessionUuid,
        );
        return { success: true, messages };
      }
```

Replace with:

```ts
      case "get_chat_messages": {
        const chatId = params.chat_id as string;
        const chat = await this.chats.read(chatId);
        // Use the real SDK session UUID if we have one, else fall back to chat_id.
        const sessionUuid = chat?.session_id ?? chatId;
        const messages = await readSessionMessages(
          this.deps.home,
          this.deps.defaultProjectCwd,
          sessionUuid,
        );
        return { success: true, messages };
      }
```

- [ ] **Step 2: Rewire `runChat`.** Find:

```ts
  private async runChat(chatId: string, prompt: string): Promise<unknown> {
    const sidecar = await this.sessions.read(chatId);
    if (!sidecar) throw new Error(`chat not found: ${chatId}`);

    const mutex = this.mutexes.get(chatId);
    const run = mutex.tryRun(async () => {
      const ac = this.aborts.register(chatId);
      try {
        await runTurn({
          chatId,
          prompt,
          cwd: this.deps.defaultProjectCwd,
          // Resume only if we've already captured a real SDK session UUID.
          resumeSessionId: sidecar.session_uuid,
          signal: ac.signal,
          onEvent: (ev) => this.deps.publishStream(`chat_${chatId}`, ev),
          onSessionId: (sessionId) => {
            // Fire-and-forget — stash the real session UUID so next resume works.
            this.sessions.update(chatId, { session_uuid: sessionId }).catch((e) => {
              console.warn(`[rpc] failed to stash session_uuid for ${chatId}:`, e);
            });
          },
        });
        await this.sessions.touch(chatId);
      } finally {
        this.aborts.clear(chatId);
      }
      return { success: true };
    });

    if (run === null) {
      throw new Error(`chat ${chatId} is already streaming a turn`);
    }
    return await run;
  }
```

Replace with:

```ts
  private async runChat(chatId: string, prompt: string): Promise<unknown> {
    const chat = await this.chats.read(chatId);
    if (!chat) throw new Error(`chat not found: ${chatId}`);

    const mutex = this.mutexes.get(chatId);
    const run = mutex.tryRun(async () => {
      const ac = this.aborts.register(chatId);
      try {
        await runTurn({
          chatId,
          prompt,
          cwd: this.deps.defaultProjectCwd,
          // Resume only if we've already captured a real SDK session UUID.
          resumeSessionId: chat.session_id ?? undefined,
          signal: ac.signal,
          onEvent: (ev) => this.deps.publishStream(`chat_${chatId}`, ev),
          onSessionId: (sessionId) => {
            // Fire-and-forget — stash the real session UUID so next resume works.
            this.chats.setSessionUuid(chatId, sessionId).catch((e) => {
              console.warn(`[rpc] failed to stash session_uuid for ${chatId}:`, e);
            });
          },
        });
        await this.chats.touch(chatId);
      } finally {
        this.aborts.clear(chatId);
      }
      return { success: true };
    });

    if (run === null) {
      throw new Error(`chat ${chatId} is already streaming a turn`);
    }
    return await run;
  }
```

- [ ] **Step 3: Typecheck.** `cd adapter && npm run typecheck` — expect exit 0. rpc.ts no longer references `SessionStore` or `this.sessions`.

- [ ] **Step 4: Commit Tasks 5–7 together** (one logical rewire):

```bash
cd /home/lili/claude-bioflow
git add adapter/src/rpc.ts
git commit -m "feat(adapter): rewire all chat RPCs from sidecar to ChatsRepo

list_chats, create_chat, delete_chat, update_chat_name, set_active_agent,
get_chat_messages, and runChat now read/write chats via Postgres. The
sidecar file is no longer consulted on any path. sessions.ts is kept
compilable for one more commit so git history bisects cleanly across
the cutover.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `index.ts` — wire pool + importer bootstrap

**Files:**
- Modify: `adapter/src/index.ts`

Read `adapter/src/index.ts` to find the shape. It currently constructs `RpcRouter` somewhere. Before that construction, we must:

1. Load `db-config`.
2. If `enabled: false`, throw — Phase 2 is a cutover.
3. Create `pg.Pool`.
4. Wait for PG (up to 60s, exponential backoff).
5. Run the sidecar importer (fire-and-forget-with-log).
6. Construct `ChatsRepo`.
7. Pass to `new RpcRouter({...existingDeps, chats})`.
8. On shutdown, `pool.end()`.

- [ ] **Step 1: Read `adapter/src/index.ts`** to see the existing construction site.

- [ ] **Step 2: Add imports at the top of index.ts:**

```ts
import { Pool } from "pg";
import { loadDbConfig } from "./db-config.js";
import { ChatsRepo } from "./chats-repo.js";
import { importSidecar } from "./sidecar-import.js";
```

- [ ] **Step 3: Before `new RpcRouter(...)`, add the wiring block.** Paste (adjust variable names to match local code):

```ts
  const dbCfg = loadDbConfig();
  if (!dbCfg.enabled) {
    console.error("[adapter] PG_URL is required in Phase 2. Refusing to boot.");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: dbCfg.pgUrl, max: 10 });
  await waitForPg(pool, 60);

  // Best-effort one-shot import of legacy sidecar files.
  importSidecar({ pool, username: dbCfg.username, workspaceRoot })
    .then((r) => console.log(`[adapter] sidecar import: imported=${r.imported} skipped=${r.skipped}`))
    .catch((err) => console.warn("[adapter] sidecar import failed:", err));

  const chatsRepo = new ChatsRepo(pool, dbCfg.username);
```

- [ ] **Step 4: Pass `chats: chatsRepo` into the `new RpcRouter(...)` call** alongside the other deps.

- [ ] **Step 5: Add `waitForPg` helper at the bottom of the file** (or adjust the existing shutdown block). If no existing helper:

```ts
async function waitForPg(pool: import("pg").Pool, maxSec: number): Promise<void> {
  const deadline = Date.now() + maxSec * 1000;
  let delay = 500;
  while (Date.now() < deadline) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 10_000);
    }
  }
  throw new Error(`PG unreachable after ${maxSec}s`);
}
```

- [ ] **Step 6: On shutdown / signal handler,** call `await pool.end()`.

- [ ] **Step 7: Typecheck + build.** `cd adapter && npm run typecheck && npm run build` — both clean.

- [ ] **Step 8: Commit:**

```bash
cd /home/lili/claude-bioflow
git add adapter/src/index.ts
git commit -m "feat(adapter): wire PG pool + sidecar importer into entrypoint

Loads PG_URL/USERNAME, waits for PG, kicks off a best-effort one-shot
sidecar import, constructs ChatsRepo, and passes it into the RpcRouter.
The adapter now refuses to boot without PG_URL — Phase 2 is a cutover,
not a dual-write.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Delete `adapter/src/sessions.ts`

**Files:**
- Delete: `adapter/src/sessions.ts`
- Modify (maybe): `adapter/src/types.ts` if it re-exports the sidecar type

- [ ] **Step 1: Grep for residual references.** `rg -n "SessionStore|sessions\.ts|ChatSidecar" adapter/src adapter/test` — expect zero matches outside `adapter/src/sessions.ts` itself. If `ChatSidecar` is referenced in `types.ts`, remove it.

- [ ] **Step 2: Delete the file.** `rm adapter/src/sessions.ts`.

- [ ] **Step 3: Build + typecheck + test.** `cd adapter && npm run typecheck && npm run build && npm test`.

- [ ] **Step 4: Commit:**

```bash
cd /home/lili/claude-bioflow
git add -A adapter/src/sessions.ts adapter/src/types.ts
git commit -m "feat(adapter): remove sessions.ts sidecar module

All callers migrated to ChatsRepo. .pantheon/chats/*.json files are now
imported on first Phase-2 boot (one-shot) and ignored thereafter.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: `add-user.sh` — inject `PG_URL` + `USERNAME`

**Files:**
- Modify: `hub/scripts/add-user.sh`

- [ ] **Step 1: Read `hub/scripts/add-user.sh` around the docker run invocation (line ~185–196).** Note the `-e` env flags already in place.

- [ ] **Step 2: Add three new env vars to the `docker run` command:**

```bash
    -e "PG_URL=postgres://bioflow:${POSTGRES_PASSWORD}@claude-bioflow-postgres:5432/bioflow" \
    -e "USERNAME=${USERNAME}" \
    -e "SIDECAR_IMPORT_ON_BOOT=1" \
```

Place them alongside the existing `-e "ID_HASH=..."` lines.

- [ ] **Step 3: Ensure `ensure_hub_env` runs first** (already does as of Phase 1 Task 20 — the POSTGRES_PASSWORD env comes from `${HUB_DIR}/.env`, which the shell has loaded into its environment before this point via `set -a; . hub/.env; set +a` OR by the fact that `ensure_hub_env` writes to the file that `docker compose` reads later).

  Check if `add-user.sh` currently sources `$HUB_DIR/.env` into its own shell. If not, add a `set -a; . "${ENV_FILE}"; set +a` line right after `ensure_hub_env`, so `${POSTGRES_PASSWORD}` is available in the `-e` substitution below.

- [ ] **Step 4: Ensure the user container joins `bioflow-net`.** Already does (line 187: `--network "${NETWORK}"` where `NETWORK="claude-bioflow_bioflow-net"`). Good.

- [ ] **Step 5: Sanity.** `bash -n hub/scripts/add-user.sh` — parses clean. `./hub/scripts/add-user.sh --help` — prints.

- [ ] **Step 6: Commit:**

```bash
cd /home/lili/claude-bioflow
git add hub/scripts/add-user.sh
git commit -m "feat(hub): inject PG_URL + USERNAME into user containers

add-user.sh now sources hub/.env for POSTGRES_PASSWORD and passes
PG_URL + USERNAME (+ SIDECAR_IMPORT_ON_BOOT=1 for the first run) as
docker run -e flags. Container already joins bioflow-net.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Dev compose — adapter joins `bioflow-net` with PG env

**Files:**
- Modify: `docker-compose.dev.yml`

- [ ] **Step 1: Read the existing `docker-compose.dev.yml`** to see how the `adapter` service is defined and whether it's on `bioflow-net` or an isolated network.

- [ ] **Step 2: Add to the adapter service's `environment:`:**

```yaml
      PG_URL: "postgres://bioflow:${POSTGRES_PASSWORD}@postgres:5432/bioflow"
      USERNAME: "devuser"
      SIDECAR_IMPORT_ON_BOOT: "1"
```

- [ ] **Step 3: Add to the adapter service's `depends_on:`:**

```yaml
    depends_on:
      postgres:
        condition: service_healthy
```

- [ ] **Step 4: If the adapter service isn't already on `bioflow-net`,** add it to the networks list. If the dev compose uses a single default network, move postgres + indexer onto it by REMOVING their network-specific settings (the default network connects all services).

- [ ] **Step 5: Lint.** `docker compose -f docker-compose.dev.yml config > /dev/null` — exit 0.

- [ ] **Step 6: Commit:**

```bash
cd /home/lili/claude-bioflow
git add docker-compose.dev.yml
git commit -m "feat(dev): dev adapter reaches PG via the shared dev network

Adds PG_URL + USERNAME (devuser) + SIDECAR_IMPORT_ON_BOOT=1 to the
adapter service and depends_on postgres:healthy so Phase 2 works in
the dev stack.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Final sanity + smoke

- [ ] **Step 1: Full test suite.** `cd hub/indexer && npm test` (indexer), `cd adapter && npm test` (adapter). Both green.

- [ ] **Step 2: Compose stack sanity.**

```bash
cd /home/lili/claude-bioflow
docker compose -f docker-compose.dev.yml up -d --build postgres indexer adapter
sleep 8
docker compose -f docker-compose.dev.yml logs adapter --tail=30
# Look for: "[adapter] sidecar import: imported=N skipped=M"
docker compose -f docker-compose.dev.yml exec postgres \
  psql -U bioflow -d bioflow -c "SELECT chat_id, name, session_id FROM chats LIMIT 10;"
```

- [ ] **Step 3: Tear down.** `docker compose -f docker-compose.dev.yml down`.

- [ ] **Step 4: (Optional) Manual frontend smoke.** Bring up the full stack including nginx + frontend, click "New chat", send a message, reload browser, confirm the chat appears.

- [ ] **Step 5: No final commit — Task 12 is verification only.**

---

## Spec coverage cross-check

| Spec section | Task(s) |
|---|---|
| §4 Architecture | 2, 8, 10 |
| §5.1 migration 0004 | 1 |
| §5.2 sessions title — **deferred per §7.2** | (none; Phase 3) |
| §5.3 list_chats join query | 3 |
| §6.1 file tree | 2, 3, 4, 8, 9 |
| §6.2 RPC rewire table | 5, 6, 7 |
| §6.3 PG_URL provisioning | 10 |
| §6.4 username tenant key | 2, 3 |
| §6.5 sidecar importer | 4, 8 |
| §7 indexer changes — **§7.2 skipped** | — |
| §8 error handling (PG wait, tenant guard, malformed import) | 2, 3, 4, 8 |
| §9 testing | 1, 3, 4, 12 |
| §10 configuration | 2, 10, 11 |
| §11 rollout — **§11 flag pattern simplified to cutover** | 8 |
| §12 phase boundary verify | 12 |
