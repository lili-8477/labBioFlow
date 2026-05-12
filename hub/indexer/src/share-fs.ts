// Pure filesystem helpers for the share-promotion skill flow.
//
// These functions never touch Postgres. They are the "trusted file ops" layer
// for snapshotting a user's skill folder and untarring it under shared/skills/.
// Path-traversal defence lives here once: callers MUST resolve refs through
// safeJoin() before passing them to anything else.

import { createHash } from "node:crypto";
import {
  createReadStream,
} from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm as rmFs,
} from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { create, extract, t, type ReadEntry } from "tar";

const IGNORE_BASENAMES = new Set([".git", "node_modules", ".DS_Store", ".venv", "__pycache__"]);

/** Joins root + ref, refuses traversal. Returns absolute resolved path or null. */
export function safeJoin(root: string, ref: string): string | null {
  if (ref.length === 0 || ref.includes("\0")) return null;
  const rootResolved = path.resolve(root);
  const target       = path.resolve(rootResolved, ref);
  // Must be under the root, not equal to it (we want a child).
  const withSep = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (!target.startsWith(withSep)) return null;
  return target;
}

export interface SkillFileEntry {
  path:       string;     // POSIX-style relative path inside the skill dir
  sha256:     string;
  size_bytes: number;
}

/** Recursively walks a skill directory, returning file entries sorted by path.
 *  Symlinks are NOT followed; broken / dir-exit symlinks are skipped. */
export async function walkSkillFiles(skillDir: string): Promise<SkillFileEntry[]> {
  const real = await realpath(skillDir);
  const entries: SkillFileEntry[] = [];
  const stack: string[] = [real];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    const items = await readdir(dir, { withFileTypes: true });
    for (const it of items) {
      if (IGNORE_BASENAMES.has(it.name)) continue;
      const abs = path.join(dir, it.name);
      // Symlink guard: lstat reports the link itself, not its target.
      // Symlinks are skipped entirely — skill folders must be self-contained.
      let st;
      try { st = await lstat(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        stack.push(abs);
      } else if (st.isFile()) {
        const rel = path.relative(real, abs).split(path.sep).join("/");
        const hash = createHash("sha256");
        await pipeline(createReadStream(abs), hash);
        entries.push({
          path:       rel,
          sha256:     hash.digest("hex"),
          size_bytes: st.size,
        });
      }
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/** Reads SKILL.md if present, returns its full text; else null. */
export async function readSkillManifest(skillDir: string): Promise<string | null> {
  try {
    return await readFile(path.join(skillDir, "SKILL.md"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Reads README.md if present, returns its full text; else null.
 *  Folder-kind analogue of readSkillManifest. README is optional — folders
 *  without one still snapshot (the file tree is the source of truth). */
export async function readFolderReadme(folderDir: string): Promise<string | null> {
  try {
    return await readFile(path.join(folderDir, "README.md"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Tar+gzip a directory into destTar. The tarball entries are stored with
 *  paths relative to the directory's PARENT, so the top-level entry is the
 *  directory name itself. (Symmetric with extractSkillTarball below which
 *  expects to land that directory under the appropriate shared/ subtree.) */
export async function packSkillTarball(opts: {
  skillDir: string;        // absolute path to the directory to pack (skills or projects)
  destTar:  string;        // /workspaces/shared/.share-snapshots/<share_id>.tar.gz
}): Promise<void> {
  const real = await realpath(opts.skillDir);
  const parent = path.dirname(real);
  const base   = path.basename(real);
  await mkdir(path.dirname(opts.destTar), { recursive: true });
  await create(
    {
      gzip:    true,
      file:    opts.destTar,
      cwd:     parent,
      filter:  (p) => {
        for (const seg of p.split(path.sep)) {
          if (IGNORE_BASENAMES.has(seg)) return false;
        }
        return true;
      },
    },
    [base],
  );
}

/** Extract a skill tarball into destParent (e.g. /workspaces/shared/skills/).
 *  Returns the list of paths actually written, relative to destParent. The
 *  caller should have already collision-checked that destParent/<name> is
 *  absent. node-tar refuses absolute paths and `..` entries by default. */
export async function extractSkillTarball(opts: {
  srcTar:     string;
  destParent: string;
}): Promise<string[]> {
  await mkdir(opts.destParent, { recursive: true });
  const written: string[] = [];
  await extract({
    file:   opts.srcTar,
    cwd:    opts.destParent,
    strict: true,
    onentry(entry: ReadEntry) {
      written.push(entry.path);
    },
  });
  return written;
}

/** Atomically replace a directory under `sharedSkillsDir` with the contents
 *  of `srcTar`. The replace is done via untar-to-sibling + rename-swap:
 *
 *    1. untar to <sharedSkillsDir>/.<name>.new.<shareId>/  (top-level becomes <name>)
 *    2. hoist its inner <name>/ contents up so .new.<shareId>/ IS the new tree
 *    3. rename <sharedSkillsDir>/<name>/ → .<name>.old.<shareId>/
 *    4. rename .<name>.new.<shareId>/   → <name>/
 *    5. rm -rf .<name>.old.<shareId>/
 *
 *  There is a brief window between steps 3 and 4 where the target name does
 *  not exist. Any read of <name> in that window gets ENOENT — acceptable
 *  for the use case (single-tenant indexer, skill files read lazily by
 *  Claude Code on tool registration).
 *
 *  On rename failure between steps 3 and 4, we best-effort restore the old
 *  directory back to its original name and rethrow. The .new dir is left
 *  in place for manual cleanup.
 *
 *  Returns the list of paths written (from extractSkillTarball's onentry). */
export async function atomicReplaceSkillDir(opts: {
  srcTar:           string;
  sharedSkillsDir:  string;
  name:             string;     // skill folder basename (caller used safeJoin)
  shareId:          string;     // for temp-dir naming
}): Promise<string[]> {
  const newDir = path.join(opts.sharedSkillsDir, `.${opts.name}.new.${opts.shareId}`);
  const oldDir = path.join(opts.sharedSkillsDir, `.${opts.name}.old.${opts.shareId}`);
  const target = path.join(opts.sharedSkillsDir, opts.name);

  // Step 1: untar to a fresh parent. extractSkillTarball writes its top-level
  // entry (the skill folder, named <opts.name>) inside destParent.
  await mkdir(newDir, { recursive: true });
  const written = await extractSkillTarball({
    srcTar:     opts.srcTar,
    destParent: newDir,
  });

  // Step 2: hoist <newDir>/<topLevelDir>/* up so newDir itself IS the new tree.
  // The tarball top-level dir name equals the basename of the source skillDir
  // passed to packSkillTarball, which may differ from opts.name. Derive it
  // from the first written path segment.
  const topLevelDir = written.length > 0
    ? written[0]!.split("/")[0]!
    : opts.name;
  const innerExtracted = path.join(newDir, topLevelDir);
  const hoistTmp = path.join(opts.sharedSkillsDir, `.${opts.name}.hoist.${opts.shareId}`);
  await rename(innerExtracted, hoistTmp);
  await rmFs(newDir, { recursive: true, force: true });
  await rename(hoistTmp, newDir);

  // Step 3: move existing target aside.
  await rename(target, oldDir);

  // Step 4: install new.
  try {
    await rename(newDir, target);
  } catch (e) {
    // Best-effort restore so the system has SOMETHING at the target name.
    try { await rename(oldDir, target); } catch { /* swallow */ }
    throw e;
  }

  // Step 5: delete .old (best-effort; failure here is non-fatal to the caller).
  await rmFs(oldDir, { recursive: true, force: true });

  return written;
}

/** Stream-extract one entry from a tarball. Returns the bytes, or null when
 *  the entry is not present. The path argument is matched against entries
 *  POSIX-style; both `<root>/<rel>` and just `<rel>` are accepted so the
 *  caller does not have to know whether the snapshot was packed with the
 *  skill-folder prefix. */
export async function extractSingleFile(opts: {
  srcTar: string;
  path:   string;        // POSIX-style; may include skill root prefix or not
}): Promise<Buffer | null> {
  const wantA = opts.path.replace(/^\/+/, "");
  // Normalise: allow caller to omit the top-level skill dir.
  // wantB strips the first path segment (when caller passes full "root/file" form).
  // wantC strips to bare name (when entry has prefix but caller passed bare name).
  const wantB = wantA.includes("/") ? wantA.split("/").slice(1).join("/") : "";

  return await new Promise<Buffer | null>((resolveP, rejectP) => {
    const chunks: Buffer[] = [];
    let matched = false;

    const parser = t({ strict: true });

    parser.on("entry", (entry: ReadEntry) => {
      const ep = entry.path.replace(/^\/+/, "");
      if (matched) { entry.resume(); return; }
      // Match: exact path, or strip-first-segment form, or entry ends with /<wantA>
      const epStripped = ep.includes("/") ? ep.split("/").slice(1).join("/") : ep;
      if (ep === wantA || (wantB && ep === wantB) || epStripped === wantA) {
        matched = true;
        entry.on("data", (c: Buffer) => chunks.push(c));
        entry.on("end", () => resolveP(Buffer.concat(chunks)));
      } else {
        entry.resume();
      }
    });

    parser.on("end", () => {
      if (!matched) resolveP(null);
    });
    parser.on("error", rejectP);

    pipeline(createReadStream(opts.srcTar), parser).catch(rejectP);
  });
}
