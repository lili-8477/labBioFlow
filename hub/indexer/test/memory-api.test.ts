import { describe, it, expect, afterAll } from "vitest";
import { buildApp } from "../src/memory-api.js";

const app = buildApp({});

afterAll(async () => {
  await app.close();
});

describe("memory-api", () => {
  it("GET /healthz returns 200 + { ok: true }", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
