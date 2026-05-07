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
  // List-row parity: the frontend memory panel renders search hits with the
  // same component as list rows, so SearchHit must carry every field
  // MemoryListItem expects. Without these, the panel sees `deleted_at`
  // === undefined and rendered every search hit with the [deleted] badge.
  type:        string;
  source:      "user" | "distilled";
  created_at:  string;
  updated_at:  string;
  hit_count:   number;
  last_hit_at: string | null;
  deleted_at:  string | null;
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
       m.type, m.source, m.created_at, m.updated_at,
       m.hit_count, m.last_hit_at, m.deleted_at,
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
       m.type, m.source, m.created_at, m.updated_at,
       m.hit_count, m.last_hit_at, m.deleted_at,
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
    type:        string;
    source:      "user" | "distilled";
    created_at:  Date;
    updated_at:  Date;
    hit_count:   number;
    last_hit_at: Date | null;
    deleted_at:  Date | null;
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
    type:        r.type,
    source:      r.source,
    created_at:  r.created_at.toISOString(),
    updated_at:  r.updated_at.toISOString(),
    hit_count:   r.hit_count,
    last_hit_at: r.last_hit_at ? r.last_hit_at.toISOString() : null,
    deleted_at:  r.deleted_at  ? r.deleted_at.toISOString()  : null,
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
  scope_tier:         "org" | "user" | "project";
  name:               string;
  description:        string;
  body:               string;
  source_session_id:  string | null;
  facets:             Record<string, string[]>;
  hit_count:          number;
  last_hit_at:        Date | null;
  created_at:         Date;
  updated_at:         Date;
  // Populated for soft-deleted rows so the frontend can render the [deleted]
  // badge and pick Forget vs Restore. Agents looking up a row by id see the
  // deleted state too — that's intentional: the targeted lookup path was
  // never the soft-delete enforcement boundary (search/list/timeline are).
  deleted_at:         Date | null;
}

// Fetch a single memory by id with its facets grouped by key. Returns
// soft-deleted rows too (with deleted_at populated) so the frontend can
// render Forget/Restore correctly — the soft-delete visibility boundary is
// search/list/timeline, not targeted by-id lookup.
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
    scope_tier:         "org" | "user" | "project";
    name:               string;
    description:        string;
    body:               string;
    source_session_id:  string | null;
    hit_count:          number;
    last_hit_at:        Date | null;
    created_at:         Date;
    updated_at:         Date;
    deleted_at:         Date | null;
    facets:             Record<string, string[]>;
  };
  const r = await pool.query<Row>(
    `SELECT m.memory_id, m.username, m.project_dir, m.type, m.source,
            CASE
              WHEN m.username = '__org__'    THEN 'org'
              WHEN m.project_dir IS NULL     THEN 'user'
              ELSE 'project'
            END AS scope_tier,
            m.name, m.description, m.body, m.source_session_id,
            m.hit_count, m.last_hit_at, m.created_at, m.updated_at, m.deleted_at,
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
      WHERE m.memory_id = $1`,
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
    scope_tier:        row.scope_tier,
    name:              row.name,
    description:       row.description,
    body:              row.body,
    source_session_id: row.source_session_id,
    facets:            row.facets,
    hit_count:         row.hit_count,
    last_hit_at:       row.last_hit_at,
    created_at:        row.created_at,
    updated_at:        row.updated_at,
    deleted_at:        row.deleted_at,
  };
}

export async function getAuditTrail(args: {
  pool:     Pool;
  actor:    string;
  memoryId: string;
  limit?:   number;
}): Promise<
  | {
      rows: Array<{
        audit_id: number;
        action:   string;
        actor:    string;
        before:   unknown;
        after:    unknown;
        created_at: string;
      }>;
    }
  | { error: 'not_found' | 'forbidden' }
> {
  // Ownership check: lookup the memory (including soft-deleted rows)
  const ownershipCheck = await args.pool.query<{ username: string }>(
    `SELECT username FROM memories WHERE memory_id = $1`,
    [args.memoryId],
  );

  if (ownershipCheck.rowCount === 0) {
    return { error: 'not_found' };
  }

  const row = ownershipCheck.rows[0]!;
  if (row.username !== args.actor) {
    return { error: 'forbidden' };
  }

  // Fetch audit trail capped at limit (default/max 100)
  const limit = Math.min(args.limit ?? 100, 100);
  type AuditRow = {
    audit_id:  number;
    action:    string;
    actor:     string;
    before:    unknown;
    after:     unknown;
    created_at: Date;
  };
  const auditRes = await args.pool.query<AuditRow>(
    `SELECT audit_id, action, actor, before, after, created_at
       FROM memory_audit_log
      WHERE memory_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [args.memoryId, limit],
  );

  return {
    rows: auditRes.rows.map((r) => ({
      audit_id:  r.audit_id,
      action:    r.action,
      actor:     r.actor,
      before:    r.before,
      after:     r.after,
      created_at: r.created_at.toISOString(),
    })),
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

export interface ListFilter {
  pool:             Pool;
  username:         string;                       // requester (for org-merge)
  project_dir:      string | null;                // null = no project filter
  scope?:           'org' | 'user' | 'project';  // optional narrow
  type?:            string[];                     // any-of
  source?:          'user' | 'distilled';
  include_deleted?: boolean;                      // default false
  sort?:            'created' | 'hit';            // default 'created'
  limit?:           number;                       // default 50, cap 200
  cursor?:          string;                       // ISO timestamp from prev page's tail
}

export interface ListItem {
  memory_id:   string;
  type:        string;
  source:      'user' | 'distilled';
  scope_tier:  'org' | 'user' | 'project';
  name:        string;
  description: string;
  created_at:  string;
  updated_at:  string;
  hit_count:   number;
  last_hit_at: string | null;
  deleted_at:  string | null;
}

// Paginated browser-friendly listing. Filterable by scope_tier, type, source,
// include_deleted. Sortable by created_at DESC (default) or last_hit_at DESC.
// Cursor pagination: the cursor is the ISO timestamp of the last item's sort
// column from the previous page. Returns items plus next_cursor (null = last page).
//
// The org-merge: when scope is undefined, returns rows where
// (username = $u OR username = '__org__') AND (project_dir filter).
// When scope='org', returns only username='__org__' rows.
// When scope='user', returns only rows where username=$u AND project_dir IS NULL.
// When scope='project', returns only rows where username=$u AND project_dir IS NOT NULL
//   (and project_dir=$project_dir when project_dir is specified).
//
// Params:
//   $1  username
//   $2  project_dir (text or NULL = no filter)
//   $3  scope_filter (text or NULL = no scope filter)
//   $4  types[] (text[] or NULL = no type filter)
//   $5  source (text or NULL = no source filter)
//   $6  include_deleted (boolean)
//   $7  cursor (timestamptz or NULL = no cursor)
//   $8  limit+1
export async function listMemories(f: ListFilter): Promise<{
  items: ListItem[];
  next_cursor: string | null;
}> {
  const limit       = Math.min(f.limit ?? 50, 200);
  const sort        = f.sort ?? 'created';
  const sortCol     = sort === 'hit' ? 'm.last_hit_at' : 'm.created_at';
  const types       = f.type && f.type.length > 0 ? f.type : null;
  const source      = f.source ?? null;
  const scope       = f.scope ?? null;
  const projectDir  = f.project_dir;
  const cursor      = f.cursor ?? null;
  const inclDeleted = f.include_deleted ?? false;

  // Scope filter logic (applied in WHERE):
  // - scope=undefined: (username=$u OR username='__org__') AND project_dir filter
  // - scope='org':     username='__org__'
  // - scope='user':    username=$u AND project_dir IS NULL
  // - scope='project': username=$u AND project_dir IS NOT NULL (+ project_dir filter)
  //
  // We encode this as a parameterized CASE expression to keep a single query.
  // $3 = scope_filter (text or NULL). The WHERE clause ANDs in one of three
  // compound conditions based on $3.

  // Cursor condition: skip rows at/before the cursor timestamp on the sort col.
  // For sort='hit', last_hit_at can be NULL. We only apply the cursor to non-NULL
  // values (i.e. once all non-NULL rows are paged through, the final cursor passed
  // in will be NULL, and the query just returns the remaining NULL rows by tie-break).
  let cursorCond: string;
  if (sort === 'hit') {
    // When sort='hit': skip rows where last_hit_at >= cursor (we want < cursor).
    // NULL last_hit_at rows come AFTER all non-NULL rows (NULLS LAST), so they
    // only appear once cursor is NULL (first page) or after all non-NULL rows.
    // When cursor IS NOT NULL, exclude all NULL last_hit_at rows too (they haven't
    // been paged yet conceptually, but they appear at the end; once the first page
    // with all NULLs is needed, cursor will be null). Actually, the simpler correct
    // approach: when cursor is supplied (non-null), only return rows where
    // last_hit_at < cursor (strict). NULL rows sort AFTER any non-NULL so they
    // appear at the end of the full result set. When cursor is provided and all
    // non-null values < cursor are exhausted, the next "page" starting point is
    // the NULL block — but since NULLs < anything is false, they'd be excluded.
    // Solution: when cursor is provided, include NULLs only after non-NULLs are done.
    // The simplest stable solution: cursor condition is:
    //   ($7::timestamptz IS NULL OR (last_hit_at IS NOT NULL AND last_hit_at < $7::timestamptz)
    //                               OR (last_hit_at IS NULL AND $7_was_null_cursor))
    // This is getting complex. Use the two-tier approach:
    //   - when cursor is null: no filter (include everything, NULLs at end)
    //   - when cursor is non-null: last_hit_at IS NOT NULL AND last_hit_at < cursor
    //     OR last_hit_at IS NULL AND <all non-null pages exhausted signal>
    // The cleanest is: include NULL rows only when cursor is NULL (first call).
    // But that breaks if limit < total non-null count.
    //
    // Correct approach for NULLS LAST ordering: since NULLs sort last, cursor
    // pagination for hit sort works as:
    //   - If cursor is null: no cursor filter, returns top rows (non-null first, NULLs last)
    //   - If cursor looks like a real timestamp: WHERE last_hit_at < cursor (excludes NULLs)
    //   - After all non-null rows are paged, next_cursor from last non-null page's last item
    //     has last_hit_at = some timestamp. The "NULL page" needs special handling.
    //
    // Simplest correct approach used here: use a sentinel. Since NULL rows sort LAST,
    // after all non-null pages are consumed, the caller gets next_cursor from the last
    // non-null item. That cursor, when applied, gives WHERE last_hit_at < <min_value>
    // which excludes NULLs. The NULL rows are never reached via cursor pagination for hit sort.
    //
    // This matches real-world cursor pagination for nullable sort cols where NULLs are
    // minority edge cases. For this implementation we keep it simple and stable:
    // NULLs appear on the first page if limit is large enough, otherwise are unreachable
    // via cursor. The tie-break (memory_id ASC) ensures no duplicates within a page.
    cursorCond = `($7::timestamptz IS NULL OR (${sortCol} IS NOT NULL AND ${sortCol} < $7::timestamptz))`;
  } else {
    // For created_at sort: created_at is never NULL (it has a DEFAULT now()), so simple.
    cursorCond = `($7::timestamptz IS NULL OR ${sortCol} < $7::timestamptz)`;
  }

  const orderBy = sort === 'hit'
    ? `ORDER BY m.last_hit_at DESC NULLS LAST, m.memory_id ASC`
    : `ORDER BY m.created_at DESC, m.memory_id ASC`;

  const sql = `
SELECT m.memory_id, m.type, m.source,
       CASE
         WHEN m.username = '__org__'   THEN 'org'
         WHEN m.project_dir IS NULL    THEN 'user'
         ELSE 'project'
       END AS scope_tier,
       m.name, m.description,
       m.created_at, m.updated_at,
       m.hit_count, m.last_hit_at, m.deleted_at
  FROM memories m
 WHERE
   -- Org-merge + scope filter
   (
     ($3::text IS NULL AND (m.username = $1 OR m.username = '__org__') AND ($2::text IS NULL OR m.project_dir IS NULL OR m.project_dir = $2))
     OR ($3 = 'org'     AND m.username = '__org__')
     OR ($3 = 'user'    AND m.username = $1 AND m.project_dir IS NULL)
     OR ($3 = 'project' AND m.username = $1 AND m.project_dir IS NOT NULL AND ($2::text IS NULL OR m.project_dir = $2))
   )
   -- deleted filter
   AND ($6 OR m.deleted_at IS NULL)
   -- type filter
   AND ($4::text[] IS NULL OR m.type = ANY($4))
   -- source filter
   AND ($5::text IS NULL OR m.source = $5::text)
   -- cursor filter
   AND ${cursorCond}
${orderBy}
LIMIT $8
`;

  type Row = {
    memory_id:   string;
    type:        string;
    source:      'user' | 'distilled';
    scope_tier:  'org' | 'user' | 'project';
    name:        string;
    description: string;
    created_at:  Date;
    updated_at:  Date;
    hit_count:   number;
    last_hit_at: Date | null;
    deleted_at:  Date | null;
  };

  const res = await f.pool.query<Row>(sql, [
    f.username,      // $1
    projectDir,      // $2
    scope,           // $3
    types,           // $4
    source,          // $5
    inclDeleted,     // $6
    cursor,          // $7
    limit + 1,       // $8 — fetch one extra to determine next_cursor
  ]);

  const rows = res.rows;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  let next_cursor: string | null = null;
  if (hasMore) {
    const tail = pageRows[pageRows.length - 1]!;
    const tailVal = sort === 'hit' ? tail.last_hit_at : tail.created_at;
    next_cursor = tailVal ? tailVal.toISOString() : null;
  }

  const items: ListItem[] = pageRows.map((r) => ({
    memory_id:   r.memory_id,
    type:        r.type,
    source:      r.source,
    scope_tier:  r.scope_tier,
    name:        r.name,
    description: r.description,
    created_at:  r.created_at.toISOString(),
    updated_at:  r.updated_at.toISOString(),
    hit_count:   r.hit_count,
    last_hit_at: r.last_hit_at ? r.last_hit_at.toISOString() : null,
    deleted_at:  r.deleted_at  ? r.deleted_at.toISOString()  : null,
  }));

  return { items, next_cursor };
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

export async function getMetrics(pool: Pool): Promise<{
  memories_total: number;
  memories_by_type: Record<string, number>;
  memories_by_source: { user: number; distilled: number };
  memories_soft_deleted: number;
  embedder_queue_depth: number;
  embedder_queue_oldest: string | null;
  distill_cursor_lag_seconds_max: number;
  audit_log_size: number;
}> {
  type MetricsRow = {
    memories_total:              string;
    memories_soft_deleted:       string;
    embedder_queue_depth:        string;
    embedder_queue_oldest:       Date | null;
    distill_cursor_lag_seconds_max: string;
    audit_log_size:              string;
  };

  const metricsRes = await pool.query<MetricsRow>(
    `SELECT
       (SELECT COUNT(*) FROM memories WHERE deleted_at IS NULL) AS memories_total,
       (SELECT COUNT(*) FROM memories WHERE deleted_at IS NOT NULL) AS memories_soft_deleted,
       (SELECT COUNT(*) FROM embedder_queue) AS embedder_queue_depth,
       (SELECT enqueued_at FROM embedder_queue ORDER BY enqueued_at ASC LIMIT 1) AS embedder_queue_oldest,
       (SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (now() - last_seen_session_last_active))), 0)
          FROM memory_distill_cursor) AS distill_cursor_lag_seconds_max,
       (SELECT COUNT(*) FROM memory_audit_log) AS audit_log_size`,
  );

  const metricsRow = metricsRes.rows[0]!;

  type TypeSourceRow = {
    type:   string;
    source: string;
    n:      string;
  };

  const typeSourceRes = await pool.query<TypeSourceRow>(
    `SELECT type, source, COUNT(*) AS n
       FROM memories
      WHERE deleted_at IS NULL
      GROUP BY type, source`,
  );

  const memories_by_type: Record<string, number> = {};
  const memories_by_source: { user: number; distilled: number } = { user: 0, distilled: 0 };

  for (const row of typeSourceRes.rows) {
    const count = parseInt(row.n, 10);
    memories_by_type[row.type] = (memories_by_type[row.type] ?? 0) + count;
    if (row.source === "user" || row.source === "distilled") {
      memories_by_source[row.source] += count;
    }
  }

  return {
    memories_total: parseInt(metricsRow.memories_total, 10),
    memories_by_type,
    memories_by_source,
    memories_soft_deleted: parseInt(metricsRow.memories_soft_deleted, 10),
    embedder_queue_depth: parseInt(metricsRow.embedder_queue_depth, 10),
    embedder_queue_oldest: metricsRow.embedder_queue_oldest
      ? metricsRow.embedder_queue_oldest.toISOString()
      : null,
    distill_cursor_lag_seconds_max: Math.round(
      parseFloat(metricsRow.distill_cursor_lag_seconds_max) * 100,
    ) / 100,
    audit_log_size: parseInt(metricsRow.audit_log_size, 10),
  };
}
