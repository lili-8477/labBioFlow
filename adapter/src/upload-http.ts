// HTTP upload server for the per-user devcontainer.
//
// Listens on a port (default 5000) inside the user's container; nginx proxies
// authenticated PUT/POST requests at /upload/<rel-path> here. The body is
// streamed straight to disk under the user's workspace — no buffering — so a
// 2 GB upload uses ~64 KB of RSS.
//
// All trust decisions live in this file. nginx authenticates the user (HTTP
// Basic) and routes to the right per-user container; once the request lands
// here we still validate the path because the SDK / agent code shares this
// process and we don't want a path-traversal bug to clobber CLAUDE.md, .env,
// or session state.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdir, realpath, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface UploadServerOptions {
  workspaceRoot: string;        // absolute, e.g. "/workspace"
  port: number;
  /** Subtree relative to workspaceRoot under which writes are allowed. */
  allowedSubtree?: string;       // default "local_projects"
  // Phase 2: needed for /share-snapshot/<id>/file proxy.
  username?:       string;       // omitted → /share-snapshot/ returns 503
  memoryApiUrl?:   string;       // omitted → /share-snapshot/ returns 503
}

const DENY_NAMES = new Set([".env", ".claude", "CLAUDE.md", ".bioflow"]);

export function startUploadServer(opts: UploadServerOptions): Server {
  const { workspaceRoot, port } = opts;
  const allowed = opts.allowedSubtree ?? "local_projects";
  const allowedPrefix = resolve(workspaceRoot, allowed) + "/";
  const username     = opts.username ?? null;
  const memoryApiUrl = opts.memoryApiUrl ?? null;

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res, { workspaceRoot, allowedPrefix, username, memoryApiUrl });
    } catch (err) {
      console.error("[upload] handler crashed:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.end();
    }
  });

  server.on("error", (err) => {
    console.error(`[upload] server error on port ${port}:`, err);
  });

  server.listen(port, () => {
    console.log(`[upload] listening on :${port}, writes allowed under ${allowedPrefix}`);
  });

  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { workspaceRoot: string; allowedPrefix: string; username: string | null; memoryApiUrl: string | null },
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  if (url === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.startsWith("/share-snapshot/") && method === "GET") {
    await handleShareSnapshot(req, res, ctx);
    return;
  }

  if (method !== "PUT" && method !== "POST") {
    res.setHeader("Allow", "PUT, POST");
    sendJson(res, 405, { error: "method" });
    return;
  }

  if (!url.startsWith("/upload/")) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  // Decode the path, segment by segment, and validate each.
  let relPath: string;
  try {
    relPath = decodeURIComponent(url.slice("/upload/".length));
  } catch {
    sendJson(res, 400, { error: "bad_path_encoding" });
    return;
  }
  if (!relPath || relPath.endsWith("/")) {
    sendJson(res, 400, { error: "missing_filename" });
    return;
  }

  // Reject deny-listed top-level names defensively, even within the allowed
  // subtree — nothing legitimate should land at e.g. local_projects/.env.
  for (const seg of relPath.split("/")) {
    if (DENY_NAMES.has(seg)) {
      sendJson(res, 403, { error: "denied_name", segment: seg });
      return;
    }
  }

  const abs = resolve(ctx.workspaceRoot, relPath);
  if (!isUnder(abs, ctx.allowedPrefix)) {
    sendJson(res, 403, { error: "path_outside_allowed_subtree", path: abs });
    return;
  }

  // Symlink hardening: realpath the parent (after mkdir-p). If the resolved
  // path leaves the allowed subtree, refuse — this stops a planted symlink
  // from redirecting our write outside local_projects.
  const parent = dirname(abs);
  await mkdir(parent, { recursive: true });
  let parentReal: string;
  try {
    parentReal = await realpath(parent);
  } catch (err) {
    sendJson(res, 500, { error: "stat_parent_failed", message: (err as Error).message });
    return;
  }
  if (!isUnder(parentReal + "/", ctx.allowedPrefix)) {
    sendJson(res, 403, { error: "parent_resolves_outside_allowed_subtree", parent: parentReal });
    return;
  }

  // Stream the body into the file. Size accounting is only used for the
  // success response — nginx already enforces client_max_body_size 2g.
  let bytesWritten = 0;
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try { await unlink(abs); } catch { /* may not exist yet */ }
  };

  const sink = createWriteStream(abs, { mode: 0o644 });
  let aborted = false;

  await new Promise<void>((resolveP, rejectP) => {
    req.on("data", (chunk: Buffer) => { bytesWritten += chunk.length; });
    req.on("aborted", () => { aborted = true; });
    sink.on("error", (err) => {
      aborted = true;
      sink.destroy();
      rejectP(err);
    });
    sink.on("finish", () => resolveP());
    req.pipe(sink);
  }).catch(async (err: Error) => {
    await cleanup();
    if (!res.headersSent) {
      // ENOSPC, EACCES, etc.
      const code = (err as NodeJS.ErrnoException).code;
      sendJson(res, code === "ENOSPC" ? 507 : 500, { error: "write_failed", code, message: err.message });
    } else {
      res.end();
    }
  });

  if (aborted) {
    await cleanup();
    if (!res.headersSent) {
      // The client gave up; respond with 499-like (nginx convention) but http
      // doesn't define 499. Use 400 with a reason. Frontend will see it as a
      // failure regardless.
      sendJson(res, 499, { error: "client_aborted" });
    }
    return;
  }

  if (!res.headersSent) {
    sendJson(res, 201, { path: abs, size: bytesWritten });
  }
}

function isUnder(path: string, allowedPrefix: string): boolean {
  // allowedPrefix always ends with "/". For files, append nothing extra; the
  // file path will be allowedPrefix + something, which startsWith the prefix.
  const withSlash = path.endsWith("/") ? path : path + "/";
  return withSlash.startsWith(allowedPrefix) || path === allowedPrefix.slice(0, -1);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

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
