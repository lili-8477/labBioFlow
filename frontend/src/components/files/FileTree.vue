<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useFileStore } from '@/stores/files'
import { getFileIcon } from '@/utils/format'
import { natsService } from '@/services/nats'
import type { FileEntry } from '@/types'

const emit = defineEmits<{
  (e: 'open-file', path: string): void
}>()

const files = useFileStore()

// State: which dirs are expanded, their loaded children, loading status
const expandedDirs = ref<Set<string>>(new Set())
const dirChildren = ref<Map<string, FileEntry[]>>(new Map())
const loadingDirs = ref<Set<string>>(new Set())

const newItemPath = ref('')
const showNewInput = ref(false)
const newItemType = ref<'file' | 'directory'>('file')

onMounted(() => {
  if (files.tree.length === 0) files.loadTree()
})

// Build flat visible list with depth info
interface FlatEntry {
  entry: FileEntry
  depth: number
  path: string
}

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

async function handleDelete(fe: FlatEntry) {
  if (confirm(`Delete ${fe.entry.name}?`)) {
    await files.deletePath(fe.path)
    dirChildren.value.clear()
    expandedDirs.value.clear()
    await files.loadTree()
  }
}

function refresh() {
  dirChildren.value.clear()
  expandedDirs.value.clear()
  files.loadTree()
}
</script>

<template>
  <div class="file-tree">
    <div class="tree-header">
      <span class="title">Files</span>
      <div class="tree-actions">
        <button class="icon-btn" @click="refresh()" title="Refresh">&#8635;</button>
        <button class="icon-btn" @click="showNewInput = true; newItemType = 'file'" title="New File">+</button>
        <button class="icon-btn" @click="showNewInput = true; newItemType = 'directory'" title="New Folder">&#128193;</button>
      </div>
    </div>

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

    <div class="tree-content">
      <div
        v-for="fe in visibleEntries"
        :key="fe.path"
        class="entry-row"
        :style="{ paddingLeft: (12 + fe.depth * 16) + 'px' }"
        @click="handleClick(fe)"
      >
        <span v-if="fe.entry.type === 'directory'" class="expand-icon">
          <span v-if="loadingDirs.has(fe.path)" class="spinner"></span>
          <template v-else>{{ expandedDirs.has(fe.path) ? '&#9660;' : '&#9654;' }}</template>
        </span>
        <span v-else class="expand-icon">&nbsp;</span>
        <span class="icon">{{ getFileIcon(fe.entry.name, fe.entry.type) }}</span>
        <span class="name">{{ fe.entry.name }}</span>
        <button class="delete-btn" @click.stop="handleDelete(fe)" title="Delete">&times;</button>
      </div>

      <div v-if="!files.loading && files.tree.length === 0" class="empty">
        No files found.
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
.delete-btn {
  opacity: 0; width: 20px; height: 20px; background: transparent;
  border: none; color: var(--text-muted); border-radius: 3px;
  display: flex; align-items: center; justify-content: center;
}
.entry-row:hover .delete-btn { opacity: 1; }
.delete-btn:hover { color: var(--danger); background: var(--bg-hover); }

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
</style>
