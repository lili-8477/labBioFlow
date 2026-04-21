// Thin wrapper around @anthropic-ai/claude-agent-sdk's `query()` generator.
// Drives one turn: takes the user text + chat_id (= session UUID), streams SDK
// messages through the EventTranslator, publishes StreamEvents to a callback.
//
// Isolation: this is the ONLY file that imports the SDK. Swap it out behind
// this interface if the SDK surface churns.

import { query, type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";
import { EventTranslator, capToolOutput } from "./events.js";
import type { StreamEvent } from "./types.js";

export interface RunTurnArgs {
  chatId: string;
  prompt: string;
  cwd: string;
  /** Prior SDK session UUID to resume; undefined for a new session. */
  resumeSessionId: string | undefined;
  signal: AbortSignal;
  onEvent: (ev: StreamEvent) => void;
  /** Called once the first session_id is observed in SDK output. */
  onSessionId: (sessionId: string) => void;
}

export async function runTurn(args: RunTurnArgs): Promise<void> {
  const { chatId, prompt, cwd, resumeSessionId, signal, onEvent, onSessionId } = args;
  const translator = new EventTranslator();

  // Point the SDK at the global CLI binary we installed in the image.
  // Otherwise the SDK looks for a platform-specific native binary under
  // node_modules/@anthropic-ai/claude-agent-sdk-<platform>/claude, which
  // isn't pulled in by `npm ci --omit=dev` and wouldn't match our libc anyway.
  const cliPath = process.env.CLAUDE_CLI_PATH ?? "/usr/bin/claude";

  const options: Options = {
    cwd,
    permissionMode: "bypassPermissions",
    abortController: { signal } as unknown as AbortController,
    includePartialMessages: true,
    pathToClaudeCodeExecutable: cliPath,
    // SDK generates its own session UUID for new sessions; we capture it via
    // onSessionId and stash it against the chat_id so get_chat_messages works.
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
  } as Options;

  console.log(`[claude] runTurn chat=${chatId.slice(0, 8)} resume=${resumeSessionId?.slice(0, 8) ?? "none"} cwd=${cwd}`);

  let iter = query({ prompt, options });
  let retriedFresh = false;

  let msgCount = 0;
  let sessionIdSeen: string | undefined;
  // Catch "No conversation found" on resume (session JSONL lost) and retry
  // without `resume` — start a fresh session so the user isn't stuck.
  const runLoop = async (): Promise<void> => {
    for await (const msg of iter) {
      if (signal.aborted) return;
      msgCount++;
      const anyMsg = msg as Record<string, unknown>;
      const type = anyMsg.type;
      if (!sessionIdSeen && typeof anyMsg.session_id === "string") {
        sessionIdSeen = anyMsg.session_id;
        console.log(`[claude]   session_id=${sessionIdSeen.slice(0, 8)}`);
        onSessionId(sessionIdSeen);
      }
      if (msgCount <= 3 || msgCount % 20 === 0) console.log(`[claude]   msg#${msgCount} type=${type}`);
      // If the SDK reports a failed-resume error result, retry without resume.
      const subtype = (msg as Record<string, unknown>).subtype;
      const result = (msg as Record<string, unknown>).result;
      if (
        !retriedFresh &&
        resumeSessionId &&
        type === "result" &&
        typeof result === "string" &&
        /No conversation found/i.test(result)
      ) {
        console.warn(`[claude] resume ${resumeSessionId.slice(0, 8)} failed (${subtype}); retrying fresh`);
        retriedFresh = true;
        const freshOptions = { ...options };
        delete (freshOptions as Record<string, unknown>).resume;
        iter = query({ prompt, options: freshOptions as Options });
        sessionIdSeen = undefined;
        msgCount = 0;
        return runLoop();
      }
      handleSdkMessage(msg, chatId, translator, onEvent);
    }
  };
  await runLoop();
  console.log(`[claude] runTurn end, msgs=${msgCount}, aborted=${signal.aborted}, retried=${retriedFresh}`);

  if (!signal.aborted) {
    for (const ev of translator.turnEnd(chatId, undefined)) onEvent(ev);
  }
}

function handleSdkMessage(
  msg: SDKMessage,
  chatId: string,
  t: EventTranslator,
  emit: (ev: StreamEvent) => void,
): void {
  // The SDK surfaces two kinds of messages we care about:
  //   - `assistant` / `user` wrap full API messages (content blocks).
  //   - `stream_event` (only when includePartialMessages=true) carries the
  //     raw Anthropic `content_block_delta` text deltas for live typing.
  // Other subtypes (`system`, `result`) are terminal/metadata.

  const anyMsg = msg as Record<string, unknown>;
  const type = anyMsg.type as string;

  if (type === "stream_event") {
    const ev = anyMsg.event as { type: string; delta?: { type: string; text?: string } } | undefined;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
      emit(t.textDelta(ev.delta.text, chatId));
    }
    return;
  }

  if (type === "assistant") {
    const inner = (anyMsg.message as { content?: unknown[]; usage?: { input_tokens?: number; output_tokens?: number } } | undefined) ?? {};
    const content = (inner.content as Array<Record<string, unknown>>) ?? [];
    const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
    for (const block of content) {
      if (block.type === "tool_use") {
        toolUses.push({
          id: String(block.id),
          name: String(block.name),
          input: block.input,
        });
      }
    }
    if (toolUses.length > 0) {
      emit(t.assistantToolCalls(chatId, undefined, toolUses));
    }
    if (inner.usage) {
      t.recordUsage(inner.usage.input_tokens ?? 0, inner.usage.output_tokens ?? 0);
    }
    return;
  }

  if (type === "user") {
    const inner = (anyMsg.message as { content?: unknown[] } | undefined) ?? {};
    const content = (inner.content as Array<Record<string, unknown>>) ?? [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const toolUseId = String(block.tool_use_id);
      const rawContent = block.content;
      let text: string;
      if (typeof rawContent === "string") {
        text = rawContent;
      } else if (Array.isArray(rawContent)) {
        text = rawContent
          .map((p: unknown) => {
            const b = p as Record<string, unknown>;
            return b?.type === "text" ? String(b.text ?? "") : JSON.stringify(b);
          })
          .join("\n");
      } else {
        text = JSON.stringify(rawContent ?? "");
      }
      const isTransfer = anyMsg.parent_tool_use_id != null && false; // reserved: detect Task subagent
      emit(t.toolResult(chatId, toolUseId, capToolOutput(text), { transfer: isTransfer }));
    }
    return;
  }

  if (type === "result") {
    const cost = (anyMsg.total_cost_usd as number | undefined) ?? 0;
    t.recordCost(cost);
    return;
  }
}
