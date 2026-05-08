import { describe, it, expect, beforeEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  safeJoin,
  walkSkillFiles,
  readSkillManifest,
  packSkillTarball,
  extractSkillTarball,
  extractSingleFile,
} from "../src/share-fs.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "share-fs-"));
});

describe("safeJoin", () => {
  it("accepts a child name", () => {
    const r = safeJoin(root, "foo");
    expect(r).toBe(path.resolve(root, "foo"));
  });
  it("rejects ../ traversal", () => {
    expect(safeJoin(root, "../etc")).toBeNull();
  });
  it("rejects absolute paths", () => {
    expect(safeJoin(root, "/etc/passwd")).toBeNull();
  });
  it("rejects empty ref", () => {
    expect(safeJoin(root, "")).toBeNull();
  });
  it("rejects null bytes", () => {
    expect(safeJoin(root, "foo\0bar")).toBeNull();
  });
  it("rejects ref equal to root", () => {
    expect(safeJoin(root, ".")).toBeNull();
  });
});

describe("walkSkillFiles", () => {
  it("returns sorted file entries with sha256 + size", async () => {
    const skill = path.join(root, "single-cell");
    await mkdir(path.join(skill, "scripts"), { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "# skill\n");
    await writeFile(path.join(skill, "scripts", "qc.py"), "print(1)\n");
    const r = await walkSkillFiles(skill);
    expect(r.map(f => f.path)).toEqual(["SKILL.md", "scripts/qc.py"]);
    expect(r[0].size_bytes).toBe(8);
    expect(r[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("ignores .git and node_modules", async () => {
    const skill = path.join(root, "s");
    await mkdir(path.join(skill, ".git"), { recursive: true });
    await mkdir(path.join(skill, "node_modules"), { recursive: true });
    await writeFile(path.join(skill, ".git", "HEAD"), "ref: x\n");
    await writeFile(path.join(skill, "node_modules", "foo.js"), "x");
    await writeFile(path.join(skill, "SKILL.md"), "# x");
    const r = await walkSkillFiles(skill);
    expect(r.map(f => f.path)).toEqual(["SKILL.md"]);
  });
});

describe("readSkillManifest", () => {
  it("returns the file body when SKILL.md exists", async () => {
    const skill = path.join(root, "s");
    await mkdir(skill);
    await writeFile(path.join(skill, "SKILL.md"), "hi");
    expect(await readSkillManifest(skill)).toBe("hi");
  });
  it("returns null when SKILL.md is absent", async () => {
    const skill = path.join(root, "s");
    await mkdir(skill);
    expect(await readSkillManifest(skill)).toBeNull();
  });
});

describe("pack/extract round-trip", () => {
  it("packs a skill into a tarball that extracts back to the same files", async () => {
    const skill = path.join(root, "single-cell");
    await mkdir(path.join(skill, "scripts"), { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "manifest body\n");
    await writeFile(path.join(skill, "scripts", "qc.py"), "print(1)\n");
    const tarPath = path.join(root, "snap.tar.gz");
    await packSkillTarball({ skillDir: skill, destTar: tarPath });

    const dest = path.join(root, "out");
    const written = await extractSkillTarball({ srcTar: tarPath, destParent: dest });
    expect(written).toEqual(expect.arrayContaining(["single-cell/SKILL.md", "single-cell/scripts/qc.py"]));
    const r = await walkSkillFiles(path.join(dest, "single-cell"));
    expect(r.map(f => f.path)).toEqual(["SKILL.md", "scripts/qc.py"]);
  });
});

describe("extractSingleFile", () => {
  it("returns the bytes for a known entry", async () => {
    const skill = path.join(root, "s");
    await mkdir(skill);
    await writeFile(path.join(skill, "SKILL.md"), "abc\n");
    const tarPath = path.join(root, "snap.tar.gz");
    await packSkillTarball({ skillDir: skill, destTar: tarPath });

    const buf = await extractSingleFile({ srcTar: tarPath, path: "s/SKILL.md" });
    expect(buf?.toString("utf8")).toBe("abc\n");

    const buf2 = await extractSingleFile({ srcTar: tarPath, path: "SKILL.md" });
    expect(buf2?.toString("utf8")).toBe("abc\n");
  });
  it("returns null for a missing entry", async () => {
    const skill = path.join(root, "s");
    await mkdir(skill);
    await writeFile(path.join(skill, "SKILL.md"), "x");
    const tarPath = path.join(root, "snap.tar.gz");
    await packSkillTarball({ skillDir: skill, destTar: tarPath });
    expect(await extractSingleFile({ srcTar: tarPath, path: "missing.txt" })).toBeNull();
  });
});
