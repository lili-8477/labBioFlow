import { describe, it, expect } from "vitest";
import { jsonlPath } from "../src/transcript-reader.js";

describe("transcript-reader.jsonlPath", () => {
  it("includes the .claude segment matching production layout", () => {
    const p = jsonlPath("/workspaces", {
      session_id: "abc",
      username: "alice",
      encoded_project_dir: "-workspace",
      last_active: new Date(),
    });
    expect(p).toBe("/workspaces/alice/.claude/claude-projects/-workspace/abc.jsonl");
  });

  it("matches the path-decode contract (5 segments under workspacesRoot)", () => {
    const p = jsonlPath("/r", {
      session_id: "s",
      username: "u",
      encoded_project_dir: "-w-p",
      last_active: new Date(),
    });
    // r / u / .claude / claude-projects / -w-p / s.jsonl  → 5 segments after /r
    expect(p.replace("/r/", "").split("/")).toEqual(["u", ".claude", "claude-projects", "-w-p", "s.jsonl"]);
  });
});
