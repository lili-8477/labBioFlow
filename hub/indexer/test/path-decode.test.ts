import { describe, it, expect } from "vitest";
import { resolveJsonlPath } from "../src/path-decode.js";

const ROOT = "/workspaces";

describe("resolveJsonlPath", () => {
  it("extracts username, encoded dir, sessionId", () => {
    const r = resolveJsonlPath(
      ROOT,
      "/workspaces/alice/.pantheon/claude-projects/-workspace-pbmc3k/abc-def.jsonl",
    );
    expect(r).not.toBeNull();
    expect(r!.username).toBe("alice");
    expect(r!.encodedProjectDir).toBe("-workspace-pbmc3k");
    expect(r!.sessionId).toBe("abc-def");
    expect(r!.displayProjectPath).toBe("/workspace/pbmc3k");
  });

  it("handles usernames with hyphens", () => {
    const r = resolveJsonlPath(
      ROOT,
      "/workspaces/ada-lovelace/.pantheon/claude-projects/-w/s.jsonl",
    );
    expect(r!.username).toBe("ada-lovelace");
  });

  it("rejects paths outside watch root", () => {
    expect(
      resolveJsonlPath(ROOT, "/tmp/alice/.pantheon/claude-projects/-w/s.jsonl"),
    ).toBeNull();
  });

  it("rejects path traversal via ..", () => {
    expect(
      resolveJsonlPath(ROOT, "/workspaces/../etc/.pantheon/claude-projects/-w/s.jsonl"),
    ).toBeNull();
  });

  it("rejects shape that doesn't match the expected layout", () => {
    expect(
      resolveJsonlPath(ROOT, "/workspaces/alice/other-dir/foo/s.jsonl"),
    ).toBeNull();
    expect(
      resolveJsonlPath(ROOT, "/workspaces/alice/.pantheon/wrong/-w/s.jsonl"),
    ).toBeNull();
  });

  it("derives sessionId from filename stem, not from internals", () => {
    const r = resolveJsonlPath(
      ROOT,
      "/workspaces/u/.pantheon/claude-projects/-p/f8e3b6c4-1234-5678-9abc-def012345678.jsonl",
    );
    expect(r!.sessionId).toBe("f8e3b6c4-1234-5678-9abc-def012345678");
  });
});
