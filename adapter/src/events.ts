// Translate Claude Agent SDK messages into the frontend stream event shape.
//
// Contract source of truth: pantheon-frontend/src/stores/chat.ts:processStepMessage
// (tool_calls[].function.arguments MUST be a JSON string; frontend JSON.parses it).
//
// Stateful because tool-call duration is measured in the adapter:
// remember wall-clock when a tool_use is emitted, compute duration on tool_result.

import type { StepMessageData, StreamEvent, ToolCallInfo } from "./types.js";

export interface ToolTiming {
  name: string;
  start: number;
}

export class EventTranslator {
  private toolTimings = new Map<string, ToolTiming>();
  private lastUsage = { input: 0, output: 0 };
  private cumulativeCost = 0;

  /** Emit a frontend `chunk` event for a streamed text delta. */
  textDelta(text: string, chatId: string): StreamEvent {
    return { type: "chunk", chunk: { type: "text", text }, chat_id: chatId };
  }

  /**
   * Assistant emitted tool_use blocks. Record start times, build the
   * step_message role=assistant with tool_calls[] (arguments is a JSON string).
   */
  assistantToolCalls(
    chatId: string,
    agentName: string | undefined,
    blocks: Array<{ id: string; name: string; input: unknown }>,
    now = Date.now() / 1000,
  ): StreamEvent {
    const tool_calls: ToolCallInfo[] = blocks.map((b) => {
      this.toolTimings.set(b.id, { name: b.name, start: now });
      return {
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      };
    });
    const step: StepMessageData = {
      role: "assistant",
      tool_calls,
      agent_name: agentName,
      timestamp: now,
      _metadata: { start_timestamp: now },
    };
    return { type: "step_message", step_message: step, chat_id: chatId };
  }

  /**
   * Tool result for a prior tool_use. Looks up the start time to report duration.
   * Delegation (Task tool) surfaces as transfer=true with content = target agent.
   */
  toolResult(
    chatId: string,
    toolUseId: string,
    content: string,
    opts: { transfer?: boolean } = {},
    now = Date.now() / 1000,
  ): StreamEvent {
    const timing = this.toolTimings.get(toolUseId);
    const start = timing?.start ?? now;
    const toolName = timing?.name ?? "tool";
    this.toolTimings.delete(toolUseId);

    const step: StepMessageData = opts.transfer
      ? {
          role: "tool",
          transfer: true,
          content,
          tool_call_id: toolUseId,
          _metadata: {
            start_timestamp: start,
            end_timestamp: now,
            execution_duration: now - start,
          },
        }
      : {
          role: "tool",
          tool_call_id: toolUseId,
          tool_name: toolName,
          content,
          _metadata: {
            start_timestamp: start,
            end_timestamp: now,
            execution_duration: now - start,
          },
        };

    return { type: "step_message", step_message: step, chat_id: chatId };
  }

  /**
   * Per-turn usage update from an assistant message_stop. Accumulates so the
   * final synthetic step reports totals even though the SDK only reports
   * `total_cost_usd` at the terminal `result` event.
   */
  recordUsage(input: number, output: number): void {
    this.lastUsage = { input, output };
  }

  recordCost(totalUsd: number): void {
    this.cumulativeCost = totalUsd;
  }

  /**
   * Turn ended. Emit a synthetic final step_message carrying cumulative tokens
   * and cost in _metadata, followed by a `chat_finished`. The synthetic step
   * lets the existing ExecutionTimeline render cumulative metrics without UI
   * changes.
   */
  turnEnd(chatId: string, agentName: string | undefined, now = Date.now() / 1000): StreamEvent[] {
    const total_tokens = this.lastUsage.input + this.lastUsage.output;
    const syntheticStep: StepMessageData = {
      role: "assistant",
      agent_name: agentName,
      timestamp: now,
      _metadata: {
        end_timestamp: now,
        total_tokens,
        input_tokens: this.lastUsage.input,
        output_tokens: this.lastUsage.output,
        current_cost: this.cumulativeCost,
      },
    };
    return [
      { type: "step_message", step_message: syntheticStep, chat_id: chatId },
      { type: "chat_finished", chat_id: chatId },
    ];
  }
}

export const MAX_TOOL_OUTPUT_BYTES = 900_000;

/** Cap tool output to fit under NATS's 1 MB default message ceiling. */
export function capToolOutput(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= MAX_TOOL_OUTPUT_BYTES) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(s.slice(0, mid), "utf8") <= MAX_TOOL_OUTPUT_BYTES - 32) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + "\n...[truncated]";
}
