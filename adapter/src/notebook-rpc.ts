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
    const abs = this.resolve(relPath);
    const raw = await fs.readFile(abs, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`not a valid .ipynb (JSON parse failed): ${relPath}`);
    }
    const normalized = normalizeNotebook(parsed as Record<string, unknown>);
    // Legacy .ipynb files saved in nbformat <4.5 lack cell ids. normalizeCell
    // fabricates ids on every read — but if we don't persist them, the next
    // read fabricates DIFFERENT ids and any frontend reference to the prior
    // read's id fails with "cell not found". Detect missing-ids and write the
    // upgraded notebook back so ids stabilise across reads.
    const rawCells = ((parsed as Record<string, unknown>).cells as
      Array<Record<string, unknown>>) ?? [];
    const hadMissingIds = rawCells.some((c) => !c.id);
    if (hadMissingIds) {
      normalized.nbformat_minor = Math.max(normalized.nbformat_minor, 5);
      await fs.writeFile(abs, JSON.stringify(normalized, null, 1), "utf8");
    }
    return normalized;
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

  /**
   * Add a cell. `position` follows the Pantheon-frontend contract:
   *   null/undefined            → append at end
   *   cell_id (UUID-like)       → insert AFTER that cell
   *   numeric string "N"        → insert AT index N (pushes cell-N down;
   *                                i.e. new cell becomes the Nth cell —
   *                                the frontend uses this to emulate "before")
   */
  async addCell(
    relPath: string,
    cellType: string,
    source: string,
    position: string | undefined,
  ): Promise<unknown> {
    const nb = await this.readFile(relPath);
    const newCell = normalizeCell({ cell_type: cellType, source, outputs: [] });

    if (!position) {
      nb.cells.push(newCell);
    } else if (/^\d+$/.test(position)) {
      // Numeric index: insert AT this position (new cell becomes cells[N]).
      const idx = Math.min(parseInt(position, 10), nb.cells.length);
      nb.cells.splice(idx, 0, newCell);
    } else {
      // Cell id: insert AFTER that cell.
      const idx = nb.cells.findIndex((c) => c.id === position);
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

  async manageKernel(action: string): Promise<unknown> {
    if (!this.kernel) {
      if (action === "status")
        return { success: true, status: "dead", kernel_status: "dead", kernel_session_id: null };
      if (action === "variables") return { success: true, variables: {} };
      return { success: false, error: "kernel bridge not configured" };
    }
    const sessionId = this.kernel.sessionId;
    if (action === "status") {
      // Emit both field names: `kernel_status` is what the frontend reads;
      // `status` is kept for any older/other consumer.
      return {
        success: true,
        status: this.kernel.status,
        kernel_status: this.kernel.status,
        kernel_session_id: sessionId,
      };
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
      // Run a small introspection snippet in the kernel and parse its
      // stdout (JSON). We pay ~10-50ms per call for a running kernel;
      // fresh kernels need a kernel-start first (~1-2s).
      const code =
        "import json as _j, types as _t\n" +
        "_SKIP = {'In','Out','get_ipython','exit','quit','open'}\n" +
        "_o = {}\n" +
        "for _k, _v in list(globals().items()):\n" +
        "    if _k.startswith('_'): continue\n" +
        "    if _k in _SKIP: continue\n" +
        "    if isinstance(_v, _t.ModuleType): continue\n" +
        "    _tn = type(_v).__name__\n" +
        "    try:\n" +
        "        _r = repr(_v)\n" +
        "        if len(_r) > 200: _r = _r[:200] + '...'\n" +
        "    except Exception:\n" +
        "        _r = '<repr failed>'\n" +
        "    _shape = None\n" +
        "    try:\n" +
        "        _shape = str(tuple(_v.shape)) if hasattr(_v, 'shape') else None\n" +
        "    except Exception:\n" +
        "        pass\n" +
        "    _o[_k] = {'type': _tn, 'repr': _r, 'shape': _shape}\n" +
        "print(_j.dumps(_o))\n";
      try {
        const { stdout } = await this.kernel.executeAndCollect(
          "__vars_introspect__",
          code,
        );
        const variables = JSON.parse(stdout.trim() || "{}");
        return { success: true, variables, kernel_session_id: sessionId };
      } catch (e) {
        return {
          success: true,
          variables: {},
          error: e instanceof Error ? e.message : String(e),
          kernel_session_id: sessionId,
        };
      }
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
      case "add_cell": {
        // Frontend sends Pantheon-legacy names (`content`, `position`); keep
        // `source`/`after_cell_id` as aliases for anything calling the newer
        // API shape directly.
        const source = (args.source as string) ?? (args.content as string) ?? "";
        const position =
          (args.position as string | number | null | undefined) ??
          (args.after_cell_id as string | undefined);
        const positionStr =
          position === null || position === undefined ? undefined : String(position);
        return this.addCell(
          p,
          (args.cell_type as string) ?? "code",
          source,
          positionStr,
        );
      }
      case "update_cell":
        return this.updateCell(
          p,
          args.cell_id as string,
          (args.source as string) ?? (args.content as string) ?? "",
        );
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
