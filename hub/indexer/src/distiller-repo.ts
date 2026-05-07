import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { DistillationResult, Observation } from "./distiller-prompts.js";
import { contentHash } from "./content-hash.js";

export interface SettledSession {
  session_id:          string;
  username:            string;
  encoded_project_dir: string;
  last_active:         Date;
}

export async function findSettledSessions(
  pool: Pool,
  args: { username: string; cursor: Date; settleSeconds: number; limit: number },
): Promise<SettledSession[]> {
  const r = await pool.query<SettledSession>(
    `SELECT session_id, username, encoded_project_dir, last_active
       FROM sessions
      WHERE username = $1
        AND last_active > $2
        AND last_active < (now() - ($3::int || ' seconds')::interval)
      ORDER BY last_active ASC
      LIMIT $4`,
    [args.username, args.cursor.toISOString(), args.settleSeconds, args.limit],
  );
  return r.rows;
}

export interface SessionMeta {
  username:           string;
  project_dir:        string | null;
  // Nullable because /memory/distill (agent-driven) may not know the session
  // UUID, and user-authored memories elsewhere already pass NULL.
  source_session_id:  string | null;
}

export interface WriteDistillationArgs {
  sessionMeta:    SessionMeta;
  result:         DistillationResult;
  promptVersion:  number;
}

export interface InsertMemoryRowArgs {
  username:           string;
  project_dir:        string | null;
  source:             "distilled" | "user";
  type:               string;
  source_session_id:  string | null;
  name:               string;
  description:        string;
  body:               string;
  facets:             Record<string, string[] | undefined>;
  content_hash:       Buffer;
}

export async function insertMemoryRow(
  client: PoolClient,
  args:   InsertMemoryRowArgs,
): Promise<string | null> {
  const memId = randomUUID();
  const ins = await client.query<{ memory_id: string }>(
    `INSERT INTO memories (
       memory_id, username, project_dir, type, source,
       name, description, body, source_session_id, content_hash
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (username, project_dir, type, content_hash) DO NOTHING
     RETURNING memory_id`,
    [
      memId, args.username, args.project_dir, args.type, args.source,
      args.name, args.description, args.body, args.source_session_id, args.content_hash,
    ],
  );
  if (ins.rowCount === 0) return null; // dedup; nothing else to write

  const writtenId = ins.rows[0]!.memory_id;
  const chunk = await client.query<{ chunk_id: string }>(
    `INSERT INTO memory_chunks (memory_id, chunk_idx, content)
     VALUES ($1, 0, $2) RETURNING chunk_id`,
    [writtenId, args.body],
  );
  await client.query(
    `INSERT INTO embedder_queue (chunk_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [chunk.rows[0]!.chunk_id],
  );
  for (const [k, vs] of Object.entries(args.facets)) {
    if (!vs) continue;
    for (const v of vs) {
      await client.query(
        `INSERT INTO memory_facets (memory_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [writtenId, k, v],
      );
    }
  }
  return writtenId;
}

export async function writeDistillation(
  pool: Pool,
  args: WriteDistillationArgs,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insertDistilled(client, args.sessionMeta, "session_summary", {
      name:        args.result.summary.name,
      description: args.result.summary.description,
      body:        args.result.summary.body,
      facets:      {},
    }, args.promptVersion);

    for (const obs of args.result.observations) {
      const memType = obs.type === "user-preference" ? "feedback" : "observation";
      await insertDistilled(client, args.sessionMeta, memType, obs, args.promptVersion);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function insertDistilled(
  client:        PoolClient,
  meta:          SessionMeta,
  memType:       string,
  payload:       Pick<Observation, "name" | "description" | "body" | "facets">,
  promptVersion: number,
): Promise<void> {
  const hash = contentHash({ body: `${payload.name}\n${payload.body}`, promptVersion });
  await insertMemoryRow(client, {
    username:          meta.username,
    project_dir:       meta.project_dir,
    source:            "distilled",
    type:              memType,
    source_session_id: meta.source_session_id,
    name:              payload.name,
    description:       payload.description,
    body:              payload.body,
    facets:            payload.facets,
    content_hash:      hash,
  });
}
