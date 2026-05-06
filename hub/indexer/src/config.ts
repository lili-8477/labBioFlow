import pino from "pino";

export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

export interface Config {
  pgUrl: string;
  workspacesRoot: string;
  maxConcurrentFiles: number;
  maxPassBytes: number;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  migrationLockKey: bigint;
  pgStartupMaxWaitSec: number;
  anthropicApiKey:      string;
  embedderUrl:          string;
  distillModel:         string;
  distillSettleSec:     number;
  distillIntervalSec:   number;
  distillMaxTokens:     number;
  distillPromptVersion: number;
  distillBatchSize:     number;
  embedderBatchSize:    number;
  embedderIntervalMs:   number;
  memoryApiPort:        number;
}

function parseIntVar(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer; got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseBigintVar(env: Record<string, string | undefined>, name: string, fallback: bigint): bigint {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`${name} must be a valid bigint literal; got ${JSON.stringify(raw)}`);
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const pgUrl = env.PG_URL;
  if (!pgUrl) throw new Error("PG_URL is required");
  const anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required");
  const logLevel = (env.LOG_LEVEL ?? "info") as Config["logLevel"];
  return {
    pgUrl,
    workspacesRoot: env.WORKSPACES_ROOT ?? "/workspaces",
    maxConcurrentFiles: parseIntVar(env, "MAX_CONCURRENT_FILES", 8),
    maxPassBytes: parseIntVar(env, "MAX_PASS_BYTES", 8 * 1024 * 1024),
    logLevel,
    migrationLockKey: parseBigintVar(env, "MIGRATION_LOCK_KEY", 0x62696f666c77n),
    pgStartupMaxWaitSec: parseIntVar(env, "PG_STARTUP_MAX_WAIT_SEC", 300),
    anthropicApiKey,
    embedderUrl:          env.EMBEDDER_URL  ?? "http://embedder:8000",
    distillModel:         env.DISTILL_MODEL ?? "claude-haiku-4-5",
    distillSettleSec:     parseIntVar(env, "DISTILL_SETTLE_SEC",      300),
    distillIntervalSec:   parseIntVar(env, "DISTILL_INTERVAL_SEC",     60),
    distillMaxTokens:     parseIntVar(env, "DISTILL_MAX_TOKENS",   80000),
    distillPromptVersion: parseIntVar(env, "DISTILL_PROMPT_VERSION",    1),
    distillBatchSize:     parseIntVar(env, "DISTILL_BATCH_SIZE",       50),
    embedderBatchSize:    parseIntVar(env, "EMBEDDER_BATCH_SIZE",      64),
    embedderIntervalMs:   parseIntVar(env, "EMBEDDER_INTERVAL_MS",   5000),
    memoryApiPort:        parseIntVar(env, "MEMORY_API_PORT",         8400),
  };
}
