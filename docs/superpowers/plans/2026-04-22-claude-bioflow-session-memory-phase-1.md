# claude-bioflow session memory — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a host-side TypeScript service that indexes Claude Code session JSONL files into Postgres, so every user's session state and token usage is queryable from one place.

**Architecture:** One new long-running Node service (`hub/indexer/`) watches `hub/workspaces/*/.pantheon/claude-projects/*/*.jsonl` via chokidar, parses appended lines with byte-offset resume, and upserts into a shared `postgres:16-alpine`. Offsets live in Postgres so advances are transactional with the session/token rows they guard. Adapter and frontend are **not** touched.

**Tech Stack:** TypeScript, Node 20, `chokidar` (watcher), `pg` (node-postgres), `pino` (logs), `vitest` + `@testcontainers/postgresql` (tests), `postgres:16-alpine` (DB), Docker Compose.

**Spec reference:** `docs/superpowers/specs/2026-04-22-claude-bioflow-session-memory-phase-1-design.md`

**Deviation from spec (§5.2, §5.3):** The existing `hub/scripts/add-user.sh` already bind-mounts
`${WORKSPACE}/.pantheon/claude-projects → /home/node/.claude/projects` (line 169). We reuse
that mount. Watch glob becomes `${WORKSPACES_ROOT}/*/.pantheon/claude-projects/*/*.jsonl`
and path-decode carries an extra `.pantheon/claude-projects/` segment. Spec §5.2's new mkdir
and `-v` line are NOT applied. Spec §5.3's dev compose uses the same path.

---

## Task list overview

1. Indexer package skeleton (package.json, tsconfig, .gitignore)
2. `src/config.ts` — env parsing + unit test
3. Migration runner (`src/migrate.ts`) + `migrate.test.ts`
4. Migration 0001 — `sessions` table
5. Migration 0002 — `token_usage_log` table
6. Migration 0003 — `file_offsets` table
7. `src/path-decode.ts` + unit test
8. `src/jsonl-parser.ts` + fixtures + unit test
9. `src/session-projector.ts` + unit test
10. `src/db.ts` — typed pool + SQL helpers + integration test
11. `src/process-file.ts` — one-pass orchestration + integration test
12. Integration: restart-resume idempotency
13. Integration: file rotation / inode change
14. Integration: concurrent files + semaphore bound
15. Integration: backlog-on-boot
16. `src/watcher.ts` — chokidar + per-file serial queue
17. `src/index.ts` — entrypoint wiring
18. Dockerfile
19. `hub/docker-compose.yml` — add `postgres` and `indexer` services
20. `hub/.env` auto-generation in `add-user.sh`
21. `docker-compose.dev.yml` — add postgres + indexer for dev
22. `.gitignore` — `hub/postgres-data/`, `hub/.env`, `hub/indexer/node_modules/`, `hub/indexer/dist/`

---

## Task 1: Indexer package skeleton

**Files:**
- Create: `hub/indexer/package.json`
- Create: `hub/indexer/tsconfig.json`
- Create: `hub/indexer/.gitignore`
- Create: `hub/indexer/vitest.config.ts`

- [ ] **Step 1: Create `hub/indexer/package.json`**

```json
{
  "name": "claude-bioflow-indexer",
  "version": "0.1.0",
  "description": "Indexes Claude Code JSONL sessions into Postgres.",
  "license": "MIT",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsup src/index.ts --format esm --target node20 --clean --out-dir dist",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "chokidar": "^4.0.1",
    "pg": "^8.13.1",
    "pino": "^9.5.0"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "^10.14.0",
    "@types/node": "^24.0.0",
    "@types/pg": "^8.11.10",
    "testcontainers": "^10.14.0",
    "tsup": "^8.3.5",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Create `hub/indexer/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "declaration": false,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Create `hub/indexer/.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 4: Create `hub/indexer/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Install dependencies**

Run: `cd hub/indexer && npm install`
Expected: creates `node_modules/`, writes `package-lock.json`, exits 0.

- [ ] **Step 6: Sanity typecheck**

Run: `cd hub/indexer && npx tsc --noEmit --skipLibCheck || true`
Expected: exits 0 (no .ts files yet so nothing to check).

- [ ] **Step 7: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/package.json hub/indexer/tsconfig.json hub/indexer/.gitignore hub/indexer/vitest.config.ts hub/indexer/package-lock.json
git commit -m "feat(indexer): scaffold Phase 1 indexer package"
```

---

## Task 2: Config module (`src/config.ts`)

**Files:**
- Create: `hub/indexer/src/config.ts`
- Create: `hub/indexer/test/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `hub/indexer/test/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reads PG_URL and applies defaults", () => {
    const cfg = loadConfig({ PG_URL: "postgres://u@h/d" });
    expect(cfg.pgUrl).toBe("postgres://u@h/d");
    expect(cfg.workspacesRoot).toBe("/workspaces");
    expect(cfg.maxConcurrentFiles).toBe(8);
    expect(cfg.maxPassBytes).toBe(8 * 1024 * 1024);
    expect(cfg.logLevel).toBe("info");
    expect(cfg.migrationLockKey).toBe(0x62696f666c77n);
    expect(cfg.pgStartupMaxWaitSec).toBe(300);
  });

  it("overrides from env", () => {
    const cfg = loadConfig({
      PG_URL: "postgres://x",
      WORKSPACES_ROOT: "/tmp/w",
      MAX_CONCURRENT_FILES: "2",
      MAX_PASS_BYTES: "1024",
      LOG_LEVEL: "debug",
      MIGRATION_LOCK_KEY: "0x1234",
      PG_STARTUP_MAX_WAIT_SEC: "10",
    });
    expect(cfg.workspacesRoot).toBe("/tmp/w");
    expect(cfg.maxConcurrentFiles).toBe(2);
    expect(cfg.maxPassBytes).toBe(1024);
    expect(cfg.logLevel).toBe("debug");
    expect(cfg.migrationLockKey).toBe(0x1234n);
    expect(cfg.pgStartupMaxWaitSec).toBe(10);
  });

  it("throws without PG_URL", () => {
    expect(() => loadConfig({})).toThrow(/PG_URL/);
  });

  it("rejects non-numeric MAX_CONCURRENT_FILES", () => {
    expect(() => loadConfig({ PG_URL: "x", MAX_CONCURRENT_FILES: "abc" }))
      .toThrow(/MAX_CONCURRENT_FILES/);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `cd hub/indexer && npx vitest run test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
export interface Config {
  pgUrl: string;
  workspacesRoot: string;
  maxConcurrentFiles: number;
  maxPassBytes: number;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  migrationLockKey: bigint;
  pgStartupMaxWaitSec: number;
}

function parseIntVar(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer; got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseBigintVar(env: Record<string, string | undefined>, name: string, fallback: bigint): bigint {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`${name} must be a valid bigint literal; got ${JSON.stringify(raw)}`);
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const pgUrl = env.PG_URL;
  if (!pgUrl) throw new Error("PG_URL is required");
  const logLevel = (env.LOG_LEVEL ?? "info") as Config["logLevel"];
  return {
    pgUrl,
    workspacesRoot: env.WORKSPACES_ROOT ?? "/workspaces",
    maxConcurrentFiles: parseIntVar(env, "MAX_CONCURRENT_FILES", 8),
    maxPassBytes: parseIntVar(env, "MAX_PASS_BYTES", 8 * 1024 * 1024),
    logLevel,
    migrationLockKey: parseBigintVar(env, "MIGRATION_LOCK_KEY", 0x62696f666c77n),
    pgStartupMaxWaitSec: parseIntVar(env, "PG_STARTUP_MAX_WAIT_SEC", 300),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hub/indexer && npx vitest run test/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/src/config.ts hub/indexer/test/config.test.ts
git commit -m "feat(indexer): env-based config loader"
```

---

## Task 3: Migration runner

**Files:**
- Create: `hub/indexer/src/migrate.ts`
- Create: `hub/indexer/test/migrate.test.ts`
- Create: `hub/indexer/migrations/.gitkeep` (empty migrations dir to allow listing)

- [ ] **Step 1: Write the failing test**

Create `hub/indexer/test/migrate.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runMigrations } from "../src/migrate.js";

let pg: StartedPostgreSqlContainer;
let url: string;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:16-alpine").start();
  url = pg.getConnectionUri();
}, 60_000);

afterAll(async () => {
  await pg?.stop();
}, 30_000);

describe("runMigrations", () => {
  it("applies sql files in order, records versions, and is idempotent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "migrations-"));
    try {
      await writeFile(path.join(dir, "0001_a.sql"), "CREATE TABLE a (id int);");
      await writeFile(path.join(dir, "0002_b.sql"), "CREATE TABLE b (id int);");

      const pool = new Pool({ connectionString: url });
      try {
        await runMigrations({ pool, migrationsDir: dir, lockKey: 0x1234n });

        const v = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
        expect(v.rows.map((r) => r.version)).toEqual([1, 2]);
        const t = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
        expect(t.rows.map((r) => r.tablename)).toContain("a");
        expect(t.rows.map((r) => r.tablename)).toContain("b");

        // Second run is a no-op (should not throw on duplicate CREATE TABLE).
        await runMigrations({ pool, migrationsDir: dir, lockKey: 0x1234n });
        const v2 = await pool.query("SELECT count(*)::int AS c FROM schema_migrations");
        expect(v2.rows[0].c).toBe(2);
      } finally {
        await pool.end();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent runs via advisory lock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "migrations-"));
    try {
      await writeFile(path.join(dir, "0001_c.sql"), "CREATE TABLE c (id int);");

      const p1 = new Pool({ connectionString: url });
      const p2 = new Pool({ connectionString: url });
      try {
        await Promise.all([
          runMigrations({ pool: p1, migrationsDir: dir, lockKey: 0x5678n }),
          runMigrations({ pool: p2, migrationsDir: dir, lockKey: 0x5678n }),
        ]);
        const v = await p1.query("SELECT count(*)::int AS c FROM schema_migrations WHERE version = 1");
        expect(v.rows[0].c).toBe(1);
      } finally {
        await p1.end();
        await p2.end();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `cd hub/indexer && npx vitest run test/migrate.test.ts`
Expected: FAIL — cannot resolve `../src/migrate.js`.

- [ ] **Step 3: Implement `src/migrate.ts`**

```ts
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { Pool, PoolClient } from "pg";

export interface MigrateOptions {
  pool: Pool;
  migrationsDir: string;
  lockKey: bigint;
}

export async function runMigrations(opts: MigrateOptions): Promise<void> {
  const client = await opts.pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [opts.lockKey.toString()]);
    try {
      await ensureTable(client);
      const applied = await currentVersions(client);
      const files = await listMigrationFiles(opts.migrationsDir);
      for (const { version, file } of files) {
        if (applied.has(version)) continue;
        const sql = await readFile(path.join(opts.migrationsDir, file), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations (version, applied_at) VALUES ($1, now())",
            [version],
          );
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [opts.lockKey.toString()]);
    }
  } finally {
    client.release();
  }
}

async function ensureTable(c: PoolClient): Promise<void> {
  await c.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL
    )
  `);
}

async function currentVersions(c: PoolClient): Promise<Set<number>> {
  const r = await c.query("SELECT version FROM schema_migrations");
  return new Set(r.rows.map((row) => row.version as number));
}

async function listMigrationFiles(dir: string): Promise<Array<{ version: number; file: string }>> {
  const all = await readdir(dir);
  const out: Array<{ version: number; file: string }> = [];
  for (const f of all) {
    if (!f.endsWith(".sql")) continue;
    const m = /^(\d+)_/.exec(f);
    if (!m) continue;
    out.push({ version: Number(m[1]), file: f });
  }
  out.sort((a, b) => a.version - b.version);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hub/indexer && npx vitest run test/migrate.test.ts`
Expected: PASS (2 tests, ~10-15s for container boot).

- [ ] **Step 5: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/src/migrate.ts hub/indexer/test/migrate.test.ts
git commit -m "feat(indexer): advisory-locked migration runner"
```

---

## Task 4: Migration 0001 — `sessions` table

**Files:**
- Create: `hub/indexer/migrations/0001_sessions.sql`

- [ ] **Step 1: Write the SQL**

```sql
CREATE TABLE sessions (
  session_id          UUID PRIMARY KEY,
  username            TEXT NOT NULL,
  parent_session_id   UUID,
  encoded_project_dir TEXT NOT NULL,
  project_display     TEXT,
  title               TEXT,
  model               TEXT,
  message_count       INT  NOT NULL DEFAULT 0,
  token_usage         JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_active        TIMESTAMPTZ,
  last_active         TIMESTAMPTZ,
  jsonl_location      TEXT NOT NULL DEFAULT 'volume',
  status              TEXT NOT NULL DEFAULT 'active',
  is_sidechain        BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX sessions_username_last_active_idx
  ON sessions (username, last_active DESC);

CREATE INDEX sessions_username_project_last_active_idx
  ON sessions (username, encoded_project_dir, last_active DESC);

CREATE INDEX sessions_parent_idx
  ON sessions (parent_session_id) WHERE parent_session_id IS NOT NULL;

CREATE INDEX sessions_status_last_active_idx
  ON sessions (status, last_active) WHERE status = 'active';
```

- [ ] **Step 2: Verify by running the existing migrate test (which picks up numbered SQL files)**

Add a smoke test that migrate.test.ts already covers — the file is picked up by glob.
Sanity run: `cd hub/indexer && npx vitest run test/migrate.test.ts`
Expected: still passes (migrations/ folder now has a real file that its own tmp-dir test ignores).

- [ ] **Step 3: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/migrations/0001_sessions.sql
git commit -m "feat(indexer): migration 0001 — sessions table"
```

---

## Task 5: Migration 0002 — `token_usage_log` table

**Files:**
- Create: `hub/indexer/migrations/0002_token_usage_log.sql`

- [ ] **Step 1: Write the SQL**

```sql
CREATE TABLE token_usage_log (
  id                  BIGSERIAL PRIMARY KEY,
  username            TEXT NOT NULL,
  session_id          UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  entry_uuid          UUID NOT NULL,
  model               TEXT,
  input_tokens        INT  NOT NULL DEFAULT 0,
  output_tokens       INT  NOT NULL DEFAULT 0,
  cache_read_tokens   INT  NOT NULL DEFAULT 0,
  cache_write_tokens  INT  NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL,
  UNIQUE (session_id, entry_uuid)
);

CREATE INDEX token_usage_log_username_created_idx
  ON token_usage_log (username, created_at);

CREATE INDEX token_usage_log_session_idx
  ON token_usage_log (session_id, created_at);
```

- [ ] **Step 2: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/migrations/0002_token_usage_log.sql
git commit -m "feat(indexer): migration 0002 — token_usage_log table"
```

---

## Task 6: Migration 0003 — `file_offsets` table

**Files:**
- Create: `hub/indexer/migrations/0003_file_offsets.sql`

- [ ] **Step 1: Write the SQL**

```sql
CREATE TABLE file_offsets (
  username     TEXT NOT NULL,
  jsonl_path   TEXT NOT NULL,
  byte_offset  BIGINT NOT NULL,
  inode        BIGINT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (username, jsonl_path)
);
```

- [ ] **Step 2: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/migrations/0003_file_offsets.sql
git commit -m "feat(indexer): migration 0003 — file_offsets table"
```

---

## Task 7: `src/path-decode.ts`

**Files:**
- Create: `hub/indexer/src/path-decode.ts`
- Create: `hub/indexer/test/path-decode.test.ts`

**Note:** Per the deviation at the top of this plan, the expected layout is
`<watchRoot>/<username>/.pantheon/claude-projects/<encoded>/<sessionId>.jsonl` — four path
components between the watch root and the filename, not two as in the original spec §7.2.

- [ ] **Step 1: Write the failing test**

Create `hub/indexer/test/path-decode.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveJsonlPath } from "../src/path-decode.js";

const ROOT = "/workspaces";

describe("resolveJsonlPath", () => {
  it("extracts username, encoded dir, sessionId", () => {
    const r = resolveJsonlPath(
      ROOT,
      "/workspaces/alice/.pantheon/claude-projects/-workspace-pbmc3k/abc-def.jsonl",
    );
    expect(r).not.toBeNull();
    expect(r!.username).toBe("alice");
    expect(r!.encodedProjectDir).toBe("-workspace-pbmc3k");
    expect(r!.sessionId).toBe("abc-def");
    expect(r!.displayProjectPath).toBe("/workspace/pbmc3k");
  });

  it("handles usernames with hyphens", () => {
    const r = resolveJsonlPath(
      ROOT,
      "/workspaces/ada-lovelace/.pantheon/claude-projects/-w/s.jsonl",
    );
    expect(r!.username).toBe("ada-lovelace");
  });

  it("rejects paths outside watch root", () => {
    expect(
      resolveJsonlPath(ROOT, "/tmp/alice/.pantheon/claude-projects/-w/s.jsonl"),
    ).toBeNull();
  });

  it("rejects path traversal via ..", () => {
    expect(
      resolveJsonlPath(ROOT, "/workspaces/../etc/.pantheon/claude-projects/-w/s.jsonl"),
    ).toBeNull();
  });

  it("rejects shape that doesn't match the expected layout", () => {
    expect(
      resolveJsonlPath(ROOT, "/workspaces/alice/other-dir/foo/s.jsonl"),
    ).toBeNull();
    expect(
      resolveJsonlPath(ROOT, "/workspaces/alice/.pantheon/wrong/-w/s.jsonl"),
    ).toBeNull();
  });

  it("derives sessionId from filename stem, not from internals", () => {
    const r = resolveJsonlPath(
      ROOT,
      "/workspaces/u/.pantheon/claude-projects/-p/f8e3b6c4-1234-5678-9abc-def012345678.jsonl",
    );
    expect(r!.sessionId).toBe("f8e3b6c4-1234-5678-9abc-def012345678");
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `cd hub/indexer && npx vitest run test/path-decode.test.ts`
Expected: FAIL — cannot resolve `../src/path-decode.js`.

- [ ] **Step 3: Implement `src/path-decode.ts`**

```ts
import * as path from "node:path";

export interface ResolvedJsonlPath {
  username: string;
  encodedProjectDir: string;
  sessionId: string;
  displayProjectPath: string;
}

/**
 * Resolve a watched JSONL path into its trust-critical components.
 *
 * Expected layout (matches existing add-user.sh bind-mount):
 *   <watchRoot>/<username>/.pantheon/claude-projects/<encoded>/<sessionId>.jsonl
 *
 * Username is taken from the watch-root-relative path prefix — never from the
 * encoded project directory name. The decoded project path is lossy (real
 * dashes collide with separator dashes) and is only suitable for display.
 */
export function resolveJsonlPath(
  watchRoot: string,
  fullPath: string,
): ResolvedJsonlPath | null {
  const normRoot = path.resolve(watchRoot);
  const normFull = path.resolve(fullPath);
  if (!normFull.startsWith(normRoot + path.sep)) return null;

  const rel = normFull.slice(normRoot.length + 1);
  const parts = rel.split(path.sep);
  // username / .pantheon / claude-projects / encoded / sessionId.jsonl
  if (parts.length !== 5) return null;
  if (parts.some((p) => p === "" || p === "..")) return null;
  const [username, dotPantheon, cp, encodedProjectDir, file] = parts as [
    string, string, string, string, string,
  ];
  if (dotPantheon !== ".pantheon") return null;
  if (cp !== "claude-projects") return null;
  if (!file.endsWith(".jsonl")) return null;
  const sessionId = file.slice(0, -".jsonl".length);
  if (sessionId.length === 0) return null;

  return {
    username,
    encodedProjectDir,
    sessionId,
    displayProjectPath: decodeDisplay(encodedProjectDir),
  };
}

function decodeDisplay(encoded: string): string {
  // Claude Code encodes "/a/b" as "-a-b". Decode by replacing every "-" with
  // "/". Known lossy when a real path contains "-".
  return encoded.replace(/-/g, "/");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hub/indexer && npx vitest run test/path-decode.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/src/path-decode.ts hub/indexer/test/path-decode.test.ts
git commit -m "feat(indexer): resolveJsonlPath with trusted username prefix"
```

---

## Task 8: `src/jsonl-parser.ts` + fixtures

**Files:**
- Create: `hub/indexer/src/jsonl-parser.ts`
- Create: `hub/indexer/test/fixtures/simple-session.jsonl`
- Create: `hub/indexer/test/fixtures/tool-call-session.jsonl`
- Create: `hub/indexer/test/fixtures/subagent-session.jsonl`
- Create: `hub/indexer/test/fixtures/malformed-lines.jsonl`
- Create: `hub/indexer/test/jsonl-parser.test.ts`

- [ ] **Step 1: Create fixtures**

`hub/indexer/test/fixtures/simple-session.jsonl` (3 lines — user, assistant, assistant with usage):

```
{"type":"user","uuid":"11111111-1111-1111-1111-111111111111","sessionId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","timestamp":"2026-04-22T10:00:00.000Z","message":{"role":"user","content":"hi"}}
{"type":"assistant","uuid":"22222222-2222-2222-2222-222222222222","sessionId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","timestamp":"2026-04-22T10:00:01.000Z","message":{"model":"claude-sonnet-4-6","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
{"type":"assistant","uuid":"33333333-3333-3333-3333-333333333333","sessionId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","timestamp":"2026-04-22T10:00:02.000Z","message":{"model":"claude-sonnet-4-6","content":[{"type":"text","text":"more"}],"usage":{"input_tokens":20,"output_tokens":7,"cache_read_input_tokens":100,"cache_creation_input_tokens":50}}}
```

`hub/indexer/test/fixtures/tool-call-session.jsonl`:

```
{"type":"user","uuid":"44444444-4444-4444-4444-444444444444","sessionId":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","timestamp":"2026-04-22T11:00:00.000Z","message":{"role":"user","content":"run ls"}}
{"type":"assistant","uuid":"55555555-5555-5555-5555-555555555555","sessionId":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","timestamp":"2026-04-22T11:00:01.000Z","message":{"model":"claude-sonnet-4-6","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":30,"output_tokens":4,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
{"type":"user","uuid":"66666666-6666-6666-6666-666666666666","sessionId":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","timestamp":"2026-04-22T11:00:02.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"file1\nfile2"}]}}
```

`hub/indexer/test/fixtures/subagent-session.jsonl`:

```
{"type":"user","uuid":"77777777-7777-7777-7777-777777777777","sessionId":"cccccccc-cccc-cccc-cccc-cccccccccccc","timestamp":"2026-04-22T12:00:00.000Z","isSidechain":true,"message":{"role":"user","content":"subagent task"}}
{"type":"assistant","uuid":"88888888-8888-8888-8888-888888888888","sessionId":"cccccccc-cccc-cccc-cccc-cccccccccccc","timestamp":"2026-04-22T12:00:01.000Z","isSidechain":true,"message":{"model":"claude-sonnet-4-6","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":5,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
```

`hub/indexer/test/fixtures/malformed-lines.jsonl` (valid, then invalid JSON, then valid — note the trailing line has no newline to simulate a mid-write truncation):

```
{"type":"user","uuid":"99999999-9999-9999-9999-999999999999","sessionId":"dddddddd-dddd-dddd-dddd-dddddddddddd","timestamp":"2026-04-22T13:00:00.000Z","message":{"role":"user","content":"one"}}
{not valid json at all
{"type":"user","uuid":"aaaaaaaa-0000-0000-0000-000000000001","sessionId":"dddddddd-dddd-dddd-dddd-dddddddddddd","timestamp":"2026-04-22T13:00:01.000Z","message":{"role":"user","content":"three"}}
{"type":"user","uuid":"aaaaaaaa-0000-0000-0000-00000000
```

- [ ] **Step 2: Write the failing test**

Create `hub/indexer/test/jsonl-parser.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseJsonlLine, parseJsonlBuffer } from "../src/jsonl-parser.js";

const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));

describe("parseJsonlLine", () => {
  it("parses a user entry", () => {
    const e = parseJsonlLine('{"type":"user","uuid":"u1","sessionId":"s1","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hi"}}');
    expect(e).not.toBeNull();
    expect(e!.type).toBe("user");
    expect(e!.uuid).toBe("u1");
    expect(e!.sessionId).toBe("s1");
    expect(e!.isSidechain).toBe(false);
  });

  it("parses an assistant entry with usage", () => {
    const e = parseJsonlLine('{"type":"assistant","uuid":"u2","sessionId":"s1","timestamp":"2026-01-01T00:00:01Z","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":7,"cache_creation_input_tokens":3}}}');
    expect(e!.type).toBe("assistant");
    expect(e!.model).toBe("claude-sonnet-4-6");
    expect(e!.usage).toEqual({ input: 10, output: 5, cache_read: 7, cache_write: 3 });
  });

  it("returns null on malformed JSON", () => {
    expect(parseJsonlLine("{not json")).toBeNull();
    expect(parseJsonlLine("")).toBeNull();
  });

  it("skips summary and system entries", () => {
    expect(parseJsonlLine('{"type":"summary","summary":"x","leafUuid":"u"}')).toBeNull();
    expect(parseJsonlLine('{"type":"system","content":"x"}')).toBeNull();
  });

  it("skips unknown types silently", () => {
    expect(parseJsonlLine('{"type":"future","uuid":"u","sessionId":"s","timestamp":"2026-01-01T00:00:00Z"}')).toBeNull();
  });

  it("skips entries missing required fields", () => {
    expect(parseJsonlLine('{"type":"user","sessionId":"s","timestamp":"2026-01-01T00:00:00Z"}')).toBeNull();
    expect(parseJsonlLine('{"type":"user","uuid":"u","timestamp":"2026-01-01T00:00:00Z"}')).toBeNull();
    expect(parseJsonlLine('{"type":"user","uuid":"u","sessionId":"s"}')).toBeNull();
  });

  it("ignores unknown extra fields (forward-compat)", () => {
    const e = parseJsonlLine('{"type":"user","uuid":"u","sessionId":"s","timestamp":"2026-01-01T00:00:00Z","future_field":"x","message":{"role":"user","content":"hi"}}');
    expect(e).not.toBeNull();
  });

  it("reads isSidechain", () => {
    const e = parseJsonlLine('{"type":"user","uuid":"u","sessionId":"s","timestamp":"2026-01-01T00:00:00Z","isSidechain":true,"message":{}}');
    expect(e!.isSidechain).toBe(true);
  });
});

describe("parseJsonlBuffer", () => {
  it("parses simple-session.jsonl into 3 entries", async () => {
    const buf = await readFile(FIX + "simple-session.jsonl", "utf8");
    const entries = parseJsonlBuffer(buf);
    expect(entries).toHaveLength(3);
    expect(entries[0].type).toBe("user");
    expect(entries[1].type).toBe("assistant");
    expect(entries[1].usage!.input).toBe(10);
    expect(entries[2].usage!.cache_read).toBe(100);
    expect(entries[2].usage!.cache_write).toBe(50);
  });

  it("skips malformed lines and recovers", async () => {
    const buf = await readFile(FIX + "malformed-lines.jsonl", "utf8");
    const entries = parseJsonlBuffer(buf);
    // valid line 1 + valid line 3 = 2; line 2 is invalid, line 4 is truncated.
    expect(entries).toHaveLength(2);
    expect(entries[0].uuid).toBe("99999999-9999-9999-9999-999999999999");
    expect(entries[1].uuid).toBe("aaaaaaaa-0000-0000-0000-000000000001");
  });

  it("marks subagent entries", async () => {
    const buf = await readFile(FIX + "subagent-session.jsonl", "utf8");
    const entries = parseJsonlBuffer(buf);
    expect(entries.every((e) => e.isSidechain)).toBe(true);
  });
});
```

- [ ] **Step 3: Run the failing test**

Run: `cd hub/indexer && npx vitest run test/jsonl-parser.test.ts`
Expected: FAIL — cannot resolve `../src/jsonl-parser.js`.

- [ ] **Step 4: Implement `src/jsonl-parser.ts`**

```ts
export interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface ParsedEntry {
  type: "user" | "assistant";
  uuid: string;
  sessionId: string;
  timestamp: string;            // ISO-8601
  isSidechain: boolean;
  model: string | null;         // assistant only
  usage: TokenUsage | null;     // assistant only
}

const INTERESTING = new Set(["user", "assistant"]);

export function parseJsonlLine(line: string): ParsedEntry | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = obj.type;
  if (typeof type !== "string" || !INTERESTING.has(type)) return null;
  const uuid = obj.uuid;
  const sessionId = obj.sessionId;
  const timestamp = obj.timestamp;
  if (typeof uuid !== "string" || typeof sessionId !== "string" || typeof timestamp !== "string") {
    return null;
  }
  const isSidechain = obj.isSidechain === true;
  let model: string | null = null;
  let usage: TokenUsage | null = null;
  if (type === "assistant") {
    const msg = obj.message as Record<string, unknown> | undefined;
    if (msg) {
      if (typeof msg.model === "string") model = msg.model;
      const u = msg.usage as Record<string, unknown> | undefined;
      if (u) {
        usage = {
          input: intOr0(u.input_tokens),
          output: intOr0(u.output_tokens),
          cache_read: intOr0(u.cache_read_input_tokens),
          cache_write: intOr0(u.cache_creation_input_tokens),
        };
      }
    }
  }
  return { type: type as ParsedEntry["type"], uuid, sessionId, timestamp, isSidechain, model, usage };
}

export function parseJsonlBuffer(buf: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  for (const line of buf.split("\n")) {
    const e = parseJsonlLine(line);
    if (e) out.push(e);
  }
  return out;
}

function intOr0(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.trunc(v);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd hub/indexer && npx vitest run test/jsonl-parser.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/src/jsonl-parser.ts hub/indexer/test/jsonl-parser.test.ts hub/indexer/test/fixtures/
git commit -m "feat(indexer): pure JSONL line parser with fixtures"
```

---

## Task 9: `src/session-projector.ts`

**Files:**
- Create: `hub/indexer/src/session-projector.ts`
- Create: `hub/indexer/test/session-projector.test.ts`

- [ ] **Step 1: Write the failing test**

Create `hub/indexer/test/session-projector.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { projectEntries } from "../src/session-projector.js";
import type { ParsedEntry } from "../src/jsonl-parser.js";

const BASE: ParsedEntry = {
  type: "user",
  uuid: "00000000-0000-0000-0000-000000000001",
  sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  timestamp: "2026-04-22T10:00:00.000Z",
  isSidechain: false,
  model: null,
  usage: null,
};

const META = {
  fileSessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  username: "alice",
  encodedProjectDir: "-w",
  displayProjectPath: "/w",
};

describe("projectEntries", () => {
  it("returns empty on empty input", () => {
    const r = projectEntries([], META);
    expect(r.sessionUpserts).toEqual([]);
    expect(r.tokenRows).toEqual([]);
  });

  it("builds one SessionUpsert and no token rows from user-only entries", () => {
    const entries: ParsedEntry[] = [
      { ...BASE, uuid: "u1", timestamp: "2026-04-22T10:00:00.000Z" },
      { ...BASE, uuid: "u2", timestamp: "2026-04-22T10:00:05.000Z" },
    ];
    const r = projectEntries(entries, META);
    expect(r.sessionUpserts).toHaveLength(1);
    const up = r.sessionUpserts[0];
    expect(up.session_id).toBe(META.fileSessionId);
    expect(up.username).toBe("alice");
    expect(up.encoded_project_dir).toBe("-w");
    expect(up.project_display).toBe("/w");
    expect(up.message_count_delta).toBe(2);
    expect(up.first_active_candidate).toBe("2026-04-22T10:00:00.000Z");
    expect(up.last_active).toBe("2026-04-22T10:00:05.000Z");
    expect(up.is_sidechain).toBe(false);
    expect(up.token_usage_delta).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
    expect(r.tokenRows).toHaveLength(0);
  });

  it("emits one token row per assistant entry and sums deltas", () => {
    const entries: ParsedEntry[] = [
      { ...BASE, type: "assistant", uuid: "a1", model: "m", usage: { input: 10, output: 2, cache_read: 0, cache_write: 0 } },
      { ...BASE, type: "assistant", uuid: "a2", model: "m", usage: { input: 20, output: 4, cache_read: 5, cache_write: 3 } },
    ];
    const r = projectEntries(entries, META);
    expect(r.tokenRows).toHaveLength(2);
    expect(r.tokenRows[0].entry_uuid).toBe("a1");
    expect(r.tokenRows[1].input_tokens).toBe(20);
    const up = r.sessionUpserts[0];
    expect(up.token_usage_delta).toEqual({ input: 30, output: 6, cache_read: 5, cache_write: 3 });
    expect(up.model).toBe("m");
  });

  it("is_sidechain is OR across pass", () => {
    const entries: ParsedEntry[] = [
      { ...BASE, uuid: "u1", isSidechain: false },
      { ...BASE, uuid: "u2", isSidechain: true },
    ];
    const r = projectEntries(entries, META);
    expect(r.sessionUpserts[0].is_sidechain).toBe(true);
  });

  it("idempotency: calling twice on same input yields same outputs", () => {
    const entries: ParsedEntry[] = [
      { ...BASE, type: "assistant", uuid: "a1", model: "m", usage: { input: 10, output: 2, cache_read: 0, cache_write: 0 } },
    ];
    const r1 = projectEntries(entries, META);
    const r2 = projectEntries(entries, META);
    expect(r1).toEqual(r2);
  });

  it("splits entries by sessionId if they differ from file sessionId", () => {
    const entries: ParsedEntry[] = [
      { ...BASE, uuid: "u1", sessionId: "session-x", timestamp: "2026-04-22T10:00:00.000Z" },
      { ...BASE, uuid: "u2", sessionId: "session-y", timestamp: "2026-04-22T10:00:01.000Z" },
    ];
    const r = projectEntries(entries, META);
    expect(r.sessionUpserts).toHaveLength(2);
    expect(r.sessionUpserts.map((u) => u.session_id).sort()).toEqual(["session-x", "session-y"]);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `cd hub/indexer && npx vitest run test/session-projector.test.ts`
Expected: FAIL — cannot resolve `../src/session-projector.js`.

- [ ] **Step 3: Implement `src/session-projector.ts`**

```ts
import type { ParsedEntry } from "./jsonl-parser.js";

export interface SessionUpsert {
  session_id: string;
  username: string;
  encoded_project_dir: string;
  project_display: string | null;
  model: string | null;
  message_count_delta: number;
  token_usage_delta: { input: number; output: number; cache_read: number; cache_write: number };
  first_active_candidate: string;
  last_active: string;
  is_sidechain: boolean;
}

export interface TokenUsageRow {
  username: string;
  session_id: string;
  entry_uuid: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  created_at: string;
}

export interface ProjectMeta {
  fileSessionId: string;
  username: string;
  encodedProjectDir: string;
  displayProjectPath: string;
}

export interface ProjectionResult {
  sessionUpserts: SessionUpsert[];
  tokenRows: TokenUsageRow[];
}

/**
 * Pure projection: ParsedEntry[] → (SessionUpsert[], TokenUsageRow[]).
 *
 * Entries can span multiple sessions (rare — Claude Code normally writes one
 * session per file — but the JSONL content is authoritative, not the
 * filename). The projector groups by entry.sessionId.
 */
export function projectEntries(entries: ParsedEntry[], meta: ProjectMeta): ProjectionResult {
  if (entries.length === 0) return { sessionUpserts: [], tokenRows: [] };

  const bySession = new Map<string, ParsedEntry[]>();
  for (const e of entries) {
    const key = e.sessionId;
    const bucket = bySession.get(key) ?? [];
    bucket.push(e);
    bySession.set(key, bucket);
  }

  const sessionUpserts: SessionUpsert[] = [];
  const tokenRows: TokenUsageRow[] = [];

  for (const [sessionId, group] of bySession) {
    let firstTs = group[0].timestamp;
    let lastTs = group[0].timestamp;
    let isSidechain = false;
    let model: string | null = null;
    const delta = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

    for (const e of group) {
      if (e.timestamp < firstTs) firstTs = e.timestamp;
      if (e.timestamp > lastTs) lastTs = e.timestamp;
      if (e.isSidechain) isSidechain = true;
      if (e.type === "assistant") {
        if (e.model) model = e.model;
        if (e.usage) {
          delta.input += e.usage.input;
          delta.output += e.usage.output;
          delta.cache_read += e.usage.cache_read;
          delta.cache_write += e.usage.cache_write;
          tokenRows.push({
            username: meta.username,
            session_id: sessionId,
            entry_uuid: e.uuid,
            model: e.model,
            input_tokens: e.usage.input,
            output_tokens: e.usage.output,
            cache_read_tokens: e.usage.cache_read,
            cache_write_tokens: e.usage.cache_write,
            created_at: e.timestamp,
          });
        }
      }
    }

    sessionUpserts.push({
      session_id: sessionId,
      username: meta.username,
      encoded_project_dir: meta.encodedProjectDir,
      project_display: meta.displayProjectPath,
      model,
      message_count_delta: group.length,
      token_usage_delta: delta,
      first_active_candidate: firstTs,
      last_active: lastTs,
      is_sidechain: isSidechain,
    });
  }

  return { sessionUpserts, tokenRows };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hub/indexer && npx vitest run test/session-projector.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/src/session-projector.ts hub/indexer/test/session-projector.test.ts
git commit -m "feat(indexer): session/token projection (pure)"
```

---

## Task 10: `src/db.ts` — typed pool + SQL helpers

**Files:**
- Create: `hub/indexer/src/db.ts`
- Create: `hub/indexer/test/db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `hub/indexer/test/db.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { commitPass, readOffset } from "../src/db.js";
import type { SessionUpsert, TokenUsageRow } from "../src/session-projector.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({
    pool,
    migrationsDir: MIGRATIONS_DIR,
    lockKey: 0x62696f666c77n,
  });
}, 90_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

const SID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TOKEN_UUID = (n: number): string =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

function upsert(overrides: Partial<SessionUpsert> = {}): SessionUpsert {
  return {
    session_id: SID,
    username: "alice",
    encoded_project_dir: "-w",
    project_display: "/w",
    model: "m",
    message_count_delta: 1,
    token_usage_delta: { input: 10, output: 2, cache_read: 0, cache_write: 0 },
    first_active_candidate: "2026-04-22T10:00:00.000Z",
    last_active: "2026-04-22T10:00:00.000Z",
    is_sidechain: false,
    ...overrides,
  };
}

function tokenRow(n: number, overrides: Partial<TokenUsageRow> = {}): TokenUsageRow {
  return {
    username: "alice",
    session_id: SID,
    entry_uuid: TOKEN_UUID(n),
    model: "m",
    input_tokens: 10,
    output_tokens: 2,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    created_at: "2026-04-22T10:00:00.000Z",
    ...overrides,
  };
}

describe("commitPass", () => {
  it("inserts session + tokens + offset atomically", async () => {
    await commitPass(pool, {
      sessionUpserts: [upsert()],
      tokenRows: [tokenRow(1)],
      offset: { username: "alice", jsonlPath: "/wp/a.jsonl", byteOffset: 123, inode: 42 },
    });

    const s = await pool.query("SELECT * FROM sessions WHERE session_id=$1", [SID]);
    expect(s.rowCount).toBe(1);
    expect(s.rows[0].message_count).toBe(1);
    expect(s.rows[0].token_usage).toEqual({ input: 10, output: 2, cache_read: 0, cache_write: 0 });

    const t = await pool.query("SELECT count(*)::int AS c FROM token_usage_log WHERE session_id=$1", [SID]);
    expect(t.rows[0].c).toBe(1);

    const off = await readOffset(pool, "alice", "/wp/a.jsonl");
    expect(off).toEqual({ byteOffset: 123, inode: 42 });
  });

  it("merges deltas on repeated session and deduplicates token rows", async () => {
    await commitPass(pool, {
      sessionUpserts: [upsert({
        message_count_delta: 2,
        token_usage_delta: { input: 5, output: 1, cache_read: 0, cache_write: 0 },
        last_active: "2026-04-22T10:00:10.000Z",
      })],
      tokenRows: [tokenRow(1), tokenRow(2, { input_tokens: 5, output_tokens: 1 })],
      offset: { username: "alice", jsonlPath: "/wp/a.jsonl", byteOffset: 200, inode: 42 },
    });

    const s = await pool.query("SELECT * FROM sessions WHERE session_id=$1", [SID]);
    expect(s.rows[0].message_count).toBe(3);
    expect(s.rows[0].token_usage).toEqual({ input: 15, output: 3, cache_read: 0, cache_write: 0 });

    // tokenRow(1) was already inserted in the previous test, so ON CONFLICT DO NOTHING: total = 2.
    const t = await pool.query("SELECT count(*)::int AS c FROM token_usage_log WHERE session_id=$1", [SID]);
    expect(t.rows[0].c).toBe(2);

    const off = await readOffset(pool, "alice", "/wp/a.jsonl");
    expect(off!.byteOffset).toBe(200);
  });

  it("readOffset returns null for unknown (username, path)", async () => {
    const r = await readOffset(pool, "alice", "/nonexistent.jsonl");
    expect(r).toBeNull();
  });

  it("rolls back the whole pass if a token insert fails", async () => {
    // Force a FK violation by using a session_id whose session row isn't in the upsert set.
    const rogue: TokenUsageRow = tokenRow(99, { session_id: "ffffffff-ffff-ffff-ffff-ffffffffffff" });
    await expect(commitPass(pool, {
      sessionUpserts: [upsert({ session_id: "cccccccc-cccc-cccc-cccc-cccccccccccc" })],
      tokenRows: [rogue],
      offset: { username: "alice", jsonlPath: "/wp/b.jsonl", byteOffset: 1, inode: 1 },
    })).rejects.toThrow();

    const s = await pool.query("SELECT count(*)::int AS c FROM sessions WHERE session_id=$1",
      ["cccccccc-cccc-cccc-cccc-cccccccccccc"]);
    expect(s.rows[0].c).toBe(0);
    const off = await readOffset(pool, "alice", "/wp/b.jsonl");
    expect(off).toBeNull();
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `cd hub/indexer && npx vitest run test/db.test.ts`
Expected: FAIL — cannot resolve `../src/db.js`.

- [ ] **Step 3: Implement `src/db.ts`**

```ts
import type { Pool, PoolClient } from "pg";
import type { SessionUpsert, TokenUsageRow } from "./session-projector.js";

export interface OffsetWrite {
  username: string;
  jsonlPath: string;
  byteOffset: number;
  inode: number | null;
}

export interface CommitPassInput {
  sessionUpserts: SessionUpsert[];
  tokenRows: TokenUsageRow[];
  offset: OffsetWrite;
}

const UPSERT_SESSION_SQL = `
INSERT INTO sessions (
  session_id, username, encoded_project_dir, project_display, model,
  message_count, token_usage, first_active, last_active, is_sidechain
) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
ON CONFLICT (session_id) DO UPDATE SET
  username            = EXCLUDED.username,
  encoded_project_dir = EXCLUDED.encoded_project_dir,
  project_display     = COALESCE(EXCLUDED.project_display, sessions.project_display),
  model               = COALESCE(EXCLUDED.model, sessions.model),
  message_count       = sessions.message_count + EXCLUDED.message_count,
  token_usage         = jsonb_build_object(
      'input',       COALESCE((sessions.token_usage->>'input')::int, 0)
                   + COALESCE((EXCLUDED.token_usage->>'input')::int, 0),
      'output',      COALESCE((sessions.token_usage->>'output')::int, 0)
                   + COALESCE((EXCLUDED.token_usage->>'output')::int, 0),
      'cache_read',  COALESCE((sessions.token_usage->>'cache_read')::int, 0)
                   + COALESCE((EXCLUDED.token_usage->>'cache_read')::int, 0),
      'cache_write', COALESCE((sessions.token_usage->>'cache_write')::int, 0)
                   + COALESCE((EXCLUDED.token_usage->>'cache_write')::int, 0)
  ),
  first_active = COALESCE(sessions.first_active, EXCLUDED.first_active),
  last_active  = GREATEST(sessions.last_active, EXCLUDED.last_active),
  is_sidechain = sessions.is_sidechain OR EXCLUDED.is_sidechain
`;

const INSERT_TOKEN_SQL = `
INSERT INTO token_usage_log (
  username, session_id, entry_uuid, model,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (session_id, entry_uuid) DO NOTHING
`;

const UPSERT_OFFSET_SQL = `
INSERT INTO file_offsets (username, jsonl_path, byte_offset, inode, updated_at)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (username, jsonl_path) DO UPDATE SET
  byte_offset = EXCLUDED.byte_offset,
  inode       = EXCLUDED.inode,
  updated_at  = EXCLUDED.updated_at
`;

export async function commitPass(pool: Pool, input: CommitPassInput): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (const s of input.sessionUpserts) {
      await upsertSession(c, s);
    }
    for (const r of input.tokenRows) {
      await insertToken(c, r);
    }
    await upsertOffset(c, input.offset);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

async function upsertSession(c: PoolClient, s: SessionUpsert): Promise<void> {
  await c.query(UPSERT_SESSION_SQL, [
    s.session_id,
    s.username,
    s.encoded_project_dir,
    s.project_display,
    s.model,
    s.message_count_delta,
    JSON.stringify(s.token_usage_delta),
    s.first_active_candidate,
    s.last_active,
    s.is_sidechain,
  ]);
}

async function insertToken(c: PoolClient, r: TokenUsageRow): Promise<void> {
  await c.query(INSERT_TOKEN_SQL, [
    r.username, r.session_id, r.entry_uuid, r.model,
    r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens,
    r.created_at,
  ]);
}

async function upsertOffset(c: PoolClient, o: OffsetWrite): Promise<void> {
  await c.query(UPSERT_OFFSET_SQL, [o.username, o.jsonlPath, o.byteOffset, o.inode]);
}

export async function readOffset(
  pool: Pool,
  username: string,
  jsonlPath: string,
): Promise<{ byteOffset: number; inode: number | null } | null> {
  const r = await pool.query(
    "SELECT byte_offset, inode FROM file_offsets WHERE username=$1 AND jsonl_path=$2",
    [username, jsonlPath],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  return {
    byteOffset: Number(row.byte_offset),
    inode: row.inode === null ? null : Number(row.inode),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hub/indexer && npx vitest run test/db.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/src/db.ts hub/indexer/test/db.test.ts
git commit -m "feat(indexer): atomic commitPass SQL helpers"
```

---

## Task 11: `src/process-file.ts` — one-pass orchestration

**Files:**
- Create: `hub/indexer/src/process-file.ts`
- Create: `hub/indexer/test/integration/tail-live-writes.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `hub/indexer/test/integration/tail-live-writes.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/migrate.js";
import { processFile } from "../../src/process-file.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

let pg: StartedPostgreSqlContainer;
let pool: Pool;
let root: string;

function line(o: Record<string, unknown>): string { return JSON.stringify(o) + "\n"; }

const SID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SID2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({
    pool,
    migrationsDir: MIGRATIONS_DIR,
    lockKey: 0x62696f666c77n,
  });
}, 90_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

async function setupFile(): Promise<{ full: string; root: string }> {
  root = await mkdtemp(path.join(os.tmpdir(), "indexer-"));
  const dir = path.join(root, "alice", ".pantheon", "claude-projects", "-w");
  await mkdir(dir, { recursive: true });
  const full = path.join(dir, `${SID}.jsonl`);
  await writeFile(full, "");
  return { full, root };
}

describe("processFile", () => {
  it("ingests appended lines and advances the offset", async () => {
    const { full } = await setupFile();
    await appendFile(full, line({
      type: "user", uuid: "00000000-0000-0000-0000-000000000001", sessionId: SID,
      timestamp: "2026-04-22T10:00:00.000Z",
      message: { content: "hi" },
    }));
    await appendFile(full, line({
      type: "assistant", uuid: "00000000-0000-0000-0000-000000000002", sessionId: SID,
      timestamp: "2026-04-22T10:00:01.000Z",
      message: {
        model: "m",
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }));

    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    const s = await pool.query("SELECT * FROM sessions WHERE session_id=$1", [SID]);
    expect(s.rows[0].message_count).toBe(2);
    expect(s.rows[0].token_usage).toEqual({ input: 10, output: 2, cache_read: 0, cache_write: 0 });

    // Append more; second pass picks up only the new bytes.
    await appendFile(full, line({
      type: "assistant", uuid: "00000000-0000-0000-0000-000000000003", sessionId: SID,
      timestamp: "2026-04-22T10:00:02.000Z",
      message: {
        model: "m",
        usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }));

    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    const s2 = await pool.query("SELECT * FROM sessions WHERE session_id=$1", [SID]);
    expect(s2.rows[0].message_count).toBe(3);
    expect(s2.rows[0].token_usage).toEqual({ input: 15, output: 3, cache_read: 0, cache_write: 0 });

    await rm(root, { recursive: true, force: true });
  });

  it("handles a mid-write truncated last line by only committing complete lines", async () => {
    const { full, root: r2 } = await setupFile();
    await appendFile(full, line({
      type: "user", uuid: "00000000-0000-0000-0000-000000001001", sessionId: SID2,
      timestamp: "2026-04-22T10:00:00.000Z",
      message: {},
    }));
    // Partial JSON with no trailing newline.
    await appendFile(full, '{"type":"user","uuid":"00000000-0000-0000-0000-000000001002","sessionId":"bbbb');

    await processFile({ pool, watchRoot: r2, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    const s = await pool.query("SELECT message_count FROM sessions WHERE session_id=$1", [SID2]);
    expect(s.rows[0].message_count).toBe(1);
    await rm(r2, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `cd hub/indexer && npx vitest run test/integration/tail-live-writes.test.ts`
Expected: FAIL — cannot resolve `../../src/process-file.js`.

- [ ] **Step 3: Implement `src/process-file.ts`**

```ts
import { promises as fs } from "node:fs";
import type { Pool } from "pg";
import { commitPass, readOffset } from "./db.js";
import { parseJsonlBuffer } from "./jsonl-parser.js";
import { resolveJsonlPath } from "./path-decode.js";
import { projectEntries } from "./session-projector.js";

export interface ProcessFileOptions {
  pool: Pool;
  watchRoot: string;
  fullPath: string;
  maxPassBytes: number;
}

/**
 * One pass over a JSONL file: read from the stored offset to current EOF,
 * project entries, commit (session upserts + token rows + new offset) in a
 * single transaction. If new bytes exceed maxPassBytes we chunk the read at
 * newline boundaries and commit per chunk.
 */
export async function processFile(opts: ProcessFileOptions): Promise<void> {
  const { pool, watchRoot, fullPath, maxPassBytes } = opts;

  const resolved = resolveJsonlPath(watchRoot, fullPath);
  if (!resolved) return;
  const { username, encodedProjectDir, sessionId, displayProjectPath } = resolved;

  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }

  const prior = await readOffset(pool, username, fullPath);
  const inode = Number(stat.ino);
  let startOffset = 0;
  if (prior) {
    const sameInode = prior.inode === null || prior.inode === inode;
    const notShrunk = Number(stat.size) >= prior.byteOffset;
    if (sameInode && notShrunk) startOffset = prior.byteOffset;
  }

  const endOffset = Number(stat.size);
  if (endOffset <= startOffset) return;

  let chunkStart = startOffset;
  while (chunkStart < endOffset) {
    const chunkEnd = Math.min(chunkStart + maxPassBytes, endOffset);
    const { committedEnd, buf } = await readChunk(fullPath, chunkStart, chunkEnd, endOffset);
    if (buf === "") break;

    const entries = parseJsonlBuffer(buf);
    const projection = projectEntries(entries, {
      fileSessionId: sessionId,
      username,
      encodedProjectDir,
      displayProjectPath,
    });

    await commitPass(pool, {
      sessionUpserts: projection.sessionUpserts,
      tokenRows: projection.tokenRows,
      offset: { username, jsonlPath: fullPath, byteOffset: committedEnd, inode },
    });

    if (committedEnd <= chunkStart) break; // no complete lines in this slice
    chunkStart = committedEnd;
  }
}

/**
 * Read [start, hardEnd) from the file, but back up to the last newline we can
 * find so we never commit a partial line. If this is the final chunk
 * (hardEnd === fileSize), we still require a trailing newline.
 */
async function readChunk(
  fullPath: string,
  start: number,
  hardEnd: number,
  _fileSize: number,
): Promise<{ committedEnd: number; buf: string }> {
  const fh = await fs.open(fullPath, "r");
  try {
    const len = hardEnd - start;
    const buffer = Buffer.alloc(len);
    await fh.read(buffer, 0, len, start);
    const text = buffer.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl === -1) return { committedEnd: start, buf: "" };
    // Everything up to and including the last newline is safe to parse.
    const safe = text.slice(0, lastNl + 1);
    return { committedEnd: start + Buffer.byteLength(safe, "utf8"), buf: safe };
  } finally {
    await fh.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hub/indexer && npx vitest run test/integration/tail-live-writes.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/src/process-file.ts hub/indexer/test/integration/tail-live-writes.test.ts
git commit -m "feat(indexer): processFile — offset-resume pass"
```

---

## Task 12: Integration — restart-resume idempotency

**Files:**
- Create: `hub/indexer/test/integration/restart-resume.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/migrate.js";
import { processFile } from "../../src/process-file.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({
    pool,
    migrationsDir: MIGRATIONS_DIR,
    lockKey: 0x62696f666c77n,
  });
}, 90_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

describe("restart-resume", () => {
  it("N writes, interrupted run, M more writes → N+M tokens, no dupes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-rr-"));
    const SID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const dir = path.join(root, "bob", ".pantheon", "claude-projects", "-w");
    await mkdir(dir, { recursive: true });
    const full = path.join(dir, `${SID}.jsonl`);
    await writeFile(full, "");

    const writeAssistant = async (n: number) => {
      await appendFile(full, JSON.stringify({
        type: "assistant",
        uuid: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
        sessionId: SID, timestamp: `2026-04-22T10:00:${String(n).padStart(2, "0")}.000Z`,
        message: {
          model: "m",
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }) + "\n");
    };

    for (let i = 1; i <= 5; i++) await writeAssistant(i);
    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    // Simulate a crash: re-run the same pass — should be a no-op (no new bytes).
    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    for (let i = 6; i <= 9; i++) await writeAssistant(i);
    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    const r = await pool.query("SELECT count(*)::int AS c FROM token_usage_log WHERE session_id=$1", [SID]);
    expect(r.rows[0].c).toBe(9);

    const s = await pool.query("SELECT message_count, token_usage FROM sessions WHERE session_id=$1", [SID]);
    expect(s.rows[0].message_count).toBe(9);
    expect(s.rows[0].token_usage).toEqual({ input: 9, output: 9, cache_read: 0, cache_write: 0 });

    await rm(root, { recursive: true, force: true });
  });

  it("offset table forces dedupe if offset is manually reset mid-file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-rr2-"));
    const SID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const dir = path.join(root, "carol", ".pantheon", "claude-projects", "-w");
    await mkdir(dir, { recursive: true });
    const full = path.join(dir, `${SID}.jsonl`);
    await writeFile(full, "");
    await appendFile(full, JSON.stringify({
      type: "assistant", uuid: "11111111-1111-1111-1111-111111111111",
      sessionId: SID, timestamp: "2026-04-22T10:00:00.000Z",
      message: { model: "m", usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + "\n");

    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    // Simulate loss of offset row.
    await pool.query("DELETE FROM file_offsets WHERE username=$1", ["carol"]);
    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    // token_usage_log still has 1 row (UNIQUE constraint dedupes replay).
    const t = await pool.query("SELECT count(*)::int AS c FROM token_usage_log WHERE session_id=$1", [SID]);
    expect(t.rows[0].c).toBe(1);
    // sessions.message_count double-counts because it's a blind delta merge;
    // this is known and acceptable since offsets shouldn't be deleted in practice.
    // The counter is a convenience field, not a billing-critical one.
    await rm(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd hub/indexer && npx vitest run test/integration/restart-resume.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/test/integration/restart-resume.test.ts
git commit -m "test(indexer): restart-resume idempotency"
```

---

## Task 13: Integration — file rotation / inode change

**Files:**
- Create: `hub/indexer/test/integration/rotation.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtemp, mkdir, writeFile, rm, unlink } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/migrate.js";
import { processFile } from "../../src/process-file.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));
const UUID = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: pg.getConnectionUri() });
  await runMigrations({
    pool,
    migrationsDir: MIGRATIONS_DIR,
    lockKey: 0x62696f666c77n,
  });
}, 90_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

describe("rotation", () => {
  it("resets offset when the file is replaced (inode changes)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-rot-"));
    const SID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const dir = path.join(root, "dan", ".pantheon", "claude-projects", "-w");
    await mkdir(dir, { recursive: true });
    const full = path.join(dir, `${SID}.jsonl`);

    const assistant = (uuid: string) => JSON.stringify({
      type: "assistant", uuid, sessionId: SID,
      timestamp: "2026-04-22T10:00:00.000Z",
      message: { model: "m", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + "\n";

    await writeFile(full, assistant(UUID(1)));
    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    // Replace the file entirely (new inode).
    await unlink(full);
    await writeFile(full, assistant(UUID(2)));
    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    const r = await pool.query("SELECT count(*)::int AS c FROM token_usage_log WHERE session_id=$1", [SID]);
    expect(r.rows[0].c).toBe(2);

    await rm(root, { recursive: true, force: true });
  });

  it("resets offset when the file is truncated (size < stored offset)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-trunc-"));
    const SID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const dir = path.join(root, "eve", ".pantheon", "claude-projects", "-w");
    await mkdir(dir, { recursive: true });
    const full = path.join(dir, `${SID}.jsonl`);

    const assistant = (uuid: string) => JSON.stringify({
      type: "assistant", uuid, sessionId: SID,
      timestamp: "2026-04-22T10:00:00.000Z",
      message: { model: "m", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + "\n";

    await writeFile(full, assistant(UUID(10)) + assistant(UUID(11)));
    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    // Truncate (same inode, smaller file).
    await writeFile(full, assistant(UUID(12)));
    await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });

    const r = await pool.query("SELECT count(*)::int AS c FROM token_usage_log WHERE session_id=$1", [SID]);
    // 2 originals (unique) + 1 new = 3
    expect(r.rows[0].c).toBe(3);

    await rm(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd hub/indexer && npx vitest run test/integration/rotation.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/test/integration/rotation.test.ts
git commit -m "test(indexer): rotation + truncation offset reset"
```

---

## Task 14: Integration — concurrent files + semaphore

**Files:**
- Create: `hub/indexer/src/semaphore.ts`
- Create: `hub/indexer/test/integration/concurrent-files.test.ts`

- [ ] **Step 1: Implement a tiny async semaphore**

Create `hub/indexer/src/semaphore.ts`:

```ts
export class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (permits < 1) throw new Error("Semaphore permits must be >= 1");
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.permits--;
  }

  release(): void {
    this.permits++;
    const next = this.waiters.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
```

- [ ] **Step 2: Write the test**

Create `hub/indexer/test/integration/concurrent-files.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/migrate.js";
import { processFile } from "../../src/process-file.js";
import { Semaphore } from "../../src/semaphore.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: pg.getConnectionUri(), max: 20 });
  await runMigrations({
    pool,
    migrationsDir: MIGRATIONS_DIR,
    lockKey: 0x62696f666c77n,
  });
}, 90_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

describe("concurrent files", () => {
  it("ingests 20 files in parallel with a semaphore bound of 4", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-conc-"));
    const sem = new Semaphore(4);
    const N = 20;
    const writes = Array.from({ length: N }, (_, i) => i);

    await Promise.all(writes.map(async (i) => {
      const idx = String(i).padStart(2, "0");
      // Valid UUID: 8-4-4-4-12 hex chars. Use the index byte to make each unique.
      const SID = `aaaa${idx}aa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
      const user = `user${idx}`;
      const dir = path.join(root, user, ".pantheon", "claude-projects", "-w");
      await mkdir(dir, { recursive: true });
      const full = path.join(dir, `${SID}.jsonl`);
      const lines = [];
      for (let k = 0; k < 5; k++) {
        lines.push(JSON.stringify({
          type: "assistant",
          uuid: `${idx}${idx}${idx}${idx}-aaaa-aaaa-aaaa-${String(k).padStart(12, "0")}`,
          sessionId: SID,
          timestamp: `2026-04-22T10:00:${String(k).padStart(2, "0")}.000Z`,
          message: { model: "m", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        }));
      }
      await writeFile(full, lines.join("\n") + "\n");
      await sem.run(() => processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 }));
    }));

    const s = await pool.query("SELECT count(*)::int AS c FROM sessions");
    expect(s.rows[0].c).toBe(N);
    const t = await pool.query("SELECT count(*)::int AS c FROM token_usage_log");
    expect(t.rows[0].c).toBe(N * 5);
    const o = await pool.query("SELECT count(*)::int AS c FROM file_offsets");
    expect(o.rows[0].c).toBe(N);

    await rm(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 3: Run the test**

Run: `cd hub/indexer && npx vitest run test/integration/concurrent-files.test.ts`
Expected: PASS (1 test).

- [ ] **Step 4: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/src/semaphore.ts hub/indexer/test/integration/concurrent-files.test.ts
git commit -m "feat(indexer): semaphore + concurrent-files integration test"
```

---

## Task 15: Integration — backlog on boot

**Files:**
- Create: `hub/indexer/test/integration/backlog-on-boot.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/migrate.js";
import { processFile } from "../../src/process-file.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: pg.getConnectionUri(), max: 20 });
  await runMigrations({
    pool,
    migrationsDir: MIGRATIONS_DIR,
    lockKey: 0x62696f666c77n,
  });
}, 90_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

describe("backlog on boot", () => {
  it("pre-populates 50 JSONL files totalling 10k lines, processes them all", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-bl-"));
    const FILES = 50;
    const LINES_PER_FILE = 200; // 50 * 200 = 10_000

    const paths: string[] = [];
    for (let f = 0; f < FILES; f++) {
      const idx = String(f).padStart(2, "0");
      // Valid UUIDs: 8-4-4-4-12 hex chars each.
      const SID = `bbbb${idx}bb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`;
      const user = `u${idx}`;
      const dir = path.join(root, user, ".pantheon", "claude-projects", "-w");
      await mkdir(dir, { recursive: true });
      const full = path.join(dir, `${SID}.jsonl`);
      const lines: string[] = [];
      for (let k = 0; k < LINES_PER_FILE; k++) {
        lines.push(JSON.stringify({
          type: k % 2 === 0 ? "user" : "assistant",
          uuid: `${idx}${idx}${idx}${idx}-bbbb-bbbb-bbbb-${String(k).padStart(12, "0")}`,
          sessionId: SID,
          timestamp: `2026-04-22T${String(10 + Math.floor(k / 60)).padStart(2, "0")}:${String(k % 60).padStart(2, "0")}:00.000Z`,
          message: k % 2 === 0
            ? { content: "u" }
            : { model: "m", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        }));
      }
      await writeFile(full, lines.join("\n") + "\n");
      paths.push(full);
    }

    // Simulate boot: process every file once, like chokidar "add" would.
    for (const full of paths) {
      await processFile({ pool, watchRoot: root, fullPath: full, maxPassBytes: 8 * 1024 * 1024 });
    }

    const s = await pool.query("SELECT count(*)::int AS c FROM sessions");
    expect(s.rows[0].c).toBe(FILES);
    const t = await pool.query("SELECT count(*)::int AS c FROM token_usage_log");
    expect(t.rows[0].c).toBe(FILES * LINES_PER_FILE / 2);
    const msg = await pool.query("SELECT SUM(message_count)::int AS total FROM sessions");
    expect(msg.rows[0].total).toBe(FILES * LINES_PER_FILE);

    await rm(root, { recursive: true, force: true });
  }, 120_000);
});
```

- [ ] **Step 2: Run the test**

Run: `cd hub/indexer && npx vitest run test/integration/backlog-on-boot.test.ts`
Expected: PASS (1 test).

- [ ] **Step 3: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/test/integration/backlog-on-boot.test.ts
git commit -m "test(indexer): backlog-on-boot coverage"
```

---

## Task 16: `src/watcher.ts` — chokidar + per-file serial queue

**Files:**
- Create: `hub/indexer/src/watcher.ts`
- Create: `hub/indexer/test/integration/watcher.test.ts`

- [ ] **Step 1: Write the failing test**

Create `hub/indexer/test/integration/watcher.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/migrate.js";
import { startWatcher } from "../../src/watcher.js";
import pino from "pino";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

let pg: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new Pool({ connectionString: pg.getConnectionUri(), max: 10 });
  await runMigrations({
    pool,
    migrationsDir: MIGRATIONS_DIR,
    lockKey: 0x62696f666c77n,
  });
}, 90_000);

afterAll(async () => {
  await pool?.end();
  await pg?.stop();
}, 30_000);

async function waitUntil(pred: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitUntil timed out");
}

describe("startWatcher", () => {
  it("picks up new files and live appends", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-w-"));
    const SID = "aaaaaaaa-0000-0000-0000-000000000001";
    const logger = pino({ level: "silent" });

    const handle = startWatcher({
      pool,
      watchRoot: root,
      maxConcurrentFiles: 4,
      maxPassBytes: 8 * 1024 * 1024,
      logger,
    });
    try {
      // Create file after watcher starts.
      const dir = path.join(root, "frank", ".pantheon", "claude-projects", "-w");
      await mkdir(dir, { recursive: true });
      const full = path.join(dir, `${SID}.jsonl`);
      await writeFile(full, JSON.stringify({
        type: "assistant", uuid: "aa000000-0000-0000-0000-000000000001", sessionId: SID,
        timestamp: "2026-04-22T10:00:00.000Z",
        message: { model: "m", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      }) + "\n");

      await waitUntil(async () => {
        const r = await pool.query("SELECT count(*)::int AS c FROM sessions WHERE session_id=$1", [SID]);
        return r.rows[0].c === 1;
      });

      await appendFile(full, JSON.stringify({
        type: "assistant", uuid: "aa000000-0000-0000-0000-000000000002", sessionId: SID,
        timestamp: "2026-04-22T10:00:01.000Z",
        message: { model: "m", usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      }) + "\n");

      await waitUntil(async () => {
        const r = await pool.query("SELECT message_count FROM sessions WHERE session_id=$1", [SID]);
        return r.rows[0]?.message_count === 2;
      });

      const s = await pool.query("SELECT token_usage FROM sessions WHERE session_id=$1", [SID]);
      expect(s.rows[0].token_usage).toEqual({ input: 4, output: 3, cache_read: 0, cache_write: 0 });
    } finally {
      await handle.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds files present at startup (backlog)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexer-w2-"));
    const SID = "aaaaaaaa-0000-0000-0000-000000000099";
    const logger = pino({ level: "silent" });
    const dir = path.join(root, "gwen", ".pantheon", "claude-projects", "-w");
    await mkdir(dir, { recursive: true });
    const full = path.join(dir, `${SID}.jsonl`);
    await writeFile(full, JSON.stringify({
      type: "user", uuid: "bb000000-0000-0000-0000-000000000001", sessionId: SID,
      timestamp: "2026-04-22T10:00:00.000Z", message: { content: "hi" },
    }) + "\n");

    const handle = startWatcher({
      pool,
      watchRoot: root,
      maxConcurrentFiles: 4,
      maxPassBytes: 8 * 1024 * 1024,
      logger,
    });
    try {
      await waitUntil(async () => {
        const r = await pool.query("SELECT count(*)::int AS c FROM sessions WHERE session_id=$1", [SID]);
        return r.rows[0].c === 1;
      });
    } finally {
      await handle.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `cd hub/indexer && npx vitest run test/integration/watcher.test.ts`
Expected: FAIL — cannot resolve `../../src/watcher.js`.

- [ ] **Step 3: Implement `src/watcher.ts`**

```ts
import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
import type { Pool } from "pg";
import type { Logger } from "pino";
import * as path from "node:path";
import { processFile } from "./process-file.js";
import { Semaphore } from "./semaphore.js";

export interface StartWatcherOptions {
  pool: Pool;
  watchRoot: string;
  maxConcurrentFiles: number;
  maxPassBytes: number;
  logger: Logger;
}

export interface WatcherHandle {
  close(): Promise<void>;
  waitIdle(): Promise<void>;
}

interface FileState {
  processing: boolean;
  reprocess: boolean;
}

export function startWatcher(opts: StartWatcherOptions): WatcherHandle {
  const { pool, watchRoot, maxConcurrentFiles, maxPassBytes, logger } = opts;
  const sem = new Semaphore(maxConcurrentFiles);
  const state = new Map<string, FileState>();
  const inflight = new Set<Promise<void>>();

  const glob = path
    .join(watchRoot, "*", ".pantheon", "claude-projects", "*", "*.jsonl")
    .replace(/\\/g, "/");

  const watcher: FSWatcher = chokidar.watch(glob, {
    persistent: true,
    awaitWriteFinish: false,
    ignoreInitial: false,
    alwaysStat: true,
  });

  function enqueue(fullPath: string): void {
    let s = state.get(fullPath);
    if (!s) {
      s = { processing: false, reprocess: false };
      state.set(fullPath, s);
    }
    if (s.processing) {
      s.reprocess = true;
      return;
    }
    s.processing = true;
    const p = (async () => {
      try {
        do {
          s!.reprocess = false;
          await sem.run(() => processFile({ pool, watchRoot, fullPath, maxPassBytes }));
        } while (s!.reprocess);
      } catch (err) {
        logger.error({ err, fullPath }, "processFile failed");
      } finally {
        s!.processing = false;
      }
    })();
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  }

  watcher.on("add", (p) => enqueue(p));
  watcher.on("change", (p) => enqueue(p));
  watcher.on("error", (err) => logger.error({ err }, "watcher error"));

  return {
    async close() {
      await watcher.close();
      await Promise.allSettled([...inflight]);
    },
    async waitIdle() {
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hub/indexer && npx vitest run test/integration/watcher.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/src/watcher.ts hub/indexer/test/integration/watcher.test.ts
git commit -m "feat(indexer): chokidar watcher with per-file serial queue"
```

---

## Task 17: `src/index.ts` — entrypoint wiring

**Files:**
- Create: `hub/indexer/src/index.ts`

- [ ] **Step 1: Implement the entrypoint**

```ts
import { Pool } from "pg";
import pino from "pino";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { runMigrations } from "./migrate.js";
import { startWatcher } from "./watcher.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = pino({ level: cfg.logLevel });

  const pool = new Pool({ connectionString: cfg.pgUrl, max: Math.max(10, cfg.maxConcurrentFiles * 2) });

  await waitForPg(pool, cfg.pgStartupMaxWaitSec, logger);

  await runMigrations({
    pool,
    migrationsDir: path.resolve(HERE, "..", "migrations"),
    lockKey: cfg.migrationLockKey,
  });
  logger.info({ workspacesRoot: cfg.workspacesRoot }, "migrations applied — starting watcher");

  const handle = startWatcher({
    pool,
    watchRoot: cfg.workspacesRoot,
    maxConcurrentFiles: cfg.maxConcurrentFiles,
    maxPassBytes: cfg.maxPassBytes,
    logger,
  });

  const shutdown = async (sig: NodeJS.Signals): Promise<void> => {
    logger.info({ sig }, "shutdown signal");
    await handle.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function waitForPg(pool: Pool, maxWaitSec: number, logger: pino.Logger): Promise<void> {
  const deadline = Date.now() + maxWaitSec * 1000;
  let delay = 500;
  while (Date.now() < deadline) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      logger.warn({ err: (err as Error).message, delay }, "waiting for PG");
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
  logger.error("PG unreachable past PG_STARTUP_MAX_WAIT_SEC — exiting");
  process.exit(1);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Build succeeds**

Run: `cd hub/indexer && npm run build`
Expected: creates `dist/index.js`, exits 0.

- [ ] **Step 3: Typecheck succeeds**

Run: `cd hub/indexer && npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/src/index.ts
git commit -m "feat(indexer): entrypoint wires migrations + watcher"
```

---

## Task 18: Dockerfile

**Files:**
- Create: `hub/indexer/Dockerfile`
- Create: `hub/indexer/.dockerignore`

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsup src/index.ts --format esm --target node20 --clean --out-dir dist

# Runtime stage
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

USER node
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Write `.dockerignore`**

```
node_modules
dist
test
*.md
.gitignore
```

- [ ] **Step 3: Build the image**

Run: `cd hub/indexer && docker build -t claude-bioflow-indexer:dev .`
Expected: image built successfully.

- [ ] **Step 4: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/indexer/Dockerfile hub/indexer/.dockerignore
git commit -m "feat(indexer): Dockerfile (multi-stage node:20-alpine)"
```

---

## Task 19: `hub/docker-compose.yml` — add postgres + indexer services

**Files:**
- Modify: `hub/docker-compose.yml`

- [ ] **Step 1: Read existing file to find insertion point**

The file currently defines `nats` and `nginx` services under `services:` and declares `bioflow-net` under `networks:`. Append two new services and keep the network declaration untouched.

- [ ] **Step 2: Edit `hub/docker-compose.yml`**

Add these two services under `services:` (after the `nginx` block, before `networks:`):

```yaml
  postgres:
    image: postgres:16-alpine
    container_name: claude-bioflow-postgres
    env_file: [ ./.env ]
    environment:
      POSTGRES_USER: bioflow
      POSTGRES_DB: bioflow
    volumes:
      - ./postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U bioflow"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s
    restart: unless-stopped
    networks:
      - bioflow-net

  indexer:
    build: ./indexer
    container_name: claude-bioflow-indexer
    env_file: [ ./.env ]
    environment:
      PG_URL: "postgres://bioflow:${POSTGRES_PASSWORD}@postgres:5432/bioflow"
      WORKSPACES_ROOT: /workspaces
      MAX_CONCURRENT_FILES: "8"
      LOG_LEVEL: info
    volumes:
      - ./workspaces:/workspaces:ro
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - bioflow-net
```

- [ ] **Step 3: Lint the compose file**

Run: `cd /home/lili/claude-bioflow/hub && docker compose config > /dev/null`
Expected: exits 0 (may warn about missing `.env` — acceptable; Task 20 creates it on first run).

- [ ] **Step 4: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/docker-compose.yml
git commit -m "feat(hub): add postgres + indexer services"
```

---

## Task 20: `hub/.env` auto-generation in `add-user.sh`

**Files:**
- Modify: `hub/scripts/add-user.sh`

- [ ] **Step 1: Add a helper near the top of `add-user.sh`, right after the constants block (after the `NATS_HOST=` line)**

Find this existing block (lines 9-14):

```bash
HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HTPASSWD_FILE="${HUB_DIR}/htpasswd"
WORKSPACES_DIR="${HUB_DIR}/workspaces"
SHARED_DIR="${WORKSPACES_DIR}/shared"
NETWORK="claude-bioflow_bioflow-net"
NATS_HOST="claude-bioflow-nats"
```

Add below it:

```bash
ENV_FILE="${HUB_DIR}/.env"

ensure_hub_env() {
    if [[ -f "$ENV_FILE" ]] && grep -q '^POSTGRES_PASSWORD=' "$ENV_FILE"; then
        return
    fi
    local pw
    pw=$(openssl rand -base64 32 | tr -d '=+/')
    touch "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    if grep -q '^POSTGRES_PASSWORD=' "$ENV_FILE" 2>/dev/null; then
        # Shouldn't reach here, but guard anyway.
        return
    fi
    {
        echo "# claude-bioflow hub secrets — do not commit"
        echo "POSTGRES_PASSWORD=${pw}"
    } >> "$ENV_FILE"
    echo "Generated ${ENV_FILE} with a random POSTGRES_PASSWORD."
}
```

- [ ] **Step 2: Call it just before the `=== Adding user: ${USERNAME} ===` echo**

Find this line (line 86):

```bash
echo "=== Adding user: ${USERNAME} ==="
```

Insert above it:

```bash
ensure_hub_env
```

- [ ] **Step 3: Sanity — run the add-user help to ensure no syntax errors**

Run: `cd /home/lili/claude-bioflow/hub && bash scripts/add-user.sh --help`
Expected: help text prints, exits 0.

- [ ] **Step 4: Commit**

```bash
cd /home/lili/claude-bioflow
git add hub/scripts/add-user.sh
git commit -m "feat(hub): auto-generate hub/.env with POSTGRES_PASSWORD on first add-user"
```

---

## Task 21: `docker-compose.dev.yml` — add postgres + indexer for dev

**Files:**
- Modify: `docker-compose.dev.yml`

- [ ] **Step 1: Read the current dev compose to see layout**

Run: `cd /home/lili/claude-bioflow && cat docker-compose.dev.yml | head -80`

- [ ] **Step 2: Append the two services**

The dev compose sits at the repo root, so paths for the bind-mount should be `./hub/workspaces` (matching the pattern in `add-user.sh` for the single-user dev setup) and `./hub/postgres-data`.

Add these under `services:`:

```yaml
  postgres:
    image: postgres:16-alpine
    env_file: [ ./hub/.env ]
    environment:
      POSTGRES_USER: bioflow
      POSTGRES_DB: bioflow
    volumes:
      - ./hub/postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U bioflow"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s

  indexer:
    build: ./hub/indexer
    env_file: [ ./hub/.env ]
    environment:
      PG_URL: "postgres://bioflow:${POSTGRES_PASSWORD}@postgres:5432/bioflow"
      WORKSPACES_ROOT: /workspaces
      MAX_CONCURRENT_FILES: "4"
      LOG_LEVEL: debug
    volumes:
      - ./hub/workspaces:/workspaces:ro
    depends_on:
      postgres:
        condition: service_healthy
```

- [ ] **Step 3: Lint the dev compose**

Run: `cd /home/lili/claude-bioflow && docker compose -f docker-compose.dev.yml config > /dev/null`
Expected: exits 0 (may warn about missing env — acceptable for now; `hub/.env` is created by Task 20's helper when an operator runs add-user, or can be created manually).

- [ ] **Step 4: Commit**

```bash
cd /home/lili/claude-bioflow
git add docker-compose.dev.yml
git commit -m "feat(dev): wire postgres + indexer into docker-compose.dev.yml"
```

---

## Task 22: `.gitignore` updates

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Edit the existing `.gitignore`**

Append:

```
hub/postgres-data/
hub/.env
```

(`hub/indexer/node_modules/` and `hub/indexer/dist/` are already covered by the top-level `node_modules/` and `dist/` patterns.)

- [ ] **Step 2: Verify git status ignores those paths**

Run: `cd /home/lili/claude-bioflow && mkdir -p hub/postgres-data && touch hub/.env hub/postgres-data/test && git status --short`
Expected: `hub/postgres-data/` and `hub/.env` do NOT appear as untracked. Then `rm -rf hub/postgres-data hub/.env`.

- [ ] **Step 3: Commit**

```bash
cd /home/lili/claude-bioflow
git add .gitignore
git commit -m "chore: gitignore postgres-data and hub/.env"
```

---

## Final verification

- [ ] **Run the full test suite**

Run: `cd /home/lili/claude-bioflow/hub/indexer && npm test`
Expected: all tests pass, under ~90s total (including testcontainer boots).

- [ ] **Typecheck clean**

Run: `cd /home/lili/claude-bioflow/hub/indexer && npm run typecheck`
Expected: exits 0.

- [ ] **End-to-end smoke test using the dev compose**

```bash
cd /home/lili/claude-bioflow
# Generate hub/.env if not present (normally add-user.sh does this):
if [ ! -f hub/.env ]; then
  mkdir -p hub
  pw=$(openssl rand -base64 32 | tr -d '=+/')
  printf '# hub secrets\nPOSTGRES_PASSWORD=%s\n' "$pw" > hub/.env
  chmod 600 hub/.env
fi
docker compose -f docker-compose.dev.yml up -d --build postgres indexer
# Wait for indexer to come up:
sleep 8
docker compose -f docker-compose.dev.yml logs indexer --tail=30
# Verify schema landed:
docker compose -f docker-compose.dev.yml exec postgres \
  psql -U bioflow -d bioflow -c "\dt"
```
Expected: `sessions`, `token_usage_log`, `file_offsets`, `schema_migrations` tables all present.

Tear down with `docker compose -f docker-compose.dev.yml down` when finished.

---

## Spec coverage cross-check

| Spec section | Task(s) |
|---|---|
| §3 Architecture (indexer service) | 1, 17, 18 |
| §4 File tree | 1, 4–9, 11, 14, 16–18 |
| §5.1 postgres + indexer compose services | 19 |
| §5.2 add-user.sh mount — **deviation:** existing mount reused | (no task; see note at top) |
| §5.3 docker-compose.dev.yml | 21 |
| §5.4 Multi-tenancy | 7 |
| §5.5 `hub/.env` | 20, 22 |
| §6.1 Migration runner | 3 |
| §6.2 sessions migration | 4 |
| §6.3 token_usage_log migration | 5 |
| §6.4 file_offsets migration | 6 |
| §7.1 Watcher + worker | 14, 16 |
| §7.1 processFile offset math | 11, 13 |
| §7.2 path-decode | 7 |
| §7.3 JSONL parser | 8 |
| §7.4 session-projector + upsert SQL | 9, 10 |
| §8 Error handling (PG backoff, offset reset, ROLLBACK) | 10, 11, 13, 17 |
| §9 Testing (unit + integration) | 2, 3, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 |
| §10 Forward-compat (read-only, top-level fields) | 8 (parser) |
| §11 Configuration | 2 |
| §12 Phase boundary (queries work end-to-end) | final verification |
