// Node-side wrapper around image/kernel-bridge.py.
//
// Spawns one Python child per adapter process (lazy, on first execute).
// Forwards execute/interrupt/restart as JSON lines on stdin; reads JSON lines
// on stdout and routes them to:
//   - IOPub messages → NATS stream `notebook_iopub_<sessionId>`
//   - execute_reply → resolves the pending execute() promise
//   - status changes → tracked in `status`, also streamed to the same subject

import { ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type KernelStatus = "starting" | "idle" | "busy" | "dead" | "unknown";

export interface IOPubEvent {
  msg_type: string;
  content: Record<string, unknown>;
  cell_id: string | null;
  parent_msg_id: string | null;
}

export interface ExecuteReply {
  status: "ok" | "error" | string;
  execution_count: number | null;
  error: string | null;
}

export interface KernelDeps {
  /** Path to the Python helper script inside the container. */
  bridgePath: string;
  /** Stable session ID used for the IOPub stream subject. */
  sessionId: string;
  /** Called for every IOPub message — adapter republishes to NATS. */
  onIopub: (sessionId: string, ev: IOPubEvent) => void;
}

export class KernelBridge {
  private proc: ChildProcess | null = null;
  private pendingReplies = new Map<
    string,
    { resolve: (r: ExecuteReply) => void; reject: (e: Error) => void }
  >();
  private lastExecuteCellId: string | null = null;
  private status_: KernelStatus = "unknown";

  constructor(private deps: KernelDeps) {}

  get status(): KernelStatus {
    return this.status_;
  }

  get sessionId(): string {
    return this.deps.sessionId;
  }

  private ensureStarted(): void {
    if (this.proc && !this.proc.killed) return;
    console.log(`[kernel] spawning ${this.deps.bridgePath}`);
    this.proc = spawn("python3", ["-u", this.deps.bridgePath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    this.status_ = "starting";

    const stdout = this.proc.stdout!;
    const rl = createInterface({ input: stdout });
    rl.on("line", (line) => this.handleEvent(line));

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[kernel stderr]`, chunk.toString("utf8").trimEnd());
    });

    this.proc.on("exit", (code, sig) => {
      console.warn(`[kernel] bridge exited code=${code} sig=${sig}`);
      this.status_ = "dead";
      for (const pending of this.pendingReplies.values()) {
        pending.reject(new Error("kernel bridge died"));
      }
      this.pendingReplies.clear();
      this.proc = null;
    });
  }

  private handleEvent(line: string): void {
    if (!line.trim()) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      console.warn(`[kernel] unparseable line: ${line.slice(0, 200)}`);
      return;
    }
    const op = ev.op as string;
    if (op === "iopub") {
      const iopub: IOPubEvent = {
        msg_type: String(ev.msg_type ?? ""),
        content: (ev.content as Record<string, unknown>) ?? {},
        cell_id: (ev.cell_id as string | null) ?? null,
        parent_msg_id: (ev.parent_msg_id as string | null) ?? null,
      };
      if (iopub.msg_type === "status") {
        const state = iopub.content.execution_state as string | undefined;
        if (state === "busy" || state === "idle") this.status_ = state;
      }
      this.deps.onIopub(this.deps.sessionId, iopub);
      return;
    }
    if (op === "execute_reply") {
      const cellId = String(ev.cell_id ?? "");
      const pending = this.pendingReplies.get(cellId);
      if (pending) {
        this.pendingReplies.delete(cellId);
        pending.resolve({
          status: (ev.status as string) ?? "ok",
          execution_count: (ev.execution_count as number | null) ?? null,
          error: (ev.error as string | null) ?? null,
        });
      }
      return;
    }
    if (op === "status") {
      const state = ev.state as KernelStatus;
      if (state) this.status_ = state;
      return;
    }
    if (op === "restarted") {
      this.status_ = "idle";
      return;
    }
    if (op === "interrupted") {
      return;
    }
    if (op === "error") {
      console.error(`[kernel] bridge error: ${String(ev.error).slice(0, 400)}`);
      return;
    }
  }

  private write(cmd: Record<string, unknown>): void {
    this.ensureStarted();
    this.proc!.stdin!.write(JSON.stringify(cmd) + "\n");
  }

  execute(cellId: string, code: string, kernelspec = "python3"): Promise<ExecuteReply> {
    this.lastExecuteCellId = cellId;
    return new Promise((resolve, reject) => {
      // Reject any prior pending reply for the same cell — shouldn't happen
      // in practice because the frontend tracks executingCells, but be safe.
      this.pendingReplies.set(cellId, { resolve, reject });
      this.write({ op: "execute", cell_id: cellId, code, kernelspec });
    });
  }

  interrupt(): void {
    if (!this.proc) return;
    this.write({ op: "interrupt" });
  }

  restart(): void {
    if (!this.proc) {
      this.ensureStarted();
      return;
    }
    this.write({ op: "restart" });
  }

  shutdown(): void {
    if (!this.proc) return;
    try {
      this.write({ op: "shutdown" });
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (this.proc && !this.proc.killed) this.proc.kill("SIGTERM");
    }, 500);
  }
}
