import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionMessages } from "../src/history.js";

// Build a JSONL that mirrors what Claude Code writes, including the quirk
// where one API turn is split across two entries (thinking + text).
function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe("readSessionMessages", () => {
  let home: string;
  const cwd = "/workspace";
  const chatId = "11111111-2222-3333-4444-555555555555";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "bioflow-hist-"));
    const encoded = cwd.replace(/\//g, "-");
    await fs.mkdir(path.join(home, ".claude", "projects", encoded), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  async function writeSession(lines: object[]): Promise<void> {
    const encoded = cwd.replace(/\//g, "-");
    await fs.writeFile(
      path.join(home, ".claude", "projects", encoded, `${chatId}.jsonl`),
      jsonl(lines),
      "utf8",
    );
  }

  it("skips assistant entries that are pure thinking (no text, no tool_use)", async () => {
    await writeSession([
      { type: "user", message: { role: "user", content: [{ type: "text", text: "Hi" }] } },
      // Thinking-only assistant entry — must NOT appear as an empty message.
      {
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "thinking", thinking: "hmm" }],
        },
      },
      // Text entry for the same turn — this is the real reply.
      {
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "text", text: "Hi there!" }],
        },
      },
    ]);
    const msgs = await readSessionMessages(home, cwd, chatId);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: "user", content: "Hi" });
    expect(msgs[1]).toMatchObject({ role: "assistant", content: "Hi there!" });
  });

  it("returns empty list when no session file exists", async () => {
    const msgs = await readSessionMessages(home, cwd, "nonexistent-uuid");
    expect(msgs).toEqual([]);
  });

  it("ignores queue-operation and attachment entries", async () => {
    await writeSession([
      { type: "queue-operation", operation: "enqueue" },
      { type: "attachment", attachment: { type: "deferred_tools_delta" } },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "yo" }] } },
    ]);
    const msgs = await readSessionMessages(home, cwd, chatId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("user");
  });

  it("projects tool_use to tool_calls with arguments as JSON string", async () => {
    await writeSession([
      {
        type: "assistant",
        message: {
          id: "msg_2",
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_x", name: "Bash", input: { command: "ls" } }],
        },
      },
    ]);
    const msgs = await readSessionMessages(home, cwd, chatId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.tool_calls).toHaveLength(1);
    const tc = msgs[0]!.tool_calls![0]!;
    expect(tc.function.name).toBe("Bash");
    expect(typeof tc.function.arguments).toBe("string");
    expect(JSON.parse(tc.function.arguments)).toEqual({ command: "ls" });
  });

  it("skips the 'Base directory for this skill' user-text block injected after a Skill tool call", async () => {
    await writeSession([
      { type: "user", message: { role: "user", content: [{ type: "text", text: "explain QC" }] } },
      {
        type: "assistant",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_skill_1", name: "Skill", input: { skill: "sc-preprocessing" } }],
        },
      },
      // Empty tool_result ack from the Skill invocation.
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_skill_1", content: "" }],
        },
      },
      // The Skill payload comes as a plain user-text block — this must NOT
      // surface as a user message.
      {
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "text",
            text: "Base directory for this skill: /home/node/.claude/skills/sc-preprocessing\n\n# SC Best Practices: Preprocessing\n\n...",
          }],
        },
      },
      {
        type: "assistant",
        message: {
          id: "m2",
          role: "assistant",
          content: [{ type: "text", text: "For a 10x PBMC dataset, use MAD-based thresholds ..." }],
        },
      },
    ]);
    const msgs = await readSessionMessages(home, cwd, chatId);
    // Expected: user "explain QC", assistant tool_use, tool_result, assistant answer.
    // NO user message carrying the skill body.
    expect(msgs.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["explain QC"]);
    expect(msgs.some((m) => (m.content || "").startsWith("Base directory"))).toBe(false);
    expect(msgs.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(msgs[msgs.length - 1]?.content).toMatch(/MAD-based thresholds/);
  });

  it("tolerates a truncated last JSONL line", async () => {
    const encoded = cwd.replace(/\//g, "-");
    await fs.writeFile(
      path.join(home, ".claude", "projects", encoded, `${chatId}.jsonl`),
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }) +
        "\n{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\"",
      "utf8",
    );
    const msgs = await readSessionMessages(home, cwd, chatId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: "user", content: "hello" });
  });
});
