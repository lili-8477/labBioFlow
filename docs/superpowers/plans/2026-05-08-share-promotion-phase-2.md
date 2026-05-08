# Share-to-org promotion — phase 2 (skill kind) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the share-promotion queue (phase 1, memory-only) so users can submit a skill folder from `~/.claude/skills/<name>/` for org review; on approve the indexer untars the frozen snapshot to `shared/skills/<name>/`, where every user's read-only mount picks it up immediately.

**Architecture:** Phase 1's queue (`share_requests` table + six routes + adapter NATS bridge + Share panel) is reused unchanged. New work lives in three layers: (a) indexer gains a `share-fs.ts` helper module (path-traversal guard, tarball pack/unpack, manifest/file-index readers), the workspaces mount flips `:ro` → `:rw`, and `submitShareRequest`/`decideShareRequest` grow skill branches that talk to those helpers; (b) one new HTTP route `GET /share/:id/snapshot/file` streams a single file out of a snapshot tarball, proxied through the per-user adapter HTTP server (port 5000) and a new nginx `/share-snapshot/` location — same auth-routes-per-user pattern as `/upload/`; (c) frontend gains a minimal Skills right-panel that lists the user's `~/.claude/skills/<name>/` with a Share button per skill, plus skill-aware preview rendering in `ShareDetail.vue` (manifest + file tree + click-to-fetch). The trust model is unchanged: the adapter injects `USERNAME` as actor on every call; the frontend never sends it.

**Phase scope:** skill kind end-to-end. `submit`/`decide` for `kind: 'skill'` go from `501 not implemented` to fully working. Memory promotion is untouched. Folder kind (`local_projects/<name>/`) defers to phase 3 — the same machinery, different source/dest paths and a 100 MB cap.

**Tech Stack:**
- Backend: TypeScript / Node 20, fastify, `tar` (node-tar 7.x — canonical streaming tarball lib, supports per-entry extraction), vitest + `@testcontainers/postgresql`
- Adapter: TypeScript / Node 20 — adds an HTTP proxy route to `upload-http.ts` (or a new sibling), no new deps; new `skills_list` NATS RPC reads filesystem
- Infra: nginx (one new `location` block); docker-compose (drop `:ro` on indexer's workspaces volume)
- Frontend: Vue 3 Composition API + pinia (no new runtime deps)

**Spec:** `docs/superpowers/specs/2026-05-07-share-promotion.md`. Phase 2 scope is enumerated in §11 (what MVP=memory deferred) and §12 (phase split row "phase 2"). Per-kind mechanics in §5.2 (skill). Trust boundaries in §10. State machine and approve/reject semantics in §7 are unchanged.

**Phase 1 surface (already shipped, do NOT re-implement):**
- `share_requests` table + migration 0010 — schema already accepts `artifact_kind='skill'` and `promotion_result jsonb`.
- `MEMORY_ORG_MANAGER` env on indexer.
- `share-repo.ts`: six functions; `submitShareRequest` short-circuits `kind !== 'memory'` with `not_implemented`; `decideShareRequest`'s approve branch short-circuits non-memory kinds with `promotion_failed: kind '<kind>' not implemented`. Phase 2 replaces both shorts with real branches.
- `share-api.ts`: six routes (`submit`, `list`, `capabilities`, `:id/decide`, `:id/withdraw`, `:id`).
- `adapter/share-rpc.ts` + six dispatch cases in `adapter/rpc.ts`.
- Frontend: types/services/store/SharePanel/ShareList/ShareDetail/Share button on MemoryDetail/Share tab in MainLayout.

**Out of phase 2 scope:**
- Folder kind (`local_projects/`), Files-panel context menu, 100 MB size cap → phase 3.
- Snapshot cleanup cron (30-day TTL on rejected/approved snapshots) → phase 4.
- Multi-manager, update-existing-skill kind, line-by-line review → phase 4.
- Range-aware file streaming (the spec's "range-aware so the frontend can preview the first 1 MB of a notebook" applies to large folder files in phase 3; phase 2 streams full file, since skills are small).
- A full skill editor / SKILL.md authoring UI. Phase 2 ships a *listing* component only — view name+description+Share button per skill. Editing skills happens in the IDE / via files.

**Production prerequisites already in place:**
- Per-user mount layout: every user's container sees `~/.claude/skills/` (rw, per-user) AND `~/.claude/skills-shared/` (ro, points at `shared/skills/`). See `hub/scripts/add-user.sh:283–299` and `recreate-user.sh:160–161`.
- Indexer reads `WORKSPACES_ROOT=/workspaces` and currently mounts `./workspaces:/workspaces:ro`.

---

## File Structure

**Created:**
- `hub/indexer/src/share-fs.ts` — pure helpers, no PG; six exports: `safeJoin`, `walkSkillFiles`, `readSkillManifest`, `packSkillTarball`, `extractSkillTarball`, `extractSingleFile`
- `hub/indexer/test/share-fs.test.ts` — vitest unit tests against a tmpdir; covers path-traversal rejection, walk ignores `.git`/`node_modules`, pack→extract round-trip, single-file extract returns bytes, single-file extract on missing path returns null, manifest reads SKILL.md or null
- `adapter/src/skills-rpc.ts` — `listUserSkills(home)` returns `[{ name, description }]` from `<home>/.claude/skills/<name>/SKILL.md` frontmatter
- `adapter/test/skills-rpc.test.ts` — tmpdir fixtures, asserts frontmatter parsing, asserts ignores files at top-level (only directories with `SKILL.md` count), asserts empty-list when `~/.claude/skills/` missing
- `frontend/src/types/skills.ts` — `SkillSummary { name, description }`
- `frontend/src/services/skills.ts` — `skillsService.list()` — wraps `natsService.invoke('skills_list', {})`
- `frontend/src/stores/skills.ts` — pinia: `skills: SkillSummary[]`, `loading: boolean`, `load()`, `submitShare(name, note?)` (delegates to `useShareStore().submit`)
- `frontend/src/components/skills/SkillsPanel.vue` — top-level: header + list, click "Refresh"
- `frontend/src/components/skills/SkillRow.vue` — one row: name, description (truncated), `[Share]` button → opens the same submit modal as MemoryDetail

**Modified:**
- `hub/indexer/package.json` — add `"tar": "^7.4.3"` to deps; `"@types/node"` already covers stream typings
- `hub/indexer/src/config.ts` — add `shareSnapshotsDir: string` field; default = `${WORKSPACES_ROOT}/shared/.share-snapshots`; reads `SHARE_SNAPSHOTS_DIR` env if set
- `hub/indexer/src/index.ts` — at boot, `mkdir -p` the snapshots dir; thread `shareSnapshotsDir` into the share-api deps
- `hub/indexer/src/share-repo.ts` — extend `SubmitArgs` with `workspacesRoot: string` and `shareSnapshotsDir: string`; extend `submitShareRequest` with the `kind === 'skill'` branch; extend `decideShareRequest` with the skill approve branch; widen `SubmitResult` reasons union with `'invalid_ref'`, `'source_not_found'`, `'snapshot_failed'`; widen `DecideResult` reason set with `'collision'`
- `hub/indexer/src/share-api.ts` — extend `ShareApiDeps` with `workspacesRoot` + `shareSnapshotsDir`, thread into `submitShareRequest`/`decideShareRequest` calls; add new route `GET /share/:id/snapshot/file?actor=&path=` that streams one file
- `hub/indexer/test/share-repo.test.ts` — add 8 new tests: skill submit happy path, skill submit path-traversal rejection, skill submit missing source dir, skill submit missing SKILL.md, skill approve happy path, skill approve collision, skill approve idempotent (re-decide on already-approved returns 409), skill snapshot survives source deletion
- `hub/indexer/test/share-api.test.ts` — add tests for the new snapshot/file route: happy path, 404 on missing path, 403 on non-owner-non-reviewer
- `adapter/src/upload-http.ts` — add a second handler branch for `GET /share-snapshot/:id/file?path=...`; proxies to indexer's `/share/:id/snapshot/file?actor=USERNAME&path=...`. (Stays in `upload-http.ts` because it's another HTTP route on the same per-user adapter port; renaming the file is out of scope.)
- `adapter/src/index.ts` — pass `username` and `memoryApiUrl` into `startUploadServer` so the new branch can build the upstream URL; also register the `skills_list` RPC by importing `listUserSkills` and adding it to the dispatch deps
- `adapter/src/rpc.ts` — new dispatch case `case "skills_list":` returning `{success: true, skills}`
- `adapter/test/upload-http.test.ts` — add tests for `GET /share-snapshot/:id/file` (mocked indexer): happy path streams bytes, 404 propagated, query string includes injected `actor=USERNAME`
- `hub/nginx.conf` — new `location /share-snapshot/` block with auth_basic + per-user `proxy_pass`
- `hub/docker-compose.yml` — drop `:ro` from `./workspaces:/workspaces:ro`; add `SHARE_SNAPSHOTS_DIR: /workspaces/shared/.share-snapshots` env (explicit, even though config falls back to the same value)
- `frontend/src/types/share.ts` — add `SkillSnapshotMeta { manifest: string; files: SkillSnapshotFile[]; root_name: string }` and `SkillSnapshotFile { path, sha256, size_bytes }`; `ShareRequest.snapshot_meta` stays `Record<string, unknown>` because shape is still kind-discriminated by `artifact_kind`
- `frontend/src/services/share.ts` — add `fetchSnapshotFile(id: string, path: string): Promise<Blob>` — HTTP GET to `/share-snapshot/<id>/file?path=...`; returns the Response body. Used by ShareDetail.
- `frontend/src/components/share/ShareDetail.vue` — replace the "preview unavailable" placeholder for kind=skill with: manifest preview (markdown-rendered or pre-formatted), file tree, click-a-file-to-fetch behaviour
- `frontend/src/components/layout/MainLayout.vue` — extend `RightPanel` union with `'skills'`; add toolbar button + render branch; in `togglePanel('skills')` cause `useSkillsStore().load()`

---

## Task 1: Indexer config — `shareSnapshotsDir` + `:rw` mount + boot mkdir

**Files:**
- Modify: `hub/indexer/src/config.ts`
- Modify: `hub/indexer/test/config.test.ts`
- Modify: `hub/indexer/src/index.ts`
- Modify: `hub/docker-compose.yml`

- [ ] **Step 1: Extend `Config` interface and `loadConfig()`**

`workspacesRoot` is already on the existing `Config` interface (read from `WORKSPACES_ROOT`, default `/workspaces`). Add a single new field.

In `hub/indexer/src/config.ts`, add field to the `Config` interface (alongside `memoryOrgManager`):

```ts
shareSnapshotsDir:    string;
```

In the body of `loadConfig()`, before the `return` statement:

```ts
const shareSnapshotsDir = env.SHARE_SNAPSHOTS_DIR && env.SHARE_SNAPSHOTS_DIR.length > 0
  ? env.SHARE_SNAPSHOTS_DIR
  : `${env.WORKSPACES_ROOT ?? "/workspaces"}/shared/.share-snapshots`;
```

Add `shareSnapshotsDir,` to the returned object.

- [ ] **Step 2: Add config tests**

In `hub/indexer/test/config.test.ts`, add three cases mirroring the existing `memoryOrgManager` cases:

```ts
it('shareSnapshotsDir defaults to /workspaces/shared/.share-snapshots', () => {
  const cfg = loadConfig({ PG_URL: 'postgres://x' });
  expect(cfg.shareSnapshotsDir).toBe('/workspaces/shared/.share-snapshots');
});

it('shareSnapshotsDir tracks WORKSPACES_ROOT when SHARE_SNAPSHOTS_DIR unset', () => {
  const cfg = loadConfig({ PG_URL: 'postgres://x', WORKSPACES_ROOT: '/srv/ws' });
  expect(cfg.shareSnapshotsDir).toBe('/srv/ws/shared/.share-snapshots');
});

it('shareSnapshotsDir uses SHARE_SNAPSHOTS_DIR override when set', () => {
  const cfg = loadConfig({
    PG_URL: 'postgres://x',
    WORKSPACES_ROOT: '/workspaces',
    SHARE_SNAPSHOTS_DIR: '/var/share-snaps',
  });
  expect(cfg.shareSnapshotsDir).toBe('/var/share-snaps');
});
```

- [ ] **Step 3: Run config tests**

```
cd hub/indexer && npm test -- config
```

Expected: 3 new tests passing on top of the existing config suite.

- [ ] **Step 4: Bootstrap the snapshots dir at indexer boot**

In `hub/indexer/src/index.ts`, near the top of `main()` after `loadConfig()`, add:

```ts
import { mkdir } from "node:fs/promises";
// ...
await mkdir(cfg.shareSnapshotsDir, { recursive: true });
```

(If an import of `node:fs/promises` already exists at file top, just add `mkdir` to it.)

- [ ] **Step 5: Drop `:ro` on the indexer's workspaces mount + add env**

In `hub/docker-compose.yml`, under the `indexer:` service:

Change:
```yaml
    volumes:
      - ./workspaces:/workspaces:ro
```
to:
```yaml
    volumes:
      - ./workspaces:/workspaces
```

Add to `environment:` block (anywhere is fine; near `MEMORY_ORG_MANAGER` reads cleanly):
```yaml
      SHARE_SNAPSHOTS_DIR: /workspaces/shared/.share-snapshots
```

- [ ] **Step 6: Manual smoke — bring up the stack and confirm boot + writable mount**

```
cd hub
docker compose up -d --build indexer
docker compose logs indexer | tail -20
docker compose exec indexer ls -la /workspaces/shared/.share-snapshots
docker compose exec indexer touch /workspaces/shared/.share-snapshots/.write-probe && rm /workspaces/shared/.share-snapshots/.write-probe
```

Expected: indexer logs show no error; `.share-snapshots/` exists; the touch+rm probe succeeds (writable). If the touch fails with EACCES, the `:ro` is still in effect — re-check the compose edit.

- [ ] **Step 7: Commit**

```
git add hub/indexer/src/config.ts hub/indexer/test/config.test.ts hub/indexer/src/index.ts hub/docker-compose.yml
git commit -m "feat(indexer): add SHARE_SNAPSHOTS_DIR config and flip workspaces mount to rw"
```

---

## Task 2: `share-fs.ts` — tarball + path-traversal helpers

**Files:**
- Create: `hub/indexer/src/share-fs.ts`
- Create: `hub/indexer/test/share-fs.test.ts`
- Modify: `hub/indexer/package.json`

- [ ] **Step 1: Add the `tar` dep**

```
cd hub/indexer
npm install tar@^7.4.3
```

This adds `"tar": "^7.4.3"` to `dependencies` and a lockfile entry. node-tar is the canonical Node tarball library; v7 is ESM-compatible.

- [ ] **Step 2: Write the helper module**

Create `hub/indexer/src/share-fs.ts`:

```ts
// Pure filesystem helpers for the share-promotion skill flow.
//
// These functions never touch Postgres. They are the "trusted file ops" layer
// for snapshotting a user's skill folder and untarring it under shared/skills/.
// Path-traversal defence lives here once: callers MUST resolve refs through
// safeJoin() before passing them to anything else.

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
} from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";

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
      // Symlink hardening: require the resolved path stays under the skill root.
      let st;
      try { st = await stat(abs); } catch { continue; }
      if (st.isDirectory()) {
        stack.push(abs);
      } else if (st.isFile()) {
        const rel = path.relative(real, abs).split(path.sep).join("/");
        const buf = await readFile(abs);
        entries.push({
          path:       rel,
          sha256:     createHash("sha256").update(buf).digest("hex"),
          size_bytes: buf.byteLength,
        });
      }
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
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

/** Tar+gzip the skill directory into destTar. The tarball entries are stored
 *  with paths relative to the skill folder's PARENT, so the top-level entry
 *  is the skill folder name itself. (Symmetric with extractSkillTarball below
 *  which expects to land that folder under shared/skills/.) */
export async function packSkillTarball(opts: {
  skillDir: string;        // /workspaces/<user>/.claude/skills/<name>
  destTar:  string;        // /workspaces/shared/.share-snapshots/<share_id>.tar.gz
}): Promise<void> {
  const real = await realpath(opts.skillDir);
  const parent = path.dirname(real);
  const base   = path.basename(real);
  await mkdir(path.dirname(opts.destTar), { recursive: true });
  await tar.create(
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
  await tar.extract({
    file:   opts.srcTar,
    cwd:    opts.destParent,
    strict: true,
    onentry(entry: tar.ReadEntry) {
      written.push(entry.path);
    },
  });
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
  const wantB = wantA.includes("/") ? wantA.split("/").slice(1).join("/") : wantA;

  return await new Promise<Buffer | null>((resolveP, rejectP) => {
    const chunks: Buffer[] = [];
    let matched = false;

    const parser = tar.t({ strict: true });

    parser.on("entry", (entry: tar.ReadEntry) => {
      const ep = entry.path.replace(/^\/+/, "");
      if (matched) { entry.resume(); return; }
      if (ep === wantA || ep === wantB) {
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
```

- [ ] **Step 3: Write the failing tests**

Create `hub/indexer/test/share-fs.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  safeJoin,
  walkSkillFiles,
  readSkillManifest,
  packSkillTarball,
  extractSkillTarball,
  extractSingleFile,
} from "../src/share-fs.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "share-fs-"));
});

describe("safeJoin", () => {
  it("accepts a child name", () => {
    const r = safeJoin(root, "foo");
    expect(r).toBe(path.resolve(root, "foo"));
  });
  it("rejects ../ traversal", () => {
    expect(safeJoin(root, "../etc")).toBeNull();
  });
  it("rejects absolute paths", () => {
    expect(safeJoin(root, "/etc/passwd")).toBeNull();
  });
  it("rejects empty ref", () => {
    expect(safeJoin(root, "")).toBeNull();
  });
  it("rejects null bytes", () => {
    expect(safeJoin(root, "foo\0bar")).toBeNull();
  });
  it("rejects ref equal to root", () => {
    expect(safeJoin(root, ".")).toBeNull();
  });
});

describe("walkSkillFiles", () => {
  it("returns sorted file entries with sha256 + size", async () => {
    const skill = path.join(root, "single-cell");
    await mkdir(path.join(skill, "scripts"), { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "# skill\n");
    await writeFile(path.join(skill, "scripts", "qc.py"), "print(1)\n");
    const r = await walkSkillFiles(skill);
    expect(r.map(f => f.path)).toEqual(["SKILL.md", "scripts/qc.py"]);
    expect(r[0].size_bytes).toBe(8);
    expect(r[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("ignores .git and node_modules", async () => {
    const skill = path.join(root, "s");
    await mkdir(path.join(skill, ".git"), { recursive: true });
    await mkdir(path.join(skill, "node_modules"), { recursive: true });
    await writeFile(path.join(skill, ".git", "HEAD"), "ref: x\n");
    await writeFile(path.join(skill, "node_modules", "foo.js"), "x");
    await writeFile(path.join(skill, "SKILL.md"), "# x");
    const r = await walkSkillFiles(skill);
    expect(r.map(f => f.path)).toEqual(["SKILL.md"]);
  });
});

describe("readSkillManifest", () => {
  it("returns the file body when SKILL.md exists", async () => {
    const skill = path.join(root, "s");
    await mkdir(skill);
    await writeFile(path.join(skill, "SKILL.md"), "hi");
    expect(await readSkillManifest(skill)).toBe("hi");
  });
  it("returns null when SKILL.md is absent", async () => {
    const skill = path.join(root, "s");
    await mkdir(skill);
    expect(await readSkillManifest(skill)).toBeNull();
  });
});

describe("pack/extract round-trip", () => {
  it("packs a skill into a tarball that extracts back to the same files", async () => {
    const skill = path.join(root, "single-cell");
    await mkdir(path.join(skill, "scripts"), { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "manifest body\n");
    await writeFile(path.join(skill, "scripts", "qc.py"), "print(1)\n");
    const tarPath = path.join(root, "snap.tar.gz");
    await packSkillTarball({ skillDir: skill, destTar: tarPath });

    const dest = path.join(root, "out");
    const written = await extractSkillTarball({ srcTar: tarPath, destParent: dest });
    expect(written).toEqual(expect.arrayContaining(["single-cell/SKILL.md", "single-cell/scripts/qc.py"]));
    const r = await walkSkillFiles(path.join(dest, "single-cell"));
    expect(r.map(f => f.path)).toEqual(["SKILL.md", "scripts/qc.py"]);
  });
});

describe("extractSingleFile", () => {
  it("returns the bytes for a known entry", async () => {
    const skill = path.join(root, "s");
    await mkdir(skill);
    await writeFile(path.join(skill, "SKILL.md"), "abc\n");
    const tarPath = path.join(root, "snap.tar.gz");
    await packSkillTarball({ skillDir: skill, destTar: tarPath });

    const buf = await extractSingleFile({ srcTar: tarPath, path: "s/SKILL.md" });
    expect(buf?.toString("utf8")).toBe("abc\n");

    const buf2 = await extractSingleFile({ srcTar: tarPath, path: "SKILL.md" });
    expect(buf2?.toString("utf8")).toBe("abc\n");
  });
  it("returns null for a missing entry", async () => {
    const skill = path.join(root, "s");
    await mkdir(skill);
    await writeFile(path.join(skill, "SKILL.md"), "x");
    const tarPath = path.join(root, "snap.tar.gz");
    await packSkillTarball({ skillDir: skill, destTar: tarPath });
    expect(await extractSingleFile({ srcTar: tarPath, path: "missing.txt" })).toBeNull();
  });
});
```

- [ ] **Step 4: Run the tests**

```
cd hub/indexer && npm test -- share-fs
```

Expected: 12 tests passing.

- [ ] **Step 5: Commit**

```
git add hub/indexer/package.json hub/indexer/package-lock.json hub/indexer/src/share-fs.ts hub/indexer/test/share-fs.test.ts
git commit -m "feat(indexer): share-fs helpers — safeJoin + tarball pack/extract/single-file"
```

---

## Task 3: `share-repo.submitShareRequest` — skill branch

**Files:**
- Modify: `hub/indexer/src/share-repo.ts`
- Modify: `hub/indexer/test/share-repo.test.ts`

- [ ] **Step 1: Widen the SubmitArgs and SubmitResult types**

In `hub/indexer/src/share-repo.ts`, replace the existing `SubmitArgs` and `SubmitResult` definitions:

```ts
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
```

Add the imports at the top of `share-repo.ts`:

```ts
import * as path from "node:path";
import { stat } from "node:fs/promises";
import {
  safeJoin,
  walkSkillFiles,
  readSkillManifest,
  packSkillTarball,
} from "./share-fs.js";
```

- [ ] **Step 2: Replace the `not_implemented` short-circuit with the real skill branch**

In `submitShareRequest`, replace the block:

```ts
  if (args.kind !== "memory") {
    return { ok: false, reason: "not_implemented" };
  }
```

with:

```ts
  if (args.kind === "skill") {
    return await submitSkillShareRequest(args);
  }
  if (args.kind !== "memory") {
    return { ok: false, reason: "not_implemented" };
  }
```

Then below the existing memory body (after the closing brace of `submitShareRequest`), add the skill helper:

```ts
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
```

- [ ] **Step 3: Add tests for skill submit**

In `hub/indexer/test/share-repo.test.ts`, ADD a new `describe("submitShareRequest skill branch")` block (do not modify existing tests). The test setup needs a tmpdir for `workspacesRoot` and `shareSnapshotsDir`. Reuse the existing pgc/pool fixture.

```ts
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

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
      pool, manager: "li86", requester: "alice",
      kind: "skill", ref: "single-cell",
      workspacesRoot, shareSnapshotsDir,
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
      pool, manager: "li86", requester: "alice",
      kind: "skill", ref: "../../etc",
      workspacesRoot, shareSnapshotsDir,
    });
    expect(r).toEqual({ ok: false, reason: "invalid_ref" });
  });

  it("returns source_not_found when the skill folder does not exist", async () => {
    const r = await submitShareRequest({
      pool, manager: "li86", requester: "alice",
      kind: "skill", ref: "no-such-skill",
      workspacesRoot, shareSnapshotsDir,
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe("source_not_found");
  });

  it("returns missing_manifest when SKILL.md is absent", async () => {
    const skill = path.join(workspacesRoot, "alice", ".claude", "skills", "no-manifest");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "qc.py"), "x");
    const r = await submitShareRequest({
      pool, manager: "li86", requester: "alice",
      kind: "skill", ref: "no-manifest",
      workspacesRoot, shareSnapshotsDir,
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe("missing_manifest");
  });
});
```

If the existing share-repo tests' top-level `describe` already has a fixture pool, reuse it (move the pool variable out of the inner block scope as needed). Don't duplicate testcontainer setup.

- [ ] **Step 4: Run the tests**

```
cd hub/indexer && npm test -- share-repo
```

Expected: 4 new tests passing; existing tests still green.

- [ ] **Step 5: Commit**

```
git add hub/indexer/src/share-repo.ts hub/indexer/test/share-repo.test.ts
git commit -m "feat(share-repo): skill submit — pack tarball, freeze manifest+file index"
```

---

## Task 4: `share-repo.decideShareRequest` — skill approve branch

**Files:**
- Modify: `hub/indexer/src/share-repo.ts`
- Modify: `hub/indexer/test/share-repo.test.ts`

- [ ] **Step 1: Widen DecideArgs and DecideResult; thread paths in**

In `hub/indexer/src/share-repo.ts`, replace the existing `DecideArgs` and `DecideResult`:

```ts
export interface DecideArgs {
  pool:               Pool;
  actor:              string;
  manager:            string | null;
  shareId:            string;
  decision:           "approve" | "reject";
  comment?:           string;
  // Phase 2: required for the skill approve branch.
  workspacesRoot:     string;
  shareSnapshotsDir:  string;
}

export type DecideResult =
  | { ok: true; status: ShareStatus; promotion_result?: Record<string, unknown> }
  | { ok: false; reason:
        | "not_found"
        | "forbidden"
        | "already_decided"
        | "promotion_failed"
        | "collision";
      detail?: string };
```

Add the import:

```ts
import { extractSkillTarball } from "./share-fs.js";
```

- [ ] **Step 2: Replace the kind-not-memory short-circuit in approve path**

In `decideShareRequest`'s approve branch, locate the block:

```ts
    if (row.artifact_kind !== "memory") {
      await client.query("ROLLBACK");
      return {
        ok:     false,
        reason: "promotion_failed",
        detail: `kind '${row.artifact_kind}' not implemented`,
      };
    }
```

Replace with:

```ts
    if (row.artifact_kind === "skill") {
      const result = await approveSkillShareRequest({
        client, row, comment: args.comment,
        workspacesRoot:    args.workspacesRoot,
        shareSnapshotsDir: args.shareSnapshotsDir,
      });
      if (!result.ok) {
        await client.query("ROLLBACK");
        return result;
      }
      // approveSkillShareRequest is responsible for issuing UPDATE + COMMIT.
      return result;
    }
    if (row.artifact_kind !== "memory") {
      await client.query("ROLLBACK");
      return {
        ok:     false,
        reason: "promotion_failed",
        detail: `kind '${row.artifact_kind}' not implemented`,
      };
    }
```

At the bottom of the file, add the skill approve helper:

```ts
async function approveSkillShareRequest(args: {
  client:             PoolClient;
  row:                ShareRow;
  comment?:           string;
  workspacesRoot:     string;
  shareSnapshotsDir:  string;
}): Promise<DecideResult> {
  const { client, row } = args;

  // Validate snapshot shape.
  const meta = row.snapshot_meta as Record<string, unknown>;
  if (
    typeof meta.root_name !== "string" ||
    typeof meta.manifest  !== "string" ||
    !Array.isArray(meta.files)
  ) {
    return { ok: false, reason: "promotion_failed", detail: "snapshot_meta missing root_name/manifest/files" };
  }
  const rootName = meta.root_name as string;

  // Refuse traversal in stored root_name (defence in depth — submit guards too).
  const sharedSkills = path.join(args.workspacesRoot, "shared", "skills");
  const destDir = safeJoin(sharedSkills, rootName);
  if (destDir === null) {
    return { ok: false, reason: "promotion_failed", detail: "snapshot root_name is invalid" };
  }

  // Collision check.
  try {
    const st = await stat(destDir);
    if (st.isDirectory()) {
      return { ok: false, reason: "collision", detail: `shared/skills/${rootName} already exists` };
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
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

  await client.query(
    `UPDATE share_requests
        SET status = 'approved', decided_at = now(),
            review_comment = $1, promotion_result = $2
      WHERE share_id = $3`,
    [args.comment ?? null, promotion_result, row.share_id],
  );
  await client.query("COMMIT");
  return { ok: true, status: "approved", promotion_result };
}
```

- [ ] **Step 3: Add tests for skill approve**

In `hub/indexer/test/share-repo.test.ts`, add a new describe block AFTER the skill submit block:

```ts
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
      pool, manager: "li86", requester: "alice",
      kind: "skill", ref: "demo",
      workspacesRoot, shareSnapshotsDir,
    });
    expect(submitR.ok).toBe(true);
    if (!submitR.ok) throw new Error("type guard");

    const decideR = await decideShareRequest({
      pool, actor: "li86", manager: "li86",
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
      pool, manager: "li86", requester: "alice",
      kind: "skill", ref: "demo",
      workspacesRoot, shareSnapshotsDir,
    });
    if (!submitR.ok) throw new Error("setup failed");

    const decideR = await decideShareRequest({
      pool, actor: "li86", manager: "li86",
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
      pool, manager: "li86", requester: "alice",
      kind: "skill", ref: "demo",
      workspacesRoot, shareSnapshotsDir,
    });
    if (!submitR.ok) throw new Error("setup failed");
    // Delete the source.
    const { rm } = await import("node:fs/promises");
    await rm(path.join(workspacesRoot, "alice", ".claude", "skills", "demo"), { recursive: true });

    const decideR = await decideShareRequest({
      pool, actor: "li86", manager: "li86",
      shareId: submitR.share_id, decision: "approve",
      workspacesRoot, shareSnapshotsDir,
    });
    expect(decideR.ok).toBe(true);
  });
});
```

- [ ] **Step 4: Run the tests**

```
cd hub/indexer && npm test -- share-repo
```

Expected: 3 new tests passing on top of Task 3's 4; existing tests still green.

- [ ] **Step 5: Commit**

```
git add hub/indexer/src/share-repo.ts hub/indexer/test/share-repo.test.ts
git commit -m "feat(share-repo): skill approve — untar snapshot to shared/skills with collision check"
```

---

## Task 5: `share-api` — `GET /share/:id/snapshot/file` route + thread paths through

**Files:**
- Modify: `hub/indexer/src/share-api.ts`
- Modify: `hub/indexer/src/index.ts`
- Modify: `hub/indexer/test/share-api.test.ts`

- [ ] **Step 1: Extend ShareApiDeps**

In `hub/indexer/src/share-api.ts`, replace:

```ts
export interface ShareApiDeps {
  pool:    Pool;
  manager: string | null;
  repo: { /* ... */ };
}
```

with:

```ts
export interface ShareApiDeps {
  pool:               Pool;
  manager:            string | null;
  workspacesRoot:     string;
  shareSnapshotsDir:  string;
  repo: { /* unchanged */ };
}
```

In the `submit` route handler, in the call to `deps.repo.submitShareRequest({ ... })`, ADD `workspacesRoot` and `shareSnapshotsDir`:

```ts
const result = await deps.repo.submitShareRequest({
  pool:              deps.pool,
  manager:           deps.manager,
  requester:         b.requester,
  kind:              b.kind,
  ref:               b.ref,
  note:              b.note,
  workspacesRoot:    deps.workspacesRoot,
  shareSnapshotsDir: deps.shareSnapshotsDir,
});
```

Same for the `decide` route's call.

ALSO map the new SubmitResult reasons to HTTP codes. Replace the existing trailing block:

```ts
      if (result.reason === 'no_manager') {
        reply.code(503);
        return { error: 'sharing disabled' };
      }
      if (result.reason === 'not_implemented') {
        reply.code(501);
        return { error: `kind ${b.kind} not yet implemented` };
      }
      // forbidden
      reply.code(403);
      return { error: 'source not found or not owned by requester' };
```

with:

```ts
      switch (result.reason) {
        case 'no_manager':
          reply.code(503); return { error: 'sharing disabled' };
        case 'not_implemented':
          reply.code(501); return { error: `kind ${b.kind} not yet implemented` };
        case 'forbidden':
          reply.code(403); return { error: 'source not found or not owned by requester' };
        case 'invalid_ref':
          reply.code(400); return { error: 'invalid ref' };
        case 'source_not_found':
          reply.code(404); return { error: 'source not found', detail: result.detail };
        case 'missing_manifest':
          reply.code(400); return { error: 'skill is missing SKILL.md' };
        case 'snapshot_failed':
          reply.code(500); return { error: 'snapshot failed', detail: result.detail };
      }
```

Map the new DecideResult `'collision'` reason in the decide route. Per spec §8.1, promotion failures (including name collision) return HTTP 422 — the manager retries by rejecting with a rename suggestion.

```ts
      if (result.reason === 'collision') {
        reply.code(422);
        return { error: 'name collision', detail: result.detail };
      }
```

(Add this BEFORE the existing `if (result.reason === 'promotion_failed') { ... }` line.)

- [ ] **Step 2: Add the snapshot/file route**

After the bare `GET /share/:id` route registration (so route order keeps the literal `/snapshot/file` suffix matching first), register a new route. Actually, since `/share/:id/snapshot/file` is more specific than `/share/:id`, fastify's radix tree picks the literal child. Register it right before the bare `GET /share/:id` route to make ordering explicit:

```ts
import { extractSingleFile } from './share-fs.js';
import { lookup as mimeLookup } from 'mime-types';
import * as path from 'node:path';

// (...inside the plugin factory, before the bare GET /share/:id...)

const SnapshotFileQuery = z.object({
  actor: z.string().min(1),
  path:  z.string().min(1),
});

instance.get<{ Params: { id: string } }>('/share/:id/snapshot/file', async (req, reply) => {
  const parsed = SnapshotFileQuery.safeParse(req.query);
  if (!parsed.success) {
    reply.code(400);
    return { error: 'validation failed', issues: parsed.error.issues };
  }
  const { actor, path: relPath } = parsed.data;

  const got = await deps.repo.getShareRequest({
    pool:    deps.pool,
    actor,
    shareId: req.params.id,
  });
  if ('error' in got) {
    reply.code(got.error === 'not_found' ? 404 : 403);
    return { error: got.error };
  }
  if (got.artifact_kind !== 'skill') {
    reply.code(400);
    return { error: 'snapshot/file only valid for skill kind' };
  }

  const tarPath = path.join(deps.shareSnapshotsDir, `${req.params.id}.tar.gz`);
  const buf = await extractSingleFile({ srcTar: tarPath, path: relPath });
  if (buf === null) {
    reply.code(404);
    return { error: 'file not in snapshot' };
  }

  const mt = mimeLookup(relPath) || 'application/octet-stream';
  reply.header('Content-Type', mt);
  reply.header('Content-Length', buf.byteLength.toString());
  reply.header('Cache-Control', 'private, max-age=300');
  return reply.send(buf);
});
```

Skip `mime-types` if not already a dep — just hardcode:

```ts
const mt = relPath.endsWith('.md') ? 'text/markdown'
         : relPath.endsWith('.json') ? 'application/json'
         : relPath.endsWith('.txt') ? 'text/plain'
         : relPath.endsWith('.py')  ? 'text/x-python'
         : 'application/octet-stream';
```

(Drop the `import { lookup as mimeLookup } ...` line in that case. Keep it minimal — no new deps for mime detection.)

- [ ] **Step 3: Pass workspacesRoot + shareSnapshotsDir from indexer index.ts**

In `hub/indexer/src/index.ts`, update the `app.register(shareRoutesPlugin({ ... }))` call:

```ts
await app.register(shareRoutesPlugin({
  pool,
  manager:           cfg.memoryOrgManager,
  workspacesRoot:    cfg.workspacesRoot,
  shareSnapshotsDir: cfg.shareSnapshotsDir,
  repo: {
    submitShareRequest,
    listShareRequests,
    getShareRequest,
    decideShareRequest,
    withdrawShareRequest,
    getShareCapabilities,
  },
}));
```

(If `cfg.workspacesRoot` does not yet exist on the Config interface, add it in Task 1's config edit. The existing config almost certainly already exposes it — check; if not, add `workspacesRoot: env.WORKSPACES_ROOT ?? "/workspaces"` to `loadConfig`.)

- [ ] **Step 4: Add API tests**

`hub/indexer/test/share-api.test.ts` already builds a fastify app via `app.inject(...)`. Phase 1 tests pass `manager` and `repo` into the plugin; extend the test's `buildApp(...)` helper to also accept and pass `workspacesRoot`/`shareSnapshotsDir`. Then add this describe block:

```ts
describe('GET /share/:id/snapshot/file', () => {
  let workspacesRoot: string;
  let shareSnapshotsDir: string;
  let shareId: string;

  beforeEach(async () => {
    workspacesRoot    = await mkdtemp(path.join(tmpdir(), "ws-"));
    shareSnapshotsDir = await mkdtemp(path.join(tmpdir(), "snap-"));
    const skill = path.join(workspacesRoot, "alice", ".claude", "skills", "demo");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "# demo skill\n");

    const submit = await submitShareRequest({
      pool, manager: 'li86', requester: 'alice',
      kind: 'skill', ref: 'demo',
      workspacesRoot, shareSnapshotsDir,
    });
    if (!submit.ok) throw new Error('setup failed');
    shareId = submit.share_id;

    // Rebuild app with the per-test paths.
    app = await buildApp({ pool, manager: 'li86', workspacesRoot, shareSnapshotsDir });
  });

  it('streams the requested file when the actor is the requester', async () => {
    const res = await app.inject({
      method: 'GET',
      url:    `/share/${shareId}/snapshot/file?actor=alice&path=demo/SKILL.md`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/markdown/);
    expect(res.body).toContain('demo skill');
  });

  it('returns 404 for an unknown path inside the tarball', async () => {
    const res = await app.inject({
      method: 'GET',
      url:    `/share/${shareId}/snapshot/file?actor=alice&path=missing.txt`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when the actor is neither requester nor reviewer', async () => {
    const res = await app.inject({
      method: 'GET',
      url:    `/share/${shareId}/snapshot/file?actor=bob&path=demo/SKILL.md`,
    });
    expect(res.statusCode).toBe(403);
  });
});
```

(Reuse the existing top-level `pool`/`pgc` fixture from share-api.test.ts; do not duplicate testcontainer setup.)

- [ ] **Step 5: Run the tests**

```
cd hub/indexer && npm test -- share-api
```

Expected: 3 new tests passing; existing share-api tests still green.

- [ ] **Step 6: Commit**

```
git add hub/indexer/src/share-api.ts hub/indexer/src/index.ts hub/indexer/test/share-api.test.ts
git commit -m "feat(share-api): GET /share/:id/snapshot/file streams a single file from snapshot"
```

---

## Task 6: Adapter HTTP — `/share-snapshot/:id/file` proxy + nginx route

**Files:**
- Modify: `adapter/src/upload-http.ts`
- Modify: `adapter/src/index.ts`
- Modify: `adapter/test/upload-http.test.ts` (or create if missing)
- Modify: `hub/nginx.conf`

- [ ] **Step 1: Extend `UploadServerOptions` with username + memoryApiUrl**

In `adapter/src/upload-http.ts`, replace the existing `UploadServerOptions`:

```ts
export interface UploadServerOptions {
  workspaceRoot:   string;
  port:            number;
  allowedSubtree?: string;
  // Phase 2: needed for /share-snapshot/<id>/file proxy.
  username?:       string;       // omitted → /share-snapshot/ returns 503
  memoryApiUrl?:   string;       // omitted → /share-snapshot/ returns 503
}
```

Read them in `startUploadServer`:

```ts
const username     = opts.username ?? null;
const memoryApiUrl = opts.memoryApiUrl ?? null;
```

Pass them to `handle(...)` via the context object.

- [ ] **Step 2: Add the `/share-snapshot/` branch in the request handler**

Inside `handle()`, after the existing `/healthz` early-return and BEFORE the `if (method !== "PUT" && method !== "POST")` check, insert:

```ts
if (url.startsWith("/share-snapshot/") && method === "GET") {
  await handleShareSnapshot(req, res, ctx);
  return;
}
```

Update `ctx` to include `username` and `memoryApiUrl`. Add the handler function at the bottom of the file:

```ts
async function handleShareSnapshot(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { username: string | null; memoryApiUrl: string | null },
): Promise<void> {
  if (!ctx.username || !ctx.memoryApiUrl) {
    sendJson(res, 503, { error: "share-snapshot disabled — adapter not configured" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://x");
  // /share-snapshot/<id>/file?path=<relPath>
  const m = url.pathname.match(/^\/share-snapshot\/([^/]+)\/file$/);
  if (!m) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  const id = m[1];
  const relPath = url.searchParams.get("path");
  if (!relPath) {
    sendJson(res, 400, { error: "missing_path" });
    return;
  }

  const upstream = new URL(`/share/${encodeURIComponent(id)}/snapshot/file`, ctx.memoryApiUrl);
  upstream.searchParams.set("actor", ctx.username);
  upstream.searchParams.set("path",  relPath);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream.toString());
  } catch (err) {
    sendJson(res, 502, { error: "upstream_failed", message: (err as Error).message });
    return;
  }

  res.statusCode = upstreamRes.status;
  upstreamRes.headers.forEach((v, k) => {
    // Allow-list a small set; do not propagate hop-by-hop headers.
    if (["content-type", "content-length", "cache-control"].includes(k.toLowerCase())) {
      res.setHeader(k, v);
    }
  });

  if (upstreamRes.body) {
    const reader = upstreamRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}
```

- [ ] **Step 3: Wire username + memoryApiUrl from `adapter/src/index.ts`**

In `adapter/src/index.ts`, find the `startUploadServer({ ... })` call and add the new fields:

```ts
startUploadServer({
  workspaceRoot,
  port:           uploadPort,
  username:       dbCfg.username,
  memoryApiUrl,
});
```

- [ ] **Step 4: Add nginx route**

In `hub/nginx.conf`, copy the `/upload/` block as a template for `/share-snapshot/`. Add this block AFTER the existing `/upload/` location and BEFORE the catch-all `location /` block:

```nginx
        # Per-user share-snapshot proxy. URL: /share-snapshot/<id>/file?path=<rel>
        # Routed to the user's adapter HTTP server (port 5000), which injects
        # actor=<remote_user> and forwards to the indexer. Rate-limited shared
        # with /upload/ since both target the same per-user adapter.
        location /share-snapshot/ {
            auth_basic "claude-bioflow files";
            auth_basic_user_file /etc/nginx/htpasswd;

            proxy_pass http://claude-bioflow-$remote_user:5000;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-User $remote_user;
            proxy_read_timeout 60s;
        }
```

- [ ] **Step 5: Add adapter test (mocked indexer)**

Create or extend `adapter/test/upload-http.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startUploadServer } from "../src/upload-http.js";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("/share-snapshot/:id/file proxy", () => {
  let upload: Server, fakeIndexer: Server;
  let port: number, indexerPort: number;
  const seenUrls: string[] = [];

  beforeAll(async () => {
    const wsRoot = await mkdtemp(join(tmpdir(), "ws-"));

    fakeIndexer = createServer((req, res) => {
      seenUrls.push(req.url ?? "");
      if (req.url?.includes("path=missing")) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "file not in snapshot" }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/markdown");
      res.end("# hello");
    });
    await new Promise<void>(r => fakeIndexer.listen(0, () => r()));
    indexerPort = (fakeIndexer.address() as { port: number }).port;

    upload = startUploadServer({
      workspaceRoot: wsRoot,
      port:          0,
      username:      "alice",
      memoryApiUrl:  `http://127.0.0.1:${indexerPort}`,
    });
    await new Promise<void>(r => upload.once("listening", () => r()));
    port = (upload.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>(r => upload.close(() => r()));
    await new Promise<void>(r => fakeIndexer.close(() => r()));
  });

  it("proxies GET /share-snapshot/:id/file and injects actor=USERNAME", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/share-snapshot/abc/file?path=demo/SKILL.md`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("# hello");
    const last = seenUrls.at(-1)!;
    expect(last).toContain("/share/abc/snapshot/file");
    expect(last).toContain("actor=alice");
    expect(last).toContain("path=demo");
  });

  it("propagates 404 from the upstream", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/share-snapshot/abc/file?path=missing.txt`);
    expect(r.status).toBe(404);
  });

  it("returns 503 when the adapter has no username configured", async () => {
    const tmpUp = startUploadServer({
      workspaceRoot: "/tmp",
      port:          0,
    });
    await new Promise<void>(r => tmpUp.once("listening", () => r()));
    const tmpPort = (tmpUp.address() as { port: number }).port;
    const r = await fetch(`http://127.0.0.1:${tmpPort}/share-snapshot/x/file?path=y`);
    expect(r.status).toBe(503);
    await new Promise<void>(r => tmpUp.close(() => r()));
  });
});
```

- [ ] **Step 6: Run tests**

```
cd adapter && npm test -- upload-http
```

Expected: 3 new tests passing.

- [ ] **Step 7: Smoke test through nginx (optional but recommended)**

```
cd hub
docker compose up -d --build adapter nginx
# Submit a skill share as test1 via the existing share_submit RPC, then:
curl -u test1:<htpasswd> "http://localhost/share-snapshot/<share_id>/file?path=demo/SKILL.md"
```

Expected: streams the SKILL.md body. nginx logs show 200, no 502.

- [ ] **Step 8: Commit**

```
git add adapter/src/upload-http.ts adapter/src/index.ts adapter/test/upload-http.test.ts hub/nginx.conf
git commit -m "feat(adapter): /share-snapshot/:id/file proxy with USERNAME-injected actor"
```

---

## Task 7: Adapter — `skills_list` NATS RPC

**Files:**
- Create: `adapter/src/skills-rpc.ts`
- Create: `adapter/test/skills-rpc.test.ts`
- Modify: `adapter/src/rpc.ts`
- Modify: `adapter/src/index.ts`

- [ ] **Step 1: Write the helper module**

Create `adapter/src/skills-rpc.ts`:

```ts
// Lists the user's per-user skills under <home>/.claude/skills/<name>/SKILL.md.
// Pure read-only file walk. Empty array when the directory does not exist.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface SkillSummary {
  name:        string;
  description: string;       // empty string when frontmatter has no description
}

export async function listUserSkills(home: string): Promise<SkillSummary[]> {
  const skillsDir = join(home, ".claude", "skills");
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: SkillSummary[] = [];
  for (const it of entries) {
    if (!it.isDirectory()) continue;
    const skill = join(skillsDir, it.name);
    let manifest: string;
    try {
      manifest = await readFile(join(skill, "SKILL.md"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    out.push({
      name:        it.name,
      description: extractDescription(manifest),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function extractDescription(manifest: string): string {
  // YAML frontmatter between leading "---" lines. Look for `description:` only.
  // Anything fancier (multi-line, quoted, escapes) we treat as opaque and
  // surface as empty — the manager's review UI shows the full manifest.
  const fmMatch = manifest.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return "";
  const fm = fmMatch[1];
  const dm = fm.match(/^description:\s*(.+?)\s*$/m);
  if (!dm) return "";
  return dm[1].replace(/^['"]|['"]$/g, "");
}
```

- [ ] **Step 2: Write tests**

Create `adapter/test/skills-rpc.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { listUserSkills } from "../src/skills-rpc.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "home-"));
});

describe("listUserSkills", () => {
  it("returns [] when ~/.claude/skills does not exist", async () => {
    expect(await listUserSkills(home)).toEqual([]);
  });

  it("lists each subdir that contains SKILL.md", async () => {
    const make = async (n: string, body: string) => {
      const d = path.join(home, ".claude", "skills", n);
      await mkdir(d, { recursive: true });
      await writeFile(path.join(d, "SKILL.md"), body);
    };
    await make("alpha", `---\ndescription: alpha skill\n---\nbody`);
    await make("beta",  `---\ndescription: "beta with quotes"\n---\nbody`);
    await mkdir(path.join(home, ".claude", "skills", "no-manifest"), { recursive: true });

    const r = await listUserSkills(home);
    expect(r).toEqual([
      { name: "alpha", description: "alpha skill" },
      { name: "beta",  description: "beta with quotes" },
    ]);
  });

  it("returns empty description when frontmatter is missing or has no description", async () => {
    const d = path.join(home, ".claude", "skills", "x");
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, "SKILL.md"), "no frontmatter here\n");
    expect(await listUserSkills(home)).toEqual([{ name: "x", description: "" }]);
  });
});
```

- [ ] **Step 3: Wire into RPC dispatch**

In `adapter/src/rpc.ts`:

1. Import the helper at the top:
   ```ts
   import { listUserSkills, type SkillSummary } from "./skills-rpc.js";
   ```
2. Extend `RpcRouterDeps` with:
   ```ts
   home: string;
   ```
3. In the dispatch switch, add right after the `share_capabilities` case:
   ```ts
   case "skills_list": {
     const skills = await listUserSkills(this.deps.home);
     return { success: true, skills };
   }
   ```

In `adapter/src/index.ts`, ensure `home` is passed into the RpcRouter deps. The variable `home` is already read at the top of the file (`const home = process.env.HOME ?? "/home/node"`). Add it to the new RpcRouter constructor call.

- [ ] **Step 4: Run tests**

```
cd adapter && npm test -- skills-rpc
```

Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```
git add adapter/src/skills-rpc.ts adapter/test/skills-rpc.test.ts adapter/src/rpc.ts adapter/src/index.ts
git commit -m "feat(adapter): skills_list NATS RPC enumerates ~/.claude/skills with descriptions"
```

---

## Task 8: Frontend types + services + Skills store

**Files:**
- Modify: `frontend/src/types/share.ts`
- Modify: `frontend/src/services/share.ts`
- Create: `frontend/src/types/skills.ts`
- Create: `frontend/src/services/skills.ts`
- Create: `frontend/src/stores/skills.ts`

- [ ] **Step 1: Extend share types**

In `frontend/src/types/share.ts`, append:

```ts
// Phase 2: skill snapshot shape inside snapshot_meta when artifact_kind='skill'.
export interface SkillSnapshotFile {
  path:       string;     // POSIX-style, relative to the skill dir
  sha256:     string;
  size_bytes: number;
}

export interface SkillSnapshotMeta {
  root_name: string;                 // basename of the skill folder
  manifest:  string;                 // SKILL.md contents
  files:     SkillSnapshotFile[];
}
```

- [ ] **Step 2: Extend share service with `fetchSnapshotFile`**

In `frontend/src/services/share.ts`, append to `shareService`:

```ts
  /**
   * Phase 2: fetch a single file from a frozen skill snapshot via the adapter
   * HTTP proxy. Used by ShareDetail's "click a file to preview" UX. Returns
   * the file body as text — the indexer route caps the file size implicitly
   * (skills are small; folders defer to phase 3).
   */
  fetchSnapshotFile: async (id: string, relPath: string): Promise<string> => {
    const url = `/share-snapshot/${encodeURIComponent(id)}/file?path=${encodeURIComponent(relPath)}`;
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) {
      throw new Error(`snapshot file fetch failed (HTTP ${r.status})`);
    }
    return await r.text();
  },
```

- [ ] **Step 3: Create skills types + service**

`frontend/src/types/skills.ts`:

```ts
export interface SkillSummary {
  name:        string;
  description: string;
}
```

`frontend/src/services/skills.ts`:

```ts
import { natsService } from './nats';
import type { SkillSummary } from '@/types/skills';

export const skillsService = {
  list: async (): Promise<SkillSummary[]> => {
    const r = await natsService.invoke('skills_list', {}) as
      { success: true; skills: SkillSummary[] };
    return r.skills;
  },
} as const;
```

- [ ] **Step 4: Create skills store**

`frontend/src/stores/skills.ts`:

```ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { SkillSummary } from '@/types/skills';
import { skillsService } from '@/services/skills';
import { useShareStore } from '@/stores/share';

export const useSkillsStore = defineStore('skills', () => {
  const skills  = ref<SkillSummary[]>([]);
  const loading = ref(false);
  const error   = ref<string | null>(null);

  async function load() {
    loading.value = true;
    error.value   = null;
    try {
      skills.value = await skillsService.list();
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function submitShare(name: string, note?: string) {
    const share = useShareStore();
    return await share.submit({ kind: 'skill', ref: name, note });
  }

  return { skills, loading, error, load, submitShare };
});
```

(`useShareStore().submit` already exists from phase 1 — verify by reading `frontend/src/stores/share.ts`. If the phase-1 store exposes a different name, align this call to it instead of inventing one.)

- [ ] **Step 5: Smoke build**

```
cd frontend && npm run build
```

Expected: clean TS build, dist regenerates.

- [ ] **Step 6: Commit**

```
git add frontend/src/types/share.ts frontend/src/types/skills.ts frontend/src/services/share.ts frontend/src/services/skills.ts frontend/src/stores/skills.ts
git commit -m "feat(frontend): skills types/service/store + share fetchSnapshotFile"
```

---

## Task 9: Frontend `SkillsPanel.vue` + `SkillRow.vue`

**Files:**
- Create: `frontend/src/components/skills/SkillsPanel.vue`
- Create: `frontend/src/components/skills/SkillRow.vue`

- [ ] **Step 1: Write `SkillRow.vue`**

```vue
<script setup lang="ts">
import { ref } from 'vue'
import type { SkillSummary } from '@/types/skills'
import { useSkillsStore } from '@/stores/skills'

defineProps<{ skill: SkillSummary }>()

const showModal = ref(false)
const note      = ref('')
const submitting = ref(false)
const errorMsg  = ref('')

const skills = useSkillsStore()

async function onSubmit(name: string) {
  submitting.value = true
  errorMsg.value = ''
  try {
    await skills.submitShare(name, note.value || undefined)
    showModal.value = false
    note.value = ''
  } catch (e) {
    errorMsg.value = (e as Error).message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="skill-row">
    <div class="skill-meta">
      <div class="skill-name">{{ skill.name }}</div>
      <div v-if="skill.description" class="skill-desc">{{ skill.description }}</div>
    </div>
    <button class="btn-share" @click="showModal = true">Share</button>
  </div>

  <Teleport to="body">
    <div v-if="showModal" class="modal-overlay" @click.self="showModal = false">
      <div class="modal">
        <h3>Share <strong>{{ skill.name }}</strong> with the org?</h3>
        <p v-if="skill.description" class="modal-desc">{{ skill.description }}</p>
        <textarea v-model="note" rows="3" placeholder="Why are you sharing this? (optional)" />
        <p v-if="errorMsg" class="modal-error">{{ errorMsg }}</p>
        <div class="modal-actions">
          <button @click="showModal = false" :disabled="submitting">Cancel</button>
          <button class="primary" @click="onSubmit(skill.name)" :disabled="submitting">
            {{ submitting ? 'Submitting…' : 'Submit' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.skill-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--space-3); padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-soft);
}
.skill-meta { min-width: 0; flex: 1; }
.skill-name { font-weight: var(--fw-semi); font-size: var(--text-sm); color: var(--text-primary); }
.skill-desc { font-size: var(--text-xs); color: var(--text-muted); margin-top: 2px;
              overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn-share {
  padding: var(--space-1) var(--space-3); border-radius: var(--radius);
  font-size: var(--text-xs); border: 1px solid var(--border);
  background: var(--bg-secondary); color: var(--text-primary); cursor: pointer;
}
.btn-share:hover { background: var(--bg-hover); }

.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.modal {
  background: var(--bg-primary); border: 1px solid var(--border);
  border-radius: var(--radius); padding: var(--space-4); width: min(420px, 90vw);
  display: flex; flex-direction: column; gap: var(--space-2);
}
.modal-desc { font-size: var(--text-xs); color: var(--text-muted); margin: 0; }
.modal textarea { width: 100%; padding: var(--space-2); resize: vertical; }
.modal-error { color: var(--danger); font-size: var(--text-xs); margin: 0; }
.modal-actions { display: flex; gap: var(--space-2); justify-content: flex-end; }
.modal-actions button {
  padding: var(--space-1) var(--space-3); border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--bg-secondary); cursor: pointer;
}
.modal-actions button.primary { background: var(--accent); color: white; border-color: var(--accent); }
.modal-actions button:disabled { opacity: 0.5; cursor: default; }
</style>
```

- [ ] **Step 2: Write `SkillsPanel.vue`**

```vue
<script setup lang="ts">
import { onMounted } from 'vue'
import { useSkillsStore } from '@/stores/skills'
import SkillRow from './SkillRow.vue'

const skills = useSkillsStore()

onMounted(() => skills.load())
</script>

<template>
  <div class="panel">
    <header class="panel-header">
      <h3>Skills</h3>
      <button class="refresh" @click="skills.load()" :disabled="skills.loading">
        {{ skills.loading ? '…' : 'Refresh' }}
      </button>
    </header>
    <div v-if="skills.error" class="error">{{ skills.error }}</div>
    <div v-else-if="skills.skills.length === 0 && !skills.loading" class="empty">
      No skills under <code>~/.claude/skills/</code>.
    </div>
    <div v-else class="list">
      <SkillRow v-for="s in skills.skills" :key="s.name" :skill="s" />
    </div>
  </div>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-soft);
}
.panel-header h3 { margin: 0; font-size: var(--text-md); font-weight: var(--fw-semi); }
.refresh {
  padding: var(--space-1) var(--space-2); border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--bg-secondary);
  font-size: var(--text-xs); cursor: pointer;
}
.error  { padding: var(--space-3) var(--space-4); color: var(--danger); }
.empty  { padding: var(--space-4); color: var(--text-muted); font-size: var(--text-sm); }
.list   { flex: 1; overflow-y: auto; }
</style>
```

- [ ] **Step 3: Smoke build**

```
cd frontend && npm run build
```

Expected: clean TS build.

- [ ] **Step 4: Commit**

```
git add frontend/src/components/skills/
git commit -m "feat(frontend): SkillsPanel + SkillRow listing components with share submit modal"
```

---

## Task 10: `ShareDetail.vue` — skill preview (manifest + file tree + click-to-fetch)

**Files:**
- Modify: `frontend/src/components/share/ShareDetail.vue`

- [ ] **Step 1: Add the skill preview section**

In `frontend/src/components/share/ShareDetail.vue`, replace the existing placeholder block:

```vue
<!-- ── Skill / folder placeholder ─────────────────────────── -->
<section v-else-if="store.selected.artifact_kind !== 'memory'" class="detail-section">
  <p class="preview-unavailable">
    Snapshot preview not available for {{ store.selected.artifact_kind }} requests in phase 1.
  </p>
</section>
```

with:

```vue
<!-- ── Skill snapshot preview ────────────────────────────── -->
<section v-else-if="store.selected.artifact_kind === 'skill' && skillSnap" class="detail-section">
  <h3 class="section-label">Manifest (SKILL.md)</h3>
  <pre class="manifest-body">{{ skillSnap.manifest }}</pre>

  <h3 class="section-label" style="margin-top: var(--space-4)">Files</h3>
  <ul class="file-list">
    <li v-for="f in skillSnap.files" :key="f.path">
      <button class="file-row" @click="openFile(f.path)">
        <span class="file-path">{{ f.path }}</span>
        <span class="file-size">{{ humanSize(f.size_bytes) }}</span>
      </button>
    </li>
  </ul>

  <div v-if="filePreview" class="file-preview">
    <h4 class="section-label">{{ filePreview.path }}</h4>
    <pre class="manifest-body">{{ filePreview.body }}</pre>
    <button class="close-preview" @click="filePreview = null">Close</button>
  </div>
</section>

<!-- ── Folder placeholder (phase 3) ─────────────────────── -->
<section v-else-if="store.selected.artifact_kind === 'folder'" class="detail-section">
  <p class="preview-unavailable">
    Folder preview not available yet — coming in phase 3.
  </p>
</section>
```

In the `<script setup>` block, ADD imports + computed + handlers:

```ts
import { shareService } from '@/services/share'
import type { SkillSnapshotMeta } from '@/types/share'

const skillSnap = computed<SkillSnapshotMeta | null>(() => {
  if (!store.selected || store.selected.artifact_kind !== 'skill') return null
  return store.selected.snapshot_meta as SkillSnapshotMeta
})

const filePreview = ref<{ path: string; body: string } | null>(null)

async function openFile(relPath: string) {
  if (!store.selected) return
  try {
    const body = await shareService.fetchSnapshotFile(store.selected.share_id, relPath)
    filePreview.value = { path: relPath, body }
  } catch (e) {
    filePreview.value = { path: relPath, body: `failed to load: ${(e as Error).message}` }
  }
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
```

ADD scoped CSS at the bottom of the file's `<style scoped>` block:

```css
.manifest-body {
  white-space: pre-wrap; word-break: break-word;
  font-family: var(--font-mono); font-size: 0.92em;
  background: var(--code-bg); border: 1px solid var(--border-soft);
  border-radius: var(--radius); padding: var(--space-3) var(--space-4);
  color: var(--text-primary); line-height: 1.55; margin: 0 0 var(--space-2);
  max-height: 240px; overflow: auto;
}
.file-list { list-style: none; padding: 0; margin: 0; }
.file-row {
  width: 100%; display: flex; justify-content: space-between; align-items: center;
  padding: var(--space-1) var(--space-2); border: 1px solid var(--border-soft);
  border-radius: var(--radius); margin-bottom: 2px; background: var(--bg-secondary);
  cursor: pointer; font-family: var(--font-mono); font-size: var(--text-xs);
  text-align: left;
}
.file-row:hover { background: var(--bg-hover); }
.file-path { color: var(--text-primary); }
.file-size { color: var(--text-muted); }
.file-preview { margin-top: var(--space-3); }
.close-preview {
  padding: 2px 8px; border-radius: var(--radius); border: 1px solid var(--border);
  background: var(--bg-secondary); cursor: pointer; font-size: var(--text-2xs);
}
```

- [ ] **Step 2: Smoke build**

```
cd frontend && npm run build
```

Expected: clean TS build.

- [ ] **Step 3: Commit**

```
git add frontend/src/components/share/ShareDetail.vue
git commit -m "feat(frontend): skill snapshot preview in ShareDetail — manifest + files + click-to-fetch"
```

---

## Task 11: `MainLayout.vue` — Skills tab integration

**Files:**
- Modify: `frontend/src/components/layout/MainLayout.vue`

- [ ] **Step 1: Extend the RightPanel union and import**

In `frontend/src/components/layout/MainLayout.vue`'s `<script setup>` block, change:

```ts
type RightPanel = 'none' | 'files' | 'notebook' | 'agents' | 'memory' | 'share'
```

to:

```ts
type RightPanel = 'none' | 'files' | 'notebook' | 'agents' | 'memory' | 'share' | 'skills'
```

Add the imports near the existing panel imports:

```ts
import SkillsPanel from '@/components/skills/SkillsPanel.vue'
import { useSkillsStore } from '@/stores/skills'
```

Add the store usage:

```ts
const skillsStore = useSkillsStore()
```

In `togglePanel(panel)`, add a branch that triggers a load when opening:

```ts
function togglePanel(panel: RightPanel) {
  rightPanel.value = rightPanel.value === panel ? 'none' : panel
  if (rightPanel.value === 'skills') skillsStore.load()
}
```

(The existing function may differ slightly; preserve its existing behaviour and add only the skills-load side effect.)

- [ ] **Step 2: Add the Skills tab button + render branch**

In the toolbar's `<template>`, add a new button between the Memory and Share buttons:

```vue
<button
  class="panel-tab tb-btn"
  :class="{ active: rightPanel === 'skills' }"
  @click="togglePanel('skills')"
  title="Skills (per-user)"
>Skills</button>
```

Below the SharePanel render branch, add:

```vue
<SkillsPanel v-else-if="rightPanel === 'skills'" />
```

- [ ] **Step 3: Manual end-to-end smoke (live stack)**

```
cd hub
docker compose up -d --build indexer adapter nginx
# In a browser as test1:
#  1. Open the right panel toolbar → click "Skills"
#  2. Confirm the SkillsPanel lists ~/.claude/skills/ entries with their descriptions
#  3. Click "Share" on one row, write a note, submit. Toast shows "submitted".
#  4. Switch user to li86 (manager): right panel "Share" tab shows badge (1)
#  5. Click Share → Inbox → click the row. Detail shows manifest + file tree.
#  6. Click a file → its body appears in the preview pane.
#  7. Type a comment "ok looks good" → click Approve.
#  8. As any user: ~/.claude/skills-shared/<name>/SKILL.md is now readable.
```

- [ ] **Step 4: Commit**

```
git add frontend/src/components/layout/MainLayout.vue
git commit -m "feat(frontend): Skills right-panel tab in MainLayout"
```

---

## Final review

After all 11 tasks:

- [ ] Run the full indexer test suite: `cd hub/indexer && npm test` — expect ~30 new tests on top of phase 1's count, all passing.
- [ ] Run the adapter test suite: `cd adapter && npm test` — expect ~6 new tests (3 share-snapshot proxy, 3 skills-rpc).
- [ ] Frontend build clean: `cd frontend && npm run build` — no TS errors, dist/ regenerates.
- [ ] Live stack: rebuild every container that changed (`indexer`, `adapter`, `nginx`) and recreate the four user containers via `hub/scripts/recreate-user.sh <user>` — the per-user adapters need to pick up the new `/share-snapshot/` route, and `recreate-user.sh` runs the same image as the rest of the stack.
- [ ] Run the manual end-to-end smoke from Task 11 step 3 against the live stack with all four production users. Verify `~/.claude/skills-shared/` shows the promoted skill within seconds for every user.
- [ ] Verify the rejection path: submit another skill, reject as li86, confirm the source is not promoted, the snapshot tarball is left in place under `shared/.share-snapshots/<id>.tar.gz` (cleanup is phase 4), and the Outbox row shows status=rejected with the comment.
- [ ] Verify the collision path: submit two skills with the same name from two different users; approve the first, attempt to approve the second → manager sees 409 collision; status stays pending; manager rejects with comment "rename to <new>".
- [ ] Update `docs/QA_log.md` only if a learning-oriented question came up during implementation (per CLAUDE.md §3).
- [ ] Memory: do NOT save a feedback memory about this work — the code is self-documenting.

When all green: dispatch `superpowers:code-reviewer` agent with scope = "phase 2 share-promotion (skill kind), see plan and spec." Land the merge to main.

---

## Appendix: rough timing

| Task | Est | Notes |
|---|---:|---|
| 1 config + mount + dir bootstrap | 30m | three files + one compose edit |
| 2 share-fs helpers | 1.5h | the bulk of new code; six pure helpers + 12 tests |
| 3 skill submit branch | 1h | repo edit + 4 tests |
| 4 skill approve branch | 1h | repo edit + 3 tests |
| 5 snapshot/file route | 45m | one route + 3 tests + threading paths |
| 6 adapter HTTP proxy + nginx | 1h | upload-http extension + nginx block + 3 tests |
| 7 skills_list NATS RPC | 30m | one helper + RPC case + 3 tests |
| 8 frontend types/services/store | 30m | scaffolding |
| 9 SkillsPanel + SkillRow | 1h | listing + share submit modal |
| 10 ShareDetail skill preview | 45m | manifest + file tree + click-fetch |
| 11 MainLayout Skills tab | 30m | tab + render branch + smoke |

Total: ~9 hours of focused work, similar shape to phase 1.
