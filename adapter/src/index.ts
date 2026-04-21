#!/usr/bin/env node
// Adapter entrypoint. Per-user devcontainer runs one of these.
//
// Env:
//   NATS_SERVERS      e.g. "nats://pantheon-nats:4222"
//   ID_HASH           short hash (12 hex); service_id = sha256(ID_HASH) full hex
//   NATS_USER         optional auth user (defaults to "agent")
//   NATS_PASS         optional auth token
//   WORKSPACE_ROOT    default "/workspace"
//   DEFAULT_PROJECT   default "/workspace" (cwd for Claude Code turns)
//   HOME              default "/home/node"

import { createHash } from "node:crypto";
import { NatsBus } from "./nats-bus.js";
import { RpcRouter } from "./rpc.js";

function computeServiceId(idHash: string): string {
  return createHash("sha256").update(idHash).digest("hex");
}

async function main(): Promise<void> {
  const idHash = requireEnv("ID_HASH");
  const serviceId = computeServiceId(idHash);
  const servers = process.env.NATS_SERVERS ?? "nats://localhost:4222";
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? "/workspace";
  const defaultProjectCwd = process.env.DEFAULT_PROJECT ?? workspaceRoot;
  const home = process.env.HOME ?? "/home/node";

  const bus = new NatsBus({
    servers,
    serviceId,
    user: process.env.NATS_USER ?? "agent",
    pass: process.env.NATS_PASS,
    subjectPrefix: process.env.NATS_SUBJECT_PREFIX,
  });

  await bus.connect();
  console.log(`[adapter] connected to NATS ${servers}, service_id=${serviceId.slice(0, 12)}...`);

  const router = new RpcRouter({
    serviceId,
    workspaceRoot,
    home,
    defaultProjectCwd,
    publishStream: (streamId, ev) => bus.publishStream(streamId, ev),
    publishRaw: (subject, envelope) => bus.publishRaw(subject, envelope),
    streamSubject: (streamId) => bus.subjectFor(streamId),
    kernelBridgePath: process.env.KERNEL_BRIDGE_PATH ?? "/opt/adapter/kernel-bridge.py",
  });

  await bus.serve((method, params) => router.dispatch(method, params));
  console.log("[adapter] serving RPCs");

  const shutdown = async (sig: string) => {
    console.log(`[adapter] ${sig} received, shutting down`);
    router.abortAll();
    await new Promise((r) => setTimeout(r, 500)); // let aborts flush
    await bus.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[adapter] missing required env ${name}`);
    process.exit(2);
  }
  return v;
}

main().catch((err) => {
  console.error("[adapter] fatal:", err);
  process.exit(1);
});
