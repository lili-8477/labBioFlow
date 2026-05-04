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
import { NotebookManager } from "./notebook-rpc.js";
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
