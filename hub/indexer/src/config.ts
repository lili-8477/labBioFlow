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
  embedderUrl:          string;
  embedderBatchSize:    number;
  embedderIntervalMs:   number;
  memoryApiPort:        number;
  memoryOrgManagers:    string[];
  shareSnapshotsDir:          string;
  shareMaxFolderBytes:        number;
  shareSnapshotTtlDays:       number;
  shareCleanupIntervalHours:  number;
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
  const logLevel = (env.LOG_LEVEL ?? "info") as Config["logLevel"];
  const memoryOrgManagers = (env.MEMORY_ORG_MANAGER ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0);
  const shareSnapshotsDir = env.SHARE_SNAPSHOTS_DIR && env.SHARE_SNAPSHOTS_DIR.length > 0
    ? env.SHARE_SNAPSHOTS_DIR
    : `${env.WORKSPACES_ROOT ?? "/workspaces"}/shared/.share-snapshots`;
  const shareMaxFolderBytes       = parseIntVar(env, "SHARE_MAX_FOLDER_BYTES",        100 * 1024 * 1024);
  const shareSnapshotTtlDays      = parseIntVar(env, "SHARE_SNAPSHOT_TTL_DAYS",      30);
  const shareCleanupIntervalHours = parseIntVar(env, "SHARE_CLEANUP_INTERVAL_HOURS", 24);
  return {
    pgUrl,
    workspacesRoot: env.WORKSPACES_ROOT ?? "/workspaces",
    maxConcurrentFiles: parseIntVar(env, "MAX_CONCURRENT_FILES", 8),
    maxPassBytes: parseIntVar(env, "MAX_PASS_BYTES", 8 * 1024 * 1024),
    logLevel,
    migrationLockKey: parseBigintVar(env, "MIGRATION_LOCK_KEY", 0x62696f666c77n),
    pgStartupMaxWaitSec: parseIntVar(env, "PG_STARTUP_MAX_WAIT_SEC", 300),
    embedderUrl:          env.EMBEDDER_URL  ?? "http://embedder:8000",
    embedderBatchSize:    parseIntVar(env, "EMBEDDER_BATCH_SIZE",      64),
    embedderIntervalMs:   parseIntVar(env, "EMBEDDER_INTERVAL_MS",   5000),
    memoryApiPort:        parseIntVar(env, "MEMORY_API_PORT",         8400),
    memoryOrgManagers,
    shareSnapshotsDir,
    shareMaxFolderBytes,
    shareSnapshotTtlDays,
    shareCleanupIntervalHours,
  };
}
