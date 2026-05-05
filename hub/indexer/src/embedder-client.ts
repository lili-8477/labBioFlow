export class EmbedderError extends Error {
  constructor(message: string, public cause?: unknown) { super(message); }
}

export interface EmbedTextsArgs {
  baseUrl:    string;
  texts:      string[];
  timeoutMs?: number;
}

export async function embedTexts(args: EmbedTextsArgs): Promise<number[][]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), args.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(`${args.baseUrl}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: args.texts }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new EmbedderError(`embedder fetch failed: ${(e as Error).message}`, e);
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new EmbedderError(`embedder ${res.status}: ${body.slice(0, 200)}`);
  }

  let parsed: any;
  try {
    parsed = await res.json();
  } catch (e) {
    throw new EmbedderError(`embedder returned non-JSON: ${(e as Error).message}`, e);
  }
  if (!Array.isArray(parsed?.vectors)) {
    throw new EmbedderError(`embedder response missing 'vectors' array`);
  }
  if (parsed.vectors.length !== args.texts.length) {
    throw new EmbedderError(
      `embedder returned ${parsed.vectors.length} vectors for ${args.texts.length} texts`,
    );
  }
  return parsed.vectors as number[][];
}
