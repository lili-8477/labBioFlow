import { describe, expect, it, vi } from "vitest";
import {
  callMemorySearch,
  callMemoryGet,
  callMemoryTimeline,
  callMemoryWrite,
  toolDefinitions,
} from "../src/index.js";

// Test approach: handler-export. Each tool exposes a thin function that takes
// a `deps` bag (fetch + baseUrl + username) and returns an MCP tool result.
// We never spin up a real HTTP server or stdio transport — the handlers are
// the only logic worth testing; the SDK plumbing in main() is config.

type FetchArgs = { url: string; init: RequestInit };

// Stub fetch helper: records the call, returns whatever Response the test
// scripts. We use `Response` (Node 20+ native) so the JSON / status-code
// behaviour matches production.
function makeFetchStub(response: Response | Error) {
  const calls: FetchArgs[] = [];
  const stub = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (response instanceof Error) throw response;
    // Each test gets one response; clone so the handler can read the body
    // even if a future test reuses the same Response object.
    return response.clone();
  });
  return { stub: stub as unknown as typeof fetch, calls };
}

const baseDeps = (stub: typeof fetch) => ({
  fetch: stub,
  baseUrl: "http://stub:8400",
  username: "alice",
});

describe("toolDefinitions", () => {
  it("exposes exactly the four memory tools", () => {
    const names = toolDefinitions.map((t) => t.name).sort();
    expect(names).toEqual([
      "memory_get",
      "memory_search",
      "memory_timeline",
      "memory_write",
    ]);
  });

  it("each tool has an inputSchema with type=object", () => {
    for (const t of toolDefinitions) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description).toBeTruthy();
    }
  });
});

describe("callMemorySearch", () => {
  it("POSTs /memory/search with username from deps and args from caller", async () => {
    const { stub, calls } = makeFetchStub(
      new Response(JSON.stringify([{ memory_id: "m1", score: 0.9 }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await callMemorySearch(
      { query: "phylo tree", limit: 5, types: ["user", "project"] },
      baseDeps(stub),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://stub:8400/memory/search");
    expect(calls[0]!.init.method).toBe("POST");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({
      username: "alice",
      query: "phylo tree",
      limit: 5,
      types: ["user", "project"],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.type).toBe("text");
    // The agent reads `content[0].text` — must be JSON-stringified payload.
    expect(JSON.parse(result.content[0]!.text)).toEqual([
      { memory_id: "m1", score: 0.9 },
    ]);
  });

  it("forwards project_dir and since when supplied", async () => {
    const { stub, calls } = makeFetchStub(
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await callMemorySearch(
      { query: "x", project_dir: "-home-alice-proj", since: "2026-01-01T00:00:00Z" },
      baseDeps(stub),
    );
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.project_dir).toBe("-home-alice-proj");
    expect(body.since).toBe("2026-01-01T00:00:00Z");
  });

  it("returns isError=true when memory-api responds 400", async () => {
    const { stub } = makeFetchStub(
      new Response(
        JSON.stringify({ error: "validation failed", issues: [{ path: ["query"] }] }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await callMemorySearch({ query: "" }, baseDeps(stub));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("validation failed");
    expect(result.content[0]!.text).toContain("400");
  });

  it("returns isError=true when fetch throws (network error)", async () => {
    const { stub } = makeFetchStub(new Error("ECONNREFUSED"));
    const result = await callMemorySearch({ query: "x" }, baseDeps(stub));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("ECONNREFUSED");
  });
});

describe("callMemoryGet", () => {
  it("GETs /memory/:id with the id path-encoded", async () => {
    const { stub, calls } = makeFetchStub(
      new Response(JSON.stringify({ memory_id: "abc-123", body: "..." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await callMemoryGet({ id: "abc-123" }, baseDeps(stub));
    expect(calls[0]!.url).toBe("http://stub:8400/memory/abc-123");
    expect(calls[0]!.init.method ?? "GET").toBe("GET");
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text).memory_id).toBe("abc-123");
  });

  it("encodes ids with slashes/spaces so the URL is well-formed", async () => {
    const { stub, calls } = makeFetchStub(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await callMemoryGet({ id: "weird id/with slash" }, baseDeps(stub));
    expect(calls[0]!.url).toBe(
      "http://stub:8400/memory/" + encodeURIComponent("weird id/with slash"),
    );
  });

  it("surfaces 404 from memory-api as an MCP error", async () => {
    const { stub } = makeFetchStub(
      new Response(JSON.stringify({ error: "memory not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await callMemoryGet({ id: "missing" }, baseDeps(stub));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("memory not found");
  });
});

describe("callMemoryTimeline", () => {
  it("GETs /memory/timeline with username always set in querystring", async () => {
    const { stub, calls } = makeFetchStub(
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await callMemoryTimeline(
      {
        project_dir: "-home-alice-proj",
        since: "2026-01-01T00:00:00Z",
        until: "2026-02-01T00:00:00Z",
        limit: 25,
      },
      baseDeps(stub),
    );
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/memory/timeline");
    expect(url.searchParams.get("username")).toBe("alice");
    expect(url.searchParams.get("project_dir")).toBe("-home-alice-proj");
    expect(url.searchParams.get("since")).toBe("2026-01-01T00:00:00Z");
    expect(url.searchParams.get("until")).toBe("2026-02-01T00:00:00Z");
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it("omits unset optional params from the querystring", async () => {
    const { stub, calls } = makeFetchStub(
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await callMemoryTimeline({}, baseDeps(stub));
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("username")).toBe("alice");
    expect(url.searchParams.has("project_dir")).toBe(false);
    expect(url.searchParams.has("since")).toBe(false);
    expect(url.searchParams.has("until")).toBe(false);
    expect(url.searchParams.has("limit")).toBe(false);
  });
});

describe("callMemoryWrite", () => {
  it("POSTs /memory/write with scope=user", async () => {
    const { stub, calls } = makeFetchStub(
      new Response(JSON.stringify({ memory_id: "m-new" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await callMemoryWrite(
      {
        scope: "user",
        type: "user",
        name: "favourite tools",
        description: "alice prefers seqkit",
        body: "Alice prefers seqkit over samtools subcommands.",
        facets: { topic: ["bioinformatics"] },
      },
      baseDeps(stub),
    );
    expect(calls[0]!.url).toBe("http://stub:8400/memory/write");
    expect(calls[0]!.init.method).toBe("POST");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({
      username: "alice",
      scope: "user",
      type: "user",
      name: "favourite tools",
      description: "alice prefers seqkit",
      body: "Alice prefers seqkit over samtools subcommands.",
      facets: { topic: ["bioinformatics"] },
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({ memory_id: "m-new" });
  });

  it("POSTs scope=project with project_dir", async () => {
    const { stub, calls } = makeFetchStub(
      new Response(JSON.stringify({ memory_id: "p-new" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await callMemoryWrite(
      {
        scope: "project",
        project_dir: "-home-alice-proj",
        type: "project",
        name: "bam→fastq pipeline",
        description: "...",
        body: "...",
      },
      baseDeps(stub),
    );
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.scope).toBe("project");
    expect(body.project_dir).toBe("-home-alice-proj");
  });

  it("rejects scope=org WITHOUT making an HTTP call", async () => {
    const { stub, calls } = makeFetchStub(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const result = await callMemoryWrite(
      {
        scope: "org",
        type: "reference",
        name: "x",
        description: "x",
        body: "x",
      },
      baseDeps(stub),
    );
    expect(calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/org-scope writes are admin-only/);
  });

  it("surfaces 400 validation errors from memory-api", async () => {
    const { stub } = makeFetchStub(
      new Response(
        JSON.stringify({ error: "validation failed", issues: [{ path: ["body"] }] }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await callMemoryWrite(
      { scope: "user", type: "user", name: "x", description: "x", body: "" },
      baseDeps(stub),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("validation failed");
  });
});
