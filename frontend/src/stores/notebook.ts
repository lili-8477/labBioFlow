import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { natsService } from '@/services/nats'
import type {
  Notebook, NotebookCell, NotebookInfo,
  CellOutput, VariableInfo, NotebookStreamMessage,
  KernelStatus, ClipboardCell,
} from '@/types'

type CellType = 'code' | 'markdown' | 'raw'

/**
 * Notebook store. Backend contract (see bioFlow/Pantheon
 * `pantheon.toolsets.notebook.IntegratedNotebookToolSet`):
 *
 *   read_notebook(notebook_path, validate)
 *   create_notebook(notebook_path, language)
 *   add_cell(notebook_path, cell_type, content, cell_id, position, execute)
 *   update_cell(notebook_path, cell_id, content, old_content, execute)
 *   delete_cell(notebook_path, cell_id)
 *   move_cell(notebook_path, cell_id, below_cell_id)
 *   execute_cell(notebook_path, cell_id)
 *   manage_kernel(notebook_path, action, kernel_spec?)
 *     action ∈ restart | interrupt | status | variables | shutdown | delete | switch
 *
 * Responses include `kernel_session_id` (once a kernel context has been
 * created). The frontend stores this ID and subscribes to the matching
 * NATS stream (`pantheon.stream.notebook_iopub_<id>`) for live IOPub
 * messages.
 */
export const useNotebookStore = defineStore('notebook', () => {
  // ── Persisted state (mirrors backend) ────────────────────────────────
  const notebook = ref<Notebook | null>(null)
  const filePath = ref<string | null>(null)
  const version = ref(0)

  // ── Kernel / execution ───────────────────────────────────────────────
  const loading = ref(false)
  const saving = ref(false)
  const executingCells = ref<Set<string>>(new Set())
  const variables = ref<Record<string, VariableInfo>>({})
  const cellStreamOutputs = ref<Map<string, CellOutput[]>>(new Map())
  const kernelSessionId = ref<string | null>(null)
  const kernelStatus = ref<KernelStatus>('unknown')
  const lastExecutionError = ref<string | null>(null)

  // ── UI state ─────────────────────────────────────────────────────────
  const selectedCellId = ref<string | null>(null)
  const clipboard = ref<ClipboardCell | null>(null)
  const editingMarkdownCells = ref<Set<string>>(new Set())
  const collapsedOutputs = ref<Set<string>>(new Set())

  let notebookSubId: string | null = null

  const cells = computed(() => notebook.value?.cells || [])
  const cellCount = computed(() => cells.value.length)
  const isBusy = computed(() => executingCells.value.size > 0 || kernelStatus.value === 'busy')
  const selectedCell = computed(() =>
    selectedCellId.value ? cells.value.find((c) => c.id === selectedCellId.value) ?? null : null,
  )

  // ─────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Capture `kernel_session_id` from any tool response and (re)subscribe
   * to its IOPub stream. Idempotent: skips if the id didn't change.
   */
  function captureKernelSessionId(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null
    const r = result as Record<string, unknown>
    const id = (r.kernel_session_id as string) ?? null
    if (id && id !== kernelSessionId.value) {
      kernelSessionId.value = id
      subscribeToNotebookStream()
    }
    return id
  }

  function subscribeToNotebookStream() {
    if (notebookSubId) {
      natsService.unsubscribe(notebookSubId)
      notebookSubId = null
    }
    if (!kernelSessionId.value) return
    const safeId = encodeURIComponent(kernelSessionId.value)
    notebookSubId = natsService.subscribe(
      `notebook_iopub_${safeId}`,
      handleNotebookStream,
    )
  }

  // ─────────────────────────────────────────────────────────────────────
  // Notebook-level operations
  // ─────────────────────────────────────────────────────────────────────

  async function openNotebook(path: string) {
    loading.value = true
    try {
      const result = (await natsService.proxyToolset(
        'read_notebook',
        { notebook_path: path, validate: false },
        'notebook',
      )) as NotebookInfo | Record<string, unknown>

      const nb = (result as NotebookInfo)?.notebook || (result as Record<string, unknown>)
      if (nb && (nb as Notebook).cells) {
        notebook.value = nb as Notebook
        filePath.value = path
        version.value = (result as NotebookInfo)?.version || 0
        selectedCellId.value = notebook.value.cells[0]?.id ?? null

        // Ask the backend for an active kernel session (if any) so we can
        // attach the IOPub stream before the user runs anything.
        await refreshKernelStatus()
      }
    } catch (e) {
      console.error('Failed to open notebook:', e)
      lastExecutionError.value = (e as Error).message
    } finally {
      loading.value = false
    }
  }

  async function createNotebook(path: string, language = 'python') {
    const result = (await natsService.proxyToolset(
      'create_notebook',
      { notebook_path: path, language },
      'notebook',
    )) as Record<string, unknown>
    captureKernelSessionId(result)
    if (result?.success !== false) {
      await openNotebook(path)
    }
    return result
  }

  async function refreshNotebook() {
    if (filePath.value) await openNotebook(filePath.value)
  }

  function closeNotebook() {
    if (notebookSubId) {
      natsService.unsubscribe(notebookSubId)
      notebookSubId = null
    }
    notebook.value = null
    filePath.value = null
    variables.value = {}
    cellStreamOutputs.value.clear()
    executingCells.value.clear()
    editingMarkdownCells.value.clear()
    collapsedOutputs.value.clear()
    selectedCellId.value = null
    kernelSessionId.value = null
    kernelStatus.value = 'unknown'
  }

  // ─────────────────────────────────────────────────────────────────────
  // Cell CRUD
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Compute a backend `position` string. Backend semantics:
   *   - `null` → append at end
   *   - numeric string → insert at that index (0-based)
   *   - cell_id → insert AFTER that cell
   *
   * There's no native "before" — we emulate it by computing the integer
   * index of the reference cell, which places the new cell before it.
   */
  function resolvePosition(
    arg?: { relativeTo: string; side: 'before' | 'after' } | string | null,
  ): string | null {
    if (!arg) return null
    if (typeof arg === 'string') return arg
    if (arg.side === 'after') return arg.relativeTo
    // before:
    const idx = cells.value.findIndex((c) => c.id === arg.relativeTo)
    if (idx < 0) return null
    return String(idx)
  }

  async function addCell(
    cellType: CellType = 'code',
    source = '',
    positionArg?: { relativeTo: string; side: 'before' | 'after' } | string | null,
  ) {
    if (!filePath.value) return
    const position = resolvePosition(positionArg)

    const result = (await natsService.proxyToolset(
      'add_cell',
      {
        notebook_path: filePath.value,
        cell_type: cellType,
        content: source,
        position,
        execute: false,
      },
      'notebook',
    )) as { success: boolean; cell_id: string; kernel_session_id?: string }

    captureKernelSessionId(result)

    if (result?.success !== false) {
      await refreshNotebook()
      if (result?.cell_id) selectedCellId.value = result.cell_id
    }
    return result
  }

  async function insertCell(side: 'above' | 'below', cellType: CellType = 'code') {
    if (!selectedCellId.value) {
      await addCell(cellType)
      return
    }
    await addCell(cellType, '', {
      relativeTo: selectedCellId.value,
      side: side === 'above' ? 'before' : 'after',
    })
  }

  async function updateCell(cellId: string, source: string) {
    if (!filePath.value) return
    const cell = notebook.value?.cells.find((c) => c.id === cellId)
    if (cell) cell.source = source
    saving.value = true
    try {
      const result = (await natsService.proxyToolset(
        'update_cell',
        {
          notebook_path: filePath.value,
          cell_id: cellId,
          content: source,
          execute: false,
        },
        'notebook',
      )) as Record<string, unknown>
      captureKernelSessionId(result)
    } finally {
      saving.value = false
    }
  }

  async function deleteCell(cellId: string) {
    if (!filePath.value) return
    const idx = cells.value.findIndex((c) => c.id === cellId)
    const result = (await natsService.proxyToolset(
      'delete_cell',
      { notebook_path: filePath.value, cell_id: cellId },
      'notebook',
    )) as Record<string, unknown>
    captureKernelSessionId(result)
    await refreshNotebook()
    if (cells.value.length) {
      selectedCellId.value = cells.value[Math.min(idx, cells.value.length - 1)].id
    } else {
      selectedCellId.value = null
    }
  }

  /**
   * Move a cell up or down. Backend `move_cell` takes `below_cell_id`
   * (the cell to move AFTER, or null to move to top).
   */
  async function moveCell(cellId: string, direction: 'up' | 'down') {
    if (!filePath.value || !notebook.value) return
    const idx = cells.value.findIndex((c) => c.id === cellId)
    if (idx === -1) return
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= cells.value.length) return

    let belowCellId: string | null = null
    if (direction === 'up') {
      // Moving up → place after the cell that's two positions above, or top if none
      belowCellId = idx >= 2 ? cells.value[idx - 2].id : null
    } else {
      // Moving down → place after the cell currently below us
      belowCellId = cells.value[idx + 1].id
    }

    try {
      const result = (await natsService.proxyToolset(
        'move_cell',
        { notebook_path: filePath.value, cell_id: cellId, below_cell_id: belowCellId },
        'notebook',
      )) as Record<string, unknown>
      captureKernelSessionId(result)
      await refreshNotebook()
    } catch (e) {
      console.error('move_cell failed:', e)
    }
    selectedCellId.value = cellId
  }

  /**
   * Change a cell's type. The integrated toolset's `update_cell` doesn't
   * expose a cell_type parameter, so we delete + re-add with the source
   * preserved.
   */
  async function changeCellType(cellId: string, newType: CellType) {
    if (!filePath.value) return
    const cell = cells.value.find((c) => c.id === cellId)
    if (!cell || cell.cell_type === newType) return

    const source = cell.source
    const idx = cells.value.findIndex((c) => c.id === cellId)
    const prevId = cells.value[idx - 1]?.id

    await deleteCell(cellId)
    await addCell(
      newType,
      source,
      prevId ? { relativeTo: prevId, side: 'after' } : undefined,
    )
  }

  // ─────────────────────────────────────────────────────────────────────
  // Execution
  // ─────────────────────────────────────────────────────────────────────

  async function executeCell(cellId: string) {
    if (!filePath.value) return
    const cell = cells.value.find((c) => c.id === cellId)
    if (!cell) return

    if (cell.cell_type === 'markdown') {
      editingMarkdownCells.value.delete(cellId)
      return
    }

    executingCells.value.add(cellId)
    kernelStatus.value = 'busy'
    cellStreamOutputs.value.set(cellId, [])
    lastExecutionError.value = null

    // Flush any pending in-memory edits for this cell to disk BEFORE
    // the adapter reads it back. Monaco's onDidChangeModelContent updates
    // notebook.value.cells[i].source synchronously, but the actual
    // update_cell RPC is debounced 500ms — so clicking Run within that
    // window would execute the stale on-disk version.
    const target = notebook.value?.cells.find((c) => c.id === cellId)
    if (target && target.cell_type === 'code') {
      const src = Array.isArray(target.source) ? target.source.join('') : (target.source ?? '')
      await updateCell(cellId, src)
    }

    try {
      const result = (await natsService.proxyToolset(
        'execute_cell',
        { notebook_path: filePath.value, cell_id: cellId },
        'notebook',
      )) as Record<string, unknown>

      // Capture kernel_session_id so IOPub streaming is wired for subsequent runs.
      captureKernelSessionId(result)

      if (result && result.success === false) {
        lastExecutionError.value = (result.error as string) || 'Cell execution failed'
      }

      if (notebook.value) {
        const target = notebook.value.cells.find((c) => c.id === cellId)
        if (target && result) {
          target.outputs = (result.outputs as CellOutput[]) || target.outputs
          target.execution_count =
            (result.execution_count as number) || target.execution_count
        }
      }
    } catch (e) {
      console.error('Cell execution error:', e)
      lastExecutionError.value = (e as Error).message
    } finally {
      executingCells.value.delete(cellId)
      if (executingCells.value.size === 0) {
        kernelStatus.value = lastExecutionError.value ? 'unknown' : 'idle'
      }
    }
  }

  async function runAll() {
    for (const cell of cells.value) {
      if (cell.cell_type !== 'code') continue
      if (lastExecutionError.value) break
      await executeCell(cell.id)
    }
  }

  async function runBelow() {
    if (!selectedCellId.value) return runAll()
    const startIdx = cells.value.findIndex((c) => c.id === selectedCellId.value)
    if (startIdx < 0) return
    for (let i = startIdx; i < cells.value.length; i++) {
      const c = cells.value[i]
      if (c.cell_type !== 'code') continue
      if (lastExecutionError.value) break
      await executeCell(c.id)
    }
  }

  async function runAndAdvance(cellId?: string) {
    const id = cellId ?? selectedCellId.value
    if (!id) return
    await executeCell(id)
    const idx = cells.value.findIndex((c) => c.id === id)
    if (idx === cells.value.length - 1) {
      await addCell('code', '', { relativeTo: id, side: 'after' })
    } else if (idx >= 0) {
      selectedCellId.value = cells.value[idx + 1].id
    }
  }

  async function interruptKernel() {
    if (!filePath.value) return
    try {
      const result = (await natsService.proxyToolset(
        'manage_kernel',
        { notebook_path: filePath.value, action: 'interrupt' },
        'notebook',
      )) as Record<string, unknown>
      captureKernelSessionId(result)
    } catch (e) {
      console.warn('interrupt failed:', e)
    }
  }

  async function restartKernel() {
    if (!filePath.value) return
    try {
      kernelStatus.value = 'starting'
      const result = (await natsService.proxyToolset(
        'manage_kernel',
        { notebook_path: filePath.value, action: 'restart' },
        'notebook',
      )) as Record<string, unknown>
      captureKernelSessionId(result)
      variables.value = {}
      kernelStatus.value = 'idle'
    } catch (e) {
      console.warn('restart failed:', e)
      kernelStatus.value = 'unknown'
    }
  }

  async function refreshKernelStatus() {
    if (!filePath.value) return
    try {
      const result = (await natsService.proxyToolset(
        'manage_kernel',
        { notebook_path: filePath.value, action: 'status' },
        'notebook',
      )) as Record<string, unknown>
      captureKernelSessionId(result)
      const status = result?.kernel_status as string | undefined
      if (status) kernelStatus.value = status as KernelStatus
    } catch {
      // No active kernel yet — will be created lazily on first execute_cell.
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Output management (best-effort: backend has no dedicated endpoint,
  // so we mutate locally and refresh by re-saving via update_cell).
  // ─────────────────────────────────────────────────────────────────────

  function clearCellOutputs(cellId: string) {
    const cell = notebook.value?.cells.find((c) => c.id === cellId)
    if (cell) {
      cell.outputs = []
      cell.execution_count = null
    }
    cellStreamOutputs.value.delete(cellId)
    // Persist by re-saving the cell source — backend update_cell is SSOT
    // for source only, so outputs on disk stay until next execution.
    // Users who want a persistent clear can run the cell to overwrite.
  }

  function clearAllOutputs() {
    if (!notebook.value) return
    for (const c of notebook.value.cells) {
      c.outputs = []
      c.execution_count = null
    }
    cellStreamOutputs.value.clear()
  }

  function toggleOutputCollapsed(cellId: string) {
    if (collapsedOutputs.value.has(cellId)) collapsedOutputs.value.delete(cellId)
    else collapsedOutputs.value.add(cellId)
  }

  // ─────────────────────────────────────────────────────────────────────
  // Clipboard
  // ─────────────────────────────────────────────────────────────────────

  function copyCell(cellId: string) {
    const cell = cells.value.find((c) => c.id === cellId)
    if (!cell) return
    clipboard.value = {
      cell_type: cell.cell_type,
      source: cell.source,
      metadata: cell.metadata,
    }
  }

  async function cutCell(cellId: string) {
    copyCell(cellId)
    await deleteCell(cellId)
  }

  async function pasteCell(afterCellId?: string) {
    if (!clipboard.value) return
    const targetId = afterCellId ?? selectedCellId.value ?? undefined
    await addCell(
      clipboard.value.cell_type as CellType,
      clipboard.value.source,
      targetId ? { relativeTo: targetId, side: 'after' } : undefined,
    )
  }

  function setMarkdownEditing(cellId: string, editing: boolean) {
    if (editing) editingMarkdownCells.value.add(cellId)
    else editingMarkdownCells.value.delete(cellId)
  }

  // ─────────────────────────────────────────────────────────────────────
  // Variables (via manage_kernel action='variables')
  // ─────────────────────────────────────────────────────────────────────

  async function loadVariables() {
    if (!filePath.value) return
    try {
      const result = (await natsService.proxyToolset(
        'manage_kernel',
        { notebook_path: filePath.value, action: 'variables' },
        'notebook',
      )) as { success: boolean; variables?: Record<string, VariableInfo> }
      captureKernelSessionId(result)
      if (result?.success !== false && result?.variables) {
        variables.value = result.variables
      }
    } catch (e) {
      console.warn('loadVariables failed:', e)
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // IOPub stream handler
  // ─────────────────────────────────────────────────────────────────────

  function handleNotebookStream(msg: unknown) {
    const nbMsg = msg as NotebookStreamMessage
    if (nbMsg.type !== 'notebook') return

    const cellId = nbMsg.metadata?.cell_id
    const msgType = nbMsg.data.msg_type
    const content = nbMsg.data.content || {}

    // Kernel lifecycle messages don't carry a cell_id
    if (msgType === 'status') {
      const state = (content.execution_state as KernelStatus) || 'unknown'
      kernelStatus.value = state
      return
    }

    if (!cellId) return

    let output: CellOutput | null = null
    switch (msgType) {
      case 'stream':
        output = {
          output_type: 'stream',
          name: content.name as string,
          text: content.text as string,
        }
        break
      case 'execute_result':
        output = {
          output_type: 'execute_result',
          data: content.data as Record<string, unknown>,
          metadata: content.metadata as Record<string, unknown>,
          execution_count: content.execution_count as number,
        }
        break
      case 'display_data':
        output = {
          output_type: 'display_data',
          data: content.data as Record<string, unknown>,
          metadata: content.metadata as Record<string, unknown>,
        }
        break
      case 'error':
        output = {
          output_type: 'error',
          ename: content.ename as string,
          evalue: content.evalue as string,
          traceback: content.traceback as string[],
        }
        break
    }

    if (output) {
      const existing = cellStreamOutputs.value.get(cellId) || []
      existing.push(output)
      cellStreamOutputs.value.set(cellId, [...existing])
    }
  }

  return {
    // state
    notebook, filePath, version, loading, saving,
    executingCells, variables, cellStreamOutputs,
    kernelSessionId, kernelStatus, lastExecutionError,
    selectedCellId, clipboard, editingMarkdownCells, collapsedOutputs,
    // derived
    cells, cellCount, isBusy, selectedCell,
    // actions
    openNotebook, createNotebook, refreshNotebook, closeNotebook,
    addCell, insertCell, updateCell, deleteCell, moveCell, changeCellType,
    executeCell, runAll, runBelow, runAndAdvance,
    interruptKernel, restartKernel, refreshKernelStatus,
    clearCellOutputs, clearAllOutputs, toggleOutputCollapsed,
    copyCell, cutCell, pasteCell,
    setMarkdownEditing, loadVariables,
  }
})
