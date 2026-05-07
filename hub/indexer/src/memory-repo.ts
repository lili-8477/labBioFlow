import type { Pool, PoolClient } from "pg";
import { logger } from "./config.js";
import { contentHash } from "./content-hash.js";
import { insertMemoryRow } from "./distiller-repo.js";
import { encodeProjectDir } from "./path-decode.js";

export interface AuditEntry {
  memory_id: string;
  actor:     string;
  action:    'write' | 'update' | 'forget' | 'restore';
  before:    Record<string, unknown> | null;
  after:     Record<string, unknown> | null;
}

export async function appendAudit(
  client: PoolClient,
  e: AuditEntry,
): Promise<void> {
  await client.query(
    `INSERT INTO memory_audit_log (memory_id, actor, action, before, after)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [
      e.memory_id,
      e.actor,
      e.action,
      e.before ? JSON.stringify(e.before) : null,
      e.after  ? JSON.stringify(e.after)  : null,
    ],
  );
}

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

export interface WriteUserMemoryArgs {
  pool:        Pool;
  username:    string;
  scope:       "user" | "project" | "org";
  project_dir: string | null;     // required when scope === "project"; ignored otherwise
  type:        "user" | "feedback" | "project" | "reference";
  name:        string;
  description: string;
  body:        string;
  facets?:     Record<string, string[]>;
}

// Persist a /memorize-style user-authored memory. Shares the chunk + facet +
// queue path with distillation by delegating to insertMemoryRow; the only
// caller-side differences are source='user', source_session_id=NULL, and the
// content_hash recipe.
//
// Org-scope writes are operator-administered (sub-phase B spec §7.4): they
// cannot be issued from inside a user container, so we reject them here.
//
// Returns { memory_id: null } when the row collides on
// (username, project_dir, type, content_hash) — that is dedup, not failure.
export async function writeUserMemory(
  args: WriteUserMemoryArgs,
): Promise<{ memory_id: string | null }> {
  if (args.scope === "org") {
    throw new Error("org-scope writes are admin-only; use the operator administration path");
  }
  if (args.scope === "project" && args.project_dir == null) {
    throw new Error("scope=project requires a project_dir");
  }
  const project_dir = args.scope === "user" ? null : args.project_dir;

  // promptVersion=0 is the sentinel for user-authored memories: there is no
  // distillation prompt to version, so identical user content always hashes
  // the same regardless of any future prompt-version bumps in distillation.
  const hash = contentHash({
    body:          `${args.name}\n${args.body}`,
    promptVersion: 0,
  });

  const client = await args.pool.connect();
  try {
    await client.query("BEGIN");
    const memory_id = await insertMemoryRow(client, {
      username:          args.username,
      project_dir,
      source:            "user",
      type:              args.type,
      source_session_id: null,
      name:              args.name,
      description:       args.description,
      body:              args.body,
      facets:            args.facets ?? {},
      content_hash:      hash,
    });
    if (memory_id !== null) {
      await appendAudit(client, {
        memory_id,
        actor:  args.username,
        action: 'write',
        before: null,
        after:  { type: args.type, name: args.name, description: args.description, body: args.body },
      });
    }
    await client.query("COMMIT");
    return { memory_id };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export interface ForgetMemoryArgs {
  pool:     Pool;
  username: string;          // for authorization scoping (caller cannot forget another user's memory)
  memoryId: string;
}

// Soft-delete a memory by setting `deleted_at = now()`. Authorisation is
// enforced in the WHERE clause: a row is only updated when both the id and
// the caller's username match. Returns {ok: true} when a row was actually
// updated, {ok: false} for any miss (not found, owned by someone else, or
// already deleted) — that asymmetry makes the second forget on the same id
// idempotent without silently lying to the caller.
//
// Chunks, facets, and embedder_queue rows are intentionally left in place.
// Search and timeline already filter by `deleted_at IS NULL`, so the data is
// invisible to readers; physical deletion is a separate retention concern.
export async function forgetMemory(args: ForgetMemoryArgs): Promise<{ ok: boolean }> {
  const client = await args.pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the row and capture pre-state in one round-trip.
    const sel = await client.query<{ memory_id: string; deleted_at: Date | null; name: string }>(
      `SELECT memory_id, deleted_at, name
         FROM memories
        WHERE memory_id = $1
          AND username  = $2
        FOR UPDATE`,
      [args.memoryId, args.username],
    );

    // Not found or wrong owner → rollback, no audit.
    if (sel.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false };
    }

    const row = sel.rows[0]!;

    // Already deleted → idempotent false, no audit.
    if (row.deleted_at !== null) {
      await client.query("ROLLBACK");
      return { ok: false };
    }

    await client.query(
      `UPDATE memories
          SET deleted_at = now(),
              updated_at = now()
        WHERE memory_id = $1
          AND username  = $2
          AND deleted_at IS NULL`,
      [args.memoryId, args.username],
    );

    await appendAudit(client, {
      memory_id: args.memoryId,
      actor:     args.username,
      action:    'forget',
      before:    { deleted_at: null, name: row.name },
      after:     null,
    });

    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function updateMemory(args: {
  pool:        Pool;
  actor:       string;
  memoryId:    string;
  name:        string;
  description: string;
  body:        string;
}): Promise<{ ok: boolean; reason?: 'not_found' | 'forbidden' | 'distilled' }> {
  const client = await args.pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the row and capture pre-state for ownership check and audit.
    const sel = await client.query<{
      username:    string;
      source:      string;
      name:        string;
      description: string;
      body:        string;
    }>(
      `SELECT username, source, name, description, body
         FROM memories
        WHERE memory_id = $1
        FOR UPDATE`,
      [args.memoryId],
    );

    if (sel.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: 'not_found' };
    }

    const row = sel.rows[0]!;

    if (row.username !== args.actor) {
      await client.query("ROLLBACK");
      return { ok: false, reason: 'forbidden' };
    }

    if (row.source !== 'user') {
      await client.query("ROLLBACK");
      return { ok: false, reason: 'distilled' };
    }

    // Match writeUserMemory's hash recipe exactly: promptVersion=0, body=`${name}\n${body}`.
    const hash = contentHash({
      body:          `${args.name}\n${args.body}`,
      promptVersion: 0,
    });

    await client.query(
      `UPDATE memories
          SET name        = $1,
              description = $2,
              body        = $3,
              content_hash = $4,
              updated_at  = now()
        WHERE memory_id = $5`,
      [args.name, args.description, args.body, hash, args.memoryId],
    );

    // Delete old chunks and re-insert one chunk with the new body, embedding=NULL.
    await client.query(
      `DELETE FROM memory_chunks WHERE memory_id = $1`,
      [args.memoryId],
    );
    const chunk = await client.query<{ chunk_id: string }>(
      `INSERT INTO memory_chunks (memory_id, chunk_idx, content)
       VALUES ($1, 0, $2) RETURNING chunk_id`,
      [args.memoryId, args.body],
    );
    await client.query(
      `INSERT INTO embedder_queue (chunk_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [chunk.rows[0]!.chunk_id],
    );

    await appendAudit(client, {
      memory_id: args.memoryId,
      actor:     args.actor,
      action:    'update',
      before:    { name: row.name, description: row.description, body: row.body },
      after:     { name: args.name, description: args.description, body: args.body },
    });

    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function restoreMemory(args: {
  pool:     Pool;
  actor:    string;
  memoryId: string;
}): Promise<{ ok: boolean; reason?: 'not_found' | 'forbidden' | 'not_deleted' }> {
  const client = await args.pool.connect();
  try {
    await client.query("BEGIN");

    const sel = await client.query<{ username: string; deleted_at: Date | null }>(
      `SELECT username, deleted_at
         FROM memories
        WHERE memory_id = $1
        FOR UPDATE`,
      [args.memoryId],
    );

    if (sel.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: 'not_found' };
    }

    const row = sel.rows[0]!;

    if (row.username !== args.actor) {
      await client.query("ROLLBACK");
      return { ok: false, reason: 'forbidden' };
    }

    if (row.deleted_at === null) {
      await client.query("ROLLBACK");
      return { ok: false, reason: 'not_deleted' };
    }

    await client.query(
      `UPDATE memories
          SET deleted_at = NULL,
              updated_at = now()
        WHERE memory_id = $1`,
      [args.memoryId],
    );

    await appendAudit(client, {
      memory_id: args.memoryId,
      actor:     args.actor,
      action:    'restore',
      before:    { deleted_at: row.deleted_at },
      after:     { deleted_at: null },
    });

    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export interface GetContextArgs {
  pool:          Pool;
  username:      string;
  project_path:  string;
  budget_tokens: number;
}

export interface MemoryContext {
  system_prompt: string;
  memory_ids:    string[];
}

// SessionStart bundle: rank up to ~50 candidate memories by
// scope_tier × popularity × recency (no FTS or vector — context isn't
// query-driven), then walk them in score-DESC order and accumulate header +
// body lines into a single system_prompt string until adding the next memory
// would push the running char count past `budget_tokens * 4` (the
// 4-chars-per-token heuristic). Always include at least one memory if any
// candidates exist; an empty bundle is worse than slightly oversized.
//
// project_path is the raw absolute path inside the user's container (e.g.
// "/workspace/pbmc3k"). It's encoded to "-workspace-pbmc3k" via
// encodeProjectDir before filtering on memories.project_dir.
//
// Returns {system_prompt: "", memory_ids: []} when no rows match — the
// caller checks `memory_ids.length === 0` to decide whether to emit a
// SessionStart hook at all, so the empty string (not the bare header) is
// the documented "skip" signal.
const CONTEXT_SQL = `
SELECT m.memory_id, m.type, m.name, m.body,
       CASE
         WHEN m.username = '__org__'                              THEN 'org'
         WHEN m.project_dir IS NULL                               THEN 'user'
         ELSE 'project'
       END AS scope_tier,
       (CASE
          WHEN m.username = '__org__'                              THEN 1.00
          WHEN m.project_dir IS NULL                               THEN 1.10
          ELSE 1.20
        END
        * (1.0 + LN(1 + m.hit_count) * 0.05)
        * EXP(-EXTRACT(EPOCH FROM (now() - m.created_at)) / (86400 * 90))
       ) AS score
FROM memories m
WHERE m.deleted_at IS NULL
  AND (m.username = $1 OR m.username = '__org__')
  AND (m.project_dir IS NULL OR m.project_dir = $2)
  AND m.name <> 'raw distillation failed'
ORDER BY score DESC
LIMIT 50
`;

export async function getContext(args: GetContextArgs): Promise<MemoryContext> {
  const encodedProjectDir = encodeProjectDir(args.project_path);

  type Row = {
    memory_id:  string;
    type:       string;
    name:       string;
    body:       string;
    scope_tier: "org" | "user" | "project";
    score:      string;
  };
  const r = await args.pool.query<Row>(CONTEXT_SQL, [args.username, encodedProjectDir]);

  if (r.rows.length === 0) {
    return { system_prompt: "", memory_ids: [] };
  }

  const HEADER = "# Memory Context\n\n";
  const charBudget = args.budget_tokens * 4;
  const ids: string[] = [];
  const parts: string[] = [HEADER];
  let used = HEADER.length;

  for (const row of r.rows) {
    const block = `[${row.scope_tier}:${row.type}] ${row.name}\n${row.body}\n\n`;
    if (ids.length === 0 || used + block.length <= charBudget) {
      parts.push(block);
      used += block.length;
      ids.push(row.memory_id);
    } else {
      break;
    }
  }

  return { system_prompt: parts.join(""), memory_ids: ids };
}
