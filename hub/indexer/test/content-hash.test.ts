import { describe, it, expect } from "vitest";
import { contentHash } from "../src/content-hash.js";

describe("contentHash", () => {
  it("returns a 32-byte Buffer", () => {
    expect(contentHash({ body: "hello", promptVersion: 1 })).toHaveLength(32);
  });

  it("is stable for identical inputs", () => {
    const a = contentHash({ body: "x", promptVersion: 1 });
    const b = contentHash({ body: "x", promptVersion: 1 });
    expect(a.equals(b)).toBe(true);
  });

  it("normalises whitespace + case so trivial reformatting doesn't dedup-bust", () => {
    const a = contentHash({ body: "Hello   World\n", promptVersion: 1 });
    const b = contentHash({ body: "hello world", promptVersion: 1 });
    expect(a.equals(b)).toBe(true);
  });

  it("differs when promptVersion changes (forces re-distill)", () => {
    const a = contentHash({ body: "x", promptVersion: 1 });
    const b = contentHash({ body: "x", promptVersion: 2 });
    expect(a.equals(b)).toBe(false);
  });

  it("differs for substantively different bodies", () => {
    const a = contentHash({ body: "x", promptVersion: 1 });
    const b = contentHash({ body: "y", promptVersion: 1 });
    expect(a.equals(b)).toBe(false);
  });
});
