# File Explorer Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add move, rename, new-in-dir, and directory-upload affordances to the file panel by introducing one backend `move` op plus a row context menu, drag-row-to-folder, and `webkitdirectory` upload on the frontend.

**Architecture:** Backend gets a single new `manage_path { op: "move" }` operation that wraps `fs.rename` with the existing workspace-scope and hidden-name guards, refusing on `target_exists`. Frontend introduces a `FileContextMenu.vue` component (right-click + hover `⋯` button) and a `MoveToModal.vue` directory picker, extends the existing drag-drop handlers in `FileTree.vue` to dispatch by MIME type (OS files vs. internal `application/x-bioflow-path`), and adds a directory-upload toolbar button plus a `webkitGetAsEntry`-based folder drop walker in a new `frontend/src/utils/dnd.ts` helper.

**Tech Stack:** TypeScript, Node.js (`node:fs/promises`), Vue 3 SFC + Pinia, Vitest (adapter unit tests), Playwright (frontend smoke tests).

**Spec:** `docs/superpowers/specs/2026-04-30-file-explorer-improvements-design.md`

**Working directory convention:** all paths in this plan are relative to the `claude-bioflow` repo root (`/home/lili/claude-bioflow`). All `npm`/`vitest` commands run from `adapter/` unless stated otherwise.

---

## File Structure

**Modify:**
- `adapter/src/fs-rpc.ts` — add `move` op to `managePath`, wire `from` / `to` in `dispatch`.
- `adapter/test/fs-rpc.test.ts` — new tests for move (happy path, target-exists, traversal, hidden-name).
- `frontend/src/stores/files.ts` — add `movePath(from, to)` returning a typed result.
- `frontend/src/components/files/FileTree.vue` — context-menu wiring, inline rename, drag-row-to-folder, directory-upload picker, folder drag-drop, error-strip surface.
- `frontend/test-ui.mjs` — extend smoke runner with new flows.

**Create:**
- `frontend/src/components/files/FileContextMenu.vue` — generic positioned menu, fires events.
- `frontend/src/components/files/MoveToModal.vue` — directory-only tree picker.
- `frontend/src/utils/dnd.ts` — `walkDataTransferItems()` that produces `{ file: File, relativePath: string }[]` from a folder drop.

---

## Task 1: Backend `move` op (TDD)

**Files:**
- Modify: `adapter/src/fs-rpc.ts`
- Test: `adapter/test/fs-rpc.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `adapter/test/fs-rpc.test.ts` (inside the existing `describe("FileManager", () => { ... })`):

```typescript
  describe("manage_path move", () => {
    it("renames a file in place", async () => {
      await fs.writeFile(path.join(root, "a.txt"), "hello");
      const res = (await fm.dispatch("manage_path", {
        operation: "move",
        from: "a.txt",
        to: "b.txt",
      })) as { success: boolean };
      expect(res.success).toBe(true);
      expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("hello");
      await expect(fs.stat(path.join(root, "a.txt"))).rejects.toThrow();
    });

    it("moves a file into a sibling directory, creating it if missing", async () => {
      await fs.writeFile(path.join(root, "a.txt"), "x");
      const res = (await fm.dispatch("manage_path", {
        operation: "move",
        from: "a.txt",
        to: "sub/a.txt",
      })) as { success: boolean };
      expect(res.success).toBe(true);
      expect(await fs.readFile(path.join(root, "sub", "a.txt"), "utf8")).toBe("x");
    });

    it("moves a directory recursively", async () => {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "file.py"), "print(1)");
      const res = (await fm.dispatch("manage_path", {
        operation: "move",
        from: "src",
        to: "lib",
      })) as { success: boolean };
      expect(res.success).toBe(true);
      expect(await fs.readFile(path.join(root, "lib", "file.py"), "utf8")).toBe("print(1)");
    });

    it("refuses when target exists", async () => {
      await fs.writeFile(path.join(root, "a.txt"), "1");
      await fs.writeFile(path.join(root, "b.txt"), "2");
      await expect(
        fm.dispatch("manage_path", { operation: "move", from: "a.txt", to: "b.txt" }),
      ).rejects.toThrow(/target_exists/);
      // Source is untouched.
      expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("1");
    });

    it("refuses path traversal in `from`", async () => {
      await expect(
        fm.dispatch("manage_path", { operation: "move", from: "../escape", to: "ok.txt" }),
      ).rejects.toThrow();
    });

    it("refuses path traversal in `to`", async () => {
      await fs.writeFile(path.join(root, "a.txt"), "1");
      await expect(
        fm.dispatch("manage_path", { operation: "move", from: "a.txt", to: "../escape" }),
      ).rejects.toThrow();
    });

    it("refuses moving into a hidden segment", async () => {
      await fs.writeFile(path.join(root, "a.txt"), "1");
      await expect(
        fm.dispatch("manage_path", { operation: "move", from: "a.txt", to: ".env" }),
      ).rejects.toThrow();
    });

    it("refuses moving from a hidden segment", async () => {
      // Even if .env existed, frontend should not be able to move it.
      await fs.writeFile(path.join(root, ".env"), "SECRET=1");
      await expect(
        fm.dispatch("manage_path", { operation: "move", from: ".env", to: "leaked.txt" }),
      ).rejects.toThrow();
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix adapter test -- fs-rpc.test.ts`

Expected: 8 new tests fail (the existing tests still pass). Failures are on the move-related cases.

- [ ] **Step 3: Implement `move` in `managePath`**

In `adapter/src/fs-rpc.ts`, replace the body of `managePath` with:

```typescript
  /** manage_path: create_dir | delete | move — used by the frontend's file CRUD. */
  async managePath(
    op: string,
    relPath: string,
    recursive = true,
    extra: { from?: string; to?: string } = {},
  ): Promise<unknown> {
    if (op === "create_dir") {
      const abs = this.resolve(relPath);
      await fs.mkdir(abs, { recursive: true });
      return { success: true };
    }
    if (op === "delete") {
      const abs = this.resolve(relPath);
      try {
        const st = await fs.stat(abs);
        if (st.isDirectory()) await fs.rm(abs, { recursive, force: true });
        else await fs.unlink(abs);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      return { success: true };
    }
    if (op === "move") {
      const from = extra.from ?? "";
      const to = extra.to ?? "";
      if (!from || !to) throw new Error("manage_path move: missing from/to");

      // Hidden-name guard on every segment of both paths.
      for (const seg of from.split("/").filter(Boolean)) {
        if (isHidden(seg)) throw new Error(`manage_path move: hidden segment in from: ${seg}`);
      }
      for (const seg of to.split("/").filter(Boolean)) {
        if (isHidden(seg)) throw new Error(`manage_path move: hidden segment in to: ${seg}`);
      }

      const absFrom = this.resolve(from);
      const absTo = this.resolve(to);

      // Refuse if target already exists. No overwrite.
      try {
        await fs.stat(absTo);
        throw new Error("manage_path move: target_exists");
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }

      await fs.mkdir(path.dirname(absTo), { recursive: true });
      await fs.rename(absFrom, absTo);
      return { success: true };
    }
    throw new Error(`manage_path: unknown operation ${op}`);
  }
```

- [ ] **Step 4: Wire `from` / `to` into `dispatch`**

In `adapter/src/fs-rpc.ts`, replace the `manage_path` case in `dispatch`:

```typescript
      case "manage_path":
        return this.managePath(
          (args.operation as string) ?? "delete",
          rel,
          (args.recursive as boolean) ?? true,
          {
            from: args.from as string | undefined,
            to: args.to as string | undefined,
          },
        );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm --prefix adapter test -- fs-rpc.test.ts`

Expected: all tests pass (including the 8 new move tests).

- [ ] **Step 6: Typecheck**

Run: `npm --prefix adapter run typecheck`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add adapter/src/fs-rpc.ts adapter/test/fs-rpc.test.ts
git commit -m "feat(adapter): add manage_path move op for file_manager

fs.rename-based move/rename. Refuses on target_exists, hidden segments,
and path traversal. Tested via vitest unit tests."
```

---

## Task 2: Frontend store `movePath` + error surface

**Files:**
- Modify: `frontend/src/stores/files.ts`
- Modify: `frontend/src/components/files/FileTree.vue`

- [ ] **Step 1: Add `movePath` to the files store**

Open `frontend/src/stores/files.ts`. After the `deletePath` function and before `closeFile`, add:

```typescript
  async function movePath(from: string, to: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const res = (await natsService.proxyToolset('manage_path', {
        operation: 'move',
        from,
        to,
      }, 'file_manager')) as { success?: boolean }
      if (res?.success) return { ok: true }
      return { ok: false, error: 'move failed' }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      // Surface the specific reason (target_exists, hidden segment, traversal) verbatim.
      return { ok: false, error: msg }
    }
  }
```

Then add `movePath` to the returned object:

```typescript
  return {
    tree, loading, openFile,
    loadTree, readFile, writeFile, createFile,
    createDirectory, deletePath, movePath, closeFile,
  }
```

- [ ] **Step 2: Add an error strip to `FileTree.vue`**

In `frontend/src/components/files/FileTree.vue`, in the `<script setup>` block near the other refs, add:

```typescript
const treeError = ref<string | null>(null)
let treeErrorTimer: number | null = null

function showTreeError(msg: string) {
  treeError.value = msg
  if (treeErrorTimer !== null) clearTimeout(treeErrorTimer)
  treeErrorTimer = window.setTimeout(() => {
    treeError.value = null
    treeErrorTimer = null
  }, 5000)
}
```

In the `<template>`, between the closing `</div>` of `.tree-content` and the `<div v-if="uploads.items.length > 0" class="upload-tray">`, add:

```vue
    <div v-if="treeError" class="tree-error" role="alert">
      {{ treeError }}
      <button class="link-btn" @click="treeError = null">×</button>
    </div>
```

In the `<style scoped>` block, append:

```css
.tree-error {
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--danger) 12%, var(--bg-secondary));
  color: var(--danger);
  font-size: 0.82em;
  padding: 6px 12px;
  display: flex; align-items: center; justify-content: space-between;
}
```

- [ ] **Step 3: Verify build**

Run: `npm --prefix frontend run typecheck`

Expected: no errors.

- [ ] **Step 4: Manual smoke check**

Start dev server: `npm --prefix frontend run dev`

In a browser session against the running app, open the Files panel and run in DevTools console:

```js
window.dispatchEvent(new CustomEvent('debug-tree-error'))  // expected to do nothing — no listener; this is just a noop
```

(There is no automated way to trigger `showTreeError` until later tasks; the strip is dormant for now. Confirm the panel still renders and uploads still work.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/stores/files.ts frontend/src/components/files/FileTree.vue
git commit -m "feat(frontend): add movePath store action and tree-error strip

Wraps the new manage_path move RPC with a typed result, and adds a
shared transient error surface inside FileTree for upcoming flows
(rename, drag-move, move-to)."
```

---

## Task 3: `FileContextMenu.vue` component + wire to existing actions

**Files:**
- Create: `frontend/src/components/files/FileContextMenu.vue`
- Modify: `frontend/src/components/files/FileTree.vue`

This task delivers user feedback item **#2 (new file in specific directory)** by routing New File / New Folder through the context menu with `<dir>/` pre-filled.

- [ ] **Step 1: Create `FileContextMenu.vue`**

Write `frontend/src/components/files/FileContextMenu.vue`:

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{
  x: number
  y: number
  type: 'file' | 'directory'
}>()

const emit = defineEmits<{
  (e: 'rename'): void
  (e: 'move-to'): void
  (e: 'new-file'): void
  (e: 'new-folder'): void
  (e: 'delete'): void
  (e: 'close'): void
}>()

const root = ref<HTMLElement | null>(null)

function onClickOutside(ev: MouseEvent) {
  if (!root.value) return
  if (!root.value.contains(ev.target as Node)) emit('close')
}
function onKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape') emit('close')
}

onMounted(() => {
  // Use mousedown so the close handler runs before the next click bubbles.
  document.addEventListener('mousedown', onClickOutside, true)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onClickOutside, true)
  document.removeEventListener('keydown', onKey)
})

function pick(action: 'rename' | 'move-to' | 'new-file' | 'new-folder' | 'delete') {
  emit(action)
  emit('close')
}
</script>

<template>
  <div
    ref="root"
    class="ctx-menu"
    :style="{ left: x + 'px', top: y + 'px' }"
    role="menu"
  >
    <button class="ctx-item" role="menuitem" @click="pick('rename')">Rename</button>
    <button class="ctx-item" role="menuitem" @click="pick('move-to')">Move to…</button>
    <div class="ctx-sep" />
    <button class="ctx-item" role="menuitem" @click="pick('new-file')">
      New File{{ props.type === 'directory' ? ' in this folder' : '' }}
    </button>
    <button class="ctx-item" role="menuitem" @click="pick('new-folder')">
      New Folder{{ props.type === 'directory' ? ' in this folder' : '' }}
    </button>
    <div class="ctx-sep" />
    <button class="ctx-item ctx-danger" role="menuitem" @click="pick('delete')">Delete</button>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 1000;
  min-width: 200px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
  padding: 4px 0;
  font-size: 0.88em;
}
.ctx-item {
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  color: var(--text-primary);
  padding: 6px 12px;
  cursor: pointer;
}
.ctx-item:hover { background: var(--bg-tertiary); }
.ctx-danger { color: var(--danger); }
.ctx-sep {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}
</style>
```

- [ ] **Step 2: Wire context menu into `FileTree.vue`**

In `frontend/src/components/files/FileTree.vue`, add to the `<script setup>` imports:

```typescript
import FileContextMenu from './FileContextMenu.vue'
```

Add state:

```typescript
const ctxMenu = ref<{ x: number; y: number; fe: FlatEntry } | null>(null)

function openCtxMenuAt(ev: MouseEvent, fe: FlatEntry) {
  ev.preventDefault()
  ev.stopPropagation()
  ctxMenu.value = { x: ev.clientX, y: ev.clientY, fe }
}
function closeCtxMenu() {
  ctxMenu.value = null
}
```

Add a handler that pre-fills the new-item input scoped to a directory:

```typescript
function startNewItemIn(fe: FlatEntry, kind: 'file' | 'directory') {
  // Determine parent directory: if row is a directory, use its path; otherwise use its parent.
  const parent = fe.entry.type === 'directory'
    ? fe.path
    : (fe.path.includes('/') ? fe.path.slice(0, fe.path.lastIndexOf('/')) : '')
  newItemType.value = kind
  newItemPath.value = parent ? `${parent}/` : ''
  showNewInput.value = true
  // Auto-expand the parent directory so the user sees the new item appear after creation.
  if (parent && fe.entry.type === 'directory' && !expandedDirs.value.has(parent)) {
    toggleDir(parent)
  }
}
```

In the `<template>`, modify the row to add right-click and a hover `⋯` button. Replace the existing `entry-row` block with:

```vue
      <div
        v-for="fe in visibleEntries"
        :key="fe.path"
        class="entry-row"
        :class="{ 'drag-over': dragOverPath === fe.path }"
        :style="{ paddingLeft: (12 + fe.depth * 16) + 'px' }"
        @click="handleClick(fe)"
        @contextmenu="openCtxMenuAt($event, fe)"
        @dragover.stop="onDragOver($event, fe.path)"
        @dragleave.stop="onDragLeave($event, fe.path)"
        @drop.stop="onDrop($event, fe.path)"
      >
        <span v-if="fe.entry.type === 'directory'" class="expand-icon">
          <span v-if="loadingDirs.has(fe.path)" class="spinner"></span>
          <template v-else>{{ expandedDirs.has(fe.path) ? '&#9660;' : '&#9654;' }}</template>
        </span>
        <span v-else class="expand-icon">&nbsp;</span>
        <span class="icon">{{ getFileIcon(fe.entry.name, fe.entry.type) }}</span>
        <span class="name">{{ fe.entry.name }}</span>
        <a
          v-if="fe.entry.type === 'file'"
          class="download-btn"
          :href="downloadUrl(fe.path)"
          :download="fe.entry.name"
          @click.stop
          title="Download (works for any size)"
          aria-label="Download"
        >&#x2B07;</a>
        <button
          class="more-btn"
          @click.stop="openCtxMenuAt($event, fe)"
          title="More actions"
          aria-label="More"
        >&#x22EF;</button>
        <button class="delete-btn" @click.stop="handleDelete(fe)" title="Delete">&times;</button>
      </div>
```

Add the menu render after `</div>` of `.tree-content` (and before the error strip from Task 2):

```vue
    <FileContextMenu
      v-if="ctxMenu"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :type="ctxMenu.fe.entry.type"
      @rename="/* wired in Task 4 */ closeCtxMenu()"
      @move-to="/* wired in Task 6 */ closeCtxMenu()"
      @new-file="(startNewItemIn(ctxMenu.fe, 'file'), closeCtxMenu())"
      @new-folder="(startNewItemIn(ctxMenu.fe, 'directory'), closeCtxMenu())"
      @delete="(handleDelete(ctxMenu.fe), closeCtxMenu())"
      @close="closeCtxMenu"
    />
```

In `<style scoped>`, append:

```css
.more-btn {
  opacity: 0;
  width: 20px; height: 20px;
  background: transparent; border: none;
  color: var(--text-muted); border-radius: 3px;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.9em; cursor: pointer;
}
.entry-row:hover .more-btn { opacity: 1; }
.more-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
```

- [ ] **Step 3: Typecheck**

Run: `npm --prefix frontend run typecheck`

Expected: no errors.

- [ ] **Step 4: Manual verification**

Start dev: `npm --prefix frontend run dev`. In the browser:

1. Right-click a file row — context menu appears at cursor. Click "New File" — the input strip opens with the file's parent directory pre-filled and a trailing `/`. Type `note.md`, hit Enter — file is created in that directory. Verify by expanding the parent.
2. Right-click a directory row — click "New Folder". Input strip pre-fills `<dirname>/`. Type `subdir`, Enter — folder is created inside that directory.
3. Right-click and hit Escape — menu closes.
4. Click outside the menu — menu closes.
5. Click the `⋯` button on a row (visible on hover) — menu opens at the cursor.
6. Click Delete in the menu — confirm dialog appears, file is deleted on confirm.

If any of those don't work, fix before committing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/files/FileContextMenu.vue frontend/src/components/files/FileTree.vue
git commit -m "feat(frontend): file row context menu + new-in-dir UX

Right-click any row (or click the hover '⋯' button) to open a menu
with Rename / Move to… / New File / New Folder / Delete. New File and
New Folder pre-fill the input strip with the row's parent directory,
fixing 'cannot create new file in a specific directory'. Rename and
Move to… are stubbed; wired in later tasks."
```

---

## Task 4: Inline rename

**Files:**
- Modify: `frontend/src/components/files/FileTree.vue`

This task delivers user feedback item **#3 (rename)**.

- [ ] **Step 1: Add inline-rename state + handler**

In `<script setup>`, add:

```typescript
const renamingPath = ref<string | null>(null)
const renameInput = ref('')

function startRename(fe: FlatEntry) {
  renamingPath.value = fe.path
  renameInput.value = fe.entry.name
}

function cancelRename() {
  renamingPath.value = null
  renameInput.value = ''
}

async function commitRename(fe: FlatEntry) {
  const newName = renameInput.value.trim()
  if (!newName || newName === fe.entry.name) {
    cancelRename()
    return
  }
  if (newName.includes('/')) {
    showTreeError('Rename: name cannot contain "/"')
    cancelRename()
    return
  }
  const parent = fe.path.includes('/') ? fe.path.slice(0, fe.path.lastIndexOf('/')) : ''
  const targetPath = parent ? `${parent}/${newName}` : newName

  const result = await files.movePath(fe.path, targetPath)
  if (!result.ok) {
    showTreeError(`Rename failed: ${result.error}`)
    cancelRename()
    return
  }

  // Refresh: clear children cache for parent (or reload tree at root) and
  // collapse — simplest reliable refresh given the existing patterns.
  cancelRename()
  dirChildren.value.clear()
  expandedDirs.value.clear()
  await files.loadTree()
}
```

- [ ] **Step 2: Add the focus helper and replace the row's name span**

Add a focus helper in `<script setup>`:

```typescript
function focusRenameInput(el: Element | null, originalName: string) {
  const input = el as HTMLInputElement | null
  if (!input) return
  input.focus()
  const dot = originalName.lastIndexOf('.')
  input.setSelectionRange(0, dot > 0 ? dot : originalName.length)
}
```

In the `entry-row` template, replace:

```vue
        <span class="name">{{ fe.entry.name }}</span>
```

with:

```vue
        <input
          v-if="renamingPath === fe.path"
          v-model="renameInput"
          class="rename-input"
          :ref="(el) => focusRenameInput(el as Element | null, fe.entry.name)"
          @click.stop
          @keyup.enter="commitRename(fe)"
          @keyup.escape="cancelRename()"
          @blur="commitRename(fe)"
        />
        <span v-else class="name">{{ fe.entry.name }}</span>
```

(Vue 3 function refs require `:ref` — the colon-bound form — so the value is a function expression, not a string ref name.)

- [ ] **Step 3: Wire context menu's Rename event**

Replace the `@rename="/* wired in Task 4 */ closeCtxMenu()"` on `<FileContextMenu>` with:

```vue
      @rename="(startRename(ctxMenu.fe), closeCtxMenu())"
```

- [ ] **Step 4: Add styles**

In `<style scoped>`, append:

```css
.rename-input {
  flex: 1;
  background: var(--bg-primary);
  border: 1px solid var(--accent);
  border-radius: 3px;
  color: var(--text-primary);
  font: inherit;
  padding: 1px 4px;
  outline: none;
}
```

- [ ] **Step 5: Typecheck**

Run: `npm --prefix frontend run typecheck`

Expected: no errors.

- [ ] **Step 6: Manual verification**

In the browser:

1. Right-click `foo.txt`, choose Rename. The name span becomes an input with the basename selected (`foo`).
2. Type `bar`, hit Enter. The file becomes `bar.txt`. Reload to confirm persistence.
3. Right-click `bar.txt`, Rename, change to `existing.txt` where `existing.txt` already exists. The input reverts and a red error strip says `Rename failed: ... target_exists ...`.
4. Right-click, Rename, hit Escape. No change.
5. Right-click, Rename, type a name with `/`. Error strip says `Rename: name cannot contain "/"`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/files/FileTree.vue
git commit -m "feat(frontend): inline rename via context menu

Selecting Rename swaps the row's name span for an input pre-selected
on the basename. Enter commits via manage_path move; Escape or empty
reverts. Errors (target_exists, '/' in name) revert and surface in
the tree-error strip."
```

---

## Task 5: Drag-row-to-folder move

**Files:**
- Modify: `frontend/src/components/files/FileTree.vue`

Partial delivery of user feedback item **#1 (move)** — drag handling. Move-to modal completes it in Task 6.

- [ ] **Step 1: Constants and helpers**

In `<script setup>` near the top, add:

```typescript
const INTERNAL_PATH_MIME = 'application/x-bioflow-path'

function isAncestorOrSelf(maybeAncestor: string, descendant: string): boolean {
  if (maybeAncestor === descendant) return true
  return descendant.startsWith(maybeAncestor + '/')
}
```

- [ ] **Step 2: Add `dragstart` to entry rows + make rows draggable**

In the `entry-row` element in the template, add `draggable="true"` and `@dragstart`:

```vue
      <div
        v-for="fe in visibleEntries"
        :key="fe.path"
        class="entry-row"
        :class="{ 'drag-over': dragOverPath === fe.path }"
        :style="{ paddingLeft: (12 + fe.depth * 16) + 'px' }"
        draggable="true"
        @dragstart="onRowDragStart($event, fe)"
        @click="handleClick(fe)"
        @contextmenu="openCtxMenuAt($event, fe)"
        @dragover.stop="onDragOver($event, fe.path)"
        @dragleave.stop="onDragLeave($event, fe.path)"
        @drop.stop="onDrop($event, fe.path)"
      >
```

Add the handler in `<script setup>`:

```typescript
function onRowDragStart(ev: DragEvent, fe: FlatEntry) {
  if (!ev.dataTransfer) return
  ev.dataTransfer.setData(INTERNAL_PATH_MIME, fe.path)
  ev.dataTransfer.setData('text/plain', fe.path)  // graceful fallback
  ev.dataTransfer.effectAllowed = 'move'
}
```

- [ ] **Step 3: Update `onDragOver` to recognize internal drags**

Replace `onDragOver` with:

```typescript
function onDragOver(e: DragEvent, path: string | null) {
  if (!e.dataTransfer) return
  const types = Array.from(e.dataTransfer.types)
  const hasFiles = types.includes('Files')
  const hasInternal = types.includes(INTERNAL_PATH_MIME)
  if (!hasFiles && !hasInternal) return
  e.preventDefault()
  e.dataTransfer.dropEffect = hasInternal ? 'move' : 'copy'
  isDraggingFiles.value = hasFiles  // pane-highlight only triggers for OS uploads
  dragOverPath.value = path
}
```

- [ ] **Step 4: Update `onDrop` to dispatch by MIME**

Replace `onDrop` with:

```typescript
function onDrop(e: DragEvent, path: string | null) {
  e.preventDefault()
  const dt = e.dataTransfer
  dragOverPath.value = null
  isDraggingFiles.value = false
  if (!dt) return

  const types = Array.from(dt.types)

  // 1) Internal move
  if (types.includes(INTERNAL_PATH_MIME)) {
    const sourcePath = dt.getData(INTERNAL_PATH_MIME)
    if (!sourcePath) return
    if (path === null) return  // drop on empty pane: not a valid move target

    // Resolve drop target directory
    const target = visibleEntries.value.find(fe => fe.path === path)
    if (!target) return
    const targetDir = target.entry.type === 'directory'
      ? target.path
      : (target.path.includes('/') ? target.path.slice(0, target.path.lastIndexOf('/')) : '')

    // Source's current parent
    const sourceParent = sourcePath.includes('/')
      ? sourcePath.slice(0, sourcePath.lastIndexOf('/'))
      : ''

    if (targetDir === sourceParent) return                  // no-op: same parent
    if (isAncestorOrSelf(sourcePath, targetDir)) return     // would move into self

    const basename = sourcePath.split('/').pop() ?? sourcePath
    const newPath = targetDir ? `${targetDir}/${basename}` : basename

    void doMove(sourcePath, newPath)
    return
  }

  // 2) OS-file upload (existing behavior)
  const fileList = dt.files
  if (!fileList || fileList.length === 0) return
  startUploads(fileList, dropDirFor(path))
}

async function doMove(from: string, to: string) {
  const result = await files.movePath(from, to)
  if (!result.ok) {
    showTreeError(`Move failed: ${result.error}`)
    return
  }
  dirChildren.value.clear()
  expandedDirs.value.clear()
  await files.loadTree()
}
```

- [ ] **Step 5: Typecheck**

Run: `npm --prefix frontend run typecheck`

Expected: no errors.

- [ ] **Step 6: Manual verification**

In the browser:

1. Drag `local_projects/foo.txt` onto a folder `local_projects/sub/`. Drop — file moves. Tree refreshes; expanding `sub/` shows `foo.txt`.
2. Drag `foo.txt` onto another file in the same folder. No-op (same parent).
3. Drag a folder onto one of its own descendants. No-op.
4. Drag onto an existing target with the same name. Error strip: `Move failed: ... target_exists ...`.
5. Drag a file from your OS into the panel. Existing upload behavior still works (the dispatch by MIME chose the upload branch).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/files/FileTree.vue
git commit -m "feat(frontend): drag-row-to-folder move

Rows are now draggable. Internal drags carry application/x-bioflow-path;
the existing drop handler dispatches by dataTransfer.types so OS-file
uploads continue to work unchanged. Same-parent and into-self drops
are no-ops; other failures surface in the tree-error strip."
```

---

## Task 6: `MoveToModal.vue` + Move to… wiring

**Files:**
- Create: `frontend/src/components/files/MoveToModal.vue`
- Modify: `frontend/src/components/files/FileTree.vue`

Completes user feedback item **#1 (move)** with a discoverable menu path.

- [ ] **Step 1: Create `MoveToModal.vue`**

Write `frontend/src/components/files/MoveToModal.vue`:

```vue
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { natsService } from '@/services/nats'

const props = defineProps<{
  sourcePath: string
}>()

const emit = defineEmits<{
  (e: 'pick', dir: string): void
  (e: 'close'): void
}>()

interface DirNode {
  name: string
  path: string
  children?: DirNode[]   // undefined = not loaded
  loading?: boolean
}

const root = ref<DirNode[]>([])
const expanded = ref<Set<string>>(new Set())
const selected = ref<string>('')
const error = ref<string | null>(null)

const sourceParent = computed(() =>
  props.sourcePath.includes('/')
    ? props.sourcePath.slice(0, props.sourcePath.lastIndexOf('/'))
    : '',
)

function isAncestorOrSelf(maybeAncestor: string, descendant: string): boolean {
  if (maybeAncestor === descendant) return true
  return descendant.startsWith(maybeAncestor + '/')
}

async function loadDir(parentPath: string): Promise<DirNode[]> {
  const result = await natsService.proxyToolset('list_files', {
    sub_dir: parentPath || null,
    recursive: false,
  }, 'file_manager') as { success: boolean; files: Array<{ name: string; type: string }> }
  if (!result?.success || !Array.isArray(result.files)) return []
  return result.files
    .filter(f => f.type === 'directory' && f.name !== '.executor')
    .map(f => ({
      name: f.name,
      path: parentPath ? `${parentPath}/${f.name}` : f.name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

onMounted(async () => {
  root.value = await loadDir('')
})

async function toggle(node: DirNode) {
  if (expanded.value.has(node.path)) {
    expanded.value.delete(node.path)
    expanded.value = new Set(expanded.value)
    return
  }
  expanded.value.add(node.path)
  expanded.value = new Set(expanded.value)
  if (node.children === undefined) {
    node.loading = true
    node.children = await loadDir(node.path)
    node.loading = false
  }
}

function pickDir(node: DirNode) {
  selected.value = node.path
}
function pickRoot() {
  selected.value = ''
}

const moveDisabled = computed(() => {
  if (selected.value === sourceParent.value) return true
  if (isAncestorOrSelf(props.sourcePath, selected.value)) return true
  return false
})

function confirm() {
  if (moveDisabled.value) {
    error.value = 'Cannot move into the same folder, into the file itself, or into a descendant.'
    return
  }
  emit('pick', selected.value)
}

function flatten(nodes: DirNode[], depth: number, out: { node: DirNode; depth: number }[]) {
  for (const n of nodes) {
    out.push({ node: n, depth })
    if (expanded.value.has(n.path) && n.children) flatten(n.children, depth + 1, out)
  }
}
const visible = computed(() => {
  const out: { node: DirNode; depth: number }[] = []
  flatten(root.value, 0, out)
  return out
})
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-label="Move to folder">
      <div class="modal-header">Move <strong>{{ sourcePath }}</strong> to…</div>
      <div class="modal-body">
        <div
          class="dir-row"
          :class="{ selected: selected === '' }"
          @click="pickRoot()"
        >
          <span class="icon">&#128193;</span>
          <span class="name">/ (workspace root)</span>
        </div>
        <div
          v-for="{ node, depth } in visible"
          :key="node.path"
          class="dir-row"
          :class="{ selected: selected === node.path }"
          :style="{ paddingLeft: (12 + depth * 16) + 'px' }"
          @click="pickDir(node)"
        >
          <span class="caret" @click.stop="toggle(node)">
            <span v-if="node.loading" class="spinner"></span>
            <template v-else>{{ expanded.has(node.path) ? '&#9660;' : '&#9654;' }}</template>
          </span>
          <span class="icon">&#128193;</span>
          <span class="name">{{ node.name }}</span>
        </div>
      </div>
      <div v-if="error" class="modal-error">{{ error }}</div>
      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="moveDisabled" @click="confirm()">Move</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 2000;
}
.modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 480px;
  max-height: 70vh;
  display: flex; flex-direction: column;
  font-size: 0.9em;
}
.modal-header {
  padding: 12px 16px; border-bottom: 1px solid var(--border);
  font-weight: 600;
}
.modal-body {
  flex: 1; overflow-y: auto; padding: 4px 0;
}
.dir-row {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 12px; cursor: pointer;
}
.dir-row:hover { background: var(--bg-tertiary); }
.dir-row.selected { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.caret { width: 14px; font-size: 0.7em; color: var(--text-muted); cursor: pointer; }
.icon { font-size: 0.9em; }
.name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.modal-error {
  padding: 6px 16px; color: var(--danger); font-size: 0.85em;
  border-top: 1px solid var(--border);
}
.modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--border);
}
.btn {
  background: var(--bg-tertiary); border: 1px solid var(--border);
  color: var(--text-primary); border-radius: 4px;
  padding: 6px 12px; cursor: pointer;
}
.btn:hover:not(:disabled) { background: var(--bg-hover); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
.spinner {
  display: inline-block; width: 8px; height: 8px;
  border: 1.5px solid var(--border); border-top-color: var(--accent);
  border-radius: 50%; animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
```

- [ ] **Step 2: Wire into `FileTree.vue`**

Add to imports:

```typescript
import MoveToModal from './MoveToModal.vue'
```

Add state:

```typescript
const moveSource = ref<string | null>(null)

function openMoveTo(fe: FlatEntry) {
  moveSource.value = fe.path
}

async function onMovePick(targetDir: string) {
  if (!moveSource.value) return
  const source = moveSource.value
  const basename = source.split('/').pop() ?? source
  const newPath = targetDir ? `${targetDir}/${basename}` : basename
  moveSource.value = null
  await doMove(source, newPath)
}
```

Add the modal render alongside the context menu:

```vue
    <MoveToModal
      v-if="moveSource"
      :source-path="moveSource"
      @pick="onMovePick"
      @close="moveSource = null"
    />
```

Wire the context-menu event. Replace `@move-to="/* wired in Task 6 */ closeCtxMenu()"` with:

```vue
      @move-to="(openMoveTo(ctxMenu.fe), closeCtxMenu())"
```

- [ ] **Step 3: Typecheck**

Run: `npm --prefix frontend run typecheck`

Expected: no errors.

- [ ] **Step 4: Manual verification**

In the browser:

1. Right-click `local_projects/foo.txt`, choose Move to…. Modal opens with the directory tree (workspace root + folders only). Click `local_projects/sub` and click Move. File moves.
2. Open Move to… on the same file again. Select the source's current parent — Move button is disabled.
3. Move to… for a directory `src/`. Select `src` — Move disabled (into self). Select `src/lib` — disabled (descendant).
4. Move to… → click `/ (workspace root)` → Move. File ends up at root.
5. Trigger `target_exists` by moving into a folder where the same basename already exists. Tree-error strip surfaces the backend error.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/files/MoveToModal.vue frontend/src/components/files/FileTree.vue
git commit -m "feat(frontend): Move to… modal with directory-only tree

Lazily expands directories via list_files, disables the Move button
when the target equals the source, the source's current parent, or a
descendant of the source. Picks reuse the same doMove path as
drag-row-to-folder."
```

---

## Task 7: Directory upload via toolbar picker

**Files:**
- Modify: `frontend/src/components/files/FileTree.vue`

Partial delivery of user feedback item **#4 (directory upload)**. Folder drag-drop in Task 8.

- [ ] **Step 1: Add a second hidden input + button + handler**

In `<script setup>`, add:

```typescript
const dirInput = ref<HTMLInputElement | null>(null)

function openDirPicker() {
  uploadTargetDir.value = DEFAULT_DROP_DIR
  dirInput.value?.click()
}

function onPickDir(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files || input.files.length === 0) return
  // Each File has a webkitRelativePath like "folder/sub/file.txt".
  // We upload to <DEFAULT_DROP_DIR>/<webkitRelativePath>.
  for (const file of Array.from(input.files)) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath
    if (!rel) continue
    const destDir = DEFAULT_DROP_DIR + '/' + rel.split('/').slice(0, -1).join('/')
    const { id, promise } = queueUpload(file, destDir)
    fileForUpload.set(id, file)
    promise
      .then(() => refreshAfterUpload(destDir))
      .catch(() => {})
  }
  input.value = ''
}
```

- [ ] **Step 2: Add the input element and toolbar button**

In the template, after the existing `<input ref="fileInput" ... />`, add:

```vue
    <input
      ref="dirInput"
      type="file"
      multiple
      style="display:none"
      @change="onPickDir"
    />
```

In the toolbar `tree-actions`, add a new button after the existing upload button:

```vue
        <button class="icon-btn" @click="openDirPicker()" title="Upload folder">&#128194;</button>
```

(Note: `webkitdirectory` is not a TypeScript-supported attribute. Set it imperatively on mount to keep the template valid.)

- [ ] **Step 3: Apply `webkitdirectory` imperatively**

Replace the existing `onMounted(...)` with:

```typescript
onMounted(() => {
  if (files.tree.length === 0) files.loadTree()
  if (dirInput.value) {
    dirInput.value.setAttribute('webkitdirectory', '')
    dirInput.value.setAttribute('directory', '')
  }
})
```

- [ ] **Step 4: Typecheck**

Run: `npm --prefix frontend run typecheck`

Expected: no errors.

- [ ] **Step 5: Manual verification**

In the browser:

1. Click the new folder-upload button. The system folder picker opens (Chromium / Firefox both support `webkitdirectory`).
2. Pick a small folder (3–5 files, including subfolders). Uploads queue sequentially in the upload tray. After completion, expand `local_projects/<picked-folder>/` and confirm the subdirectory structure was preserved.
3. Confirm the original single-file upload toolbar button still works.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/files/FileTree.vue
git commit -m "feat(frontend): directory upload via toolbar picker

Adds a folder-icon toolbar button using <input webkitdirectory> that
queues each File under local_projects/<webkitRelativePath>, preserving
the picked folder's tree structure."
```

---

## Task 8: Folder drag-drop walker

**Files:**
- Create: `frontend/src/utils/dnd.ts`
- Modify: `frontend/src/components/files/FileTree.vue`

Completes user feedback item **#4 (directory upload)**.

- [ ] **Step 1: Create the walker**

Write `frontend/src/utils/dnd.ts`:

```typescript
// Walk a DataTransferItemList (from a drag-drop) into a flat list of files,
// preserving each file's relative path inside the dropped folder structure.
//
// Uses webkitGetAsEntry (non-standard but supported in Chromium, Firefox,
// and Safari). For pure-file drops, the relativePath is just the file name.

export interface DroppedFile {
  file: File
  relativePath: string  // e.g. "folder/sub/file.txt" or "file.txt"
}

interface FileSystemEntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (cb: (f: File) => void, err?: (e: Error) => void) => void
  createReader?: () => { readEntries: (cb: (entries: FileSystemEntryLike[]) => void) => void }
}

export async function walkDataTransferItems(items: DataTransferItemList): Promise<DroppedFile[]> {
  const out: DroppedFile[] = []
  const entries: FileSystemEntryLike[] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'file') continue
    const entry = (item as DataTransferItem & {
      webkitGetAsEntry?: () => FileSystemEntryLike | null
    }).webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }

  for (const entry of entries) {
    await walkEntry(entry, '', out)
  }
  return out
}

async function walkEntry(entry: FileSystemEntryLike, prefix: string, out: DroppedFile[]): Promise<void> {
  const here = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file!((f) => resolve(f), (e) => reject(e))
    })
    out.push({ file, relativePath: here })
    return
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader()
    // readEntries returns at most ~100 entries per call; loop until empty.
    let batch: FileSystemEntryLike[] = []
    do {
      batch = await new Promise<FileSystemEntryLike[]>((resolve) => {
        reader.readEntries((es) => resolve(es))
      })
      for (const child of batch) {
        await walkEntry(child, here, out)
      }
    } while (batch.length > 0)
  }
}
```

- [ ] **Step 2: Use the walker in `onDrop`**

In `frontend/src/components/files/FileTree.vue`, add an import:

```typescript
import { walkDataTransferItems } from '@/utils/dnd'
```

Modify the OS-file branch in `onDrop`. Replace:

```typescript
  // 2) OS-file upload (existing behavior)
  const fileList = dt.files
  if (!fileList || fileList.length === 0) return
  startUploads(fileList, dropDirFor(path))
```

with:

```typescript
  // 2) OS-file or folder upload
  const dropDir = dropDirFor(path)
  // If items are present and any look like a directory, use the walker.
  // Otherwise fall back to the simpler dt.files path.
  const items = dt.items
  const hasItems = items && items.length > 0 && typeof (items[0] as DataTransferItem & {
    webkitGetAsEntry?: unknown
  }).webkitGetAsEntry === 'function'

  if (hasItems) {
    void (async () => {
      const dropped = await walkDataTransferItems(items)
      if (dropped.length === 0) return
      for (const { file, relativePath } of dropped) {
        // relativePath includes filename. Compute the directory portion.
        const subDir = relativePath.includes('/')
          ? relativePath.slice(0, relativePath.lastIndexOf('/'))
          : ''
        const destDir = subDir ? `${dropDir}/${subDir}` : dropDir
        const { id, promise } = queueUpload(file, destDir)
        fileForUpload.set(id, file)
        promise
          .then(() => refreshAfterUpload(destDir))
          .catch(() => {})
      }
    })()
    return
  }

  const fileList = dt.files
  if (!fileList || fileList.length === 0) return
  startUploads(fileList, dropDir)
```

- [ ] **Step 3: Typecheck**

Run: `npm --prefix frontend run typecheck`

Expected: no errors.

- [ ] **Step 4: Manual verification**

In the browser:

1. Drag a folder from the OS file manager into the tree pane. The walker queues every file with its subpath preserved. After completion, expand the destination and confirm the structure.
2. Drag a single file (no folder). Existing behavior still works (fast path via the same walker; relativePath is just the filename).
3. Drag a mix of files and folders. All upload to the destination directory, folders preserving structure.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/dnd.ts frontend/src/components/files/FileTree.vue
git commit -m "feat(frontend): folder drag-drop upload via webkitGetAsEntry

New utility walkDataTransferItems recursively flattens a folder drop
into (File, relativePath) pairs. FileTree's onDrop uses it for any
drop with DataTransferItem support, falling back to dt.files for the
plain-file path. Subdirectory structure is preserved under the drop
target."
```

---

## Task 9: Smoke tests + final verification

**Files:**
- Modify: `frontend/test-ui.mjs`

The frontend has no unit-test framework; it relies on a Playwright smoke runner (`test-ui.mjs`). Extend it with assertions for the new flows and run a final manual check.

- [ ] **Step 1: Read the existing smoke runner end-to-end**

Run: `wc -l frontend/test-ui.mjs && head -200 frontend/test-ui.mjs`

Note the URL constant and how it sets up auth, then where it ends. New tests will be appended before `await browser.close()`.

- [ ] **Step 2: Append new test sections**

Append to `frontend/test-ui.mjs`, **immediately before** `await browser.close()`:

```javascript
  // ================================================
  // TEST: Context menu opens on right-click
  // ================================================
  console.log('\n=== Test: Context menu ===');
  const firstRow = page.locator('.entry-row').first();
  await firstRow.click({ button: 'right' });
  await page.waitForTimeout(300);
  const menuVisible = await page.locator('.ctx-menu').isVisible();
  console.log(`Context menu visible: ${menuVisible}`);
  await page.screenshot({ path: '/tmp/ss-ft-ctx.png' });
  // Close it
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // ================================================
  // TEST: New File pre-fills directory
  // ================================================
  console.log('\n=== Test: New File pre-fill ===');
  // Find a directory row
  const dirRows = page.locator('.entry-row');
  const dirCount = await dirRows.count();
  let dirIdx = -1;
  for (let i = 0; i < dirCount; i++) {
    // Directory rows have an expand-icon containing ▶ or ▼.
    const caret = await dirRows.nth(i).locator('.expand-icon').textContent();
    if (caret && (caret.includes('▶') || caret.includes('▼'))) { dirIdx = i; break; }
  }
  if (dirIdx >= 0) {
    await dirRows.nth(dirIdx).click({ button: 'right' });
    await page.waitForTimeout(300);
    await page.locator('.ctx-menu .ctx-item', { hasText: 'New File' }).click();
    await page.waitForTimeout(300);
    const inputVal = await page.locator('.new-item input').inputValue();
    console.log(`Pre-filled value: "${inputVal}" (should end with "/")`);
    if (!inputVal.endsWith('/')) errors.push('New File pre-fill missing trailing slash');
    // Cancel
    await page.keyboard.press('Escape');
  } else {
    console.log('No directory row found to test New File pre-fill (skipping).');
  }

  // ================================================
  // TEST: Toolbar has folder-upload button
  // ================================================
  console.log('\n=== Test: Folder upload button ===');
  const folderBtn = page.locator('.tree-actions .icon-btn[title="Upload folder"]');
  const folderBtnCount = await folderBtn.count();
  console.log(`Folder upload button count: ${folderBtnCount}`);
  if (folderBtnCount === 0) errors.push('Folder upload button not found in toolbar');

  // ================================================
  // Final
  // ================================================
  if (errors.length > 0) {
    console.log('\nERRORS:');
    for (const e of errors) console.log(`  - ${e}`);
    process.exitCode = 1;
  } else {
    console.log('\nAll new smoke checks passed.');
  }
```

If the existing runner already has a final summary/exit block, integrate the new error pushes into that flow instead of duplicating it.

- [ ] **Step 3: Run smoke runner end-to-end**

(Pre-req: dev server running, NATS / adapter reachable as the runner expects.)

Run: `npm --prefix frontend run dev` in one terminal.

In a second terminal: `node frontend/test-ui.mjs`

Expected: all sections including the new ones print pass output. Check screenshots in `/tmp/`.

- [ ] **Step 4: Full manual sweep**

In a real browser session, verify the four user-reported gaps are fixed:

1. **Move:** drag a file to a folder; rename a file via Move to…; both succeed.
2. **New file in directory:** right-click a directory, New File, type a name, Enter. File appears in that directory.
3. **Rename:** right-click a file, Rename, change the name, Enter. File is renamed in place.
4. **Directory upload:** click the folder-upload button, pick a folder; structure preserved. Drag a folder from the OS into the tree; structure preserved.

Also verify nothing regressed: single-file upload (toolbar + drag), Delete, Refresh, opening a file in the viewer, Download.

- [ ] **Step 5: Commit**

```bash
git add frontend/test-ui.mjs
git commit -m "test(frontend): smoke checks for context menu, new-in-dir, dir-upload"
```

---

## Self-Review Notes

- **Spec coverage:** all four user feedback items map to tasks (item 1 → Tasks 5–6; item 2 → Task 3; item 3 → Task 4; item 4 → Tasks 7–8). Backend op covered by Task 1. Error-strip surface in Task 2 used by Tasks 4–6.
- **Method/property names checked:** `movePath` is consistent across store and callers. `manage_path move` args (`from`, `to`, `operation: "move"`) consistent between backend and store. `INTERNAL_PATH_MIME` defined and used only in `FileTree.vue`. `walkDataTransferItems` exported and consumed.
- **No placeholders:** every step shows code or a concrete command.
- **Frontend tests:** the project has no Vue unit-test framework, only Playwright via `test-ui.mjs`. Plan reflects that — backend gets vitest unit tests, frontend gets a smoke-runner extension plus an explicit manual sweep.
