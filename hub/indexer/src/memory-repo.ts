import type { Pool } from "pg";
import { logger } from "./config.js";

export interface SearchMemoriesArgs {
  pool:           Pool;
  embedderClient: { embedTexts: (texts: string[]) => Promise<number[][]> };
  username:       string;
  project_dir:    string | null;
  query:          string;
  limit?:         number;
  types?:         string[];
  since?:         Date;
}

export interface SearchHit {
  memory_id:   string;
  name:        string;
  description: string;
  snippet:     string;
  score:       number;
  scope_tier:  "org" | "user" | "project";
}

// Hybrid path (embedder available): vector + FTS blended ranking.
// Params: $1 query vector, $2 query text, $3 username, $4 project_dir,
//         $5 types[], $6 since, $7 limit.
//
// TODO(memory-chunking): the candidates CTE caps at LIMIT 200 ordered by
// vector distance. Once chunked memories ship and the corpus exceeds 200
// chunks-with-embeddings, FTS-only hits on chunks beyond the top-200 vector
// neighbourhood will be silently dropped. See
// docs/superpowers/plans/2026-05-06-agent-memory-sub-phase-b.md for the
// follow-up (split into two sub-queries and UNION, or raise the cap).
const HYBRID_SQL = `
WITH q AS (SELECT $1::vector AS qv, plainto_tsquery('english', $2) AS qt),
candidates AS (
  SELECT mc.memory_id,
         mc.content,
         (1 - (mc.embedding <=> q.qv)) AS vec_sim,
         ts_rank(mc.tsv, q.qt) AS fts_score
  FROM memory_chunks mc, q
  WHERE mc.embedding IS NOT NULL OR mc.tsv @@ q.qt
  ORDER BY mc.embedding <=> q.qv
  LIMIT 200
)
-- TODO(memory-chunking): once a memory can have >1 chunk, this join will
-- emit one row per matching chunk and produce duplicate memory_ids in the
-- output. Pick the best chunk per memory (e.g. DISTINCT ON (memory_id) with
-- score-ordered subquery) before returning. See sub-phase-b plan.
SELECT m.memory_id, m.name, m.description,
       LEFT(c.content, 200) AS snippet,
       (c.vec_sim * 0.7 + LEAST(c.fts_score, 1.0) * 0.3)
         * CASE
             WHEN m.username = '__org__'                              THEN 1.00
             WHEN m.project_dir IS NULL                               THEN 1.10
             ELSE 1.20
           END
         * (1.0 + LN(1 + m.hit_count) * 0.05)
         * EXP(-EXTRACT(EPOCH FROM (now() - m.created_at)) / (86400 * 90))  AS score,
       CASE
         WHEN m.username = '__org__'                              THEN 'org'
         WHEN m.project_dir IS NULL                               THEN 'user'
         ELSE 'project'
       END AS scope_tier
FROM memories m JOIN candidates c USING (memory_id)
WHERE m.deleted_at IS NULL
  AND (m.username = $3 OR m.username = '__org__')
  AND (m.project_dir IS NULL OR m.project_dir = $4)
  AND ($5::text[] IS NULL OR m.type = ANY($5))
  AND ($6::timestamptz IS NULL OR m.created_at >= $6)
ORDER BY score DESC
LIMIT $7
`;

// FTS-only fallback (embedder unavailable). pgvector's `<=>` against a
// zero-vector returns NaN, which would poison every score and make the final
// ORDER BY/LIMIT non-deterministic — so we drop the vector arm entirely
// rather than feeding it a placeholder vector. vec_sim slot collapses to 0.0,
// leaving score = 0.3 * LEAST(fts_score, 1.0) * scope * popularity * recency.
//
// Params shift down by one (no qVec): $1 query text, $2 username,
// $3 project_dir, $4 types[], $5 since, $6 limit.
const FTS_ONLY_SQL = `
WITH q AS (SELECT plainto_tsquery('english', $1) AS qt),
candidates AS (
  SELECT mc.memory_id,
         mc.content,
         ts_rank(mc.tsv, q.qt) AS fts_score
  FROM memory_chunks mc, q
  WHERE mc.tsv @@ q.qt
  ORDER BY ts_rank(mc.tsv, q.qt) DESC
  LIMIT 200
)
-- TODO(memory-chunking): once a memory can have >1 chunk, this join will
-- emit one row per matching chunk and produce duplicate memory_ids. See
-- the matching note in HYBRID_SQL above.
SELECT m.memory_id, m.name, m.description,
       LEFT(c.content, 200) AS snippet,
       (LEAST(c.fts_score, 1.0) * 0.3)
         * CASE
             WHEN m.username = '__org__'                              THEN 1.00
             WHEN m.project_dir IS NULL                               THEN 1.10
             ELSE 1.20
           END
         * (1.0 + LN(1 + m.hit_count) * 0.05)
         * EXP(-EXTRACT(EPOCH FROM (now() - m.created_at)) / (86400 * 90))  AS score,
       CASE
         WHEN m.username = '__org__'                              THEN 'org'
         WHEN m.project_dir IS NULL                               THEN 'user'
         ELSE 'project'
       END AS scope_tier
FROM memories m JOIN candidates c USING (memory_id)
WHERE m.deleted_at IS NULL
  AND (m.username = $2 OR m.username = '__org__')
  AND (m.project_dir IS NULL OR m.project_dir = $3)
  AND ($4::text[] IS NULL OR m.type = ANY($4))
  AND ($5::timestamptz IS NULL OR m.created_at >= $5)
ORDER BY score DESC
LIMIT $6
`;

export async function searchMemories(args: SearchMemoriesArgs): Promise<SearchHit[]> {
  const limit = args.limit ?? 10;

  let qVec: number[] | null;
  try {
    const out = await args.embedderClient.embedTexts([args.query]);
    if (!Array.isArray(out) || !Array.isArray(out[0])) {
      throw new Error("embedder returned malformed vectors");
    }
    qVec = out[0];
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "embedder unavailable; falling back to FTS-only search",
    );
    qVec = null;
  }

  const types = args.types && args.types.length > 0 ? args.types : null;
  const since = args.since ? args.since.toISOString() : null;

  type Row = {
    memory_id:   string;
    name:        string;
    description: string;
    snippet:     string;
    score:       string;
    scope_tier:  "org" | "user" | "project";
  };

  const res = qVec === null
    ? await args.pool.query<Row>(
        FTS_ONLY_SQL,
        [args.query, args.username, args.project_dir, types, since, limit],
      )
    : await args.pool.query<Row>(
        HYBRID_SQL,
        ["[" + qVec.join(",") + "]", args.query, args.username, args.project_dir, types, since, limit],
      );

  const hits: SearchHit[] = res.rows.map((r) => ({
    memory_id:   r.memory_id,
    name:        r.name,
    description: r.description,
    snippet:     r.snippet,
    score:       parseFloat(r.score),
    scope_tier:  r.scope_tier,
  }));

  if (hits.length > 0) {
    await args.pool.query(
      `UPDATE memories
          SET hit_count   = hit_count + 1,
              last_hit_at = now()
        WHERE memory_id = ANY($1::uuid[])`,
      [hits.map((h) => h.memory_id)],
    );
  }

  return hits;
}
