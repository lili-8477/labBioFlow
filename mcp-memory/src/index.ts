#!/usr/bin/env node
/**
 * bioflow-memory-mcp — stdio MCP server bridging Claude Code agents
 * to the bioflow memory-api HTTP service.
 *
 * Design notes:
 * - Thin bridge, no business logic. Each MCP tool is a 1-call HTTP proxy
 *   to memory-api. Validation and storage live in the API.
 * - `username` is fixed per-process from the env (one container = one user
 *   in the bioflow model); the agent never supplies it. This is what stops
 *   a curious agent from snooping another user's memories.
 * - org-scope writes are rejected at this layer because the only legitimate
 *   author is the platform admin running indexing, not an in-container
 *   agent. The API still accepts them for the indexer's own writes.
 * - HTTP errors (network, 4xx, 5xx) become MCP `isError: true` results so
 *   the calling agent sees them and can decide whether to retry, ask the
 *   user, or give up — surfacing as MCP transport errors would just kill
 *   the tool call.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ─── tool definitions ──────────────────────────────────────────────────
// JSON Schema (not zod) because that's what MCP clients consume verbatim
// from list_tools to render the tool surface to the model. Keep schemas
// permissive: validation is the API's job, and over-validating here would
// duplicate logic and silently mask new fields the API learns later.

export const toolDefinitions = [
  {
    name: "memory_search",
    description:
      "Search agent memories by hybrid (vector + FTS) ranking. Scoped to the current user; pass project_dir to narrow to one project.",
    inputSchema: {
      type: "object",
      properties: {
        query:       { type: "string", description: "Free-text query." },
        project_dir: { type: "string", description: "Encoded project dir (e.g. -home-alice-proj). Omit for cross-project search." },
        types:       { type: "array",  items: { type: "string" }, description: "Filter to memory types (user, feedback, project, reference)." },
        limit:       { type: "integer", minimum: 1, maximum: 100 },
        since:       { type: "string", description: "ISO-8601 cutoff; only memories created after are returned." },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_get",
    description: "Fetch a single memory by id. Returns null/404-error if not found.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "memory_timeline",
    description:
      "List memories in reverse-chronological order for the current user, optionally narrowed by project_dir/since/until.",
    inputSchema: {
      type: "object",
      properties: {
        project_dir: { type: "string" },
        since:       { type: "string", description: "ISO-8601" },
        until:       { type: "string", description: "ISO-8601" },
        limit:       { type: "integer", minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: "memory_write",
    description:
      "Author a new memory. scope='user' for personal memories, scope='project' (with project_dir) for project-scoped. scope='org' is admin-only and rejected here.",
    inputSchema: {
      type: "object",
      properties: {
        scope:       { type: "string", enum: ["user", "project"] },
        project_dir: { type: "string", description: "Required when scope='project'." },
        type:        { type: "string", enum: ["user", "feedback", "project", "reference"] },
        name:        { type: "string" },
        description: { type: "string" },
        body:        { type: "string" },
        facets:      { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
      },
      required: ["scope", "type", "name", "description", "body"],
    },
  },
] as const;

// ─── deps & result types ───────────────────────────────────────────────

export interface ToolDeps {
  fetch:    typeof fetch;
  baseUrl:  string; // e.g. http://claude-bioflow-indexer:8400
  username: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// Wrap a successful JSON payload in the shape MCP expects. The agent reads
// content[0].text — we stringify so structured data round-trips losslessly
// rather than getting flattened to "[object Object]".
function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

// Build an error result. We include status + body so the model can read why
// the call failed without us having to translate API errors to prose.
function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Shared HTTP→ToolResult unwrap. Anything non-2xx becomes an MCP error
// containing the raw body (which memory-api makes JSON-friendly already).
async function unwrap(res: Response, label: string): Promise<ToolResult> {
  const text = await res.text();
  if (!res.ok) {
    return fail(`${label} failed: HTTP ${res.status} ${res.statusText} — ${text}`);
  }
  // Pass through the API's JSON verbatim. If it isn't JSON (shouldn't happen
  // for these endpoints), wrap the raw text so the agent at least sees it.
  try {
    return ok(JSON.parse(text));
  } catch {
    return ok(text);
  }
}

// ─── tool handlers ─────────────────────────────────────────────────────
// Exported individually so tests can drive them without wiring the SDK
// stdio transport. Each catches network errors so the agent gets a
// structured tool-error rather than a transport-level crash.

export async function callMemorySearch(args: any, deps: ToolDeps): Promise<ToolResult> {
  // Build body explicitly: only forward fields the user supplied so that
  // optional API params remain optional on the wire (don't poison filters
  // with `undefined` keys after JSON.stringify drops them).
  const body: Record<string, unknown> = { username: deps.username, query: args?.query };
  if (args?.project_dir !== undefined) body.project_dir = args.project_dir;
  if (args?.limit       !== undefined) body.limit       = args.limit;
  if (args?.types       !== undefined) body.types       = args.types;
  if (args?.since       !== undefined) body.since       = args.since;
  try {
    const res = await deps.fetch(`${deps.baseUrl}/memory/search`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify(body),
    });
    return await unwrap(res, "memory_search");
  } catch (err) {
    return fail(`memory_search network error: ${(err as Error).message}`);
  }
}

export async function callMemoryGet(args: any, deps: ToolDeps): Promise<ToolResult> {
  // encodeURIComponent because memory ids are content hashes today but the
  // schema permits any string; defensive against future id changes.
  const id = encodeURIComponent(String(args?.id ?? ""));
  try {
    const res = await deps.fetch(`${deps.baseUrl}/memory/${id}`);
    return await unwrap(res, "memory_get");
  } catch (err) {
    return fail(`memory_get network error: ${(err as Error).message}`);
  }
}

export async function callMemoryTimeline(args: any, deps: ToolDeps): Promise<ToolResult> {
  const params = new URLSearchParams({ username: deps.username });
  if (args?.project_dir !== undefined) params.set("project_dir", String(args.project_dir));
  if (args?.since       !== undefined) params.set("since",       String(args.since));
  if (args?.until       !== undefined) params.set("until",       String(args.until));
  if (args?.limit       !== undefined) params.set("limit",       String(args.limit));
  try {
    const res = await deps.fetch(`${deps.baseUrl}/memory/timeline?${params.toString()}`);
    return await unwrap(res, "memory_timeline");
  } catch (err) {
    return fail(`memory_timeline network error: ${(err as Error).message}`);
  }
}

export async function callMemoryWrite(args: any, deps: ToolDeps): Promise<ToolResult> {
  // Hard reject org-scope BEFORE any HTTP traffic. The memory-api will
  // happily accept it (it's used by the indexer's own admin writes), so
  // this guard is the only thing keeping in-container agents from poisoning
  // org-wide memory.
  if (args?.scope === "org") {
    return fail(
      "memory_write rejected: org-scope writes are admin-only and not available from inside a user container.",
    );
  }
  const body: Record<string, unknown> = {
    username:    deps.username,
    scope:       args?.scope,
    type:        args?.type,
    name:        args?.name,
    description: args?.description,
    body:        args?.body,
  };
  if (args?.project_dir !== undefined) body.project_dir = args.project_dir;
  if (args?.facets      !== undefined) body.facets      = args.facets;
  try {
    const res = await deps.fetch(`${deps.baseUrl}/memory/write`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify(body),
    });
    return await unwrap(res, "memory_write");
  } catch (err) {
    return fail(`memory_write network error: ${(err as Error).message}`);
  }
}

// ─── stdio entrypoint ──────────────────────────────────────────────────
// Only run main() when invoked as a script. Test imports just want the
// handler functions and must not start a stdio server (which would hang
// vitest waiting for stdin).

async function main(): Promise<void> {
  const username = process.env.USERNAME ?? "";
  const baseUrl  = process.env.MEMORY_API_URL ?? "http://claude-bioflow-indexer:8400";
  if (!username) {
    console.error("[bioflow-memory-mcp] USERNAME env var required");
    process.exit(1);
  }

  const deps: ToolDeps = { fetch, baseUrl, username };

  const server = new Server(
    { name: "bioflow-memory-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // Cast away the readonly-ness of `as const` for the SDK's mutable type.
    tools: toolDefinitions as unknown as Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    let result: ToolResult;
    switch (name) {
      case "memory_search":   result = await callMemorySearch(args, deps); break;
      case "memory_get":      result = await callMemoryGet(args, deps); break;
      case "memory_timeline": result = await callMemoryTimeline(args, deps); break;
      case "memory_write":    result = await callMemoryWrite(args, deps); break;
      default:                result = fail(`unknown tool: ${name}`); break;
    }
    // SDK 1.x widened CallToolResult to include a "task" variant (long-running
    // tools); we only emit synchronous {content,isError} results, so cast.
    return result as unknown as { content: ToolResult["content"]; isError?: boolean };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs forever via stdio; no further code after connect.
}

// Run main() when this file is the program entrypoint. Using import.meta.url
// vs process.argv[1] is the canonical ESM check and works whether tsc emits
// the file as dist/index.js or it's run via tsx during dev.
const invokedDirect =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/bioflow-memory-mcp") === true;
if (invokedDirect) {
  main().catch((err) => {
    console.error("[bioflow-memory-mcp] fatal:", err);
    process.exit(1);
  });
}
