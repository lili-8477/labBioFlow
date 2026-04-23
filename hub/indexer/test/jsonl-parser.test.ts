import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseJsonlLine, parseJsonlBuffer } from "../src/jsonl-parser.js";

const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));

describe("parseJsonlLine", () => {
  it("parses a user entry", () => {
    const e = parseJsonlLine('{"type":"user","uuid":"11111111-1111-1111-1111-111111111111","sessionId":"22222222-2222-2222-2222-222222222222","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hi"}}');
    expect(e).not.toBeNull();
    expect(e!.type).toBe("user");
    expect(e!.uuid).toBe("11111111-1111-1111-1111-111111111111");
    expect(e!.sessionId).toBe("22222222-2222-2222-2222-222222222222");
    expect(e!.isSidechain).toBe(false);
  });

  it("parses an assistant entry with usage", () => {
    const e = parseJsonlLine('{"type":"assistant","uuid":"33333333-3333-3333-3333-333333333333","sessionId":"22222222-2222-2222-2222-222222222222","timestamp":"2026-01-01T00:00:01Z","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":7,"cache_creation_input_tokens":3}}}');
    expect(e!.type).toBe("assistant");
    expect(e!.model).toBe("claude-sonnet-4-6");
    expect(e!.usage).toEqual({ input: 10, output: 5, cache_read: 7, cache_write: 3 });
  });

  it("returns null on malformed JSON", () => {
    expect(parseJsonlLine("{not json")).toBeNull();
    expect(parseJsonlLine("")).toBeNull();
  });

  it("skips summary and system entries", () => {
    expect(parseJsonlLine('{"type":"summary","summary":"x","leafUuid":"u"}')).toBeNull();
    expect(parseJsonlLine('{"type":"system","content":"x"}')).toBeNull();
  });

  it("skips unknown types silently", () => {
    expect(parseJsonlLine('{"type":"future","uuid":"u","sessionId":"s","timestamp":"2026-01-01T00:00:00Z"}')).toBeNull();
  });

  it("skips entries missing required fields", () => {
    expect(parseJsonlLine('{"type":"user","sessionId":"s","timestamp":"2026-01-01T00:00:00Z"}')).toBeNull();
    expect(parseJsonlLine('{"type":"user","uuid":"u","timestamp":"2026-01-01T00:00:00Z"}')).toBeNull();
    expect(parseJsonlLine('{"type":"user","uuid":"u","sessionId":"s"}')).toBeNull();
  });

  it("ignores unknown extra fields (forward-compat)", () => {
    const e = parseJsonlLine('{"type":"user","uuid":"44444444-4444-4444-4444-444444444444","sessionId":"55555555-5555-5555-5555-555555555555","timestamp":"2026-01-01T00:00:00Z","future_field":"x","message":{"role":"user","content":"hi"}}');
    expect(e).not.toBeNull();
  });

  it("reads isSidechain", () => {
    const e = parseJsonlLine('{"type":"user","uuid":"66666666-6666-6666-6666-666666666666","sessionId":"77777777-7777-7777-7777-777777777777","timestamp":"2026-01-01T00:00:00Z","isSidechain":true,"message":{}}');
    expect(e!.isSidechain).toBe(true);
  });

  it("skips entries whose uuid or sessionId is not a valid UUID", () => {
    // Non-UUID uuid
    expect(parseJsonlLine('{"type":"user","uuid":"not-a-uuid","sessionId":"11111111-1111-1111-1111-111111111111","timestamp":"2026-01-01T00:00:00Z","message":{}}')).toBeNull();
    // Non-UUID sessionId
    expect(parseJsonlLine('{"type":"user","uuid":"11111111-1111-1111-1111-111111111111","sessionId":"also-bad","timestamp":"2026-01-01T00:00:00Z","message":{}}')).toBeNull();
    // Right shape, wrong chars (non-hex)
    expect(parseJsonlLine('{"type":"user","uuid":"zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz","sessionId":"11111111-1111-1111-1111-111111111111","timestamp":"2026-01-01T00:00:00Z","message":{}}')).toBeNull();
  });

  it("parses an ai-title entry into a synthetic title ParsedEntry", () => {
    const e = parseJsonlLine('{"type":"ai-title","sessionId":"88888888-8888-8888-8888-888888888888","aiTitle":"Figuring out scRNA-seq QC"}');
    expect(e).not.toBeNull();
    expect(e!.type).toBe("title");
    expect(e!.sessionId).toBe("88888888-8888-8888-8888-888888888888");
    expect(e!.title).toBe("Figuring out scRNA-seq QC");
  });

  it("rejects ai-title with missing aiTitle or bad sessionId", () => {
    expect(parseJsonlLine('{"type":"ai-title","sessionId":"88888888-8888-8888-8888-888888888888"}')).toBeNull();
    expect(parseJsonlLine('{"type":"ai-title","sessionId":"not-a-uuid","aiTitle":"x"}')).toBeNull();
    expect(parseJsonlLine('{"type":"ai-title","sessionId":"88888888-8888-8888-8888-888888888888","aiTitle":""}')).toBeNull();
  });
});

describe("parseJsonlBuffer", () => {
  it("parses simple-session.jsonl into 3 entries", async () => {
    const buf = await readFile(FIX + "simple-session.jsonl", "utf8");
    const entries = parseJsonlBuffer(buf);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.type).toBe("user");
    expect(entries[1]!.type).toBe("assistant");
    expect(entries[1]!.usage!.input).toBe(10);
    expect(entries[2]!.usage!.cache_read).toBe(100);
    expect(entries[2]!.usage!.cache_write).toBe(50);
  });

  it("skips malformed lines and recovers", async () => {
    const buf = await readFile(FIX + "malformed-lines.jsonl", "utf8");
    const entries = parseJsonlBuffer(buf);
    // valid line 1 + valid line 3 = 2; line 2 is invalid, line 4 is truncated.
    expect(entries).toHaveLength(2);
    expect(entries[0]!.uuid).toBe("99999999-9999-9999-9999-999999999999");
    expect(entries[1]!.uuid).toBe("aaaaaaaa-0000-0000-0000-000000000001");
  });

  it("marks subagent entries", async () => {
    const buf = await readFile(FIX + "subagent-session.jsonl", "utf8");
    const entries = parseJsonlBuffer(buf);
    expect(entries.every((e) => e.isSidechain)).toBe(true);
  });
});
