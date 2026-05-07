// Tests for the nine memory_* RPC dispatch branches in RpcRouter.
// Uses vi.fn() stubs for MemoryRpcClient — no real HTTP or PG needed.

import { describe, it, expect, vi } from "vitest";
import { RpcRouter } from "../src/rpc.js";
import type { RpcDeps } from "../src/rpc.js";
import type { MemoryRpcClient } from "../src/memory-rpc.js";

// Minimal deps that satisfy RpcDeps without touching PG, NATS, or the kernel.
// We cast ChatsRepo as unknown because the router never calls chats methods in
// these tests — only the memory branches execute.
function makeRouter(memory: MemoryRpcClient | null): RpcRouter {
  const deps: RpcDeps = {
    serviceId: "test-service-id",
    workspaceRoot: "/tmp/ws",
    chats: {} as RpcDeps["chats"],
    home: "/tmp/home",
    defaultProjectCwd: "/tmp/ws",
    publishStream: () => undefined,
    publishRaw: () => undefined,
    streamSubject: (id) => `pantheon.stream.${id}`,
    kernelBridgePath: "/dev/null",
    kernelIdleCullMs: 0,
    kernelCullCheckIntervalMs: 60_000,
    memory,
  };
  return new RpcRouter(deps);
}

// Build a stub MemoryRpcClient whose methods all return canned values.
function makeMemoryClient(overrides: Partial<{
  search: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  timeline: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
}> = {}): MemoryRpcClient {
  return {
    search: overrides.search ?? vi.fn().mockResolvedValue([]),
    get: overrides.get ?? vi.fn().mockResolvedValue({}),
    timeline: overrides.timeline ?? vi.fn().mockResolvedValue([]),
    list: overrides.list ?? vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    write: overrides.write ?? vi.fn().mockResolvedValue({ memory_id: "mem-new" }),
    update: overrides.update ?? vi.fn().mockResolvedValue({ ok: true }),
    forget: overrides.forget ?? vi.fn().mockResolvedValue({ ok: true }),
    restore: overrides.restore ?? vi.fn().mockResolvedValue({ ok: true }),
    audit: overrides.audit ?? vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as MemoryRpcClient;
}

describe("RpcRouter memory_* dispatch", () => {
  describe("memory_search", () => {
    it("calls client.search and wraps as {success, hits}", async () => {
      const hits = [{ id: "m1", name: "hit" }];
      const searchFn = vi.fn().mockResolvedValue(hits);
      const client = makeMemoryClient({ search: searchFn });
      const router = makeRouter(client);

      const res = await router.dispatch("memory_search", { query: "RNA" }) as Record<string, unknown>;

      expect(searchFn).toHaveBeenCalledOnce();
      expect(searchFn).toHaveBeenCalledWith({ query: "RNA" });
      expect(res.success).toBe(true);
      expect(res.hits).toEqual(hits);
    });

    it("passes all optional params through", async () => {
      const searchFn = vi.fn().mockResolvedValue([]);
      const client = makeMemoryClient({ search: searchFn });
      const router = makeRouter(client);

      await router.dispatch("memory_search", {
        query: "test",
        project_dir: "/w/proj",
        limit: 20,
        types: ["user"],
        since: "2026-01-01T00:00:00Z",
      });

      expect(searchFn).toHaveBeenCalledWith({
        query: "test",
        project_dir: "/w/proj",
        limit: 20,
        types: ["user"],
        since: "2026-01-01T00:00:00Z",
      });
    });
  });

  describe("memory_get", () => {
    it("calls client.get(memory_id) and wraps as {success, memory}", async () => {
      const detail = { id: "mem-42", name: "My note", body: "content" };
      const getFn = vi.fn().mockResolvedValue(detail);
      const client = makeMemoryClient({ get: getFn });
      const router = makeRouter(client);

      const res = await router.dispatch("memory_get", { memory_id: "mem-42" }) as Record<string, unknown>;

      expect(getFn).toHaveBeenCalledOnce();
      expect(getFn).toHaveBeenCalledWith("mem-42");
      expect(res.success).toBe(true);
      expect(res.memory).toEqual(detail);
    });
  });

  describe("memory_timeline", () => {
    it("calls client.timeline and wraps as {success, entries}", async () => {
      const entries = [{ id: "e1", action: "write" }];
      const timelineFn = vi.fn().mockResolvedValue(entries);
      const client = makeMemoryClient({ timeline: timelineFn });
      const router = makeRouter(client);

      const res = await router.dispatch("memory_timeline", {
        project_dir: "/w/p",
        since: "2026-01-01T00:00:00Z",
        limit: 10,
      }) as Record<string, unknown>;

      expect(timelineFn).toHaveBeenCalledOnce();
      expect(res.success).toBe(true);
      expect(res.entries).toEqual(entries);
    });
  });

  describe("memory_list", () => {
    it("calls client.list and spreads {items, next_cursor} alongside success", async () => {
      const items = [{ id: "m1" }, { id: "m2" }];
      const listFn = vi.fn().mockResolvedValue({ items, next_cursor: "tok" });
      const client = makeMemoryClient({ list: listFn });
      const router = makeRouter(client);

      const res = await router.dispatch("memory_list", { scope: "user", limit: 50 }) as Record<string, unknown>;

      expect(listFn).toHaveBeenCalledOnce();
      expect(res.success).toBe(true);
      expect(res.items).toEqual(items);
      expect(res.next_cursor).toBe("tok");
    });
  });

  describe("memory_write", () => {
    it("calls client.write and spreads {memory_id} alongside success", async () => {
      const writeFn = vi.fn().mockResolvedValue({ memory_id: "mem-new-99" });
      const client = makeMemoryClient({ write: writeFn });
      const router = makeRouter(client);

      const res = await router.dispatch("memory_write", {
        scope: "user",
        type: "user",
        name: "note",
        description: "desc",
        body: "body text",
      }) as Record<string, unknown>;

      expect(writeFn).toHaveBeenCalledOnce();
      expect(res.success).toBe(true);
      expect(res.memory_id).toBe("mem-new-99");
    });
  });

  describe("memory_update", () => {
    it("calls client.update(memory_id, {name, description, body}) and returns {success, ok}", async () => {
      const updateFn = vi.fn().mockResolvedValue({ ok: true });
      const client = makeMemoryClient({ update: updateFn });
      const router = makeRouter(client);

      const res = await router.dispatch("memory_update", {
        memory_id: "mem-7",
        name: "new name",
        description: "new desc",
        body: "new body",
      }) as Record<string, unknown>;

      expect(updateFn).toHaveBeenCalledOnce();
      expect(updateFn).toHaveBeenCalledWith("mem-7", {
        name: "new name",
        description: "new desc",
        body: "new body",
      });
      expect(res.success).toBe(true);
      expect(res.ok).toBe(true);
    });
  });

  describe("memory_forget", () => {
    it("calls client.forget(memory_id) and returns {success, ok}", async () => {
      const forgetFn = vi.fn().mockResolvedValue({ ok: true });
      const client = makeMemoryClient({ forget: forgetFn });
      const router = makeRouter(client);

      const res = await router.dispatch("memory_forget", { memory_id: "mem-del" }) as Record<string, unknown>;

      expect(forgetFn).toHaveBeenCalledOnce();
      expect(forgetFn).toHaveBeenCalledWith("mem-del");
      expect(res.success).toBe(true);
      expect(res.ok).toBe(true);
    });
  });

  describe("memory_restore", () => {
    it("calls client.restore(memory_id) and returns {success, ok}", async () => {
      const restoreFn = vi.fn().mockResolvedValue({ ok: true });
      const client = makeMemoryClient({ restore: restoreFn });
      const router = makeRouter(client);

      const res = await router.dispatch("memory_restore", { memory_id: "mem-del" }) as Record<string, unknown>;

      expect(restoreFn).toHaveBeenCalledOnce();
      expect(restoreFn).toHaveBeenCalledWith("mem-del");
      expect(res.success).toBe(true);
      expect(res.ok).toBe(true);
    });
  });

  describe("memory_audit", () => {
    it("calls client.audit(memory_id, limit) and returns {success, rows}", async () => {
      const rows = [{ action: "write", actor: "alice" }];
      const auditFn = vi.fn().mockResolvedValue({ rows });
      const client = makeMemoryClient({ audit: auditFn });
      const router = makeRouter(client);

      const res = await router.dispatch("memory_audit", { memory_id: "mem-5", limit: 25 }) as Record<string, unknown>;

      expect(auditFn).toHaveBeenCalledOnce();
      expect(auditFn).toHaveBeenCalledWith("mem-5", 25);
      expect(res.success).toBe(true);
      expect(res.rows).toEqual(rows);
    });

    it("calls client.audit without limit when not provided", async () => {
      const auditFn = vi.fn().mockResolvedValue({ rows: [] });
      const client = makeMemoryClient({ audit: auditFn });
      const router = makeRouter(client);

      await router.dispatch("memory_audit", { memory_id: "mem-5" });

      expect(auditFn).toHaveBeenCalledWith("mem-5", undefined);
    });
  });

  describe("null memory client", () => {
    it("throws 'memory api not configured' for every branch when memory is null", async () => {
      const router = makeRouter(null);

      const methods = [
        ["memory_search", { query: "x" }],
        ["memory_get", { memory_id: "m1" }],
        ["memory_timeline", {}],
        ["memory_list", {}],
        ["memory_write", { scope: "user", type: "user", name: "n", description: "d", body: "b" }],
        ["memory_update", { memory_id: "m1", name: "n", description: "d", body: "b" }],
        ["memory_forget", { memory_id: "m1" }],
        ["memory_restore", { memory_id: "m1" }],
        ["memory_audit", { memory_id: "m1" }],
      ] as const;

      for (const [method, params] of methods) {
        await expect(
          router.dispatch(method, params as Record<string, unknown>),
        ).rejects.toThrow("memory api not configured");
      }
    });
  });
});
