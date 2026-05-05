import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { embedTexts, EmbedderError } from "../src/embedder-client.js";

let lastReceived: any;
let nextStatus = 200;
let nextBody: any = { vectors: [] };
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastReceived = body ? JSON.parse(body) : null;
        res.writeHead(nextStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(nextBody));
      });
    }).listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("embedTexts", () => {
  it("posts to /embed and returns vectors", async () => {
    nextStatus = 200;
    nextBody = { vectors: [[0.1, 0.2], [0.3, 0.4]] };
    const v = await embedTexts({ baseUrl, texts: ["a", "b"] });
    expect(v).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(lastReceived).toEqual({ texts: ["a", "b"] });
  });

  it("throws EmbedderError on non-2xx", async () => {
    nextStatus = 500;
    nextBody = { detail: "boom" };
    await expect(embedTexts({ baseUrl, texts: ["a"] })).rejects.toBeInstanceOf(EmbedderError);
  });

  it("throws EmbedderError when response shape is wrong", async () => {
    nextStatus = 200;
    nextBody = { not_vectors: [] };
    await expect(embedTexts({ baseUrl, texts: ["a"] })).rejects.toBeInstanceOf(EmbedderError);
  });

  it("throws EmbedderError when vector count != texts count", async () => {
    nextStatus = 200;
    nextBody = { vectors: [[0.1, 0.2]] };
    await expect(embedTexts({ baseUrl, texts: ["a", "b"] })).rejects.toBeInstanceOf(EmbedderError);
  });
});
