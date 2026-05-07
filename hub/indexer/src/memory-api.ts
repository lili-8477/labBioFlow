import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type {
  searchMemories,
  getMemory,
  timelineMemories,
  writeUserMemory,
  forgetMemory,
  getContext,
  updateMemory,
  restoreMemory,
  listMemories,
  getAuditTrail,
} from "./memory-repo.js";

// DI seam: production wires real repo functions; tests pass vi.fn stubs. Pool
// and embedderClient travel as a bag so the same `repo.searchMemories` shape
// works whether the underlying impl needs them or not.
export interface MemoryApiDeps {
  pool:           Pool;
  embedderClient: { embedTexts: (texts: string[]) => Promise<number[][]> };
  repo: {
    searchMemories:   typeof searchMemories;
    getMemory:        typeof getMemory;
    timelineMemories: typeof timelineMemories;
    writeUserMemory:  typeof writeUserMemory;
    forgetMemory:     typeof forgetMemory;
    getContext:       typeof getContext;
    updateMemory:     typeof updateMemory;
    restoreMemory:    typeof restoreMemory;
    listMemories:     typeof listMemories;
    getAuditTrail:    typeof getAuditTrail;
  };
}

// project_dir is tri-state: missing/undefined and explicit `null` both mean
// "no project filter". The repo layer normalises null → undefined / vice versa
// per its own conventions; we just pass the JSON shape through.
const SearchBody = z.object({
  username:    z.string().min(1),
  project_dir: z.string().nullable().optional(),
  query:       z.string().min(1),
  limit:       z.number().int().positive().max(100).optional(),
  types:       z.array(z.string()).optional(),
  since:       z.string().datetime().optional(),
});

const TimelineQuery = z.object({
  username:    z.string().min(1),
  // Querystring → only `string | undefined` is reachable; nullability lives
  // at the JSON body layer (search/write).
  project_dir: z.string().optional(),
  since:       z.string().datetime().optional(),
  until:       z.string().datetime().optional(),
  // Querystrings arrive as strings; zod's `coerce.number` does the int parse.
  limit:       z.coerce.number().int().positive().max(500).optional(),
});

const WriteBody = z.object({
  username:    z.string().min(1),
  scope:       z.enum(["user", "project", "org"]),
  project_dir: z.string().nullable().optional(),
  type:        z.enum(["user", "feedback", "project", "reference"]),
  name:        z.string().min(1),
  description: z.string(),
  body:        z.string(),
  facets:      z.record(z.string(), z.array(z.string())).optional(),
});

const ForgetBody = z.object({
  username:  z.string().min(1),
  memory_id: z.string().min(1),
});

const ContextQuery = z.object({
  username:      z.string().min(1),
  project_path:  z.string().min(1),
  budget_tokens: z.coerce.number().int().positive().max(100000).optional(),
});

const UpdateBody = z.object({
  actor:       z.string().min(1),
  name:        z.string().min(1),
  description: z.string(),
  body:        z.string().min(1),
});

const RestoreBody = z.object({ actor: z.string().min(1) });

// Querystring schema for GET /memory/list. Uses coerce.boolean/coerce.number
// for the same reason TimelineQuery does: querystrings arrive as strings.
// `type` arrives as repeated ?type=foo&type=bar → zod array of strings.
const ListQuery = z.object({
  username:        z.string().min(1),
  project_dir:     z.string().optional(),
  scope:           z.enum(['org', 'user', 'project']).optional(),
  type:            z.union([z.string(), z.array(z.string())]).transform((v) =>
    typeof v === 'string' ? [v] : v
  ).optional(),
  source:          z.enum(['user', 'distilled']).optional(),
  include_deleted: z.coerce.boolean().optional(),
  sort:            z.enum(['created', 'hit']).optional(),
  limit:           z.coerce.number().int().positive().max(200).optional(),
  cursor:          z.string().datetime().optional(),
});

const AuditQuery = z.object({
  actor: z.string().min(1),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export function buildApp(deps: MemoryApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ ok: true }));

  // POST /memory/search — hybrid retrieval (vector + FTS). Body validated by
  // SearchBody; ISO `since` is converted to Date at the boundary.
  app.post("/memory/search", async (req, reply) => {
    const parsed = SearchBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    const hits = await deps.repo.searchMemories({
      pool:           deps.pool,
      embedderClient: deps.embedderClient,
      username:       b.username,
      project_dir:    b.project_dir ?? null,
      query:          b.query,
      limit:          b.limit,
      types:          b.types,
      since:          b.since ? new Date(b.since) : undefined,
    });
    return hits;
  });

  // GET /memory/timeline — registered BEFORE GET /memory/:id so fastify's
  // router matches the literal "timeline" segment first; otherwise the
  // dynamic `:id` route would swallow it.
  app.get("/memory/timeline", async (req, reply) => {
    const parsed = TimelineQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    const entries = await deps.repo.timelineMemories({
      pool:        deps.pool,
      username:    q.username,
      project_dir: q.project_dir,
      since:       q.since ? new Date(q.since) : undefined,
      until:       q.until ? new Date(q.until) : undefined,
      limit:       q.limit,
    });
    return entries;
  });

  // GET /memory/context — SessionStart bundle. Default budget_tokens=2000
  // applied here per spec §7.2; the underlying getContext trusts whatever
  // number arrives.
  app.get("/memory/context", async (req, reply) => {
    const parsed = ContextQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    const ctx = await deps.repo.getContext({
      pool:          deps.pool,
      username:      q.username,
      project_path:  q.project_path,
      budget_tokens: q.budget_tokens ?? 2000,
    });
    return ctx;
  });

  // GET /memory/list — paginated listing with optional filters. Registered
  // BEFORE GET /memory/:id so fastify's router matches the literal "list"
  // segment before the dynamic :id wildcard.
  app.get("/memory/list", async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const q = parsed.data;
    return await deps.repo.listMemories({
      pool:            deps.pool,
      username:        q.username,
      project_dir:     q.project_dir ?? null,
      scope:           q.scope,
      type:            q.type,
      source:          q.source,
      include_deleted: q.include_deleted,
      sort:            q.sort,
      limit:           q.limit,
      cursor:          q.cursor,
    });
  });

  // POST /memory/write — /memorize-style user-authored memory. Returns
  // {memory_id: null} on dedup collision.
  app.post("/memory/write", async (req, reply) => {
    const parsed = WriteBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    return await deps.repo.writeUserMemory({
      pool:        deps.pool,
      username:    b.username,
      scope:       b.scope,
      project_dir: b.project_dir ?? null,
      type:        b.type,
      name:        b.name,
      description: b.description,
      body:        b.body,
      facets:      b.facets,
    });
  });

  // POST /memory/forget — soft-delete with username scoping; idempotent
  // (returns {ok:false} for already-deleted or wrong-owner ids).
  app.post("/memory/forget", async (req, reply) => {
    const parsed = ForgetBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "validation failed", issues: parsed.error.issues };
    }
    const b = parsed.data;
    return await deps.repo.forgetMemory({
      pool:     deps.pool,
      username: b.username,
      memoryId: b.memory_id,
    });
  });

  // PUT /memory/:id — edit a user-authored memory's name/description/body.
  // Rejects distilled rows (403) and non-owner edits (403). Registered BEFORE
  // GET /memory/:id to match fastify's route-registration convention in this file.
  app.put<{ Params: { id: string } }>("/memory/:id", async (req, reply) => {
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation failed', issues: parsed.error.issues };
    }
    const r = await deps.repo.updateMemory({
      pool:        deps.pool,
      actor:       parsed.data.actor,
      memoryId:    req.params.id,
      name:        parsed.data.name,
      description: parsed.data.description,
      body:        parsed.data.body,
    });
    if (!r.ok && r.reason === 'not_found') { reply.code(404); return { error: 'memory not found' }; }
    if (!r.ok && r.reason === 'forbidden')  { reply.code(403); return { error: 'not the owner' }; }
    if (!r.ok && r.reason === 'distilled')  { reply.code(403); return { error: 'distilled memories are read-only' }; }
    return { ok: true };
  });

  // POST /memory/:id/restore — undelete a soft-deleted memory. Owner-only.
  // 409 Conflict when the row is already live (not_deleted is a state mismatch,
  // not a validation problem). Registered before GET /memory/:id.
  app.post<{ Params: { id: string } }>("/memory/:id/restore", async (req, reply) => {
    const parsed = RestoreBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'validation failed', issues: parsed.error.issues }; }
    const r = await deps.repo.restoreMemory({ pool: deps.pool, actor: parsed.data.actor, memoryId: req.params.id });
    if (!r.ok && r.reason === 'not_found')   { reply.code(404); return { error: 'memory not found' }; }
    if (!r.ok && r.reason === 'forbidden')   { reply.code(403); return { error: 'not the owner' }; }
    if (!r.ok && r.reason === 'not_deleted') { reply.code(409); return { error: 'memory is not deleted' }; }
    return { ok: true };
  });

  // GET /memory/:id/audit — fetch audit trail for a memory. Owner-only.
  // Registered before GET /memory/:id so literal "/audit" segment takes precedence.
  app.get<{ Params: { id: string } }>("/memory/:id/audit", async (req, reply) => {
    const parsed = AuditQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation failed', issues: parsed.error.issues };
    }
    const q = parsed.data;
    const result = await deps.repo.getAuditTrail({
      pool:     deps.pool,
      actor:    q.actor,
      memoryId: req.params.id,
      limit:    q.limit,
    });
    if ('error' in result) {
      if (result.error === 'not_found') { reply.code(404); return { error: 'memory not found' }; }
      if (result.error === 'forbidden') { reply.code(403); return { error: 'not the owner' }; }
    }
    return result;
  });

  // GET /memory/:id — must be registered AFTER literal /memory/* routes
  // so fastify's radix tree prefers static segments over the wildcard.
  app.get<{ Params: { id: string } }>("/memory/:id", async (req, reply) => {
    const detail = await deps.repo.getMemory(deps.pool, req.params.id);
    if (detail === null) {
      reply.code(404);
      return { error: "memory not found" };
    }
    return detail;
  });

  return app;
}
