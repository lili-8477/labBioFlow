export interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface ParsedEntry {
  type: "user" | "assistant" | "title";
  uuid: string;            // synthetic for title entries (see parseJsonlLine)
  sessionId: string;
  timestamp: string;       // synthetic for title entries (see parseJsonlLine)
  isSidechain: boolean;
  model: string | null;
  usage: TokenUsage | null;
  title: string | null;    // populated only when type === "title"
}

const INTERESTING = new Set(["user", "assistant", "ai-title"]);

// Canonical UUID v1-v5 format: 8-4-4-4-12 lowercase/uppercase hex. We reject
// non-UUID ids at the parser because `sessions.session_id` and
// `token_usage_log.entry_uuid` are declared UUID in the schema — letting a
// malformed id reach commitPass would roll back the whole transaction, leave
// the file offset unchanged, and wedge the file forever.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a single JSONL line. Returns null for: blank lines, malformed JSON,
 * entries whose `type` is not `user`/`assistant`, entries missing any of
 * `uuid`/`sessionId`/`timestamp`, and entries whose `uuid` or `sessionId` is
 * not a valid UUID. Never throws. Pure — callers are responsible for any
 * rate-limited logging of skip reasons (see spec §7.3).
 */
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

  // ai-title: { type: "ai-title", sessionId, aiTitle }. No uuid/timestamp;
  // we synthesise stable values so the downstream shape is uniform.
  if (type === "ai-title") {
    const sessionId = obj.sessionId;
    const aiTitle = obj.aiTitle;
    if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) return null;
    if (typeof aiTitle !== "string" || aiTitle.length === 0) return null;
    return {
      type: "title",
      uuid: `00000000-0000-0000-0000-000000000000`,
      sessionId,
      timestamp: "1970-01-01T00:00:00.000Z",
      isSidechain: false,
      model: null,
      usage: null,
      title: aiTitle,
    };
  }

  const uuid = obj.uuid;
  const sessionId = obj.sessionId;
  const timestamp = obj.timestamp;
  if (typeof uuid !== "string" || typeof sessionId !== "string" || typeof timestamp !== "string") {
    return null;
  }
  if (!UUID_RE.test(uuid) || !UUID_RE.test(sessionId)) return null;
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
  return { type: type as ParsedEntry["type"], uuid, sessionId, timestamp, isSidechain, model, usage, title: null };
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
