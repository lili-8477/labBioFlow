import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { insertMemoryRow } from "../src/distiller-repo.js";
import { contentHash } from "../src/content-hash.js";
import { searchMemories, getMemory, timelineMemories } from "../src/memory-repo.js";

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
