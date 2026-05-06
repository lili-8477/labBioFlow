import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Pool } from "pg";
import { buildApp, type MemoryApiDeps } from "../src/memory-api.js";
import type {
  SearchHit,
  MemoryDetail,
  TimelineEntry,
  MemoryContext,
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
} } {
  const repo = {
    searchMemories:   vi.fn(async (): Promise<SearchHit[]>     => []),
    getMemory:        vi.fn(async (): Promise<MemoryDetail | null> => null),
    timelineMemories: vi.fn(async (): Promise<TimelineEntry[]> => []),
    writeUserMemory:  vi.fn(async (): Promise<{ memory_id: string | null }> => ({ memory_id: "m-1" })),
    forgetMemory:     vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true })),
    getContext:       vi.fn(async (): Promise<MemoryContext>   => ({ system_prompt: "", memory_ids: [] })),
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
});
