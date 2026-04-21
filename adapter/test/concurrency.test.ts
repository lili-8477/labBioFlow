import { describe, expect, it } from "vitest";
import { AbortRegistry, AsyncMutex, ChatMutexRegistry } from "../src/concurrency.js";

describe("AsyncMutex", () => {
  it("serialises: second tryRun returns null while first is in-flight", async () => {
    const m = new AsyncMutex();
    let firstResolve!: () => void;
    const first = m.tryRun(() => new Promise<string>((r) => (firstResolve = () => r("done"))));
    expect(first).not.toBeNull();
    const second = m.tryRun(async () => "other");
    expect(second).toBeNull();
    firstResolve();
    expect(await first).toBe("done");
    const third = m.tryRun(async () => "third");
    expect(third).not.toBeNull();
    expect(await third).toBe("third");
  });
});

describe("ChatMutexRegistry", () => {
  it("returns the same mutex instance per chat_id", () => {
    const r = new ChatMutexRegistry();
    expect(r.get("a")).toBe(r.get("a"));
    expect(r.get("a")).not.toBe(r.get("b"));
  });
});

describe("AbortRegistry", () => {
  it("abort() triggers the signal and returns true; false if unregistered", () => {
    const r = new AbortRegistry();
    const ac = r.register("c1");
    let aborted = false;
    ac.signal.addEventListener("abort", () => (aborted = true));
    expect(r.abort("c1")).toBe(true);
    expect(aborted).toBe(true);
    expect(r.abort("c1")).toBe(false);
  });
});
