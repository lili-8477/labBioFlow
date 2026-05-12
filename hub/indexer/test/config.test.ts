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

  it('memoryOrgManagers defaults to [] when MEMORY_ORG_MANAGER is unset', () => {
    const cfg = loadConfig({ PG_URL: 'postgres://x' });
    expect(cfg.memoryOrgManagers).toEqual([]);
  });

  it('memoryOrgManagers reads a single name', () => {
    const cfg = loadConfig({ PG_URL: 'postgres://x', MEMORY_ORG_MANAGER: 'li86' });
    expect(cfg.memoryOrgManagers).toEqual(['li86']);
  });

  it('memoryOrgManagers parses a comma-separated list and trims whitespace', () => {
    const cfg = loadConfig({ PG_URL: 'postgres://x', MEMORY_ORG_MANAGER: 'li86, alice ,bob' });
    expect(cfg.memoryOrgManagers).toEqual(['li86', 'alice', 'bob']);
  });

  it('memoryOrgManagers treats empty string and stray commas as empty list', () => {
    const cfg = loadConfig({ PG_URL: 'postgres://x', MEMORY_ORG_MANAGER: ',, ,' });
    expect(cfg.memoryOrgManagers).toEqual([]);
  });

  it('shareSnapshotsDir defaults to /workspaces/shared/.share-snapshots', () => {
    const cfg = loadConfig({ PG_URL: 'postgres://x' });
    expect(cfg.shareSnapshotsDir).toBe('/workspaces/shared/.share-snapshots');
  });

  it('shareSnapshotsDir tracks WORKSPACES_ROOT when SHARE_SNAPSHOTS_DIR unset', () => {
    const cfg = loadConfig({ PG_URL: 'postgres://x', WORKSPACES_ROOT: '/srv/ws' });
    expect(cfg.shareSnapshotsDir).toBe('/srv/ws/shared/.share-snapshots');
  });

  it('shareSnapshotsDir uses SHARE_SNAPSHOTS_DIR override when set', () => {
    const cfg = loadConfig({
      PG_URL: 'postgres://x',
      WORKSPACES_ROOT: '/workspaces',
      SHARE_SNAPSHOTS_DIR: '/var/share-snaps',
    });
    expect(cfg.shareSnapshotsDir).toBe('/var/share-snaps');
  });

  it('shareMaxFolderBytes defaults to 100 MB', () => {
    const cfg = loadConfig({ PG_URL: 'postgres://x' });
    expect(cfg.shareMaxFolderBytes).toBe(100 * 1024 * 1024);
  });

  it('shareMaxFolderBytes reads SHARE_MAX_FOLDER_BYTES env', () => {
    const cfg = loadConfig({ PG_URL: 'postgres://x', SHARE_MAX_FOLDER_BYTES: '5242880' });
    expect(cfg.shareMaxFolderBytes).toBe(5 * 1024 * 1024);
  });

  it('shareMaxFolderBytes rejects non-integer SHARE_MAX_FOLDER_BYTES', () => {
    expect(() => loadConfig({ PG_URL: 'postgres://x', SHARE_MAX_FOLDER_BYTES: 'huge' }))
      .toThrow(/integer/);
  });

  it('shareSnapshotTtlDays defaults to 30', () => {
    const cfg = loadConfig({ PG_URL: 'postgres://x' });
    expect(cfg.shareSnapshotTtlDays).toBe(30);
  });

  it('shareSnapshotTtlDays reads SHARE_SNAPSHOT_TTL_DAYS env override', () => {
    const cfg = loadConfig({ PG_URL: 'postgres://x', SHARE_SNAPSHOT_TTL_DAYS: '7' });
    expect(cfg.shareSnapshotTtlDays).toBe(7);
  });

  it('shareCleanupIntervalHours defaults to 24 and reads env override', () => {
    const cfg = loadConfig({ PG_URL: 'postgres://x', SHARE_CLEANUP_INTERVAL_HOURS: '6' });
    expect(cfg.shareCleanupIntervalHours).toBe(6);
  });

  it('shareAutoCloseIdleDays defaults to 30', () => {
    const cfg = loadConfig({ PG_URL: 'postgres://x' });
    expect(cfg.shareAutoCloseIdleDays).toBe(30);
  });

  it('shareAutoCloseIntervalHours reads SHARE_AUTO_CLOSE_INTERVAL_HOURS env override', () => {
    const cfg = loadConfig({ PG_URL: 'postgres://x', SHARE_AUTO_CLOSE_INTERVAL_HOURS: '6' });
    expect(cfg.shareAutoCloseIntervalHours).toBe(6);
  });
});
