# Share-promotion — snapshot cleanup cron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Periodically remove snapshot tarballs under `<shareSnapshotsDir>/<share_id>.tar.gz` whose `share_requests` row was decided more than 30 days ago. Today these tarballs accumulate forever (spec §4.1 deferred the cleanup to phase 4); on a long-running deployment the `shared/.share-snapshots/` directory will fill the disk.

**Architecture:** One new helper module `share-cleanup.ts` exporting `cleanupOldSnapshots({ pool, snapshotsDir, ttlDays })`. The indexer process starts an interval loop at boot (mirroring the existing `startEmbedderLoop` in `index.ts`) that calls this function periodically. The helper:
1. SELECTs `share_id` from `share_requests` where `decided_at < now() - <ttl>` AND `artifact_kind IN ('skill', 'folder')` (memory has no tarball).
2. For each row, attempts `unlink(<snapshotsDir>/<share_id>.tar.gz)`.
3. Tracks counts: `deleted`, `missing` (file already gone — idempotent OK), `errors`.
4. Returns the counts; the loop logs them.

No schema changes. No new table. Idempotency comes from file-existence checks rather than a `tarball_deleted_at` column — simpler, and the rows themselves remain queryable for forensics.

**Tech Stack:** Same as the indexer — TypeScript / Node 20, fastify, pg, vitest + `@testcontainers/postgresql`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-07-share-promotion.md` §4.1 "Snapshot lifecycle: snapshots persist for the request's life and 30 days after decision". §12 phase 4 row mentions "snapshot cleanup cron" as one of the deferred items.

**Out of scope:**
- A `tarball_deleted_at` column on `share_requests` (idempotent file delete is enough).
- A cleanup-audit-log table (logs to pino, like other ops events).
- A manual "clean now" admin endpoint (cron + boot pass is sufficient; future-add if useful).
- Cleaning up memory rows (they have no tarball).
- Cleaning up rows that are still `pending` (their snapshot is still active — would be a bug to delete).

---

## File Structure

**Created:**
- `hub/indexer/src/share-cleanup.ts` — exports `cleanupOldSnapshots()` and a `CleanupResult` type
- `hub/indexer/test/share-cleanup.test.ts` — testcontainers + tmpdir test, ~5 cases

**Modified:**
- `hub/indexer/src/config.ts` — add `shareSnapshotTtlDays: number` and `shareCleanupIntervalHours: number`
- `hub/indexer/test/config.test.ts` — 2 tests for the new fields
- `hub/indexer/src/index.ts` — start a `cleanupShareSnapshots` interval loop at boot (mirrors `startEmbedderLoop`)
- `hub/docker-compose.yml` — add `SHARE_SNAPSHOT_TTL_DAYS: "30"` and `SHARE_CLEANUP_INTERVAL_HOURS: "24"` env (explicit, operator-tunable)

---

## Task 1: Config + `share-cleanup.ts` module + tests

**Files:**
- Modify: `hub/indexer/src/config.ts`
- Modify: `hub/indexer/test/config.test.ts`
- Create: `hub/indexer/src/share-cleanup.ts`
- Create: `hub/indexer/test/share-cleanup.test.ts`
- Modify: `hub/docker-compose.yml`

- [ ] **Step 1: Add config fields**

In `hub/indexer/src/config.ts`, alongside `shareMaxFolderBytes`:

```ts
shareSnapshotTtlDays:       number;
shareCleanupIntervalHours:  number;
```

In `loadConfig()` body, before the `return`:

```ts
const shareSnapshotTtlDays      = parseIntVar(env, "SHARE_SNAPSHOT_TTL_DAYS",      30);
const shareCleanupIntervalHours = parseIntVar(env, "SHARE_CLEANUP_INTERVAL_HOURS", 24);
```

Add both to the returned object.

- [ ] **Step 2: Add config tests**

In `hub/indexer/test/config.test.ts`:

```ts
it('shareSnapshotTtlDays defaults to 30', () => {
  const cfg = loadConfig({ PG_URL: 'postgres://x' });
  expect(cfg.shareSnapshotTtlDays).toBe(30);
});

it('shareCleanupIntervalHours defaults to 24 and reads env override', () => {
  const cfg = loadConfig({ PG_URL: 'postgres://x', SHARE_CLEANUP_INTERVAL_HOURS: '6' });
  expect(cfg.shareCleanupIntervalHours).toBe(6);
});
```

- [ ] **Step 3: Write the cleanup module**

Create `hub/indexer/src/share-cleanup.ts`:

```ts
// Periodic cleanup of expired share-snapshot tarballs.
//
// Today: every share_request row that has been decided keeps its tarball at
// <shareSnapshotsDir>/<share_id>.tar.gz forever. The spec (§4.1) calls for
// 30-day retention from decided_at; this module enforces it.
//
// Idempotent by file-existence: if the tarball is already gone (re-run after
// crash, manual cleanup, etc.) we count it as `missing` and continue. The
// share_requests rows themselves are NEVER touched — they remain queryable
// for forensics; only the bulky tarball blob is reaped.

import { unlink } from "node:fs/promises";
import * as path from "node:path";
import type { Pool } from "pg";

export interface CleanupArgs {
  pool:          Pool;
  snapshotsDir:  string;
  ttlDays:       number;
}

export interface CleanupResult {
  scanned: number;     // rows matching the cutoff
  deleted: number;     // tarballs successfully unlinked
  missing: number;     // tarball file already gone
  errors:  number;     // unlink failures (logged, not thrown)
}

export async function cleanupOldSnapshots(args: CleanupArgs): Promise<CleanupResult> {
  // Skill + folder are the only kinds with on-disk tarballs.
  // Pending rows are excluded by the decided_at IS NOT NULL filter.
  const rows = await args.pool.query<{ share_id: string }>(
    `SELECT share_id FROM share_requests
      WHERE artifact_kind IN ('skill', 'folder')
        AND decided_at IS NOT NULL
        AND decided_at < now() - ($1 || ' days')::interval`,
    [args.ttlDays],
  );

  const result: CleanupResult = {
    scanned: rows.rowCount ?? 0,
    deleted: 0,
    missing: 0,
    errors:  0,
  };

  for (const { share_id } of rows.rows) {
    const tarPath = path.join(args.snapshotsDir, `${share_id}.tar.gz`);
    try {
      await unlink(tarPath);
      result.deleted += 1;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        result.missing += 1;
      } else {
        result.errors += 1;
      }
    }
  }

  return result;
}
```

- [ ] **Step 4: Write the tests**

Create `hub/indexer/test/share-cleanup.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { cleanupOldSnapshots } from "../src/share-cleanup.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("cleanupOldSnapshots", () => {
  let pgc: StartedPostgreSqlContainer;
  let pool: Pool;
  let snapshotsDir: string;

  beforeAll(async () => {
    pgc  = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    pool = new Pool({ connectionString: pgc.getConnectionUri() });
    await runMigrations({
      pool,
      migrationsDir: path.resolve(HERE, "..", "migrations"),
      lockKey:       0xdeadbeefn,
    });
  }, 60_000);

  afterAll(async () => { await pool.end(); await pgc.stop(); });

  beforeEach(async () => {
    snapshotsDir = await mkdtemp(path.join(tmpdir(), "snap-cleanup-"));
    await pool.query(`DELETE FROM share_requests`);
  });

  /** Helper: insert a share_requests row with a given decided_at and matching tarball file. */
  async function seedRow(opts: {
    kind: 'skill' | 'folder' | 'memory';
    decidedDaysAgo: number | null;     // null = still pending
    withTarball: boolean;              // if true, create the .tar.gz on disk
  }): Promise<string> {
    const r = await pool.query<{ share_id: string }>(
      `INSERT INTO share_requests
         (artifact_kind, artifact_ref, snapshot_meta, requester, reviewer,
          status, decided_at)
       VALUES ($1, 'x', '{}', 'alice', 'li86', $2,
               $3::int IS NULL
                 ? NULL
                 : (now() - ($3 || ' days')::interval))
       RETURNING share_id`,
      [opts.kind, opts.decidedDaysAgo === null ? 'pending' : 'approved',
       opts.decidedDaysAgo],
    );
    const id = r.rows[0]!.share_id;
    if (opts.withTarball) {
      await writeFile(path.join(snapshotsDir, `${id}.tar.gz`), "stub");
    }
    return id;
  }

  it("deletes tarballs whose row was decided > ttl days ago", async () => {
    const oldId = await seedRow({ kind: 'skill', decidedDaysAgo: 31, withTarball: true });
    const r = await cleanupOldSnapshots({ pool, snapshotsDir, ttlDays: 30 });
    expect(r).toEqual({ scanned: 1, deleted: 1, missing: 0, errors: 0 });
    await expect(access(path.join(snapshotsDir, `${oldId}.tar.gz`))).rejects.toThrow();
  });

  it("leaves tarballs whose row was decided <= ttl days ago", async () => {
    const youngId = await seedRow({ kind: 'skill', decidedDaysAgo: 29, withTarball: true });
    const r = await cleanupOldSnapshots({ pool, snapshotsDir, ttlDays: 30 });
    expect(r).toEqual({ scanned: 0, deleted: 0, missing: 0, errors: 0 });
    await expect(access(path.join(snapshotsDir, `${youngId}.tar.gz`))).resolves.toBeUndefined();
  });

  it("leaves tarballs of pending requests regardless of age", async () => {
    // Pending row has decided_at = NULL; the SQL filter excludes it.
    const pendingId = await seedRow({ kind: 'skill', decidedDaysAgo: null, withTarball: true });
    const r = await cleanupOldSnapshots({ pool, snapshotsDir, ttlDays: 30 });
    expect(r.scanned).toBe(0);
    await expect(access(path.join(snapshotsDir, `${pendingId}.tar.gz`))).resolves.toBeUndefined();
  });

  it("ignores memory rows (no tarball ever existed)", async () => {
    await seedRow({ kind: 'memory', decidedDaysAgo: 100, withTarball: false });
    const r = await cleanupOldSnapshots({ pool, snapshotsDir, ttlDays: 30 });
    expect(r.scanned).toBe(0);   // filtered at SQL by artifact_kind
  });

  it("counts already-missing tarballs separately from errors", async () => {
    await seedRow({ kind: 'skill', decidedDaysAgo: 60, withTarball: false });
    const r = await cleanupOldSnapshots({ pool, snapshotsDir, ttlDays: 30 });
    expect(r).toEqual({ scanned: 1, deleted: 0, missing: 1, errors: 0 });
  });

  it("processes a mix correctly", async () => {
    await seedRow({ kind: 'skill',  decidedDaysAgo: 90, withTarball: true });   // delete
    await seedRow({ kind: 'folder', decidedDaysAgo: 45, withTarball: true });   // delete
    await seedRow({ kind: 'skill',  decidedDaysAgo: 10, withTarball: true });   // keep
    await seedRow({ kind: 'skill',  decidedDaysAgo: 50, withTarball: false });  // missing
    await seedRow({ kind: 'memory', decidedDaysAgo: 50, withTarball: false });  // ignored
    await seedRow({ kind: 'skill',  decidedDaysAgo: null, withTarball: true }); // pending — keep

    const r = await cleanupOldSnapshots({ pool, snapshotsDir, ttlDays: 30 });
    expect(r).toEqual({ scanned: 3, deleted: 2, missing: 1, errors: 0 });
  });
});
```

Note: the `seedRow` helper's SQL ternary won't actually work in Postgres — rewrite to use CASE or build the value in JS first. Adjusted seed helper:

```ts
async function seedRow(opts: { kind: 'skill' | 'folder' | 'memory';
                               decidedDaysAgo: number | null;
                               withTarball: boolean; }): Promise<string> {
  const decidedAt = opts.decidedDaysAgo === null
    ? null
    : new Date(Date.now() - opts.decidedDaysAgo * 24 * 60 * 60 * 1000);
  const status = decidedAt === null ? 'pending' : 'approved';
  const r = await pool.query<{ share_id: string }>(
    `INSERT INTO share_requests
       (artifact_kind, artifact_ref, snapshot_meta, requester, reviewer,
        status, decided_at)
     VALUES ($1, 'x', '{}', 'alice', 'li86', $2, $3)
     RETURNING share_id`,
    [opts.kind, status, decidedAt],
  );
  const id = r.rows[0]!.share_id;
  if (opts.withTarball) {
    await writeFile(path.join(snapshotsDir, `${id}.tar.gz`), "stub");
  }
  return id;
}
```

(Drop the ternary-in-SQL version above; use this clean JS-side construction.)

- [ ] **Step 5: Add compose env**

In `hub/docker-compose.yml` under the `indexer:` `environment:` block:

```yaml
      SHARE_SNAPSHOT_TTL_DAYS: "30"
      SHARE_CLEANUP_INTERVAL_HOURS: "24"
```

- [ ] **Step 6: Run tests**

```
cd /home/lili/claude-bioflow/hub/indexer && npm test -- config share-cleanup
```

Expected: 2 new config tests + 6 new share-cleanup tests pass.

- [ ] **Step 7: Commit**

```
git add hub/indexer/src/config.ts hub/indexer/test/config.test.ts \
        hub/indexer/src/share-cleanup.ts hub/indexer/test/share-cleanup.test.ts \
        hub/docker-compose.yml
git commit -m "feat(indexer): cleanupOldSnapshots — 30-day TTL on share tarballs"
```

No `Co-Authored-By` trailer.

---

## Task 2: Wire cleanup loop into indexer boot

**Files:**
- Modify: `hub/indexer/src/index.ts`

- [ ] **Step 1: Add the cleanup loop function**

In `hub/indexer/src/index.ts`, after the `startEmbedderLoop` definition and call, add:

```ts
import { cleanupOldSnapshots } from "./share-cleanup.js";

// ... existing code ...

const startCleanupLoop = (): void => {
  const intervalMs = cfg.shareCleanupIntervalHours * 60 * 60 * 1000;
  const tick = async (): Promise<void> => {
    try {
      const result = await cleanupOldSnapshots({
        pool,
        snapshotsDir: cfg.shareSnapshotsDir,
        ttlDays:      cfg.shareSnapshotTtlDays,
      });
      if (result.scanned > 0) {
        logger.info({ result }, "share snapshot cleanup pass");
      }
    } catch (err) {
      logger.error({ err }, "share snapshot cleanup crashed");
    } finally {
      setTimeout(tick, intervalMs);
    }
  };
  // Boot-time pass after a brief delay so the rest of startup logs are clean.
  setTimeout(tick, 5_000);
};

startCleanupLoop();
```

(Place the import at the top with the other imports. Place the `startCleanupLoop` block right after `startEmbedderLoop()` is called.)

- [ ] **Step 2: Smoke test against a real container**

```
cd /home/lili/claude-bioflow/hub
docker compose build indexer
docker compose up -d indexer
sleep 8
docker logs claude-bioflow-indexer 2>&1 | grep -iE "cleanup|snapshot|listening" | tail -10
```

Expected: indexer boots cleanly. If there are decided share requests already in the DB and the cleanup loop's first pass produces a non-zero `scanned`, you'll see a log line; otherwise the silent path is correct.

- [ ] **Step 3: Verify the cron runs (optional manual probe)**

To prove the loop fires without waiting 24 hours, you can briefly set the interval to 1 hour via env, restart, observe, then revert:

```
docker exec claude-bioflow-indexer printenv SHARE_CLEANUP_INTERVAL_HOURS
# expect: 24
```

Skip if you trust the timer code — the test in Task 1 already exercises `cleanupOldSnapshots`; this only verifies the wiring.

- [ ] **Step 4: Commit**

```
git add hub/indexer/src/index.ts
git commit -m "feat(indexer): start share snapshot cleanup loop at boot"
```

No `Co-Authored-By` trailer.

---

## Final review

- [ ] Full indexer test suite: `cd /home/lili/claude-bioflow/hub/indexer && npm test`. Expect 327 + 8 new = 335 passing.
- [ ] Live smoke: bring up the stack; confirm indexer boots cleanly with the new loop. The cleanup runs ~5s after boot (silent if nothing to clean).
- [ ] No frontend or adapter changes — those test suites are untouched.
- [ ] If desired, manually verify a real cleanup: pick an approved share with `decided_at` past 30 days (or temporarily set `SHARE_SNAPSHOT_TTL_DAYS: "0"` in compose, restart indexer, watch the next log line, then revert TTL).

When green: merge to main like phases 2/3.

---

## Appendix: rough timing

| Task | Est | Notes |
|---|---:|---|
| 1 config + module + tests | 1h | one new file, 6 tests, one compose edit |
| 2 boot wiring + smoke | 30m | one function in index.ts, manual log check |

Total: ~1.5 hours. Small slice, isolated module, no schema changes.
