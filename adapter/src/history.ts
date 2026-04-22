// Read a Claude Code session JSONL and project it onto the frontend's
// ChatMessage shape (get_chat_messages RPC).
//
// JSONL format is not a stable public API — all JSONL I/O lives in this module
// so it can be swapped when the SDK exposes a first-class history accessor.

import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface LegacyMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string }; type: "function" }>;
  tool_call_id?: string;
  tool_name?: string;
  transfer?: boolean;
  timestamp?: number;
  _metadata?: Record<string, unknown>;
}

function sessionPathCandidates(home: string, cwd: string, chatId: string): string[] {
  // Claude Code encodes cwd into the projects dir as "-absolute-path-with-dashes".
  const encoded = cwd.replace(/\//g, "-");
  return [
    path.join(home, ".claude", "projects", encoded, `${chatId}.jsonl`),
    path.join(home, ".claude", "projects", encoded.replace(/^-/, ""), `${chatId}.jsonl`),
  ];
}

export async function readSessionMessages(
  home: string,
  cwd: string,
  chatId: string,
): Promise<LegacyMessage[]> {
  const candidates = sessionPathCandidates(home, cwd, chatId);
  let content = "";
  for (const p of candidates) {
    try {
      content = await fs.readFile(p, "utf8");
      break;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (!content) return [];

  const out: LegacyMessage[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // skip a truncated last line
    }
    const projected = projectEntry(entry);
    out.push(...projected);
  }
  return out;
}

/** Recognises the skill-payload text Claude Code injects after a Skill tool call.
 *  The anchor is stable across skills: every injection starts with the literal
 *  "Base directory for this skill:" line pointing at ~/.claude/skills/<name>/. */
function isSkillInjection(text: string): boolean {
  return /^Base directory for this skill:\s*\S+\.claude\/skills\//.test(text.trimStart());
}

function projectEntry(entry: Record<string, unknown>): LegacyMessage[] {
  const type = entry.type as string;
  if (type === "user") {
    const msg = (entry.message as { content?: unknown }) ?? {};
    const content = msg.content;
    if (typeof content === "string") {
      return [{ role: "user", content }];
    }
    if (Array.isArray(content)) {
      const out: LegacyMessage[] = [];
      const textParts: string[] = [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "text") {
          const text = String(block.text ?? "");
          // Claude Code injects the full skill body back as a user text block
          // right after a `Skill` tool call (see session JSONL: assistant
          // tool_use → user tool_result ack → user text "Base directory for
          // this skill: ..."). It isn't actually user input; rendering it in
          // the chat transcript makes it look like the user pasted the skill.
          // Drop it — the timeline still shows the Skill tool invocation,
          // which is the signal the user needs.
          if (isSkillInjection(text)) continue;
          textParts.push(text);
        } else if (block.type === "tool_result") {
          const raw = block.content;
          let text: string;
          if (typeof raw === "string") text = raw;
          else if (Array.isArray(raw))
            text = raw
              .map((p: unknown) => {
                const b = p as Record<string, unknown>;
                return b?.type === "text" ? String(b.text ?? "") : JSON.stringify(b);
              })
              .join("\n");
          else text = JSON.stringify(raw ?? "");
          out.push({
            role: "tool",
            content: text,
            tool_call_id: String(block.tool_use_id ?? ""),
          });
        }
      }
      if (textParts.length > 0) out.unshift({ role: "user", content: textParts.join("") });
      return out;
    }
  }
  if (type === "assistant") {
    const msg = (entry.message as { content?: unknown[] }) ?? {};
    const blocks = (msg.content as Array<Record<string, unknown>>) ?? [];
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("");
    const toolCalls = blocks
      .filter((b) => b.type === "tool_use")
      .map((b) => ({
        id: String(b.id),
        type: "function" as const,
        function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
      }));
    // Claude Code can split one API message across multiple JSONL entries
    // (e.g. thinking block first, then text). A thinking-only entry has
    // neither text nor tool_use blocks — skip it so it doesn't render as an
    // empty assistant bubble.
    if (text.length === 0 && toolCalls.length === 0) return [];
    const m: LegacyMessage = { role: "assistant", content: text };
    if (toolCalls.length > 0) m.tool_calls = toolCalls;
    return [m];
  }
  return [];
}
