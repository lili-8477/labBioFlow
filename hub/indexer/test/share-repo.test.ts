import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runMigrations } from "../src/migrate.js";
import { insertMemoryRow } from "../src/distiller-repo.js";
import { contentHash } from "../src/content-hash.js";
import {
  submitShareRequest,
  listShareRequests,
  getShareRequest,
  decideShareRequest,
  withdrawShareRequest,
  getShareCapabilities,
  type ShareStatus,
  type ArtifactKind,
} from "../src/share-repo.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
let pg: StartedPostgreSqlContainer;
let pool: Pool;

const MANAGER = "li86";
const ALICE   = "alice";
const BOB     = "bob";

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
  await pool.query("TRUNCATE share_requests CASCADE");
  await pool.query("TRUNCATE memories CASCADE");
});

// ─── helpers ────────────────────────────────────────────────────────────────

let _seedSeq = 0;

/** Insert a memory row for `username`, returning its memory_id. */
async function seedMemory(args: {
  username:    string;
  body?:       string;
  type?:       string;
  deleted?:    boolean;
  facets?:     Record<string, string[]>;
}): Promise<string> {
  _seedSeq++;
  const body = args.body ?? `body-${_seedSeq}`;
  const name = `name-${_seedSeq}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const hash = contentHash({ body: `${name}\n${body}`, promptVersion: 0 });
    const memId = await insertMemoryRow(client, {
      username:          args.username,
      project_dir:       null,
      source:            "user",
      type:              args.type ?? "observation",
      source_session_id: null,
      name,
      description:       `desc-${_seedSeq}`,
      body,
      facets:            args.facets ?? {},
      content_hash:      hash,
    });
    if (!memId) throw new Error("seed dedup collision");
    if (args.deleted) {
      await client.query("UPDATE memories SET deleted_at = now() WHERE memory_id = $1", [memId]);
    }
    await client.query("COMMIT");
    return memId;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Insert directly into share_requests, bypassing business-logic checks. */
async function seedRequest(args: {
  requester: string;
  kind?:     ArtifactKind;
  ref?:      string;
  note?:     string;
  status?:   ShareStatus;
  reviewer?: string;
}): Promise<string> {
  const share_id = randomUUID();
  const status   = args.status ?? "pending";
  const decided  = status !== "pending" ? "now()" : "NULL";
  await pool.query(
    `INSERT INTO share_requests
       (share_id, artifact_kind, artifact_ref, snapshot_meta,
        requester, reviewer, status, decided_at, requester_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             ${decided}, $8)`,
    [
      share_id,
      args.kind ?? "memory",
      args.ref  ?? randomUUID(),
      { name: "snap-name", body: "snap-body", type: "observation", source: "user",
        description: "snap-desc", hit_count: 0, last_hit_at: null, facets: {} },
      args.requester,
      args.reviewer ?? MANAGER,
      status,
      args.note ?? null,
    ],
  );
  return share_id;
}

// ─── submitShareRequest ──────────────────────────────────────────────────────

describe("submitShareRequest", () => {
  it("happy path: queues memory request; snapshot has frozen body+facets; status=pending; reviewer=manager", async () => {
    const ref = await seedMemory({
      username: ALICE,
      body:     "my bioflow note",
      facets:   { tool: ["scanpy", "cellranger"] },
    });

    const result = await submitShareRequest({
      pool,
      managers:  [MANAGER],
      requester: ALICE,
      kind:      "memory",
      ref,
      note:      "please share",
      workspacesRoot:    "/tmp/unused",
      shareSnapshotsDir: "/tmp/unused",
      maxFolderBytes:    100 * 1024 * 1024,
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unreachable");

    const r = await pool.query<{
      status:         string;
      reviewer:       string;
      requester_note: string | null;
      snapshot_meta:  Record<string, unknown>;
    }>(
      `SELECT status, reviewer, requester_note, snapshot_meta
         FROM share_requests WHERE share_id = $1`,
      [result.share_id],
    );
    expect(r.rowCount).toBe(1);
    const row = r.rows[0]!;
    expect(row.status).toBe("pending");
    expect(row.reviewer).toBe(MANAGER);
    expect(row.requester_note).toBe("please share");
    expect(row.snapshot_meta.body).toBe("my bioflow note");
    expect(row.snapshot_meta.facets).toEqual({ tool: ["cellranger", "scanpy"] });
  });

  it("returns no_manager when manager is null", async () => {
    const ref = await seedMemory({ username: ALICE });
    const result = await submitShareRequest({ pool, managers: [], requester: ALICE, kind: "memory", ref, workspacesRoot: "/tmp/unused", shareSnapshotsDir: "/tmp/unused", maxFolderBytes: 100 * 1024 * 1024 });
    expect(result).toEqual({ ok: false, reason: "no_manager" });
  });

  it("returns forbidden when source memory_id is owned by a different user", async () => {
    const ref = await seedMemory({ username: BOB });
    const result = await submitShareRequest({ pool, managers: [MANAGER], requester: ALICE, kind: "memory", ref, workspacesRoot: "/tmp/unused", shareSnapshotsDir: "/tmp/unused", maxFolderBytes: 100 * 1024 * 1024 });
    expect(result).toEqual({ ok: false, reason: "forbidden" });
  });

  it("returns forbidden when source memory is soft-deleted", async () => {
    const ref = await seedMemory({ username: ALICE, deleted: true });
    const result = await submitShareRequest({ pool, managers: [MANAGER], requester: ALICE, kind: "memory", ref, workspacesRoot: "/tmp/unused", shareSnapshotsDir: "/tmp/unused", maxFolderBytes: 100 * 1024 * 1024 });
    expect(result).toEqual({ ok: false, reason: "forbidden" });
  });
});

// ─── listShareRequests ───────────────────────────────────────────────────────

describe("listShareRequests", () => {
  it("outbox: returns own submissions across all statuses, newest first", async () => {
    const s1 = await seedRequest({ requester: ALICE, status: "pending" });
    const s2 = await seedRequest({ requester: ALICE, status: "approved" });
    const _s3 = await seedRequest({ requester: BOB, status: "pending" }); // not alice's

    const result = await listShareRequests({ pool, actor: ALICE, managers: [MANAGER], role: "outbox" });
    const ids = result.items.map((x) => x.share_id);
    expect(ids).toContain(s1);
    expect(ids).toContain(s2);
    expect(ids).not.toContain(_s3);

    // newest first (s2 inserted after s1 in this loop)
    expect(ids.indexOf(s2)).toBeLessThan(ids.indexOf(s1));
  });

  it("inbox: returns reviewer=actor pending only; empty for non-managers", async () => {
    await seedRequest({ requester: ALICE, status: "pending",  reviewer: MANAGER });
    await seedRequest({ requester: ALICE, status: "approved", reviewer: MANAGER });

    // Non-manager gets empty list
    const asAlice = await listShareRequests({ pool, actor: ALICE, managers: [MANAGER], role: "inbox" });
    expect(asAlice.items).toHaveLength(0);

    // Manager gets only pending
    const asManager = await listShareRequests({ pool, actor: MANAGER, managers: [MANAGER], role: "inbox" });
    expect(asManager.items.every((x) => x.status === "pending")).toBe(true);
    expect(asManager.items.length).toBe(1);
  });

  it("all: returns rows where actor is requester OR reviewer", async () => {
    const s1 = await seedRequest({ requester: ALICE, reviewer: MANAGER });
    const s2 = await seedRequest({ requester: BOB,   reviewer: MANAGER });
    const s3 = await seedRequest({ requester: BOB,   reviewer: ALICE });
    const s4 = await seedRequest({ requester: BOB,   reviewer: BOB });

    const result = await listShareRequests({ pool, actor: ALICE, managers: [MANAGER], role: "all" });
    const ids = result.items.map((x) => x.share_id);
    expect(ids).toContain(s1);
    expect(ids).not.toContain(s2); // alice not involved
    expect(ids).toContain(s3);     // alice is reviewer
    expect(ids).not.toContain(s4);
  });

  it("status filter narrows results", async () => {
    const pending  = await seedRequest({ requester: ALICE, status: "pending" });
    const approved = await seedRequest({ requester: ALICE, status: "approved" });

    const result = await listShareRequests({
      pool, actor: ALICE, managers: [MANAGER], role: "outbox", status: "approved",
    });
    const ids = result.items.map((x) => x.share_id);
    expect(ids).toContain(approved);
    expect(ids).not.toContain(pending);
  });

  it("cursor pagination: limit=2 traversal yields the same set as a single limit=200 query (Set comparison)", async () => {
    // Insert 5 requests
    for (let i = 0; i < 5; i++) {
      await seedRequest({ requester: ALICE });
      // Stagger created_at slightly to ensure deterministic ordering
      await pool.query(
        `UPDATE share_requests
            SET created_at = now() - ($1 * interval '1 millisecond')
          WHERE share_id = (SELECT share_id FROM share_requests ORDER BY created_at ASC LIMIT 1)`,
        [i * 10],
      );
    }

    const reference = await listShareRequests({
      pool, actor: ALICE, managers: [MANAGER], role: "outbox", limit: 200,
    });
    const refIds = new Set(reference.items.map((x) => x.share_id));
    expect(refIds.size).toBe(5);

    const collected = new Set<string>();
    let cursor: string | undefined = undefined;
    let pages = 0;
    do {
      const page = await listShareRequests({
        pool, actor: ALICE, managers: [MANAGER], role: "outbox", limit: 2, cursor,
      });
      for (const item of page.items) collected.add(item.share_id);
      cursor = page.next_cursor ?? undefined;
      pages++;
      expect(pages).toBeLessThanOrEqual(4);
    } while (cursor !== undefined);

    expect(collected).toEqual(refIds);
  });

  it("cursor pagination is stable when multiple rows share created_at to microsecond precision", async () => {
    // Insert 6 rows then crush their created_at to a single timestamp — exactly
    // the case where a created_at-only cursor would skip rows. The (created_at,
    // share_id) tuple cursor must traverse all 6.
    for (let i = 0; i < 6; i++) {
      await seedRequest({ requester: ALICE });
    }
    await pool.query(
      `UPDATE share_requests SET created_at = '2026-05-07T12:00:00Z' WHERE requester = $1`,
      [ALICE],
    );

    const collected = new Set<string>();
    let cursor: string | undefined = undefined;
    let pages = 0;
    do {
      const page = await listShareRequests({
        pool, actor: ALICE, managers: [MANAGER], role: "outbox", limit: 2, cursor,
      });
      for (const item of page.items) collected.add(item.share_id);
      cursor = page.next_cursor ?? undefined;
      pages++;
      expect(pages).toBeLessThanOrEqual(4);  // 6 rows / 2 per page = 3 pages, +1 buffer
    } while (cursor !== undefined);

    expect(collected.size).toBe(6);
  });
});

// ─── getShareRequest ─────────────────────────────────────────────────────────

describe("getShareRequest", () => {
  it("returns row when actor is requester", async () => {
    const shareId = await seedRequest({ requester: ALICE, reviewer: MANAGER });
    const result = await getShareRequest({ pool, actor: ALICE, shareId });
    expect("share_id" in result).toBe(true);
    if (!("share_id" in result)) throw new Error("unreachable");
    expect(result.share_id).toBe(shareId);
  });

  it("returns row when actor is reviewer", async () => {
    const shareId = await seedRequest({ requester: ALICE, reviewer: MANAGER });
    const result = await getShareRequest({ pool, actor: MANAGER, shareId });
    expect("share_id" in result).toBe(true);
  });

  it("returns {error:forbidden} when actor is neither", async () => {
    const shareId = await seedRequest({ requester: ALICE, reviewer: MANAGER });
    const result = await getShareRequest({ pool, actor: BOB, shareId });
    expect(result).toEqual({ error: "forbidden" });
  });

  it("returns {error:not_found} for missing share_id", async () => {
    const result = await getShareRequest({ pool, actor: ALICE, shareId: randomUUID() });
    expect(result).toEqual({ error: "not_found" });
  });
});

// ─── decideShareRequest ───────────────────────────────────────────────────────

describe("decideShareRequest", () => {
  it("approve memory: inserts org row, status→approved, promotion_result.promoted_memory_id is set, audit row with via=share_promotion appended", async () => {
    // Create source memory for snapshot
    const ref = await seedMemory({ username: ALICE, body: "shared content" });

    // Submit so snapshot is frozen
    const sub = await submitShareRequest({ pool, managers: [MANAGER], requester: ALICE, kind: "memory", ref, workspacesRoot: "/tmp/unused", shareSnapshotsDir: "/tmp/unused", maxFolderBytes: 100 * 1024 * 1024 });
    expect(sub.ok).toBe(true);
    if (!sub.ok) throw new Error("unreachable");

    const result = await decideShareRequest({
      pool, actor: MANAGER, managers: [MANAGER], shareId: sub.share_id, decision: "approve",
      workspacesRoot: "/tmp/unused", shareSnapshotsDir: "/tmp/unused",
    });

    expect(result).toMatchObject({ ok: true, status: "approved" });
    if (!result.ok) throw new Error("unreachable");
    expect(result.promotion_result?.promoted_memory_id).toBeTruthy();
    expect(result.promotion_result?.deduped).toBe(false);

    // Org row exists
    const orgRow = await pool.query<{ username: string }>(
      `SELECT username FROM memories WHERE memory_id = $1`,
      [result.promotion_result!.promoted_memory_id],
    );
    expect(orgRow.rowCount).toBe(1);
    expect(orgRow.rows[0]!.username).toBe("__org__");

    // share_request updated
    const sr = await pool.query<{ status: string; promotion_result: Record<string, unknown> }>(
      `SELECT status, promotion_result FROM share_requests WHERE share_id = $1`,
      [sub.share_id],
    );
    expect(sr.rows[0]!.status).toBe("approved");

    // audit row
    const audit = await pool.query<{ after: Record<string, unknown> }>(
      `SELECT after FROM memory_audit_log WHERE memory_id = $1 AND action = 'write'`,
      [result.promotion_result!.promoted_memory_id],
    );
    expect(audit.rowCount).toBe(1);
    expect((audit.rows[0]!.after as Record<string, unknown>).via).toBe("share_promotion");
    expect((audit.rows[0]!.after as Record<string, unknown>).share_id).toBe(sub.share_id);
  });

  it("approve memory dedup: when org row already exists with same content, promotion_result.deduped=true, status still approves", async () => {
    const snapName = "dedup-snap";
    const snapBody = "dedup body content";
    const hash = contentHash({ body: `${snapName}\n${snapBody}`, promptVersion: 0 });

    // Pre-insert org row with same content_hash
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existingId = await insertMemoryRow(client, {
        username:          "__org__",
        project_dir:       null,
        source:            "user",
        type:              "observation",
        source_session_id: null,
        name:              snapName,
        description:       "pre-existing",
        body:              snapBody,
        facets:            {},
        content_hash:      hash,
      });
      await client.query("COMMIT");
      if (!existingId) throw new Error("unexpected dedup on pre-insert");
    } finally {
      client.release();
    }

    // Create a share request whose snapshot hashes to the same value
    const shareId = randomUUID();
    await pool.query(
      `INSERT INTO share_requests
         (share_id, artifact_kind, artifact_ref, snapshot_meta, requester, reviewer)
       VALUES ($1, 'memory', $2, $3, $4, $5)`,
      [
        shareId,
        randomUUID(),
        { name: snapName, body: snapBody, type: "observation", source: "user",
          description: "desc", hit_count: 0, last_hit_at: null, facets: {} },
        ALICE,
        MANAGER,
      ],
    );

    const result = await decideShareRequest({
      pool, actor: MANAGER, managers: [MANAGER], shareId, decision: "approve",
      workspacesRoot: "/tmp/unused", shareSnapshotsDir: "/tmp/unused",
    });

    expect(result).toMatchObject({ ok: true, status: "approved" });
    if (!result.ok) throw new Error("unreachable");
    expect(result.promotion_result?.deduped).toBe(true);
    expect(result.promotion_result?.existing_memory_id).toBeTruthy();
    expect(result.promotion_result?.promoted_memory_id).toBeNull();

    const sr = await pool.query<{ status: string }>(
      `SELECT status FROM share_requests WHERE share_id = $1`,
      [shareId],
    );
    expect(sr.rows[0]!.status).toBe("approved");
  });

  it("reject memory: status→rejected, review_comment stored, no DB row created in memories", async () => {
    const ref = await seedMemory({ username: ALICE });
    const sub = await submitShareRequest({ pool, managers: [MANAGER], requester: ALICE, kind: "memory", ref, workspacesRoot: "/tmp/unused", shareSnapshotsDir: "/tmp/unused", maxFolderBytes: 100 * 1024 * 1024 });
    expect(sub.ok).toBe(true);
    if (!sub.ok) throw new Error("unreachable");

    const countBefore = (await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memories WHERE username = '__org__'`,
    )).rows[0]!.count;

    const result = await decideShareRequest({
      pool, actor: MANAGER, managers: [MANAGER], shareId: sub.share_id,
      decision: "reject", comment: "not relevant",
      workspacesRoot: "/tmp/unused", shareSnapshotsDir: "/tmp/unused",
    });

    expect(result).toMatchObject({ ok: true, status: "rejected" });

    const countAfter = (await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM memories WHERE username = '__org__'`,
    )).rows[0]!.count;
    expect(countBefore).toBe(countAfter); // no new org row

    const sr = await pool.query<{ status: string; review_comment: string }>(
      `SELECT status, review_comment FROM share_requests WHERE share_id = $1`,
      [sub.share_id],
    );
    expect(sr.rows[0]!.status).toBe("rejected");
    expect(sr.rows[0]!.review_comment).toBe("not relevant");
  });

  it("returns forbidden when actor != manager", async () => {
    const shareId = await seedRequest({ requester: ALICE, reviewer: MANAGER });
    const result = await decideShareRequest({
      pool, actor: ALICE, managers: [MANAGER], shareId, decision: "approve",
      workspacesRoot: "/tmp/unused", shareSnapshotsDir: "/tmp/unused",
    });
    expect(result).toEqual({ ok: false, reason: "forbidden" });
  });

  it("returns forbidden when manager is null", async () => {
    const shareId = await seedRequest({ requester: ALICE, reviewer: MANAGER });
    const result = await decideShareRequest({
      pool, actor: MANAGER, managers: [], shareId, decision: "approve",
      workspacesRoot: "/tmp/unused", shareSnapshotsDir: "/tmp/unused",
    });
    expect(result).toEqual({ ok: false, reason: "forbidden" });
  });

  it("returns already_decided when called twice on the same share_id", async () => {
    const ref = await seedMemory({ username: ALICE });
    const sub = await submitShareRequest({ pool, managers: [MANAGER], requester: ALICE, kind: "memory", ref, workspacesRoot: "/tmp/unused", shareSnapshotsDir: "/tmp/unused", maxFolderBytes: 100 * 1024 * 1024 });
    expect(sub.ok).toBe(true);
    if (!sub.ok) throw new Error("unreachable");

    const first = await decideShareRequest({
      pool, actor: MANAGER, managers: [MANAGER], shareId: sub.share_id, decision: "reject",
      workspacesRoot: "/tmp/unused", shareSnapshotsDir: "/tmp/unused",
    });
    expect(first.ok).toBe(true);

    const second = await decideShareRequest({
      pool, actor: MANAGER, managers: [MANAGER], shareId: sub.share_id, decision: "approve",
      workspacesRoot: "/tmp/unused", shareSnapshotsDir: "/tmp/unused",
    });
    expect(second).toMatchObject({ ok: false, reason: "already_decided" });
  });

  it("approve on kind=skill with malformed snapshot_meta returns promotion_failed", async () => {
    // Bypass submitShareRequest by inserting a skill-kind row whose snapshot_meta
    // lacks the root_name/manifest/files fields that approveSkillShareRequest requires.
    // Guards the shape-validation path in approveSkillShareRequest.
    const shareId = await seedRequest({ requester: ALICE, kind: "skill", ref: "single-cell-qc" });
    const result = await decideShareRequest({
      pool, actor: MANAGER, managers: [MANAGER], shareId, decision: "approve",
      workspacesRoot: "/tmp/unused", shareSnapshotsDir: "/tmp/unused",
    });
    expect(result).toMatchObject({ ok: false, reason: "promotion_failed" });
    if (result.ok) throw new Error("unreachable");
    expect(result.detail).toMatch(/snapshot_meta/);

    // Status must remain pending — the failed approve rolled back, leaving the request
    // open for the manager to either reject it or retry once skill kind ships.
    const sr = await pool.query<{ status: string }>(
      `SELECT status FROM share_requests WHERE share_id = $1`,
      [shareId],
    );
    expect(sr.rows[0]!.status).toBe("pending");
  });

  it("approve on row with malformed snapshot_meta returns promotion_failed (defense against bad jsonb)", async () => {
    // Inject a memory-kind row whose snapshot is missing required fields.
    // submitShareRequest never produces this shape, but a future external
    // writer or schema migration could; the guard must catch it.
    const shareId = randomUUID();
    await pool.query(
      `INSERT INTO share_requests
         (share_id, artifact_kind, artifact_ref, snapshot_meta, requester, reviewer)
       VALUES ($1, 'memory', 'm-x', $2::jsonb, $3, $4)`,
      [shareId, { not_a_snapshot: true }, ALICE, MANAGER],
    );
    const result = await decideShareRequest({
      pool, actor: MANAGER, managers: [MANAGER], shareId, decision: "approve",
      workspacesRoot: "/tmp/unused", shareSnapshotsDir: "/tmp/unused",
    });
    expect(result).toMatchObject({ ok: false, reason: "promotion_failed" });
    if (result.ok) throw new Error("unreachable");
    expect(result.detail).toMatch(/snapshot_meta/);

    const sr = await pool.query<{ status: string }>(
      `SELECT status FROM share_requests WHERE share_id = $1`,
      [shareId],
    );
    expect(sr.rows[0]!.status).toBe("pending");
  });
});

// ─── withdrawShareRequest ─────────────────────────────────────────────────────

describe("withdrawShareRequest", () => {
  it("happy path: status→withdrawn", async () => {
    const shareId = await seedRequest({ requester: ALICE, status: "pending" });
    const result = await withdrawShareRequest({ pool, actor: ALICE, shareId });
    expect(result).toEqual({ ok: true });

    const sr = await pool.query<{ status: string; decided_at: Date | null }>(
      `SELECT status, decided_at FROM share_requests WHERE share_id = $1`,
      [shareId],
    );
    expect(sr.rows[0]!.status).toBe("withdrawn");
    expect(sr.rows[0]!.decided_at).not.toBeNull();
  });

  it("returns forbidden when actor != requester", async () => {
    const shareId = await seedRequest({ requester: ALICE, status: "pending" });
    const result = await withdrawShareRequest({ pool, actor: BOB, shareId });
    expect(result).toEqual({ ok: false, reason: "forbidden" });
  });

  it("returns already_decided after a previous approve", async () => {
    const shareId = await seedRequest({ requester: ALICE, status: "approved" });
    const result = await withdrawShareRequest({ pool, actor: ALICE, shareId });
    expect(result).toEqual({ ok: false, reason: "already_decided" });
  });
});

// ─── getShareCapabilities ─────────────────────────────────────────────────────

describe("getShareCapabilities", () => {
  it("non-manager: is_manager=false, pending_inbox_count=0, actor_username matches", async () => {
    const caps = await getShareCapabilities({ pool, actor: ALICE, managers: [MANAGER] });
    expect(caps.is_manager).toBe(false);
    expect(caps.pending_inbox_count).toBe(0);
    expect(caps.actor_username).toBe(ALICE);
    expect(caps.manager_usernames).toEqual([MANAGER]);
  });

  it("manager: is_manager=true, count reflects pending rows where reviewer=actor", async () => {
    await seedRequest({ requester: ALICE, reviewer: MANAGER, status: "pending" });
    await seedRequest({ requester: BOB,   reviewer: MANAGER, status: "pending" });
    await seedRequest({ requester: ALICE, reviewer: MANAGER, status: "approved" }); // not pending

    const caps = await getShareCapabilities({ pool, actor: MANAGER, managers: [MANAGER] });
    expect(caps.is_manager).toBe(true);
    expect(caps.pending_inbox_count).toBe(2);
    expect(caps.actor_username).toBe(MANAGER);
    expect(caps.manager_usernames).toEqual([MANAGER]);
  });

  it("manager null: is_manager=false even if actor matches some username", async () => {
    const caps = await getShareCapabilities({ pool, actor: MANAGER, managers: [] });
    expect(caps.is_manager).toBe(false);
    expect(caps.pending_inbox_count).toBe(0);
    expect(caps.manager_usernames).toEqual([]);
  });
});

// ─── submitShareRequest skill branch ─────────────────────────────────────────

describe("submitShareRequest skill branch", () => {
  let workspacesRoot: string;
  let shareSnapshotsDir: string;

  beforeEach(async () => {
    workspacesRoot    = await mkdtemp(path.join(tmpdir(), "ws-"));
    shareSnapshotsDir = await mkdtemp(path.join(tmpdir(), "snap-"));
    // Pre-seed alice's skills/single-cell/SKILL.md
    const skill = path.join(workspacesRoot, "alice", ".claude", "skills", "single-cell");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "# single-cell\nbody\n");
    await writeFile(path.join(skill, "qc.py"), "print(1)\n");
  });

  it("happy path: packs a tarball and writes a pending row", async () => {
    const r = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "skill", ref: "single-cell",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes: 100 * 1024 * 1024,
    });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) throw new Error("type guard");

    const row = (await pool.query(
      `SELECT artifact_kind, snapshot_meta, status FROM share_requests WHERE share_id=$1`,
      [r.share_id])).rows[0];
    expect(row.artifact_kind).toBe("skill");
    expect(row.status).toBe("pending");
    const meta = row.snapshot_meta as { root_name: string; manifest: string; files: { path: string }[] };
    expect(meta.root_name).toBe("single-cell");
    expect(meta.manifest).toMatch(/single-cell/);
    expect(meta.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "qc.py"]);

    // The tarball must exist on disk.
    const tarPath = path.join(shareSnapshotsDir, `${r.share_id}.tar.gz`);
    const { stat } = await import("node:fs/promises");
    expect((await stat(tarPath)).isFile()).toBe(true);
  });

  it("rejects ../ path traversal with invalid_ref", async () => {
    const r = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "skill", ref: "../../etc",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes: 100 * 1024 * 1024,
    });
    expect(r).toEqual({ ok: false, reason: "invalid_ref" });
  });

  it("returns source_not_found when the skill folder does not exist", async () => {
    const r = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "skill", ref: "no-such-skill",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes: 100 * 1024 * 1024,
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe("source_not_found");
  });

  it("returns missing_manifest when SKILL.md is absent", async () => {
    const skill = path.join(workspacesRoot, "alice", ".claude", "skills", "no-manifest");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "qc.py"), "x");
    const r = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "skill", ref: "no-manifest",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes: 100 * 1024 * 1024,
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe("missing_manifest");
  });
});

// ─── decideShareRequest skill approve branch ──────────────────────────────────

describe("decideShareRequest skill approve branch", () => {
  let workspacesRoot: string;
  let shareSnapshotsDir: string;

  beforeEach(async () => {
    workspacesRoot    = await mkdtemp(path.join(tmpdir(), "ws-"));
    shareSnapshotsDir = await mkdtemp(path.join(tmpdir(), "snap-"));
    // Pre-create shared/skills/ — destination of the untar.
    await mkdir(path.join(workspacesRoot, "shared", "skills"), { recursive: true });
    // Seed alice's source skill.
    const skill = path.join(workspacesRoot, "alice", ".claude", "skills", "demo");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "# demo");
    await writeFile(path.join(skill, "run.sh"), "#!/bin/bash\necho hi\n");
  });

  it("approves a pending skill request and untars to shared/skills/", async () => {
    const submitR = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "skill", ref: "demo",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes: 100 * 1024 * 1024,
    });
    expect(submitR.ok).toBe(true);
    if (!submitR.ok) throw new Error("type guard");

    const decideR = await decideShareRequest({
      pool, actor: "li86", managers: ["li86"],
      shareId: submitR.share_id, decision: "approve", comment: "looks good",
      workspacesRoot, shareSnapshotsDir,
    });
    expect(decideR.ok).toBe(true);
    if (!decideR.ok) throw new Error("type guard");
    expect(decideR.status).toBe("approved");
    expect(decideR.promotion_result?.dest_path).toBe(path.join(workspacesRoot, "shared", "skills", "demo"));

    // Files must be present on disk.
    const { readFile } = await import("node:fs/promises");
    const manifest = await readFile(
      path.join(workspacesRoot, "shared", "skills", "demo", "SKILL.md"), "utf8");
    expect(manifest).toMatch(/demo/);
  });

  it("rejects approve when shared/skills/<name> already exists (collision)", async () => {
    // Pre-create the collision target.
    await mkdir(path.join(workspacesRoot, "shared", "skills", "demo"), { recursive: true });

    const submitR = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "skill", ref: "demo",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes: 100 * 1024 * 1024,
    });
    if (!submitR.ok) throw new Error("setup failed");

    const decideR = await decideShareRequest({
      pool, actor: "li86", managers: ["li86"],
      shareId: submitR.share_id, decision: "approve",
      workspacesRoot, shareSnapshotsDir,
    });
    expect(decideR.ok).toBe(false);
    expect((decideR as any).reason).toBe("collision");

    // Status must remain pending so the manager can reject-with-comment.
    const row = (await pool.query(
      `SELECT status FROM share_requests WHERE share_id=$1`, [submitR.share_id])).rows[0];
    expect(row.status).toBe("pending");
  });

  it("snapshot survives source deletion (manager reviews frozen content)", async () => {
    const submitR = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "skill", ref: "demo",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes: 100 * 1024 * 1024,
    });
    if (!submitR.ok) throw new Error("setup failed");
    // Delete the source.
    const { rm } = await import("node:fs/promises");
    await rm(path.join(workspacesRoot, "alice", ".claude", "skills", "demo"), { recursive: true });

    const decideR = await decideShareRequest({
      pool, actor: "li86", managers: ["li86"],
      shareId: submitR.share_id, decision: "approve",
      workspacesRoot, shareSnapshotsDir,
    });
    expect(decideR.ok).toBe(true);
  });
});

// ─── submitShareRequest folder branch ─────────────────────────────────────────

describe("submitShareRequest folder branch", () => {
  let workspacesRoot: string;
  let shareSnapshotsDir: string;
  const maxFolderBytes = 100 * 1024 * 1024;

  beforeEach(async () => {
    workspacesRoot    = await mkdtemp(path.join(tmpdir(), "ws-"));
    shareSnapshotsDir = await mkdtemp(path.join(tmpdir(), "snap-"));
    // Pre-seed alice's local_projects/pbmc/
    const proj = path.join(workspacesRoot, "alice", "local_projects", "pbmc");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "README.md"), "# pbmc analysis\n");
    await writeFile(path.join(proj, "notebook.ipynb"), '{"cells":[]}\n');
  });

  it("happy path: packs a tarball and writes a pending folder row", async () => {
    const r = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "folder", ref: "pbmc",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) throw new Error("type guard");

    const row = (await pool.query(
      `SELECT artifact_kind, snapshot_meta, status FROM share_requests WHERE share_id=$1`,
      [r.share_id])).rows[0];
    expect(row.artifact_kind).toBe("folder");
    const meta = row.snapshot_meta as {
      root_name: string; readme: string | null;
      files: { path: string }[]; total_bytes: number;
    };
    expect(meta.root_name).toBe("pbmc");
    expect(meta.readme).toMatch(/pbmc analysis/);
    expect(meta.files.map((f) => f.path).sort()).toEqual(["README.md", "notebook.ipynb"]);
    const expected = Buffer.byteLength('# pbmc analysis\n') + Buffer.byteLength('{"cells":[]}\n');
    expect(meta.total_bytes).toBe(expected);
  });

  it("happy path with no README.md sets readme=null", async () => {
    const proj = path.join(workspacesRoot, "alice", "local_projects", "no-readme");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "data.csv"), "a,b\n1,2\n");
    const r = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "folder", ref: "no-readme",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("type guard");
    const row = (await pool.query(
      `SELECT snapshot_meta FROM share_requests WHERE share_id=$1`, [r.share_id])).rows[0];
    expect((row.snapshot_meta as any).readme).toBeNull();
  });

  it("rejects ../ path traversal with invalid_ref", async () => {
    const r = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "folder", ref: "../../etc",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    expect(r).toEqual({ ok: false, reason: "invalid_ref" });
  });

  it("returns source_not_found when the folder does not exist", async () => {
    const r = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "folder", ref: "no-such-project",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe("source_not_found");
  });

  it("rejects folder exceeding maxFolderBytes with oversize", async () => {
    // Use a small cap so we don't have to generate 100MB.
    const r = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "folder", ref: "pbmc",
      workspacesRoot, shareSnapshotsDir,
      maxFolderBytes: 10,           // 10-byte cap
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe("oversize");
    expect((r as any).detail).toMatch(/exceeds cap 10/);
  });
});

// ─── decideShareRequest folder approve branch ─────────────────────────────────

describe("decideShareRequest folder approve branch", () => {
  let workspacesRoot: string;
  let shareSnapshotsDir: string;
  const maxFolderBytes = 100 * 1024 * 1024;

  beforeEach(async () => {
    workspacesRoot    = await mkdtemp(path.join(tmpdir(), "ws-"));
    shareSnapshotsDir = await mkdtemp(path.join(tmpdir(), "snap-"));
    await mkdir(path.join(workspacesRoot, "shared", "projects"), { recursive: true });
    const proj = path.join(workspacesRoot, "alice", "local_projects", "demo");
    await mkdir(proj, { recursive: true });
    await writeFile(path.join(proj, "README.md"), "# demo");
    await writeFile(path.join(proj, "run.sh"), "#!/bin/bash\necho hi\n");
  });

  it("approves a pending folder request and untars to shared/projects/", async () => {
    const submitR = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "folder", ref: "demo",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    if (!submitR.ok) throw new Error("setup failed");

    const decideR = await decideShareRequest({
      pool, actor: "li86", managers: ["li86"],
      shareId: submitR.share_id, decision: "approve", comment: "lgtm",
      workspacesRoot, shareSnapshotsDir,
    });
    expect(decideR.ok).toBe(true);
    if (!decideR.ok) throw new Error("type guard");
    expect(decideR.promotion_result?.dest_path).toBe(
      path.join(workspacesRoot, "shared", "projects", "demo"));

    const { readFile } = await import("node:fs/promises");
    const readme = await readFile(
      path.join(workspacesRoot, "shared", "projects", "demo", "README.md"), "utf8");
    expect(readme).toMatch(/demo/);
  });

  it("rejects approve when shared/projects/<name> already exists (collision)", async () => {
    await mkdir(path.join(workspacesRoot, "shared", "projects", "demo"), { recursive: true });
    const submitR = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "folder", ref: "demo",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    if (!submitR.ok) throw new Error("setup failed");
    const decideR = await decideShareRequest({
      pool, actor: "li86", managers: ["li86"],
      shareId: submitR.share_id, decision: "approve",
      workspacesRoot, shareSnapshotsDir,
    });
    expect(decideR.ok).toBe(false);
    expect((decideR as any).reason).toBe("collision");
  });

  it("snapshot survives source deletion", async () => {
    const submitR = await submitShareRequest({
      pool, managers: ["li86"], requester: "alice",
      kind: "folder", ref: "demo",
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    if (!submitR.ok) throw new Error("setup failed");
    const { rm } = await import("node:fs/promises");
    await rm(path.join(workspacesRoot, "alice", "local_projects", "demo"), { recursive: true });

    const decideR = await decideShareRequest({
      pool, actor: "li86", managers: ["li86"],
      shareId: submitR.share_id, decision: "approve",
      workspacesRoot, shareSnapshotsDir,
    });
    expect(decideR.ok).toBe(true);
  });
});

// ─── multi-manager ────────────────────────────────────────────────────────────

describe("multi-manager", () => {
  let workspacesRoot: string;
  let shareSnapshotsDir: string;
  const maxFolderBytes = 100 * 1024 * 1024;
  const managers = ['li86', 'alice'];

  beforeEach(async () => {
    workspacesRoot    = await mkdtemp(path.join(tmpdir(), "ws-"));
    shareSnapshotsDir = await mkdtemp(path.join(tmpdir(), "snap-"));
    // Clean share_requests so counts start fresh.
    await pool.query(`DELETE FROM share_requests`);
  });

  /** Helper: insert a pending memory share row using bob as requester, li86+alice as managers. */
  async function seedPending(): Promise<string> {
    // Use the existing seedMemory helper to insert a valid memory row for bob.
    const memId = await seedMemory({ username: 'bob' });
    const r = await submitShareRequest({
      pool, managers, requester: 'bob',
      kind: 'memory', ref: memId,
      workspacesRoot, shareSnapshotsDir, maxFolderBytes,
    });
    if (!r.ok) throw new Error('seed failed: ' + (r as any).reason);
    return r.share_id;
  }

  it("any manager can approve any pending request", async () => {
    const id = await seedPending();
    // alice (not the primary, but in the managers list) approves
    const r = await decideShareRequest({
      pool, actor: 'alice', managers,
      shareId: id, decision: 'approve',
      workspacesRoot, shareSnapshotsDir,
    });
    expect(r.ok).toBe(true);
  });

  it("a non-manager cannot decide", async () => {
    const id = await seedPending();
    const r = await decideShareRequest({
      pool, actor: 'bob', managers,
      shareId: id, decision: 'approve',
      workspacesRoot, shareSnapshotsDir,
    });
    expect(r).toMatchObject({ ok: false, reason: 'forbidden' });
  });

  it("every manager sees the same pending inbox", async () => {
    await seedPending();
    await seedPending();
    for (const m of managers) {
      const list = await listShareRequests({
        pool, actor: m, managers, role: 'inbox',
      });
      expect(list.items).toHaveLength(2);
    }
  });

  it("getShareCapabilities returns is_manager=true for every manager and pending count", async () => {
    await seedPending();
    for (const m of managers) {
      const caps = await getShareCapabilities({ pool, actor: m, managers });
      expect(caps.is_manager).toBe(true);
      expect(caps.manager_usernames).toEqual(managers);
      expect(caps.pending_inbox_count).toBe(1);
    }
    const caps = await getShareCapabilities({ pool, actor: 'bob', managers });
    expect(caps.is_manager).toBe(false);
    expect(caps.pending_inbox_count).toBe(0);
  });
});
