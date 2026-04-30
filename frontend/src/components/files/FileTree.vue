<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useFileStore } from '@/stores/files'
import { useUploadsStore } from '@/stores/uploads'
import { queueUpload, cancelUpload, retryUpload } from '@/services/upload'
import { getFileIcon } from '@/utils/format'
import { natsService } from '@/services/nats'
import type { FileEntry } from '@/types'
import FileContextMenu from './FileContextMenu.vue'

const emit = defineEmits<{
  (e: 'open-file', path: string): void
}>()

const files = useFileStore()
const uploads = useUploadsStore()

const INTERNAL_PATH_MIME = 'application/x-bioflow-path'

function isAncestorOrSelf(maybeAncestor: string, descendant: string): boolean {
  if (maybeAncestor === descendant) return true
  return descendant.startsWith(maybeAncestor + '/')
}

// State: which dirs are expanded, their loaded children, loading status
const expandedDirs = ref<Set<string>>(new Set())
const dirChildren = ref<Map<string, FileEntry[]>>(new Map())
const loadingDirs = ref<Set<string>>(new Set())

// Retry support: keep the original File handle off the Pinia store (Vue's
// reactivity proxy mangles XHR-related types). Component-local Map is fine
// since retries only happen while the tree is mounted.
const fileForUpload = new Map<string, File>()
const dragOverPath = ref<string | null>(null)  // null = pane background
const isDraggingFiles = ref(false)             // true while a file-drag is active over the tree
const fileInput = ref<HTMLInputElement | null>(null)
const uploadTargetDir = ref<string>('')        // dest for the toolbar button picker

const newItemPath = ref('')
const showNewInput = ref(false)
const newItemType = ref<'file' | 'directory'>('file')

// Build flat visible list with depth info
interface FlatEntry {
  entry: FileEntry
  depth: number
  path: string
}

const ctxMenu = ref<{ x: number; y: number; fe: FlatEntry } | null>(null)

function openCtxMenuAt(ev: MouseEvent, fe: FlatEntry) {
  ev.preventDefault()
  ev.stopPropagation()
  ctxMenu.value = { x: ev.clientX, y: ev.clientY, fe }
}
function closeCtxMenu() {
  ctxMenu.value = null
}

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
  if (renameInFlight) return
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

  renameInFlight = true
  try {
    const result = await files.movePath(fe.path, targetPath)
    if (!result.ok) {
      showTreeError(`Rename failed: ${result.error}`)
      cancelRename()
      return
    }
    cancelRename()
    await reloadTreeFromRoot()
  } finally {
    renameInFlight = false
  }
}

function focusRenameInput(el: Element | null, originalName: string) {
  const input = el as HTMLInputElement | null
  if (!input) return
  if (input === document.activeElement) return
  input.focus()
  const dot = originalName.lastIndexOf('.')
  input.setSelectionRange(0, dot > 0 ? dot : originalName.length)
}

const treeError = ref<string | null>(null)
let treeErrorTimer: number | null = null
let renameInFlight = false
const TREE_ERROR_DISMISS_MS = 5000

function showTreeError(msg: string) {
  treeError.value = msg
  if (treeErrorTimer !== null) clearTimeout(treeErrorTimer)
  treeErrorTimer = window.setTimeout(() => {
    treeError.value = null
    treeErrorTimer = null
  }, TREE_ERROR_DISMISS_MS)
}

onMounted(() => {
  if (files.tree.length === 0) files.loadTree()
})

const visibleEntries = computed<FlatEntry[]>(() => {
  const result: FlatEntry[] = []

  function walk(entries: FileEntry[], depth: number, parentPath: string) {
    for (const entry of entries) {
      const path = parentPath ? `${parentPath}/${entry.name}` : entry.name
      result.push({ entry, depth, path })

      if (entry.type === 'directory' && expandedDirs.value.has(path)) {
        const children = dirChildren.value.get(path)
        if (children) {
          walk(children, depth + 1, path)
        }
      }
    }
  }

  walk(files.tree, 0, '')
  return result
})

async function toggleDir(path: string) {
  if (expandedDirs.value.has(path)) {
    expandedDirs.value.delete(path)
    expandedDirs.value = new Set(expandedDirs.value)
    return
  }

  expandedDirs.value.add(path)
  expandedDirs.value = new Set(expandedDirs.value)

  if (!dirChildren.value.has(path)) {
    loadingDirs.value.add(path)
    loadingDirs.value = new Set(loadingDirs.value)
    try {
      const result = await natsService.proxyToolset('list_files', {
        sub_dir: path,
        recursive: false,
      }, 'file_manager') as { success: boolean; files: Array<{ name: string; type: string; size?: number }> }

      if (result?.success && Array.isArray(result.files)) {
        const children: FileEntry[] = result.files
          .filter(f => f.name !== '.executor')
          .map(f => ({
            name: f.name,
            path: `${path}/${f.name}`,
            type: (f.type === 'directory' ? 'directory' : 'file') as 'file' | 'directory',
            size: f.size,
          }))
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
        dirChildren.value.set(path, children)
        dirChildren.value = new Map(dirChildren.value)
      }
    } catch (e) {
      console.error('Failed to list directory:', path, e)
    } finally {
      loadingDirs.value.delete(path)
      loadingDirs.value = new Set(loadingDirs.value)
    }
  }
}

function handleClick(fe: FlatEntry) {
  if (fe.entry.type === 'directory') {
    toggleDir(fe.path)
  } else {
    emit('open-file', fe.path)
  }
}

async function createItem() {
  if (!newItemPath.value.trim()) return
  if (newItemType.value === 'directory') {
    await files.createDirectory(newItemPath.value.trim())
  } else {
    await files.createFile(newItemPath.value.trim())
  }
  showNewInput.value = false
  newItemPath.value = ''
  dirChildren.value.clear()
  await files.loadTree()
}

function startNewItemIn(fe: FlatEntry, kind: 'file' | 'directory') {
  const parent = fe.entry.type === 'directory'
    ? fe.path
    : (fe.path.includes('/') ? fe.path.slice(0, fe.path.lastIndexOf('/')) : '')
  newItemType.value = kind
  newItemPath.value = parent ? `${parent}/` : ''
  showNewInput.value = true
  if (parent && fe.entry.type === 'directory' && !expandedDirs.value.has(parent)) {
    toggleDir(parent)
  }
}

async function handleDelete(fe: FlatEntry) {
  if (confirm(`Delete ${fe.entry.name}?`)) {
    await files.deletePath(fe.path)
    await reloadTreeFromRoot()
  }
}

/** URL to nginx's direct-download endpoint for this file.
 *  Scoped by HTTP Basic auth to the authenticated user's own workspace.
 *  Works at any size — streams directly from disk, bypassing NATS. */
function downloadUrl(filePath: string): string {
  const segs = filePath.split('/').map(encodeURIComponent)
  return `/download/${segs.join('/')}`
}

async function reloadTreeFromRoot() {
  dirChildren.value.clear()
  expandedDirs.value.clear()
  await files.loadTree()
}

function refresh() {
  void reloadTreeFromRoot()
}

/** Workspace-relative directory that this drop target represents.
 *  null path = the empty tree-content pane → workspace root. */
function dropDirFor(path: string | null): string {
  if (path === null) return ''
  // If the row is a directory, drop into it. If it's a file, drop into its parent.
  const child = visibleEntries.value.find(fe => fe.path === path)
  if (!child) return ''
  if (child.entry.type === 'directory') return path
  const lastSlash = path.lastIndexOf('/')
  return lastSlash < 0 ? '' : path.slice(0, lastSlash)
}

function refreshAfterUpload(destDir: string) {
  // Reload the destination dir's listing so the new file appears.
  if (destDir === '') {
    files.loadTree()
    return
  }
  // For a sub-dir, drop the cached children and re-toggle if expanded.
  dirChildren.value.delete(destDir)
  dirChildren.value = new Map(dirChildren.value)
  if (expandedDirs.value.has(destDir)) {
    // Force re-fetch by collapsing then re-expanding.
    expandedDirs.value.delete(destDir)
    toggleDir(destDir)
  }
}

function startUploads(fileList: FileList | File[], destDir: string) {
  const arr = Array.from(fileList)
  for (const file of arr) {
    const { id, promise } = queueUpload(file, destDir)
    fileForUpload.set(id, file)
    promise
      .then(() => refreshAfterUpload(destDir))
      .catch(() => { /* error state already in store */ })
  }
}

function onPickFiles(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    startUploads(input.files, uploadTargetDir.value)
    input.value = ''  // allow re-picking the same file
  }
}

function openFilePicker() {
  uploadTargetDir.value = ''  // toolbar button → workspace root
  fileInput.value?.click()
}

function onRowDragStart(ev: DragEvent, fe: FlatEntry) {
  if (!ev.dataTransfer) return
  ev.dataTransfer.setData(INTERNAL_PATH_MIME, fe.path)
  ev.dataTransfer.setData('text/plain', fe.path)
  ev.dataTransfer.effectAllowed = 'move'
}

function onDragOver(e: DragEvent, path: string | null) {
  if (!e.dataTransfer) return
  const types = Array.from(e.dataTransfer.types)
  const hasFiles = types.includes('Files')
  const hasInternal = types.includes(INTERNAL_PATH_MIME)
  if (!hasFiles && !hasInternal) return
  e.preventDefault()
  e.dataTransfer.dropEffect = hasInternal ? 'move' : 'copy'
  isDraggingFiles.value = hasFiles
  dragOverPath.value = path
}

function onDragLeave(e: DragEvent, path: string | null) {
  // Leave only if we're moving to outside this drop zone, not into a child.
  // The relatedTarget is the new element under the cursor.
  const next = e.relatedTarget as Node | null
  const current = e.currentTarget as Node
  if (next && current.contains(next)) return
  if (dragOverPath.value === path) {
    dragOverPath.value = null
    if (path === null) isDraggingFiles.value = false
  }
}

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

    const target = visibleEntries.value.find(fe => fe.path === path)
    if (!target) return
    const targetDir = target.entry.type === 'directory'
      ? target.path
      : (target.path.includes('/') ? target.path.slice(0, target.path.lastIndexOf('/')) : '')

    const sourceParent = sourcePath.includes('/')
      ? sourcePath.slice(0, sourcePath.lastIndexOf('/'))
      : ''

    if (targetDir === sourceParent) return
    if (isAncestorOrSelf(sourcePath, targetDir)) return

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
  await reloadTreeFromRoot()
}

function onCancelUpload(id: string) {
  cancelUpload(id)
}

function onRetryUpload(id: string) {
  const file = fileForUpload.get(id)
  if (!file) return
  retryUpload(id, file)
}

function onClearUploads() {
  uploads.clearFinished()
}

function fmtBytes(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}
</script>

<template>
  <div class="file-tree">
    <div class="tree-header">
      <span class="title">Files</span>
      <div class="tree-actions">
        <button class="icon-btn" @click="refresh()" title="Refresh">&#8635;</button>
        <button class="icon-btn" @click="openFilePicker()" title="Upload (max 2 GB)">&#x2B06;</button>
        <button class="icon-btn" @click="showNewInput = true; newItemType = 'file'" title="New File">+</button>
        <button class="icon-btn" @click="showNewInput = true; newItemType = 'directory'" title="New Folder">&#128193;</button>
      </div>
    </div>

    <input
      ref="fileInput"
      type="file"
      multiple
      style="display:none"
      @change="onPickFiles"
    />

    <div v-if="showNewInput" class="new-item">
      <input
        v-model="newItemPath"
        :placeholder="newItemType === 'file' ? 'filename.py' : 'dirname/'"
        @keyup.enter="createItem"
        @keyup.escape="showNewInput = false"
        autofocus
      />
      <button class="icon-btn sm" @click="createItem">&#10003;</button>
      <button class="icon-btn sm" @click="showNewInput = false">&times;</button>
    </div>

    <div v-if="files.loading" class="loading">Loading...</div>

    <div
      class="tree-content"
      :class="{ 'drag-over-pane': dragOverPath === null && isDraggingFiles }"
      @dragover="onDragOver($event, null)"
      @dragleave="onDragLeave($event, null)"
      @drop="onDrop($event, null)"
    >
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
        <span v-if="fe.entry.type === 'directory'" class="expand-icon">
          <span v-if="loadingDirs.has(fe.path)" class="spinner"></span>
          <template v-else>{{ expandedDirs.has(fe.path) ? '&#9660;' : '&#9654;' }}</template>
        </span>
        <span v-else class="expand-icon">&nbsp;</span>
        <span class="icon">{{ getFileIcon(fe.entry.name, fe.entry.type) }}</span>
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

      <div v-if="!files.loading && files.tree.length === 0" class="empty">
        No files found. Drop a file here to upload to the workspace root.
      </div>
    </div>

    <FileContextMenu
      v-if="ctxMenu"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :type="ctxMenu.fe.entry.type"
      @rename="(startRename(ctxMenu.fe), closeCtxMenu())"
      @move-to="closeCtxMenu()"
      @new-file="(startNewItemIn(ctxMenu.fe, 'file'), closeCtxMenu())"
      @new-folder="(startNewItemIn(ctxMenu.fe, 'directory'), closeCtxMenu())"
      @delete="(handleDelete(ctxMenu.fe), closeCtxMenu())"
      @close="closeCtxMenu"
    />

    <div v-if="treeError" class="tree-error" role="alert">
      {{ treeError }}
      <button class="link-btn" @click="treeError = null">×</button>
    </div>

    <div v-if="uploads.items.length > 0" class="upload-tray">
      <div class="tray-header">
        <span>Uploads ({{ uploads.items.length }})</span>
        <button class="icon-btn sm" @click="onClearUploads()" title="Clear finished">&times;</button>
      </div>
      <div
        v-for="u in uploads.items"
        :key="u.id"
        class="upload-row"
        :class="{ 'state-error': u.state === 'error', 'state-done': u.state === 'done', 'state-canceled': u.state === 'canceled' }"
      >
        <div class="upload-meta">
          <span class="upload-name" :title="u.destPath">{{ u.fileName }}</span>
          <span class="upload-size">
            {{ fmtBytes(u.bytesSent) }} / {{ fmtBytes(u.totalBytes) }}
          </span>
        </div>
        <div class="upload-bar">
          <div class="upload-bar-fill" :style="{ width: u.totalBytes > 0 ? (u.bytesSent / u.totalBytes * 100) + '%' : '0%' }"></div>
        </div>
        <div class="upload-status">
          <template v-if="u.state === 'uploading' || u.state === 'pending'">
            <button class="link-btn" @click="onCancelUpload(u.id)">Cancel</button>
          </template>
          <template v-else-if="u.state === 'error'">
            <span class="upload-error" :title="u.error">{{ u.error || 'Failed' }}</span>
            <button class="link-btn" @click="onRetryUpload(u.id)">Retry</button>
          </template>
          <template v-else-if="u.state === 'done'">
            <span class="upload-ok">Uploaded</span>
          </template>
          <template v-else-if="u.state === 'canceled'">
            <span class="upload-muted">Canceled</span>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.file-tree { display: flex; flex-direction: column; height: 100%; }
.tree-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--border);
}
.title { font-weight: 600; font-size: 0.9em; }
.tree-actions { display: flex; gap: 4px; }
.icon-btn {
  width: 28px; height: 28px; background: transparent; border: none;
  color: var(--text-secondary); border-radius: 4px;
  display: flex; align-items: center; justify-content: center;
  font-size: 1em;
}
.icon-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.icon-btn.sm { width: 24px; height: 24px; font-size: 0.9em; }

.new-item {
  display: flex; gap: 4px; padding: 8px 16px; border-bottom: 1px solid var(--border);
}
.new-item input {
  flex: 1; padding: 4px 8px; background: var(--bg-primary);
  border: 1px solid var(--accent); border-radius: 4px;
  color: var(--text-primary); font-family: var(--font-mono); font-size: 0.85em;
}

.loading { padding: 12px 16px; color: var(--text-muted); font-size: 0.85em; }

.tree-content { flex: 1; overflow-y: auto; padding: 4px 0; }
.entry-row {
  display: flex; align-items: center; gap: 4px; padding: 4px 12px;
  cursor: pointer; font-size: 0.9em; transition: background 0.1s;
}
.entry-row:hover { background: var(--bg-tertiary); }
.expand-icon { width: 14px; font-size: 0.7em; color: var(--text-muted); flex-shrink: 0; }
.icon { flex-shrink: 0; font-size: 0.9em; }
.name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.delete-btn, .download-btn {
  opacity: 0; width: 20px; height: 20px; background: transparent;
  border: none; color: var(--text-muted); border-radius: 3px;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.75em; text-decoration: none;
}
.entry-row:hover .delete-btn,
.entry-row:hover .download-btn { opacity: 1; }
.delete-btn:hover { color: var(--danger); background: var(--bg-hover); }
.download-btn:hover { color: var(--accent); background: var(--bg-hover); }

.spinner {
  display: inline-block; width: 8px; height: 8px;
  border: 1.5px solid var(--border); border-top-color: var(--accent);
  border-radius: 50%; animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.empty {
  padding: 20px 16px; text-align: center;
  color: var(--text-muted); font-size: 0.85em;
}

/* Drag-and-drop highlights */
.tree-content.drag-over-pane {
  outline: 2px dashed var(--accent);
  outline-offset: -4px;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
}
.entry-row.drag-over {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  outline: 1px dashed var(--accent);
  outline-offset: -2px;
}

/* Upload tray */
.upload-tray {
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
  max-height: 220px; overflow-y: auto;
  font-size: 0.82em;
}
.tray-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 12px; color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
  font-weight: 600;
}
.upload-row {
  display: grid; grid-template-columns: 1fr auto;
  gap: 4px 8px; padding: 6px 12px;
  border-bottom: 1px solid var(--border);
}
.upload-row:last-child { border-bottom: none; }
.upload-meta {
  grid-column: 1 / -1;
  display: flex; justify-content: space-between; gap: 8px;
}
.upload-name {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 180px;
}
.upload-size { color: var(--text-muted); font-variant-numeric: tabular-nums; }
.upload-bar {
  grid-column: 1 / 2;
  height: 4px; background: var(--bg-tertiary); border-radius: 2px;
  overflow: hidden;
}
.upload-bar-fill {
  height: 100%; background: var(--accent);
  transition: width 0.12s linear;
}
.upload-row.state-done .upload-bar-fill { background: var(--success, #4caf50); }
.upload-row.state-error .upload-bar-fill { background: var(--danger); }
.upload-row.state-canceled .upload-bar-fill { background: var(--text-muted); }
.upload-status {
  grid-column: 2 / 3; grid-row: 2;
  display: flex; align-items: center; gap: 8px;
}
.upload-error {
  color: var(--danger); max-width: 120px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.upload-ok { color: var(--success, #4caf50); }
.upload-muted { color: var(--text-muted); }
.link-btn {
  background: none; border: none; padding: 0;
  color: var(--accent); cursor: pointer; font-size: inherit;
}
.link-btn:hover { text-decoration: underline; }

.tree-error {
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--danger) 12%, var(--bg-secondary));
  color: var(--danger);
  font-size: 0.82em;
  padding: 6px 12px;
  display: flex; align-items: center; justify-content: space-between;
}

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
</style>
