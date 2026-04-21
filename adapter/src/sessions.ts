// chat_id == Claude Code session UUID. A 1-line sidecar at
// <workspace>/.pantheon/chats/<chat_id>.json carries display metadata
// (title, last activity) so list_chats doesn't have to parse JSONL.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ChatInfo, ChatSidecar } from "./types.js";

export class SessionStore {
  constructor(private workspaceRoot: string) {}

  private get chatsDir(): string {
    return path.join(this.workspaceRoot, ".pantheon", "chats");
  }

  private sidecarPath(chatId: string): string {
    return path.join(this.chatsDir, `${chatId}.json`);
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.chatsDir, { recursive: true });
  }

  async create(name?: string): Promise<ChatSidecar> {
    await this.ensureDir();
    const id = randomUUID();
    const now = new Date().toISOString();
    const sidecar: ChatSidecar = {
      id,
      name: name || "New chat",
      created_at: now,
      last_activity_at: now,
    };
    await fs.writeFile(this.sidecarPath(id), JSON.stringify(sidecar), "utf8");
    return sidecar;
  }

  async read(chatId: string): Promise<ChatSidecar | null> {
    try {
      const raw = await fs.readFile(this.sidecarPath(chatId), "utf8");
      return JSON.parse(raw) as ChatSidecar;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async update(chatId: string, patch: Partial<ChatSidecar>): Promise<ChatSidecar | null> {
    const cur = await this.read(chatId);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    await fs.writeFile(this.sidecarPath(chatId), JSON.stringify(next), "utf8");
    return next;
  }

  async touch(chatId: string): Promise<void> {
    await this.update(chatId, { last_activity_at: new Date().toISOString() });
  }

  async delete(chatId: string): Promise<void> {
    try {
      await fs.unlink(this.sidecarPath(chatId));
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  async list(): Promise<ChatInfo[]> {
    await this.ensureDir();
    const files = await fs.readdir(this.chatsDir).catch(() => []);
    const out: ChatInfo[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(this.chatsDir, f), "utf8");
        const s = JSON.parse(raw) as ChatSidecar;
        out.push({
          id: s.id,
          name: s.name,
          last_activity_date: s.last_activity_at,
          project_name: s.project_name,
        });
      } catch {
        // skip corrupt sidecars
      }
    }
    return out;
  }
}
