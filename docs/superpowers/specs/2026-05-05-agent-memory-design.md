# claude-bioflow agent memory — design

Date: 2026-05-05
Status: draft for review
Builds on:

- `2026-04-22-claude-bioflow-session-memory-phase-1-design.md` — indexer + `sessions` / `token_usage_log` / `file_offsets` (landed; migrations 0001–0003).
- `2026-04-22-claude-bioflow-session-memory-phase-2-design.md` — `chats` table + adapter-direct-PG (landed; migration 0004 + 0005).

Inspiration / explicit reference: [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) — we adopt three of its ideas (token-efficient 3-tool retrieval, content-hash dedup, observation/summary split) and reject the rest of its architecture for reasons in §3.

## 1. Goal

The two prior phases capture *raw* state: every JSONL line lands in Postgres,
every chat's identity is queryable, billing rollups work. They do not give the
running agent **retrievable, distilled context**. A user who debugged a tricky
Scanpy preprocessing step yesterday gets no benefit from that work today —
the agent re-reads JSONL only if explicitly asked, and pays full-transcript
tokens when it does.

Add a typed, retrievable, scope-aware **agent memory** layer that:

1. Distills settled sessions into structured memory rows (summaries +
   observations) **server-side in the indexer**, off the user's critical
   path.
2. Lets users author personal / project / org memories explicitly via slash
   commands.
3. Serves a token-efficient retrieval API to every per-user container via a
   small MCP server, plus a `SessionStart` hook that pre-injects the most
   relevant memories.

After this lands, `SessionStart` injects ~1–2k tokens of relevant prior
context into every new session, the agent can `memory_search` mid-turn for
more, and `/memorize` lets the user pin a fact for later recall.

## 2. Non-goals

| Feature | Phase / disposition |
|---|---|
| RAG over arbitrary uploaded documents | not scoped |
| Per-codebase-file context (claude-mem's `PreToolUse:Read` style) | not scoped — too chatty, low signal |
| Embeddings via paid API (Voyage, Anthropic, OpenAI) | pluggable, default local; revisit if recall is poor |
| Compaction policy beyond `hit_count` + age | future; soft-delete is enough for now |
| Cross-user memory sharing beyond the org tier | not scoped |
| Frontend memory browser | sub-phase C of this roadmap |
| Soft-delete / undelete / audit trail | sub-phase C |
| `users` table | not planned (consistent with 2026-04-22 specs — `username` is the tenant key) |
| Subagent-scoped memory (per `tick-executor` etc.) | not scoped — subagents inherit the parent session's scope |

## 3. Why not just port claude-mem

claude-mem is a single-user, single-laptop plugin. Its assumptions break in
our setting; copying its shape would cost more than building from our own
primitives.

| Concern | claude-mem | claude-bioflow (this spec) |
|---|---|---|
| Capture | per-event hooks call a local worker on port 37777 | indexer already projects JSONL → PG (Phase 1) |
| Storage | SQLite + Chroma sidecar under `~/.claude-mem/` | shared Postgres + pgvector, scoped by `(username, project_dir)` |
| Distillation | hook on `Stop` calls LLM in the user's session, blocks return | indexer does it async, off the user's critical path |
| Retrieval | local MCP `mcp-search` against SQLite | per-container MCP that hits the hub's memory API over docker network |
| Scoping | per-cwd, single user | three tiers: org / user / project |
| Multi-tenancy | not modeled | first-class via `username` (already trusted from filesystem prefix in Phase 1) |
| Daemon lifecycle | per-host worker on a fixed port | nothing new — extends an existing hub service |

What we keep:

- **3-tool retrieval pattern** (`search` returns IDs + ~50-tok snippets, `get`
  fetches full body, `timeline` walks chronologically). Big token win for
  agent retrieval, easy to translate to PG.
- **Content-hash dedup on observations** — re-distilling a session is
  idempotent.
- **Observation / summary split** — many fine-grained observations + one
  per-session summary, both retrievable.

What we drop:

- Per-host worker daemon. The indexer is our worker.
- Per-tool-call `PostToolUse` hook for capture. The indexer already has the
  JSONL; capture happens once, server-side, when a session settles.
- SQLite. Postgres is already provisioned.
- Bundled tree-sitter for 25 languages. Observations are LLM-extracted from
  the transcript, not AST-parsed.
- Fixed-port worker (37777). Everything goes through the hub network with
  service-name DNS.

## 4. Architecture

```
   [per-user container]                       [hub: docker-compose]                  [postgres]
                                                                                     ┌──────────────────┐
   Claude Code                                                                       │ memories         │
    ├─ SessionStart hook ──prefetch context──┐                                       │ memory_chunks    │
    ├─ MCP "bioflow-memory" ─search/get──────┼──> memory-api ─────────────────────── │ memory_facets    │
    │   timeline/write/forget                │   (extends hub/indexer/, port 8400)   │ embedder_queue   │
    └─ /memorize, /recall, /forget cmds ─────┘            │                          │ memory_distill_  │
                                                          │                          │   cursor         │
                                                          ▼                          └──────────────────┘
                                                    embedder sidecar                       ▲
                                                    (bge-small-en-v1.5,                    │
                                                    Python, CPU,                           │
                                                    claude-bioflow-embedder:8000)          │
                                                                                           │
   JSONL ──tail──> indexer (Phase 1) ──async distill module──> claude-haiku-4-5 ───────────┘
                                                                (via hub-side
                                                                 ANTHROPIC_API_KEY)
```

Three new things on the hub:

1. **DB schema** — three migrations (0006, 0007, 0008) on the existing
   `bioflow` PG.
2. **`distiller` module + memory HTTP API inside `hub/indexer/`** — async
   LLM-driven extraction of memories from settled sessions, plus a thin
   HTTP server for memory CRUD/search.
3. **`embedder` sidecar service** — Python service running
   `bge-small-en-v1.5` on CPU, exposed on the hub network as
   `claude-bioflow-embedder:8000/embed`. Pluggable behind a single env var.

One new thing in every per-user container:

4. **`bioflow-memory` MCP server** — a small Node binary baked into the
   devcontainer image, wired in `.mcp.json`, plus three slash commands and
   one `SessionStart` hook added to the skeleton harness.

## 5. File tree added

```
claude-bioflow/
├── hub/
│   ├── docker-compose.yml                            # + embedder service; indexer gains 8400 port + ANTHROPIC_API_KEY
│   ├── indexer/
│   │   ├── package.json                              # + fastify (HTTP), + zod (schema validation)
│   │   ├── src/
│   │   │   ├── index.ts                              # modify — boot HTTP server alongside watcher
│   │   │   ├── distiller.ts                          # NEW — settle-detector + LLM call
│   │   │   ├── distiller-prompts.ts                  # NEW — prompt templates (versioned)
│   │   │   ├── distiller-cursor.ts                   # NEW — track which sessions have been distilled
│   │   │   ├── memory-api.ts                         # NEW — fastify routes
│   │   │   ├── memory-repo.ts                        # NEW — typed PG queries (search, get, write, etc.)
│   │   │   ├── memory-rank.ts                        # NEW — pure scoring function
│   │   │   ├── embedder-client.ts                    # NEW — HTTP client to the embedder sidecar
│   │   │   └── llm-client.ts                         # NEW — Anthropic SDK wrapper, model pinned
│   │   ├── migrations/
│   │   │   ├── 0006_memories.sql                     # NEW
│   │   │   ├── 0007_memory_chunks.sql                # NEW (uses pgvector — see §6.0)
│   │   │   └── 0008_memory_facets.sql                # NEW
│   │   └── test/
│   │       ├── distiller.test.ts                     # NEW — mocked LLM, verify rows
│   │       ├── memory-repo.test.ts                   # NEW — testcontainers PG
│   │       ├── memory-rank.test.ts                   # NEW — pure
│   │       ├── memory-api.test.ts                    # NEW — fastify inject
│   │       └── integration/
│   │           ├── distill-real-session.test.ts      # NEW — fixture session → memory rows
│   │           └── search-mixed-scope.test.ts        # NEW — scope merging
│   ├── embedder/                                     # NEW service
│   │   ├── Dockerfile                                # python:3.12-slim, sentence-transformers
│   │   ├── pyproject.toml
│   │   ├── server.py                                 # FastAPI, single /embed endpoint
│   │   └── test_server.py
│   ├── scripts/
│   │   └── add-user.sh                               # + MEMORY_API_URL env var, + .mcp.json template, + harness wiring
│   └── skeleton/
│       └── harness/
│           ├── commands/
│           │   ├── memorize.md                       # NEW
│           │   ├── recall.md                         # NEW
│           │   └── forget.md                         # NEW
│           └── hooks/
│               └── memory_session_start.sh           # NEW — fetches /memory/context, emits to stdout
├── mcp-memory/                                       # NEW — sibling of adapter/, hub/
│   ├── package.json                                  # @modelcontextprotocol/sdk
│   ├── tsconfig.json
│   ├── src/index.ts                                  # 4 tools: memory_search, memory_get, memory_timeline, memory_write
│   └── test/index.test.ts
├── image/
│   └── Dockerfile                                    # modify — npm install -g ../mcp-memory bundle alongside the adapter copy step
└── docs/superpowers/specs/
    └── 2026-05-05-agent-memory-design.md             # this file
```

## 6. Schema

### 6.0 pgvector prerequisite

Postgres image switches from `postgres:16-alpine` to `pgvector/pgvector:pg16`
(same wire protocol, adds the `vector` type). Migration 0007 runs
`CREATE EXTENSION IF NOT EXISTS vector;` before creating its tables. No data
migration — existing tables are unaffected. Operators with running clusters
swap the image and restart; the existing `postgres-data/` volume is
binary-compatible.

### 6.1 `migrations/0006_memories.sql`

```sql
CREATE TABLE memories (
  memory_id          UUID PRIMARY KEY,
  username           TEXT NOT NULL,
  project_dir        TEXT,                          -- encoded_project_dir, NULL = user-wide; both NULL = org-wide
  type               TEXT NOT NULL CHECK (type IN (
                       'user',              -- user-authored facts about themselves
                       'feedback',          -- corrections / preferences
                       'project',           -- project-specific facts
                       'reference',         -- pointers to external systems
                       'session_summary',   -- LLM: one per settled session
                       'observation'        -- LLM: 0..N per settled session
                     )),
  source             TEXT NOT NULL CHECK (source IN ('user', 'distilled')),
  name               TEXT NOT NULL,                 -- short title, surfaced in search snippets
  description        TEXT NOT NULL,                 -- one-line; surfaced in search snippets
  body               TEXT NOT NULL,                 -- full content
  source_session_id  UUID,                          -- FK-shaped ref to sessions; not enforced (settled sessions can be archived in Phase 3)
  source_entry_uuids JSONB NOT NULL DEFAULT '[]'::jsonb,  -- entry_uuids that contributed; for observation provenance
  content_hash       BYTEA NOT NULL,                -- SHA-256 of normalised body; dedup key
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  hit_count          INT  NOT NULL DEFAULT 0,
  last_hit_at        TIMESTAMPTZ,
  deleted_at         TIMESTAMPTZ,                   -- soft-delete; reserved, populated in sub-phase C
  UNIQUE (username, project_dir, type, content_hash)
);

CREATE INDEX memories_username_type_created_idx
  ON memories (username, type, created_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX memories_org_type_created_idx
  ON memories (type, created_at DESC) WHERE username = '__org__' AND deleted_at IS NULL;
  -- "org" memories are written with username = '__org__' to keep the column NOT NULL; see §7.

CREATE INDEX memories_project_idx
  ON memories (username, project_dir, type) WHERE project_dir IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX memories_source_session_idx
  ON memories (source_session_id) WHERE source_session_id IS NOT NULL;
```

Notes:

- `username` is `NOT NULL`. Org-wide memories use the sentinel `'__org__'`
  (consistent with Phase 1's "no `users` table" decision; the sentinel is
  documented in `memory-repo.ts` and gated from per-user write APIs).
- `(username, project_dir, type, content_hash)` UNIQUE makes
  re-distillation idempotent — `INSERT ... ON CONFLICT DO NOTHING` is safe
  to call repeatedly. This is claude-mem's content-hash trick, applied
  per-tenant.
- `source_entry_uuids` lets the distiller cite which JSONL entries
  produced an observation. Useful for "show me where you got that" UX
  and for cleaning up observations whose source rows were soft-deleted.
- No FK on `source_session_id` because Phase 3 may archive `sessions`
  rows to cold storage; the soft reference survives that.

### 6.2 `migrations/0007_memory_chunks.sql`

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_chunks (
  chunk_id     BIGSERIAL PRIMARY KEY,
  memory_id    UUID NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  chunk_idx    INT  NOT NULL,
  content      TEXT NOT NULL,
  embedding    vector(384),                            -- bge-small-en-v1.5 dimension
  tsv          tsvector
                 GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (memory_id, chunk_idx)
);

CREATE INDEX memory_chunks_tsv_idx
  ON memory_chunks USING GIN (tsv);

CREATE INDEX memory_chunks_embedding_idx
  ON memory_chunks USING hnsw (embedding vector_cosine_ops);
```

Most memories chunk to 1 row; long observations chunk into ~512-token slices.
The HNSW index is built lazily — first query may be slow on a huge backlog.

`embedding` is nullable: a memory is searchable by FTS the moment it lands;
the embedder sidecar fills the vector asynchronously via the queue (§6.3).

### 6.3 `migrations/0008_memory_facets.sql` + embedder queue

```sql
CREATE TABLE memory_facets (
  memory_id   UUID NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  key         TEXT NOT NULL,                            -- 'gene', 'dataset', 'tool', 'pipeline', etc.
  value       TEXT NOT NULL,
  PRIMARY KEY (memory_id, key, value)
);

CREATE INDEX memory_facets_kv_idx
  ON memory_facets (key, value);

CREATE TABLE embedder_queue (
  chunk_id    BIGINT PRIMARY KEY REFERENCES memory_chunks(chunk_id) ON DELETE CASCADE,
  attempts    INT NOT NULL DEFAULT 0,
  last_error  TEXT,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memory_distill_cursor (
  username    TEXT PRIMARY KEY,
  last_seen_session_last_active TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01'::timestamptz
);
```

`memory_facets` is open-ended tagging — gene names, dataset accessions,
pipelines, tools. Filled by the distiller from a fixed prompt list (§8) plus
user-authored memories.

`embedder_queue` is a cheap work queue. The embedder worker SELECTs the
oldest N rows, batches them into one HTTP call, writes back the vectors, and
deletes the queue rows. Failed rows stay with `attempts++`; after 5 failures
they're left for inspection (no auto-purge).

`memory_distill_cursor` is per-user. The distiller polls every 60s for
`sessions WHERE last_active > cursor AND last_active < now() - interval '5 min'`
(i.e. settled-and-not-touched-recently), processes them, and advances the
cursor. This is much simpler than reactive triggers and tolerates indexer
restarts trivially.

## 7. Components in detail

### 7.1 Distiller (`hub/indexer/src/distiller.ts`)

Runs as a second loop alongside the watcher. Every 60s:

```
for each username in (SELECT DISTINCT username FROM sessions):
  cursor   = SELECT last_seen_session_last_active FROM memory_distill_cursor WHERE username = $1
  settled  = SELECT * FROM sessions
              WHERE username = $1
                AND last_active > cursor
                AND last_active < now() - interval '5 minutes'
              ORDER BY last_active LIMIT 50
  for each session in settled:
    transcript = stream JSONL via byte-range read (path-decode + Phase 1's path layout)
    pruned     = trim to last MAX_DISTILL_TOKENS (default 80k)  // recent matters more
    {summary, observations, facets} = await llm.distill(pruned, model='claude-haiku-4-5')
    BEGIN;
      INSERT INTO memories (... session_summary ...) ON CONFLICT DO NOTHING
      for each obs:
        INSERT INTO memories (... observation ...) ON CONFLICT DO NOTHING RETURNING memory_id
        INSERT INTO memory_chunks (memory_id, chunk_idx=0, content=body, embedding=NULL)
        for each (key,value) in facets[obs]: INSERT INTO memory_facets ...
        INSERT INTO embedder_queue (chunk_id) ON CONFLICT DO NOTHING
      UPDATE memory_distill_cursor SET last_seen_session_last_active = session.last_active
    COMMIT;
```

- **Settle window** = 5 min idle, configurable via `DISTILL_SETTLE_SEC`.
  Long enough that an active conversation isn't repeatedly re-distilled, short
  enough that today's work is recallable later today.
- **Token cap** prevents one giant session from melting the budget.
  `claude-haiku-4-5` 200k context easily handles 80k input + 4k output;
  prompt-cache hits across observations make this cheap.
- **Dedup by `(username, project_dir, type, content_hash)`** means the same
  session re-distilled (e.g., after a settle-window false negative) yields no
  duplicate rows.
- **Per-user advisory lock** (`pg_try_advisory_lock(hash(username))`) so two
  indexer instances (future HA) don't race on the same user.

### 7.2 Memory API (`hub/indexer/src/memory-api.ts`)

Fastify on port 8400, listening on the docker network. No auth — the network
is private and every adapter container is trusted (same trust model as Phase
2's PG access).

| Method + path | Body / query | Response |
|---|---|---|
| `POST /memory/search` | `{username, project_dir?, query, limit=10, types?, since?}` | `[{memory_id, name, description, snippet, score, scope_tier}]` |
| `GET /memory/:id` | — | `{memory_id, type, name, description, body, facets[], created_at, ...}` |
| `GET /memory/timeline` | `?username=&project_dir=&since=&until=&limit=50` | `[{memory_id, name, type, created_at}]` chronological |
| `POST /memory/write` | `{username, scope: 'user'|'project'|'org', project_dir?, type, name, description, body, facets?}` | `{memory_id}` |
| `POST /memory/forget` | `{username, memory_id}` | `{ok: true}` (sets `deleted_at`) |
| `GET /memory/context` | `?username=&project_path=&budget_tokens=2000` | `{system_prompt: "<formatted memory bundle>", memory_ids: [...]}` |

`project_dir` (encoded) is canonical on every endpoint. `/memory/context`
additionally accepts `project_path` (raw, e.g. `/workspace/local_projects/foo`)
because the `SessionStart` shell hook can't easily reproduce Claude Code's
filename encoding scheme — the API translates via Phase 1's `path-decode.ts`
so encoding stays in one place.

Search implementation — hybrid vector + FTS, ranked in SQL:

```sql
WITH q AS (SELECT $1::vector AS qv, plainto_tsquery('english', $2) AS qt),
candidates AS (
  SELECT mc.memory_id,
         mc.content,
         (1 - (mc.embedding <=> q.qv)) AS vec_sim,
         ts_rank(mc.tsv, q.qt) AS fts_score
  FROM memory_chunks mc, q
  WHERE mc.embedding IS NOT NULL OR mc.tsv @@ q.qt
  ORDER BY mc.embedding <=> q.qv
  LIMIT 200
)
SELECT m.memory_id, m.name, m.description,
       LEFT(c.content, 200) AS snippet,
       (c.vec_sim * 0.7 + LEAST(c.fts_score, 1.0) * 0.3) AS base_score,
       CASE
         WHEN m.username = '__org__'                              THEN 'org'
         WHEN m.project_dir IS NULL                               THEN 'user'
         ELSE 'project'
       END AS scope_tier
FROM memories m JOIN candidates c USING (memory_id)
WHERE m.deleted_at IS NULL
  AND (m.username = $username OR m.username = '__org__')
  AND (m.project_dir IS NULL OR m.project_dir = $project_dir)
  AND ($types::text[] IS NULL OR m.type = ANY($types))
ORDER BY (
  base_score
  * CASE scope_tier WHEN 'project' THEN 1.20 WHEN 'user' THEN 1.10 ELSE 1.00 END  -- specificity
  * (1.0 + LN(1 + m.hit_count) * 0.05)                                            -- popularity
  * EXP(-EXTRACT(EPOCH FROM (now() - m.created_at)) / (86400 * 90))                -- 90-day half-life-ish
) DESC
LIMIT $limit;
```

After a search, the API increments `hit_count` and `last_hit_at` for the
returned IDs in a single `UPDATE`.

### 7.3 Embedder sidecar (`hub/embedder/`)

Single FastAPI endpoint `POST /embed` taking `{texts: [str]}` and returning
`{vectors: [[float; 384]]}`. Model: `BAAI/bge-small-en-v1.5` (384 dims,
strong on MTEB retrieval, ~30ms/chunk on CPU). Image stays under 600 MB;
model weights baked in at build time so first run pre-warms.

A lightweight worker inside `hub/indexer/` polls `embedder_queue`:

```
every 5s:
  rows = SELECT chunk_id, content FROM memory_chunks
         JOIN embedder_queue USING (chunk_id)
         ORDER BY embedder_queue.enqueued_at LIMIT 64
  if rows:
    vecs = await POST embedder /embed {texts: rows.content}
    BEGIN; UPDATE memory_chunks SET embedding = $vec WHERE chunk_id = $id ...
           DELETE FROM embedder_queue WHERE chunk_id = ANY($ids); COMMIT
```

Pluggable behind `EMBEDDER_URL` env var. To swap to Voyage / Anthropic
embeddings, replace the URL and the dimension constant in 0007 (one
migration; existing chunks need re-embedding — accepted cost).

### 7.4 Per-container MCP server (`packages/bioflow-memory-mcp/`)

Standard `@modelcontextprotocol/sdk` Node binary. Reads `USERNAME`
(set by `add-user.sh`) and `MEMORY_API_URL` (defaults to
`http://claude-bioflow-indexer:8400`) from env. Wired in the per-user
`.mcp.json` that `add-user.sh` seeds. Tools:

```ts
memory_search(query: string, project_dir?: string, types?: string[], limit?: number)
  → [{memory_id, name, description, snippet, score, scope_tier}]   // ~50 tok each

memory_get(memory_id: string)
  → {memory_id, type, name, description, body, facets, created_at, source_session_id?}

memory_timeline(project_dir?: string, since?: ISO, until?: ISO, limit?: number)
  → [{memory_id, name, type, created_at}]

memory_write(scope: 'user'|'project', project_dir?: string, type, name, description, body, facets?)
  → {memory_id}
```

`memory_write` cannot write `scope: 'org'` from inside a user container; org
memories are operator-administered (analogous to how `workspaces/shared/`
mounts read-only into every container). Org-write goes through a separate
admin path that's out of scope here.

The MCP binary is installed globally in the devcontainer image, so every user
gets it without per-user install.

### 7.5 Hooks added to skeleton (`hub/skeleton/harness/hooks/memory_session_start.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail

# Skip if memory disabled (e.g. tests) or API unreachable
[ "${MEMORY_ENABLED:-1}" = "1" ] || exit 0
[ -n "${MEMORY_API_URL:-}" ] || exit 0

# Pass the raw project path; memory-api encodes it server-side using the
# helper from Phase 1 (hub/indexer/src/path-decode.ts), so the encoding
# scheme stays in one place. Never block session start on a hiccup.
curl -fsS --max-time 3 -G \
  --data-urlencode "username=${USERNAME}" \
  --data-urlencode "project_path=${CLAUDE_PROJECT_DIR:-/workspace}" \
  --data-urlencode "budget_tokens=2000" \
  "${MEMORY_API_URL}/memory/context" \
  | jq -r '.system_prompt' || true
```

The hook script's stdout becomes additional system context per Claude Code's
hook contract. A failed memory-api never blocks `SessionStart` — degrades
silently to "no injected memory."

**No `PostToolUse` hook.** This is the largest divergence from claude-mem.
Capture happens server-side in the distiller, not in-session.

### 7.6 Slash commands (`hub/skeleton/harness/commands/`)

Three short markdown commands added to the skeleton, copied into every user's
`.claude/commands/` by `add-user.sh`:

- `/memorize <text>` — `POST /memory/write` with `type='user'` and the text
  as `body`. Auto-derives `name`/`description` from the first line.
- `/recall <query>` — calls `memory_search` and prints the top 5 to the
  conversation. Shorthand for "force the agent to look at memory before
  answering."
- `/forget <memory-id>` — `POST /memory/forget`. The MCP `memory_search`
  output includes IDs so this is point-and-shoot.

## 8. Distillation prompt (`distiller-prompts.ts`)

Versioned prompt template. Bumping the version invalidates the dedup
content_hash for distilled rows (forces fresh distillation on next pass —
opt-in via `DISTILL_PROMPT_VERSION_FORCE_REDISTILL=1`).

```
SYSTEM:
You distill a Claude Code session transcript into structured memory rows for
later retrieval. Output strict JSON matching the schema below. Be terse.
Skip operational noise (file listings, command echoes, retries).

Schema (zod-validated downstream):
{
  summary: { name: string ≤80c, description: string ≤200c, body: string ≤1500c },
  observations: [
    {
      type: 'decision'|'finding'|'file-touched'|'command-result'|'user-preference',
      name: string ≤80c,
      description: string ≤200c,
      body: string ≤800c,
      facets: { gene?: string[], dataset?: string[], tool?: string[], pipeline?: string[], file?: string[] }
    }
  ]  // 0..8 items
}

Rules:
- A 'user-preference' captures something the user expressed about how they
  want the agent to work or what they care about — promote to a feedback
  memory upon distillation.
- A 'decision' captures a chosen approach with the why; not what was tried
  and discarded.
- A 'finding' captures a surprising fact the agent learned (data shape,
  bug root cause, env quirk).
- 'file-touched' is a path + one-line summary of what changed and why.
- 'command-result' is a command that produced a result the user is likely
  to need again (path-to-output, key number, error fingerprint).
- Skip everything else. Empty observations array is fine.

USER:
<transcript JSON, last MAX_DISTILL_TOKENS tokens>
```

`user-preference` observations are post-processed into `feedback`-typed
memories (with the prefix "Why:" / "How to apply:" structure that mirrors
the host's auto-memory format). All other observation types stay as
`type='observation'` with `source='distilled'`.

Model pinned to `claude-haiku-4-5` via `llm-client.ts`. Single env var
override `DISTILL_MODEL` for ops.

## 9. Scope model and retrieval

Three tiers, baked into the `(username, project_dir)` pair:

| Tier | `username` | `project_dir` | Meaning |
|---|---|---|---|
| org | `'__org__'` | `NULL` | Lab-wide knowledge, mirrors `workspaces/shared/` |
| user | `<username>` | `NULL` | Personal, follows the user across all projects |
| project | `<username>` | `<encoded_project_dir>` | Pinned to one `local_projects/<project>/` |

Search merges all three for a given `(username, project_dir)` and ranks per
the SQL in §7.2. The user's three open decisions from brainstorming
("embedding provider / distillation model / where the API lives") are baked
into bge-small / haiku-4-5 / extending the indexer.

## 10. Error handling

| Failure | Behavior |
|---|---|
| Distiller LLM call fails | Log; cursor not advanced; retried next 60s loop |
| Distiller LLM returns invalid JSON | zod-fail; fall back to summary-only with a `name` of "raw distillation failed" — keeps a row so we know we tried |
| Embedder sidecar down | `embedder_queue` rows accumulate; FTS still works; chunks become vector-searchable when embedder returns |
| Embedder returns wrong dimension | Hard fail; alarming log; queue row stays for inspection |
| memory-api returns 5xx to MCP | MCP returns `{error}`; agent continues without memory result |
| memory-api unreachable from `SessionStart` hook | Hook exits 0 with empty stdout; session starts normally |
| User runs `/memorize` while api down | Hook prints error to chat; nothing persisted |
| Postgres unreachable | Same backoff as Phase 1 indexer; 5 min cap then exit 1 |
| Two indexers running (future HA) | Per-user advisory lock in distiller; first wins, second skips |
| Org-memory write attempt from a user container | API rejects with 403; logged |
| `bge-small` model file missing in embedder image | Image build fails fast; pre-baked weights are part of CI |
| Session re-distilled (false-negative settle) | Content-hash dedup; no duplicate rows |
| LLM hallucinates a `gene` facet | Stored as a facet; downside is irrelevant search hits, mitigated by score ranking; no integrity risk |

Same operating principle as Phase 1: never `process.exit()` from worker
code. Distiller and embedder loops bubble errors to the loop boundary, log,
and re-enter on next tick.

## 11. JSONL ingestion contract

The distiller reads JSONL the same way Phase 1's `process-file.ts` does —
through `path-decode.ts` and `jsonl-parser.ts`. Forward-compat properties
from Phase 1 §10 carry over verbatim. The only new requirement is that the
distiller can stream a session's JSONL by `(username, encoded_project_dir,
session_id)`; this is one filesystem read, no new state.

If a session's JSONL has been moved to cold storage (Phase 3 of the prior
roadmap), the distiller skips it; cold-storage distillation is out of scope.
The cursor still advances past the `last_active` so we don't keep re-trying.

## 12. Configuration

Indexer (additions to existing env):

| var | required | default | notes |
|---|---|---|---|
| `MEMORY_API_PORT` | no | `8400` | fastify listen port |
| `ANTHROPIC_API_KEY` | yes (for distillation) | — | hub-side key; central billing |
| `DISTILL_MODEL` | no | `claude-haiku-4-5` | |
| `DISTILL_SETTLE_SEC` | no | `300` | settle window |
| `DISTILL_INTERVAL_SEC` | no | `60` | how often to scan for settled sessions |
| `DISTILL_MAX_TOKENS` | no | `80000` | input cap per session |
| `DISTILL_PROMPT_VERSION` | no | `1` | bump invalidates content_hash on next pass |
| `DISTILL_BATCH_SIZE` | no | `50` | sessions per user per scan |
| `EMBEDDER_URL` | no | `http://claude-bioflow-embedder:8000` | swap for paid API |
| `EMBEDDER_BATCH_SIZE` | no | `64` | chunks per embed call |
| `EMBEDDER_INTERVAL_MS` | no | `5000` | poll period |

Embedder service:

| var | required | default | notes |
|---|---|---|---|
| `EMBEDDER_MODEL` | no | `BAAI/bge-small-en-v1.5` | dimension must match 0007 |
| `EMBEDDER_PORT` | no | `8000` | |

Per-user adapter / container (added by `add-user.sh`):

| var | required | default | notes |
|---|---|---|---|
| `MEMORY_API_URL` | yes | `http://claude-bioflow-indexer:8400` | for MCP + hook |
| `USERNAME` | yes | `<username>` | already exists |
| `MEMORY_ENABLED` | no | `1` | kill switch for tests |

## 13. Testing

Same toolchain as Phases 1–2: `vitest` + `@testcontainers/postgresql`. New
fixture data: anonymised distillation outputs from real sessions.

### Unit (pure)

- `memory-rank.test.ts` — table-driven scoring: identical sims, different
  scope tiers → project ranks above user ranks above org; recency curve
  monotonic; hit_count boost saturates.
- `distiller-prompts.test.ts` — prompt is stable bytes; version bump
  changes content_hash.
- `path-decode.test.ts` — already covered in Phase 1; nothing new.

### Integration (testcontainers)

- `memory-repo.test.ts` — write/get/search/forget round-trip; UNIQUE dedup
  works; `__org__` sentinel scope merging.
- `memory-api.test.ts` — fastify `inject()` against real PG; multi-tenant
  isolation (alice writes, bob can't read except org).
- `distill-real-session.test.ts` — fixture JSONL session →
  distiller (with mocked LLM returning a fixed JSON) → assert N memory
  rows + facets + chunks queued.
- `search-mixed-scope.test.ts` — populate org + user + project memories,
  search, assert ordering reflects scope-specificity multiplier.
- `embedder-queue.test.ts` — enqueue 100 chunks, run worker against a stub
  embedder server, assert all chunks get vectors and queue drains.

### MCP server

- `packages/bioflow-memory-mcp/test/index.test.ts` — start a stub
  memory-api on localhost; exercise each of the 4 tools with valid +
  invalid inputs; assert the agent-facing JSON shape.

### CI gate

`npm test` (root + packages) under 90s including testcontainer boot. No
real LLM calls in CI — distiller tests stub `llm-client`.

## 14. Phased rollout

**Sub-phase A — silent distillation.** Land migrations 0006–0008,
distiller, embedder. No memory-api, no MCP, no hooks. Run for one week,
inspect distilled rows in PG by hand, tune the prompt. Zero user-visible
change.

**Sub-phase B — retrieval.** Land memory-api, MCP server, `SessionStart`
hook, slash commands. Roll one user (li86) by flipping `MEMORY_ENABLED`,
verify, then roll the rest. Backout = unset `MEMORY_ENABLED` (no schema
revert needed).

**Sub-phase C — UX + hardening.** Frontend memory browser
(list/edit/forget), soft-delete enforcement, audit log on write/forget,
basic metrics endpoint. Touches the existing frontend + adapter; not
scoped here.

## 15. Phase boundary check

After sub-phase A, `SELECT type, COUNT(*) FROM memories GROUP BY 1` shows
populated `session_summary` and `observation` rows for any session that
settled in the last week. The distiller's cursor advances; restarting the
indexer doesn't re-process or duplicate.

After sub-phase B, opening a fresh chat in any user's container injects
~1–2k tokens of relevant context as a system message at SessionStart, the
agent can call `memory_search` mid-turn, and `/memorize` writes a
user-authored memory that's findable in the next session.

What still doesn't work after this spec (by design):

- No memory editing UI — sub-phase C.
- No memory diff in code review of distiller prompt changes — out of scope;
  prompt versioning + content_hash gives us forced re-distillation as the
  manual lever.
- No paid-embedding upgrade path beyond "swap `EMBEDDER_URL`, run a
  re-embed migration" — accepted; we ship pluggable, not pre-built.
- No subagent-scoped memory — subagents inherit parent scope.
- No org-write API surface — operator-administered out-of-band; consistent
  with the way `workspaces/shared/CLAUDE.md` already works.

The two prior session-memory phases provided the substrate; this spec is the
first phase that gives the agent itself something to remember with.
