// RPC dispatch: maps frontend method names to handlers. The frontend contract
// is pinned — see pantheon-frontend/src/stores/chat.ts for the list of calls.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ChatsRepo } from "./chats-repo.js";
import { runTurn } from "./claude.js";
import { AbortRegistry, ChatMutexRegistry } from "./concurrency.js";
import { FileManager } from "./fs-rpc.js";
import { readSessionMessages } from "./history.js";
import { KernelBridge, type IOPubEvent } from "./kernel.js";
import { MemoryRpcClient } from "./memory-rpc.js";
import { NotebookManager } from "./notebook-rpc.js";
import { ShareRpcClient } from "./share-rpc.js";
import { listOrgSkills } from "./org-skills-rpc.js";
import { listUserSkills } from "./skills-rpc.js";
import type { StreamEvent } from "./types.js";

export interface RpcDeps {
  serviceId: string;
  workspaceRoot: string;
  chats: ChatsRepo;
  home: string;
  defaultProjectCwd: string; // where `chat` runs by default (a project dir)
  publishStream: (streamId: string, ev: StreamEvent) => void;
  /** Raw NATS publish for non-chat streams (notebook IOPub, etc.). */
  publishRaw: (subject: string, envelope: Record<string, unknown>) => void;
  /** Subject for streams (frontend `pantheon.stream.<id>`). */
  streamSubject: (streamId: string) => string;
  /** Path to the Python kernel bridge script. */
  kernelBridgePath: string;
  /** Idle-cull threshold (ms). 0 disables automatic culling. */
  kernelIdleCullMs?: number;
  /** How often to check for cull (ms). Defaults to 60_000. */
  kernelCullCheckIntervalMs?: number;
  /** Memory API client. null when MEMORY_API_URL is not configured. */
  memory: MemoryRpcClient | null;
  /** Share API client. null when MEMORY_API_URL is not configured. */
  share: ShareRpcClient | null;
}

export class RpcRouter {
  private chats: ChatsRepo;
  private files: FileManager;
  private notebooks: NotebookManager;
  private mutexes = new ChatMutexRegistry();
  private aborts = new AbortRegistry();

  constructor(private deps: RpcDeps) {
    this.chats = deps.chats;
    this.files = new FileManager(deps.workspaceRoot);
    // Kernel session_id = `<prefix>_<hash-of-notebook-path>`. One kernel
    // per notebook so their variable namespaces don't bleed together.
    const kernelSessionPrefix = `k_${deps.serviceId.slice(0, 16)}`;
    const kernelFactory = (sessionId: string): KernelBridge =>
      new KernelBridge({
        bridgePath: deps.kernelBridgePath,
        sessionId,
        onIopub: (sid, ev) => this.publishIopub(sid, ev),
        cullIdleMs: deps.kernelIdleCullMs,
        cullCheckIntervalMs: deps.kernelCullCheckIntervalMs,
        onCulled: (sid, reason) => this.publishCulled(sid, reason),
      });
    this.notebooks = new NotebookManager(
      deps.workspaceRoot,
      kernelFactory,
      kernelSessionPrefix,
    );
  }

  private settingsPath(): string {
    return path.join(this.deps.home, ".claude", "settings.json");
  }

  private async readSettings(): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(this.settingsPath(), "utf8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }

  private async writeSettings(obj: Record<string, unknown>): Promise<void> {
    await fs.writeFile(this.settingsPath(), JSON.stringify(obj, null, 2) + "\n", "utf8");
  }

  private publishCulled(
    sessionId: string,
    reason: { idleMs: number; thresholdMs: number },
  ): void {
    // Publish a synthetic iopub-style status message so any frontend listening
    // on notebook_iopub_<sessionId> learns the kernel was culled. Next
    // executeCell will respawn lazily.
    const subject = this.deps.streamSubject(`notebook_iopub_${sessionId}`);
    this.deps.publishRaw(subject, {
      type: "notebook",
      session_id: this.deps.serviceId,
      timestamp: Date.now() / 1000,
      data: {
        msg_type: "status",
        content: { execution_state: "dead", cull_reason: reason },
      },
      metadata: { cell_id: undefined },
    });
  }

  private publishIopub(sessionId: string, ev: IOPubEvent): void {
    const subject = this.deps.streamSubject(`notebook_iopub_${sessionId}`);
    this.deps.publishRaw(subject, {
      type: "notebook",
      session_id: this.deps.serviceId,
      timestamp: Date.now() / 1000,
      data: {
        msg_type: ev.msg_type,
        content: ev.content,
      },
      metadata: { cell_id: ev.cell_id ?? undefined },
    });
  }

  abortAll(): void {
    this.aborts.abortAll();
    this.notebooks.shutdownAll();
  }

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    const short = method === "chat"
      ? `chat(chat_id=${String(params.chat_id).slice(0, 8)}..., len=${(params.message as unknown[])?.length ?? 0})`
      : method;
    console.log(`[rpc] -> ${short}`);
    try {
      const result = await this.dispatchInner(method, params);
      console.log(`[rpc] <- ${method} ok`);
      return result;
    } catch (e) {
      console.error(`[rpc] <- ${method} err:`, e instanceof Error ? e.stack ?? e.message : e);
      throw e;
    }
  }

  private async dispatchInner(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "get_endpoint":
        return { success: true, service_id: this.deps.serviceId };

      case "get_model": {
        const cur = await this.readSettings();
        return { success: true, model: (cur.model as string) ?? "claude-sonnet-4-6" };
      }

      case "set_model": {
        const model = params.model as string;
        if (!model || typeof model !== "string") throw new Error("model required");
        const cur = await this.readSettings();
        cur.model = model;
        await this.writeSettings(cur);
        return { success: true, model };
      }

      case "list_chats": {
        const chats = await this.chats.list();
        return { success: true, chats };
      }

      case "create_chat": {
        const name = (params.chat_name as string | undefined) ?? "New chat";
        const chatId = crypto.randomUUID();
        await this.chats.create(chatId, name);
        return { success: true, chat_id: chatId };
      }

      case "delete_chat": {
        const chatId = params.chat_id as string;
        await this.chats.delete(chatId);
        this.mutexes.delete(chatId);
        return { success: true };
      }

      case "update_chat_name": {
        const chatId = params.chat_id as string;
        const name = params.chat_name as string;
        await this.chats.updateName(chatId, name);
        return { success: true };
      }

      case "get_chat_messages": {
        const chatId = params.chat_id as string;
        const chat = await this.chats.read(chatId);
        // Use the real SDK session UUID if we have one, else fall back to chat_id.
        const sessionUuid = chat?.session_id ?? chatId;
        const messages = await readSessionMessages(
          this.deps.home,
          this.deps.defaultProjectCwd,
          sessionUuid,
        );
        return { success: true, messages };
      }

      case "get_suggestions":
        return { success: true, suggestions: [] };

      case "get_agents": {
        // Hide harness-internal subagents (planner/executor/reviewer of the
        // tick harness) from the user-facing agents listing. They're dispatched
        // by the orchestrator via the Task tool, not picked by the user.
        // Convention: names starting with `tick-` or `_` are internal.
        const agentsDir = path.join(this.deps.home, ".claude", "agents");
        const names = await fs.readdir(agentsDir).catch(() => [] as string[]);
        const agents = names
          .filter((n) => n.endsWith(".md"))
          .map((n) => n.replace(/\.md$/, ""))
          .filter((n) => !n.startsWith("tick-") && !n.startsWith("_"))
          .map((name) => ({
            name,
            instructions: "",
            tools: [],
            toolsets: [],
            icon: "",
            not_loaded_toolsets: [],
            model: null,
            models: [],
          }));
        return { success: true, agents, can_switch_agents: false };
      }

      case "get_harness_mode": {
        const flag = path.join(this.deps.home, ".claude", ".harness_active");
        const active = await fs.stat(flag).then(() => true).catch(() => false);
        // installed = the orchestrator command + tick-* agents are present.
        const cmdFile = path.join(this.deps.home, ".claude", "commands", "tick.md");
        const installed = await fs.stat(cmdFile).then(() => true).catch(() => false);
        return { success: true, active, installed };
      }

      case "set_harness_mode": {
        const enabled = Boolean(params.enabled);
        const flag = path.join(this.deps.home, ".claude", ".harness_active");
        if (enabled) {
          await fs.mkdir(path.dirname(flag), { recursive: true });
          await fs.writeFile(flag, "");
        } else {
          await fs.unlink(flag).catch(() => { /* not present is fine */ });
        }
        return { success: true, active: enabled };
      }

      case "get_harness_progress": {
        // Two ways to find the right progress.md:
        //   1. project_name matches a local_projects/<dir>/progress.md (works
        //      for drop-created chats where chat-name === project-dir name).
        //   2. Fallback: the most-recently-modified progress.md anywhere under
        //      local_projects/. Covers the typed-prompt flow where the chat
        //      keeps its default name but tick-bootstrap picks a project slug
        //      from the user's message.
        // Returns the matched project name so the UI can show it.
        const projectsRoot = path.join(this.deps.workspaceRoot, "local_projects");

        const tryPath = async (p: string): Promise<string | null> => {
          try { return await fs.readFile(p, "utf8"); }
          catch { return null; }
        };

        const projectName = (params.project_name as string | undefined)?.trim();
        let raw: string | null = null;
        let matchedProject: string | null = null;

        // Path #1: by name.
        if (projectName && !projectName.includes("/") && !projectName.startsWith(".")) {
          raw = await tryPath(path.join(projectsRoot, projectName, "progress.md"));
          if (raw != null) matchedProject = projectName;
        }

        // Path #2: most-recently-modified progress.md as a fallback. We only
        // consider files modified in the last 6h so a stale project from
        // weeks ago doesn't masquerade as the active one.
        if (raw == null) {
          let dirs: string[] = [];
          try {
            dirs = await fs.readdir(projectsRoot);
          } catch {
            return { success: true, exists: false, progress: null, project_name: null };
          }
          const cutoff = Date.now() - 6 * 60 * 60 * 1000;
          let best: { name: string; mtime: number } | null = null;
          for (const d of dirs) {
            if (d.startsWith(".") || d.startsWith("_")) continue;
            const p = path.join(projectsRoot, d, "progress.md");
            const st = await fs.stat(p).catch(() => null);
            if (!st || st.mtimeMs < cutoff) continue;
            if (!best || st.mtimeMs > best.mtime) best = { name: d, mtime: st.mtimeMs };
          }
          if (best) {
            raw = await tryPath(path.join(projectsRoot, best.name, "progress.md"));
            if (raw != null) matchedProject = best.name;
          }
        }

        if (raw == null) {
          return { success: true, exists: false, progress: null, project_name: null };
        }
        return {
          success: true,
          exists: true,
          progress: parseProgressMd(raw),
          project_name: matchedProject,
        };
      }

      case "set_active_agent": {
        const chatId = (params.chat_name as string) || (params.chat_id as string);
        const agentName = params.agent_name as string;
        await this.chats.setActiveAgent(chatId, agentName);
        return { success: true };
      }

      case "stop_chat": {
        const chatId = params.chat_id as string;
        const stopped = this.aborts.abort(chatId);
        return { success: true, stopped };
      }

      case "chat": {
        const chatId = params.chat_id as string;
        const messageArr = params.message as Array<{ role: string; content: string }>;
        const { text, images } = extractPrompt(messageArr);
        return await this.runChat(chatId, text, images);
      }

      case "proxy_toolset": {
        const methodName = params.method_name as string;
        const toolsetName = params.toolset_name as string | undefined;
        const args = (params.args as Record<string, unknown>) ?? {};
        if (toolsetName === "file_manager" || !toolsetName) {
          return this.files.dispatch(methodName, args);
        }
        if (toolsetName === "notebook") {
          return this.notebooks.dispatch(methodName, args);
        }
        throw new Error(`unknown toolset: ${toolsetName}`);
      }

      case "memory_search": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const hits = await this.deps.memory.search(params as Parameters<MemoryRpcClient["search"]>[0]);
        return { success: true, hits };
      }

      case "memory_get": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const memory = await this.deps.memory.get(params.memory_id as string);
        return { success: true, memory };
      }

      case "memory_timeline": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const entries = await this.deps.memory.timeline(params as Parameters<MemoryRpcClient["timeline"]>[0]);
        return { success: true, entries };
      }

      case "memory_list": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const res = await this.deps.memory.list(params as Parameters<MemoryRpcClient["list"]>[0]);
        return { success: true, ...(res as object) };
      }

      case "memory_write": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const res = await this.deps.memory.write(params as Parameters<MemoryRpcClient["write"]>[0]);
        return { success: true, ...(res as object) };
      }

      case "memory_update": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const { memory_id, ...body } = params as { memory_id: string; name: string; description: string; body: string };
        const res = await this.deps.memory.update(memory_id, body);
        return { success: true, ...(res as object) };
      }

      case "memory_forget": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const res = await this.deps.memory.forget(params.memory_id as string);
        return { success: true, ...(res as object) };
      }

      case "memory_restore": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const res = await this.deps.memory.restore(params.memory_id as string);
        return { success: true, ...(res as object) };
      }

      case "memory_audit": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const res = await this.deps.memory.audit(
          params.memory_id as string,
          params.limit as number | undefined,
        );
        return { success: true, ...(res as object) };
      }

      case "share_submit": {
        if (!this.deps.share) throw new Error("share api not configured");
        const res = await this.deps.share.submit(
          params as Parameters<ShareRpcClient["submit"]>[0],
        );
        return { success: true, ...(res as object) };
      }

      case "share_list": {
        if (!this.deps.share) throw new Error("share api not configured");
        const res = await this.deps.share.list(
          params as Parameters<ShareRpcClient["list"]>[0],
        );
        return { success: true, ...(res as object) };
      }

      case "share_get": {
        if (!this.deps.share) throw new Error("share api not configured");
        const res = await this.deps.share.get(params.share_id as string);
        return { success: true, share: res };
      }

      case "share_decide": {
        if (!this.deps.share) throw new Error("share api not configured");
        const { share_id, ...body } = params as { share_id: string; decision: "approve" | "reject"; comment?: string };
        const res = await this.deps.share.decide(share_id, body);
        return { success: true, ...(res as object) };
      }

      case "share_withdraw": {
        if (!this.deps.share) throw new Error("share api not configured");
        const res = await this.deps.share.withdraw(params.share_id as string);
        return { success: true, ...(res as object) };
      }

      case "share_capabilities": {
        if (!this.deps.share) throw new Error("share api not configured");
        const res = await this.deps.share.capabilities();
        return { success: true, ...(res as object) };
      }

      case "skills_list": {
        const skills = await listUserSkills(this.deps.home);
        return { success: true, skills };
      }

      case "org_skills_list": {
        const skills = await listOrgSkills(this.deps.workspaceRoot);
        return { success: true, skills };
      }

      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private async runChat(chatId: string, prompt: string, images: ImageRef[] = []): Promise<unknown> {
    const chat = await this.chats.read(chatId);
    if (!chat) throw new Error(`chat not found: ${chatId}`);

    const mutex = this.mutexes.get(chatId);
    const run = mutex.tryRun(async () => {
      const ac = this.aborts.register(chatId);
      try {
        await runTurn({
          chatId,
          prompt,
          images,
          cwd: this.deps.defaultProjectCwd,
          // Resume only if we've already captured a real SDK session UUID.
          resumeSessionId: chat.session_id ?? undefined,
          signal: ac.signal,
          onEvent: (ev) => this.deps.publishStream(`chat_${chatId}`, ev),
          onSessionId: (sessionId) => {
            // Fire-and-forget — stash the real session UUID so next resume works.
            this.chats.setSessionUuid(chatId, sessionId).catch((e) => {
              console.warn(`[rpc] failed to stash session_uuid for ${chatId}:`, e);
            });
          },
        });
        await this.chats.touch(chatId);
      } finally {
        this.aborts.clear(chatId);
      }
      return { success: true };
    });

    if (run === null) {
      throw new Error(`chat ${chatId} is already streaming a turn`);
    }
    return await run;
  }
}

export interface ImageRef {
  path: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

// Allow-listed parent for any image path the frontend can attach. The frontend
// can only POST uploads into this directory via the upload-http server, so any
// path outside it is either a programming error or someone trying to read
// CLAUDE.md / .env via a crafted [image:] line.
const ATTACHMENT_PREFIX = "/workspace/local_projects/.chat-attachments/";

const MEDIA_TYPE_BY_EXT: Record<string, ImageRef["mediaType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// ─── progress.md parsing ───────────────────────────────────────────────
// The tick harness keeps all per-project state in a single markdown file. The
// frontend wants a parsed view for its self-driving checklist, but we don't
// want a full markdown library here — the structure is rigid enough that line
// scanning is sufficient. Tolerant on input: if a section is missing or the
// format drifts, we degrade to "no steps" rather than throwing.

export interface ProgressStep {
  /** First word after the box (and the optional `(reviewed)` marker). */
  name: string;
  /** Rest of the line up to ` | ` (which separates description from metrics). */
  description: string;
  done: boolean;
  reviewed: boolean;
}

export interface ParsedProgress {
  pipeline: string | null;
  steps: ProgressStep[];
  complete: boolean;
  /** Count of unchecked `☐` lines under `## Review feedback`. */
  pendingFeedback: number;
  /** Index of the next ☐ step (or null when nothing is pending). The
   *  orchestrator dispatches this one next, so the UI can highlight it. */
  nextStepIndex: number | null;
}

const STEP_LINE_RE = /^-\s*([☑☐])\s*(?:\(reviewed\)\s*)?(\S+)(?:\s+(.*))?$/u;

export function parseProgressMd(raw: string): ParsedProgress {
  // Walk the file once, tracking which top-level section we're in. Plan and
  // Review feedback are the only sections with parseable structure.
  let section: string | null = null;
  let pipeline: string | null = null;
  const steps: ProgressStep[] = [];
  let pendingFeedback = 0;
  let complete = false;

  for (const line of raw.split(/\r?\n/)) {
    const headerMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (headerMatch) {
      const heading = (headerMatch[1] ?? "").toLowerCase();
      if (heading.startsWith("status:")) {
        if (/complete/i.test(line)) complete = true;
        section = null;
        continue;
      }
      // First word: plan / sample(s) / pipeline / review / ...
      section = heading.split(/\s+/)[0] ?? null;
      continue;
    }

    if (section === "pipeline" && line.trim() && !pipeline) {
      pipeline = line.trim();
      continue;
    }

    if (section === "plan") {
      const m = STEP_LINE_RE.exec(line);
      if (!m) continue;
      const box = m[1] ?? "";
      const name = m[2] ?? "";
      const restRaw = (m[3] ?? "").trim();
      // Strip metrics suffix (` | metric=value ...`) from the human-readable
      // description so the checklist stays one line.
      const description = (restRaw.split(/\s*\|\s*/, 1)[0] ?? "").trim();
      steps.push({
        name,
        description,
        done: box === "☑",
        reviewed: /\(reviewed\)/.test(line),
      });
    }

    if (section === "review" && /^-\s*☐/.test(line)) {
      pendingFeedback++;
    }
  }

  const nextStepIndex = steps.findIndex(s => !s.done);
  return {
    pipeline,
    steps,
    complete,
    pendingFeedback,
    nextStepIndex: nextStepIndex === -1 ? null : nextStepIndex,
  };
}

const IMAGE_LINE_RE = /^\[image:\s*([^\]]+)\]\s*$/;

/**
 * Pull the most recent user message and split out any `[image: <path>]`
 * lines into structured ImageRefs. Lines for non-allow-listed paths are
 * dropped (logged); the rest of the text passes through verbatim.
 */
function extractPrompt(messages: Array<{ role: string; content: string }>): {
  text: string;
  images: ImageRef[];
} {
  let raw = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") { raw = m.content; break; }
  }
  if (!raw) return { text: "", images: [] };

  const images: ImageRef[] = [];
  const remaining: string[] = [];
  for (const line of raw.split("\n")) {
    const m = IMAGE_LINE_RE.exec(line);
    if (!m || !m[1]) { remaining.push(line); continue; }
    const path = m[1].trim();
    if (!path.startsWith(ATTACHMENT_PREFIX)) {
      console.warn(`[chat] dropping image line outside allowed prefix: ${path}`);
      continue;
    }
    const ext = (path.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();
    const mediaType = MEDIA_TYPE_BY_EXT[ext];
    if (!mediaType) {
      console.warn(`[chat] dropping image with unsupported extension: ${path}`);
      continue;
    }
    images.push({ path, mediaType });
  }
  return { text: remaining.join("\n").trim(), images };
}
