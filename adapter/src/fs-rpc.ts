// file_manager.* RPCs — implement directly on the local filesystem.
// Scoped to the workspace root so a misbehaving frontend can't escape.

import { promises as fs } from "node:fs";
import * as path from "node:path";

// Extensions that are always binary. Everything else is read as UTF-8 text;
// if that decode produces replacement chars, we fall back to base64.
const BINARY_EXTS = new Set([
  // images
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "ico", "heic", "avif",
  // documents
  "pdf", "docx", "xlsx", "pptx", "odt", "ods", "odp",
  // archives
  "zip", "tar", "gz", "bz2", "xz", "7z", "rar",
  // media
  "mp4", "mov", "webm", "mkv", "avi", "mp3", "wav", "ogg", "flac", "m4a",
  // sci-data
  "h5", "hdf5", "h5ad", "rds", "feather", "arrow", "parquet", "npy", "npz", "pkl", "pickle", "mtx", "10x", "loom",
  // compiled
  "so", "dylib", "dll", "exe", "class", "jar",
  // fonts
  "ttf", "otf", "woff", "woff2", "eot",
]);

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
  ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff",
  heic: "image/heic", avif: "image/avif",
  pdf: "application/pdf",
  json: "application/json", xml: "application/xml",
  csv: "text/csv", tsv: "text/tab-separated-values",
  html: "text/html", css: "text/css", txt: "text/plain",
  md: "text/markdown", log: "text/plain",
  py: "text/x-python", js: "application/javascript", ts: "application/typescript",
  sh: "application/x-sh", yaml: "application/yaml", yml: "application/yaml",
  r: "text/x-r", ipynb: "application/x-ipynb+json",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  zip: "application/zip", gz: "application/gzip",
};

function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] || "application/octet-stream";
}

export class FileManager {
  constructor(private root: string) {}

  private resolve(relPath: string): string {
    const normalized = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
    const abs = path.resolve(this.root, normalized);
    if (!abs.startsWith(this.root)) throw new Error("path escapes workspace");
    return abs;
  }

  async listFiles(relPath = ""): Promise<unknown> {
    const abs = this.resolve(relPath);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (e.name.startsWith(".executor") || e.name === ".git") continue;
      const entryPath = path.join(relPath, e.name);
      const full = path.join(abs, e.name);
      try {
        const st = await fs.stat(full);
        out.push({
          name: e.name,
          path: entryPath,
          type: e.isDirectory() ? "directory" : "file",
          size: e.isDirectory() ? undefined : st.size,
          modified: Math.floor(st.mtimeMs / 1000),
        });
      } catch {
        // skip unreadable
      }
    }
    return { success: true, files: out };
  }

  async readFile(relPath: string, opts: { encoding?: "utf8" | "base64" } = {}): Promise<unknown> {
    const abs = this.resolve(relPath);
    const ext = (relPath.split(".").pop() ?? "").toLowerCase();
    const mime = mimeForExt(ext);
    const wantBase64 = opts.encoding === "base64" || BINARY_EXTS.has(ext);

    if (wantBase64) {
      const buf = await fs.readFile(abs);
      return {
        success: true,
        content: buf.toString("base64"),
        encoding: "base64",
        mime_type: mime,
        size: buf.length,
      };
    }

    // Try UTF-8; fall back to base64 if the decode produces replacement chars
    // (i.e. the file is actually binary with an unknown extension).
    const buf = await fs.readFile(abs);
    const text = buf.toString("utf8");
    if (text.includes("\uFFFD")) {
      return {
        success: true,
        content: buf.toString("base64"),
        encoding: "base64",
        mime_type: "application/octet-stream",
        size: buf.length,
      };
    }
    return { success: true, content: text, encoding: "utf8", mime_type: mime, size: buf.length };
  }

  async writeFile(
    relPath: string,
    content: string,
    opts: { encoding?: "utf8" | "base64" } = {},
  ): Promise<unknown> {
    const abs = this.resolve(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (opts.encoding === "base64") {
      await fs.writeFile(abs, Buffer.from(content, "base64"));
    } else {
      await fs.writeFile(abs, content, "utf8");
    }
    return { success: true };
  }

  async deleteFile(relPath: string): Promise<unknown> {
    const abs = this.resolve(relPath);
    const st = await fs.stat(abs);
    if (st.isDirectory()) await fs.rm(abs, { recursive: true, force: true });
    else await fs.unlink(abs);
    return { success: true };
  }

  /** manage_path: create_dir | delete — used by the frontend's file CRUD. */
  async managePath(op: string, relPath: string, recursive = true): Promise<unknown> {
    const abs = this.resolve(relPath);
    if (op === "create_dir") {
      await fs.mkdir(abs, { recursive: true });
      return { success: true };
    }
    if (op === "delete") {
      try {
        const st = await fs.stat(abs);
        if (st.isDirectory()) await fs.rm(abs, { recursive, force: true });
        else await fs.unlink(abs);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      return { success: true };
    }
    throw new Error(`manage_path: unknown operation ${op}`);
  }

  async dispatch(method: string, args: Record<string, unknown>): Promise<unknown> {
    // The frontend uses different arg names across methods:
    //   list_files:   sub_dir
    //   read/write:   file_path
    //   manage_path:  path
    // Accept all three keys so we're forgiving.
    const rel =
      (args.file_path as string) ??
      (args.sub_dir as string) ??
      (args.path as string) ??
      "";
    const encoding = args.encoding as "utf8" | "base64" | undefined;
    switch (method) {
      case "list_files":
        return this.listFiles(rel);
      case "read_file":
        return this.readFile(rel, { encoding });
      case "write_file":
        return this.writeFile(rel, (args.content as string) ?? "", { encoding });
      case "delete_file":
        return this.deleteFile(rel);
      case "manage_path":
        return this.managePath(
          (args.operation as string) ?? "delete",
          rel,
          (args.recursive as boolean) ?? true,
        );
      default:
        throw new Error(`file_manager: unknown method ${method}`);
    }
  }
}
