import { describe, it, expect, vi } from "vitest";
import { distill } from "../src/llm-client.js";

function fakeSdk(responseText: string, capture?: { lastArgs?: any }) {
  return {
    messages: {
      create: vi.fn(async (args: any) => {
        if (capture) capture.lastArgs = args;
        return {
          content: [{ type: "text", text: responseText }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }),
    },
  } as any;
}

const VALID = JSON.stringify({
  summary: { name: "n", description: "d", body: "b" },
  observations: [],
});

describe("llm-client.distill", () => {
  it("calls Anthropic with the pinned model and a max_tokens budget", async () => {
    const cap: { lastArgs?: any } = {};
    await distill({
      transcript: "hello",
      anthropic: fakeSdk(VALID, cap),
      model: "claude-haiku-4-5",
    });
    expect(cap.lastArgs.model).toBe("claude-haiku-4-5");
    expect(cap.lastArgs.max_tokens).toBeGreaterThanOrEqual(2048);
    expect(cap.lastArgs.system).toContain("distill");
    expect(cap.lastArgs.messages[0].content).toContain("hello");
  });

  it("returns a parsed DistillationResult on valid JSON", async () => {
    const out = await distill({
      transcript: "x",
      anthropic: fakeSdk(VALID),
      model: "claude-haiku-4-5",
    });
    expect(out.summary.name).toBe("n");
    expect(out.observations).toEqual([]);
  });

  it("strips markdown code fences if the LLM wraps the JSON", async () => {
    const wrapped = "```json\n" + VALID + "\n```";
    const out = await distill({
      transcript: "x",
      anthropic: fakeSdk(wrapped),
      model: "claude-haiku-4-5",
    });
    expect(out.summary.name).toBe("n");
  });

  it("throws DistillerLlmError when JSON is malformed", async () => {
    await expect(
      distill({
        transcript: "x",
        anthropic: fakeSdk("not json at all"),
        model: "claude-haiku-4-5",
      }),
    ).rejects.toThrow(/parse/i);
  });

  it("throws DistillerLlmError when JSON shape is wrong", async () => {
    const bad = JSON.stringify({ summary: { name: "n" }, observations: [] });
    await expect(
      distill({
        transcript: "x",
        anthropic: fakeSdk(bad),
        model: "claude-haiku-4-5",
      }),
    ).rejects.toThrow();
  });
});
