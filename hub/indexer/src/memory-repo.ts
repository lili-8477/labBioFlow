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

export interface MemoryDetail {
  memory_id:          string;
  username:           string;
  project_dir:        string | null;
  type:               string;
  source:             "distilled" | "user";
  name:               string;
  description:        string;
  body:               string;
  source_session_id:  string | null;
  facets:             Record<string, string[]>;
  hit_count:          number;
  last_hit_at:        Date | null;
  created_at:         Date;
  updated_at:         Date;
}

// Fetch a single memory by id with its facets grouped by key. Soft-deleted
// rows (deleted_at IS NOT NULL) are treated as absent and return null.
//
// One round-trip via a correlated subquery that builds the facets map in
// Postgres (jsonb_object_agg over per-key jsonb_agg). Empty facet sets
// collapse to '{}'::jsonb so the JS shape is always Record<string,string[]>.
export async function getMemory(
  pool:     Pool,
  memoryId: string,
): Promise<MemoryDetail | null> {
  type Row = {
    memory_id:          string;
    username:           string;
    project_dir:        string | null;
    type:               string;
    source:             "distilled" | "user";
    name:               string;
    description:        string;
    body:               string;
    source_session_id:  string | null;
    hit_count:          number;
    last_hit_at:        Date | null;
    created_at:         Date;
    updated_at:         Date;
    facets:             Record<string, string[]>;
  };
  const r = await pool.query<Row>(
    `SELECT m.memory_id, m.username, m.project_dir, m.type, m.source,
            m.name, m.description, m.body, m.source_session_id,
            m.hit_count, m.last_hit_at, m.created_at, m.updated_at,
            COALESCE(
              (SELECT jsonb_object_agg(key, vals) FROM (
                 SELECT key, jsonb_agg(value ORDER BY value COLLATE "C") AS vals
                   FROM memory_facets
                  WHERE memory_id = m.memory_id
                  GROUP BY key
               ) g),
              '{}'::jsonb
            ) AS facets
       FROM memories m
      WHERE m.memory_id = $1
        AND m.deleted_at IS NULL`,
    [memoryId],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  return {
    memory_id:         row.memory_id,
    username:          row.username,
    project_dir:       row.project_dir,
    type:              row.type,
    source:            row.source,
    name:              row.name,
    description:       row.description,
    body:              row.body,
    source_session_id: row.source_session_id,
    facets:            row.facets,
    hit_count:         row.hit_count,
    last_hit_at:       row.last_hit_at,
    created_at:        row.created_at,
    updated_at:        row.updated_at,
  };
}

export interface TimelineEntry {
  memory_id:    string;
  name:         string;
  type:         string;
  created_at:   Date;
}

export interface TimelineMemoriesArgs {
  pool:         Pool;
  username:     string;
  // project_dir tri-state semantics:
  //   undefined → no project filter (returns all scopes for the user + org)
  //   null      → treated the same as undefined (no filter), so callers that
  //               pass an Optional<string|null> from JSON without normalising
  //               still get the org+user+all-projects timeline they expect
  //   "<dir>"   → exact match on project_dir = "<dir>" only; rows with
  //               project_dir IS NULL (including org rows) are excluded
  project_dir?: string | null;
  since?:       Date;
  until?:       Date;
  limit?:       number;
}

// Chronological timeline (newest first) for a user, merged with org-scope
// memories. Soft-deleted rows are excluded. Results are capped by `limit`
// (default 50). since/until are inclusive bounds.
export async function timelineMemories(args: TimelineMemoriesArgs): Promise<TimelineEntry[]> {
  const limit      = args.limit ?? 50;
  const projectDir = typeof args.project_dir === "string" ? args.project_dir : null;
  const since      = args.since ? args.since.toISOString() : null;
  const until      = args.until ? args.until.toISOString() : null;

  type Row = {
    memory_id:  string;
    name:       string;
    type:       string;
    created_at: Date;
  };
  const r = await args.pool.query<Row>(
    `SELECT memory_id, name, type, created_at
       FROM memories
      WHERE deleted_at IS NULL
        AND (username = $1 OR username = '__org__')
        AND ($2::text IS NULL OR project_dir = $2)
        AND ($3::timestamptz IS NULL OR created_at >= $3)
        AND ($4::timestamptz IS NULL OR created_at <= $4)
      ORDER BY created_at DESC
      LIMIT $5`,
    [args.username, projectDir, since, until, limit],
  );
  return r.rows.map((row) => ({
    memory_id:  row.memory_id,
    name:       row.name,
    type:       row.type,
    created_at: row.created_at,
  }));
}
