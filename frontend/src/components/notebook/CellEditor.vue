<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import type { NotebookCell } from '@/types'
import { getMonaco, defaultCellEditorOptions } from '@/utils/monaco'
import { renderMarkdown } from '@/utils/markdown'

const props = defineProps<{
  cell: NotebookCell
  executing: boolean
  selected: boolean
  /** When true the markdown cell is in edit mode instead of rendered mode. */
  markdownEditing: boolean
  /** Zero-based index for display. */
  index: number
}>()

const emit = defineEmits<{
  (e: 'execute'): void
  (e: 'execute-advance'): void
  (e: 'update', source: string): void
  (e: 'delete'): void
  (e: 'select'): void
  (e: 'move-up'): void
  (e: 'move-down'): void
  (e: 'insert-above'): void
  (e: 'insert-below'): void
  (e: 'change-type', type: 'code' | 'markdown'): void
  (e: 'clear-outputs'): void
  (e: 'copy'): void
  (e: 'start-edit-markdown'): void
  (e: 'end-edit-markdown'): void
  (e: 'focus-editor', focused: boolean): void
}>()

const editorEl = ref<HTMLElement | null>(null)
const rootEl = ref<HTMLElement | null>(null)
let editor: import('monaco-editor').editor.IStandaloneCodeEditor | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null

const isCode = computed(() => props.cell.cell_type === 'code')
const isMarkdown = computed(() => props.cell.cell_type === 'markdown')
const isRaw = computed(() => props.cell.cell_type === 'raw')
const showEditor = computed(() => isCode.value || isRaw.value || props.markdownEditing)
const renderedMarkdown = computed(() =>
  props.cell.source ? renderMarkdown(props.cell.source) : '<p class="md-empty">Empty markdown cell — double-click to edit</p>',
)

async function initEditor() {
  if (!editorEl.value || editor) return
  const monaco = await getMonaco()

  const language =
    props.cell.cell_type === 'code'
      ? 'python'
      : props.cell.cell_type === 'markdown'
        ? 'markdown'
        : 'plaintext'

  editor = monaco.editor.create(editorEl.value, {
    value: props.cell.source || '',
    language,
    ...defaultCellEditorOptions(isCode.value),
  })

  const updateHeight = () => {
    if (!editor || !editorEl.value) return
    const contentHeight = Math.max(editor.getContentHeight(), 32)
    editorEl.value.style.height = `${Math.min(contentHeight, 600)}px`
    editor.layout()
  }
  editor.onDidContentSizeChange(updateHeight)
  updateHeight()

  editor.onDidChangeModelContent(() => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (editor) emit('update', editor.getValue())
    }, 500)
  })

  editor.onDidFocusEditorText(() => {
    emit('select')
    emit('focus-editor', true)
  })
  editor.onDidBlurEditorText(() => {
    emit('focus-editor', false)
    // Flush any pending debounce immediately on blur
    if (debounceTimer && editor) {
      clearTimeout(debounceTimer)
      debounceTimer = null
      emit('update', editor.getValue())
    }
    if (isMarkdown.value) emit('end-edit-markdown')
  })

  // Keybindings
  editor.addAction({
    id: 'execute-cell',
    label: 'Run Cell',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    run: () => emit('execute'),
  })
  editor.addAction({
    id: 'execute-cell-advance',
    label: 'Run Cell and Advance',
    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.Enter],
    run: () => emit('execute-advance'),
  })
  editor.addAction({
    id: 'exit-edit-mode',
    label: 'Exit Edit Mode',
    keybindings: [monaco.KeyCode.Escape],
    run: () => {
      editor?.getDomNode()?.blur()
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      rootEl.value?.focus()
    },
  })
}

// Keep editor value in sync when source mutates externally (e.g. paste).
watch(
  () => props.cell.source,
  (val) => {
    if (editor && editor.getValue() !== val) {
      editor.setValue(val)
    }
  },
)

// Re-init Monaco when cell type changes (e.g. code → markdown)
watch(
  () => props.cell.cell_type,
  async (newType, oldType) => {
    if (newType === oldType) return
    // Dispose any existing editor; will re-mount next tick if needed
    editor?.dispose()
    editor = null
    if (showEditor.value) {
      // Wait a tick for the DOM ref to remount if it was hidden
      await new Promise((r) => setTimeout(r, 0))
      await initEditor()
    }
  },
)

// Re-init Monaco when switching markdown render → edit mode
watch(
  () => showEditor.value,
  async (now) => {
    if (now && !editor) {
      await new Promise((r) => setTimeout(r, 0))
      await initEditor()
    } else if (!now && editor) {
      editor.dispose()
      editor = null
    }
  },
)

// Focus the editor when we enter markdown-edit mode
watch(
  () => props.markdownEditing,
  async (val) => {
    if (val) {
      await new Promise((r) => setTimeout(r, 10))
      editor?.focus()
    }
  },
)

onMounted(() => {
  if (showEditor.value) initEditor()
})
onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
  editor?.dispose()
  editor = null
})

function onRootKeydown(e: KeyboardEvent) {
  // Command-mode shortcuts (root has focus, editor does not).
  if (e.target !== rootEl.value) return
  if (e.key === 'Enter') {
    e.preventDefault()
    if (isMarkdown.value) emit('start-edit-markdown')
    else editor?.focus()
    return
  }
  if (e.key === 'a') { e.preventDefault(); emit('insert-above') }
  else if (e.key === 'b') { e.preventDefault(); emit('insert-below') }
  else if (e.key === 'd' && (e as KeyboardEvent).repeat === false) {
    // Match Jupyter's "dd" to delete. Track double-d via timestamp.
    const now = Date.now()
    const last = (rootEl.value as HTMLElement & { _lastD?: number })._lastD ?? 0
    if (now - last < 500) emit('delete')
    ;(rootEl.value as HTMLElement & { _lastD?: number })._lastD = now
  }
  else if (e.key === 'y') { e.preventDefault(); emit('change-type', 'code') }
  else if (e.key === 'm') { e.preventDefault(); emit('change-type', 'markdown') }
  else if (e.key === 'c') { e.preventDefault(); emit('copy') }
  else if (e.key === 'ArrowUp' && (e.altKey || e.metaKey)) { e.preventDefault(); emit('move-up') }
  else if (e.key === 'ArrowDown' && (e.altKey || e.metaKey)) { e.preventDefault(); emit('move-down') }
}

function onMarkdownDblClick() {
  if (isMarkdown.value) emit('start-edit-markdown')
}
</script>

<template>
  <div
    ref="rootEl"
    class="cell-editor"
    :class="[cell.cell_type, { executing, selected, 'md-rendered': isMarkdown && !markdownEditing }]"
    tabindex="-1"
    @click="emit('select')"
    @keydown="onRootKeydown"
  >
    <!-- Gutter: cell type, execution count, run indicator -->
    <div class="cell-gutter">
      <span class="cell-index" :title="`Cell ${index + 1}`">{{ index + 1 }}</span>
      <span v-if="isCode" class="exec-count" :class="{ placeholder: !cell.execution_count && !executing }">
        <template v-if="executing">[*]</template>
        <template v-else>[{{ cell.execution_count ?? ' ' }}]</template>
      </span>
      <span v-else class="cell-type-badge">{{ isMarkdown ? 'Md' : 'Raw' }}</span>
    </div>

    <!-- Body: editor or rendered markdown -->
    <div class="cell-body">
      <!-- Markdown rendered -->
      <div
        v-if="isMarkdown && !markdownEditing"
        class="md-rendered-body markdown-body"
        @dblclick="onMarkdownDblClick"
        v-html="renderedMarkdown"
      ></div>

      <!-- Monaco editor -->
      <div v-show="showEditor" ref="editorEl" class="cell-editor-container"></div>
    </div>

    <!-- Actions -->
    <div class="cell-actions">
      <button
        v-if="isCode"
        class="action-btn run"
        @click.stop="emit('execute')"
        :disabled="executing"
        title="Run (Ctrl+Enter) · Shift+Enter to advance"
      >▶</button>
      <button
        v-if="isMarkdown && markdownEditing"
        class="action-btn run"
        @click.stop="emit('execute')"
        title="Render markdown (Shift+Enter)"
      >✓</button>
      <button
        class="action-btn"
        @click.stop="emit('move-up')"
        title="Move up (Alt+↑)"
      >↑</button>
      <button
        class="action-btn"
        @click.stop="emit('move-down')"
        title="Move down (Alt+↓)"
      >↓</button>
      <button
        class="action-btn delete"
        @click.stop="emit('delete')"
        title="Delete (dd)"
      >×</button>
    </div>
  </div>
</template>

<style scoped>
.cell-editor {
  position: relative;
  display: flex;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-secondary);
  overflow: hidden;
  outline: none;
  transition: border-color 0.14s var(--ease-out-quart),
              box-shadow 0.14s var(--ease-out-quart);
}
.cell-editor.selected {
  border-color: var(--accent);
  box-shadow: var(--shadow-sm), 0 0 0 1px var(--accent) inset;
}
.cell-editor.executing {
  border-color: var(--warning);
  box-shadow: 0 0 0 1px var(--warning-soft) inset;
}
/* Cell type is signalled by the GUTTER (colored typographic marker),
   not a left stripe. Stripes look templated no matter how they're tinted. */
.cell-editor.code    .cell-gutter { background: var(--bg-tertiary); }
.cell-editor.markdown .cell-gutter {
  background: color-mix(in oklch, var(--success-soft) 70%, var(--bg-tertiary));
}
.cell-editor.raw     .cell-gutter { background: var(--bg-tertiary); opacity: 0.85; }

.cell-gutter {
  width: 52px;
  padding: var(--space-2) var(--space-1);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  user-select: none;
  transition: background 0.14s var(--ease-out-quart);
}
.cell-index {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--text-muted);
  opacity: 0.45;
  font-variant-numeric: tabular-nums;
}
.exec-count {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  color: var(--accent);
  letter-spacing: -0.02em;
}
.exec-count.placeholder {
  color: var(--text-muted);
  opacity: 0.4;
}
.cell-editor.executing .exec-count { color: var(--warning); }
.cell-type-badge {
  font-family: var(--font-display);
  font-weight: var(--fw-semi);
  font-size: var(--text-2xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--success);
}
.cell-editor.raw .cell-type-badge { color: var(--text-muted); }

.cell-body { flex: 1; min-width: 0; }
.cell-editor-container { min-height: 32px; }

.md-rendered-body {
  padding: 12px 14px;
  min-height: 40px;
  cursor: text;
  font-size: 0.92em;
}
.md-rendered-body :deep(p:first-child) { margin-top: 0; }
.md-rendered-body :deep(p:last-child) { margin-bottom: 0; }
.md-rendered-body :deep(.md-empty) {
  color: var(--text-muted);
  font-style: italic;
  font-size: 0.85em;
  margin: 0;
}

.cell-actions {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px;
  opacity: 0;
  transition: opacity 0.12s;
}
.cell-editor:hover .cell-actions,
.cell-editor.selected .cell-actions { opacity: 1; }
.action-btn {
  width: 24px;
  height: 24px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85em;
}
.action-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.action-btn.run { color: var(--success); }
.action-btn.run:hover { color: var(--success); }
.action-btn.delete:hover { color: var(--danger); }
</style>
