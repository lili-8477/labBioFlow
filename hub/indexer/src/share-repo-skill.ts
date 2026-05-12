import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { stat } from "node:fs/promises";
import {
  safeJoin,
  walkSkillFiles,
  readSkillManifest,
  packSkillTarball,
  extractSkillTarball,
} from "./share-fs.js";
import type { SubmitArgs, SubmitResult, ShareRow, DecideResult } from "./share-repo.js";

export async function submitSkillShareRequest(args: SubmitArgs): Promise<SubmitResult> {
  // Resolve <workspaces>/<requester>/.claude/skills/<ref>; reject traversal.
  const userSkillsRoot = path.join(args.workspacesRoot, args.requester, ".claude", "skills");
  const resolved = safeJoin(userSkillsRoot, args.ref);
  if (resolved === null) {
    return { ok: false, reason: "invalid_ref" };
  }

  // TOCTOU note: stat → walk → pack are not atomic. A racing user could swap a
  // symlink mid-flight; tarball would contain the post-swap tree while files[]
  // describes the pre-swap tree. Acceptable for the single-tenant container model.
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
    [share_id, args.ref, snapshot_meta, args.requester, args.managers[0], args.note ?? null],
  );
  return { ok: true, share_id };
}

export async function submitSkillUpdateShareRequest(args: SubmitArgs): Promise<SubmitResult> {
  // Same source validation as submitSkillShareRequest.
  const userSkillsRoot = path.join(args.workspacesRoot, args.requester, ".claude", "skills");
  const resolved = safeJoin(userSkillsRoot, args.ref);
  if (resolved === null) {
    return { ok: false, reason: "invalid_ref" };
  }

  let st;
  try { st = await stat(resolved); }
  catch (e) {
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

  // The key difference from submitSkillShareRequest: target MUST already exist.
  const target = path.join(args.workspacesRoot, "shared", "skills", args.ref);
  try {
    const ts = await stat(target);
    if (!ts.isDirectory()) {
      return { ok: false, reason: "target_not_found", detail: `${target} exists but is not a directory` };
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "target_not_found", detail: `no existing org skill at shared/skills/${args.ref} — submit as kind='skill' instead` };
    }
    throw e;
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
     VALUES ($1, 'skill_update', $2, $3, $4, $5, $6)`,
    [share_id, args.ref, snapshot_meta, args.requester, args.managers[0], args.note ?? null],
  );
  return { ok: true, share_id };
}

export async function approveSkillShareRequest(args: {
  row:                ShareRow;
  workspacesRoot:     string;
  shareSnapshotsDir:  string;
}): Promise<
  | { ok: true; promotion_result: Record<string, unknown> }
  | { ok: false; reason: "promotion_failed" | "collision"; detail?: string }
> {
  const { row } = args;

  // Validate snapshot shape.
  const meta = row.snapshot_meta as Record<string, unknown>;
  if (
    typeof meta.root_name !== "string" ||
    typeof meta.manifest  !== "string" ||
    !Array.isArray(meta.files)
  ) {
    return { ok: false, reason: "promotion_failed", detail: "snapshot_meta missing root_name/manifest/files" };
  }
  const rootName = meta.root_name;

  // Refuse traversal in stored root_name (defence in depth — submit guards too).
  const sharedSkills = path.join(args.workspacesRoot, "shared", "skills");
  const destDir = safeJoin(sharedSkills, rootName);
  if (destDir === null) {
    return { ok: false, reason: "promotion_failed", detail: "snapshot root_name is invalid" };
  }

  // Collision check — anything at this path (dir, file, symlink) is a collision.
  try {
    await stat(destDir);
    return { ok: false, reason: "collision", detail: `shared/skills/${rootName} already exists` };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // ENOENT — proceed with extraction
  }

  const tarPath = path.join(args.shareSnapshotsDir, `${row.share_id}.tar.gz`);
  let written: string[];
  try {
    written = await extractSkillTarball({ srcTar: tarPath, destParent: sharedSkills });
  } catch (e) {
    return { ok: false, reason: "promotion_failed", detail: `untar failed: ${(e as Error).message}` };
  }

  const promotion_result: Record<string, unknown> = {
    dest_path:     destDir,
    copied_files:  written,
  };

  return { ok: true, promotion_result };
}
