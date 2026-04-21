// Contract tests — the frontend's event shape is the pinned contract.
// These fixtures come from pantheon-frontend/src/stores/chat.ts:processStepMessage
// and src/types/index.ts. If the SDK changes, these stay green.

import { describe, expect, it } from "vitest";
import { capToolOutput, EventTranslator, MAX_TOOL_OUTPUT_BYTES } from "../src/events.js";

const CHAT = "550e8400-e29b-41d4-a716-446655440000";

describe("EventTranslator.textDelta", () => {
  it("emits a chunk event with type='text' and the delta text", () => {
    const t = new EventTranslator();
    const ev = t.textDelta("hello ", CHAT);
    expect(ev).toEqual({
      type: "chunk",
      chunk: { type: "text", text: "hello " },
      chat_id: CHAT,
    });
  });
});

describe("EventTranslator.assistantToolCalls", () => {
  it("serialises tool_use.input as a JSON STRING (frontend JSON.parses arguments)", () => {
    const t = new EventTranslator();
    const ev = t.assistantToolCalls(CHAT, "researcher", [
      { id: "toolu_1", name: "Bash", input: { command: "ls", cwd: "/tmp" } },
    ]);
    expect(ev.type).toBe("step_message");
    if (ev.type !== "step_message") throw new Error();
    expect(ev.step_message.role).toBe("assistant");
    expect(ev.step_message.agent_name).toBe("researcher");
    expect(ev.step_message.tool_calls).toHaveLength(1);
    const tc = ev.step_message.tool_calls![0]!;
    expect(tc.id).toBe("toolu_1");
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("Bash");
    // Critical: must be a JSON string, not an object
    expect(typeof tc.function.arguments).toBe("string");
    expect(JSON.parse(tc.function.arguments)).toEqual({ command: "ls", cwd: "/tmp" });
  });

  it("records start timestamp so later toolResult can compute duration", () => {
    const t = new EventTranslator();
    t.assistantToolCalls(CHAT, undefined, [{ id: "toolu_2", name: "Read", input: {} }], 1000);
    const res = t.toolResult(CHAT, "toolu_2", "file content", {}, 1002.5);
    if (res.type !== "step_message") throw new Error();
    expect(res.step_message._metadata?.start_timestamp).toBe(1000);
    expect(res.step_message._metadata?.end_timestamp).toBe(1002.5);
    expect(res.step_message._metadata?.execution_duration).toBeCloseTo(2.5, 5);
  });
});

describe("EventTranslator.toolResult", () => {
  it("emits role=tool with tool_call_id matching the original tool_use", () => {
    const t = new EventTranslator();
    t.assistantToolCalls(CHAT, undefined, [{ id: "toolu_x", name: "Grep", input: {} }], 10);
    const ev = t.toolResult(CHAT, "toolu_x", "match\n", {}, 11);
    if (ev.type !== "step_message") throw new Error();
    expect(ev.step_message.role).toBe("tool");
    expect(ev.step_message.tool_call_id).toBe("toolu_x");
    expect(ev.step_message.tool_name).toBe("Grep");
    expect(ev.step_message.content).toBe("match\n");
    expect(ev.step_message.transfer).toBeFalsy();
  });

  it("sets transfer=true and content=<target agent> when opts.transfer", () => {
    const t = new EventTranslator();
    t.assistantToolCalls(CHAT, undefined, [{ id: "toolu_d", name: "Task", input: {} }], 20);
    const ev = t.toolResult(CHAT, "toolu_d", "researcher", { transfer: true }, 21);
    if (ev.type !== "step_message") throw new Error();
    expect(ev.step_message.transfer).toBe(true);
    expect(ev.step_message.content).toBe("researcher");
  });

  it("works with no prior tool_use recorded (name falls back to 'tool')", () => {
    const t = new EventTranslator();
    const ev = t.toolResult(CHAT, "stray", "output", {}, 5);
    if (ev.type !== "step_message") throw new Error();
    expect(ev.step_message.tool_name).toBe("tool");
  });
});

describe("EventTranslator.turnEnd", () => {
  it("emits a synthetic step_message with cumulative tokens+cost, then chat_finished", () => {
    const t = new EventTranslator();
    t.recordUsage(100, 50);
    t.recordCost(0.0123);
    const evs = t.turnEnd(CHAT, "researcher", 99);
    expect(evs).toHaveLength(2);
    const [step, end] = evs;
    if (step!.type !== "step_message") throw new Error();
    expect(step!.step_message._metadata?.total_tokens).toBe(150);
    expect(step!.step_message._metadata?.input_tokens).toBe(100);
    expect(step!.step_message._metadata?.output_tokens).toBe(50);
    expect(step!.step_message._metadata?.current_cost).toBe(0.0123);
    expect(step!.step_message._metadata?.end_timestamp).toBe(99);
    expect(end!.type).toBe("chat_finished");
    if (end!.type !== "chat_finished") throw new Error();
    expect(end!.chat_id).toBe(CHAT);
  });
});

describe("capToolOutput", () => {
  it("passes small strings through unchanged", () => {
    expect(capToolOutput("small")).toBe("small");
  });
  it("truncates to under the NATS ceiling with a marker", () => {
    const big = "a".repeat(MAX_TOOL_OUTPUT_BYTES + 10_000);
    const out = capToolOutput(big);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
    expect(out.endsWith("...[truncated]")).toBe(true);
  });
});
