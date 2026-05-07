import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { insertMemoryRow } from "../src/distiller-repo.js";
import { contentHash } from "../src/content-hash.js";
import { searchMemories, getMemory, timelineMemories, writeUserMemory, forgetMemory, getContext, updateMemory, restoreMemory, listMemories, getAuditTrail } from "../src/memory-repo.js";

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
  await pool.query("TRUNCATE memories CASCADE");
});

const DIM = 384;

function unitVector(seed: number): number[] {
  // Deterministic pseudo-random unit vector of length DIM. Seed varies so
  // distinct memories get distinct embeddings; the test does not depend on
  // any particular pairwise ordering by vector similarity (the SQL's scope
  // multiplier dominates), only that the embedding is non-null and FTS
  // matches.
  let s = seed * 1_000_003 + 7;
  const v: number[] = [];
  let sumSq = 0;
  for (let i = 0; i < DIM; i++) {
    s = (s * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    const x = (s / 0x7fff_ffff) - 0.5;
    v.push(x);
    sumSq += x * x;
  }
  const norm = Math.sqrt(sumSq) || 1;
  return v.map((x) => x / norm);
}

function vecLiteral(v: number[]): string {
  return "[" + v.join(",") + "]";
}

interface SeedArgs {
  username:    string;
  project_dir: string | null;
  body:        string;
  seed:        number;
  // Optional embedding seed; defaults to a fixed value so all rows share the
  // same vec_sim and the SQL's scope multiplier alone decides ordering.
  embedSeed?:  number;
  type?:       string;
}

async function seedMemory(args: SeedArgs): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const memId = await insertMemoryRow(client, {
      username:          args.username,
      project_dir:       args.project_dir,
      source:            "user",
      type:              args.type ?? "observation",
      source_session_id: null,
      name:              `seed-${args.seed}`,
      description:       `desc-${args.seed}`,
      body:              args.body,
      facets:            {},
      content_hash:      contentHash({ body: args.body, promptVersion: args.seed }),
    });
    if (!memId) throw new Error("seed dedup collision");
    await client.query(
      `UPDATE memory_chunks
          SET embedding = $1::vector
        WHERE memory_id = $2`,
      [vecLiteral(unitVector(args.embedSeed ?? 42)), memId],
    );
    await client.query("COMMIT");
    return memId;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

const QUERY_BODY = "preprocessing single cell scanpy normalisation log1p pipeline";
const QUERY     = "scanpy preprocessing pipeline";

const stubEmbedder = {
  embedTexts: async (_texts: string[]) => [unitVector(999)],
};

const downEmbedder = {
  embedTexts: async (_texts: string[]) => { throw new Error("embedder down"); },
};

describe("searchMemories", () => {
  it("returns project > user > org for the same FTS body and increments hit_count", async () => {
    const orgId     = await seedMemory({ username: "__org__", project_dir: null,   body: QUERY_BODY, seed: 1 });
    const userId    = await seedMemory({ username: "alice",   project_dir: null,   body: QUERY_BODY, seed: 2 });
    const projectId = await seedMemory({ username: "alice",   project_dir: "-w-p", body: QUERY_BODY, seed: 3 });

    const hits = await searchMemories({
      pool,
      embedderClient: stubEmbedder,
      username:    "alice",
      project_dir: "-w-p",
      query:       QUERY,
      limit:       10,
    });

    expect(hits.map((h) => h.memory_id)).toEqual([projectId, userId, orgId]);
    expect(hits.map((h) => h.scope_tier)).toEqual(["project", "user", "org"]);
    for (const h of hits) {
      expect(h.snippet.length).toBeGreaterThan(0);
      expect(h.snippet.length).toBeLessThanOrEqual(200);
      expect(typeof h.score).toBe("number");
      expect(Number.isFinite(h.score)).toBe(true);
    }
    // Ordering must be by score (not insertion order); scope multiplier
    // dominates here, so scores must be strictly descending.
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[1].score).toBeGreaterThan(hits[2].score);

    const counts = await pool.query<{ memory_id: string; hit_count: number }>(
      `SELECT memory_id, hit_count FROM memories
        WHERE memory_id = ANY($1::uuid[])`,
      [[orgId, userId, projectId]],
    );
    for (const r of counts.rows) expect(r.hit_count).toBe(1);

    const lastHit = await pool.query<{ memory_id: string; last_hit_at: Date | null }>(
      `SELECT memory_id, last_hit_at FROM memories
        WHERE memory_id = ANY($1::uuid[])`,
      [[orgId, userId, projectId]],
    );
    for (const r of lastHit.rows) expect(r.last_hit_at).not.toBeNull();
  });

  it("excludes soft-deleted memories", async () => {
    const liveId    = await seedMemory({ username: "alice", project_dir: "-w-p", body: QUERY_BODY, seed: 4 });
    const deletedId = await seedMemory({ username: "alice", project_dir: "-w-p", body: QUERY_BODY, seed: 5 });
    await pool.query("UPDATE memories SET deleted_at = now() WHERE memory_id = $1", [deletedId]);

    const hits = await searchMemories({
      pool, embedderClient: stubEmbedder,
      username: "alice", project_dir: "-w-p", query: QUERY, limit: 10,
    });
    const ids = hits.map((h) => h.memory_id);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(deletedId);
  });

  it("falls back to FTS when the embedder throws", async () => {
    const id = await seedMemory({ username: "alice", project_dir: "-w-p", body: QUERY_BODY, seed: 6 });
    const hits = await searchMemories({
      pool, embedderClient: downEmbedder,
      username: "alice", project_dir: "-w-p", query: QUERY, limit: 10,
    });
    expect(hits.map((h) => h.memory_id)).toContain(id);
    // No NaN poisoning from the dropped vector arm — every score must be
    // a finite number.
    for (const h of hits) expect(Number.isFinite(h.score)).toBe(true);
  });

  it("FTS-only fallback orders results by ts_rank when scope is equal", async () => {
    // Same scope (project) so the scope/popularity/recency multipliers are
    // identical; ranking must come from ts_rank(fts_score) alone. The strong
    // body repeats the query terms more often than the weak body.
    // plainto_tsquery is conjunctive — both bodies must contain every query
    // term ("scanpy", "preprocessing", "pipeline"). Strong repeats them many
    // times; weak mentions each once buried in unrelated padding.
    const STRONG = "scanpy preprocessing pipeline scanpy preprocessing pipeline scanpy preprocessing pipeline scanpy preprocessing pipeline";
    const WEAK   = "scanpy preprocessing pipeline " + "padding ".repeat(80);
    const weakId   = await seedMemory({ username: "alice", project_dir: "-w-p", body: WEAK,   seed: 101 });
    const strongId = await seedMemory({ username: "alice", project_dir: "-w-p", body: STRONG, seed: 102 });

    const hits = await searchMemories({
      pool, embedderClient: downEmbedder,
      username: "alice", project_dir: "-w-p", query: QUERY, limit: 10,
    });
    const ids = hits.map((h) => h.memory_id);
    expect(ids).toContain(strongId);
    expect(ids).toContain(weakId);
    expect(ids.indexOf(strongId)).toBeLessThan(ids.indexOf(weakId));
    const strongHit = hits.find((h) => h.memory_id === strongId)!;
    const weakHit   = hits.find((h) => h.memory_id === weakId)!;
    expect(strongHit.score).toBeGreaterThan(weakHit.score);
  });

  it("respects the types filter", async () => {
    const observationId = await seedMemory({
      username: "alice", project_dir: "-w-p", body: QUERY_BODY, seed: 7,
    });
    const feedbackId = await seedMemory({
      username: "alice", project_dir: "-w-p", body: QUERY_BODY, seed: 8, type: "feedback",
    });

    const onlyFeedback = await searchMemories({
      pool, embedderClient: stubEmbedder,
      username: "alice", project_dir: "-w-p", query: QUERY, limit: 10,
      types: ["feedback"],
    });
    const ids = onlyFeedback.map((h) => h.memory_id);
    expect(ids).toContain(feedbackId);
    expect(ids).not.toContain(observationId);
  });

  it("respects the since filter and the limit", async () => {
    const oldId = await seedMemory({ username: "alice", project_dir: "-w-p", body: QUERY_BODY, seed: 9 });
    await pool.query(
      `UPDATE memories SET created_at = now() - interval '30 days' WHERE memory_id = $1`,
      [oldId],
    );
    const newId = await seedMemory({ username: "alice", project_dir: "-w-p", body: QUERY_BODY, seed: 10 });

    const recent = await searchMemories({
      pool, embedderClient: stubEmbedder,
      username: "alice", project_dir: "-w-p", query: QUERY, limit: 10,
      since: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    const ids = recent.map((h) => h.memory_id);
    expect(ids).toContain(newId);
    expect(ids).not.toContain(oldId);

    const oneOnly = await searchMemories({
      pool, embedderClient: stubEmbedder,
      username: "alice", project_dir: "-w-p", query: QUERY, limit: 1,
    });
    expect(oneOnly.length).toBe(1);
  });
});

async function addFacets(memId: string, facets: Record<string, string[]>): Promise<void> {
  for (const [k, vs] of Object.entries(facets)) {
    for (const v of vs) {
      await pool.query(
        `INSERT INTO memory_facets (memory_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [memId, k, v],
      );
    }
  }
}

describe("getMemory", () => {
  it("returns the row with facets grouped by key, values sorted", async () => {
    const id = await seedMemory({
      username: "alice", project_dir: "-w-p", body: "any body text", seed: 200,
    });
    await addFacets(id, {
      tool: ["STAR", "fastp"],
      gene: ["TP53"],
    });

    const got = await getMemory(pool, id);
    expect(got).not.toBeNull();
    expect(got!.memory_id).toBe(id);
    expect(got!.username).toBe("alice");
    expect(got!.project_dir).toBe("-w-p");
    expect(got!.type).toBe("observation");
    expect(got!.source).toBe("user");
    expect(got!.name).toBe("seed-200");
    expect(got!.description).toBe("desc-200");
    expect(got!.body).toBe("any body text");
    expect(got!.source_session_id).toBeNull();
    expect(got!.hit_count).toBe(0);
    expect(got!.last_hit_at).toBeNull();
    expect(got!.created_at).toBeInstanceOf(Date);
    expect(got!.updated_at).toBeInstanceOf(Date);
    // facets grouped by key; values returned in sorted order.
    expect(got!.facets).toEqual({
      tool: ["STAR", "fastp"],
      gene: ["TP53"],
    });
  });

  it("returns an empty facets object when the row has no facets", async () => {
    const id = await seedMemory({
      username: "alice", project_dir: null, body: "no facets here", seed: 201,
    });
    const got = await getMemory(pool, id);
    expect(got).not.toBeNull();
    expect(got!.facets).toEqual({});
  });

  it("returns null for a nonexistent id", async () => {
    const got = await getMemory(pool, "00000000-0000-0000-0000-000000000000");
    expect(got).toBeNull();
  });

  it("returns null for soft-deleted rows", async () => {
    const id = await seedMemory({
      username: "alice", project_dir: "-w-p", body: "soon deleted", seed: 202,
    });
    await pool.query("UPDATE memories SET deleted_at = now() WHERE memory_id = $1", [id]);
    const got = await getMemory(pool, id);
    expect(got).toBeNull();
  });
});

describe("timelineMemories", () => {
  async function seedAt(args: SeedArgs, createdAt: Date): Promise<string> {
    const id = await seedMemory(args);
    await pool.query(
      `UPDATE memories SET created_at = $1 WHERE memory_id = $2`,
      [createdAt.toISOString(), id],
    );
    return id;
  }

  it("returns rows newest first and excludes soft-deleted ones", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-02-01T00:00:00Z");
    const t2 = new Date("2026-03-01T00:00:00Z");
    const oldId    = await seedAt({ username: "alice", project_dir: "-w-p", body: "old",    seed: 300 }, t0);
    const midId    = await seedAt({ username: "alice", project_dir: "-w-p", body: "mid",    seed: 301 }, t1);
    const newId    = await seedAt({ username: "alice", project_dir: "-w-p", body: "new",    seed: 302 }, t2);
    const goneId   = await seedAt({ username: "alice", project_dir: "-w-p", body: "gone",   seed: 303 }, t1);
    await pool.query("UPDATE memories SET deleted_at = now() WHERE memory_id = $1", [goneId]);

    const rows = await timelineMemories({ pool, username: "alice" });
    expect(rows.map((r) => r.memory_id)).toEqual([newId, midId, oldId]);
    expect(rows.every((r) => r.created_at instanceof Date)).toBe(true);
    expect(rows[0].name).toBe("seed-302");
    expect(rows[0].type).toBe("observation");
  });

  it("respects since/until inclusive bounds", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-02-01T00:00:00Z");
    const t2 = new Date("2026-03-01T00:00:00Z");
    const id0 = await seedAt({ username: "alice", project_dir: "-w-p", body: "a", seed: 310 }, t0);
    const id1 = await seedAt({ username: "alice", project_dir: "-w-p", body: "b", seed: 311 }, t1);
    const id2 = await seedAt({ username: "alice", project_dir: "-w-p", body: "c", seed: 312 }, t2);

    const inWindow = await timelineMemories({
      pool, username: "alice",
      since: t1,
      until: t2,
    });
    expect(inWindow.map((r) => r.memory_id)).toEqual([id2, id1]);

    const onlyOldest = await timelineMemories({
      pool, username: "alice",
      until: t0,
    });
    expect(onlyOldest.map((r) => r.memory_id)).toEqual([id0]);
  });

  it("includes __org__ rows for a user query and excludes other users", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-02-01T00:00:00Z");
    const orgId   = await seedAt({ username: "__org__", project_dir: null,  body: "org",   seed: 320 }, t0);
    const aliceId = await seedAt({ username: "alice",   project_dir: "-w-p", body: "alice", seed: 321 }, t1);
    const bobId   = await seedAt({ username: "bob",     project_dir: "-w-p", body: "bob",   seed: 322 }, t1);

    const rows = await timelineMemories({ pool, username: "alice" });
    const ids = rows.map((r) => r.memory_id);
    expect(ids).toEqual([aliceId, orgId]);
    expect(ids).not.toContain(bobId);
  });

  it("filters by project_dir only when a string is supplied; undefined and null are no-filter", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-02-01T00:00:00Z");
    const t2 = new Date("2026-03-01T00:00:00Z");
    const userId    = await seedAt({ username: "alice", project_dir: null,  body: "user",  seed: 330 }, t0);
    const projAId   = await seedAt({ username: "alice", project_dir: "-w-a", body: "projA", seed: 331 }, t1);
    const projBId   = await seedAt({ username: "alice", project_dir: "-w-b", body: "projB", seed: 332 }, t2);

    // undefined → no filter
    const all = await timelineMemories({ pool, username: "alice" });
    expect(all.map((r) => r.memory_id)).toEqual([projBId, projAId, userId]);

    // null → also no filter (documented as same as undefined)
    const allNull = await timelineMemories({ pool, username: "alice", project_dir: null });
    expect(allNull.map((r) => r.memory_id)).toEqual([projBId, projAId, userId]);

    // string → exact match only
    const onlyA = await timelineMemories({ pool, username: "alice", project_dir: "-w-a" });
    expect(onlyA.map((r) => r.memory_id)).toEqual([projAId]);
  });

  it("respects the limit (default 50, override honoured)", async () => {
    const base = new Date("2026-01-01T00:00:00Z").getTime();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await seedAt(
        { username: "alice", project_dir: "-w-p", body: `b${i}`, seed: 400 + i },
        new Date(base + i * 60_000),
      ));
    }
    const two = await timelineMemories({ pool, username: "alice", limit: 2 });
    expect(two.length).toBe(2);
    // newest first → ids[4], ids[3]
    expect(two.map((r) => r.memory_id)).toEqual([ids[4], ids[3]]);
  });
});

describe("writeUserMemory", () => {
  it("scope='user' writes a row with (username, NULL) and source='user'", async () => {
    const { memory_id } = await writeUserMemory({
      pool,
      username:    "alice",
      scope:       "user",
      project_dir: null,
      type:        "user",
      name:        "remember the alamo",
      description: "a personal note",
      body:        "alice prefers fastp over trimmomatic for adapter trimming",
    });
    expect(memory_id).not.toBeNull();
    const r = await pool.query<{ username: string; project_dir: string | null; source: string }>(
      `SELECT username, project_dir, source FROM memories WHERE memory_id = $1`,
      [memory_id],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].username).toBe("alice");
    expect(r.rows[0].project_dir).toBeNull();
    expect(r.rows[0].source).toBe("user");
  });

  it("scope='user' coerces project_dir to NULL even when caller passes a non-null value", async () => {
    const { memory_id } = await writeUserMemory({
      pool,
      username:    "alice",
      scope:       "user",
      project_dir: "-w-leaked-from-api",   // simulating an API-layer bug
      type:        "user",
      name:        "coercion check",
      description: "verify defensive coercion",
      body:        "user-scope must drop any project_dir the caller leaked through",
    });
    expect(memory_id).not.toBeNull();
    const r = await pool.query<{ project_dir: string | null }>(
      `SELECT project_dir FROM memories WHERE memory_id = $1`,
      [memory_id],
    );
    expect(r.rows[0].project_dir).toBeNull();
  });

  it("scope='project' writes a row with (username, project_dir)", async () => {
    const { memory_id } = await writeUserMemory({
      pool,
      username:    "alice",
      scope:       "project",
      project_dir: "-w-bio-pipeline",
      type:        "project",
      name:        "project convention",
      description: "default thread count is 16 for STAR alignment in this project",
      body:        "use --runThreadN 16 when invoking STAR; project nodes have 16 vCPU",
    });
    expect(memory_id).not.toBeNull();
    const r = await pool.query<{ username: string; project_dir: string | null; source: string }>(
      `SELECT username, project_dir, source FROM memories WHERE memory_id = $1`,
      [memory_id],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].username).toBe("alice");
    expect(r.rows[0].project_dir).toBe("-w-bio-pipeline");
    expect(r.rows[0].source).toBe("user");
  });

  it("scope='project' without project_dir throws", async () => {
    await expect(
      writeUserMemory({
        pool,
        username:    "alice",
        scope:       "project",
        project_dir: null,
        type:        "project",
        name:        "no dir",
        description: "should fail",
        body:        "this should fail because project scope needs a project_dir",
      }),
    ).rejects.toThrow(/project_dir/);
  });

  it("scope='org' throws (admin-only)", async () => {
    await expect(
      writeUserMemory({
        pool,
        username:    "alice",
        scope:       "org",
        project_dir: null,
        type:        "reference",
        name:        "policy",
        description: "should fail",
        body:        "users cannot write org-scope memories from inside their container",
      }),
    ).rejects.toThrow(/admin-only/);
  });

  it("creates exactly one chunk in memory_chunks", async () => {
    const { memory_id } = await writeUserMemory({
      pool,
      username:    "alice",
      scope:       "user",
      project_dir: null,
      type:        "user",
      name:        "chunk-test",
      description: "verifies chunk creation",
      body:        "the body of a user memory should land as a single chunk",
    });
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_chunks WHERE memory_id = $1`,
      [memory_id],
    );
    expect(r.rows[0].count).toBe("1");
  });

  it("enqueues exactly one row in embedder_queue for the new chunk", async () => {
    const { memory_id } = await writeUserMemory({
      pool,
      username:    "alice",
      scope:       "user",
      project_dir: null,
      type:        "user",
      name:        "queue-test",
      description: "verifies embedder queue insertion",
      body:        "a fresh chunk must enqueue an embedder job exactly once",
    });
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM embedder_queue
        WHERE chunk_id IN (SELECT chunk_id FROM memory_chunks WHERE memory_id = $1)`,
      [memory_id],
    );
    expect(r.rows[0].count).toBe("1");
  });

  it("writes facets when supplied", async () => {
    const { memory_id } = await writeUserMemory({
      pool,
      username:    "alice",
      scope:       "user",
      project_dir: null,
      type:        "user",
      name:        "facet-test",
      description: "verifies facets persist",
      body:        "alice prefers fastp",
      facets:      { tool: ["fastp"] },
    });
    const r = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM memory_facets WHERE memory_id = $1 ORDER BY key, value`,
      [memory_id],
    );
    expect(r.rows).toEqual([{ key: "tool", value: "fastp" }]);
  });

  it("dedups identical content: second call returns memory_id=null", async () => {
    const args = {
      pool,
      username:    "alice" as const,
      scope:       "user" as const,
      project_dir: null,
      type:        "user" as const,
      name:        "dup-test",
      description: "first write",
      body:        "alice always uses scanpy for single-cell analysis pipelines",
    };
    const first = await writeUserMemory(args);
    expect(first.memory_id).not.toBeNull();
    const second = await writeUserMemory(args);
    expect(second.memory_id).toBeNull();
  });
});

describe("forgetMemory", () => {
  it("soft-deletes own memory and getMemory subsequently returns null", async () => {
    const id = await seedMemory({
      username: "alice", project_dir: "-w-p", body: "to be forgotten", seed: 500,
    });
    const before = await getMemory(pool, id);
    expect(before).not.toBeNull();

    const res = await forgetMemory({ pool, username: "alice", memoryId: id });
    expect(res).toEqual({ ok: true });

    const after = await getMemory(pool, id);
    expect(after).toBeNull();

    // Confirm deleted_at was set (and updated_at advanced) without nuking
    // chunks / facets / queue rows.
    const r = await pool.query<{ deleted_at: Date | null; updated_at: Date }>(
      `SELECT deleted_at, updated_at FROM memories WHERE memory_id = $1`,
      [id],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].deleted_at).not.toBeNull();
    const chunkCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_chunks WHERE memory_id = $1`,
      [id],
    );
    expect(chunkCount.rows[0].count).toBe("1");
  });

  it("returns {ok: false} for a nonexistent id", async () => {
    const res = await forgetMemory({
      pool, username: "alice",
      memoryId: "00000000-0000-0000-0000-000000000000",
    });
    expect(res).toEqual({ ok: false });
  });

  it("returns {ok: false} when caller does not own the memory", async () => {
    const bobId = await seedMemory({
      username: "bob", project_dir: "-w-p", body: "bob's memory", seed: 501,
    });
    const res = await forgetMemory({ pool, username: "alice", memoryId: bobId });
    expect(res).toEqual({ ok: false });

    // bob's row is still alive
    const got = await getMemory(pool, bobId);
    expect(got).not.toBeNull();
  });

  it("is idempotent: a second forget on the same id returns {ok: false}", async () => {
    const id = await seedMemory({
      username: "alice", project_dir: "-w-p", body: "double-forget", seed: 502,
    });
    const first = await forgetMemory({ pool, username: "alice", memoryId: id });
    expect(first).toEqual({ ok: true });
    const second = await forgetMemory({ pool, username: "alice", memoryId: id });
    expect(second).toEqual({ ok: false });
  });
});

describe("getContext", () => {
  it("returns empty bundle when the user has no memories", async () => {
    const ctx = await getContext({
      pool, username: "alice",
      project_path: "/workspace",
      budget_tokens: 2000,
    });
    expect(ctx).toEqual({ system_prompt: "", memory_ids: [] });
  });

  it("includes a single memory and emits the header line", async () => {
    const id = await seedMemory({
      username: "alice", project_dir: null,
      body: "alice prefers fastp for adapter trimming", seed: 600,
    });
    const ctx = await getContext({
      pool, username: "alice",
      project_path: "/workspace",
      budget_tokens: 2000,
    });
    expect(ctx.memory_ids).toEqual([id]);
    expect(ctx.system_prompt.startsWith("# Memory Context\n\n[")).toBe(true);
    expect(ctx.system_prompt).toContain("[user:observation] seed-600");
    expect(ctx.system_prompt).toContain("alice prefers fastp for adapter trimming");
  });

  it("orders multiple in-budget memories by score DESC (project > user > org)", async () => {
    // Encoded form of "/workspace/pbmc3k" → "-workspace-pbmc3k"
    const projectDir = "-workspace-pbmc3k";
    const orgId     = await seedMemory({ username: "__org__", project_dir: null,        body: "org body",     seed: 610 });
    const userId    = await seedMemory({ username: "alice",   project_dir: null,        body: "user body",    seed: 611 });
    const projectId = await seedMemory({ username: "alice",   project_dir: projectDir,  body: "project body", seed: 612 });

    const ctx = await getContext({
      pool, username: "alice",
      project_path: "/workspace/pbmc3k",
      budget_tokens: 2000,
    });
    expect(ctx.memory_ids).toEqual([projectId, userId, orgId]);

    // Order in the prompt mirrors memory_ids order
    const prj = ctx.system_prompt.indexOf("seed-612");
    const usr = ctx.system_prompt.indexOf("seed-611");
    const org = ctx.system_prompt.indexOf("seed-610");
    expect(prj).toBeGreaterThan(-1);
    expect(usr).toBeGreaterThan(prj);
    expect(org).toBeGreaterThan(usr);

    // Header lines exist for each scope tier
    expect(ctx.system_prompt).toContain("[project:observation] seed-612");
    expect(ctx.system_prompt).toContain("[user:observation] seed-611");
    expect(ctx.system_prompt).toContain("[org:observation] seed-610");
  });

  it("includes at least one memory even when budget is too small to fit any", async () => {
    const id = await seedMemory({
      username: "alice", project_dir: null,
      body: "x".repeat(500), seed: 620,
    });
    // budget_tokens=1 → 4 chars budget; the single memory will overshoot.
    const ctx = await getContext({
      pool, username: "alice",
      project_path: "/workspace",
      budget_tokens: 1,
    });
    expect(ctx.memory_ids).toEqual([id]);
    expect(ctx.system_prompt.length).toBeGreaterThan(4);
  });

  it("excludes soft-deleted memories", async () => {
    const liveId = await seedMemory({
      username: "alice", project_dir: null, body: "live", seed: 630,
    });
    const goneId = await seedMemory({
      username: "alice", project_dir: null, body: "gone", seed: 631,
    });
    await pool.query("UPDATE memories SET deleted_at = now() WHERE memory_id = $1", [goneId]);

    const ctx = await getContext({
      pool, username: "alice",
      project_path: "/workspace",
      budget_tokens: 2000,
    });
    expect(ctx.memory_ids).toContain(liveId);
    expect(ctx.memory_ids).not.toContain(goneId);
  });

  it("excludes sentinel 'raw distillation failed' rows", async () => {
    const goodId = await seedMemory({
      username: "alice", project_dir: null, body: "good content", seed: 640,
    });
    const badId = await seedMemory({
      username: "alice", project_dir: null, body: "bad content", seed: 641,
    });
    await pool.query(
      `UPDATE memories SET name = 'raw distillation failed' WHERE memory_id = $1`,
      [badId],
    );

    const ctx = await getContext({
      pool, username: "alice",
      project_path: "/workspace",
      budget_tokens: 2000,
    });
    expect(ctx.memory_ids).toContain(goodId);
    expect(ctx.memory_ids).not.toContain(badId);
  });

  it("includes __org__ memories alongside the user's own", async () => {
    const orgId  = await seedMemory({ username: "__org__", project_dir: null, body: "org rule", seed: 650 });
    const userId = await seedMemory({ username: "alice",   project_dir: null, body: "user pref", seed: 651 });
    const otherId = await seedMemory({ username: "bob",    project_dir: null, body: "bob's", seed: 652 });

    const ctx = await getContext({
      pool, username: "alice",
      project_path: "/workspace",
      budget_tokens: 2000,
    });
    expect(ctx.memory_ids).toContain(orgId);
    expect(ctx.memory_ids).toContain(userId);
    expect(ctx.memory_ids).not.toContain(otherId);
  });

  it("encodes project_path into the encoded_project_dir filter", async () => {
    // Only project rows whose project_dir matches the encoded form should
    // surface; rows for other projects (or for the same human path encoded
    // differently) must be excluded.
    const matchingId = await seedMemory({
      username: "alice", project_dir: "-workspace-pbmc3k",
      body: "matches", seed: 660,
    });
    const otherProjectId = await seedMemory({
      username: "alice", project_dir: "-workspace-other",
      body: "other", seed: 661,
    });

    const ctx = await getContext({
      pool, username: "alice",
      project_path: "/workspace/pbmc3k",
      budget_tokens: 2000,
    });
    expect(ctx.memory_ids).toContain(matchingId);
    expect(ctx.memory_ids).not.toContain(otherProjectId);
  });
});

describe("updateMemory", () => {
  it("happy path: updates name/description/body, recomputes content_hash, re-queues chunk", async () => {
    const id = await seedMemory({
      username: "alice", project_dir: null,
      body: "original body text", seed: 700,
    });

    // Capture the original content_hash and chunk_id
    const before = await pool.query<{ content_hash: Buffer; name: string }>(
      `SELECT content_hash, name FROM memories WHERE memory_id = $1`,
      [id],
    );
    const origHash = before.rows[0]!.content_hash;

    const res = await updateMemory({
      pool,
      actor: "alice",
      memoryId: id,
      name: "updated name",
      description: "updated description",
      body: "updated body text",
    });
    expect(res).toEqual({ ok: true });

    // Row fields updated
    const after = await pool.query<{ name: string; description: string; body: string; content_hash: Buffer }>(
      `SELECT name, description, body, content_hash FROM memories WHERE memory_id = $1`,
      [id],
    );
    expect(after.rows[0]!.name).toBe("updated name");
    expect(after.rows[0]!.description).toBe("updated description");
    expect(after.rows[0]!.body).toBe("updated body text");
    // content_hash must differ from original
    expect(Buffer.compare(after.rows[0]!.content_hash, origHash)).not.toBe(0);

    // Chunk embedding is NULL (queued, not yet re-embedded)
    const chunk = await pool.query<{ embedding: unknown | null }>(
      `SELECT embedding FROM memory_chunks WHERE memory_id = $1`,
      [id],
    );
    expect(chunk.rowCount).toBe(1);
    expect(chunk.rows[0]!.embedding).toBeNull();

    // embedder_queue row exists for the new chunk
    const queue = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM embedder_queue
        WHERE chunk_id IN (SELECT chunk_id FROM memory_chunks WHERE memory_id = $1)`,
      [id],
    );
    expect(queue.rows[0]!.count).toBe("1");

    // audit row was written with action='update' and correct before/after
    const audit = await pool.query<{ action: string; before: unknown; after: unknown }>(
      `SELECT action, before, after FROM memory_audit_log
        WHERE memory_id = $1 AND action = 'update'`,
      [id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]!.action).toBe("update");
    const auditBefore = audit.rows[0]!.before as Record<string, unknown>;
    const auditAfter  = audit.rows[0]!.after  as Record<string, unknown>;
    expect(auditBefore.name).toBe("seed-700");
    expect(auditBefore.body).toBe("original body text");
    expect(auditAfter.name).toBe("updated name");
    expect(auditAfter.body).toBe("updated body text");
  });

  it("non-owner: returns {ok:false, reason:'forbidden'}", async () => {
    const id = await seedMemory({
      username: "bob", project_dir: null,
      body: "bob's private note", seed: 701,
    });
    const res = await updateMemory({
      pool,
      actor: "alice",
      memoryId: id,
      name: "hacked",
      description: "hacked",
      body: "hacked body",
    });
    expect(res).toEqual({ ok: false, reason: "forbidden" });

    // Row must be untouched
    const row = await pool.query<{ name: string }>(
      `SELECT name FROM memories WHERE memory_id = $1`,
      [id],
    );
    expect(row.rows[0]!.name).toBe("seed-701");
  });

  it("distilled row: returns {ok:false, reason:'distilled'}", async () => {
    // Insert a distilled memory directly (seedMemory always uses source='user')
    const distId = await pool.query<{ memory_id: string }>(
      `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'alice', NULL, 'observation', 'distilled', 'distilled-name', 'distilled-desc',
               'distilled body', $1)
       RETURNING memory_id`,
      [contentHash({ body: "distilled-namedistilled body", promptVersion: 1 })],
    );
    const distMemoryId = distId.rows[0]!.memory_id;

    const res = await updateMemory({
      pool,
      actor: "alice",
      memoryId: distMemoryId,
      name: "new name",
      description: "new desc",
      body: "new body",
    });
    expect(res).toEqual({ ok: false, reason: "distilled" });
  });

  it("not_found: returns {ok:false, reason:'not_found'} for a missing id", async () => {
    const res = await updateMemory({
      pool,
      actor: "alice",
      memoryId: "00000000-0000-0000-0000-000000000000",
      name: "x",
      description: "y",
      body: "z",
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("audit log grows by exactly one per successful update", async () => {
    const id = await seedMemory({
      username: "alice", project_dir: null,
      body: "audit count check", seed: 702,
    });

    const countBefore = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_audit_log WHERE memory_id = $1`,
      [id],
    );
    await updateMemory({
      pool, actor: "alice", memoryId: id,
      name: "new name A", description: "new desc A", body: "new body A",
    });
    const countAfter = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memory_audit_log WHERE memory_id = $1`,
      [id],
    );
    expect(parseInt(countAfter.rows[0]!.count) - parseInt(countBefore.rows[0]!.count)).toBe(1);
  });
});

describe("restoreMemory", () => {
  it("happy path: restores a soft-deleted row, clears deleted_at, writes audit row", async () => {
    const id = await seedMemory({
      username: "alice", project_dir: null,
      body: "to be restored", seed: 800,
    });
    // Soft-delete it first
    await forgetMemory({ pool, username: "alice", memoryId: id });
    const deletedRow = await pool.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM memories WHERE memory_id = $1`,
      [id],
    );
    expect(deletedRow.rows[0]!.deleted_at).not.toBeNull();
    const oldDeletedAt = deletedRow.rows[0]!.deleted_at!;

    const res = await restoreMemory({ pool, actor: "alice", memoryId: id });
    expect(res).toEqual({ ok: true });

    // deleted_at is cleared
    const after = await pool.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM memories WHERE memory_id = $1`,
      [id],
    );
    expect(after.rows[0]!.deleted_at).toBeNull();

    // audit row has action='restore', correct before/after
    const audit = await pool.query<{ action: string; before: unknown; after: unknown }>(
      `SELECT action, before, after FROM memory_audit_log
        WHERE memory_id = $1 AND action = 'restore'`,
      [id],
    );
    expect(audit.rowCount).toBe(1);
    const auditBefore = audit.rows[0]!.before as Record<string, unknown>;
    const auditAfter  = audit.rows[0]!.after  as Record<string, unknown>;
    // before.deleted_at should encode the timestamp we captured
    expect(auditBefore.deleted_at).not.toBeNull();
    expect(new Date(auditBefore.deleted_at as string).getTime()).toBeCloseTo(oldDeletedAt.getTime(), -3);
    expect(auditAfter.deleted_at).toBeNull();
  });

  it("not_deleted: returns {ok:false, reason:'not_deleted'} for a live row", async () => {
    const id = await seedMemory({
      username: "alice", project_dir: null,
      body: "still alive", seed: 801,
    });
    const res = await restoreMemory({ pool, actor: "alice", memoryId: id });
    expect(res).toEqual({ ok: false, reason: "not_deleted" });
  });

  it("non-owner: returns {ok:false, reason:'forbidden'}", async () => {
    const id = await seedMemory({
      username: "bob", project_dir: null,
      body: "bob's memory", seed: 802,
    });
    // Soft-delete as bob
    await pool.query("UPDATE memories SET deleted_at = now() WHERE memory_id = $1", [id]);

    const res = await restoreMemory({ pool, actor: "alice", memoryId: id });
    expect(res).toEqual({ ok: false, reason: "forbidden" });

    // Row must still be deleted
    const row = await pool.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM memories WHERE memory_id = $1`,
      [id],
    );
    expect(row.rows[0]!.deleted_at).not.toBeNull();
  });

  it("not_found: returns {ok:false, reason:'not_found'} for a missing id", async () => {
    const res = await restoreMemory({
      pool, actor: "alice",
      memoryId: "00000000-0000-0000-0000-000000000000",
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("regression: restored row reappears in searchMemories (soft-delete filter honors restore)", async () => {
    const id = await seedMemory({
      username: "alice", project_dir: "-w-p", body: QUERY_BODY, seed: 803,
    });

    // Forget → confirm absent from search
    await forgetMemory({ pool, username: "alice", memoryId: id });
    const afterForget = await searchMemories({
      pool, embedderClient: stubEmbedder,
      username: "alice", project_dir: "-w-p", query: QUERY, limit: 10,
    });
    expect(afterForget.map((h) => h.memory_id)).not.toContain(id);

    // Restore → confirm visible again
    await restoreMemory({ pool, actor: "alice", memoryId: id });
    const afterRestore = await searchMemories({
      pool, embedderClient: stubEmbedder,
      username: "alice", project_dir: "-w-p", query: QUERY, limit: 10,
    });
    expect(afterRestore.map((h) => h.memory_id)).toContain(id);
  });
});

describe("getAuditTrail", () => {
  it("happy path: write → forget → restore returns 3 rows in DESC order (restore, forget, write)", async () => {
    const { memory_id } = await writeUserMemory({
      pool,
      username:    "alice",
      scope:       "user",
      project_dir: null,
      type:        "user",
      name:        "audit-trail-test",
      description: "testing audit trail",
      body:        "original body",
    });
    expect(memory_id).not.toBeNull();

    // Forget the memory
    const forgetRes = await forgetMemory({ pool, username: "alice", memoryId: memory_id! });
    expect(forgetRes.ok).toBe(true);

    // Restore the memory
    const restoreRes = await restoreMemory({ pool, actor: "alice", memoryId: memory_id! });
    expect(restoreRes.ok).toBe(true);

    // Fetch audit trail
    const result = await getAuditTrail({
      pool,
      actor:    "alice",
      memoryId: memory_id!,
    });

    expect("rows" in result).toBe(true);
    const rows = (result as any).rows;
    expect(rows).toHaveLength(3);

    // Order must be DESC by created_at: restore, forget, write
    expect(rows[0]!.action).toBe("restore");
    expect(rows[1]!.action).toBe("forget");
    expect(rows[2]!.action).toBe("write");

    // Verify created_at is ISO string
    for (const row of rows) {
      expect(typeof row.created_at).toBe("string");
      expect(() => new Date(row.created_at)).not.toThrow();
    }
  });

  it("not_found: returns {error:'not_found'} for missing memory_id", async () => {
    const result = await getAuditTrail({
      pool,
      actor:    "alice",
      memoryId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result).toEqual({ error: "not_found" });
  });

  it("forbidden: returns {error:'forbidden'} when actor is not the owner", async () => {
    const { memory_id } = await writeUserMemory({
      pool,
      username:    "bob",
      scope:       "user",
      project_dir: null,
      type:        "user",
      name:        "bob's memory",
      description: "desc",
      body:        "body",
    });
    expect(memory_id).not.toBeNull();

    const result = await getAuditTrail({
      pool,
      actor:    "alice",
      memoryId: memory_id!,
    });
    expect(result).toEqual({ error: "forbidden" });
  });

  it("respects limit parameter (max 100)", async () => {
    // Create a memory to get its ID
    const { memory_id } = await writeUserMemory({
      pool,
      username:    "alice",
      scope:       "user",
      project_dir: null,
      type:        "user",
      name:        "limit-test",
      description: "testing limit",
      body:        "body",
    });
    expect(memory_id).not.toBeNull();

    // Fetch with limit=1
    const result = await getAuditTrail({
      pool,
      actor:    "alice",
      memoryId: memory_id!,
      limit:    1,
    });

    expect("rows" in result).toBe(true);
    const rows = (result as any).rows;
    expect(rows.length).toBeLessThanOrEqual(1);
  });
});

// ─── helpers for listMemories tests ────────────────────────────────────────

// Seed a memory and backdate its created_at so ordering is deterministic.
async function seedAt2(args: SeedArgs, createdAt: Date): Promise<string> {
  const id = await seedMemory(args);
  await pool.query(
    `UPDATE memories SET created_at = $1 WHERE memory_id = $2`,
    [createdAt.toISOString(), id],
  );
  return id;
}

describe("listMemories", () => {
  // Fixtures: 3 org rows, 5 user rows, 7 project rows = 15 total
  // Seeds 900–914 are reserved for this suite.
  const BASE = new Date("2025-01-01T00:00:00Z").getTime();

  async function seedAll(): Promise<{
    orgIds:     string[];
    userIds:    string[];
    projectIds: string[];
  }> {
    const orgIds: string[]     = [];
    const userIds: string[]    = [];
    const projectIds: string[] = [];

    for (let i = 0; i < 3; i++) {
      orgIds.push(await seedAt2(
        { username: "__org__", project_dir: null, body: `org-body-${i}`, seed: 900 + i },
        new Date(BASE + i * 60_000),
      ));
    }
    for (let i = 0; i < 5; i++) {
      userIds.push(await seedAt2(
        { username: "alice", project_dir: null, body: `user-body-${i}`, seed: 903 + i },
        new Date(BASE + (3 + i) * 60_000),
      ));
    }
    for (let i = 0; i < 7; i++) {
      projectIds.push(await seedAt2(
        { username: "alice", project_dir: "-w-list", body: `project-body-${i}`, seed: 908 + i },
        new Date(BASE + (8 + i) * 60_000),
      ));
    }
    return { orgIds, userIds, projectIds };
  }

  it("default: returns all 15 sorted by created_at DESC", async () => {
    const { orgIds, userIds, projectIds } = await seedAll();
    const allIds = [...orgIds, ...userIds, ...projectIds];

    const result = await listMemories({
      pool,
      username:    "alice",
      project_dir: null,
      limit:       200,
    });

    expect(result.next_cursor).toBeNull();
    expect(result.items).toHaveLength(15);

    // Verify descending created_at order
    const ts = result.items.map((x) => new Date(x.created_at).getTime());
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]!).toBeLessThanOrEqual(ts[i - 1]!);
    }

    // All 15 ids present
    const returnedIds = result.items.map((x) => x.memory_id);
    for (const id of allIds) {
      expect(returnedIds).toContain(id);
    }
  });

  it("scope='project' returns exactly the 7 project rows", async () => {
    const { projectIds } = await seedAll();

    const result = await listMemories({
      pool,
      username:    "alice",
      project_dir: null,
      scope:       'project',
      limit:       200,
    });

    expect(result.items).toHaveLength(7);
    const returnedIds = result.items.map((x) => x.memory_id);
    for (const id of projectIds) {
      expect(returnedIds).toContain(id);
    }
    // Confirm scope_tier is 'project' for all
    for (const item of result.items) {
      expect(item.scope_tier).toBe('project');
    }
  });

  it("source='user' filter returns only user-sourced rows", async () => {
    await seedAll();
    // Also insert a distilled row
    const distId = await pool.query<{ memory_id: string }>(
      `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body, content_hash)
       VALUES (gen_random_uuid(), 'alice', NULL, 'observation', 'distilled', 'distilled-list', 'distilled-desc',
               'distilled body for list test', $1)
       RETURNING memory_id`,
      [contentHash({ body: "distilled-listdistilled body for list test", promptVersion: 99 })],
    );
    const distMemId = distId.rows[0]!.memory_id;

    const result = await listMemories({
      pool,
      username:    "alice",
      project_dir: null,
      source:      'user',
      limit:       200,
    });

    const returnedIds = result.items.map((x) => x.memory_id);
    expect(returnedIds).not.toContain(distMemId);
    for (const item of result.items) {
      expect(item.source).toBe('user');
    }
  });

  it("include_deleted=true adds soft-deleted rows to result", async () => {
    const { userIds } = await seedAll();
    // Soft-delete one user row
    const targetId = userIds[0]!;
    await pool.query("UPDATE memories SET deleted_at = now() WHERE memory_id = $1", [targetId]);

    const withoutDeleted = await listMemories({
      pool,
      username:        "alice",
      project_dir:     null,
      include_deleted: false,
      limit:           200,
    });
    expect(withoutDeleted.items.map((x) => x.memory_id)).not.toContain(targetId);

    const withDeleted = await listMemories({
      pool,
      username:        "alice",
      project_dir:     null,
      include_deleted: true,
      limit:           200,
    });
    expect(withDeleted.items.map((x) => x.memory_id)).toContain(targetId);
    const deletedItem = withDeleted.items.find((x) => x.memory_id === targetId)!;
    expect(deletedItem.deleted_at).not.toBeNull();
  });

  it("pagination round-trip: limit=5 cursor-follow equals single limit=200 query (set equality)", async () => {
    // Use all 15 rows seeded by seedAll
    await seedAll();

    // Single-page reference
    const reference = await listMemories({
      pool,
      username:    "alice",
      project_dir: null,
      limit:       200,
    });
    const referenceIds = reference.items.map((x) => x.memory_id);
    expect(referenceIds).toHaveLength(15);

    // Paginate with limit=5
    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listMemories({
        pool,
        username:    "alice",
        project_dir: null,
        limit:       5,
        cursor:      cursor ?? undefined,
      });
      for (const item of page.items) {
        collected.push(item.memory_id);
      }
      cursor = page.next_cursor;
      pages++;
      // Safety: should never take more than 4 pages for 15 rows with limit=5
      expect(pages).toBeLessThanOrEqual(4);
    } while (cursor !== null);

    // Set equality: same ids, no duplicates, no gaps
    expect(collected).toHaveLength(15);
    expect(new Set(collected).size).toBe(15);
    expect(new Set(collected)).toEqual(new Set(referenceIds));
  });
});
