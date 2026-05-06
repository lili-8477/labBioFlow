import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/migrate.js";
import { insertMemoryRow } from "../../src/distiller-repo.js";
import { contentHash } from "../../src/content-hash.js";
import { searchMemories } from "../../src/memory-repo.js";

// End-to-end search against a real pgvector container with mixed-scope rows
// and hand-rolled embeddings. The unit suite in test/memory-repo.test.ts
// already exercises searchMemories against a testcontainers PG with
// deterministic vectors; this integration test's value-add is:
//   - random-ish unit vectors that better represent production behaviour
//   - lives under test/integration/ per project convention
//   - confirms the actual pgvector `<=>` operator + HNSW index rank order
//     on a freshly migrated DB (catches migration-order regressions before
//     the unit suite would even run)

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));
const DIM = 384;

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

// Deterministic pseudo-random unit vector (same LCG used by memory-repo.test.ts;
// inlined here rather than extracted because the helper is ~10 lines and
// extraction would force restructuring the existing unit test file).
function unitVector(seed: number): number[] {
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
  embedSeed:   number;
}

async function seedMemory(args: SeedArgs): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const memId = await insertMemoryRow(client, {
      username:          args.username,
      project_dir:       args.project_dir,
      source:            "user",
      type:              "observation",
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
      [vecLiteral(unitVector(args.embedSeed)), memId],
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

describe("integration: mixed-scope hybrid search against real pgvector", () => {
  it("returns all 5 in-scope rows, ranks the embedding-twin highest, and increments hit_count", async () => {
    // 5 memories, all with body containing "scanpy" so FTS matches every row.
    // 1 org, 2 user, 2 project. Each gets a distinct random unit vector
    // (seeds 1001..1005).
    //
    // The stub embedder returns exactly the seed-1003 vector, so the
    // user-scope row at seed 1003 should rank highest by vector similarity
    // (vec_sim = 1.0 vs ~0 for the other random vectors). Even though the
    // project-scope multiplier is 1.20 vs 1.10 for user, vec_sim of 1.0 vs
    // ~0.0 dominates: 1.0 * 0.7 * 1.10 ≈ 0.77 vs ~0.0 * 0.7 * 1.20 + 0.3 *
    // (small fts) * 1.20 ≈ a much smaller number.
    const orgId      = await seedMemory({ username: "__org__", project_dir: null,    body: "scanpy is the tool of choice for org rules",       seed: 1, embedSeed: 1001 });
    const userAId    = await seedMemory({ username: "alice",   project_dir: null,    body: "alice prefers scanpy when working with single-cell", seed: 2, embedSeed: 1002 });
    const userBId    = await seedMemory({ username: "alice",   project_dir: null,    body: "scanpy notebooks live in ~/notebooks",               seed: 3, embedSeed: 1003 });
    const projectAId = await seedMemory({ username: "alice",   project_dir: "-w-bio", body: "this project standardises on scanpy v1.9",          seed: 4, embedSeed: 1004 });
    const projectBId = await seedMemory({ username: "alice",   project_dir: "-w-bio", body: "scanpy preprocessing runs on the GPU node here",    seed: 5, embedSeed: 1005 });

    // Stub embedder returns the same vector that was hand-rolled into the
    // userB row's chunk, so userB is the row whose vec_sim with the query
    // vector is exactly 1.0.
    const stubEmbedder = {
      embedTexts: async (_texts: string[]) => [unitVector(1003)],
    };

    const hits = await searchMemories({
      pool,
      embedderClient: stubEmbedder,
      username:       "alice",
      project_dir:    "-w-bio",
      query:          "scanpy",
      limit:          10,
    });

    // All 5 rows match scope and FTS; we should see all 5 back.
    expect(hits.length).toBe(5);
    const ids = hits.map((h) => h.memory_id);
    expect(new Set(ids)).toEqual(new Set([orgId, userAId, userBId, projectAId, projectBId]));

    // The row whose embedding the stub returned must rank first; its
    // vec_sim of 1.0 beats every other row's near-zero vec_sim by enough to
    // out-weigh the project tier's 1.20 vs user tier's 1.10 multiplier.
    expect(hits[0].memory_id).toBe(userBId);

    // Scope tier classification per row.
    const tierByMem = new Map(hits.map((h) => [h.memory_id, h.scope_tier]));
    expect(tierByMem.get(orgId)).toBe("org");
    expect(tierByMem.get(userAId)).toBe("user");
    expect(tierByMem.get(userBId)).toBe("user");
    expect(tierByMem.get(projectAId)).toBe("project");
    expect(tierByMem.get(projectBId)).toBe("project");

    // Every score is a finite number (no NaN poisoning from a bad vector arm).
    for (const h of hits) {
      expect(Number.isFinite(h.score)).toBe(true);
      expect(h.snippet.length).toBeGreaterThan(0);
    }

    // hit_count incremented to 1 for every returned row.
    const counts = await pool.query<{ memory_id: string; hit_count: number; last_hit_at: Date | null }>(
      `SELECT memory_id, hit_count, last_hit_at FROM memories
        WHERE memory_id = ANY($1::uuid[])
        ORDER BY memory_id`,
      [[orgId, userAId, userBId, projectAId, projectBId]],
    );
    expect(counts.rowCount).toBe(5);
    for (const r of counts.rows) {
      expect(r.hit_count).toBe(1);
      expect(r.last_hit_at).not.toBeNull();
    }
  });
});
