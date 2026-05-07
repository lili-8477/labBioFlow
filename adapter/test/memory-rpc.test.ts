import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { MemoryRpcClient } from "../src/memory-rpc.js";

interface ServerState {
  lastReq?: { method: string; url: string; body?: Record<string, unknown> };
  nextResponse?: { status: number; body: unknown };
  responseDelay?: number;
}

let server: Server;
let baseUrl: string;
let state: ServerState = {};

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Capture request info
      const method = req.method || "GET";
      const url = req.url || "/";

      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });

      req.on("end", () => {
        try {
          state.lastReq = {
            method,
            url,
            body: body ? (JSON.parse(body) as Record<string, unknown>) : undefined,
          };

          // Apply response delay if set
          const delayMs = state.responseDelay || 0;
          setTimeout(() => {
            const { status = 200, body: respBody = {} } = state.nextResponse || {};
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(respBody));
          }, delayMs);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal" }));
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      }
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe("MemoryRpcClient", () => {
  describe("search", () => {
    it("POST /memory/search with username + query + optional params", async () => {
      state = { nextResponse: { status: 200, body: { results: [] } } };

      const client = new MemoryRpcClient(baseUrl, "alice");
      const result = await client.search({ query: "test", limit: 10, types: ["observation"] });

      expect(state.lastReq!.method).toBe("POST");
      expect(state.lastReq!.url).toBe("/memory/search");
      expect(state.lastReq!.body).toEqual({
        username: "alice",
        query: "test",
        limit: 10,
        types: ["observation"],
      });
      expect(result).toEqual({ results: [] });
    });

    it("search with project_dir and since", async () => {
      state = { nextResponse: { status: 200, body: {} } };
      const client = new MemoryRpcClient(baseUrl, "alice");
      await client.search({
        query: "test",
        project_dir: "/w/pbmc",
        since: "2026-01-01T00:00:00Z",
      });

      expect(state.lastReq!.body).toEqual({
        username: "alice",
        query: "test",
        project_dir: "/w/pbmc",
        since: "2026-01-01T00:00:00Z",
      });
    });
  });

  describe("get", () => {
    it("GET /memory/:id returns memory", async () => {
      state = { nextResponse: { status: 200, body: { id: "mem-123", name: "test" } } };

      const client = new MemoryRpcClient(baseUrl, "alice");
      const result = await client.get("mem-123");

      expect(state.lastReq!.method).toBe("GET");
      expect(state.lastReq!.url).toBe("/memory/mem-123");
      expect(result).toEqual({ id: "mem-123", name: "test" });
    });

    it("get encodes special characters in id", async () => {
      state = { nextResponse: { status: 200, body: {} } };
      const client = new MemoryRpcClient(baseUrl, "alice");
      await client.get("mem/123");

      expect(state.lastReq!.url).toBe("/memory/mem%2F123");
    });

    it("get throws on 404", async () => {
      state = { nextResponse: { status: 404, body: { error: "memory not found" } } };

      const client = new MemoryRpcClient(baseUrl, "alice");
      await expect(client.get("missing")).rejects.toThrow("memory not found");
    });

    it("get throws with statusText if no error field", async () => {
      state = { nextResponse: { status: 500, body: {} } };

      const client = new MemoryRpcClient(baseUrl, "alice");
      await expect(client.get("x")).rejects.toThrow();
    });

    it("get throws with formatted error if response is not JSON", async () => {
      // Swap handler temporarily
      server.removeAllListeners("request");
      server.on("request", (req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      });

      const client = new MemoryRpcClient(baseUrl, "alice");
      await expect(client.get("x")).rejects.toThrow(
        /memory-api GET \/memory\/x → HTTP 500/,
      );

      // Restore normal handler
      restoreHandler();
    });
  });

  describe("timeline", () => {
    it("GET /memory/timeline with username + optional qs params", async () => {
      state = { nextResponse: { status: 200, body: { events: [] } } };

      const client = new MemoryRpcClient(baseUrl, "alice");
      const result = await client.timeline({
        project_dir: "/w/x",
        since: "2026-01-01T00:00:00Z",
        until: "2026-02-01T00:00:00Z",
        limit: 20,
      });

      expect(state.lastReq!.method).toBe("GET");
      expect(state.lastReq!.url).toContain("/memory/timeline");
      expect(state.lastReq!.url).toContain("username=alice");
      expect(state.lastReq!.url).toContain("project_dir=%2Fw%2Fx");
      expect(state.lastReq!.url).toContain("since=2026-01-01T00%3A00%3A00Z");
      expect(state.lastReq!.url).toContain("limit=20");
      expect(result).toEqual({ events: [] });
    });
  });

  describe("list", () => {
    it("GET /memory/list with username + optional params", async () => {
      state = { nextResponse: { status: 200, body: { memories: [] } } };

      const client = new MemoryRpcClient(baseUrl, "alice");
      const result = await client.list({
        scope: "user",
        type: ["observation"],
        limit: 50,
      });

      expect(state.lastReq!.method).toBe("GET");
      expect(state.lastReq!.url).toContain("/memory/list");
      expect(state.lastReq!.url).toContain("username=alice");
      expect(state.lastReq!.url).toContain("scope=user");
      expect(state.lastReq!.url).toContain("type=observation");
      expect(state.lastReq!.url).toContain("limit=50");
      expect(result).toEqual({ memories: [] });
    });

    it("list encodes array params as repeated keys", async () => {
      state = { nextResponse: { status: 200, body: {} } };
      const client = new MemoryRpcClient(baseUrl, "alice");
      await client.list({ type: ["observation", "feedback"] });

      const url = state.lastReq!.url;
      expect(url).toContain("type=observation");
      expect(url).toContain("type=feedback");
    });

    it("list omits undefined query params", async () => {
      state = { nextResponse: { status: 200, body: {} } };
      const client = new MemoryRpcClient(baseUrl, "alice");
      await client.list({ limit: 10 });

      const url = state.lastReq!.url;
      expect(url).toContain("limit=10");
      expect(url).not.toContain("scope=");
      expect(url).not.toContain("type=");
    });
  });

  describe("write", () => {
    it("POST /memory/write with username + params", async () => {
      state = { nextResponse: { status: 201, body: { id: "mem-456" } } };

      const client = new MemoryRpcClient(baseUrl, "alice");
      const result = await client.write({
        scope: "user",
        type: "observation",
        name: "Test Memory",
        description: "A test",
        body: "This is a test memory",
      });

      expect(state.lastReq!.method).toBe("POST");
      expect(state.lastReq!.url).toBe("/memory/write");
      expect(state.lastReq!.body).toEqual({
        username: "alice",
        scope: "user",
        type: "observation",
        name: "Test Memory",
        description: "A test",
        body: "This is a test memory",
      });
      expect(result).toEqual({ id: "mem-456" });
    });

    it("write with project_dir and facets", async () => {
      state = { nextResponse: { status: 200, body: {} } };
      const client = new MemoryRpcClient(baseUrl, "alice");
      await client.write({
        scope: "project",
        project_dir: "/w/pbmc",
        type: "project",
        name: "Project note",
        description: "desc",
        body: "body",
        facets: { tags: ["important", "urgent"] },
      });

      expect(state.lastReq!.body).toEqual({
        username: "alice",
        scope: "project",
        project_dir: "/w/pbmc",
        type: "project",
        name: "Project note",
        description: "desc",
        body: "body",
        facets: { tags: ["important", "urgent"] },
      });
    });
  });

  describe("update", () => {
    it("PUT /memory/:id with actor + params", async () => {
      state = { nextResponse: { status: 200, body: { id: "mem-123" } } };

      const client = new MemoryRpcClient(baseUrl, "alice");
      const result = await client.update("mem-123", {
        name: "Updated",
        description: "updated desc",
        body: "updated body",
      });

      expect(state.lastReq!.method).toBe("PUT");
      expect(state.lastReq!.url).toBe("/memory/mem-123");
      expect(state.lastReq!.body).toEqual({
        actor: "alice",
        name: "Updated",
        description: "updated desc",
        body: "updated body",
      });
      expect(result).toEqual({ id: "mem-123" });
    });

    it("update encodes special characters in id", async () => {
      state = { nextResponse: { status: 200, body: {} } };
      const client = new MemoryRpcClient(baseUrl, "alice");
      await client.update("mem/123", {
        name: "x",
        description: "y",
        body: "z",
      });

      expect(state.lastReq!.url).toBe("/memory/mem%2F123");
    });
  });

  describe("forget", () => {
    it("POST /memory/forget with username + memory_id", async () => {
      state = { nextResponse: { status: 200, body: { ok: true } } };

      const client = new MemoryRpcClient(baseUrl, "alice");
      const result = await client.forget("mem-123");

      expect(state.lastReq!.method).toBe("POST");
      expect(state.lastReq!.url).toBe("/memory/forget");
      expect(state.lastReq!.body).toEqual({
        username: "alice",
        memory_id: "mem-123",
      });
      expect(result).toEqual({ ok: true });
    });
  });

  describe("restore", () => {
    it("POST /memory/:id/restore with actor", async () => {
      state = { nextResponse: { status: 200, body: { ok: true } } };

      const client = new MemoryRpcClient(baseUrl, "alice");
      const result = await client.restore("mem-123");

      expect(state.lastReq!.method).toBe("POST");
      expect(state.lastReq!.url).toBe("/memory/mem-123/restore");
      expect(state.lastReq!.body).toEqual({ actor: "alice" });
      expect(result).toEqual({ ok: true });
    });

    it("restore encodes special characters in id", async () => {
      state = { nextResponse: { status: 200, body: {} } };
      const client = new MemoryRpcClient(baseUrl, "alice");
      await client.restore("mem/123");

      expect(state.lastReq!.url).toBe("/memory/mem%2F123/restore");
    });
  });

  describe("audit", () => {
    it("GET /memory/:id/audit with actor + optional limit", async () => {
      state = { nextResponse: { status: 200, body: { entries: [] } } };

      const client = new MemoryRpcClient(baseUrl, "alice");
      const result = await client.audit("mem-123", 50);

      expect(state.lastReq!.method).toBe("GET");
      expect(state.lastReq!.url).toContain("/memory/mem-123/audit");
      expect(state.lastReq!.url).toContain("actor=alice");
      expect(state.lastReq!.url).toContain("limit=50");
      expect(result).toEqual({ entries: [] });
    });

    it("audit omits limit if undefined", async () => {
      state = { nextResponse: { status: 200, body: {} } };
      const client = new MemoryRpcClient(baseUrl, "alice");
      await client.audit("mem-123");

      const url = state.lastReq!.url;
      expect(url).toContain("actor=alice");
      expect(url).not.toContain("limit=");
    });
  });

  describe("error handling", () => {
    it("throws Error with error field from JSON response", async () => {
      state = {
        nextResponse: {
          status: 400,
          body: { error: "invalid query syntax" },
        },
      };

      const client = new MemoryRpcClient(baseUrl, "alice");
      await expect(client.search({ query: "bad[" })).rejects.toThrow(
        "invalid query syntax",
      );
    });

    it("throws Error with statusText if response has no error field", async () => {
      state = { nextResponse: { status: 500, body: { message: "something" } } };

      const client = new MemoryRpcClient(baseUrl, "alice");
      await expect(client.get("x")).rejects.toThrow("Internal Server Error");
    });

    it("throws formatted error if response body is not JSON", async () => {
      server.removeAllListeners("request");
      server.on("request", (req: IncomingMessage, res: ServerResponse) => {
        if (req.url === "/memory/test") {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Server Error");
        }
      });

      const client = new MemoryRpcClient(baseUrl, "alice");
      await expect(client.get("test")).rejects.toThrow(
        /memory-api GET \/memory\/test → HTTP 500/,
      );

      restoreHandler();
    });
  });

  describe("timeout handling", () => {
    it("throws timeout error after 5s with no response", async () => {
      state = { responseDelay: 6000, nextResponse: { status: 200, body: {} } };

      const client = new MemoryRpcClient(baseUrl, "alice");

      const start = Date.now();
      await expect(client.get("x")).rejects.toThrow(
        /memory-api request timed out after 5000ms/,
      );

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(6000);
      expect(elapsed).toBeGreaterThanOrEqual(5000);
    });

    it("POST request also respects timeout", async () => {
      state = { responseDelay: 6000, nextResponse: { status: 200, body: {} } };

      const client = new MemoryRpcClient(baseUrl, "alice");

      await expect(client.write({
        scope: "user",
        type: "observation",
        name: "test",
        description: "test",
        body: "test",
      })).rejects.toThrow(/memory-api request timed out after 5000ms/);
    });

    it("PUT request also respects timeout", async () => {
      state = { responseDelay: 6000, nextResponse: { status: 200, body: {} } };

      const client = new MemoryRpcClient(baseUrl, "alice");

      await expect(client.update("mem-123", {
        name: "test",
        description: "test",
        body: "test",
      })).rejects.toThrow(/memory-api request timed out after 5000ms/);
    });
  });

  describe("construction", () => {
    it("does not make I/O at construction time", () => {
      state = { nextResponse: { status: 200, body: {} } };
      const client = new MemoryRpcClient(baseUrl, "alice");

      expect(state.lastReq).toBeUndefined();
      expect(client).toBeDefined();
    });
  });
});

function restoreHandler() {
  server.removeAllListeners("request");
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method || "GET";
    const url = req.url || "/";

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      try {
        state.lastReq = {
          method,
          url,
          body: body ? (JSON.parse(body) as Record<string, unknown>) : undefined,
        };

        const delayMs = state.responseDelay || 0;
        setTimeout(() => {
          const { status = 200, body: respBody = {} } = state.nextResponse || {};
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(respBody));
        }, delayMs);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    });
  });
}
