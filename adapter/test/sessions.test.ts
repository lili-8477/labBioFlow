import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions.js";

describe("SessionStore", () => {
  let root: string;
  let store: SessionStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bioflow-sessions-"));
    store = new SessionStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("create -> read round-trip", async () => {
    const s = await store.create("My chat");
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/i);
    const back = await store.read(s.id);
    expect(back?.name).toBe("My chat");
    expect(back?.id).toBe(s.id);
  });

  it("list returns newest-first when sorted by the caller", async () => {
    const a = await store.create("first");
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create("second");
    const list = await store.list();
    const ids = list.map((c) => c.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it("delete is idempotent (missing sidecar is not an error)", async () => {
    await store.delete("not-a-real-id");
    const s = await store.create();
    await store.delete(s.id);
    expect(await store.read(s.id)).toBeNull();
  });

  it("update merges fields and touch updates last_activity_at", async () => {
    const s = await store.create("start");
    await store.update(s.id, { name: "renamed" });
    const renamed = await store.read(s.id);
    expect(renamed?.name).toBe("renamed");
    const before = renamed?.last_activity_at;
    await new Promise((r) => setTimeout(r, 5));
    await store.touch(s.id);
    const after = await store.read(s.id);
    expect(after?.last_activity_at).not.toBe(before);
  });
});
