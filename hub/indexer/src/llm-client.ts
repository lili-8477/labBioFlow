import type Anthropic from "@anthropic-ai/sdk";
import { buildDistillationPrompt, DistillationResult } from "./distiller-prompts.js";

export class DistillerLlmError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
  }
}

export interface DistillOpts {
  transcript: string;
  anthropic: Pick<Anthropic, "messages">;
  model: string;
  maxTokens?: number;
}

export async function distill(opts: DistillOpts): Promise<DistillationResult> {
  const prompt = buildDistillationPrompt({ transcript: opts.transcript });

  const response = await opts.anthropic.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
  });

  const textBlock = response.content.find((b: any) => b.type === "text");
  if (!textBlock || (textBlock as any).type !== "text") {
    throw new DistillerLlmError("no text block in LLM response");
  }
  const raw = (textBlock as any).text as string;

  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    throw new DistillerLlmError(`failed to parse LLM JSON: ${(e as Error).message}`, e);
  }

  const result = DistillationResult.safeParse(parsed);
  if (!result.success) {
    throw new DistillerLlmError(
      `LLM output failed schema validation: ${result.error.message}`,
      result.error,
    );
  }
  return result.data;
}
