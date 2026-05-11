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
  if (!Number.isInteger(args.ttlDays) || args.ttlDays < 1) {
    throw new RangeError(`ttlDays must be a positive integer, got ${args.ttlDays}`);
  }
  // Skill + folder are the only kinds with on-disk tarballs.
  // Pending rows are excluded by the decided_at IS NOT NULL filter.
  const rows = await args.pool.query<{ share_id: string }>(
    `SELECT share_id FROM share_requests
      WHERE artifact_kind IN ('skill', 'folder')
        AND decided_at IS NOT NULL
        AND decided_at < now() - make_interval(days => $1)`,
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
