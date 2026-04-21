// notebook.* RPCs — file operations on .ipynb JSON plus a Jupyter kernel
// for execute_cell. The kernel runs as a Python child process; IOPub
// messages are republished to NATS so the frontend can stream live output.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { KernelBridge, IOPubEvent } from "./kernel.js";

interface NotebookCell {
  id: string;
  cell_type: "code" | "markdown" | "raw";
  source: string;
  outputs: unknown[];
  execution_count: number | null;
  metadata: Record<string, unknown>;
}

interface NotebookFile {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

/** Normalize a cell from the on-disk .ipynb shape into our strict shape. */
function normalizeCell(raw: Record<string, unknown>): NotebookCell {
  const rawSource = raw.source;
  const source = Array.isArray(rawSource) ? rawSource.join("") : String(rawSource ?? "");
  const cellType = (raw.cell_type as string) === "markdown"
    ? "markdown"
    : (raw.cell_type as string) === "raw"
      ? "raw"
      : "code";
  const cell: NotebookCell = {
    id: (raw.id as string) ?? randomUUID(),
    cell_type: cellType,
    source,
    outputs: (raw.outputs as unknown[]) ?? [],
    execution_count: cellType === "code" ? ((raw.execution_count as number | null) ?? null) : null,
    metadata: (raw.metadata as Record<string, unknown>) ?? {},
  };
  return cell;
}

function normalizeNotebook(raw: Record<string, unknown>): NotebookFile {
  const cells = (raw.cells as Array<Record<string, unknown>>) ?? [];
  return {
    cells: cells.map(normalizeCell),
    metadata: (raw.metadata as Record<string, unknown>) ?? {},
    nbformat: (raw.nbformat as number) ?? 4,
    nbformat_minor: (raw.nbformat_minor as number) ?? 5,
  };
}

function blankNotebook(language: string): NotebookFile {
  const kernelspec =
    language === "r"
      ? { display_name: "R", language: "R", name: "ir" }
      : { display_name: "Python 3", language: "python", name: "python3" };
  return {
    cells: [],
    metadata: { kernelspec, language_info: { name: kernelspec.language } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

export class NotebookManager {
  /** Kernel is optional — the simple (file-only) build passes undefined. */
  constructor(private root: string, private kernel?: KernelBridge) {}

  /** Bump version each in-memory mutation so the frontend can detect staleness. */
  private versions = new Map<string, number>();

  private resolve(relPath: string): string {
    const normalized = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
    const abs = path.resolve(this.root, normalized);
    if (!abs.startsWith(this.root)) throw new Error("path escapes workspace");
    return abs;
  }

  private bumpVersion(p: string): number {
    const v = (this.versions.get(p) ?? 0) + 1;
    this.versions.set(p, v);
    return v;
  }

  private async readFile(relPath: string): Promise<NotebookFile> {
    const raw = await fs.readFile(this.resolve(relPath), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`not a valid .ipynb (JSON parse failed): ${relPath}`);
    }
    return normalizeNotebook(parsed as Record<string, unknown>);
  }

  private async writeFile(relPath: string, nb: NotebookFile): Promise<void> {
    const abs = this.resolve(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify(nb, null, 1), "utf8");
  }

  private info(relPath: string, nb: NotebookFile): Record<string, unknown> {
    const base: Record<string, unknown> = {
      success: true,
      file_path: relPath,
      version: this.bumpVersion(relPath),
      cell_count: nb.cells.length,
      notebook: nb,
    };
    if (this.kernel) base.kernel_session_id = this.kernel.sessionId;
    return base;
  }

  /** Infer kernelspec name from notebook metadata, defaulting to python3. */
  private kernelspecOf(nb: NotebookFile): string {
    const ks = (nb.metadata as Record<string, unknown>)?.kernelspec as
      | { name?: string }
      | undefined;
    return ks?.name || "python3";
  }

  async readNotebook(relPath: string): Promise<unknown> {
    const nb = await this.readFile(relPath);
    return this.info(relPath, nb);
  }

  async createNotebook(relPath: string, language: string): Promise<unknown> {
    const abs = this.resolve(relPath);
    try {
      await fs.access(abs);
      throw new Error(`notebook already exists: ${relPath}`);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        if ((e as Error).message.startsWith("notebook already exists")) throw e;
      }
    }
    const nb = blankNotebook(language);
    await this.writeFile(relPath, nb);
    return this.info(relPath, nb);
  }

  async addCell(
    relPath: string,
    cellType: string,
    source: string,
    afterCellId: string | undefined,
  ): Promise<unknown> {
    const nb = await this.readFile(relPath);
    const newCell = normalizeCell({ cell_type: cellType, source, outputs: [] });
    if (!afterCellId) {
      nb.cells.push(newCell);
    } else {
      const idx = nb.cells.findIndex((c) => c.id === afterCellId);
      if (idx < 0) nb.cells.push(newCell);
      else nb.cells.splice(idx + 1, 0, newCell);
    }
    await this.writeFile(relPath, nb);
    return { ...this.info(relPath, nb), cell_id: newCell.id };
  }

  async updateCell(relPath: string, cellId: string, source: string): Promise<unknown> {
    const nb = await this.readFile(relPath);
    const cell = nb.cells.find((c) => c.id === cellId);
    if (!cell) throw new Error(`cell not found: ${cellId}`);
    cell.source = source;
    await this.writeFile(relPath, nb);
    return this.info(relPath, nb);
  }

  async deleteCell(relPath: string, cellId: string): Promise<unknown> {
    const nb = await this.readFile(relPath);
    nb.cells = nb.cells.filter((c) => c.id !== cellId);
    await this.writeFile(relPath, nb);
    return this.info(relPath, nb);
  }

  async moveCell(
    relPath: string,
    cellId: string,
    belowCellId: string | undefined,
  ): Promise<unknown> {
    const nb = await this.readFile(relPath);
    const idx = nb.cells.findIndex((c) => c.id === cellId);
    if (idx < 0) throw new Error(`cell not found: ${cellId}`);
    const [cell] = nb.cells.splice(idx, 1);
    if (!cell) throw new Error(`cell splice failed: ${cellId}`);
    if (!belowCellId) {
      nb.cells.unshift(cell);
    } else {
      const below = nb.cells.findIndex((c) => c.id === belowCellId);
      nb.cells.splice(below + 1, 0, cell);
    }
    await this.writeFile(relPath, nb);
    return this.info(relPath, nb);
  }

  async executeCell(relPath: string, cellId: string): Promise<unknown> {
    if (!this.kernel) {
      return {
        success: false,
        error: "execute_cell not supported: kernel bridge not configured",
      };
    }
    const nb = await this.readFile(relPath);
    const cell = nb.cells.find((c) => c.id === cellId);
    if (!cell) throw new Error(`cell not found: ${cellId}`);
    if (cell.cell_type !== "code") {
      return { success: true, execution_count: null, kernel_session_id: this.kernel.sessionId };
    }
    const kernelspec = this.kernelspecOf(nb);
    const reply = await this.kernel.execute(cellId, cell.source, kernelspec);
    // Persist execution_count back into the cell so reloads keep it.
    cell.execution_count = reply.execution_count;
    await this.writeFile(relPath, nb);
    return {
      success: reply.status !== "error",
      status: reply.status,
      execution_count: reply.execution_count,
      error: reply.error,
      kernel_session_id: this.kernel.sessionId,
    };
  }

  manageKernel(action: string): unknown {
    if (!this.kernel) {
      if (action === "status")
        return { success: true, status: "dead", kernel_session_id: null };
      if (action === "variables") return { success: true, variables: {} };
      return { success: false, error: "kernel bridge not configured" };
    }
    const sessionId = this.kernel.sessionId;
    if (action === "status") {
      return { success: true, status: this.kernel.status, kernel_session_id: sessionId };
    }
    if (action === "interrupt") {
      this.kernel.interrupt();
      return { success: true, kernel_session_id: sessionId };
    }
    if (action === "restart") {
      this.kernel.restart();
      return { success: true, kernel_session_id: sessionId };
    }
    if (action === "shutdown") {
      this.kernel.shutdown();
      return { success: true, kernel_session_id: sessionId };
    }
    if (action === "variables") {
      // Variables introspection not yet implemented — return empty so the UI
      // shows an empty inspector rather than an error.
      return { success: true, variables: {}, kernel_session_id: sessionId };
    }
    return { success: false, error: `unsupported action: ${action}`, kernel_session_id: sessionId };
  }

  async dispatch(method: string, args: Record<string, unknown>): Promise<unknown> {
    const p = (args.notebook_path as string) ?? "";
    switch (method) {
      case "read_notebook":
        return this.readNotebook(p);
      case "create_notebook":
        return this.createNotebook(p, (args.language as string) ?? "python");
      case "add_cell":
        return this.addCell(
          p,
          (args.cell_type as string) ?? "code",
          (args.source as string) ?? "",
          args.after_cell_id as string | undefined,
        );
      case "update_cell":
        return this.updateCell(p, args.cell_id as string, (args.source as string) ?? "");
      case "delete_cell":
        return this.deleteCell(p, args.cell_id as string);
      case "move_cell":
        return this.moveCell(p, args.cell_id as string, args.below_cell_id as string | undefined);
      case "execute_cell":
        return this.executeCell(p, args.cell_id as string);
      case "manage_kernel":
        return this.manageKernel((args.action as string) ?? "status");
      default:
        throw new Error(`notebook: unknown method ${method}`);
    }
  }
}
