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
  // A "reset" is any pass where the stored offset can't be trusted — inode
  // changed (rotation) or the file shrank (truncation). The first chunk of
  // such a pass must DELETE existing session aggregates so the replay
  // doesn't double-count against stale values.
  let isResetPass = false;
  if (prior) {
    const sameInode = prior.inode === null || prior.inode === inode;
    const notShrunk = Number(stat.size) >= prior.byteOffset;
    if (sameInode && notShrunk) {
      startOffset = prior.byteOffset;
    } else {
      isResetPass = true;
    }
  }

  const endOffset = Number(stat.size);
  if (endOffset <= startOffset) return;

  let chunkStart = startOffset;
  while (chunkStart < endOffset) {
    const chunkEnd = Math.min(chunkStart + maxPassBytes, endOffset);
    const { committedEnd, buf } = await readChunk(fullPath, chunkStart, chunkEnd, endOffset);

    if (buf === "") {
      if (committedEnd > chunkStart) {
        // Oversized-line skip path: no parseable content, but readChunk
        // scanned forward past the offending line and found a newline later
        // in the file. Advance the offset past it and keep going.
        await commitPass(pool, {
          sessionUpserts: [],
          tokenRows: [],
          offset: { username, jsonlPath: fullPath, byteOffset: committedEnd, inode },
          resetSessionIds: [],
        });
        isResetPass = false;
        chunkStart = committedEnd;
        continue;
      }
      // Genuine no-progress: partial in-progress line at EOF. Try again
      // on the next event.
      break;
    }

    const entries = parseJsonlBuffer(buf);
    const projection = projectEntries(entries, {
      fileSessionId: sessionId,
      username,
      encodedProjectDir,
      displayProjectPath,
    });

    // Only the FIRST chunk of a reset pass clears stale aggregates. Later
    // chunks within the same pass are appending fresh content on top of rows
    // this very transaction chain has already written.
    const resetSessionIds = isResetPass
      ? projection.sessionUpserts.map((s) => s.session_id)
      : [];

    await commitPass(pool, {
      sessionUpserts: projection.sessionUpserts,
      tokenRows: projection.tokenRows,
      offset: { username, jsonlPath: fullPath, byteOffset: committedEnd, inode },
      resetSessionIds,
    });

    isResetPass = false;

    if (committedEnd <= chunkStart) break; // no complete lines in this slice
    chunkStart = committedEnd;
  }
}

const SKIP_SCAN_WINDOW = 1024 * 1024; // 1 MiB forward-scan for oversized-line skip

/**
 * Read [start, hardEnd) from the file, backing up to the last newline so we
 * never commit a partial line.
 *
 * Special case: if the slice has no newline at all and there are more bytes
 * past hardEnd, scan forward in 1 MiB windows for the next newline so we can
 * skip past a single oversized line that exceeds maxPassBytes. The return in
 * that case is `{committedEnd: skipEnd, buf: ""}` — the caller commits an
 * empty pass at `skipEnd` and continues. Without this, a line larger than
 * maxPassBytes would wedge the file forever.
 *
 * If no newline is found anywhere before EOF, treat as a partial in-progress
 * write: return `{committedEnd: start, buf: ""}` so the caller breaks and
 * tries again on the next event.
 */
async function readChunk(
  fullPath: string,
  start: number,
  hardEnd: number,
  fileSize: number,
): Promise<{ committedEnd: number; buf: string }> {
  const fh = await fs.open(fullPath, "r");
  try {
    const len = hardEnd - start;
    const buffer = Buffer.alloc(len);
    await fh.read(buffer, 0, len, start);
    const text = buffer.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl !== -1) {
      const safe = text.slice(0, lastNl + 1);
      return { committedEnd: start + Buffer.byteLength(safe, "utf8"), buf: safe };
    }
    // No newline in the requested window.
    if (hardEnd >= fileSize) {
      // At EOF: partial in-progress line. Don't advance — wait for more bytes.
      return { committedEnd: start, buf: "" };
    }
    // Bytes past our window exist: scan forward for the next newline so we
    // can skip past this oversized line without wedging.
    let scanPos = hardEnd;
    while (scanPos < fileSize) {
      const winEnd = Math.min(scanPos + SKIP_SCAN_WINDOW, fileSize);
      const winLen = winEnd - scanPos;
      const winBuf = Buffer.alloc(winLen);
      await fh.read(winBuf, 0, winLen, scanPos);
      const nlIdx = winBuf.indexOf(0x0a);
      if (nlIdx !== -1) {
        const skipEnd = scanPos + nlIdx + 1;
        return { committedEnd: skipEnd, buf: "" };
      }
      scanPos = winEnd;
    }
    // No newline all the way to EOF — still partial in-progress.
    return { committedEnd: start, buf: "" };
  } finally {
    await fh.close();
  }
}
