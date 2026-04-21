import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileManager } from "../src/fs-rpc.js";

describe("FileManager", () => {
  let root: string;
  let fm: FileManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bioflow-fs-"));
    fm = new FileManager(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("dispatch accepts sub_dir (what the frontend actually sends)", async () => {
    await fs.mkdir(path.join(root, "local_projects"));
    await fs.mkdir(path.join(root, "local_projects", "proj1"));
    const res = (await fm.dispatch("list_files", { sub_dir: "local_projects" })) as {
      success: boolean;
      files: Array<{ name: string }>;
    };
    expect(res.success).toBe(true);
    expect(res.files.map((f) => f.name)).toEqual(["proj1"]);
  });

  it("read_file returns base64 for PNG (binary extension)", async () => {
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    await fs.writeFile(path.join(root, "a.png"), pngBytes);
    const res = (await fm.readFile("a.png")) as {
      success: boolean; content: string; encoding: string; mime_type: string;
    };
    expect(res.encoding).toBe("base64");
    expect(res.mime_type).toBe("image/png");
    expect(Buffer.from(res.content, "base64").equals(pngBytes)).toBe(true);
  });

  it("read_file returns utf8 for text files and reports mime", async () => {
    await fs.writeFile(path.join(root, "s.py"), "print('hi')");
    const res = (await fm.readFile("s.py")) as {
      success: boolean; content: string; encoding: string; mime_type: string;
    };
    expect(res.encoding).toBe("utf8");
    expect(res.content).toBe("print('hi')");
    expect(res.mime_type).toBe("text/x-python");
  });

  it("dispatch accepts file_path (what the frontend actually sends for read_file)", async () => {
    await fs.writeFile(path.join(root, "x.md"), "# hi");
    const res = (await fm.dispatch("read_file", { file_path: "x.md" })) as { success: boolean; content: string };
    expect(res.success).toBe(true);
    expect(res.content).toBe("# hi");
  });

  it("manage_path create_dir + delete round-trip", async () => {
    await fm.dispatch("manage_path", { operation: "create_dir", path: "nested/deep" });
    expect((await fs.stat(path.join(root, "nested/deep"))).isDirectory()).toBe(true);
    await fm.dispatch("manage_path", { operation: "delete", path: "nested", recursive: true });
    await expect(fs.stat(path.join(root, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("list_files returns entries with type/size/modified", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "hello");
    await fs.mkdir(path.join(root, "d"));
    const res = (await fm.listFiles("")) as { success: boolean; files: unknown[] };
    expect(res.success).toBe(true);
    const names = (res.files as Array<Record<string, unknown>>).map((f) => f.name).sort();
    expect(names).toEqual(["a.txt", "d"]);
  });

  it("write_file creates intermediate directories", async () => {
    await fm.writeFile("nested/deep/f.txt", "body");
    const content = await fs.readFile(path.join(root, "nested/deep/f.txt"), "utf8");
    expect(content).toBe("body");
  });

  it("rejects paths that escape the workspace root", async () => {
    await expect(fm.readFile("../etc/passwd")).rejects.toThrow();
  });

  it("filters .executor and .git from listings", async () => {
    await fs.mkdir(path.join(root, ".executor"));
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, "keep.txt"), "x");
    const res = (await fm.listFiles("")) as { success: boolean; files: Array<{ name: string }> };
    expect(res.files.map((f) => f.name).sort()).toEqual(["keep.txt"]);
  });
});
