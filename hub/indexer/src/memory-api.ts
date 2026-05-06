import Fastify, { type FastifyInstance } from "fastify";

// Empty for now; later tasks will add a memory-repo dep.
export interface MemoryApiDeps {}

export function buildApp(_deps: MemoryApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ ok: true }));

  return app;
}
