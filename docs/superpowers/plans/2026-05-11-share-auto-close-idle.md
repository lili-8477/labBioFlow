# Share-promotion — auto-close-on-idle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the inbox from accumulating abandoned pending requests. A `pending` row whose `created_at` is older than `SHARE_AUTO_CLOSE_IDLE_DAYS` (default 30) gets automatically transitioned to a new terminal status `auto_rejected`. Manager inboxes stay focused on live work; abandoned submissions don't haunt the queue.

**Architecture:**

1. **New terminal status `auto_rejected`** (migration 0011 updates the CHECK constraint). Distinct from manual `rejected` so analytics / forensics / UI can tell the difference: an auto-close is the *reviewer* failing (timed out reviewing), not the requester (who got a "no" with a comment). Spec §13 #3 explicitly mentioned this status in the deferred design.

2. **New helper `autoCloseIdleRequests({ pool, idleDays })`** in `share-cleanup.ts` (alongside `cleanupOldSnapshots` — both are periodic share_requests maintenance, same logical home). Runs one UPDATE: `pending` rows with `created_at < now() - idleDays days` → `status='auto_rejected'`, `decided_at=now()`, `review_comment='auto-rejected after N days idle'`. Returns `{ closed }`.

3. **New cron loop `startAutoCloseLoop`** in `index.ts` mirroring the existing `startCleanupLoop` and `startEmbedderLoop` patterns. Interval defaults to 24h; configurable.

4. **Frontend `ShareStatus` extended** with `'auto_rejected'`. Status-class map + Zod enum on the indexer's list query also extended. New CSS pill style — same tone as `rejected` but slightly muted to distinguish.

5. **No effect on snapshot cleanup.** An `auto_rejected` row has `decided_at` set, so `cleanupOldSnapshots` (TTL 30d post-decision) picks up its tarball on the same trajectory as any other terminal row. A stale request thus has a 60-day total lifecycle by default: 30 days idle → auto_rejected → 30 days post-decision → tarball deleted. Operator can tune via the two env vars.

**Spec:** `docs/superpowers/specs/2026-05-07-share-promotion.md` §13 #3 ("Auto-rejection on idle is the conceptually correct framing... Defer to v2 if the queue actually gets stale"). This slice is that deferred v2.

**Out of scope:**
- A manual "extend" verb to bump `created_at` and dodge auto-close. Operators can adjust the env var if they want a longer window.
- Notifications to the requester when their submission is auto-rejected. The Outbox view shows the status change next time they look.
- Per-kind idle thresholds (memory vs skill vs folder). Uniform threshold for v1.
- Touching the existing `rejected`, `approved`, `withdrawn` statuses or their semantics.

---

## File Structure

**Created:**
- `hub/indexer/migrations/0011_share_status_auto_rejected.sql` — drop the status CHECK constraint, re-add with `auto_rejected` included.
- `hub/indexer/test/migrations-0011-smoke.test.ts` — testcontainers, asserts the new constraint accepts the new value and rejects garbage.

**Modified:**
- `hub/indexer/src/share-cleanup.ts` — add `autoCloseIdleRequests({pool, idleDays})` alongside the existing `cleanupOldSnapshots`. Same module — both are periodic maintenance.
- `hub/indexer/test/share-cleanup.test.ts` — extend with a new `describe("autoCloseIdleRequests", ...)` block.
- `hub/indexer/src/share-repo.ts` — extend `ShareStatus` union with `'auto_rejected'`.
- `hub/indexer/src/share-api.ts` — extend the Zod enum on the list-query `status` param.
- `hub/indexer/src/config.ts` — add `shareAutoCloseIdleDays: number` and `shareAutoCloseIntervalHours: number`.
- `hub/indexer/test/config.test.ts` — 2 tests.
- `hub/indexer/src/index.ts` — start a `startAutoCloseLoop` mirror of `startCleanupLoop`.
- `hub/docker-compose.yml` — `SHARE_AUTO_CLOSE_IDLE_DAYS: "30"` and `SHARE_AUTO_CLOSE_INTERVAL_HOURS: "24"`.
- `frontend/src/types/share.ts` — extend `ShareStatus`.
- `frontend/src/components/share/ShareList.vue` — extend the status-class map + add CSS pill.
- `frontend/src/components/share/ShareDetail.vue` — add the matching CSS pill (same .status-auto_rejected class).

---

## Task 1: Migration 0011 + `autoCloseIdleRequests` helper + tests

**Files:**
- Create: `hub/indexer/migrations/0011_share_status_auto_rejected.sql`
- Create: `hub/indexer/test/migrations-0011-smoke.test.ts`
- Modify: `hub/indexer/src/share-repo.ts`
- Modify: `hub/indexer/src/share-cleanup.ts`
- Modify: `hub/indexer/test/share-cleanup.test.ts`
- Modify: `hub/indexer/src/share-api.ts`

- [ ] **Step 1: Write the migration**

`hub/indexer/migrations/0011_share_status_auto_rejected.sql`:

```sql
-- 0011_share_status_auto_rejected.sql
-- Add 'auto_rejected' to share_requests.status. Distinct from manual 'rejected'
-- so we can tell apart "reviewer rejected with comment" from "request aged out
-- without review". See phase-4 auto-close-on-idle plan.

ALTER TABLE share_requests
  DROP CONSTRAINT share_requests_status_check;

ALTER TABLE share_requests
  ADD CONSTRAINT share_requests_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'auto_rejected'));
```

- [ ] **Step 2: Write the migration smoke test**

`hub/indexer/test/migrations-0011-smoke.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('migration 0011 share status auto_rejected', () => {
  let pgc: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    pgc = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = new Pool({ connectionString: pgc.getConnectionUri() });
    await runMigrations({
      pool,
      migrationsDir: path.resolve(HERE, '..', 'migrations'),
      lockKey: 0xdeadbeefn,
    });
  }, 60_000);
  afterAll(async () => { await pool.end(); await pgc.stop(); });

  it('accepts auto_rejected status', async () => {
    const r = await pool.query(
      `INSERT INTO share_requests (artifact_kind, artifact_ref, snapshot_meta,
                                   requester, reviewer, status)
       VALUES ('memory', 'x', '{}'::jsonb, 'alice', 'li86', 'auto_rejected')
       RETURNING share_id`,
    );
    expect(r.rowCount).toBe(1);
  });

  it('still rejects garbage status', async () => {
    await expect(pool.query(
      `INSERT INTO share_requests (artifact_kind, artifact_ref, snapshot_meta,
                                   requester, reviewer, status)
       VALUES ('memory', 'x', '{}'::jsonb, 'alice', 'li86', 'never-heard-of-it')`,
    )).rejects.toThrow(/share_requests_status_check/);
  });
});
```

- [ ] **Step 3: Extend `ShareStatus` type and the list-query Zod enum**

In `hub/indexer/src/share-repo.ts`, find:

```ts
export type ShareStatus = "pending" | "approved" | "rejected" | "withdrawn";
```

Replace with:

```ts
export type ShareStatus = "pending" | "approved" | "rejected" | "withdrawn" | "auto_rejected";
```

In `hub/indexer/src/share-api.ts`, find the Zod enum for the list query `status`:

```ts
status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).optional(),
```

Replace with:

```ts
status: z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'auto_rejected']).optional(),
```

- [ ] **Step 4: Add `autoCloseIdleRequests` to `share-cleanup.ts`**

In `hub/indexer/src/share-cleanup.ts`, append after `cleanupOldSnapshots`:

```ts
export interface AutoCloseArgs {
  pool:      Pool;
  idleDays:  number;
}

export interface AutoCloseResult {
  closed: number;     // rows transitioned pending → auto_rejected
}

/** Transition pending share_requests rows older than `idleDays` to status
 *  'auto_rejected'. Stamps decided_at + review_comment for forensic clarity.
 *  Idempotent: re-running picks up nothing because previously-closed rows
 *  have status != 'pending'. */
export async function autoCloseIdleRequests(args: AutoCloseArgs): Promise<AutoCloseResult> {
  if (!Number.isInteger(args.idleDays) || args.idleDays < 1) {
    throw new RangeError(`idleDays must be a positive integer, got ${args.idleDays}`);
  }

  const comment = `auto-rejected after ${args.idleDays} days idle`;
  const r = await args.pool.query(
    `UPDATE share_requests
        SET status = 'auto_rejected',
            decided_at = now(),
            review_comment = $1
      WHERE status = 'pending'
        AND created_at < now() - make_interval(days => $2)`,
    [comment, args.idleDays],
  );

  return { closed: r.rowCount ?? 0 };
}
```

- [ ] **Step 5: Add tests for `autoCloseIdleRequests`**

In `hub/indexer/test/share-cleanup.test.ts`, ADD a new `describe("autoCloseIdleRequests", ...)` block AFTER the existing `cleanupOldSnapshots` block. Reuse the same `pgc`/`pool` fixture:

```ts
import { autoCloseIdleRequests } from "../src/share-cleanup.js";

describe("autoCloseIdleRequests", () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM share_requests`);
  });

  /** Insert a row with a given created_at and status. */
  async function seedRow(opts: {
    status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'auto_rejected';
    createdDaysAgo: number;
  }): Promise<string> {
    const createdAt = new Date(Date.now() - opts.createdDaysAgo * 24 * 60 * 60 * 1000);
    const decidedAt = opts.status === 'pending' ? null : createdAt;
    const r = await pool.query<{ share_id: string }>(
      `INSERT INTO share_requests
         (artifact_kind, artifact_ref, snapshot_meta, requester, reviewer,
          status, created_at, decided_at)
       VALUES ('memory', 'x', '{}', 'alice', 'li86', $1, $2, $3)
       RETURNING share_id`,
      [opts.status, createdAt, decidedAt],
    );
    return r.rows[0]!.share_id;
  }

  it("closes pending rows older than idleDays", async () => {
    const oldId = await seedRow({ status: 'pending', createdDaysAgo: 35 });
    const r = await autoCloseIdleRequests({ pool, idleDays: 30 });
    expect(r).toEqual({ closed: 1 });

    const after = await pool.query<{ status: string; decided_at: Date; review_comment: string }>(
      `SELECT status, decided_at, review_comment FROM share_requests WHERE share_id=$1`,
      [oldId],
    );
    const row = after.rows[0]!;
    expect(row.status).toBe('auto_rejected');
    expect(row.decided_at).not.toBeNull();
    expect(row.review_comment).toMatch(/auto-rejected after 30 days idle/);
  });

  it("leaves pending rows younger than idleDays", async () => {
    const youngId = await seedRow({ status: 'pending', createdDaysAgo: 10 });
    const r = await autoCloseIdleRequests({ pool, idleDays: 30 });
    expect(r).toEqual({ closed: 0 });

    const after = await pool.query<{ status: string }>(
      `SELECT status FROM share_requests WHERE share_id=$1`, [youngId]);
    expect(after.rows[0]!.status).toBe('pending');
  });

  it("ignores non-pending rows regardless of age", async () => {
    await seedRow({ status: 'approved',    createdDaysAgo: 100 });
    await seedRow({ status: 'rejected',    createdDaysAgo: 100 });
    await seedRow({ status: 'withdrawn',   createdDaysAgo: 100 });
    await seedRow({ status: 'auto_rejected', createdDaysAgo: 100 });
    const r = await autoCloseIdleRequests({ pool, idleDays: 30 });
    expect(r.closed).toBe(0);
  });

  it("is idempotent — re-running closes zero", async () => {
    await seedRow({ status: 'pending', createdDaysAgo: 60 });
    const first = await autoCloseIdleRequests({ pool, idleDays: 30 });
    expect(first.closed).toBe(1);
    const second = await autoCloseIdleRequests({ pool, idleDays: 30 });
    expect(second.closed).toBe(0);
  });

  it("throws RangeError for idleDays < 1", async () => {
    await expect(autoCloseIdleRequests({ pool, idleDays: 0 }))
      .rejects.toThrow(RangeError);
    await expect(autoCloseIdleRequests({ pool, idleDays: -5 }))
      .rejects.toThrow(/positive integer/);
  });
});
```

- [ ] **Step 6: Run tests**

```
cd /home/lili/claude-bioflow/hub/indexer && npm test -- migrations-0011 share-cleanup
```

Expected: 2 new migration-0011 tests pass + 5 new auto-close tests pass + 8 existing share-cleanup tests still pass.

- [ ] **Step 7: Commit**

```
git -C /home/lili/claude-bioflow add \
  hub/indexer/migrations/0011_share_status_auto_rejected.sql \
  hub/indexer/test/migrations-0011-smoke.test.ts \
  hub/indexer/src/share-repo.ts \
  hub/indexer/src/share-cleanup.ts \
  hub/indexer/test/share-cleanup.test.ts \
  hub/indexer/src/share-api.ts
git -C /home/lili/claude-bioflow commit -m "feat(indexer): auto_rejected status + autoCloseIdleRequests helper"
```

No `Co-Authored-By` trailer.

---

## Task 2: Config + boot wiring (`startAutoCloseLoop`)

**Files:**
- Modify: `hub/indexer/src/config.ts`
- Modify: `hub/indexer/test/config.test.ts`
- Modify: `hub/indexer/src/index.ts`
- Modify: `hub/docker-compose.yml`

- [ ] **Step 1: Add config fields**

In `hub/indexer/src/config.ts`, alongside `shareSnapshotTtlDays` / `shareCleanupIntervalHours`:

```ts
shareAutoCloseIdleDays:       number;
shareAutoCloseIntervalHours:  number;
```

In `loadConfig()`, before the `return`:

```ts
const shareAutoCloseIdleDays      = parseIntVar(env, "SHARE_AUTO_CLOSE_IDLE_DAYS",      30);
const shareAutoCloseIntervalHours = parseIntVar(env, "SHARE_AUTO_CLOSE_INTERVAL_HOURS", 24);
```

Add both to the returned object.

- [ ] **Step 2: Add config tests**

In `hub/indexer/test/config.test.ts`:

```ts
it('shareAutoCloseIdleDays defaults to 30', () => {
  const cfg = loadConfig({ PG_URL: 'postgres://x' });
  expect(cfg.shareAutoCloseIdleDays).toBe(30);
});

it('shareAutoCloseIntervalHours reads SHARE_AUTO_CLOSE_INTERVAL_HOURS env override', () => {
  const cfg = loadConfig({ PG_URL: 'postgres://x', SHARE_AUTO_CLOSE_INTERVAL_HOURS: '6' });
  expect(cfg.shareAutoCloseIntervalHours).toBe(6);
});
```

- [ ] **Step 3: Add the boot loop**

In `hub/indexer/src/index.ts`:

(a) Import the new helper:

```ts
import { cleanupOldSnapshots, autoCloseIdleRequests } from "./share-cleanup.js";
```

(b) After the `startCleanupLoop()` call, add a parallel `startAutoCloseLoop`:

```ts
const startAutoCloseLoop = (): void => {
  const intervalMs = cfg.shareAutoCloseIntervalHours * 60 * 60 * 1000;
  const tick = async (): Promise<void> => {
    try {
      const result = await autoCloseIdleRequests({
        pool,
        idleDays: cfg.shareAutoCloseIdleDays,
      });
      if (result.closed > 0) {
        logger.info({ result }, "share auto-close pass");
      }
    } catch (err) {
      logger.error({ err }, "share auto-close crashed");
    } finally {
      setTimeout(tick, intervalMs);
    }
  };
  setTimeout(tick, 5_000);   // boot-time pass after a brief delay
};

startAutoCloseLoop();
```

- [ ] **Step 4: Add compose env**

In `hub/docker-compose.yml` under the `indexer:` `environment:` block:

```yaml
      SHARE_AUTO_CLOSE_IDLE_DAYS: "30"
      SHARE_AUTO_CLOSE_INTERVAL_HOURS: "24"
```

- [ ] **Step 5: Run tests + smoke**

```
cd /home/lili/claude-bioflow/hub/indexer && npm test -- config
cd /home/lili/claude-bioflow/hub && docker compose build indexer && docker compose up -d indexer
sleep 8
docker logs claude-bioflow-indexer 2>&1 | grep -iE "listening|auto-close|cleanup|share|error" | tail -15
```

Expected: config tests pass; indexer boots cleanly; boot-time auto-close pass fires after 5s (silent if no rows match — which is the case on a fresh stack).

- [ ] **Step 6: Commit**

```
git -C /home/lili/claude-bioflow add \
  hub/indexer/src/config.ts \
  hub/indexer/test/config.test.ts \
  hub/indexer/src/index.ts \
  hub/docker-compose.yml
git -C /home/lili/claude-bioflow commit -m "feat(indexer): start auto-close-idle loop at boot"
```

No `Co-Authored-By` trailer.

---

## Task 3: Frontend — extend `ShareStatus`, status pill CSS

**Files:**
- Modify: `frontend/src/types/share.ts`
- Modify: `frontend/src/components/share/ShareList.vue`
- Modify: `frontend/src/components/share/ShareDetail.vue`

- [ ] **Step 1: Extend the type**

In `frontend/src/types/share.ts`, change:

```ts
export type ShareStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';
```

to:

```ts
export type ShareStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'auto_rejected';
```

- [ ] **Step 2: Extend the status-class map in `ShareList.vue`**

In `frontend/src/components/share/ShareList.vue`, the `statusClass` function uses a `Record<ShareStatus, string>` which becomes a compile error after Step 1 if the new key isn't added. Add the mapping:

```ts
function statusClass(status: ShareStatus): string {
  const map: Record<ShareStatus, string> = {
    pending: 'status-pending',
    approved: 'status-approved',
    rejected: 'status-rejected',
    withdrawn: 'status-withdrawn',
    auto_rejected: 'status-auto-rejected',
  }
  return map[status]
}
```

(Use `status-auto-rejected` — hyphen — as the CSS class name. The TS enum value uses an underscore; the CSS class converts to hyphen for readability.)

In the `<style scoped>` block of `ShareList.vue` (around line 202), find the existing status-color block:

```css
.status-pending   { background: var(--accent-soft);   color: var(--accent); }
.status-approved  { background: var(--success-soft);  color: var(--success); }
.status-rejected  { background: var(--danger-soft);   color: var(--danger); }
.status-withdrawn { background: var(--bg-tertiary);   color: var(--text-muted); }
```

Add below them:

```css
.status-auto-rejected { background: var(--bg-tertiary); color: var(--text-muted);
                        font-style: italic; }
```

(Same muted appearance as `withdrawn`, with italic to distinguish "the system closed this" from "the requester withdrew it". Both are terminal-and-uneventful states.)

- [ ] **Step 3: Mirror the CSS pill in `ShareDetail.vue`**

`frontend/src/components/share/ShareDetail.vue` has a parallel status-color block in its own `<style scoped>` (around line 328). Find:

```css
.status-pending   { background: var(--accent-soft);   color: var(--accent); }
.status-approved  { background: var(--success-soft);  color: var(--success); }
.status-rejected  { background: var(--danger-soft);   color: var(--danger); }
.status-withdrawn { background: var(--bg-tertiary);   color: var(--text-muted); }
```

Add:

```css
.status-auto-rejected { background: var(--bg-tertiary); color: var(--text-muted);
                        font-style: italic; }
```

Note: `ShareDetail.vue` derives its status pill class from the template using `:class="\`status-${store.selected.status}\`"`. Since the underscore in `auto_rejected` doesn't match the CSS class with the hyphen, you also need to adapt the template OR keep the class match. Two options:

(a) Add a status-class computed in `ShareDetail.vue`'s `<script setup>` that handles the underscore→hyphen translation:

```ts
const statusClass = computed(() => {
  if (!store.selected) return ''
  return 'status-' + store.selected.status.replace(/_/g, '-')
})
```

And in the template, change `:class="\`status-${store.selected.status}\`"` to `:class="statusClass"`.

(b) Or use an underscored CSS class `status-auto_rejected` (CSS allows underscores). Simpler — no script change, no computed. The class name just stays consistent with the TS enum.

GO WITH (b). It's strictly less code. Replace the CSS rule add to use the underscored form:

```css
.status-auto_rejected { background: var(--bg-tertiary); color: var(--text-muted);
                        font-style: italic; }
```

In `ShareList.vue`'s status-class map, change the value to match: `auto_rejected: 'status-auto_rejected'` (underscore).

In `ShareList.vue`'s CSS block, same underscore: `.status-auto_rejected { ... }`.

- [ ] **Step 4: Build clean**

```
cd /home/lili/claude-bioflow/frontend && npm run build
```

Expected: clean build, no TS errors (including the previously-strict `Record<ShareStatus, string>` exhaustiveness check).

- [ ] **Step 5: Commit**

```
git -C /home/lili/claude-bioflow add \
  frontend/src/types/share.ts \
  frontend/src/components/share/ShareList.vue \
  frontend/src/components/share/ShareDetail.vue
git -C /home/lili/claude-bioflow commit -m "feat(frontend): show auto_rejected status in share panel"
```

No `Co-Authored-By` trailer.

---

## Final review

- [ ] Full indexer test suite: `cd /home/lili/claude-bioflow/hub/indexer && npm test`. Expect 346 + 9 new = 355 passing (2 migration + 5 auto-close + 2 config).
- [ ] Frontend build clean.
- [ ] Live indexer running with the new loop active (Task 2 Step 5 confirmed this).
- [ ] Optional manual test: temporarily set `SHARE_AUTO_CLOSE_IDLE_DAYS: "0"` and recreate the indexer. The next loop pass will auto-close every pending request older than 0 days (i.e., all pending). Watch the log for `share auto-close pass`. Then revert.

When green: merge to main, rebuild indexer image, recreate the container.

---

## Appendix: rough timing

| Task | Est | Notes |
|---|---:|---|
| 1 migration + function + tests | 1h | 6 files, 7 new tests |
| 2 config + boot wiring + smoke | 30m | 4 files, mechanical mirror of cleanup loop |
| 3 frontend | 20m | 3 files, type + 2 CSS rules |

Total: ~2 hours. Smaller than multi-manager because there's no mass-rename — just additions.
