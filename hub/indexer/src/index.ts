import { Pool } from "pg";
import pino from "pino";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { runMigrations } from "./migrate.js";
import { startWatcher } from "./watcher.js";
import { runEmbedderOnce } from "./embedder-worker.js";
import { embedTexts } from "./embedder-client.js";
import { buildApp } from "./memory-api.js";
import {
  searchMemories,
  getMemory,
  timelineMemories,
  writeUserMemory,
  forgetMemory,
  getContext,
  updateMemory,
  restoreMemory,
  listMemories,
  getAuditTrail,
  getMetrics,
} from "./memory-repo.js";
import { writeDistillation } from "./distiller-repo.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = pino({ level: cfg.logLevel });

  const pool = new Pool({ connectionString: cfg.pgUrl, max: Math.max(10, cfg.maxConcurrentFiles * 2) });

  await waitForPg(pool, cfg.pgStartupMaxWaitSec, logger);

  await runMigrations({
    pool,
    migrationsDir: path.resolve(HERE, "..", "migrations"),
    lockKey: cfg.migrationLockKey,
  });
  logger.info({ workspacesRoot: cfg.workspacesRoot }, "migrations applied — starting watcher");

  const handle = startWatcher({
    pool,
    watchRoot: cfg.workspacesRoot,
    maxConcurrentFiles: cfg.maxConcurrentFiles,
    maxPassBytes: cfg.maxPassBytes,
    logger,
  });

  // Auto-distill loop removed: was generating low-signal session_summary +
  // observation rows on every settled session, polluting recall. Replaced by
  // agent-on-demand distill via the /memory slash command → bioflow-memory
  // memory_distill_session MCP tool → POST /memory/distill. Distillation
  // helpers (writeDistillation, distiller.ts, llm-client.ts) are kept in
  // place because tests and the new endpoint still use writeDistillation.

  const startEmbedderLoop = (): void => {
    const tick = async (): Promise<void> => {
      try {
        const summary = await runEmbedderOnce(pool, {
          embedderUrl: cfg.embedderUrl,
          batchSize:   cfg.embedderBatchSize,
        });
        if (summary.embedded > 0 || summary.failed > 0) {
          logger.info({ summary }, "embedder pass");
        }
      } catch (err) {
        logger.error({ err }, "embedder pass crashed");
      } finally {
        setTimeout(tick, cfg.embedderIntervalMs);
      }
    };
    setTimeout(tick, cfg.embedderIntervalMs);
  };

  startEmbedderLoop();

  const app = buildApp({
    pool,
    embedderClient: {
      embedTexts: (texts) => embedTexts({ baseUrl: cfg.embedderUrl, texts }),
    },
    repo: {
      searchMemories,
      getMemory,
      timelineMemories,
      writeUserMemory,
      forgetMemory,
      getContext,
      updateMemory,
      restoreMemory,
      listMemories,
      getAuditTrail,
      getMetrics,
      writeDistillation,
    },
  });
  await app.listen({ port: cfg.memoryApiPort, host: "0.0.0.0" });
  logger.info({ port: cfg.memoryApiPort }, "memory-api listening");

  const shutdown = async (sig: NodeJS.Signals): Promise<void> => {
    logger.info({ sig }, "shutdown signal");
    await app.close();
    await handle.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function waitForPg(pool: Pool, maxWaitSec: number, logger: pino.Logger): Promise<void> {
  const deadline = Date.now() + maxWaitSec * 1000;
  let delay = 500;
  while (Date.now() < deadline) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      logger.warn({ err: (err as Error).message, delay }, "waiting for PG");
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
  logger.error("PG unreachable past PG_STARTUP_MAX_WAIT_SEC — exiting");
  process.exit(1);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
