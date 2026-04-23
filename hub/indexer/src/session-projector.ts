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
  title_candidate: string | null;
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
    // Start from the first non-title entry's timestamp (title entries have
    // synthetic epoch-0 timestamps that must not pollute first_active/last_active).
    const realEntries = group.filter((e) => e.type !== "title");
    let firstTs = (realEntries[0] ?? group[0]!).timestamp;
    let lastTs = (realEntries[0] ?? group[0]!).timestamp;
    let isSidechain = false;
    let model: string | null = null;
    let titleCandidate: string | null = null;
    let messageCount = 0;
    const delta = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

    for (const e of group) {
      if (e.type === "title") {
        if (e.title) titleCandidate = e.title; // last non-null wins
        continue;
      }
      messageCount++;
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
      message_count_delta: messageCount,
      token_usage_delta: delta,
      first_active_candidate: firstTs,
      last_active: lastTs,
      is_sidechain: isSidechain,
      title_candidate: titleCandidate,
    });
  }

  return { sessionUpserts, tokenRows };
}
