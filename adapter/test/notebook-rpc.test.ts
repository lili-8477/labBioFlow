import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotebookManager } from "../src/notebook-rpc.js";

describe("NotebookManager", () => {
  let root: string;
  let nm: NotebookManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bioflow-nb-"));
    nm = new NotebookManager(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("read_notebook normalizes source array into a single string", async () => {
    const raw = {
      cells: [
        { cell_type: "code", source: ["print(", "'hi')"], id: "abc", outputs: [], execution_count: 3, metadata: {} },
        { cell_type: "markdown", source: "# Title", id: "def", metadata: {} },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    await fs.writeFile(path.join(root, "n.ipynb"), JSON.stringify(raw), "utf8");
    const res = (await nm.readNotebook("n.ipynb")) as {
      success: boolean;
      cell_count: number;
      notebook: { cells: Array<{ source: string; cell_type: string; id: string }> };
    };
    expect(res.success).toBe(true);
    expect(res.cell_count).toBe(2);
    expect(res.notebook.cells[0]!.source).toBe("print('hi')");
    expect(res.notebook.cells[1]!.cell_type).toBe("markdown");
  });

  it("create_notebook writes a blank Python notebook", async () => {
    const res = (await nm.createNotebook("new.ipynb", "python")) as {
      success: boolean;
      notebook: { metadata: { kernelspec: { name: string } }; cells: unknown[] };
    };
    expect(res.success).toBe(true);
    expect(res.notebook.cells).toEqual([]);
    expect(res.notebook.metadata.kernelspec.name).toBe("python3");
    const back = await fs.readFile(path.join(root, "new.ipynb"), "utf8");
    expect(JSON.parse(back).nbformat).toBe(4);
  });

  it("add_cell + update_cell + delete_cell + move_cell round-trip", async () => {
    await nm.createNotebook("x.ipynb", "python");
    const a = (await nm.addCell("x.ipynb", "code", "1+1", undefined)) as { cell_id: string };
    const b = (await nm.addCell("x.ipynb", "code", "2+2", a.cell_id)) as { cell_id: string };
    await nm.updateCell("x.ipynb", a.cell_id, "print(1+1)");
    await nm.moveCell("x.ipynb", b.cell_id, undefined); // move b to top
    const after = (await nm.readNotebook("x.ipynb")) as {
      notebook: { cells: Array<{ id: string; source: string }> };
    };
    expect(after.notebook.cells.map((c) => c.id)).toEqual([b.cell_id, a.cell_id]);
    expect(after.notebook.cells[1]!.source).toBe("print(1+1)");
    await nm.deleteCell("x.ipynb", a.cell_id);
    const after2 = (await nm.readNotebook("x.ipynb")) as {
      notebook: { cells: Array<{ id: string }> };
    };
    expect(after2.notebook.cells.map((c) => c.id)).toEqual([b.cell_id]);
  });

  it("manage_kernel returns a dead kernel stub for status", async () => {
    const res = (await nm.manageKernel("status")) as { success: boolean; status: string };
    expect(res.success).toBe(true);
    expect(res.status).toBe("dead");
  });

  it("execute_cell returns a structured 'no kernel' error when no kernel configured", async () => {
    await nm.createNotebook("x.ipynb", "python");
    const a = (await nm.addCell("x.ipynb", "code", "1+1", undefined)) as { cell_id: string };
    const res = (await nm.executeCell("x.ipynb", a.cell_id)) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/kernel bridge not configured/i);
  });

  it("rejects paths that escape the workspace root", async () => {
    await expect(nm.readNotebook("../etc/passwd")).rejects.toThrow();
  });
});
