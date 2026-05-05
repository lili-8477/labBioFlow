# Agent memory — sub-phase A (silent distillation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land server-side distillation of settled Claude Code sessions into typed, embedded `memories` rows in the existing Postgres, with zero user-visible change. After this lands, `SELECT type, COUNT(*) FROM memories GROUP BY 1` shows populated rows for any session that has been idle ≥5 minutes.

**Architecture:** Extends `hub/indexer/` with a second loop alongside the existing JSONL watcher: a *distiller* that polls Postgres for newly-settled sessions, streams their JSONL via Phase 1's path helpers, sends the transcript to `claude-haiku-4-5` for structured extraction, and writes `memories` + `memory_chunks` + `memory_facets` rows in one transaction. A new `hub/embedder/` Python sidecar exposes `bge-small-en-v1.5` over HTTP; an in-indexer worker drains the `embedder_queue` and fills `embedding` columns asynchronously. No new HTTP API for users yet (that's sub-phase B), no MCP, no hooks, no slash commands.

**Tech Stack:**
- TypeScript / Node 20, vitest + `@testcontainers/postgresql` (matches existing indexer)
- `@anthropic-ai/sdk` for distillation (model pinned to `claude-haiku-4-5`)
- `zod` for LLM-output validation
- `fastify` *not yet* — sub-phase A has no HTTP server (deferred to sub-phase B)
- Postgres 16 + `pgvector` extension (image swap to `pgvector/pgvector:pg16`)
- Python 3.12 + FastAPI + `sentence-transformers` for the embedder sidecar

**Spec:** `docs/superpowers/specs/2026-05-05-agent-memory-design.md` (commit `e836496`)

**Out of sub-phase A scope** (covered by future plans):
- memory-api (`/memory/search`, `/memory/get`, `/memory/context`, …) — sub-phase B
- `mcp-memory/` package — sub-phase B
- `SessionStart` hook + slash commands + `add-user.sh` changes — sub-phase B
- Frontend memory browser, soft-delete enforcement, audit log — sub-phase C

---

## File Structure

**Created:**
- `hub/indexer/migrations/0006_memories.sql`
- `hub/indexer/migrations/0007_memory_chunks.sql`
- `hub/indexer/migrations/0008_memory_facets.sql`
- `hub/indexer/src/distiller-prompts.ts` — versioned prompt + zod result schema
- `hub/indexer/src/llm-client.ts` — Anthropic SDK wrapper, model pinned, JSON-mode parsing
- `hub/indexer/src/distiller-cursor.ts` — per-username cursor read/write
- `hub/indexer/src/distiller-repo.ts` — typed PG queries for settled sessions + memory writes
- `hub/indexer/src/distiller.ts` — orchestration loop (one pass per user, per-user advisory lock)
- `hub/indexer/src/embedder-client.ts` — HTTP client for the embedder sidecar
- `hub/indexer/src/embedder-worker.ts` — drains `embedder_queue`, writes vectors
- `hub/indexer/src/content-hash.ts` — pure SHA-256 normaliser
- `hub/indexer/test/migrations-pgvector.test.ts` — extends existing migrations smoke
- `hub/indexer/test/distiller-prompts.test.ts`
- `hub/indexer/test/content-hash.test.ts`
- `hub/indexer/test/llm-client.test.ts`
- `hub/indexer/test/distiller-cursor.test.ts`
- `hub/indexer/test/distiller-repo.test.ts`
- `hub/indexer/test/distiller.test.ts`
- `hub/indexer/test/embedder-client.test.ts`
- `hub/indexer/test/embedder-worker.test.ts`
- `hub/indexer/test/integration/distill-real-session.test.ts`
- `hub/indexer/test/fixtures/distillation-result.json` — canonical LLM stub output
- `hub/embedder/Dockerfile`
- `hub/embedder/pyproject.toml`
- `hub/embedder/server.py`
- `hub/embedder/test_server.py`

**Modified:**
- `hub/docker-compose.yml` — postgres image swap, new embedder service, indexer gets `ANTHROPIC_API_KEY` + `EMBEDDER_URL` env
- `hub/indexer/package.json` — add `@anthropic-ai/sdk`, `zod`
- `hub/indexer/src/index.ts` — boot distiller + embedder-worker loops alongside the watcher
- `hub/indexer/src/config.ts` — parse the new env vars

---

## Conventions

- Every test uses the existing testcontainers pattern (see `hub/indexer/test/migrations-smoke.test.ts:14-22`).
- Every TypeScript file uses ESM with `.js` import suffixes (matches existing code).
- Every commit message uses the existing style: `feat(indexer): …`, `feat(hub): …`, `test(indexer): …`. No `Co-Authored-By` trailer (operator preference).
- Run all indexer tests with `cd hub/indexer && npm test` (testcontainer boot ~5s).
- For each task: the failing test goes in **first**, then the implementation.

---

## Task 1: Swap to pgvector image, verify existing migrations still apply

**Goal:** Switch the postgres image so subsequent migrations can `CREATE EXTENSION vector;`. Existing rows + schema are wire-compatible.

**Files:**
- Modify: `hub/docker-compose.yml:73`
- Modify: `hub/indexer/test/migrations-smoke.test.ts:15` (testcontainer image)

- [ ] **Step 1: Update the migrations-smoke test to use the new image**

In `hub/indexer/test/migrations-smoke.test.ts`, change:

```ts
pg = await new PostgreSqlContainer("postgres:16-alpine").start();
```

to:

```ts
pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
```

- [ ] **Step 2: Run the smoke test, expect it to still pass**

```bash
cd hub/indexer && npm test -- migrations-smoke
```

Expected: `1 passed` — the existing five migrations apply unchanged against the pgvector base image.

- [ ] **Step 3: Update the same image string in db.test.ts and any other places**

Search for stale image references:

```bash
cd hub/indexer && grep -rn "postgres:16-alpine" test/
```

Replace each occurrence with `pgvector/pgvector:pg16`.

- [ ] **Step 4: Update hub/docker-compose.yml**

In `hub/docker-compose.yml`, change the postgres service `image:` line:

```yaml
postgres:
  image: pgvector/pgvector:pg16
```

- [ ] **Step 5: Run all indexer tests to confirm nothing else broke**

```bash
cd hub/indexer && npm test
```

Expected: all tests pass (same set as before the swap).

- [ ] **Step 6: Commit**

```bash
git add hub/docker-compose.yml hub/indexer/test/
git commit -m "chore(hub): switch postgres image to pgvector/pgvector:pg16

No data migration required; pgvector image is binary-compatible with
postgres:16-alpine. Enables CREATE EXTENSION vector for the upcoming
agent-memory migrations."
```

---

## Task 2: Migration 0006 — memories table

**Goal:** Land the `memories` table with type CHECK, scope columns, content_hash dedup unique, and the four indexes.

**Files:**
- Create: `hub/indexer/migrations/0006_memories.sql`
- Create: `hub/indexer/test/migrations-pgvector.test.ts`

- [ ] **Step 1: Write the failing test**

Create `hub/indexer/test/migrations-pgvector.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

describe("migration 0006 — memories", () => {
  it("creates memories table with all columns and constraints", async () => {
    const cols = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'memories' ORDER BY ordinal_position`,
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
    expect(byName.memory_id).toMatchObject({ data_type: "uuid", is_nullable: "NO" });
    expect(byName.username).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(byName.project_dir).toMatchObject({ is_nullable: "YES" });
    expect(byName.type).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(byName.source).toMatchObject({ data_type: "text", is_nullable: "NO" });
    expect(byName.content_hash).toMatchObject({ data_type: "bytea", is_nullable: "NO" });
    expect(byName.hit_count).toMatchObject({ data_type: "integer", is_nullable: "NO" });
    expect(byName.deleted_at).toMatchObject({ is_nullable: "YES" });
  });

  it("rejects unknown type via CHECK constraint", async () => {
    await expect(
      pool.query(
        `INSERT INTO memories (memory_id, username, type, source, name, description, body, content_hash)
         VALUES (gen_random_uuid(), 'alice', 'unknown', 'user', 'n', 'd', 'b', '\\x00'::bytea)`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("enforces UNIQUE(username, project_dir, type, content_hash)", async () => {
    const h = "\\xdeadbeef";
    await pool.query(
      `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'alice', '-w-p', 'observation', 'distilled', 'n', 'd', 'b', $1::bytea)`,
      [h],
    );
    const dup = await pool.query(
      `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'alice', '-w-p', 'observation', 'distilled', 'n2', 'd2', 'b2', $1::bytea)
       ON CONFLICT (username, project_dir, type, content_hash) DO NOTHING
       RETURNING memory_id`,
      [h],
    );
    expect(dup.rowCount).toBe(0);
  });

  it("registers in schema_migrations as version 6", async () => {
    const v = await pool.query("SELECT version FROM schema_migrations WHERE version = 6");
    expect(v.rowCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test, expect it to fail**

```bash
cd hub/indexer && npm test -- migrations-pgvector
```

Expected: FAIL — `relation "memories" does not exist`.

- [ ] **Step 3: Create the migration file**

Create `hub/indexer/migrations/0006_memories.sql` with the SQL from spec §6.1:

```sql
CREATE TABLE memories (
  memory_id          UUID PRIMARY KEY,
  username           TEXT NOT NULL,
  project_dir        TEXT,
  type               TEXT NOT NULL CHECK (type IN (
                       'user','feedback','project','reference',
                       'session_summary','observation'
                     )),
  source             TEXT NOT NULL CHECK (source IN ('user','distilled')),
  name               TEXT NOT NULL,
  description        TEXT NOT NULL,
  body               TEXT NOT NULL,
  source_session_id  UUID,
  source_entry_uuids JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_hash       BYTEA NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  hit_count          INT  NOT NULL DEFAULT 0,
  last_hit_at        TIMESTAMPTZ,
  deleted_at         TIMESTAMPTZ,
  UNIQUE NULLS NOT DISTINCT (username, project_dir, type, content_hash)
);

CREATE INDEX memories_username_type_created_idx
  ON memories (username, type, created_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX memories_org_type_created_idx
  ON memories (type, created_at DESC) WHERE username = '__org__' AND deleted_at IS NULL;

CREATE INDEX memories_project_idx
  ON memories (username, project_dir, type)
  WHERE project_dir IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX memories_source_session_idx
  ON memories (source_session_id) WHERE source_session_id IS NOT NULL;
```

- [ ] **Step 4: Run the test, expect pass**

```bash
cd hub/indexer && npm test -- migrations-pgvector
```

Expected: all four `it` blocks pass.

- [ ] **Step 5: Commit**

```bash
git add hub/indexer/migrations/0006_memories.sql hub/indexer/test/migrations-pgvector.test.ts
git commit -m "feat(indexer): migration 0006 — memories table

Typed memory rows with three-tier scope (org/user/project), six type
values matching the host auto-memory model + LLM-distilled types, and a
(username, project_dir, type, content_hash) UNIQUE for idempotent
re-distillation."
```

---

## Task 3: Migration 0007 — memory_chunks with pgvector + tsvector

**Goal:** Per-chunk storage with optional embedding (filled async by the worker), generated tsvector for FTS, HNSW vector index.

**Files:**
- Create: `hub/indexer/migrations/0007_memory_chunks.sql`
- Modify: `hub/indexer/test/migrations-pgvector.test.ts` — append a new `describe`

- [ ] **Step 1: Append the failing test**

Append to `hub/indexer/test/migrations-pgvector.test.ts`:

```ts
describe("migration 0007 — memory_chunks", () => {
  it("creates the vector extension", async () => {
    const ext = await pool.query(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    expect(ext.rowCount).toBe(1);
  });

  it("creates memory_chunks with embedding vector(384) and generated tsv", async () => {
    const cols = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'memory_chunks' ORDER BY ordinal_position`,
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r.data_type]));
    expect(byName.chunk_id).toBe("bigint");
    expect(byName.memory_id).toBe("uuid");
    expect(byName.chunk_idx).toBe("integer");
    expect(byName.content).toBe("text");
    expect(byName.embedding).toBe("USER-DEFINED"); // pgvector vector type
    expect(byName.tsv).toBe("tsvector");
  });

  it("inserts a chunk and round-trips a 384-dim embedding", async () => {
    const m = await pool.query(
      `INSERT INTO memories (memory_id, username, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'alice', 'observation', 'distilled', 'n', 'd', 'b', '\\xab'::bytea)
       RETURNING memory_id`,
    );
    const mid = m.rows[0].memory_id;
    const vec = "[" + Array.from({ length: 384 }, () => "0.01").join(",") + "]";
    await pool.query(
      `INSERT INTO memory_chunks (memory_id, chunk_idx, content, embedding)
       VALUES ($1, 0, 'hello world', $2::vector)`,
      [mid, vec],
    );
    const got = await pool.query(
      "SELECT content, tsv @@ plainto_tsquery('english','hello') AS hit FROM memory_chunks WHERE memory_id = $1",
      [mid],
    );
    expect(got.rows[0].content).toBe("hello world");
    expect(got.rows[0].hit).toBe(true);
  });

  it("creates the HNSW vector index", async () => {
    const idx = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'memory_chunks_embedding_idx'`,
    );
    expect(idx.rows[0].indexdef.toLowerCase()).toContain("hnsw");
    expect(idx.rows[0].indexdef.toLowerCase()).toContain("vector_cosine_ops");
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```bash
cd hub/indexer && npm test -- migrations-pgvector
```

Expected: FAIL — `relation "memory_chunks" does not exist`.

- [ ] **Step 3: Create migration 0007**

Create `hub/indexer/migrations/0007_memory_chunks.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_chunks (
  chunk_id     BIGSERIAL PRIMARY KEY,
  memory_id    UUID NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  chunk_idx    INT  NOT NULL,
  content      TEXT NOT NULL,
  embedding    vector(384),
  tsv          tsvector
                 GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (memory_id, chunk_idx)
);

CREATE INDEX memory_chunks_tsv_idx
  ON memory_chunks USING GIN (tsv);

CREATE INDEX memory_chunks_embedding_idx
  ON memory_chunks USING hnsw (embedding vector_cosine_ops);
```

- [ ] **Step 4: Run test, expect pass**

```bash
cd hub/indexer && npm test -- migrations-pgvector
```

Expected: all `it` blocks pass.

- [ ] **Step 5: Commit**

```bash
git add hub/indexer/migrations/0007_memory_chunks.sql hub/indexer/test/migrations-pgvector.test.ts
git commit -m "feat(indexer): migration 0007 — memory_chunks (pgvector + tsv)

One chunk row per searchable text slice. embedding is nullable so a
memory becomes FTS-searchable the moment it lands; the embedder worker
fills vectors asynchronously. HNSW + GIN(tsvector) cover both retrieval
modes; the union is ranked by hub/indexer/src/memory-rank.ts in
sub-phase B."
```

---

## Task 4: Migration 0008 — facets, embedder_queue, distill_cursor

**Goal:** Tagging, the embedder work queue, and the per-user distillation cursor — all small lookup tables.

**Files:**
- Create: `hub/indexer/migrations/0008_memory_facets.sql`
- Modify: `hub/indexer/test/migrations-pgvector.test.ts` — append a new `describe`

- [ ] **Step 1: Append the failing test**

```ts
describe("migration 0008 — facets, embedder_queue, distill_cursor", () => {
  it("creates memory_facets with composite PK", async () => {
    const pk = await pool.query(
      `SELECT a.attname FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'memory_facets'::regclass AND i.indisprimary
        ORDER BY a.attname`,
    );
    expect(pk.rows.map((r) => r.attname)).toEqual(["key", "memory_id", "value"]);
  });

  it("creates embedder_queue keyed on chunk_id", async () => {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='embedder_queue' ORDER BY ordinal_position`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toEqual(["chunk_id", "attempts", "last_error", "enqueued_at"]);
  });

  it("creates memory_distill_cursor with PK = username and 1970-01-01 default", async () => {
    await pool.query(
      `INSERT INTO memory_distill_cursor (username) VALUES ('alice')`,
    );
    const got = await pool.query(
      "SELECT EXTRACT(YEAR FROM last_seen_session_last_active) AS y FROM memory_distill_cursor WHERE username='alice'",
    );
    expect(Number(got.rows[0].y)).toBe(1970);
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```bash
cd hub/indexer && npm test -- migrations-pgvector
```

Expected: FAIL — `relation "memory_facets" does not exist`.

- [ ] **Step 3: Create migration 0008**

Create `hub/indexer/migrations/0008_memory_facets.sql`:

```sql
CREATE TABLE memory_facets (
  memory_id   UUID NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  PRIMARY KEY (memory_id, key, value)
);

CREATE INDEX memory_facets_kv_idx ON memory_facets (key, value);

CREATE TABLE embedder_queue (
  chunk_id    BIGINT PRIMARY KEY REFERENCES memory_chunks(chunk_id) ON DELETE CASCADE,
  attempts    INT NOT NULL DEFAULT 0,
  last_error  TEXT,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memory_distill_cursor (
  username                       TEXT PRIMARY KEY,
  last_seen_session_last_active  TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01'::timestamptz
);
```

- [ ] **Step 4: Run test, expect pass**

```bash
cd hub/indexer && npm test -- migrations-pgvector
```

Expected: all `it` blocks pass.

- [ ] **Step 5: Commit**

```bash
git add hub/indexer/migrations/0008_memory_facets.sql hub/indexer/test/migrations-pgvector.test.ts
git commit -m "feat(indexer): migration 0008 — facets, embedder queue, distill cursor

memory_facets is open-ended tagging (gene/dataset/tool/...). embedder_queue
is the chunk → vector work queue drained by a worker in the indexer.
memory_distill_cursor is per-user; advancing it is what makes the
distiller idempotent across restarts."
```

---

## Task 5: content-hash helper

**Goal:** A pure SHA-256 over a normalised body. Used to dedup distilled memories. Including the prompt version in the hash input means a version bump naturally yields fresh rows.

**Files:**
- Create: `hub/indexer/src/content-hash.ts`
- Create: `hub/indexer/test/content-hash.test.ts`

- [ ] **Step 1: Write failing test**

Create `hub/indexer/test/content-hash.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { contentHash } from "../src/content-hash.js";

describe("contentHash", () => {
  it("returns a 32-byte Buffer", () => {
    expect(contentHash({ body: "hello", promptVersion: 1 })).toHaveLength(32);
  });

  it("is stable for identical inputs", () => {
    const a = contentHash({ body: "x", promptVersion: 1 });
    const b = contentHash({ body: "x", promptVersion: 1 });
    expect(a.equals(b)).toBe(true);
  });

  it("normalises whitespace + case so trivial reformatting doesn't dedup-bust", () => {
    const a = contentHash({ body: "Hello   World\n", promptVersion: 1 });
    const b = contentHash({ body: "hello world", promptVersion: 1 });
    expect(a.equals(b)).toBe(true);
  });

  it("differs when promptVersion changes (forces re-distill)", () => {
    const a = contentHash({ body: "x", promptVersion: 1 });
    const b = contentHash({ body: "x", promptVersion: 2 });
    expect(a.equals(b)).toBe(false);
  });

  it("differs for substantively different bodies", () => {
    const a = contentHash({ body: "x", promptVersion: 1 });
    const b = contentHash({ body: "y", promptVersion: 1 });
    expect(a.equals(b)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```bash
cd hub/indexer && npm test -- content-hash
```

Expected: FAIL — `cannot find module ../src/content-hash.js`.

- [ ] **Step 3: Implement**

Create `hub/indexer/src/content-hash.ts`:

```ts
import { createHash } from "node:crypto";

export function contentHash(args: { body: string; promptVersion: number }): Buffer {
  const normalised = args.body.toLowerCase().replace(/\s+/g, " ").trim();
  const h = createHash("sha256");
  h.update(`v${args.promptVersion} `);
  h.update(normalised);
  return h.digest();
}
```

- [ ] **Step 4: Run test, expect pass**

```bash
cd hub/indexer && npm test -- content-hash
```

Expected: all 5 `it` blocks pass.

- [ ] **Step 5: Commit**

```bash
git add hub/indexer/src/content-hash.ts hub/indexer/test/content-hash.test.ts
git commit -m "feat(indexer): content-hash helper for memory dedup

SHA-256 of (promptVersion || normalised body). Used as the dedup key in
the memories UNIQUE constraint. Whitespace + case normalisation prevents
trivial reformatting from creating duplicate rows; including the prompt
version means bumping the prompt naturally produces fresh distillations."
```

---

## Task 6: distiller-prompts.ts (versioned prompt + zod result schema)

**Goal:** Single source of truth for the LLM prompt and its parsed shape. Versioned so prompt edits invalidate `content_hash` deterministically.

**Files:**
- Create: `hub/indexer/src/distiller-prompts.ts`
- Create: `hub/indexer/test/distiller-prompts.test.ts`
- Modify: `hub/indexer/package.json` — add `zod`

- [ ] **Step 1: Add the zod dependency**

```bash
cd hub/indexer && npm install zod@^3.23.8
```

- [ ] **Step 2: Write failing test**

Create `hub/indexer/test/distiller-prompts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  PROMPT_VERSION,
  buildDistillationPrompt,
  DistillationResult,
} from "../src/distiller-prompts.js";

describe("distiller-prompts", () => {
  it("PROMPT_VERSION is a positive integer", () => {
    expect(Number.isInteger(PROMPT_VERSION)).toBe(true);
    expect(PROMPT_VERSION).toBeGreaterThan(0);
  });

  it("buildDistillationPrompt embeds the transcript and version", () => {
    const out = buildDistillationPrompt({ transcript: "TRANSCRIPT_MARKER" });
    expect(out.system).toContain("distill");
    expect(out.system).toContain("strict JSON");
    expect(out.user).toContain("TRANSCRIPT_MARKER");
  });

  it("schema accepts a minimal valid result (empty observations)", () => {
    const valid = {
      summary: { name: "n", description: "d", body: "b" },
      observations: [],
    };
    expect(() => DistillationResult.parse(valid)).not.toThrow();
  });

  it("schema accepts a result with one observation of each known type", () => {
    const valid = {
      summary: { name: "n", description: "d", body: "b" },
      observations: [
        { type: "decision",        name: "a", description: "x", body: "y", facets: {} },
        { type: "finding",         name: "a", description: "x", body: "y", facets: { gene: ["TP53"] } },
        { type: "file-touched",    name: "a", description: "x", body: "y", facets: { file: ["foo.py"] } },
        { type: "command-result",  name: "a", description: "x", body: "y", facets: { tool: ["scanpy"] } },
        { type: "user-preference", name: "a", description: "x", body: "y", facets: {} },
      ],
    };
    expect(() => DistillationResult.parse(valid)).not.toThrow();
  });

  it("schema rejects unknown observation type", () => {
    expect(() =>
      DistillationResult.parse({
        summary: { name: "n", description: "d", body: "b" },
        observations: [
          { type: "rumor", name: "a", description: "x", body: "y", facets: {} },
        ],
      }),
    ).toThrow();
  });

  it("schema enforces ≤8 observations", () => {
    const obs = Array.from({ length: 9 }, () => ({
      type: "decision" as const,
      name: "a",
      description: "x",
      body: "y",
      facets: {},
    }));
    expect(() =>
      DistillationResult.parse({
        summary: { name: "n", description: "d", body: "b" },
        observations: obs,
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 3: Run test, expect fail**

```bash
cd hub/indexer && npm test -- distiller-prompts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `hub/indexer/src/distiller-prompts.ts`:

```ts
import { z } from "zod";

export const PROMPT_VERSION = 1;

const Facets = z
  .object({
    gene:     z.array(z.string()).optional(),
    dataset:  z.array(z.string()).optional(),
    tool:     z.array(z.string()).optional(),
    pipeline: z.array(z.string()).optional(),
    file:     z.array(z.string()).optional(),
  })
  .strict();

const Observation = z.object({
  type: z.enum([
    "decision",
    "finding",
    "file-touched",
    "command-result",
    "user-preference",
  ]),
  name:        z.string().max(80),
  description: z.string().max(200),
  body:        z.string().max(800),
  facets:      Facets,
});

export const DistillationResult = z.object({
  summary: z.object({
    name:        z.string().max(80),
    description: z.string().max(200),
    body:        z.string().max(1500),
  }),
  observations: z.array(Observation).max(8),
});

export type DistillationResult = z.infer<typeof DistillationResult>;
export type Observation = z.infer<typeof Observation>;

const SYSTEM_PROMPT = `You distill a Claude Code session transcript into structured memory rows for later retrieval. Output strict JSON matching the schema below. Be terse. Skip operational noise (file listings, command echoes, retries).

Schema:
{
  "summary": { "name": string ≤80c, "description": string ≤200c, "body": string ≤1500c },
  "observations": [  // 0..8 items
    {
      "type": "decision" | "finding" | "file-touched" | "command-result" | "user-preference",
      "name": string ≤80c,
      "description": string ≤200c,
      "body": string ≤800c,
      "facets": { "gene"?: string[], "dataset"?: string[], "tool"?: string[], "pipeline"?: string[], "file"?: string[] }
    }
  ]
}

Rules:
- 'user-preference' captures something the user expressed about how they want the agent to work or what they care about.
- 'decision' captures a chosen approach with the why; not what was tried and discarded.
- 'finding' captures a surprising fact the agent learned (data shape, bug root cause, env quirk).
- 'file-touched' is a path + one-line summary of what changed and why.
- 'command-result' is a command that produced a result the user is likely to need again (path-to-output, key number, error fingerprint).
- Skip everything else. Empty observations array is fine.`;

export function buildDistillationPrompt(args: { transcript: string }): {
  system: string;
  user: string;
  promptVersion: number;
} {
  return {
    system: SYSTEM_PROMPT,
    user: args.transcript,
    promptVersion: PROMPT_VERSION,
  };
}
```

- [ ] **Step 5: Run test, expect pass**

```bash
cd hub/indexer && npm test -- distiller-prompts
```

Expected: all 6 `it` blocks pass.

- [ ] **Step 6: Commit**

```bash
git add hub/indexer/src/distiller-prompts.ts hub/indexer/test/distiller-prompts.test.ts hub/indexer/package.json hub/indexer/package-lock.json
git commit -m "feat(indexer): versioned distillation prompt + zod result schema

PROMPT_VERSION feeds into content_hash so prompt edits force fresh
distillation. Schema is the strict-JSON contract for claude-haiku-4-5;
zod validation gives us a typed DistillationResult downstream and
rejects malformed LLM output cleanly."
```

---

## Task 7: llm-client.ts — Anthropic SDK wrapper

**Goal:** A thin async function `distill(transcript, opts) → DistillationResult` that pins the model, requests JSON output, and zod-validates. Tests inject a fake SDK rather than calling Anthropic.

**Files:**
- Create: `hub/indexer/src/llm-client.ts`
- Create: `hub/indexer/test/llm-client.test.ts`
- Modify: `hub/indexer/package.json` — add `@anthropic-ai/sdk`

- [ ] **Step 1: Add SDK dependency**

```bash
cd hub/indexer && npm install @anthropic-ai/sdk@^0.40.0
```

- [ ] **Step 2: Write failing test**

Create `hub/indexer/test/llm-client.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { distill } from "../src/llm-client.js";

function fakeSdk(responseText: string, capture?: { lastArgs?: any }) {
  return {
    messages: {
      create: vi.fn(async (args: any) => {
        if (capture) capture.lastArgs = args;
        return {
          content: [{ type: "text", text: responseText }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }),
    },
  } as any;
}

const VALID = JSON.stringify({
  summary: { name: "n", description: "d", body: "b" },
  observations: [],
});

describe("llm-client.distill", () => {
  it("calls Anthropic with the pinned model and a max_tokens budget", async () => {
    const cap: { lastArgs?: any } = {};
    await distill({
      transcript: "hello",
      anthropic: fakeSdk(VALID, cap),
      model: "claude-haiku-4-5",
    });
    expect(cap.lastArgs.model).toBe("claude-haiku-4-5");
    expect(cap.lastArgs.max_tokens).toBeGreaterThanOrEqual(2048);
    expect(cap.lastArgs.system).toContain("distill");
    expect(cap.lastArgs.messages[0].content).toContain("hello");
  });

  it("returns a parsed DistillationResult on valid JSON", async () => {
    const out = await distill({
      transcript: "x",
      anthropic: fakeSdk(VALID),
      model: "claude-haiku-4-5",
    });
    expect(out.summary.name).toBe("n");
    expect(out.observations).toEqual([]);
  });

  it("strips markdown code fences if the LLM wraps the JSON", async () => {
    const wrapped = "```json\n" + VALID + "\n```";
    const out = await distill({
      transcript: "x",
      anthropic: fakeSdk(wrapped),
      model: "claude-haiku-4-5",
    });
    expect(out.summary.name).toBe("n");
  });

  it("throws DistillerLlmError when JSON is malformed", async () => {
    await expect(
      distill({
        transcript: "x",
        anthropic: fakeSdk("not json at all"),
        model: "claude-haiku-4-5",
      }),
    ).rejects.toThrow(/parse/i);
  });

  it("throws DistillerLlmError when JSON shape is wrong", async () => {
    const bad = JSON.stringify({ summary: { name: "n" }, observations: [] });
    await expect(
      distill({
        transcript: "x",
        anthropic: fakeSdk(bad),
        model: "claude-haiku-4-5",
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test, expect fail**

```bash
cd hub/indexer && npm test -- llm-client
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `hub/indexer/src/llm-client.ts`:

```ts
import type Anthropic from "@anthropic-ai/sdk";
import { buildDistillationPrompt, DistillationResult } from "./distiller-prompts.js";

export class DistillerLlmError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
  }
}

export interface DistillOpts {
  transcript: string;
  anthropic: Pick<Anthropic, "messages">;
  model: string;
  maxTokens?: number;
}

export async function distill(opts: DistillOpts): Promise<DistillationResult> {
  const prompt = buildDistillationPrompt({ transcript: opts.transcript });

  const response = await opts.anthropic.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
  });

  const textBlock = response.content.find((b: any) => b.type === "text");
  if (!textBlock || (textBlock as any).type !== "text") {
    throw new DistillerLlmError("no text block in LLM response");
  }
  const raw = (textBlock as any).text as string;

  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    throw new DistillerLlmError(`failed to parse LLM JSON: ${(e as Error).message}`, e);
  }

  const result = DistillationResult.safeParse(parsed);
  if (!result.success) {
    throw new DistillerLlmError(
      `LLM output failed schema validation: ${result.error.message}`,
      result.error,
    );
  }
  return result.data;
}
```

- [ ] **Step 5: Run test, expect pass**

```bash
cd hub/indexer && npm test -- llm-client
```

Expected: all 5 `it` blocks pass.

- [ ] **Step 6: Commit**

```bash
git add hub/indexer/src/llm-client.ts hub/indexer/test/llm-client.test.ts hub/indexer/package.json hub/indexer/package-lock.json
git commit -m "feat(indexer): Anthropic SDK wrapper for distillation

Pure async function with the SDK injected — tests stub messages.create
without touching the network. Strips markdown code fences (haiku
sometimes wraps JSON), validates with the zod schema from
distiller-prompts.ts, throws DistillerLlmError on any failure so the
distiller loop can keep the cursor in place and retry."
```

---

## Task 8: distiller-cursor.ts — per-user cursor read/write

**Goal:** Two thin functions over `memory_distill_cursor`. Idempotent set; default is the table's `'1970-01-01'`.

**Files:**
- Create: `hub/indexer/src/distiller-cursor.ts`
- Create: `hub/indexer/test/distiller-cursor.test.ts`

- [ ] **Step 1: Write failing test**

Create `hub/indexer/test/distiller-cursor.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { getCursor, setCursor } from "../src/distiller-cursor.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

beforeEach(async () => {
  await pool.query("DELETE FROM memory_distill_cursor");
});

describe("distiller-cursor", () => {
  it("returns 1970-01-01 when no row exists", async () => {
    const c = await getCursor(pool, "alice");
    expect(c.toISOString()).toBe("1970-01-01T00:00:00.000Z");
  });

  it("round-trips a set value", async () => {
    const t = new Date("2026-05-01T12:00:00.000Z");
    await setCursor(pool, "alice", t);
    const c = await getCursor(pool, "alice");
    expect(c.toISOString()).toBe(t.toISOString());
  });

  it("setCursor only advances forward (never moves back)", async () => {
    const a = new Date("2026-05-01T12:00:00.000Z");
    const b = new Date("2026-05-01T11:00:00.000Z");
    await setCursor(pool, "alice", a);
    await setCursor(pool, "alice", b);
    const c = await getCursor(pool, "alice");
    expect(c.toISOString()).toBe(a.toISOString());
  });

  it("isolates per-user", async () => {
    const t = new Date("2026-05-01T12:00:00.000Z");
    await setCursor(pool, "alice", t);
    const bob = await getCursor(pool, "bob");
    expect(bob.toISOString()).toBe("1970-01-01T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```bash
cd hub/indexer && npm test -- distiller-cursor
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `hub/indexer/src/distiller-cursor.ts`:

```ts
import type { Pool } from "pg";

export async function getCursor(pool: Pool, username: string): Promise<Date> {
  const r = await pool.query<{ ts: Date }>(
    `SELECT last_seen_session_last_active AS ts
       FROM memory_distill_cursor WHERE username = $1`,
    [username],
  );
  if (r.rowCount === 0) return new Date("1970-01-01T00:00:00.000Z");
  return r.rows[0].ts;
}

export async function setCursor(
  pool: Pool,
  username: string,
  ts: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO memory_distill_cursor (username, last_seen_session_last_active)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE
       SET last_seen_session_last_active =
             GREATEST(memory_distill_cursor.last_seen_session_last_active, EXCLUDED.last_seen_session_last_active)`,
    [username, ts.toISOString()],
  );
}
```

- [ ] **Step 4: Run test, expect pass**

```bash
cd hub/indexer && npm test -- distiller-cursor
```

Expected: all 4 `it` blocks pass.

- [ ] **Step 5: Commit**

```bash
git add hub/indexer/src/distiller-cursor.ts hub/indexer/test/distiller-cursor.test.ts
git commit -m "feat(indexer): per-user distillation cursor

Monotonically-advancing watermark. GREATEST() in the upsert means a
late-arriving distill batch can never rewind the cursor (which would
cause duplicate work, not data corruption — the content_hash UNIQUE
catches that — but wastes LLM calls)."
```

---

## Task 9: distiller-repo.ts — settled-sessions query + write

**Goal:** Two PG queries used by the distiller loop:
1. `findSettledSessions(username, cursor, settleSeconds, limit)` — sessions whose `last_active > cursor` AND `last_active < now() - settleSeconds`.
2. `writeDistillation({sessionMeta, result})` — atomic insert of summary + observations + chunks + facets + queue rows.

**Files:**
- Create: `hub/indexer/src/distiller-repo.ts`
- Create: `hub/indexer/test/distiller-repo.test.ts`

- [ ] **Step 1: Write failing test**

Create `hub/indexer/test/distiller-repo.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { findSettledSessions, writeDistillation } from "../src/distiller-repo.js";
import type { DistillationResult } from "../src/distiller-prompts.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

beforeEach(async () => {
  await pool.query("TRUNCATE token_usage_log, sessions, memories CASCADE");
  await pool.query("TRUNCATE memory_distill_cursor");
});

const SID = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

async function insertSession(s: {
  sid: string;
  username: string;
  project: string;
  lastActive: string;
}) {
  await pool.query(
    `INSERT INTO sessions (session_id, username, encoded_project_dir, last_active)
     VALUES ($1, $2, $3, $4)`,
    [s.sid, s.username, s.project, s.lastActive],
  );
}

describe("findSettledSessions", () => {
  it("returns sessions with last_active > cursor AND < now() - settleSeconds", async () => {
    const now = new Date();
    const tenMinAgo  = new Date(now.getTime() - 10 * 60_000).toISOString();
    const oneMinAgo  = new Date(now.getTime() - 1  * 60_000).toISOString();

    await insertSession({ sid: SID(1), username: "alice", project: "-w-p1", lastActive: tenMinAgo });
    await insertSession({ sid: SID(2), username: "alice", project: "-w-p2", lastActive: oneMinAgo });

    const got = await findSettledSessions(pool, {
      username: "alice",
      cursor: new Date("1970-01-01"),
      settleSeconds: 300,
      limit: 50,
    });
    expect(got.map((s) => s.session_id)).toEqual([SID(1)]);
  });

  it("respects per-user scoping", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await insertSession({ sid: SID(3), username: "alice", project: "-w", lastActive: tenMinAgo });
    await insertSession({ sid: SID(4), username: "bob",   project: "-w", lastActive: tenMinAgo });
    const got = await findSettledSessions(pool, {
      username: "alice",
      cursor: new Date("1970-01-01"),
      settleSeconds: 300,
      limit: 50,
    });
    expect(got.map((s) => s.session_id)).toEqual([SID(3)]);
  });

  it("orders by last_active ascending and respects limit", async () => {
    const t1 = new Date(Date.now() - 30 * 60_000).toISOString();
    const t2 = new Date(Date.now() - 20 * 60_000).toISOString();
    const t3 = new Date(Date.now() - 10 * 60_000).toISOString();
    await insertSession({ sid: SID(7), username: "alice", project: "-w", lastActive: t3 });
    await insertSession({ sid: SID(5), username: "alice", project: "-w", lastActive: t1 });
    await insertSession({ sid: SID(6), username: "alice", project: "-w", lastActive: t2 });
    const got = await findSettledSessions(pool, {
      username: "alice",
      cursor: new Date("1970-01-01"),
      settleSeconds: 300,
      limit: 2,
    });
    expect(got.map((s) => s.session_id)).toEqual([SID(5), SID(6)]);
  });
});

const RESULT: DistillationResult = {
  summary: { name: "scanpy preprocessing", description: "QC + normalise + log1p", body: "Ran sc.pp.* pipeline on PBMC3K." },
  observations: [
    { type: "decision",     name: "use percentile filter", description: "drop top 1% mt%", body: "...", facets: { dataset: ["PBMC3K"] } },
    { type: "user-preference", name: "prefer Seurat conventions", description: "labels", body: "...", facets: {} },
    { type: "file-touched", name: "scripts/qc.py", description: "added mt-cutoff", body: "...", facets: { file: ["scripts/qc.py"] } },
  ],
};

describe("writeDistillation", () => {
  it("inserts summary + observations + chunks + facets + queue rows in one txn", async () => {
    await writeDistillation(pool, {
      sessionMeta: { username: "alice", project_dir: "-w-p", source_session_id: SID(8) },
      result: RESULT,
      promptVersion: 1,
    });

    const m = await pool.query("SELECT type, source FROM memories ORDER BY created_at");
    // 1 summary + 3 observations; user-preference becomes a feedback memory.
    const types = m.rows.map((r) => r.type);
    expect(types).toContain("session_summary");
    expect(types.filter((t) => t === "observation").length).toBe(2);
    expect(types).toContain("feedback");
    for (const r of m.rows) expect(r.source).toBe("distilled");

    const c = await pool.query("SELECT COUNT(*)::int AS n FROM memory_chunks");
    expect(c.rows[0].n).toBe(m.rowCount); // one chunk per memory at idx 0

    const q = await pool.query("SELECT COUNT(*)::int AS n FROM embedder_queue");
    expect(q.rows[0].n).toBe(m.rowCount);

    const f = await pool.query("SELECT key, value FROM memory_facets ORDER BY key, value");
    const kv = f.rows.map((r) => `${r.key}=${r.value}`);
    expect(kv).toContain("dataset=PBMC3K");
    expect(kv).toContain("file=scripts/qc.py");
  });

  it("is idempotent: re-running yields no duplicate memory rows", async () => {
    await writeDistillation(pool, {
      sessionMeta: { username: "alice", project_dir: "-w-p", source_session_id: SID(9) },
      result: RESULT,
      promptVersion: 1,
    });
    const before = (await pool.query("SELECT COUNT(*)::int AS n FROM memories")).rows[0].n;

    await writeDistillation(pool, {
      sessionMeta: { username: "alice", project_dir: "-w-p", source_session_id: SID(9) },
      result: RESULT,
      promptVersion: 1,
    });
    const after = (await pool.query("SELECT COUNT(*)::int AS n FROM memories")).rows[0].n;
    expect(after).toBe(before);
  });

  it("re-distills (creates fresh rows) when promptVersion bumps", async () => {
    await writeDistillation(pool, {
      sessionMeta: { username: "alice", project_dir: "-w-p", source_session_id: SID(10) },
      result: RESULT,
      promptVersion: 1,
    });
    const before = (await pool.query("SELECT COUNT(*)::int AS n FROM memories")).rows[0].n;

    await writeDistillation(pool, {
      sessionMeta: { username: "alice", project_dir: "-w-p", source_session_id: SID(10) },
      result: RESULT,
      promptVersion: 2,
    });
    const after = (await pool.query("SELECT COUNT(*)::int AS n FROM memories")).rows[0].n;
    expect(after).toBe(before * 2);
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```bash
cd hub/indexer && npm test -- distiller-repo
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `hub/indexer/src/distiller-repo.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { DistillationResult, Observation } from "./distiller-prompts.js";
import { contentHash } from "./content-hash.js";

export interface SettledSession {
  session_id:          string;
  username:            string;
  encoded_project_dir: string;
  last_active:         Date;
}

export async function findSettledSessions(
  pool: Pool,
  args: { username: string; cursor: Date; settleSeconds: number; limit: number },
): Promise<SettledSession[]> {
  const r = await pool.query<SettledSession>(
    `SELECT session_id, username, encoded_project_dir, last_active
       FROM sessions
      WHERE username = $1
        AND last_active > $2
        AND last_active < (now() - ($3::int || ' seconds')::interval)
      ORDER BY last_active ASC
      LIMIT $4`,
    [args.username, args.cursor.toISOString(), args.settleSeconds, args.limit],
  );
  return r.rows;
}

export interface SessionMeta {
  username:           string;
  project_dir:        string | null;
  source_session_id:  string;
}

export interface WriteDistillationArgs {
  sessionMeta:    SessionMeta;
  result:         DistillationResult;
  promptVersion:  number;
}

export async function writeDistillation(
  pool: Pool,
  args: WriteDistillationArgs,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insertOne(client, args.sessionMeta, "session_summary", {
      name:        args.result.summary.name,
      description: args.result.summary.description,
      body:        args.result.summary.body,
      facets:      {},
    }, args.promptVersion);

    for (const obs of args.result.observations) {
      const memType = obs.type === "user-preference" ? "feedback" : "observation";
      await insertOne(client, args.sessionMeta, memType, obs, args.promptVersion);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function insertOne(
  client:        PoolClient,
  meta:          SessionMeta,
  memType:       string,
  payload:       Pick<Observation, "name" | "description" | "body" | "facets">,
  promptVersion: number,
): Promise<void> {
  const hash = contentHash({ body: payload.body, promptVersion });
  const memId = randomUUID();
  const ins = await client.query<{ memory_id: string }>(
    `INSERT INTO memories (
       memory_id, username, project_dir, type, source,
       name, description, body, source_session_id, content_hash
     ) VALUES ($1, $2, $3, $4, 'distilled', $5, $6, $7, $8, $9)
     ON CONFLICT (username, project_dir, type, content_hash) DO NOTHING
     RETURNING memory_id`,
    [
      memId, meta.username, meta.project_dir, memType,
      payload.name, payload.description, payload.body, meta.source_session_id, hash,
    ],
  );
  if (ins.rowCount === 0) return; // dedup; nothing else to write

  const writtenId = ins.rows[0].memory_id;
  const chunk = await client.query<{ chunk_id: string }>(
    `INSERT INTO memory_chunks (memory_id, chunk_idx, content)
     VALUES ($1, 0, $2) RETURNING chunk_id`,
    [writtenId, payload.body],
  );
  await client.query(
    `INSERT INTO embedder_queue (chunk_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [chunk.rows[0].chunk_id],
  );
  for (const [k, vs] of Object.entries(payload.facets)) {
    if (!vs) continue;
    for (const v of vs) {
      await client.query(
        `INSERT INTO memory_facets (memory_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [writtenId, k, v],
      );
    }
  }
}
```

- [ ] **Step 4: Run test, expect pass**

```bash
cd hub/indexer && npm test -- distiller-repo
```

Expected: all 6 `it` blocks pass.

- [ ] **Step 5: Commit**

```bash
git add hub/indexer/src/distiller-repo.ts hub/indexer/test/distiller-repo.test.ts
git commit -m "feat(indexer): distiller-repo for settled sessions + atomic writes

findSettledSessions enforces both halves of the settle window: cursor
(don't reprocess) and now()-settleSeconds (let in-flight conversations
finish). writeDistillation is one transaction per session — summary +
observations + chunks + facets + queue rows commit together. user-
preference observations promote to feedback-typed memories so they
match the host auto-memory model."
```

---

## Task 10: distiller.ts — orchestration loop with per-user advisory lock

**Goal:** The actual loop. For each known username, take an advisory lock, find settled sessions, distill them via the (injected) LLM client + a JSONL reader, write rows, advance the cursor.

**Files:**
- Create: `hub/indexer/src/distiller.ts`
- Create: `hub/indexer/test/distiller.test.ts`

- [ ] **Step 1: Write failing test**

Create `hub/indexer/test/distiller.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { runDistillerOnce } from "../src/distiller.js";
import { setCursor, getCursor } from "../src/distiller-cursor.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

beforeEach(async () => {
  await pool.query("TRUNCATE token_usage_log, sessions, memories CASCADE");
  await pool.query("TRUNCATE memory_distill_cursor");
});

const SID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

const RESULT = {
  summary: { name: "n", description: "d", body: "summary body" },
  observations: [
    { type: "finding" as const, name: "f", description: "d", body: "finding body", facets: {} },
  ],
};

describe("runDistillerOnce", () => {
  it("processes one settled session per user, writes rows, advances cursor", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await pool.query(
      `INSERT INTO sessions (session_id, username, encoded_project_dir, last_active)
       VALUES ($1,'alice','-w-p',$2)`,
      [SID(1), tenMinAgo],
    );

    const llmFn = vi.fn(async () => RESULT);
    const transcriptFn = vi.fn(async () => "<jsonl chunk>");

    const summary = await runDistillerOnce(pool, {
      llm: llmFn,
      readTranscript: transcriptFn,
      settleSeconds: 300,
      perUserLimit: 50,
      maxDistillTokens: 80_000,
      promptVersion: 1,
    });
    expect(summary.usersScanned).toBe(1);
    expect(summary.sessionsDistilled).toBe(1);
    expect(llmFn).toHaveBeenCalledTimes(1);
    expect(transcriptFn).toHaveBeenCalledTimes(1);

    const c = (await pool.query("SELECT COUNT(*)::int AS n FROM memories")).rows[0].n;
    expect(c).toBe(2); // summary + 1 observation

    const cursor = await getCursor(pool, "alice");
    expect(cursor.toISOString()).toBe(new Date(tenMinAgo).toISOString());
  });

  it("does not re-process a session whose last_active is at-or-before cursor", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000);
    await pool.query(
      `INSERT INTO sessions (session_id, username, encoded_project_dir, last_active)
       VALUES ($1,'alice','-w-p',$2)`,
      [SID(2), tenMinAgo.toISOString()],
    );
    await setCursor(pool, "alice", tenMinAgo); // already past it

    const llmFn = vi.fn(async () => RESULT);
    const summary = await runDistillerOnce(pool, {
      llm: llmFn,
      readTranscript: async () => "x",
      settleSeconds: 300,
      perUserLimit: 50,
      maxDistillTokens: 80_000,
      promptVersion: 1,
    });
    expect(summary.sessionsDistilled).toBe(0);
    expect(llmFn).not.toHaveBeenCalled();
  });

  it("keeps the cursor in place when the LLM throws", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await pool.query(
      `INSERT INTO sessions (session_id, username, encoded_project_dir, last_active)
       VALUES ($1,'alice','-w-p',$2)`,
      [SID(3), tenMinAgo],
    );

    const llmFn = vi.fn(async () => { throw new Error("api down"); });
    const summary = await runDistillerOnce(pool, {
      llm: llmFn,
      readTranscript: async () => "x",
      settleSeconds: 300,
      perUserLimit: 50,
      maxDistillTokens: 80_000,
      promptVersion: 1,
    });
    expect(summary.sessionsFailed).toBe(1);
    const cursor = await getCursor(pool, "alice");
    expect(cursor.toISOString()).toBe("1970-01-01T00:00:00.000Z");
  });

  it("trims transcript to maxDistillTokens (rough char heuristic)", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await pool.query(
      `INSERT INTO sessions (session_id, username, encoded_project_dir, last_active)
       VALUES ($1,'alice','-w-p',$2)`,
      [SID(4), tenMinAgo],
    );

    const huge = "x".repeat(2_000_000); // ~500k tokens at 4 chars/token
    const captured: { transcript?: string } = {};
    await runDistillerOnce(pool, {
      llm: async (transcript) => { captured.transcript = transcript; return RESULT; },
      readTranscript: async () => huge,
      settleSeconds: 300,
      perUserLimit: 50,
      maxDistillTokens: 1000, // ~4000 chars after trim
      promptVersion: 1,
    });
    expect(captured.transcript!.length).toBeLessThanOrEqual(4 * 1000 + 100);
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```bash
cd hub/indexer && npm test -- distiller.test
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `hub/indexer/src/distiller.ts`:

```ts
import type { Pool } from "pg";
import { logger } from "./config.js";
import { findSettledSessions, writeDistillation, type SettledSession } from "./distiller-repo.js";
import { getCursor, setCursor } from "./distiller-cursor.js";
import type { DistillationResult } from "./distiller-prompts.js";

export interface RunDistillerOpts {
  llm:               (transcript: string) => Promise<DistillationResult>;
  readTranscript:    (s: SettledSession) => Promise<string>;
  settleSeconds:     number;
  perUserLimit:      number;
  maxDistillTokens:  number;
  promptVersion:     number;
}

export interface RunSummary {
  usersScanned:      number;
  sessionsDistilled: number;
  sessionsFailed:    number;
}

const CHARS_PER_TOKEN = 4; // crude; sufficient for a transcript-trimming guard

export async function runDistillerOnce(pool: Pool, opts: RunDistillerOpts): Promise<RunSummary> {
  const summary: RunSummary = { usersScanned: 0, sessionsDistilled: 0, sessionsFailed: 0 };
  const users = await pool.query<{ username: string }>(
    "SELECT DISTINCT username FROM sessions",
  );
  for (const row of users.rows) {
    summary.usersScanned++;
    const lockKey = userLockKey(row.username);
    const got = await pool.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS ok",
      [lockKey],
    );
    if (!got.rows[0].ok) continue; // another worker has this user

    try {
      await processUser(pool, row.username, opts, summary);
    } finally {
      await pool.query("SELECT pg_advisory_unlock($1)", [lockKey]);
    }
  }
  return summary;
}

async function processUser(
  pool:     Pool,
  username: string,
  opts:     RunDistillerOpts,
  summary:  RunSummary,
): Promise<void> {
  const cursor = await getCursor(pool, username);
  const settled = await findSettledSessions(pool, {
    username,
    cursor,
    settleSeconds: opts.settleSeconds,
    limit: opts.perUserLimit,
  });
  for (const s of settled) {
    try {
      const raw = await opts.readTranscript(s);
      const trimmed = raw.length > opts.maxDistillTokens * CHARS_PER_TOKEN
        ? raw.slice(-opts.maxDistillTokens * CHARS_PER_TOKEN)
        : raw;
      const result = await opts.llm(trimmed);
      await writeDistillation(pool, {
        sessionMeta: {
          username,
          project_dir:       s.encoded_project_dir,
          source_session_id: s.session_id,
        },
        result,
        promptVersion: opts.promptVersion,
      });
      await setCursor(pool, username, s.last_active);
      summary.sessionsDistilled++;
    } catch (err) {
      summary.sessionsFailed++;
      logger.error(
        { err, username, sessionId: s.session_id },
        "distillation failed; cursor not advanced",
      );
      // stop processing this user this pass — the next pass will retry the same session
      return;
    }
  }
}

function userLockKey(username: string): bigint {
  // 64-bit FNV-1a hash, fits Postgres bigint and stable across processes.
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < username.length; i++) {
    h ^= BigInt(username.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  // Map to signed bigint range expected by pg_advisory_lock.
  return h <= 0x7fffffffffffffffn ? h : h - 0x10000000000000000n;
}
```

Note: this uses `logger` from `config.js`. If that export doesn't exist yet, add it as a sub-step now (existing indexer uses pino).

- [ ] **Step 4: Run test, expect pass**

```bash
cd hub/indexer && npm test -- distiller.test
```

Expected: all 4 `it` blocks pass.

- [ ] **Step 5: Commit**

```bash
git add hub/indexer/src/distiller.ts hub/indexer/test/distiller.test.ts
git commit -m "feat(indexer): distiller orchestration loop

One pass per user, guarded by a stable per-user advisory lock so two
indexer instances (future HA) don't race. Cursor advances only after a
successful write — LLM failures keep the cursor in place so the next
pass retries the same session, while content_hash dedup makes that safe."
```

---

## Task 11: integration test — real fixture session → distilled rows

**Goal:** End-to-end inside the indexer test harness, using a real fixture JSONL from Phase 1's test corpus and a stubbed LLM. Proves the JSONL → transcript-string → distillation → DB rows pipeline.

**Files:**
- Create: `hub/indexer/test/integration/distill-real-session.test.ts`
- Create: `hub/indexer/test/fixtures/distillation-result.json`

- [ ] **Step 1: Write the canonical stub LLM output**

Create `hub/indexer/test/fixtures/distillation-result.json`:

```json
{
  "summary": {
    "name": "PBMC3K preprocessing pass",
    "description": "Loaded counts, ran sc.pp.* QC and normalisation.",
    "body": "Walked through the standard scanpy preprocessing pipeline on PBMC3K, settling on percentile-based mt-cutoffs and log1p-norm."
  },
  "observations": [
    {
      "type": "decision",
      "name": "percentile mt-cutoff",
      "description": "drop top 1% mt%",
      "body": "Used sc.pp.calculate_qc_metrics + 99th percentile cutoff over fixed thresholds because cell composition varies across batches.",
      "facets": { "tool": ["scanpy"], "dataset": ["PBMC3K"] }
    },
    {
      "type": "user-preference",
      "name": "Seurat naming conventions",
      "description": "use percent.mt not pct_counts_mt",
      "body": "User wants downstream column names to match Seurat's convention so notebooks port between tools.",
      "facets": {}
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `hub/indexer/test/integration/distill-real-session.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { runMigrations } from "../../src/migrate.js";
import { runDistillerOnce } from "../../src/distiller.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));
const FIXTURE_JSONL  = fileURLToPath(new URL("../fixtures/tool-call-session.jsonl", import.meta.url));
const FIXTURE_RESULT = fileURLToPath(new URL("../fixtures/distillation-result.json", import.meta.url));

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

describe("end-to-end distillation against a fixture session", () => {
  it("turns a real JSONL fixture into expected memory + chunk + facet + queue rows", async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const sid = "11111111-1111-1111-1111-111111111111";
    await pool.query(
      `INSERT INTO sessions (session_id, username, encoded_project_dir, last_active)
       VALUES ($1, 'alice', '-w-pbmc3k', $2)`,
      [sid, tenMinAgo],
    );
    const jsonl = await readFile(FIXTURE_JSONL, "utf8");
    const stubResult = JSON.parse(await readFile(FIXTURE_RESULT, "utf8"));

    const summary = await runDistillerOnce(pool, {
      llm: async (transcript) => {
        expect(transcript).toContain(jsonl.split("\n").filter(Boolean)[0].slice(0, 40));
        return stubResult;
      },
      readTranscript: async () => jsonl,
      settleSeconds: 300,
      perUserLimit: 50,
      maxDistillTokens: 80_000,
      promptVersion: 1,
    });
    expect(summary.sessionsDistilled).toBe(1);

    const types = (await pool.query("SELECT type FROM memories ORDER BY type")).rows.map((r) => r.type);
    expect(types).toEqual(["feedback", "observation", "session_summary"]);

    const facets = (await pool.query(
      "SELECT key, value FROM memory_facets ORDER BY key, value",
    )).rows.map((r) => `${r.key}=${r.value}`);
    expect(facets).toContain("dataset=PBMC3K");
    expect(facets).toContain("tool=scanpy");

    const queued = (await pool.query("SELECT COUNT(*)::int AS n FROM embedder_queue")).rows[0].n;
    expect(queued).toBe(3);
  });
});
```

- [ ] **Step 3: Run test, expect fail**

```bash
cd hub/indexer && npm test -- distill-real-session
```

Expected: FAIL — `tool-call-session.jsonl` may exist (from Phase 1 fixtures); if not, copy any small JSONL fixture from `hub/indexer/test/fixtures/` and update the `FIXTURE_JSONL` path. The test will fail until the LLM stub returns the right shape — which after Step 1 it does.

- [ ] **Step 4: Run again, expect pass**

```bash
cd hub/indexer && npm test -- distill-real-session
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add hub/indexer/test/integration/distill-real-session.test.ts hub/indexer/test/fixtures/distillation-result.json
git commit -m "test(indexer): integration — fixture session → distilled rows

Exercises the full distiller path (sessions row → readTranscript →
stubbed LLM → writeDistillation) and asserts the expected three
memory rows, two facets, and three queued chunks. Stubbed LLM means
no network, no API key — runs in CI in under a second once the
testcontainer is up."
```

---

## Task 12: Embedder service — Dockerfile, FastAPI server, pytest

**Goal:** Standalone Python service. `POST /embed {texts:[str]} → {vectors:[[float;384]]}`. Model baked in at build time; first request pre-warms.

**Files:**
- Create: `hub/embedder/Dockerfile`
- Create: `hub/embedder/pyproject.toml`
- Create: `hub/embedder/server.py`
- Create: `hub/embedder/test_server.py`

- [ ] **Step 1: Create pyproject.toml**

Create `hub/embedder/pyproject.toml`:

```toml
[project]
name = "claude-bioflow-embedder"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "fastapi==0.115.4",
  "uvicorn[standard]==0.32.0",
  "sentence-transformers==3.2.1",
  "pydantic==2.9.2",
]

[project.optional-dependencies]
test = ["pytest==8.3.3", "httpx==0.27.2"]
```

- [ ] **Step 2: Write the failing test**

Create `hub/embedder/test_server.py`:

```python
from fastapi.testclient import TestClient
from server import app, EMBED_DIM

client = TestClient(app)


def test_embed_returns_vectors_of_correct_dim():
    r = client.post("/embed", json={"texts": ["hello", "world"]})
    assert r.status_code == 200
    body = r.json()
    assert "vectors" in body
    assert len(body["vectors"]) == 2
    for v in body["vectors"]:
        assert len(v) == EMBED_DIM
        assert all(isinstance(x, float) for x in v)


def test_embed_rejects_empty_input():
    r = client.post("/embed", json={"texts": []})
    assert r.status_code == 400


def test_embed_rejects_oversize_batch():
    r = client.post("/embed", json={"texts": ["x"] * 1000})
    assert r.status_code == 400


def test_health_endpoint():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["model"] == "BAAI/bge-small-en-v1.5"
```

- [ ] **Step 3: Run test, expect fail**

You'll need a venv with the deps. Per CLAUDE.md (`/venv` only — never project-local venvs):

```bash
cd hub/embedder && /venv/bin/python -m pip install -e .[test]
cd hub/embedder && /venv/bin/python -m pytest test_server.py -v
```

Expected: FAIL — `server` module not found.

- [ ] **Step 4: Implement server.py**

Create `hub/embedder/server.py`:

```python
"""Tiny embedding service for claude-bioflow.

Single endpoint /embed wraps sentence-transformers BAAI/bge-small-en-v1.5.
Model is loaded at import time so the first request is fast, even though
that means a slower process boot.
"""
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

MODEL_NAME = "BAAI/bge-small-en-v1.5"
EMBED_DIM = 384
MAX_BATCH = 256

app = FastAPI(title="claude-bioflow-embedder")
_model = SentenceTransformer(MODEL_NAME, device="cpu")


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=0)


class EmbedResponse(BaseModel):
    vectors: list[list[float]]


@app.get("/health")
def health() -> dict:
    return {"model": MODEL_NAME, "dim": EMBED_DIM}


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> EmbedResponse:
    if len(req.texts) == 0:
        raise HTTPException(status_code=400, detail="texts must be non-empty")
    if len(req.texts) > MAX_BATCH:
        raise HTTPException(status_code=400, detail=f"batch size > {MAX_BATCH}")
    vecs = _model.encode(req.texts, normalize_embeddings=True).tolist()
    return EmbedResponse(vectors=vecs)
```

- [ ] **Step 5: Run test, expect pass (first run downloads model — slow)**

```bash
cd hub/embedder && /venv/bin/python -m pytest test_server.py -v
```

Expected: 4 passed (first run slow due to model weight download).

- [ ] **Step 6: Create Dockerfile**

Create `hub/embedder/Dockerfile`:

```dockerfile
FROM python:3.12-slim

WORKDIR /app

# Install runtime deps only (no test extras).
COPY pyproject.toml ./
RUN pip install --no-cache-dir \
      "fastapi==0.115.4" \
      "uvicorn[standard]==0.32.0" \
      "sentence-transformers==3.2.1" \
      "pydantic==2.9.2"

# Pre-download model weights into the image so first request is fast and
# the container has no runtime network dependency for the model.
RUN python -c "from sentence_transformers import SentenceTransformer; \
               SentenceTransformer('BAAI/bge-small-en-v1.5')"

COPY server.py ./

EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 7: Build the image to verify**

```bash
cd hub/embedder && docker build -t claude-bioflow-embedder:dev .
```

Expected: image builds successfully (~600 MB final size). The model-download RUN is the slow step (~30s on first build).

- [ ] **Step 8: Commit**

```bash
git add hub/embedder/
git commit -m "feat(hub): embedder sidecar (bge-small-en-v1.5, FastAPI, CPU)

Standalone Python service exposing POST /embed for the indexer's
embedder-worker. Model weights pre-baked into the image so cold-start
has no network dependency. 384-dim cosine-normalised vectors match
the migration 0007 column type."
```

---

## Task 13: embedder-client.ts — HTTP client for the sidecar

**Files:**
- Create: `hub/indexer/src/embedder-client.ts`
- Create: `hub/indexer/test/embedder-client.test.ts`

- [ ] **Step 1: Write failing test**

Create `hub/indexer/test/embedder-client.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { embedTexts, EmbedderError } from "../src/embedder-client.js";

let lastReceived: any;
let nextStatus = 200;
let nextBody: any = { vectors: [] };
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastReceived = body ? JSON.parse(body) : null;
        res.writeHead(nextStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(nextBody));
      });
    }).listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("embedTexts", () => {
  it("posts to /embed and returns vectors", async () => {
    nextStatus = 200;
    nextBody = { vectors: [[0.1, 0.2], [0.3, 0.4]] };
    const v = await embedTexts({ baseUrl, texts: ["a", "b"] });
    expect(v).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(lastReceived).toEqual({ texts: ["a", "b"] });
  });

  it("throws EmbedderError on non-2xx", async () => {
    nextStatus = 500;
    nextBody = { detail: "boom" };
    await expect(embedTexts({ baseUrl, texts: ["a"] })).rejects.toBeInstanceOf(EmbedderError);
  });

  it("throws EmbedderError when response shape is wrong", async () => {
    nextStatus = 200;
    nextBody = { not_vectors: [] };
    await expect(embedTexts({ baseUrl, texts: ["a"] })).rejects.toBeInstanceOf(EmbedderError);
  });

  it("throws EmbedderError when vector count != texts count", async () => {
    nextStatus = 200;
    nextBody = { vectors: [[0.1, 0.2]] };
    await expect(embedTexts({ baseUrl, texts: ["a", "b"] })).rejects.toBeInstanceOf(EmbedderError);
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```bash
cd hub/indexer && npm test -- embedder-client
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `hub/indexer/src/embedder-client.ts`:

```ts
export class EmbedderError extends Error {
  constructor(message: string, public cause?: unknown) { super(message); }
}

export interface EmbedTextsArgs {
  baseUrl:    string;
  texts:      string[];
  timeoutMs?: number;
}

export async function embedTexts(args: EmbedTextsArgs): Promise<number[][]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), args.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(`${args.baseUrl}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: args.texts }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new EmbedderError(`embedder fetch failed: ${(e as Error).message}`, e);
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new EmbedderError(`embedder ${res.status}: ${body.slice(0, 200)}`);
  }

  let parsed: any;
  try {
    parsed = await res.json();
  } catch (e) {
    throw new EmbedderError(`embedder returned non-JSON: ${(e as Error).message}`, e);
  }
  if (!Array.isArray(parsed?.vectors)) {
    throw new EmbedderError(`embedder response missing 'vectors' array`);
  }
  if (parsed.vectors.length !== args.texts.length) {
    throw new EmbedderError(
      `embedder returned ${parsed.vectors.length} vectors for ${args.texts.length} texts`,
    );
  }
  return parsed.vectors as number[][];
}
```

- [ ] **Step 4: Run test, expect pass**

```bash
cd hub/indexer && npm test -- embedder-client
```

Expected: all 4 `it` blocks pass.

- [ ] **Step 5: Commit**

```bash
git add hub/indexer/src/embedder-client.ts hub/indexer/test/embedder-client.test.ts
git commit -m "feat(indexer): HTTP client for the embedder sidecar

Single embedTexts() function with 30s default timeout. Fails loud on
shape mismatches (vectors[] missing, count mismatch) so the worker can
retry instead of writing garbage embeddings."
```

---

## Task 14: embedder-worker.ts — drain the queue, write vectors

**Files:**
- Create: `hub/indexer/src/embedder-worker.ts`
- Create: `hub/indexer/test/embedder-worker.test.ts`

- [ ] **Step 1: Write the failing test**

Create `hub/indexer/test/embedder-worker.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { runEmbedderOnce } from "../src/embedder-worker.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
let pg: StartedPostgreSqlContainer;
let pool: Pool;
let stub: Server;
let stubUrl: string;
let stubMode: "ok" | "fail" = "ok";

beforeAll(async () => {
  pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({ pool, migrationsDir: MIGRATIONS_DIR, lockKey: 0x62696f666c77n });
  await new Promise<void>((resolve) => {
    stub = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (stubMode === "fail") {
          res.writeHead(500); res.end("nope"); return;
        }
        const { texts } = JSON.parse(body);
        const vecs = texts.map(() => Array.from({ length: 384 }, () => 0.01));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ vectors: vecs }));
      });
    }).listen(0, "127.0.0.1", () => {
      const a = stub.address();
      if (typeof a === "object" && a) stubUrl = `http://127.0.0.1:${a.port}`;
      resolve();
    });
  });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
  await new Promise<void>((r) => stub.close(() => r()));
}, 30_000);

beforeEach(async () => {
  stubMode = "ok";
  await pool.query("TRUNCATE memories CASCADE");
});

async function seedChunk(content: string): Promise<number> {
  const m = await pool.query<{ memory_id: string }>(
    `INSERT INTO memories (memory_id, username, type, source, name, description, body, content_hash)
     VALUES (gen_random_uuid(),'alice','observation','distilled','n','d',$1,$2::bytea)
     RETURNING memory_id`,
    [content, Buffer.from(content)],
  );
  const c = await pool.query<{ chunk_id: string }>(
    `INSERT INTO memory_chunks (memory_id, chunk_idx, content) VALUES ($1, 0, $2) RETURNING chunk_id`,
    [m.rows[0].memory_id, content],
  );
  await pool.query("INSERT INTO embedder_queue (chunk_id) VALUES ($1)", [c.rows[0].chunk_id]);
  return Number(c.rows[0].chunk_id);
}

describe("runEmbedderOnce", () => {
  it("drains queued chunks and writes embeddings", async () => {
    await seedChunk("hello");
    await seedChunk("world");
    const summary = await runEmbedderOnce(pool, { embedderUrl: stubUrl, batchSize: 64 });
    expect(summary.embedded).toBe(2);
    const remaining = (await pool.query("SELECT COUNT(*)::int AS n FROM embedder_queue")).rows[0].n;
    expect(remaining).toBe(0);
    const filled = (await pool.query("SELECT COUNT(*)::int AS n FROM memory_chunks WHERE embedding IS NOT NULL")).rows[0].n;
    expect(filled).toBe(2);
  });

  it("on embedder failure, increments attempts and leaves rows in queue", async () => {
    const cid = await seedChunk("hello");
    stubMode = "fail";
    const summary = await runEmbedderOnce(pool, { embedderUrl: stubUrl, batchSize: 64 });
    expect(summary.failed).toBe(1);
    const r = await pool.query("SELECT attempts, last_error FROM embedder_queue WHERE chunk_id = $1", [cid]);
    expect(r.rows[0].attempts).toBe(1);
    expect(r.rows[0].last_error).toBeTruthy();
  });

  it("respects batchSize and processes oldest first", async () => {
    const c1 = await seedChunk("a");
    const c2 = await seedChunk("b");
    const c3 = await seedChunk("c");
    await runEmbedderOnce(pool, { embedderUrl: stubUrl, batchSize: 2 });
    // Two oldest processed; one remains.
    const remaining = await pool.query("SELECT chunk_id FROM embedder_queue ORDER BY chunk_id");
    expect(remaining.rows.map((r) => Number(r.chunk_id))).toEqual([c3]);
    void c1; void c2;
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```bash
cd hub/indexer && npm test -- embedder-worker
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `hub/indexer/src/embedder-worker.ts`:

```ts
import type { Pool } from "pg";
import { logger } from "./config.js";
import { embedTexts, EmbedderError } from "./embedder-client.js";

export interface RunEmbedderOpts {
  embedderUrl: string;
  batchSize:   number;
}

export interface EmbedderSummary {
  embedded: number;
  failed:   number;
}

export async function runEmbedderOnce(pool: Pool, opts: RunEmbedderOpts): Promise<EmbedderSummary> {
  const summary: EmbedderSummary = { embedded: 0, failed: 0 };
  const batch = await pool.query<{ chunk_id: string; content: string }>(
    `SELECT mc.chunk_id, mc.content
       FROM memory_chunks mc JOIN embedder_queue eq USING (chunk_id)
      ORDER BY eq.enqueued_at ASC
      LIMIT $1`,
    [opts.batchSize],
  );
  if (batch.rowCount === 0) return summary;

  const ids   = batch.rows.map((r) => r.chunk_id);
  const texts = batch.rows.map((r) => r.content);

  let vectors: number[][];
  try {
    vectors = await embedTexts({ baseUrl: opts.embedderUrl, texts });
  } catch (e) {
    summary.failed = ids.length;
    const msg = e instanceof EmbedderError ? e.message : String(e);
    await pool.query(
      `UPDATE embedder_queue SET attempts = attempts + 1, last_error = $1
        WHERE chunk_id = ANY($2::bigint[])`,
      [msg.slice(0, 500), ids],
    );
    logger.warn({ count: ids.length, err: msg }, "embedder batch failed; will retry");
    return summary;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < ids.length; i++) {
      const literal = "[" + vectors[i].join(",") + "]";
      await client.query(
        `UPDATE memory_chunks SET embedding = $1::vector WHERE chunk_id = $2`,
        [literal, ids[i]],
      );
    }
    await client.query(
      `DELETE FROM embedder_queue WHERE chunk_id = ANY($1::bigint[])`,
      [ids],
    );
    await client.query("COMMIT");
    summary.embedded = ids.length;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return summary;
}
```

- [ ] **Step 4: Run test, expect pass**

```bash
cd hub/indexer && npm test -- embedder-worker
```

Expected: all 3 `it` blocks pass.

- [ ] **Step 5: Commit**

```bash
git add hub/indexer/src/embedder-worker.ts hub/indexer/test/embedder-worker.test.ts
git commit -m "feat(indexer): embedder-worker drains the chunk queue

Selects the oldest batchSize queued chunks, sends one POST /embed,
writes vectors and deletes queue rows in a single transaction. On
embedder failure, increments attempts + records last_error so we can
inspect stuck rows; the chunk stays in the queue for the next pass."
```

---

## Task 15: docker-compose wiring — add embedder service, indexer env

**Goal:** Services are reachable on the hub network with the right environment so sub-phase A can run end-to-end via `docker compose up`.

**Files:**
- Modify: `hub/docker-compose.yml`
- Modify: `hub/.env.example` (if present; otherwise note in `hub/scripts/add-user.sh`)

- [ ] **Step 1: Add the embedder service to hub/docker-compose.yml**

Add under `services:`:

```yaml
embedder:
  build: ./embedder
  container_name: claude-bioflow-embedder
  restart: unless-stopped
  networks: [bioflow-net]
  healthcheck:
    test: ["CMD", "python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=3).status==200 else 1)"]
    interval: 10s
    timeout: 5s
    retries: 6
```

- [ ] **Step 2: Add the new env vars to the indexer service**

In the indexer block, extend the existing `environment:` map:

```yaml
environment:
  PG_URL: postgres://bioflow:${POSTGRES_PASSWORD}@postgres:5432/bioflow
  WORKSPACES_ROOT: /workspaces
  MAX_CONCURRENT_FILES: "8"
  LOG_LEVEL: info
  # Agent memory — sub-phase A
  ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
  EMBEDDER_URL: http://embedder:8000
  DISTILL_MODEL: claude-haiku-4-5
  DISTILL_SETTLE_SEC: "300"
  DISTILL_INTERVAL_SEC: "60"
  DISTILL_MAX_TOKENS: "80000"
  DISTILL_PROMPT_VERSION: "1"
  DISTILL_BATCH_SIZE: "50"
  EMBEDDER_BATCH_SIZE: "64"
  EMBEDDER_INTERVAL_MS: "5000"
depends_on:
  postgres: { condition: service_healthy }
  embedder: { condition: service_healthy }
```

- [ ] **Step 3: Document ANTHROPIC_API_KEY in hub/.env**

If `hub/.env.example` exists, add `ANTHROPIC_API_KEY=sk-ant-...`. Otherwise document in `hub/scripts/add-user.sh` near the existing `POSTGRES_PASSWORD` generator that operators must set this once at hub setup.

- [ ] **Step 4: Validate compose**

```bash
cd hub && docker compose config > /dev/null
```

Expected: no errors. (Don't bring services up yet — Task 17 does that.)

- [ ] **Step 5: Commit**

```bash
git add hub/docker-compose.yml
git commit -m "feat(hub): wire embedder service + agent-memory env on indexer

embedder builds from ./embedder; indexer waits for it via depends_on.
Centralised ANTHROPIC_API_KEY (consumed only by the indexer) keeps
distillation cost on the hub's bill, not the user's."
```

---

## Task 16: Wire boot — config.ts + index.ts run distiller + embedder loops

**Goal:** When the indexer starts, it now runs three loops: existing JSONL watcher, distiller (every `DISTILL_INTERVAL_SEC`), embedder-worker (every `EMBEDDER_INTERVAL_MS`).

**Files:**
- Modify: `hub/indexer/src/config.ts`
- Modify: `hub/indexer/src/index.ts`

- [ ] **Step 1: Read current config.ts shape**

```bash
cat hub/indexer/src/config.ts
```

Identify the existing parsing pattern (likely a single object with `process.env.X ?? default`).

- [ ] **Step 2: Extend config.ts**

Append the new env vars to the existing config object — example shape (adapt to the file's actual style):

```ts
export const config = {
  // ... existing fields ...
  anthropicApiKey:      requireEnv("ANTHROPIC_API_KEY"),
  embedderUrl:          process.env.EMBEDDER_URL          ?? "http://embedder:8000",
  distillModel:         process.env.DISTILL_MODEL         ?? "claude-haiku-4-5",
  distillSettleSec:     intEnv("DISTILL_SETTLE_SEC",      300),
  distillIntervalSec:   intEnv("DISTILL_INTERVAL_SEC",     60),
  distillMaxTokens:     intEnv("DISTILL_MAX_TOKENS",   80_000),
  distillPromptVersion: intEnv("DISTILL_PROMPT_VERSION",    1),
  distillBatchSize:     intEnv("DISTILL_BATCH_SIZE",       50),
  embedderBatchSize:    intEnv("EMBEDDER_BATCH_SIZE",      64),
  embedderIntervalMs:   intEnv("EMBEDDER_INTERVAL_MS",   5000),
};
```

If `requireEnv` / `intEnv` helpers don't already exist, add them at the top of the file:

```ts
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`required env var missing: ${name}`);
  return v;
}
function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`env var ${name} must be an integer, got ${v}`);
  return n;
}
```

- [ ] **Step 3: Modify index.ts to start the new loops**

Add to `hub/indexer/src/index.ts` (alongside the existing watcher start):

```ts
import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { distill } from "./llm-client.js";
import { runDistillerOnce } from "./distiller.js";
import { runEmbedderOnce } from "./embedder-worker.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

async function readSessionJsonl(s: { username: string; encoded_project_dir: string; session_id: string }) {
  const path = resolve(
    config.workspacesRoot,
    s.username,
    "claude-projects",
    s.encoded_project_dir,
    `${s.session_id}.jsonl`,
  );
  return await readFile(path, "utf8");
}

function startDistillerLoop(): void {
  const tick = async () => {
    try {
      const summary = await runDistillerOnce(pool, {
        llm: (transcript) =>
          distill({ transcript, anthropic, model: config.distillModel, maxTokens: 4096 }),
        readTranscript: readSessionJsonl,
        settleSeconds:    config.distillSettleSec,
        perUserLimit:     config.distillBatchSize,
        maxDistillTokens: config.distillMaxTokens,
        promptVersion:    config.distillPromptVersion,
      });
      logger.info({ summary }, "distiller pass");
    } catch (err) {
      logger.error({ err }, "distiller pass crashed");
    } finally {
      setTimeout(tick, config.distillIntervalSec * 1000);
    }
  };
  setTimeout(tick, config.distillIntervalSec * 1000); // first tick after one interval
}

function startEmbedderLoop(): void {
  const tick = async () => {
    try {
      const summary = await runEmbedderOnce(pool, {
        embedderUrl: config.embedderUrl,
        batchSize:   config.embedderBatchSize,
      });
      if (summary.embedded || summary.failed) logger.info({ summary }, "embedder pass");
    } catch (err) {
      logger.error({ err }, "embedder pass crashed");
    } finally {
      setTimeout(tick, config.embedderIntervalMs);
    }
  };
  setTimeout(tick, config.embedderIntervalMs);
}

// In the existing main() / boot block, after the watcher starts:
startDistillerLoop();
startEmbedderLoop();
```

(Adapt the variable names — `pool`, `logger`, `config` — to whatever the existing index.ts uses.)

- [ ] **Step 4: Run the full indexer test suite**

```bash
cd hub/indexer && npm test
```

Expected: every test passes. (No new test for the loop wiring — it's plumbing; the unit tests already cover `runDistillerOnce` and `runEmbedderOnce`.)

- [ ] **Step 5: Type-check**

```bash
cd hub/indexer && npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add hub/indexer/src/config.ts hub/indexer/src/index.ts
git commit -m "feat(indexer): start distiller + embedder loops at boot

Both loops are setTimeout-driven, not setInterval — tick() reschedules
itself in finally so a slow pass never overlaps with the next one. A
crash inside either loop logs and continues; we never process.exit
from worker code (matches the watcher's policy)."
```

---

## Task 17: Smoke run — `docker compose up` and verify rows appear

**Goal:** End-to-end check on a real hub. Requires `ANTHROPIC_API_KEY` set in `hub/.env`.

**Files:** none modified — operational verification only.

- [ ] **Step 1: Bring up the stack**

```bash
cd hub && docker compose up -d --build postgres embedder indexer
```

Expected: all three services reach `healthy` within ~60s (embedder cold-loads the model first time; rebuild caches that layer afterwards).

- [ ] **Step 2: Verify the schema landed**

```bash
docker exec claude-bioflow-postgres psql -U bioflow -c "\dt"
```

Expected output includes `memories`, `memory_chunks`, `memory_facets`, `embedder_queue`, `memory_distill_cursor`.

- [ ] **Step 3: Verify the embedder is reachable**

```bash
docker exec claude-bioflow-indexer wget -qO- http://embedder:8000/health
```

Expected: `{"model":"BAAI/bge-small-en-v1.5","dim":384}`.

- [ ] **Step 4: Pick a settled session and force a tick**

If you have a real user with at least one ≥5-minute-idle session:

```bash
docker exec claude-bioflow-postgres psql -U bioflow -c \
  "SELECT username, session_id, last_active FROM sessions
    WHERE last_active < now() - interval '5 minutes'
    ORDER BY last_active DESC LIMIT 3;"
```

Wait one `DISTILL_INTERVAL_SEC` (60s default), then:

```bash
docker exec claude-bioflow-postgres psql -U bioflow -c \
  "SELECT type, COUNT(*) FROM memories WHERE source='distilled' GROUP BY 1;"
```

Expected: `session_summary` count ≥ 1 within ~2 minutes; `observation` and `feedback` rows may also appear depending on the session content.

- [ ] **Step 5: Verify embeddings are filling in**

```bash
docker exec claude-bioflow-postgres psql -U bioflow -c \
  "SELECT
     SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS filled,
     COUNT(*) AS total
   FROM memory_chunks;"
```

Expected: `filled` advances toward `total` over a few minutes.

- [ ] **Step 6: Tail the logs to confirm passes are running**

```bash
docker logs -f claude-bioflow-indexer 2>&1 | grep -E "distiller pass|embedder pass"
```

Expected: log lines every minute (distiller) and every 5s when work is queued (embedder).

- [ ] **Step 7: Document the rollout in the spec's sub-phase A status**

Edit `docs/superpowers/specs/2026-05-05-agent-memory-design.md` §14 to add a status line under "Sub-phase A":

```
**Sub-phase A — silent distillation.** … STATUS: landed YYYY-MM-DD on commit <sha>.
```

- [ ] **Step 8: Commit the status update**

```bash
git add docs/superpowers/specs/2026-05-05-agent-memory-design.md
git commit -m "docs(memory): mark sub-phase A as landed

Closes the silent-distillation phase. Sub-phase B (memory-api + MCP +
hooks) builds on these tables; the spec's three open decisions are now
materialised in code (bge-small / haiku-4-5 / inside hub/indexer)."
```

---

## Self-review

**Spec coverage check** (against `docs/superpowers/specs/2026-05-05-agent-memory-design.md`):

| Spec section | Covered by |
|---|---|
| §6.0 pgvector image | Task 1 |
| §6.1 memories | Task 2 |
| §6.2 memory_chunks | Task 3 |
| §6.3 facets + queue + cursor | Task 4 |
| §7.1 distiller orchestration | Tasks 8, 9, 10, 11 |
| §7.3 embedder sidecar | Task 12 |
| §7.3 embedder client | Task 13 |
| §7.3 embedder worker | Task 14 |
| §8 prompt + zod schema | Task 6 |
| §8 user-preference → feedback promotion | Task 9 (covered by writeDistillation test) |
| §10 LLM-failure / cursor non-advancement | Task 10 (covered by "keeps cursor in place" test) |
| §10 embedder-failure / attempts++ | Task 14 (covered by "increments attempts" test) |
| §10 dedup via content_hash | Tasks 5, 9 |
| §10 prompt-version → fresh distillation | Tasks 5, 9 |
| §12 env vars | Tasks 15, 16 |
| §13 testing toolchain | every TS task uses vitest + testcontainers; embedder uses pytest |

Not covered (out of sub-phase A scope, deferred to sub-phase B/C):
- memory-api endpoints (`/memory/search`, `/memory/get`, `/memory/timeline`, `/memory/write`, `/memory/forget`, `/memory/context`) and their hybrid ranking SQL — sub-phase B.
- MCP server, slash commands, SessionStart hook, `add-user.sh` changes — sub-phase B.
- Frontend memory browser, soft-delete enforcement, audit log — sub-phase C.

**Placeholder scan:** none — every step has either runnable code, an exact command, or a deterministic file edit.

**Type consistency:** `DistillationResult` defined in Task 6 used unchanged in Tasks 7, 9, 10, 11. `SettledSession` defined in Task 9 used unchanged in Task 10. `RunSummary` / `EmbedderSummary` are local to their respective files; no cross-file naming drift. `userLockKey` returns a `bigint` because `pg_advisory_lock` accepts a bigint (the existing `migrate.ts` uses the same pattern).

**Plan complete and saved to `docs/superpowers/plans/2026-05-05-agent-memory-sub-phase-a.md`.**
