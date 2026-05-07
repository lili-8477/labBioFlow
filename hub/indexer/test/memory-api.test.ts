import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Pool } from "pg";
import { buildApp, type MemoryApiDeps } from "../src/memory-api.js";
import type {
  SearchHit,
  MemoryDetail,
  TimelineEntry,
  MemoryContext,
  ListItem,
} from "../src/memory-repo.js";

// Tiny test-double factory: every repo function is a vi.fn() with a sensible
// default return. Tests override on a per-case basis with mockResolvedValueOnce.
function makeDeps(): { deps: MemoryApiDeps; repo: {
  searchMemories:   ReturnType<typeof vi.fn>;
  getMemory:        ReturnType<typeof vi.fn>;
  timelineMemories: ReturnType<typeof vi.fn>;
  writeUserMemory:  ReturnType<typeof vi.fn>;
  forgetMemory:     ReturnType<typeof vi.fn>;
  getContext:       ReturnType<typeof vi.fn>;
  updateMemory:     ReturnType<typeof vi.fn>;
  restoreMemory:    ReturnType<typeof vi.fn>;
  listMemories:     ReturnType<typeof vi.fn>;
  getAuditTrail:    ReturnType<typeof vi.fn>;
  getMetrics:       ReturnType<typeof vi.fn>;
  writeDistillation: ReturnType<typeof vi.fn>;
} } {
  const repo = {
    searchMemories:   vi.fn(async (): Promise<SearchHit[]>     => []),
    getMemory:        vi.fn(async (): Promise<MemoryDetail | null> => null),
    timelineMemories: vi.fn(async (): Promise<TimelineEntry[]> => []),
    writeUserMemory:  vi.fn(async (): Promise<{ memory_id: string | null }> => ({ memory_id: "m-1" })),
    forgetMemory:     vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true })),
    getContext:       vi.fn(async (): Promise<MemoryContext>   => ({ system_prompt: "", memory_ids: [] })),
    updateMemory:     vi.fn(async (): Promise<{ ok: boolean; reason?: 'not_found' | 'forbidden' | 'distilled' }> => ({ ok: true })),
    restoreMemory:    vi.fn(async (): Promise<{ ok: boolean; reason?: 'not_found' | 'forbidden' | 'not_deleted' }> => ({ ok: true })),
    listMemories:     vi.fn(async (): Promise<{ items: ListItem[]; next_cursor: string | null }> => ({ items: [], next_cursor: null })),
    getAuditTrail:    vi.fn(async (): Promise<{ rows: never[] } | { error: 'not_found' | 'forbidden' }> => ({ rows: [] })),
    getMetrics:       vi.fn(async (): Promise<{ memories_total: number; memories_by_type: Record<string, number>; memories_by_source: { user: number; distilled: number }; memories_soft_deleted: number; embedder_queue_depth: number; embedder_queue_oldest: string | null; distill_cursor_lag_seconds_max: number; audit_log_size: number }> => ({
      memories_total: 0,
      memories_by_type: {},
      memories_by_source: { user: 0, distilled: 0 },
      memories_soft_deleted: 0,
      embedder_queue_depth: 0,
      embedder_queue_oldest: null,
      distill_cursor_lag_seconds_max: 0,
      audit_log_size: 0,
    })),
    writeDistillation: vi.fn(async (): Promise<void> => {}),
  };
  const deps: MemoryApiDeps = {
    pool: {} as Pool,
    embedderClient: { embedTexts: vi.fn(async () => []) },
    repo,
  };
  return { deps, repo };
}

describe("memory-api", () => {
  let depsBag: ReturnType<typeof makeDeps>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    if (app) await app.close();
    depsBag = makeDeps();
    app = buildApp(depsBag.deps);
  });

  it("GET /healthz returns 200 + { ok: true }", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  // ────────────────────────────── /memory/search ──────────────────────────────

  describe("POST /memory/search", () => {
    it("happy path: forwards to searchMemories and returns hits", async () => {
      const hits: SearchHit[] = [
        { memory_id: "a", name: "n", description: "d", snippet: "s", score: 0.9, scope_tier: "user" },
      ];
      depsBag.repo.searchMemories.mockResolvedValueOnce(hits);

      const res = await app.inject({
        method:  "POST",
        url:     "/memory/search",
        payload: {
          username:    "alice",
          project_dir: "-workspace-foo",
          query:       "vector query",
          limit:       5,
          types:       ["user", "project"],
          since:       "2026-01-01T00:00:00Z",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(hits);
      expect(depsBag.repo.searchMemories).toHaveBeenCalledTimes(1);
      const arg = depsBag.repo.searchMemories.mock.calls[0]![0];
      expect(arg.username).toBe("alice");
      expect(arg.project_dir).toBe("-workspace-foo");
      expect(arg.query).toBe("vector query");
      expect(arg.limit).toBe(5);
      expect(arg.types).toEqual(["user", "project"]);
      expect(arg.since).toBeInstanceOf(Date);
      expect(arg.since.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(arg.pool).toBe(depsBag.deps.pool);
      expect(arg.embedderClient).toBe(depsBag.deps.embedderClient);
    });

    it("treats project_dir=null as no-filter and omits since when absent", async () => {
      depsBag.repo.searchMemories.mockResolvedValueOnce([]);
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/search",
        payload: { username: "alice", project_dir: null, query: "q" },
      });
      expect(res.statusCode).toBe(200);
      const arg = depsBag.repo.searchMemories.mock.calls[0]![0];
      expect(arg.project_dir).toBeNull();
      expect(arg.since).toBeUndefined();
    });

    it("400 when username is missing", async () => {
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/search",
        payload: { query: "q" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.searchMemories).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────── /memory/:id ────────────────────────────────

  describe("GET /memory/:id", () => {
    it("happy path: returns the detail when getMemory finds it", async () => {
      const detail: MemoryDetail = {
        memory_id:         "abc",
        username:          "alice",
        project_dir:       null,
        type:              "user",
        source:            "user",
        name:              "test",
        description:       "desc",
        body:              "body",
        source_session_id: null,
        facets:            {},
        hit_count:         0,
        last_hit_at:       null,
        created_at:        new Date("2026-01-01T00:00:00Z"),
        updated_at:        new Date("2026-01-01T00:00:00Z"),
      };
      depsBag.repo.getMemory.mockResolvedValueOnce(detail);

      const res = await app.inject({ method: "GET", url: "/memory/abc" });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.memory_id).toBe("abc");
      expect(json.username).toBe("alice");
      expect(depsBag.repo.getMemory).toHaveBeenCalledWith(depsBag.deps.pool, "abc");
    });

    it("returns 404 when getMemory returns null", async () => {
      depsBag.repo.getMemory.mockResolvedValueOnce(null);
      const res = await app.inject({ method: "GET", url: "/memory/missing" });
      expect(res.statusCode).toBe(404);
    });
  });

  // ───────────────────────────── /memory/timeline ─────────────────────────────

  describe("GET /memory/timeline", () => {
    it("happy path: forwards query params and converts since/until to Date", async () => {
      const entries: TimelineEntry[] = [
        { memory_id: "x", name: "n", type: "user", created_at: new Date("2026-01-01T00:00:00Z") },
      ];
      depsBag.repo.timelineMemories.mockResolvedValueOnce(entries);

      const res = await app.inject({
        method: "GET",
        url:
          "/memory/timeline?username=alice&project_dir=-workspace-foo" +
          "&since=2026-01-01T00:00:00Z&until=2026-02-01T00:00:00Z&limit=20",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
      const arg = depsBag.repo.timelineMemories.mock.calls[0]![0];
      expect(arg.username).toBe("alice");
      expect(arg.project_dir).toBe("-workspace-foo");
      expect(arg.since).toBeInstanceOf(Date);
      expect(arg.since.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(arg.until).toBeInstanceOf(Date);
      expect(arg.until.toISOString()).toBe("2026-02-01T00:00:00.000Z");
      expect(arg.limit).toBe(20);
    });

    it("400 when username is missing", async () => {
      const res = await app.inject({ method: "GET", url: "/memory/timeline?limit=10" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.timelineMemories).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────── /memory/write ───────────────────────────────

  describe("POST /memory/write", () => {
    it("happy path: forwards args and returns the inserted id", async () => {
      depsBag.repo.writeUserMemory.mockResolvedValueOnce({ memory_id: "new-id" });
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/write",
        payload: {
          username:    "alice",
          scope:       "user",
          project_dir: null,
          type:        "user",
          name:        "n",
          description: "d",
          body:        "b",
          facets:      { tag: ["x"] },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ memory_id: "new-id" });
      const arg = depsBag.repo.writeUserMemory.mock.calls[0]![0];
      expect(arg.scope).toBe("user");
      expect(arg.project_dir).toBeNull();
      expect(arg.facets).toEqual({ tag: ["x"] });
      expect(arg.pool).toBe(depsBag.deps.pool);
    });

    it("happy path: dedup returns memory_id=null", async () => {
      depsBag.repo.writeUserMemory.mockResolvedValueOnce({ memory_id: null });
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/write",
        payload: {
          username:    "alice",
          scope:       "user",
          type:        "user",
          name:        "n",
          description: "d",
          body:        "b",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ memory_id: null });
    });

    it("400 when scope is missing", async () => {
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/write",
        payload: { username: "alice", type: "user", name: "n", description: "d", body: "b" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.writeUserMemory).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────── /memory/forget ──────────────────────────────

  describe("POST /memory/forget", () => {
    it("happy path: forwards memoryId + username and returns ok", async () => {
      depsBag.repo.forgetMemory.mockResolvedValueOnce({ ok: true });
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/forget",
        payload: { username: "alice", memory_id: "abc" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const arg = depsBag.repo.forgetMemory.mock.calls[0]![0];
      expect(arg.username).toBe("alice");
      expect(arg.memoryId).toBe("abc");
      expect(arg.pool).toBe(depsBag.deps.pool);
    });

    it("400 when memory_id is missing", async () => {
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/forget",
        payload: { username: "alice" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.forgetMemory).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────── /memory/context ─────────────────────────────

  describe("GET /memory/context", () => {
    it("happy path: applies default budget_tokens=2000 when omitted", async () => {
      const ctx: MemoryContext = { system_prompt: "hi", memory_ids: ["a"] };
      depsBag.repo.getContext.mockResolvedValueOnce(ctx);

      const res = await app.inject({
        method: "GET",
        url:    "/memory/context?username=alice&project_path=/workspace/foo",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(ctx);
      const arg = depsBag.repo.getContext.mock.calls[0]![0];
      expect(arg.username).toBe("alice");
      expect(arg.project_path).toBe("/workspace/foo");
      expect(arg.budget_tokens).toBe(2000);
    });

    it("happy path: honours explicit budget_tokens", async () => {
      depsBag.repo.getContext.mockResolvedValueOnce({ system_prompt: "", memory_ids: [] });
      const res = await app.inject({
        method: "GET",
        url:    "/memory/context?username=alice&project_path=/workspace/foo&budget_tokens=500",
      });
      expect(res.statusCode).toBe(200);
      const arg = depsBag.repo.getContext.mock.calls[0]![0];
      expect(arg.budget_tokens).toBe(500);
    });

    it("400 when project_path is missing", async () => {
      const res = await app.inject({
        method: "GET",
        url:    "/memory/context?username=alice",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.getContext).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────── PUT /memory/:id ────────────────────────────────

  describe("PUT /memory/:id", () => {
    const validPayload = {
      actor:       "alice",
      name:        "updated name",
      description: "updated description",
      body:        "updated body text",
    };

    it("happy path: calls updateMemory and returns {ok:true}", async () => {
      depsBag.repo.updateMemory.mockResolvedValueOnce({ ok: true });
      const res = await app.inject({
        method:  "PUT",
        url:     "/memory/abc-123",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(depsBag.repo.updateMemory).toHaveBeenCalledTimes(1);
      const arg = depsBag.repo.updateMemory.mock.calls[0]![0];
      expect(arg.actor).toBe("alice");
      expect(arg.memoryId).toBe("abc-123");
      expect(arg.name).toBe("updated name");
      expect(arg.description).toBe("updated description");
      expect(arg.body).toBe("updated body text");
      expect(arg.pool).toBe(depsBag.deps.pool);
    });

    it("404 when repo returns not_found", async () => {
      depsBag.repo.updateMemory.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const res = await app.inject({
        method:  "PUT",
        url:     "/memory/missing-id",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "memory not found" });
    });

    it("403 when repo returns forbidden", async () => {
      depsBag.repo.updateMemory.mockResolvedValueOnce({ ok: false, reason: "forbidden" });
      const res = await app.inject({
        method:  "PUT",
        url:     "/memory/other-users-id",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "not the owner" });
    });

    it("403 when repo returns distilled", async () => {
      depsBag.repo.updateMemory.mockResolvedValueOnce({ ok: false, reason: "distilled" });
      const res = await app.inject({
        method:  "PUT",
        url:     "/memory/distilled-id",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "distilled memories are read-only" });
    });

    it("400 when actor is missing", async () => {
      const res = await app.inject({
        method:  "PUT",
        url:     "/memory/abc-123",
        payload: { name: "n", description: "d", body: "b" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.updateMemory).not.toHaveBeenCalled();
    });

    it("400 when body is missing", async () => {
      const res = await app.inject({
        method:  "PUT",
        url:     "/memory/abc-123",
        payload: { actor: "alice", name: "n", description: "d" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.updateMemory).not.toHaveBeenCalled();
    });
  });

  // ───────────────────── POST /memory/:id/restore ─────────────────────────────

  describe("POST /memory/:id/restore", () => {
    const validPayload = { actor: "alice" };

    it("happy path: calls restoreMemory and returns {ok:true}", async () => {
      depsBag.repo.restoreMemory.mockResolvedValueOnce({ ok: true });
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/abc-123/restore",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(depsBag.repo.restoreMemory).toHaveBeenCalledTimes(1);
      const arg = depsBag.repo.restoreMemory.mock.calls[0]![0];
      expect(arg.actor).toBe("alice");
      expect(arg.memoryId).toBe("abc-123");
      expect(arg.pool).toBe(depsBag.deps.pool);
    });

    it("404 when repo returns not_found", async () => {
      depsBag.repo.restoreMemory.mockResolvedValueOnce({ ok: false, reason: "not_found" });
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/missing-id/restore",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "memory not found" });
    });

    it("403 when repo returns forbidden", async () => {
      depsBag.repo.restoreMemory.mockResolvedValueOnce({ ok: false, reason: "forbidden" });
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/other-users-id/restore",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "not the owner" });
    });

    it("409 when repo returns not_deleted (memory is still live)", async () => {
      depsBag.repo.restoreMemory.mockResolvedValueOnce({ ok: false, reason: "not_deleted" });
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/live-id/restore",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "memory is not deleted" });
    });

    it("400 when actor is missing", async () => {
      const res = await app.inject({
        method:  "POST",
        url:     "/memory/abc-123/restore",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.restoreMemory).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────── GET /memory/list ───────────────────────────────

  describe("GET /memory/list", () => {
    const sampleItem: ListItem = {
      memory_id:   "abc",
      type:        "observation",
      source:      "user",
      scope_tier:  "user",
      name:        "test memory",
      description: "desc",
      created_at:  "2026-01-01T00:00:00.000Z",
      updated_at:  "2026-01-01T00:00:00.000Z",
      hit_count:   0,
      last_hit_at: null,
      deleted_at:  null,
    };

    it("happy path: forwards query params and returns items + next_cursor", async () => {
      depsBag.repo.listMemories.mockResolvedValueOnce({
        items:       [sampleItem],
        next_cursor: "2026-01-01T00:00:00.000Z",
      });

      const res = await app.inject({
        method: "GET",
        url:    "/memory/list?username=alice&project_dir=-w-foo&scope=user&source=user&limit=50&sort=created",
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.items).toHaveLength(1);
      expect(json.items[0].memory_id).toBe("abc");
      expect(json.next_cursor).toBe("2026-01-01T00:00:00.000Z");

      expect(depsBag.repo.listMemories).toHaveBeenCalledTimes(1);
      const arg = depsBag.repo.listMemories.mock.calls[0]![0];
      expect(arg.username).toBe("alice");
      expect(arg.project_dir).toBe("-w-foo");
      expect(arg.scope).toBe("user");
      expect(arg.source).toBe("user");
      expect(arg.limit).toBe(50);
      expect(arg.sort).toBe("created");
      expect(arg.pool).toBe(depsBag.deps.pool);
    });

    it("400 when cursor is not a valid ISO datetime", async () => {
      const res = await app.inject({
        method: "GET",
        url:    "/memory/list?username=alice&cursor=not-a-date",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.listMemories).not.toHaveBeenCalled();
    });

    it.each([
      ["true",   true],
      ["false",  false],
      [undefined, false],  // missing key → transform returns false, the spec default
    ] as const)(
      "include_deleted=%s parses to %s (z.coerce.boolean would coerce non-empty strings to true)",
      async (raw, expected) => {
        const url = raw === undefined
          ? "/memory/list?username=alice"
          : `/memory/list?username=alice&include_deleted=${raw}`;
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(200);
        const arg = depsBag.repo.listMemories.mock.calls[0]![0];
        expect(arg.include_deleted).toBe(expected);
      },
    );

    it("400 when include_deleted is something other than 'true'/'false'", async () => {
      const res = await app.inject({
        method: "GET",
        url:    "/memory/list?username=alice&include_deleted=yes",
      });
      expect(res.statusCode).toBe(400);
      expect(depsBag.repo.listMemories).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────── GET /memory/:id/audit ───────────────────────────────

  describe("GET /memory/:id/audit", () => {
    it("happy path: returns audit rows when owner requests", async () => {
      depsBag.repo.getAuditTrail.mockResolvedValueOnce({
        rows: [
          { audit_id: 1, action: "write", actor: "alice", before: null, after: { name: "mem" }, created_at: "2026-01-01T00:00:00.000Z" },
        ],
      });

      const res = await app.inject({
        method: "GET",
        url:    "/memory/abc-123/audit?actor=alice&limit=50",
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.rows).toHaveLength(1);
      expect(json.rows[0].audit_id).toBe(1);
      expect(json.rows[0].action).toBe("write");

      expect(depsBag.repo.getAuditTrail).toHaveBeenCalledTimes(1);
      const arg = depsBag.repo.getAuditTrail.mock.calls[0]![0];
      expect(arg.actor).toBe("alice");
      expect(arg.memoryId).toBe("abc-123");
      expect(arg.limit).toBe(50);
      expect(arg.pool).toBe(depsBag.deps.pool);
    });

    it("404 when repo returns not_found", async () => {
      depsBag.repo.getAuditTrail.mockResolvedValueOnce({ error: "not_found" });
      const res = await app.inject({
        method: "GET",
        url:    "/memory/missing-id/audit?actor=alice",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "memory not found" });
    });

    it("403 when repo returns forbidden", async () => {
      depsBag.repo.getAuditTrail.mockResolvedValueOnce({ error: "forbidden" });
      const res = await app.inject({
        method: "GET",
        url:    "/memory/other-users-id/audit?actor=alice",
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "not the owner" });
    });

    it("400 when actor is missing", async () => {
      const res = await app.inject({
        method: "GET",
        url:    "/memory/abc-123/audit",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation failed", issues: expect.any(Array) });
      expect(depsBag.repo.getAuditTrail).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────── /memory/distill ──────────────────────────

  describe("POST /memory/distill", () => {
    const validBody = {
      username:    "alice",
      project_dir: "-home-alice-proj",
      summary: { name: "n", description: "d", body: "b" },
      observations: [
        { type: "decision", name: "n", description: "d", body: "b", facets: { tool: ["seqkit"] } },
      ],
    };

    it("happy path: forwards summary+observations to writeDistillation, returns attempted count", async () => {
      const res = await app.inject({ method: "POST", url: "/memory/distill", payload: validBody });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, attempted: 2 });
      expect(depsBag.repo.writeDistillation).toHaveBeenCalledTimes(1);
      const arg = depsBag.repo.writeDistillation.mock.calls[0]![1];
      expect(arg.sessionMeta.username).toBe("alice");
      expect(arg.sessionMeta.project_dir).toBe("-home-alice-proj");
      expect(arg.sessionMeta.source_session_id).toBeNull();
      expect(arg.result.summary).toEqual(validBody.summary);
      expect(arg.result.observations).toEqual(validBody.observations);
    });

    it("empty observations array is valid; attempted=1", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/memory/distill",
        payload: { ...validBody, observations: [] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, attempted: 1 });
    });

    it("source_session_id is forwarded when provided", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/memory/distill",
        payload: { ...validBody, source_session_id: "abc-123" },
      });
      expect(res.statusCode).toBe(200);
      const arg = depsBag.repo.writeDistillation.mock.calls[0]![1];
      expect(arg.sessionMeta.source_session_id).toBe("abc-123");
    });

    it("rejects payload missing summary with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/memory/distill",
        payload: { username: "alice", observations: [] },
      });
      expect(res.statusCode).toBe(400);
      expect(depsBag.repo.writeDistillation).not.toHaveBeenCalled();
    });

    it("rejects observation with invalid type with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/memory/distill",
        payload: {
          ...validBody,
          observations: [{ type: "speculation", name: "n", description: "d", body: "b", facets: {} }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(depsBag.repo.writeDistillation).not.toHaveBeenCalled();
    });

    it("rejects more than 8 observations with 400", async () => {
      const obs = Array.from({ length: 9 }, () => ({
        type: "finding", name: "n", description: "d", body: "b", facets: {},
      }));
      const res = await app.inject({
        method: "POST",
        url: "/memory/distill",
        payload: { ...validBody, observations: obs },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ────────────────────────────── /memory/metrics ──────────────────────────

  describe("GET /memory/metrics", () => {
    it("returns metrics from repo.getMetrics", async () => {
      const mockMetrics = {
        memories_total: 10,
        memories_by_type: { observation: 5, feedback: 3, insight: 2 },
        memories_by_source: { user: 7, distilled: 3 },
        memories_soft_deleted: 2,
        embedder_queue_depth: 5,
        embedder_queue_oldest: "2026-05-07T10:00:00Z",
        distill_cursor_lag_seconds_max: 120.5,
        audit_log_size: 25,
      };
      depsBag.repo.getMetrics = vi.fn(async () => mockMetrics);

      const res = await app.inject({ method: "GET", url: "/memory/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(mockMetrics);
      expect(depsBag.repo.getMetrics).toHaveBeenCalledTimes(1);
      expect(depsBag.repo.getMetrics).toHaveBeenCalledWith(depsBag.deps.pool);
    });
  });
});
