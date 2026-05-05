import { createHash } from "node:crypto";

export function contentHash(args: { body: string; promptVersion: number }): Buffer {
  const normalised = args.body.toLowerCase().replace(/\s+/g, " ").trim();
  const h = createHash("sha256");
  h.update(`v${args.promptVersion} `);
  h.update(normalised);
  return h.digest();
}
