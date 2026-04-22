import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reads PG_URL and applies defaults", () => {
    const cfg = loadConfig({ PG_URL: "postgres://u@h/d" });
    expect(cfg.pgUrl).toBe("postgres://u@h/d");
    expect(cfg.workspacesRoot).toBe("/workspaces");
    expect(cfg.maxConcurrentFiles).toBe(8);
    expect(cfg.maxPassBytes).toBe(8 * 1024 * 1024);
    expect(cfg.logLevel).toBe("info");
    expect(cfg.migrationLockKey).toBe(0x62696f666c77n);
    expect(cfg.pgStartupMaxWaitSec).toBe(300);
  });

  it("overrides from env", () => {
    const cfg = loadConfig({
      PG_URL: "postgres://x",
      WORKSPACES_ROOT: "/tmp/w",
      MAX_CONCURRENT_FILES: "2",
      MAX_PASS_BYTES: "1024",
      LOG_LEVEL: "debug",
      MIGRATION_LOCK_KEY: "0x1234",
      PG_STARTUP_MAX_WAIT_SEC: "10",
    });
    expect(cfg.workspacesRoot).toBe("/tmp/w");
    expect(cfg.maxConcurrentFiles).toBe(2);
    expect(cfg.maxPassBytes).toBe(1024);
    expect(cfg.logLevel).toBe("debug");
    expect(cfg.migrationLockKey).toBe(0x1234n);
    expect(cfg.pgStartupMaxWaitSec).toBe(10);
  });

  it("throws without PG_URL", () => {
    expect(() => loadConfig({})).toThrow(/PG_URL/);
  });

  it("rejects non-numeric MAX_CONCURRENT_FILES", () => {
    expect(() => loadConfig({ PG_URL: "x", MAX_CONCURRENT_FILES: "abc" }))
      .toThrow(/MAX_CONCURRENT_FILES/);
  });
});
