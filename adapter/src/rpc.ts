// RPC dispatch: maps frontend method names to handlers. The frontend contract
// is pinned — see pantheon-frontend/src/stores/chat.ts for the list of calls.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { runTurn } from "./claude.js";
import { AbortRegistry, ChatMutexRegistry } from "./concurrency.js";
import { FileManager } from "./fs-rpc.js";
import { readSessionMessages } from "./history.js";
import { KernelBridge, type IOPubEvent } from "./kernel.js";
import { NotebookManager } from "./notebook-rpc.js";
import { SessionStore } from "./sessions.js";
import type { StreamEvent } from "./types.js";

export interface RpcDeps {
  serviceId: string;
  workspaceRoot: string;
  home: string;
  defaultProjectCwd: string; // where `chat` runs by default (a project dir)
  publishStream: (streamId: string, ev: StreamEvent) => void;
  /** Raw NATS publish for non-chat streams (notebook IOPub, etc.). */
  publishRaw: (subject: string, envelope: Record<string, unknown>) => void;
  /** Subject for streams (frontend `pantheon.stream.<id>`). */
  streamSubject: (streamId: string) => string;
  /** Path to the Python kernel bridge script. */
  kernelBridgePath: string;
}

export class RpcRouter {
  private sessions: SessionStore;
  private files: FileManager;
  private notebooks: NotebookManager;
  private kernel: KernelBridge;
  private mutexes = new ChatMutexRegistry();
  private aborts = new AbortRegistry();

  constructor(private deps: RpcDeps) {
    this.sessions = new SessionStore(deps.workspaceRoot);
    this.files = new FileManager(deps.workspaceRoot);
    // Kernel session_id = first 16 hex of service_id — stable per adapter.
    const kernelSessionId = `k_${deps.serviceId.slice(0, 16)}`;
    this.kernel = new KernelBridge({
      bridgePath: deps.kernelBridgePath,
      sessionId: kernelSessionId,
      onIopub: (sessionId, ev) => this.publishIopub(sessionId, ev),
    });
    this.notebooks = new NotebookManager(deps.workspaceRoot, this.kernel);
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
    this.kernel.shutdown();
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
        const chats = await this.sessions.list();
        chats.sort((a, b) => (b.last_activity_date ?? "").localeCompare(a.last_activity_date ?? ""));
        return { success: true, chats };
      }

      case "create_chat": {
        const name = params.chat_name as string | undefined;
        const s = await this.sessions.create(name);
        return { success: true, chat_id: s.id };
      }

      case "delete_chat": {
        const chatId = params.chat_id as string;
        await this.sessions.delete(chatId);
        this.mutexes.delete(chatId);
        return { success: true };
      }

      case "update_chat_name": {
        const chatId = params.chat_id as string;
        const name = params.chat_name as string;
        await this.sessions.update(chatId, { name });
        return { success: true };
      }

      case "get_chat_messages": {
        const chatId = params.chat_id as string;
        const sidecar = await this.sessions.read(chatId);
        // Use the real SDK session UUID if we have one, else fall back to chat_id.
        const sessionUuid = sidecar?.session_uuid ?? chatId;
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
        const agentsDir = path.join(this.deps.home, ".claude", "agents");
        const names = await fs.readdir(agentsDir).catch(() => [] as string[]);
        const agents = names
          .filter((n) => n.endsWith(".md"))
          .map((n) => ({
            name: n.replace(/\.md$/, ""),
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

      case "set_active_agent": {
        const chatId = (params.chat_name as string) || (params.chat_id as string);
        const agentName = params.agent_name as string;
        await this.sessions.update(chatId, { active_agent: agentName });
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
        const prompt = extractPrompt(messageArr);
        return await this.runChat(chatId, prompt);
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

  private async runChat(chatId: string, prompt: string): Promise<unknown> {
    const sidecar = await this.sessions.read(chatId);
    if (!sidecar) throw new Error(`chat not found: ${chatId}`);

    const mutex = this.mutexes.get(chatId);
    const run = mutex.tryRun(async () => {
      const ac = this.aborts.register(chatId);
      try {
        await runTurn({
          chatId,
          prompt,
          cwd: this.deps.defaultProjectCwd,
          // Resume only if we've already captured a real SDK session UUID.
          resumeSessionId: sidecar.session_uuid,
          signal: ac.signal,
          onEvent: (ev) => this.deps.publishStream(`chat_${chatId}`, ev),
          onSessionId: (sessionId) => {
            // Fire-and-forget — stash the real session UUID so next resume works.
            this.sessions.update(chatId, { session_uuid: sessionId }).catch((e) => {
              console.warn(`[rpc] failed to stash session_uuid for ${chatId}:`, e);
            });
          },
        });
        await this.sessions.touch(chatId);
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

function extractPrompt(messages: Array<{ role: string; content: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") return m.content;
  }
  return "";
}
