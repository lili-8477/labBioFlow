<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CellOutput } from '@/types'

const props = defineProps<{
  outputs: CellOutput[]
  executing: boolean
  collapsed: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-collapsed'): void
  (e: 'clear'): void
}>()

const scrollMode = ref(false)

// ─── Output helpers ─────────────────────────────────────────────────

function getOutputText(output: CellOutput): string {
  if (output.text) {
    return Array.isArray(output.text) ? output.text.join('') : output.text
  }
  if (output.data?.['text/plain']) {
    const v = output.data['text/plain']
    return Array.isArray(v) ? v.join('') : String(v)
  }
  return ''
}

function getHtmlOutput(output: CellOutput): string | null {
  if (output.data?.['text/html']) {
    const v = output.data['text/html']
    return Array.isArray(v) ? v.join('') : String(v)
  }
  return null
}

function getImageData(output: CellOutput): string | null {
  if (output.data?.['image/png']) return `data:image/png;base64,${output.data['image/png']}`
  if (output.data?.['image/jpeg']) return `data:image/jpeg;base64,${output.data['image/jpeg']}`
  if (output.data?.['image/svg+xml']) {
    const svg = output.data['image/svg+xml']
    const encoded = encodeURIComponent(Array.isArray(svg) ? svg.join('') : String(svg))
    return `data:image/svg+xml,${encoded}`
  }
  return null
}

function getJsonOutput(output: CellOutput): string | null {
  const v = output.data?.['application/json']
  if (v === undefined) return null
  try { return JSON.stringify(v, null, 2) } catch { return null }
}

function cleanTraceback(tb?: string[]): string {
  if (!tb) return ''
  // Strip ANSI color codes so the raw traceback renders readably
  return tb.join('\n').replace(/\u001b\[[0-9;]*m/g, '')
}

const hasOutputs = computed(() => props.outputs && props.outputs.length > 0)
const totalTextLength = computed(() =>
  props.outputs.reduce((n, o) => n + getOutputText(o).length, 0),
)

async function copyAllText() {
  const text = props.outputs.map(getOutputText).filter(Boolean).join('\n')
  if (text) {
    try { await navigator.clipboard.writeText(text) } catch { /* ignore */ }
  }
}
</script>

<template>
  <div v-if="hasOutputs || executing" class="cell-output" :class="{ collapsed, 'scroll-mode': scrollMode }">
    <!-- Control strip (hover) -->
    <div v-if="hasOutputs" class="output-ctrl">
      <button class="ctrl-btn" @click="emit('toggle-collapsed')" :title="collapsed ? 'Expand output' : 'Collapse output'">
        {{ collapsed ? '▸' : '▾' }}
      </button>
      <button v-if="totalTextLength > 500" class="ctrl-btn" @click="scrollMode = !scrollMode" :title="scrollMode ? 'Unconstrained height' : 'Scroll within fixed height'">
        {{ scrollMode ? '↕' : '⇅' }}
      </button>
      <button class="ctrl-btn" @click="copyAllText" title="Copy all output text">⎘</button>
      <button class="ctrl-btn danger" @click="emit('clear')" title="Clear output">×</button>
    </div>

    <div v-if="executing && !hasOutputs" class="exec-placeholder">
      <span class="dot"></span><span class="dot"></span><span class="dot"></span> Running…
    </div>

    <div v-if="!collapsed" class="output-body">
      <div
        v-for="(output, i) in outputs"
        :key="i"
        class="output-item"
        :class="output.output_type"
      >
        <!-- stream -->
        <template v-if="output.output_type === 'stream'">
          <pre class="stream-output" :class="output.name">{{ getOutputText(output) }}</pre>
        </template>

        <!-- execute_result / display_data -->
        <template v-else-if="output.output_type === 'execute_result' || output.output_type === 'display_data'">
          <img v-if="getImageData(output)" :src="getImageData(output)!" class="output-image" alt="output image" />
          <div v-else-if="getHtmlOutput(output)" class="html-output" v-html="getHtmlOutput(output)"></div>
          <pre v-else-if="getJsonOutput(output)" class="json-output">{{ getJsonOutput(output) }}</pre>
          <pre v-else class="text-output">{{ getOutputText(output) }}</pre>
        </template>

        <!-- error -->
        <template v-else-if="output.output_type === 'error'">
          <div class="error-output">
            <div class="error-name">{{ output.ename }}: {{ output.evalue }}</div>
            <pre v-if="output.traceback" class="traceback">{{ cleanTraceback(output.traceback) }}</pre>
          </div>
        </template>
      </div>
    </div>

    <div v-else class="collapsed-note" @click="emit('toggle-collapsed')">
      {{ outputs.length }} output{{ outputs.length === 1 ? '' : 's' }} hidden — click to expand
    </div>
  </div>
</template>

<style scoped>
.cell-output {
  position: relative;
  border: 1px solid var(--border);
  border-top: none;
  border-radius: 0 0 var(--radius) var(--radius);
  background: var(--bg-primary);
  overflow: hidden;
  margin-left: 54px;
}

.output-ctrl {
  position: absolute;
  top: 2px;
  right: 2px;
  display: flex;
  gap: 1px;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 2;
  background: var(--bg-primary);
  padding: 2px;
  border-radius: 4px;
}
.cell-output:hover .output-ctrl { opacity: 1; }
.ctrl-btn {
  width: 22px;
  height: 22px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  border-radius: 3px;
  font-size: 0.85em;
}
.ctrl-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.ctrl-btn.danger:hover { color: var(--danger); }

.exec-placeholder {
  padding: 8px 12px;
  color: var(--text-muted);
  font-size: 0.82em;
  font-style: italic;
  display: flex;
  align-items: center;
  gap: 6px;
}
.exec-placeholder .dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse-dot 1.2s ease-in-out infinite;
}
.exec-placeholder .dot:nth-child(2) { animation-delay: 0.2s; }
.exec-placeholder .dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes pulse-dot {
  0%, 100% { opacity: 0.3; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1.2); }
}

.output-body { padding: 2px 0; }
.output-item { padding: 6px 12px; }
.output-item + .output-item { border-top: 1px solid var(--border); }

pre {
  font-family: var(--font-mono);
  font-size: 0.82em;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  line-height: 1.45;
}
.cell-output.scroll-mode pre,
.cell-output.scroll-mode .html-output {
  max-height: 320px;
  overflow-y: auto;
}

.stream-output.stderr { color: var(--danger); }
.stream-output.stdout { color: var(--text-primary); }

.text-output { color: var(--text-primary); }
.json-output { color: var(--text-secondary); }

.output-image {
  max-width: 100%;
  border-radius: var(--radius);
  display: block;
}

.html-output { overflow-x: auto; }
.html-output :deep(table) {
  border-collapse: collapse;
  font-size: 0.85em;
  margin: 4px 0;
}
.html-output :deep(td),
.html-output :deep(th) {
  border: 1px solid var(--border);
  padding: 4px 8px;
}
.html-output :deep(th) {
  background: var(--bg-tertiary);
  font-weight: 600;
  color: var(--text-primary);
}

.error-output { color: var(--danger); }
.error-name {
  font-weight: 600;
  margin-bottom: 4px;
  font-family: var(--font-mono);
  font-size: 0.85em;
}
.traceback {
  font-size: 0.78em;
  color: var(--text-secondary);
  max-height: 280px;
  overflow-y: auto;
}

.collapsed-note {
  padding: 6px 12px;
  color: var(--text-muted);
  font-size: 0.78em;
  font-style: italic;
  cursor: pointer;
  user-select: none;
}
.collapsed-note:hover { color: var(--accent); }
</style>
