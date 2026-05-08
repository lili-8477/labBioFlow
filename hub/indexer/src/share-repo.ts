import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { stat } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { insertMemoryRow } from "./distiller-repo.js";
import { contentHash } from "./content-hash.js";
import { appendAudit } from "./memory-repo.js";
import {
  safeJoin,
  walkSkillFiles,
  readSkillManifest,
  packSkillTarball,
} from "./share-fs.js";

export type ArtifactKind = "memory" | "skill" | "folder";
export type ShareStatus = "pending" | "approved" | "rejected" | "withdrawn";

export interface ShareRequest {
  share_id:         string;
  artifact_kind:    ArtifactKind;
  artifact_ref:     string;
  snapshot_meta:    Record<string, unknown>;
  requester:        string;
  reviewer:         string;
  status:           ShareStatus;
  requester_note:   string | null;
  review_comment:   string | null;
  promotion_result: Record<string, unknown> | null;
  created_at:       string; // ISO
  decided_at:       string | null;
}

// ─── row type returned directly from PG ────────────────────────────────────

interface ShareRow {
  share_id:         string;
  artifact_kind:    string;
  artifact_ref:     string;
  snapshot_meta:    Record<string, unknown>;
  requester:        string;
  reviewer:         string;
  status:           string;
  requester_note:   string | null;
  review_comment:   string | null;
  promotion_result: Record<string, unknown> | null;
  created_at:       Date;
  decided_at:       Date | null;
}

function mapRow(r: ShareRow): ShareRequest {
  return {
    share_id:         r.share_id,
    artifact_kind:    r.artifact_kind as ArtifactKind,
    artifact_ref:     r.artifact_ref,
    snapshot_meta:    r.snapshot_meta,
    requester:        r.requester,
    reviewer:         r.reviewer,
    status:           r.status as ShareStatus,
    requester_note:   r.requester_note,
    review_comment:   r.review_comment,
    promotion_result: r.promotion_result,
    created_at:       r.created_at.toISOString(),
    decided_at:       r.decided_at ? r.decided_at.toISOString() : null,
  };
}

// ─── 1. submitShareRequest ──────────────────────────────────────────────────

export interface SubmitArgs {
  pool:               Pool;
  manager:            string | null;
  requester:          string;
  kind:               ArtifactKind;
  ref:                string;
  note?:              string;
  // Phase 2: required for the skill branch. Memory branch ignores them.
  workspacesRoot:     string;        // e.g. "/workspaces"
  shareSnapshotsDir:  string;        // e.g. "/workspaces/shared/.share-snapshots"
}

export type SubmitResult =
  | { ok: true; share_id: string }
  | { ok: false; reason:
        | "no_manager"
        | "not_implemented"
        | "forbidden"
        | "invalid_ref"
        | "source_not_found"
        | "missing_manifest"
        | "snapshot_failed";
      detail?: string };

export async function submitShareRequest(args: SubmitArgs): Promise<SubmitResult> {
  if (args.manager === null) {
    return { ok: false, reason: "no_manager" };
  }
  if (args.kind === "skill") {
    return await submitSkillShareRequest(args);
  }
  if (args.kind !== "memory") {
    return { ok: false, reason: "not_implemented" };
  }

  // Single-query ownership check + snapshot fetch. Folding these into one
  // round-trip both shrinks the race window between checking ownership and
  // freezing the body, AND turns "not owned / soft-deleted" into "no rows"
  // — same code path as the source not existing, so we don't leak which.
  const snap = await args.pool.query<{
    name:        string;
    description: string;
    body:        string;
    type:        string;
    source:      string;
    hit_count:   number;
    last_hit_at: Date | null;
    facets:      Record<string, string[]>;
  }>(
    `SELECT m.name, m.description, m.body, m.type, m.source,
            m.hit_count, m.last_hit_at,
            COALESCE((SELECT jsonb_object_agg(key, vals)
                        FROM (
                          SELECT key,
                                 jsonb_agg(value ORDER BY value COLLATE "C") AS vals
                            FROM memory_facets
                           WHERE memory_id = m.memory_id
                           GROUP BY key
                        ) g), '{}'::jsonb) AS facets
       FROM memories m
      WHERE m.memory_id = $1
        AND m.username  = $2
        AND m.deleted_at IS NULL`,
    [args.ref, args.requester],
  );
  if ((snap.rowCount ?? 0) === 0) {
    return { ok: false, reason: "forbidden" };
  }
  const s = snap.rows[0]!;
  const snapshot_meta: Record<string, unknown> = {
    name:        s.name,
    description: s.description,
    body:        s.body,
    type:        s.type,
    source:      s.source,
    hit_count:   s.hit_count,
    last_hit_at: s.last_hit_at ? s.last_hit_at.toISOString() : null,
    facets:      s.facets,
  };

  const share_id = randomUUID();
  await args.pool.query(
    `INSERT INTO share_requests
       (share_id, artifact_kind, artifact_ref, snapshot_meta,
        requester, reviewer, requester_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      share_id,
      args.kind,
      args.ref,
      snapshot_meta,
      args.requester,
      args.manager,
      args.note ?? null,
    ],
  );
  return { ok: true, share_id };
}

async function submitSkillShareRequest(args: SubmitArgs): Promise<SubmitResult> {
  // Resolve <workspaces>/<requester>/.claude/skills/<ref>; reject traversal.
  const userSkillsRoot = path.join(args.workspacesRoot, args.requester, ".claude", "skills");
  const resolved = safeJoin(userSkillsRoot, args.ref);
  if (resolved === null) {
    return { ok: false, reason: "invalid_ref" };
  }

  let st;
  try {
    st = await stat(resolved);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "source_not_found" };
    }
    throw e;
  }
  if (!st.isDirectory()) {
    return { ok: false, reason: "source_not_found", detail: "ref is not a directory" };
  }

  const manifest = await readSkillManifest(resolved);
  if (manifest === null) {
    return { ok: false, reason: "missing_manifest", detail: "no SKILL.md at top level" };
  }

  const files = await walkSkillFiles(resolved);

  const share_id = randomUUID();
  const tarPath = path.join(args.shareSnapshotsDir, `${share_id}.tar.gz`);
  try {
    await packSkillTarball({ skillDir: resolved, destTar: tarPath });
  } catch (e) {
    return { ok: false, reason: "snapshot_failed", detail: (e as Error).message };
  }

  const snapshot_meta: Record<string, unknown> = {
    root_name: path.basename(resolved),
    manifest,
    files,
  };

  await args.pool.query(
    `INSERT INTO share_requests
       (share_id, artifact_kind, artifact_ref, snapshot_meta,
        requester, reviewer, requester_note)
     VALUES ($1, 'skill', $2, $3, $4, $5, $6)`,
    [share_id, args.ref, snapshot_meta, args.requester, args.manager, args.note ?? null],
  );
  return { ok: true, share_id };
}

// ─── 2. listShareRequests ───────────────────────────────────────────────────

export interface ListArgs {
  pool:    Pool;
  actor:   string;
  manager: string | null;
  role:    "outbox" | "inbox" | "all";
  status?: ShareStatus;
  limit?:  number;
  cursor?: string; // ISO created_at; rows with created_at < cursor
}

export interface ListResult {
  items:       ShareRequest[];
  next_cursor: string | null;
}

export async function listShareRequests(args: ListArgs): Promise<ListResult> {
  const limit = Math.min(args.limit ?? 50, 200);

  // inbox: only the manager sees their inbox
  if (args.role === "inbox") {
    if (args.actor !== args.manager) {
      return { items: [], next_cursor: null };
    }
  }

  const conditions: string[] = [];
  const params: unknown[] = [];

  // Role filter
  if (args.role === "outbox") {
    params.push(args.actor);
    conditions.push(`requester = $${params.length}`);
  } else if (args.role === "inbox") {
    params.push(args.actor);
    conditions.push(`reviewer = $${params.length}`);
    conditions.push(`status = 'pending'`);
  } else {
    // all
    params.push(args.actor);
    conditions.push(`(requester = $${params.length} OR reviewer = $${params.length})`);
  }

  if (args.status !== undefined) {
    params.push(args.status);
    conditions.push(`status = $${params.length}`);
  }

  // Cursor format is "ISO|share_id" so two rows sharing created_at to
  // microsecond precision (same-transaction inserts, deterministic seeders)
  // can still page deterministically by the share_id tiebreaker. Plain ISO
  // cursors from older clients fall back to created_at-only filtering.
  if (args.cursor !== undefined) {
    const [cursorTs, cursorId] = args.cursor.includes("|")
      ? args.cursor.split("|", 2) as [string, string]
      : [args.cursor, null];
    if (cursorId === null) {
      params.push(cursorTs);
      conditions.push(`created_at < $${params.length}::timestamptz`);
    } else {
      params.push(cursorTs);
      params.push(cursorId);
      conditions.push(
        `(created_at, share_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit + 1);
  const sql = `SELECT * FROM share_requests ${where}
                ORDER BY created_at DESC, share_id DESC
                LIMIT $${params.length}`;

  const result = await args.pool.query<ShareRow>(sql, params);
  const rows = result.rows;

  let next_cursor: string | null = null;
  if (rows.length > limit) {
    rows.splice(limit);
    const tail = rows[rows.length - 1]!;
    next_cursor = `${tail.created_at.toISOString()}|${tail.share_id}`;
  }

  return { items: rows.map(mapRow), next_cursor };
}

// ─── 3. getShareRequest ─────────────────────────────────────────────────────

export async function getShareRequest(args: {
  pool:    Pool;
  actor:   string;
  shareId: string;
}): Promise<ShareRequest | { error: "not_found" | "forbidden" }> {
  const r = await args.pool.query<ShareRow>(
    `SELECT * FROM share_requests WHERE share_id = $1`,
    [args.shareId],
  );
  if ((r.rowCount ?? 0) === 0) {
    return { error: "not_found" };
  }
  const row = r.rows[0]!;
  if (row.requester !== args.actor && row.reviewer !== args.actor) {
    return { error: "forbidden" };
  }
  return mapRow(row);
}

// ─── 4. decideShareRequest ──────────────────────────────────────────────────

export interface DecideArgs {
  pool:     Pool;
  actor:    string;
  manager:  string | null;
  shareId:  string;
  decision: "approve" | "reject";
  comment?: string;
}

export type DecideResult =
  | { ok: true; status: ShareStatus; promotion_result?: Record<string, unknown> }
  | { ok: false; reason: "not_found" | "forbidden" | "already_decided" | "promotion_failed";
      detail?: string };

export async function decideShareRequest(args: DecideArgs): Promise<DecideResult> {
  if (args.manager === null || args.actor !== args.manager) {
    return { ok: false, reason: "forbidden" };
  }

  const client = await args.pool.connect();
  try {
    await client.query("BEGIN");

    const r = await client.query<ShareRow>(
      `SELECT * FROM share_requests WHERE share_id = $1 FOR UPDATE`,
      [args.shareId],
    );
    if ((r.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    const row = r.rows[0]!;

    if (row.status !== "pending") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "already_decided", detail: row.status };
    }

    if (args.decision === "reject") {
      await client.query(
        `UPDATE share_requests
            SET status = 'rejected', decided_at = now(), review_comment = $1
          WHERE share_id = $2`,
        [args.comment ?? null, args.shareId],
      );
      await client.query("COMMIT");
      return { ok: true, status: "rejected" };
    }

    // approve path
    if (row.artifact_kind !== "memory") {
      await client.query("ROLLBACK");
      return {
        ok:     false,
        reason: "promotion_failed",
        detail: `kind '${row.artifact_kind}' not implemented`,
      };
    }

    // Validate snapshot shape before trusting the cast. Older rows or
    // future externally-written snapshots could land here malformed; we'd
    // rather emit promotion_failed (auditable, recoverable) than crash
    // deep inside insertMemoryRow against a NOT NULL constraint.
    const rawSnap = row.snapshot_meta as Record<string, unknown>;
    if (
      typeof rawSnap.name        !== "string" ||
      typeof rawSnap.description !== "string" ||
      typeof rawSnap.body        !== "string" ||
      typeof rawSnap.type        !== "string" ||
      typeof rawSnap.facets      !== "object" || rawSnap.facets === null
    ) {
      await client.query("ROLLBACK");
      return {
        ok:     false,
        reason: "promotion_failed",
        detail: "snapshot_meta is missing required string fields (name/description/body/type/facets)",
      };
    }
    const snap = rawSnap as {
      name:        string;
      description: string;
      body:        string;
      type:        string;
      facets:      Record<string, string[] | undefined>;
    };

    const hash = contentHash({ body: `${snap.name}\n${snap.body}`, promptVersion: 0 });

    const promotedId = await insertMemoryRow(client, {
      username:          "__org__",
      project_dir:       null,
      source:            "user",
      type:              snap.type,
      source_session_id: null,
      name:              snap.name,
      description:       snap.description,
      body:              snap.body,
      facets:            snap.facets,
      content_hash:      hash,
    });

    let promotion_result: Record<string, unknown>;

    if (promotedId !== null) {
      await appendAudit(client, {
        memory_id: promotedId,
        actor:     "__org__",
        action:    "write",
        before:    null,
        after:     {
          via:            "share_promotion",
          share_id:       args.shareId,
          promoted_from:  row.artifact_ref,
        },
      });
      promotion_result = { promoted_memory_id: promotedId, deduped: false };
    } else {
      // Dedup hit: look up the existing org row with same content_hash.
      const existing = await client.query<{ memory_id: string }>(
        `SELECT memory_id FROM memories
          WHERE username = '__org__' AND project_dir IS NULL
            AND type = $1 AND content_hash = $2`,
        [snap.type, hash],
      );
      const existing_memory_id = (existing.rowCount ?? 0) > 0
        ? existing.rows[0]!.memory_id
        : null;
      promotion_result = { deduped: true, existing_memory_id, promoted_memory_id: null };
    }

    await client.query(
      `UPDATE share_requests
          SET status = 'approved', decided_at = now(),
              review_comment = $1, promotion_result = $2
        WHERE share_id = $3`,
      [args.comment ?? null, promotion_result, args.shareId],
    );
    await client.query("COMMIT");
    return { ok: true, status: "approved", promotion_result };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ─── 5. withdrawShareRequest ────────────────────────────────────────────────

export async function withdrawShareRequest(args: {
  pool:    Pool;
  actor:   string;
  shareId: string;
}): Promise<{ ok: boolean; reason?: "not_found" | "forbidden" | "already_decided" }> {
  const client = await args.pool.connect();
  try {
    await client.query("BEGIN");

    const r = await client.query<ShareRow>(
      `SELECT * FROM share_requests WHERE share_id = $1 FOR UPDATE`,
      [args.shareId],
    );
    if ((r.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    const row = r.rows[0]!;

    if (row.requester !== args.actor) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "forbidden" };
    }
    if (row.status !== "pending") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "already_decided" };
    }

    await client.query(
      `UPDATE share_requests SET status = 'withdrawn', decided_at = now() WHERE share_id = $1`,
      [args.shareId],
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ─── 6. getShareCapabilities ────────────────────────────────────────────────

export async function getShareCapabilities(args: {
  pool:    Pool;
  actor:   string;
  manager: string | null;
}): Promise<{
  is_manager:           boolean;
  manager_username:     string | null;
  pending_inbox_count:  number;
  actor_username:       string;
}> {
  const is_manager = args.manager !== null && args.actor === args.manager;

  let pending_inbox_count = 0;
  if (is_manager) {
    const r = await args.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM share_requests
        WHERE reviewer = $1 AND status = 'pending'`,
      [args.actor],
    );
    pending_inbox_count = parseInt(r.rows[0]!.count, 10);
  }

  return {
    is_manager,
    manager_username:    args.manager,
    pending_inbox_count,
    actor_username:      args.actor,
  };
}
