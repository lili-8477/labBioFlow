import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { stat } from "node:fs/promises";
import {
  safeJoin,
  walkSkillFiles,
  readFolderReadme,
  packSkillTarball,
  extractSkillTarball,
} from "./share-fs.js";
import type { SubmitArgs, SubmitResult, ShareRow } from "./share-repo.js";

export async function submitFolderShareRequest(args: SubmitArgs): Promise<SubmitResult> {
  // Resolve <workspaces>/<requester>/local_projects/<ref>; reject traversal.
  const userProjectsRoot = path.join(args.workspacesRoot, args.requester, "local_projects");
  const resolved = safeJoin(userProjectsRoot, args.ref);
  if (resolved === null) {
    return { ok: false, reason: "invalid_ref" };
  }

  // TOCTOU note: stat → walk → pack are not atomic. Single-tenant container
  // model — acceptable. See same note in submitSkillShareRequest.
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

  // walkSkillFiles is named historically — it is kind-agnostic. Walks the
  // tree, hashes contents, returns sorted entries with size_bytes.
  const files = await walkSkillFiles(resolved);
  const total_bytes = files.reduce((n, f) => n + f.size_bytes, 0);
  if (total_bytes > args.maxFolderBytes) {
    return {
      ok: false,
      reason: "oversize",
      detail: `folder total ${total_bytes} bytes exceeds cap ${args.maxFolderBytes}`,
    };
  }

  const readme = await readFolderReadme(resolved);

  const share_id = randomUUID();
  const tarPath = path.join(args.shareSnapshotsDir, `${share_id}.tar.gz`);
  try {
    await packSkillTarball({ skillDir: resolved, destTar: tarPath });
  } catch (e) {
    return { ok: false, reason: "snapshot_failed", detail: (e as Error).message };
  }

  const snapshot_meta: Record<string, unknown> = {
    root_name: path.basename(resolved),
    readme,             // null when no README.md at top level
    files,
    total_bytes,
  };

  await args.pool.query(
    `INSERT INTO share_requests
       (share_id, artifact_kind, artifact_ref, snapshot_meta,
        requester, reviewer, requester_note)
     VALUES ($1, 'folder', $2, $3, $4, $5, $6)`,
    [share_id, args.ref, snapshot_meta, args.requester, args.managers[0], args.note ?? null],
  );
  return { ok: true, share_id };
}

export async function approveFolderShareRequest(args: {
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
    !Array.isArray(meta.files) ||
    typeof meta.total_bytes !== "number"
  ) {
    return { ok: false, reason: "promotion_failed",
             detail: "snapshot_meta missing root_name/files/total_bytes" };
  }
  const rootName = meta.root_name;

  // Defence-in-depth: root_name was basename()'d at submit, but validate again.
  const sharedProjects = path.join(args.workspacesRoot, "shared", "projects");
  const destDir = safeJoin(sharedProjects, rootName);
  if (destDir === null) {
    return { ok: false, reason: "promotion_failed", detail: "snapshot root_name is invalid" };
  }

  // Collision check — same rule as skill: any existing path is a collision.
  try {
    await stat(destDir);
    return {
      ok: false, reason: "collision",
      detail: `shared/projects/${rootName} already exists`,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const tarPath = path.join(args.shareSnapshotsDir, `${row.share_id}.tar.gz`);
  let written: string[];
  try {
    written = await extractSkillTarball({ srcTar: tarPath, destParent: sharedProjects });
  } catch (e) {
    return { ok: false, reason: "promotion_failed",
             detail: `untar failed: ${(e as Error).message}` };
  }

  return {
    ok: true,
    promotion_result: {
      dest_path:    destDir,
      copied_files: written,
      total_bytes:  meta.total_bytes,
    },
  };
}
