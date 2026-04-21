<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useNotebookStore } from '@/stores/notebook'
import CellEditor from '@/components/notebook/CellEditor.vue'
import CellOutputView from '@/components/notebook/CellOutputView.vue'
import CellInsertBar from '@/components/notebook/CellInsertBar.vue'
import NotebookToolbar from '@/components/notebook/NotebookToolbar.vue'
import VariableInspector from '@/components/notebook/VariableInspector.vue'

const nb = useNotebookStore()
const newNotebookPath = ref('')
const showCreateForm = ref(false)
const showVariables = ref(false)
const editorHasFocus = ref(false)
const rootEl = ref<HTMLElement | null>(null)

const notebookName = computed(() => {
  if (!nb.filePath) return ''
  const parts = nb.filePath.split('/')
  return parts[parts.length - 1]
})

async function createNotebook() {
  if (!newNotebookPath.value.trim()) return
  let path = newNotebookPath.value.trim()
  if (!path.endsWith('.ipynb')) path += '.ipynb'
  await nb.createNotebook(path)
  showCreateForm.value = false
  newNotebookPath.value = ''
}

function selectPrev() {
  const idx = nb.cells.findIndex((c) => c.id === nb.selectedCellId)
  if (idx > 0) nb.selectedCellId = nb.cells[idx - 1].id
}
function selectNext() {
  const idx = nb.cells.findIndex((c) => c.id === nb.selectedCellId)
  if (idx >= 0 && idx < nb.cells.length - 1) nb.selectedCellId = nb.cells[idx + 1].id
}

/**
 * Global notebook shortcuts. Active only when the Monaco editor doesn't have
 * focus; otherwise they would clobber typing. This mirrors Jupyter's
 * "command mode" vs "edit mode" split.
 */
function onKeydown(e: KeyboardEvent) {
  if (!nb.notebook) return
  if (editorHasFocus.value) return
  // Skip if typing in an unrelated input (e.g. the create-form field)
  const target = e.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

  const cmd = e.ctrlKey || e.metaKey
  const shift = e.shiftKey

  // Cell navigation
  if (e.key === 'ArrowUp' && !e.altKey && !e.metaKey) {
    e.preventDefault(); selectPrev(); return
  }
  if (e.key === 'ArrowDown' && !e.altKey && !e.metaKey) {
    e.preventDefault(); selectNext(); return
  }
  if (e.key === 'j') { e.preventDefault(); selectNext(); return }
  if (e.key === 'k') { e.preventDefault(); selectPrev(); return }

  // Execution
  if (e.key === 'Enter' && shift) {
    e.preventDefault()
    if (nb.selectedCellId) nb.runAndAdvance(nb.selectedCellId)
    return
  }
  if (e.key === 'Enter' && cmd) {
    e.preventDefault()
    if (nb.selectedCellId) nb.executeCell(nb.selectedCellId)
    return
  }

  // Cell operations (only if we're not inside Monaco, already checked above)
  if (!cmd && !shift) {
    if (e.key === 'a') { e.preventDefault(); nb.insertCell('above', 'code') }
    else if (e.key === 'b') { e.preventDefault(); nb.insertCell('below', 'code') }
    else if (e.key === 'v') { e.preventDefault(); nb.pasteCell() }
  }

  // Kernel shortcuts (caps variants mirror Jupyter)
  if (e.key === 'I' && shift) { e.preventDefault(); nb.interruptKernel() }
  if (e.key === '0' && shift) { e.preventDefault(); /* reserved: restart + run all */ }

  // Close variable popover on Escape
  if (e.key === 'Escape' && showVariables.value) {
    e.preventDefault()
    showVariables.value = false
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})

// Keep the selected cell visible as the user moves between them
watch(
  () => nb.selectedCellId,
  async (id) => {
    if (!id) return
    await nextTick()
    const el = rootEl.value?.querySelector(`[data-cell-id="${id}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  },
)
</script>

<template>
  <div class="notebook-editor" ref="rootEl">
    <!-- Header: title + actions -->
    <div class="nb-header">
      <div class="nb-title">
        <span class="title-label">Notebook</span>
        <span v-if="notebookName" class="notebook-name" :title="nb.filePath || ''">{{ notebookName }}</span>
      </div>
      <div class="nb-actions">
        <button
          v-if="nb.notebook"
          class="icon-btn"
          :class="{ active: showVariables }"
          @click="showVariables = !showVariables"
          title="Variable inspector"
        >Vars</button>
        <button
          class="icon-btn"
          @click="showCreateForm = !showCreateForm"
          title="New notebook"
        >+ New</button>
        <button
          v-if="nb.notebook"
          class="icon-btn"
          @click="nb.closeNotebook()"
          title="Close notebook"
        >×</button>
      </div>
    </div>

    <!-- Create form -->
    <div v-if="showCreateForm" class="create-form">
      <input
        v-model="newNotebookPath"
        placeholder="path/to/notebook.ipynb"
        @keyup.enter="createNotebook"
        autofocus
      />
      <button class="btn-sm" @click="createNotebook">Create</button>
      <button class="btn-sm ghost" @click="showCreateForm = false">Cancel</button>
    </div>

    <!-- Loading -->
    <div v-if="nb.loading" class="empty">Loading notebook…</div>

    <!-- No notebook open -->
    <div v-else-if="!nb.notebook" class="empty">
      <p class="empty-title">No notebook open</p>
      <p class="hint">Open a <code>.ipynb</code> file from the file tree,<br>or create a new one.</p>
    </div>

    <!-- Notebook -->
    <template v-else>
      <NotebookToolbar />

      <!-- Floating variable inspector popover (does not scroll with cells) -->
      <div
        v-if="showVariables"
        class="var-popover-backdrop"
        @click="showVariables = false"
      />
      <div v-if="showVariables" class="var-popover" role="dialog" aria-label="Variable inspector">
        <button
          class="popover-close"
          @click="showVariables = false"
          title="Close (Esc)"
          aria-label="Close variable inspector"
        >×</button>
        <VariableInspector />
      </div>

      <div class="nb-scroll">
        <div class="cells">
          <CellInsertBar @insert="(t) => nb.addCell(t, '', nb.cells[0] ? { relativeTo: nb.cells[0].id, side: 'before' } : undefined)" />

          <template v-for="(cell, idx) in nb.cells" :key="cell.id">
            <div class="cell-wrapper" :data-cell-id="cell.id">
              <CellEditor
                :cell="cell"
                :index="idx"
                :executing="nb.executingCells.has(cell.id)"
                :selected="nb.selectedCellId === cell.id"
                :markdown-editing="nb.editingMarkdownCells.has(cell.id)"
                @execute="nb.executeCell(cell.id)"
                @execute-advance="nb.runAndAdvance(cell.id)"
                @update="(src: string) => nb.updateCell(cell.id, src)"
                @delete="nb.deleteCell(cell.id)"
                @select="nb.selectedCellId = cell.id"
                @move-up="nb.moveCell(cell.id, 'up')"
                @move-down="nb.moveCell(cell.id, 'down')"
                @insert-above="nb.addCell('code', '', { relativeTo: cell.id, side: 'before' })"
                @insert-below="nb.addCell('code', '', { relativeTo: cell.id, side: 'after' })"
                @change-type="(t) => nb.changeCellType(cell.id, t)"
                @clear-outputs="nb.clearCellOutputs(cell.id)"
                @copy="nb.copyCell(cell.id)"
                @start-edit-markdown="nb.setMarkdownEditing(cell.id, true)"
                @end-edit-markdown="nb.setMarkdownEditing(cell.id, false)"
                @focus-editor="(f) => (editorHasFocus = f)"
              />
              <CellOutputView
                v-if="cell.cell_type === 'code'"
                :outputs="nb.cellStreamOutputs.get(cell.id) || cell.outputs"
                :executing="nb.executingCells.has(cell.id)"
                :collapsed="nb.collapsedOutputs.has(cell.id)"
                @toggle-collapsed="nb.toggleOutputCollapsed(cell.id)"
                @clear="nb.clearCellOutputs(cell.id)"
              />
            </div>
            <CellInsertBar @insert="(t) => nb.addCell(t, '', { relativeTo: cell.id, side: 'after' })" />
          </template>

          <div v-if="nb.cells.length === 0" class="no-cells">
            <button class="add-btn" @click="nb.addCell('code')">+ Add code cell</button>
            <button class="add-btn" @click="nb.addCell('markdown')">+ Add markdown cell</button>
          </div>
        </div>
      </div>

      <!-- Status / footer -->
      <div class="nb-footer">
        <span>{{ nb.cellCount }} cell{{ nb.cellCount === 1 ? '' : 's' }}</span>
        <span class="sep">·</span>
        <span>Shift+Enter run · Ctrl+Enter run in place · a/b insert · dd delete · m/y toggle type</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.notebook-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  position: relative;
}

/* Floating variable inspector popover ─────────────────────────── */
.var-popover-backdrop {
  position: absolute;
  inset: 0;
  background: transparent;
  z-index: 20;
}
.var-popover {
  position: absolute;
  top: 58px;
  right: 14px;
  width: min(420px, calc(100% - 28px));
  max-height: calc(100% - 74px);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow:
    0 10px 28px rgba(0, 0, 0, 0.45),
    0 2px 6px rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
  z-index: 21;
  overflow: hidden;
  animation: popover-in 0.12s ease-out;
}
@keyframes popover-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: translateY(0); }
}
/* Close button floats over the inspector's own header */
.popover-close {
  position: absolute;
  top: 4px;
  right: 6px;
  width: 22px;
  height: 22px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  border-radius: 4px;
  font-size: 1.1em;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}
.popover-close:hover {
  background: var(--bg-hover);
  color: var(--danger);
}

.nb-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  flex-shrink: 0;
}
.nb-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.title-label {
  font-family: var(--font-display);
  font-weight: var(--fw-semi);
  font-size: var(--text-md);
  letter-spacing: -0.01em;
}
.notebook-name {
  font-family: var(--font-mono);
  font-size: 0.78em;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nb-actions { display: flex; gap: 2px; }
.icon-btn {
  padding: 3px 8px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-secondary);
  border-radius: var(--radius);
  font-size: 0.78em;
}
.icon-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.icon-btn.active { border-color: var(--accent); color: var(--accent); }

.create-form {
  display: flex;
  gap: 6px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-primary);
}
.create-form input {
  flex: 1;
  padding: 5px 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.82em;
}
.btn-sm {
  padding: 4px 10px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--radius);
  font-size: 0.8em;
}
.btn-sm.ghost {
  background: transparent;
  color: var(--text-muted);
  border: 1px solid var(--border);
}

.empty {
  padding: 48px 20px;
  text-align: center;
  color: var(--text-muted);
}
.empty-title {
  font-family: var(--font-display);
  font-size: var(--text-xl);
  font-weight: var(--fw-semi);
  letter-spacing: -0.015em;
  margin-bottom: var(--space-2);
  color: var(--text-primary);
}
.hint { font-size: 0.82em; line-height: 1.6; }
.hint code {
  font-family: var(--font-mono);
  background: var(--bg-tertiary);
  padding: 1px 5px;
  border-radius: 3px;
}

.nb-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.cells { padding: 8px 10px 40px; }
.cell-wrapper { margin: 0; }

.no-cells {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 24px 12px;
  align-items: center;
}
.add-btn {
  padding: 8px 22px;
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-secondary);
  font-size: 0.85em;
}
.add-btn:hover {
  border-color: var(--accent);
  border-style: solid;
  color: var(--accent);
}

.nb-footer {
  flex-shrink: 0;
  padding: 6px 14px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border);
  font-size: 0.72em;
  color: var(--text-muted);
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.nb-footer .sep { opacity: 0.5; }
</style>
