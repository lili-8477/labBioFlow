<script setup lang="ts">
import { computed } from 'vue'
import { useNotebookStore } from '@/stores/notebook'

const nb = useNotebookStore()

const statusLabel = computed(() => {
  const s = nb.kernelStatus
  if (s === 'busy') return 'Busy'
  if (s === 'idle') return 'Idle'
  if (s === 'starting') return 'Starting'
  if (s === 'dead') return 'Dead'
  // 'unknown' most commonly means the kernel hasn't spawned yet (lazy
  // boot on first execute_cell). Show a softer label so it doesn't read
  // as an error.
  return 'Ready'
})

async function confirmAndRestart() {
  if (window.confirm('Restart the kernel? All variables will be lost.')) {
    await nb.restartKernel()
  }
}

async function confirmClearAll() {
  if (window.confirm('Clear outputs for every cell?')) {
    nb.clearAllOutputs()
  }
}
</script>

<template>
  <div class="nb-toolbar" v-if="nb.notebook">
    <!-- Insert / cell actions group -->
    <div class="group">
      <button
        class="tb-btn"
        @click="nb.insertCell('below', 'code')"
        title="Insert cell below (b)"
      >+ Code</button>
      <button
        class="tb-btn"
        @click="nb.insertCell('below', 'markdown')"
        title="Insert markdown cell below"
      >+ Md</button>
    </div>

    <!-- Clipboard group -->
    <div class="group">
      <button
        class="tb-btn icon-only"
        :disabled="!nb.selectedCellId"
        @click="nb.selectedCellId && nb.cutCell(nb.selectedCellId)"
        title="Cut cell (x)"
      >✂</button>
      <button
        class="tb-btn icon-only"
        :disabled="!nb.selectedCellId"
        @click="nb.selectedCellId && nb.copyCell(nb.selectedCellId)"
        title="Copy cell (c)"
      >⎘</button>
      <button
        class="tb-btn icon-only"
        :disabled="!nb.clipboard"
        @click="nb.pasteCell()"
        title="Paste cell (v)"
      >⎗</button>
      <button
        class="tb-btn icon-only"
        :disabled="!nb.selectedCellId || nb.cells[0]?.id === nb.selectedCellId"
        @click="nb.selectedCellId && nb.moveCell(nb.selectedCellId, 'up')"
        title="Move up (Alt+↑)"
      >↑</button>
      <button
        class="tb-btn icon-only"
        :disabled="!nb.selectedCellId || nb.cells[nb.cells.length - 1]?.id === nb.selectedCellId"
        @click="nb.selectedCellId && nb.moveCell(nb.selectedCellId, 'down')"
        title="Move down (Alt+↓)"
      >↓</button>
    </div>

    <!-- Run group -->
    <div class="group">
      <button
        class="tb-btn primary"
        :disabled="!nb.selectedCellId || nb.isBusy"
        @click="nb.selectedCellId && nb.runAndAdvance(nb.selectedCellId)"
        title="Run and advance (Shift+Enter)"
      >▶ Run</button>
      <button
        class="tb-btn"
        :disabled="nb.isBusy"
        @click="nb.runAll()"
        title="Run all cells"
      >⏩ All</button>
      <button
        class="tb-btn"
        :disabled="nb.isBusy"
        @click="nb.runBelow()"
        title="Run from selected cell down"
      >⇣ Below</button>
      <button
        class="tb-btn warn"
        :disabled="!nb.isBusy"
        @click="nb.interruptKernel()"
        title="Interrupt kernel"
      >■</button>
      <button
        class="tb-btn"
        @click="confirmAndRestart"
        title="Restart kernel"
      >⟳</button>
    </div>

    <!-- Cell type select -->
    <div class="group">
      <select
        class="tb-select"
        :disabled="!nb.selectedCell"
        :value="nb.selectedCell?.cell_type || 'code'"
        @change="(e) => nb.selectedCellId && nb.changeCellType(nb.selectedCellId, (e.target as HTMLSelectElement).value as 'code' | 'markdown')"
        title="Change cell type"
      >
        <option value="code">Code</option>
        <option value="markdown">Markdown</option>
        <option value="raw">Raw</option>
      </select>
    </div>

    <!-- Output control -->
    <div class="group">
      <button
        class="tb-btn"
        :disabled="!nb.selectedCellId"
        @click="nb.selectedCellId && nb.clearCellOutputs(nb.selectedCellId)"
        title="Clear output for selected cell"
      >Clear</button>
      <button
        class="tb-btn"
        @click="confirmClearAll"
        title="Clear all outputs"
      >Clear all</button>
    </div>

    <!-- Status -->
    <div class="status">
      <span class="kernel-dot" :class="nb.kernelStatus"></span>
      <span class="status-text">{{ statusLabel }}</span>
      <span v-if="nb.saving" class="saving">saving…</span>
      <span v-else-if="nb.lastExecutionError" class="err" :title="nb.lastExecutionError">err</span>
    </div>
  </div>
</template>

<style scoped>
.nb-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  position: sticky;
  top: 0;
  z-index: 5;
}
.group {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 8px;
  border-right: 1px solid var(--border);
  margin-right: 4px;
}
.group:last-of-type { border-right: none; }
.tb-btn {
  padding: 4px 8px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-secondary);
  border-radius: 4px;
  font-size: 0.8em;
  line-height: 1.2;
}
.tb-btn:hover:not(:disabled) {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border-color: var(--border);
}
.tb-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.tb-btn.icon-only { min-width: 26px; padding: 4px 6px; text-align: center; }
.tb-btn.primary { color: var(--accent); }
.tb-btn.primary:hover:not(:disabled) { border-color: var(--accent); }
.tb-btn.warn:hover:not(:disabled) { color: var(--warning); border-color: var(--warning); }

.tb-select {
  padding: 3px 6px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  border-radius: 4px;
  font-size: 0.8em;
}

.status {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.78em;
  color: var(--text-muted);
}
.kernel-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
  transition: background 0.2s;
}
.kernel-dot.idle { background: var(--success); }
.kernel-dot.busy { background: var(--warning); animation: pulse 1s ease-in-out infinite; }
.kernel-dot.starting { background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
.kernel-dot.dead { background: var(--danger); }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.saving { color: var(--accent); font-style: italic; }
.err { color: var(--danger); font-weight: 600; }
</style>
