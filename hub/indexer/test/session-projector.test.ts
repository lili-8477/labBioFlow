import { describe, it, expect } from "vitest";
import { projectEntries } from "../src/session-projector.js";
import type { ParsedEntry } from "../src/jsonl-parser.js";

const BASE: ParsedEntry = {
  type: "user",
  uuid: "00000000-0000-0000-0000-000000000001",
  sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  timestamp: "2026-04-22T10:00:00.000Z",
  isSidechain: false,
  model: null,
  usage: null,
  title: null,
};

const META = {
  fileSessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  username: "alice",
  encodedProjectDir: "-w",
  displayProjectPath: "/w",
};

describe("projectEntries", () => {
  it("returns empty on empty input", () => {
    const r = projectEntries([], META);
    expect(r.sessionUpserts).toEqual([]);
    expect(r.tokenRows).toEqual([]);
  });

  it("builds one SessionUpsert and no token rows from user-only entries", () => {
    const entries: ParsedEntry[] = [
      { ...BASE, uuid: "u1", timestamp: "2026-04-22T10:00:00.000Z" },
      { ...BASE, uuid: "u2", timestamp: "2026-04-22T10:00:05.000Z" },
    ];
    const r = projectEntries(entries, META);
    expect(r.sessionUpserts).toHaveLength(1);
    const up = r.sessionUpserts[0]!;
    expect(up.session_id).toBe(META.fileSessionId);
    expect(up.username).toBe("alice");
    expect(up.encoded_project_dir).toBe("-w");
    expect(up.project_display).toBe("/w");
    expect(up.message_count_delta).toBe(2);
    expect(up.first_active_candidate).toBe("2026-04-22T10:00:00.000Z");
    expect(up.last_active).toBe("2026-04-22T10:00:05.000Z");
    expect(up.is_sidechain).toBe(false);
    expect(up.token_usage_delta).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
    expect(r.tokenRows).toHaveLength(0);
  });

  it("emits one token row per assistant entry and sums deltas", () => {
    const entries: ParsedEntry[] = [
      { ...BASE, type: "assistant", uuid: "a1", model: "m", usage: { input: 10, output: 2, cache_read: 0, cache_write: 0 } },
      { ...BASE, type: "assistant", uuid: "a2", model: "m", usage: { input: 20, output: 4, cache_read: 5, cache_write: 3 } },
    ];
    const r = projectEntries(entries, META);
    expect(r.tokenRows).toHaveLength(2);
    expect(r.tokenRows[0]!.entry_uuid).toBe("a1");
    expect(r.tokenRows[1]!.input_tokens).toBe(20);
    const up = r.sessionUpserts[0]!;
    expect(up.token_usage_delta).toEqual({ input: 30, output: 6, cache_read: 5, cache_write: 3 });
    expect(up.model).toBe("m");
  });

  it("is_sidechain is OR across pass", () => {
    const entries: ParsedEntry[] = [
      { ...BASE, uuid: "u1", isSidechain: false },
      { ...BASE, uuid: "u2", isSidechain: true },
    ];
    const r = projectEntries(entries, META);
    expect(r.sessionUpserts[0]!.is_sidechain).toBe(true);
  });

  it("idempotency: calling twice on same input yields same outputs", () => {
    const entries: ParsedEntry[] = [
      { ...BASE, type: "assistant", uuid: "a1", model: "m", usage: { input: 10, output: 2, cache_read: 0, cache_write: 0 } },
    ];
    const r1 = projectEntries(entries, META);
    const r2 = projectEntries(entries, META);
    expect(r1).toEqual(r2);
  });

  it("splits entries by sessionId if they differ from file sessionId", () => {
    const entries: ParsedEntry[] = [
      { ...BASE, uuid: "u1", sessionId: "session-x", timestamp: "2026-04-22T10:00:00.000Z" },
      { ...BASE, uuid: "u2", sessionId: "session-y", timestamp: "2026-04-22T10:00:01.000Z" },
    ];
    const r = projectEntries(entries, META);
    expect(r.sessionUpserts).toHaveLength(2);
    expect(r.sessionUpserts.map((u) => u.session_id).sort()).toEqual(["session-x", "session-y"]);
  });

  it("propagates title from an ai-title entry into SessionUpsert.title_candidate without inflating message_count", () => {
    const entries: ParsedEntry[] = [
      { ...BASE, uuid: "aa000000-0000-0000-0000-000000000001" },
      {
        ...BASE,
        type: "title",
        uuid: "00000000-0000-0000-0000-000000000000",
        timestamp: "1970-01-01T00:00:00.000Z",
        title: "Figuring out scRNA-seq QC",
      },
    ];
    const r = projectEntries(entries, META);
    expect(r.sessionUpserts).toHaveLength(1);
    const up = r.sessionUpserts[0]!;
    expect(up.title_candidate).toBe("Figuring out scRNA-seq QC");
    expect(up.message_count_delta).toBe(1); // only the user entry counts
    expect(up.first_active_candidate).toBe("2026-04-22T10:00:00.000Z"); // not 1970
  });

  it("returns empty title_candidate when no ai-title is present", () => {
    const entries: ParsedEntry[] = [{ ...BASE, uuid: "bb000000-0000-0000-0000-000000000001" }];
    const r = projectEntries(entries, META);
    expect(r.sessionUpserts[0]!.title_candidate).toBeNull();
  });
});
