import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { SettledSession } from "./distiller-repo.js";

export function jsonlPath(workspacesRoot: string, s: SettledSession): string {
  return path.resolve(
    workspacesRoot,
    s.username,
    ".claude",
    "claude-projects",
    s.encoded_project_dir,
    `${s.session_id}.jsonl`,
  );
}

export async function readSessionJsonl(workspacesRoot: string, s: SettledSession): Promise<string> {
  return await readFile(jsonlPath(workspacesRoot, s), "utf8");
}
