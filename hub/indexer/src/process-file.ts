import { promises as fs } from "node:fs";
import type { Pool } from "pg";
import { commitPass, readOffset } from "./db.js";
import { parseJsonlBuffer } from "./jsonl-parser.js";
import { resolveJsonlPath } from "./path-decode.js";
import { projectEntries } from "./session-projector.js";

export interface ProcessFileOptions {
  pool: Pool;
  watchRoot: string;
  fullPath: string;
  maxPassBytes: number;
}

/**
 * One pass over a JSONL file: read from the stored offset to current EOF,
 * project entries, commit (session upserts + token rows + new offset) in a
 * single transaction. If new bytes exceed maxPassBytes we chunk the read at
 * newline boundaries and commit per chunk.
 */
export async function processFile(opts: ProcessFileOptions): Promise<void> {
  const { pool, watchRoot, fullPath, maxPassBytes } = opts;

  const resolved = resolveJsonlPath(watchRoot, fullPath);
  if (!resolved) return;
  const { username, encodedProjectDir, sessionId, displayProjectPath } = resolved;

  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }

  const prior = await readOffset(pool, username, fullPath);
  const inode = Number(stat.ino);
  let startOffset = 0;
  if (prior) {
    const sameInode = prior.inode === null || prior.inode === inode;
    const notShrunk = Number(stat.size) >= prior.byteOffset;
    if (sameInode && notShrunk) startOffset = prior.byteOffset;
  }

  const endOffset = Number(stat.size);
  if (endOffset <= startOffset) return;

  let chunkStart = startOffset;
  while (chunkStart < endOffset) {
    const chunkEnd = Math.min(chunkStart + maxPassBytes, endOffset);
    const { committedEnd, buf } = await readChunk(fullPath, chunkStart, chunkEnd, endOffset);
    if (buf === "") break;

    const entries = parseJsonlBuffer(buf);
    const projection = projectEntries(entries, {
      fileSessionId: sessionId,
      username,
      encodedProjectDir,
      displayProjectPath,
    });

    await commitPass(pool, {
      sessionUpserts: projection.sessionUpserts,
      tokenRows: projection.tokenRows,
      offset: { username, jsonlPath: fullPath, byteOffset: committedEnd, inode },
    });

    if (committedEnd <= chunkStart) break; // no complete lines in this slice
    chunkStart = committedEnd;
  }
}

/**
 * Read [start, hardEnd) from the file, but back up to the last newline we can
 * find so we never commit a partial line. If this is the final chunk
 * (hardEnd === fileSize), we still require a trailing newline.
 */
async function readChunk(
  fullPath: string,
  start: number,
  hardEnd: number,
  _fileSize: number,
): Promise<{ committedEnd: number; buf: string }> {
  const fh = await fs.open(fullPath, "r");
  try {
    const len = hardEnd - start;
    const buffer = Buffer.alloc(len);
    await fh.read(buffer, 0, len, start);
    const text = buffer.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl === -1) return { committedEnd: start, buf: "" };
    // Everything up to and including the last newline is safe to parse.
    const safe = text.slice(0, lastNl + 1);
    return { committedEnd: start + Buffer.byteLength(safe, "utf8"), buf: safe };
  } finally {
    await fh.close();
  }
}
