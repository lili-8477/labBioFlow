import type { Pool } from "pg";
import { logger } from "./config.js";
import { findSettledSessions, writeDistillation, type SettledSession } from "./distiller-repo.js";
import { getCursor, setCursor } from "./distiller-cursor.js";
import type { DistillationResult } from "./distiller-prompts.js";

export interface RunDistillerOpts {
  llm:               (transcript: string) => Promise<DistillationResult>;
  readTranscript:    (s: SettledSession) => Promise<string>;
  settleSeconds:     number;
  perUserLimit:      number;
  maxDistillTokens:  number;
  promptVersion:     number;
}

export interface RunSummary {
  usersScanned:      number;
  sessionsDistilled: number;
  sessionsFailed:    number;
}

const CHARS_PER_TOKEN = 4; // crude; sufficient for a transcript-trimming guard

export async function runDistillerOnce(pool: Pool, opts: RunDistillerOpts): Promise<RunSummary> {
  const summary: RunSummary = { usersScanned: 0, sessionsDistilled: 0, sessionsFailed: 0 };
  const users = await pool.query<{ username: string }>(
    "SELECT DISTINCT username FROM sessions",
  );
  for (const row of users.rows) {
    summary.usersScanned++;
    const lockKey = userLockKey(row.username);
    const client = await pool.connect();
    try {
      const got = await client.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS ok",
        [lockKey.toString()],
      );
      if (!got.rows[0]?.ok) continue; // another worker has this user
      try {
        await processUser(pool, row.username, opts, summary);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [lockKey.toString()]);
      }
    } finally {
      client.release();
    }
  }
  return summary;
}

async function processUser(
  pool:     Pool,
  username: string,
  opts:     RunDistillerOpts,
  summary:  RunSummary,
): Promise<void> {
  const cursor = await getCursor(pool, username);
  const settled = await findSettledSessions(pool, {
    username,
    cursor,
    settleSeconds: opts.settleSeconds,
    limit: opts.perUserLimit,
  });
  for (const s of settled) {
    try {
      const raw = await opts.readTranscript(s);
      const trimmed = raw.length > opts.maxDistillTokens * CHARS_PER_TOKEN
        ? raw.slice(-opts.maxDistillTokens * CHARS_PER_TOKEN)
        : raw;
      const result = await opts.llm(trimmed);
      await writeDistillation(pool, {
        sessionMeta: {
          username,
          project_dir:       s.encoded_project_dir,
          source_session_id: s.session_id,
        },
        result,
        promptVersion: opts.promptVersion,
      });
      await setCursor(pool, username, s.last_active);
      summary.sessionsDistilled++;
    } catch (err) {
      summary.sessionsFailed++;
      logger.error(
        { err, username, sessionId: s.session_id },
        "distillation failed; cursor not advanced",
      );
      // stop processing this user this pass — the next pass will retry the same session
      return;
    }
  }
}

function userLockKey(username: string): bigint {
  // 64-bit FNV-1a hash, fits Postgres bigint and stable across processes.
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < username.length; i++) {
    h ^= BigInt(username.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  // Map to signed bigint range expected by pg_advisory_lock.
  return h <= 0x7fffffffffffffffn ? h : h - 0x10000000000000000n;
}
