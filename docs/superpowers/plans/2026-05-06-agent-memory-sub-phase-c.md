# Agent memory — sub-phase C (UX + hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the user-facing memory browser. After this lands, every user can open a "Memory" panel in the frontend, browse their org/user/project memories, search, edit user-authored entries, soft-delete (forget) and restore, and see a per-memory audit trail. Operators get a `/memory/metrics` endpoint to spot a stuck distiller or embedder queue.

**Architecture:** Five new HTTP routes on the existing memory-api (`PUT /memory/:id`, `POST /memory/:id/restore`, `GET /memory/list`, `GET /memory/:id/audit`, `GET /memory/metrics`) backed by a new `memory_audit_log` table (migration 0009). All mutating routes append an audit row in the same transaction. The adapter gains a `memory-rpc.ts` HTTP client and exposes nine NATS RPC methods (`memory_search`/`memory_get`/`memory_timeline`/`memory_list`/`memory_write`/`memory_update`/`memory_forget`/`memory_restore`/`memory_audit`). The frontend gains a `MemoryPanel` component slotted into the existing right-panel rotation alongside Files / Notebook / Agents — Vue 3 + pinia, no new deps. `username` is never exposed to the browser; the adapter substitutes its trusted `USERNAME` env var on every call.

**Tech Stack:**
- Backend: TypeScript / Node 20, fastify, vitest + `@testcontainers/postgresql` (matches existing indexer)
- Adapter: TypeScript / Node 20, vitest, `undici` for fetch (already a transitive dep)
- Frontend: Vue 3 Composition API + pinia + `nats.ws` (matches existing app — no new runtime deps)

**Spec:** `docs/superpowers/specs/2026-05-05-agent-memory-design.md`, sections 7.2 / 9 / 14 (sub-phase C bullets: list/edit/forget UI, soft-delete enforcement, audit log, metrics).

**Sub-phase B status (must be merged to main before starting C):** landed 2026-05-06 — six routes live (`/memory/search`, `/memory/timeline`, `/memory/context`, `/memory/write`, `/memory/forget`, `/memory/:id`), MCP server installed in image, four production users on `MEMORY_ENABLED=1`, `MEMORY_API_URL=http://claude-bioflow-indexer:8400` already in every adapter container. Latest at `08f3cba`.

**Out of sub-phase C scope** (deferred):
- Editing **distilled** memories. Sub-phase C only allows edits to `source='user'` rows. Distilled rows are read-only via UI; users can `forget` them but not rewrite — keeps the distiller's content_hash dedup honest.
- Org-write UI. Org memories remain operator-administered (consistent with sub-phase B).
- Frontend metrics dashboard. The endpoint exists but the UI just lives behind `curl`/admin tooling for now.
- Bulk operations (multi-select forget). Single-row only.
- Vector re-embedding on edit. We invalidate the cached embedding by deleting the chunk row + re-queueing; the embedder loop picks it up on its 5s tick.
- Admin / audit log explorer (cross-memory). Per-memory audit only.

---

## File Structure

**Created:**
- `hub/indexer/migrations/0009_memory_audit_log.sql`
- `hub/indexer/test/migrations-0009-smoke.test.ts` — testcontainers, asserts table + indexes exist
- `hub/indexer/test/memory-audit.test.ts` — unit tests for audit-row insertion across all four mutation paths
- `adapter/src/memory-rpc.ts` — fetch-based HTTP client (one method per memory-api route)
- `adapter/test/memory-rpc.test.ts` — stub HTTP server on a random port; assert wire payloads
- `frontend/src/services/memory.ts` — thin wrapper over `natsService.invoke('memory_*', ...)`
- `frontend/src/stores/memory.ts` — pinia store: list state, current selection, scope filter, edit dirty state
- `frontend/src/components/memory/MemoryPanel.vue` — top-level: search, scope tabs, list + detail
- `frontend/src/components/memory/MemoryList.vue` — paginated list rows
- `frontend/src/components/memory/MemoryDetail.vue` — view + inline edit + forget + restore
- `frontend/src/types/memory.ts` — typed payloads shared between service / store / components

**Modified:**
- `hub/indexer/src/memory-repo.ts` — add `appendAudit`, `updateMemory`, `restoreMemory`, `listMemories`, `getAuditTrail`, `getMetrics`; wire `appendAudit` into existing `writeUserMemory` and `forgetMemory`
- `hub/indexer/src/memory-api.ts` — add five new routes (PUT update, POST restore, GET list, GET audit, GET metrics)
- `hub/indexer/test/memory-repo.test.ts` — add cases for the four new repo helpers (regression bar: existing tests stay green)
- `hub/indexer/test/memory-api.test.ts` — add inject() coverage for the five new routes (one happy path + one validation failure each)
- `adapter/src/rpc.ts` — add nine `case "memory_*":` branches in `dispatchInner`; thread `USERNAME` from env
- `adapter/src/index.ts` — instantiate `MemoryRpcClient(MEMORY_API_URL, USERNAME)`, pass into `RpcRouter` deps
- `adapter/test/rpc-memory.test.ts` — new file alongside existing `chats-repo.test.ts`; smoke each branch with a stub `MemoryRpcClient`
- `frontend/src/components/layout/MainLayout.vue` — extend `RightPanel` union with `'memory'`; add toolbar button + render branch
- `frontend/src/types/index.ts` — re-export memory types

**Untouched (intentional):**
- `hub/skeleton/`, `hub/scripts/add-user.sh`, `hub/scripts/recreate-user.sh` — sub-phase B already wired the env vars + MCP. Sub-phase C is a code-only rebuild.
- `image/Dockerfile` — same.
- `mcp-memory/` — agent-side tool surface is unchanged in sub-phase C. The new endpoints are operator/UI-facing only; the agent already has `memory_search/get/timeline/write/forget` and that's enough for chat. Adding update/list to the MCP would invite the agent to thrash its own memory store.

---

## Conventions

- Backend tests use the existing testcontainers pattern (`hub/indexer/test/migrations-smoke.test.ts:14-22`) and the existing `applyMigrationsForTest()` helper. New migrations go through the same path — never hand-roll DDL in a test.
- TypeScript files use ESM with `.js` import suffixes (matches sub-phase A/B).
- Audit rows are written in the **same SQL transaction** as the mutation that produced them. No "log on success" after-the-fact pattern — that's how audit gaps appear.
- All mutation routes are **owner-scoped**: `memory.username` must equal the requester's username. Mismatched owner returns 403, not 404 (so a malicious caller can't probe whether a UUID exists). Org-sentinel `'__org__'` rows are read-only via per-user containers — write attempts from a non-org caller return 403.
- The frontend never sends `username`. The adapter takes it from `process.env.USERNAME` (already validated in `db-config.ts` against `^[a-z0-9][a-z0-9-]*$`) and injects it into every memory-api call.
- Frontend has no unit-test framework (only `playwright` for `test-ui.mjs`). Test discipline for sub-phase C: write the store + service in pure TS where possible; cover them with adapter / indexer tests; cover the Vue components by manual smoke + extending `test-ui.mjs` for the panel.
- Commit message style matches sub-phase B: `feat(indexer): …`, `feat(adapter): …`, `feat(frontend): …`, `test(indexer): …`. **No `Co-Authored-By` trailer** (operator preference; see `feedback_no_coauthored_by` memory).
- Run all backend tests with `cd hub/indexer && npm test` and `cd adapter && npm test`. Frontend typecheck via `cd frontend && npm run typecheck`.

---

## Task 1: migration 0009 — `memory_audit_log` table

**Goal:** One new table, one new pair of indexes. Migrations are append-only and idempotent (pattern from 0006–0008).

**Files:**
- Create: `hub/indexer/migrations/0009_memory_audit_log.sql`
  ```sql
  CREATE TABLE memory_audit_log (
    audit_id     BIGSERIAL PRIMARY KEY,
    memory_id    UUID NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
    actor        TEXT NOT NULL,
    action       TEXT NOT NULL CHECK (action IN ('write', 'update', 'forget', 'restore')),
    before       JSONB,
    after        JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX memory_audit_memory_idx ON memory_audit_log (memory_id, created_at DESC);
  CREATE INDEX memory_audit_actor_idx  ON memory_audit_log (actor, created_at DESC);
  ```
- Create: `hub/indexer/test/migrations-0009-smoke.test.ts` — testcontainers, run all 9 migrations in order, assert `memory_audit_log` exists with the two indexes:
  ```ts
  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename='memory_audit_log' ORDER BY indexname`
  );
  expect(idx.rows.map(r => r.indexname).sort()).toEqual(
    ['memory_audit_actor_idx', 'memory_audit_log_pkey', 'memory_audit_memory_idx'].sort()
  );
  ```

**Acceptance:** `cd hub/indexer && npm test -- migrations-0009-smoke` green; existing `migrations-smoke.test.ts` still green (regression bar — migrations are sequential).

---

## Task 2: `memory-repo.appendAudit` + wire into existing write/forget

**Goal:** One private helper, two call sites updated. No new endpoints. Existing tests stay green; one new test asserts an audit row appears for each existing mutation.

**Files:**
- Modify: `hub/indexer/src/memory-repo.ts` — add an exported function:
  ```ts
  export interface AuditEntry {
    memory_id: string;
    actor: string;
    action: 'write' | 'update' | 'forget' | 'restore';
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }
  export async function appendAudit(
    client: PoolClient,
    e: AuditEntry,
  ): Promise<void> {
    await client.query(
      `INSERT INTO memory_audit_log (memory_id, actor, action, before, after)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
      [e.memory_id, e.actor, e.action, e.before ? JSON.stringify(e.before) : null,
       e.after ? JSON.stringify(e.after) : null],
    );
  }
  ```
  Use a `PoolClient` from a transaction the caller already opened — never call `pool.query` directly here, otherwise the audit row escapes the surrounding rollback.
- Modify: `hub/indexer/src/memory-repo.ts` — `writeUserMemory`: after the existing `insertMemoryRow(...)` returns a `memory_id`, call `appendAudit(client, { memory_id, actor: username, action: 'write', before: null, after: { type, name, description, body } })`. The `BEGIN/COMMIT` block already exists in `insertMemoryRow`; thread the same client through.
- Modify: `hub/indexer/src/memory-repo.ts` — `forgetMemory`: in the same transaction that sets `deleted_at`, call `appendAudit(client, { memory_id, actor: username, action: 'forget', before: <pre-state>, after: null })`. The pre-state is the row's `{deleted_at, name}` — fetch via `SELECT ... FOR UPDATE` so the read sees the same snapshot the update will mutate.
- Create: `hub/indexer/test/memory-audit.test.ts` — testcontainers, two cases:
  1. `writeUserMemory` produces exactly one `memory_audit_log` row with `action='write'`, matching `actor`/`memory_id`, `after.name === <name>`, `before IS NULL`.
  2. `forgetMemory` on that same memory produces a second row with `action='forget'` and `before.deleted_at IS NULL`, `after IS NULL`.
- Modify: `hub/indexer/test/memory-repo.test.ts` — no new cases; existing tests stay green (refactor regression bar).

**Acceptance:** `cd hub/indexer && npm test` green; new test file passes; pre-existing `memory-repo.test.ts` and `memory-api.test.ts` cases unchanged (we did NOT alter their behavior, only added audit emission).

---

## Task 3: `memory-repo.updateMemory` + `PUT /memory/:id`

**Goal:** Edit a user-authored memory's `name` / `description` / `body`. Recompute `content_hash`, regenerate the chunk + re-queue embedding. Reject distilled rows (403) and non-owner edits (403). Audit row written in the same transaction.

**Files:**
- Modify: `hub/indexer/src/memory-repo.ts` — add:
  ```ts
  export async function updateMemory(args: {
    pool: Pool;
    actor: string;
    memoryId: string;
    name: string;
    description: string;
    body: string;
  }): Promise<{ ok: boolean; reason?: 'not_found' | 'forbidden' | 'distilled' }> { ... }
  ```
  Implementation outline (single transaction):
  1. `SELECT username, source, name, description, body FROM memories WHERE memory_id=$1 FOR UPDATE`. If missing → return `{ok:false, reason:'not_found'}`.
  2. If `username !== actor` (and not the org-write admin path, which sub-phase C does not introduce) → `{ok:false, reason:'forbidden'}`.
  3. If `source !== 'user'` → `{ok:false, reason:'distilled'}` (preserve distillation idempotency).
  4. Compute new `content_hash = sha256(promptVersion + '\n' + name + '\n' + body)` using the existing `content-hash.ts` helper.
  5. `UPDATE memories SET name=$, description=$, body=$, content_hash=$, updated_at=now() WHERE memory_id=$`.
  6. `DELETE FROM memory_chunks WHERE memory_id=$1` then re-insert one chunk with the new body and `embedding=NULL`. Then `INSERT INTO embedder_queue (chunk_id) VALUES ($newChunkId)`.
  7. `appendAudit(client, { memory_id, actor, action:'update', before:{name,description,body}, after:{name,description,body} })`.
  8. Commit, return `{ok:true}`.
- Modify: `hub/indexer/src/memory-api.ts` — register **before** the wildcard `GET /memory/:id`:
  ```ts
  const UpdateBody = z.object({
    actor:       z.string().min(1),
    name:        z.string().min(1),
    description: z.string(),
    body:        z.string().min(1),
  });
  app.put<{ Params: { id: string } }>("/memory/:id", async (req, reply) => {
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'validation failed', issues: parsed.error.issues }; }
    const r = await deps.repo.updateMemory({
      pool: deps.pool, actor: parsed.data.actor, memoryId: req.params.id,
      name: parsed.data.name, description: parsed.data.description, body: parsed.data.body,
    });
    if (!r.ok && r.reason === 'not_found') { reply.code(404); return { error: 'memory not found' }; }
    if (!r.ok && r.reason === 'forbidden') { reply.code(403); return { error: 'not the owner' }; }
    if (!r.ok && r.reason === 'distilled') { reply.code(403); return { error: 'distilled memories are read-only' }; }
    return { ok: true };
  });
  ```
- Modify: `hub/indexer/test/memory-repo.test.ts` — three cases: happy path returns `{ok:true}` and the row's name+content_hash both changed; non-owner returns `{ok:false, reason:'forbidden'}`; distilled row returns `{ok:false, reason:'distilled'}`. Also: an `embedder_queue` row exists for the new chunk id after a successful update.
- Modify: `hub/indexer/test/memory-api.test.ts` — `inject({ method:'PUT', url:'/memory/<id>', payload:{...} })`; happy/404/403/400 cases.

**Acceptance:** All cases green. Specifically: after an update, `SELECT embedding FROM memory_chunks WHERE memory_id=$id` is `NULL` (queued, not yet re-embedded). On the next embedder tick the vector populates — that's a sub-phase A feature, no new code here.

---

## Task 4: `memory-repo.restoreMemory` + `POST /memory/:id/restore`

**Goal:** Undelete a soft-deleted memory. Owner-only. Audit row written.

**Files:**
- Modify: `hub/indexer/src/memory-repo.ts` — add:
  ```ts
  export async function restoreMemory(args: {
    pool: Pool; actor: string; memoryId: string;
  }): Promise<{ ok: boolean; reason?: 'not_found' | 'forbidden' | 'not_deleted' }> { ... }
  ```
  Same transaction shape as `updateMemory`: `SELECT ... FOR UPDATE`; check ownership; if `deleted_at IS NULL` → `not_deleted`; else `UPDATE memories SET deleted_at=NULL`; audit `{action:'restore', before:{deleted_at:<old>}, after:{deleted_at:null}}`.
- Modify: `hub/indexer/src/memory-api.ts` — register before `GET /memory/:id`:
  ```ts
  const RestoreBody = z.object({ actor: z.string().min(1) });
  app.post<{ Params: { id: string } }>("/memory/:id/restore", async (req, reply) => { ... });
  ```
  HTTP codes: 200 / 404 / 403 / 409 (`not_deleted` is a state conflict, not a validation problem).
- Modify: `hub/indexer/test/memory-repo.test.ts` — happy path; restore on a non-deleted row returns `not_deleted`; non-owner returns `forbidden`; restored row reappears in `searchMemories` (regression: soft-delete filter honors restore).
- Modify: `hub/indexer/test/memory-api.test.ts` — inject `POST /memory/:id/restore`.

**Acceptance:** All four cases green; restore writes one new audit row (4th audit type) for the same memory.

---

## Task 5: `memory-repo.listMemories` + `GET /memory/list`

**Goal:** Paginated browser-friendly listing. Filterable by scope tier, type, source, deleted-include flag. Sortable by `created_at DESC` (default) or `last_hit_at DESC`. No FTS — search is what `POST /memory/search` is for; `list` is "give me the most recent 50 user-authored project memories."

**Files:**
- Modify: `hub/indexer/src/memory-repo.ts` — add:
  ```ts
  export interface ListFilter {
    pool: Pool;
    username: string;                       // requester (for org-merge)
    project_dir: string | null;             // null = no project filter
    scope?: 'org' | 'user' | 'project';     // optional narrow
    type?: string[];                        // any-of
    source?: 'user' | 'distilled';
    include_deleted?: boolean;              // default false
    sort?: 'created' | 'hit';               // default 'created'
    limit?: number;                         // default 50, cap 200
    cursor?: string;                        // ISO timestamp from prev page's tail
  }
  export async function listMemories(f: ListFilter): Promise<{
    items: Array<{
      memory_id: string;
      type: string;
      source: 'user' | 'distilled';
      scope_tier: 'org' | 'user' | 'project';
      name: string;
      description: string;
      created_at: string;
      updated_at: string;
      hit_count: number;
      last_hit_at: string | null;
      deleted_at: string | null;
    }>;
    next_cursor: string | null;
  }> { ... }
  ```
  SQL is a straight `SELECT ... FROM memories WHERE` with the same `(username = $u OR username = '__org__')` merge as `searchMemories`, plus the optional filters AND-ed in. Cursor is `WHERE created_at < $cursor ORDER BY created_at DESC LIMIT limit+1` (or `last_hit_at < $cursor` when `sort='hit'`); the `+1` row determines `next_cursor`.
- Modify: `hub/indexer/src/memory-api.ts` — register before `GET /memory/:id`:
  ```ts
  const ListQuery = z.object({
    username:        z.string().min(1),
    project_dir:     z.string().optional(),
    scope:           z.enum(['org', 'user', 'project']).optional(),
    type:            z.array(z.string()).optional(),
    source:          z.enum(['user', 'distilled']).optional(),
    include_deleted: z.coerce.boolean().optional(),
    sort:            z.enum(['created', 'hit']).optional(),
    limit:           z.coerce.number().int().positive().max(200).optional(),
    cursor:          z.string().datetime().optional(),
  });
  app.get("/memory/list", async (req, reply) => { ... });
  ```
- Modify: `hub/indexer/test/memory-repo.test.ts` — fixtures: 3 org rows, 5 user rows, 7 project rows; assert: default returns all 15 sorted by created_at DESC; `scope='project'` returns 7; `source='user'` filters; `include_deleted=true` adds soft-deleted; cursor pagination returns the same set with no duplicates and no gaps when iterated.
- Modify: `hub/indexer/test/memory-api.test.ts` — inject() one happy path + one bad-cursor 400.

**Acceptance:** Pagination round-trip test: list with `limit=5`, follow `next_cursor` until it's null; concatenated items equal a `limit=200` single-page query.

---

## Task 6: `memory-repo.getAuditTrail` + `GET /memory/:id/audit`

**Goal:** Surface a memory's history in the detail view. Owner-only (org-rows readable by anyone, but those have no audit since sub-phase C doesn't write org rows).

**Files:**
- Modify: `hub/indexer/src/memory-repo.ts` — add:
  ```ts
  export async function getAuditTrail(args: {
    pool: Pool; actor: string; memoryId: string; limit?: number;
  }): Promise<{
    rows: Array<{ audit_id: number; action: string; actor: string; before: unknown; after: unknown; created_at: string }>;
  } | { error: 'not_found' | 'forbidden' }> { ... }
  ```
  Owner check first (lookup the memory), then `SELECT ... FROM memory_audit_log WHERE memory_id=$1 ORDER BY created_at DESC LIMIT $2`. Cap limit at 100.
- Modify: `hub/indexer/src/memory-api.ts` — register before `GET /memory/:id`:
  ```ts
  const AuditQuery = z.object({
    actor: z.string().min(1),
    limit: z.coerce.number().int().positive().max(100).optional(),
  });
  app.get<{ Params: { id: string } }>("/memory/:id/audit", async (req, reply) => { ... });
  ```
  HTTP codes: 200 / 404 / 403.
- Modify: `hub/indexer/test/memory-repo.test.ts` — happy path: write → forget → restore on the same memory; `getAuditTrail` returns 3 rows in DESC order (`restore`, `forget`, `write`).
- Modify: `hub/indexer/test/memory-api.test.ts` — one inject() per branch.

**Acceptance:** Test green; cross-task regression: the rows asserted here originate from Tasks 2 / 3 / 4 — if any of those forgot to write audit, this test catches it.

---

## Task 7: `memory-repo.getMetrics` + `GET /memory/metrics`

**Goal:** Single endpoint returning a flat object with: total memory rows, rows by type, rows by source, soft-deleted count, embedder_queue depth, oldest enqueued timestamp, distill cursor lag (max `now() - last_seen_session_last_active` across users), audit-log size.

**Files:**
- Modify: `hub/indexer/src/memory-repo.ts` — add:
  ```ts
  export async function getMetrics(pool: Pool): Promise<{
    memories_total: number;
    memories_by_type: Record<string, number>;
    memories_by_source: { user: number; distilled: number };
    memories_soft_deleted: number;
    embedder_queue_depth: number;
    embedder_queue_oldest: string | null;     // ISO or null
    distill_cursor_lag_seconds_max: number;   // 0 if every user is current
    audit_log_size: number;
  }> { ... }
  ```
  Single `SELECT` with subqueries; no joins. ~30 lines.
- Modify: `hub/indexer/src/memory-api.ts` — `app.get("/memory/metrics", async () => deps.repo.getMetrics(deps.pool))`. No params, no auth (private docker network — same trust model as `/healthz`).
- Modify: `hub/indexer/test/memory-repo.test.ts` — fixture: 4 rows (2 user, 2 distilled), 1 soft-deleted, 3 chunks queued; assert each field.
- Modify: `hub/indexer/test/memory-api.test.ts` — one inject() smoke.

**Acceptance:** `curl http://claude-bioflow-indexer:8400/memory/metrics` from inside any container returns valid JSON. Documented as a debug surface — no SLO, no alerting attached.

---

## Task 8: `adapter/src/memory-rpc.ts` — HTTP client

**Goal:** Pure transport: one method per memory-api route, the username is supplied at construction time. No business logic. Handles HTTP errors as thrown `Error`s with the API's `error` string when present (so `dispatchInner` can surface them through NATS as RPC errors).

**Files:**
- Create: `adapter/src/memory-rpc.ts`:
  ```ts
  export class MemoryRpcClient {
    constructor(private baseUrl: string, private username: string) {}

    async search(params: { project_dir?: string|null; query: string; limit?: number; types?: string[]; since?: string }) {
      return this.post('/memory/search', { username: this.username, ...params });
    }
    async get(id: string)        { return this.fetchJson(`/memory/${encodeURIComponent(id)}`); }
    async timeline(qs: { project_dir?: string; since?: string; until?: string; limit?: number }) {
      return this.fetchJson('/memory/timeline', { username: this.username, ...qs });
    }
    async list(qs: ListParams)   { return this.fetchJson('/memory/list', { username: this.username, ...qs }); }
    async write(p: WriteParams)  { return this.post('/memory/write',   { username: this.username, ...p }); }
    async update(id: string, p:  { name: string; description: string; body: string }) {
      return this.put(`/memory/${encodeURIComponent(id)}`, { actor: this.username, ...p });
    }
    async forget(id: string)     { return this.post('/memory/forget',  { username: this.username, memory_id: id }); }
    async restore(id: string)    { return this.post(`/memory/${encodeURIComponent(id)}/restore`, { actor: this.username }); }
    async audit(id: string, limit?: number) {
      return this.fetchJson(`/memory/${encodeURIComponent(id)}/audit`, { actor: this.username, limit });
    }
    // private fetchJson / post / put: build URL (querystring for GET), fetch, throw new Error(json.error || res.statusText) on !ok
  }
  ```
  Use the global `fetch` (Node 20). 5 s timeout via `AbortController`.
- Create: `adapter/test/memory-rpc.test.ts` — start a stub HTTP server (`http.createServer`) on port 0; for each method, assert the request method, path, and JSON body / querystring match expectation; assert the response is parsed back. ~150 lines.

**Acceptance:** `cd adapter && npm test -- memory-rpc` green.

---

## Task 9: `adapter/src/rpc.ts` — NATS RPC dispatch for `memory_*`

**Goal:** Nine new `case` branches in `dispatchInner`. Each takes the JSON params from the frontend, calls the matching `MemoryRpcClient` method, returns the raw response. Error from the client → throw → existing dispatcher converts to `{error: <msg>}` per the wire contract.

**Files:**
- Modify: `adapter/src/index.ts` — read `MEMORY_API_URL` from env (already set by sub-phase B's `add-user.sh`). Construct `new MemoryRpcClient(memoryApiUrl, dbCfg.username)` and pass into `RpcRouter`'s deps. If `MEMORY_API_URL` is missing, leave the client as `null` and have the RPC branches throw `Error('memory api not configured')` — never crash the adapter at boot.
- Modify: `adapter/src/rpc.ts` — extend `RpcDeps` with `memory: MemoryRpcClient | null`. Add the nine branches; each one is ~5 lines:
  ```ts
  case "memory_search": {
    if (!this.deps.memory) throw new Error("memory api not configured");
    const res = await this.deps.memory.search(params as Parameters<MemoryRpcClient['search']>[0]);
    return { success: true, ...res };
  }
  // memory_get, memory_timeline, memory_list, memory_write, memory_update,
  // memory_forget, memory_restore, memory_audit — all the same shape.
  ```
  `memory_search` returns `{success, hits}`; `memory_list` returns `{success, items, next_cursor}`; etc. Pin the wire shape now — once the frontend ships, these are a contract.
- Create: `adapter/test/rpc-memory.test.ts` — for each branch: stub `MemoryRpcClient` (vi.fn-style mock object), call `RpcRouter.dispatch('memory_search', {...})`, assert the underlying client method was called with `username` injected and the response shape matches `{success: true, ...}`.

**Acceptance:** `cd adapter && npm test` green; existing tests untouched.

---

## Task 10: frontend types + service + store

**Goal:** Pure-data plumbing the components will consume. No UI yet.

**Files:**
- Create: `frontend/src/types/memory.ts`:
  ```ts
  export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'session_summary' | 'observation';
  export type MemorySource = 'user' | 'distilled';
  export type ScopeTier = 'org' | 'user' | 'project';

  export interface MemoryListItem { memory_id: string; type: MemoryType; source: MemorySource;
    scope_tier: ScopeTier; name: string; description: string; created_at: string; updated_at: string;
    hit_count: number; last_hit_at: string | null; deleted_at: string | null; }
  export interface MemoryDetail extends MemoryListItem { body: string; facets: Record<string, string[]>;
    source_session_id: string | null; }
  export interface MemoryAuditEntry { audit_id: number; action: 'write' | 'update' | 'forget' | 'restore';
    actor: string; before: unknown; after: unknown; created_at: string; }
  ```
- Modify: `frontend/src/types/index.ts` — `export * from './memory'`.
- Create: `frontend/src/services/memory.ts` — one function per RPC method, all using `natsService.invoke('memory_*', params)`. Strip the `success: true` wrapper; rethrow on error.
  ```ts
  export const memoryService = {
    list:     (q: ListQuery)        => natsService.invoke('memory_list', q),
    get:      (id: string)          => natsService.invoke('memory_get', { memory_id: id }),
    search:   (p: SearchParams)     => natsService.invoke('memory_search', p),
    write:    (p: WriteParams)      => natsService.invoke('memory_write', p),
    update:   (p: UpdateParams)     => natsService.invoke('memory_update', p),
    forget:   (id: string)          => natsService.invoke('memory_forget', { memory_id: id }),
    restore:  (id: string)          => natsService.invoke('memory_restore', { memory_id: id }),
    audit:    (id: string)          => natsService.invoke('memory_audit', { memory_id: id }),
  } as const;
  ```
  Note: `memory_get` etc. send the id in the body even though the underlying HTTP route is path-based — the adapter handles the URL composition.
- Create: `frontend/src/stores/memory.ts` — pinia store, ~120 lines:
  ```ts
  export const useMemoryStore = defineStore('memory', () => {
    const items = ref<MemoryListItem[]>([]);
    const loading = ref(false);
    const cursor = ref<string | null>(null);
    const filters = ref<{ scope?: ScopeTier; type?: MemoryType[]; source?: MemorySource;
                          include_deleted: boolean; sort: 'created' | 'hit' }>({
      include_deleted: false, sort: 'created',
    });
    const selected = ref<MemoryDetail | null>(null);
    const audit = ref<MemoryAuditEntry[]>([]);
    const editDirty = ref(false);
    const editDraft = ref<{ name: string; description: string; body: string } | null>(null);
    const error = ref<string | null>(null);

    async function loadFirstPage() { ... resets cursor, calls memoryService.list with filters }
    async function loadMore()      { ... uses cursor }
    async function select(id)      { ... fetches detail + audit, clears editDraft }
    async function saveEdit()      { ... calls update + refreshes selected + audit }
    async function forget(id)      { ... calls forget + drops from items }
    async function restore(id)     { ... calls restore + refetches the row }
    async function memorize(p)     { ... calls write + prepends to items }
    function startEdit()           { editDraft.value = { name, description, body } }
    function cancelEdit()          { editDraft.value = null; editDirty.value = false }
    function setFilter(f)          { Object.assign(filters.value, f); loadFirstPage() }

    return { items, loading, cursor, filters, selected, audit, editDirty, editDraft, error,
             loadFirstPage, loadMore, select, saveEdit, forget, restore, memorize,
             startEdit, cancelEdit, setFilter };
  });
  ```

**Acceptance:** `cd frontend && npm run typecheck` green. No runtime smoke yet — that's Task 14.

---

## Task 11: `MemoryList.vue` — paginated rows

**Goal:** A scrollable list. One row per memory: name (bold), description (muted), source badge, scope tier badge, soft-deleted badge, relative timestamp. Click → selects in the store. Infinite scroll (intersection observer at the tail) calls `loadMore()`. Use existing design tokens — no new CSS variables.

**Files:**
- Create: `frontend/src/components/memory/MemoryList.vue` — ~200 lines. Pattern: clone the row layout from `frontend/src/components/files/FileTree.vue:` (entry rows, hover, selection state), simplify to a flat list. Use `--bg-tertiary` for the selected row and `--accent-soft` for the highlight bar.

**Acceptance:** Manual: select li86 in the dev frontend, open the (still-unrendered) memory panel via temporary debug button, see ~22 distilled rows. Typecheck green.

---

## Task 12: `MemoryDetail.vue` — view + edit + forget + restore

**Goal:** Right-hand pane (or below the list on narrow widths) that shows the selected memory's body, facets, audit trail, and the four action buttons.

**Files:**
- Create: `frontend/src/components/memory/MemoryDetail.vue` — ~280 lines.

  Sections (top to bottom):
  1. **Header**: name (display font), source/scope/type badges, created/updated relative timestamps.
  2. **Body**: pre-wrapped `<pre>` with the body text, monospaced. Marked-up if the existing `markdown-body` class works (skip `marked` rendering to keep this lightweight — body is rarely markdown for distilled rows).
  3. **Facets**: chip row, `key=value` pills, read-only.
  4. **Edit form** (only shown when `store.editDraft !== null` and `selected.source === 'user'`): three fields (name, description, body) with the existing input/textarea styles. Save triggers `store.saveEdit()`. Save button disabled when `!editDirty`.
  5. **Audit trail**: `<details>` collapsible. Each entry: timestamp + action + actor; for `update`, render a tiny diff (just "name changed" / "body changed" booleans — full diff is a follow-up).
  6. **Action bar**: `Edit` (only `source==='user'`), `Forget` (any non-deleted owner row), `Restore` (any deleted owner row). Distilled rows show a tooltip on the disabled Edit button: "Distilled memories are read-only."

- Wire `Forget` and `Restore` through a `confirm()` dialog the first time per session (zustand-style flag in the component); skip subsequent confirms in the same panel-open lifetime.

**Acceptance:** Typecheck green. Manual smoke deferred to Task 14.

---

## Task 13: `MemoryPanel.vue` — top-level container

**Goal:** The component slotted into the right panel rotation. Contains: header (search box + scope tabs + filter dropdowns), `MemoryList` (left/top), `MemoryDetail` (right/bottom).

**Files:**
- Create: `frontend/src/components/memory/MemoryPanel.vue` — ~200 lines.

  Layout: two-pane vertical split. List on top (40% height by default, resizer matches the existing `MainLayout.vue` pattern), detail below. On viewports narrower than 600 px, swap to single-pane with breadcrumbs.

  Header: search bar (debounced 300 ms; calls `memoryService.search` directly and switches `store.items` to the result set when active; clearing returns to `loadFirstPage()`), three scope tabs (`Org` / `Mine` / `Project`), a `Source` chip (toggle user/distilled), an `Include deleted` checkbox.

  When the panel mounts, call `store.loadFirstPage()`. When `MainLayout` switches away from the panel, **don't** reset state — the user's filter+selection should survive a Files/Notebook detour.

**Acceptance:** Typecheck green. Component renders standalone in `vite preview` against a stub adapter.

---

## Task 14: wire `MemoryPanel` into `MainLayout`

**Goal:** Add the toolbar button and the render branch.

**Files:**
- Modify: `frontend/src/components/layout/MainLayout.vue:20` — extend `RightPanel` union: `type RightPanel = 'none' | 'files' | 'notebook' | 'agents' | 'memory'`.
- Modify: `frontend/src/components/layout/MainLayout.vue:11-13` — add `import MemoryPanel from '@/components/memory/MemoryPanel.vue'`.
- Modify: `frontend/src/components/layout/MainLayout.vue:155-167` — add a fourth toolbar button between Agents and Files:
  ```vue
  <button class="tb-btn" :class="{ active: rightPanel === 'memory' }"
          @click="togglePanel('memory')" title="Memory">Memory</button>
  ```
- Modify: `frontend/src/components/layout/MainLayout.vue:208-211` — add a render branch:
  ```vue
  <MemoryPanel v-else-if="rightPanel === 'memory'" />
  ```

- Manual smoke (recorded in commit message): start the dev frontend pointed at li86's adapter, click `Memory`, confirm: list populates with li86's existing memories, scope tabs filter correctly, detail pane shows body for a clicked row, edit on a `source='user'` row writes a row that appears in the audit trail, forget hides from the list, `Include deleted` brings it back with a strikethrough style, restore unhides, no console errors.

**Acceptance:** `cd frontend && npm run typecheck && npm run build` green. Manual smoke notes in the commit body.

---

## Task 15: extend `test-ui.mjs` with a memory-panel pass

**Goal:** A lightweight playwright smoke that runs against li86's prod adapter. Same shape as the existing file-tree smoke. One screenshot per step for the commit-time eyeballing pass.

**Files:**
- Modify: `frontend/test-ui.mjs` — append, after the existing file-tree section:
  - Click `Memory` in the toolbar
  - Wait for `.memory-row` count > 0
  - Screenshot to `/tmp/ss-mem-1-list.png`
  - Click first row
  - Wait for `.memory-detail` visibility
  - Assert detail name matches list-item name
  - Screenshot to `/tmp/ss-mem-2-detail.png`
  - Click `Mine` scope tab
  - Wait for filter result
  - Screenshot to `/tmp/ss-mem-3-mine.png`

**Acceptance:** `node frontend/test-ui.mjs` runs end-to-end with no console errors logged. Screenshots show the panel in three states.

---

## Task 16: rollout

**Goal:** Deploy. No schema rollback path because additive-only migration; no env changes (sub-phase B already wired `MEMORY_API_URL` everywhere).

**Steps:**
- `cd /home/lili/claude-bioflow/hub && docker compose build indexer && docker compose up -d --no-deps indexer`
  Confirm migration 0009 ran: `docker exec claude-bioflow-postgres psql -U bioflow -d bioflow -c "\dt memory_audit_log"`.
- For each user (li86, test1, test2, test3): `cd /home/lili/claude-bioflow/hub && ./scripts/recreate-user.sh <user>` (only needed because the adapter image was rebuilt with the new `memory-rpc` code; the per-user volume + workspace is preserved by `recreate-user.sh`).
  Per the `feedback_indexer_rebuild` memory: source edits under `adapter/src/` need a build + recreate, not a restart.
- Rebuild the static frontend bundle: `cd /home/lili/claude-bioflow/frontend && npm run build`. Whichever process serves `frontend/dist/` (caddy / nginx — verify per-host) picks up the new assets immediately; if it's bind-mounted into a container, `docker restart` that container. Per the `feedback_bind_mount_inode` memory: a bind-mount of a single file may need a container restart, not just a content change — verify.
- Smoke (in this order, halt on first failure):
  1. `curl -fsS http://claude-bioflow-indexer:8400/memory/metrics | jq` — basic shape, queue not stuck.
  2. Open the frontend on li86 → Memory panel → list populates.
  3. `/memorize "sub-phase C smoke"` from li86's chat → row appears in the panel within one refresh.
  4. Edit that row's body in the panel → save → audit trail shows `update`; embedder queue depth drops to 0 within 10 s.
  5. Forget the row → disappears from list; toggle `Include deleted` → reappears with strikethrough; Restore → un-strikes.
  6. Repeat (2) for test1, test2, test3 — confirm cross-user isolation (test1 cannot see li86's user-scope rows; org rows visible everywhere).

**Acceptance:** Six smoke checks all green. Otherwise back out by reverting the adapter+frontend builds; the schema migration stays (no data lost). `MEMORY_ENABLED` toggling is not needed — sub-phase C never opens a critical-path code change for the agent.

---

## Phase boundary check (sub-phase C → done)

After Task 16:
- A user can open the Memory panel in any of the four production users' frontends and browse / search / edit / forget / restore their memories without leaving the chat UI.
- Every mutation writes a row to `memory_audit_log`; `memory_audit` over RPC returns the trail.
- `GET /memory/metrics` reports plausible numbers (memories_total > 0, embedder_queue_depth flat, distill_cursor_lag_seconds_max < 600 under normal load).
- Distilled memories are visible but not editable; user-authored memories edit and re-embed within ~10 s of save.
- Soft-deleted rows never appear in `memory_search` / `memory_context` / default `memory_list` — only when the panel's `Include deleted` toggle is on.
- No regressions in sub-phase A (distiller still ticks; embedder drains) or sub-phase B (`/memorize` / `/recall` / `/forget` still work; `SessionStart` injection still emits).

If any of the six bullets fails: revert adapter + frontend; schema is forward-compatible and stays. The MCP surface (Tasks 8/9 of sub-phase B) is unchanged, so the agent path remains operational regardless of the panel's state.

This is the last sub-phase of the agent-memory roadmap. After this lands, the only remaining open items in the design (§14 / §15) are deferred non-goals: paid-embedding upgrade, subagent-scoped memory, org-write API surface, and a cross-memory audit explorer — each justifying a fresh spec when prioritised.
