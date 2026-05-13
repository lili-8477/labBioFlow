<script setup lang="ts">
import { ref, computed } from 'vue'
import type { TimelineStep } from '@/types'

const props = defineProps<{
  steps: TimelineStep[]
  live?: boolean
}>()

const collapsed = ref(true)
const expandedSteps = ref<Set<string>>(new Set())

const hasSteps = computed(() => props.steps.length > 0)

const summary = computed(() => {
  const total = props.steps.length
  const tools = props.steps.filter(s => s.type === 'tool_call' || s.type === 'tool_result')
  const transfers = props.steps.filter(s => s.type === 'transfer')
  const running = props.steps.filter(s => s.status === 'running')
  const failed = props.steps.filter(s => s.status === 'failed')

  const parts: string[] = []
  if (tools.length > 0) parts.push(`${tools.length} tool${tools.length > 1 ? 's' : ''}`)
  if (transfers.length > 0) parts.push(`${transfers.length} delegation${transfers.length > 1 ? 's' : ''}`)
  if (running.length > 0) parts.push(`${running.length} running`)
  if (failed.length > 0) parts.push(`${failed.length} failed`)

  return parts.join(', ') || `${total} step${total > 1 ? 's' : ''}`
})

const totalDuration = computed(() => {
  const durations = props.steps
    .filter(s => s.duration != null)
    .map(s => s.duration!)
  if (durations.length === 0) return null
  return durations.reduce((a, b) => a + b, 0)
})

function toggleStep(id: string) {
  if (expandedSteps.value.has(id)) {
    expandedSteps.value.delete(id)
  } else {
    expandedSteps.value.add(id)
  }
  expandedSteps.value = new Set(expandedSteps.value)  // trigger reactivity
}

function formatDuration(seconds: number | undefined): string {
  if (seconds == null) return ''
  if (seconds < 0.01) return '<0.01s'
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}m ${secs.toFixed(0)}s`
}

function stepIcon(step: TimelineStep): string {
  if (step.type === 'transfer') return '\u2192'       // →
  if (step.status === 'running') return '\u25CB'       // ○
  if (step.status === 'failed') return '\u2717'        // ✗
  return '\u2713'                                       // ✓
}

function stepStatusClass(step: TimelineStep): string {
  return step.status
}
</script>

<template>
  <div v-if="hasSteps" class="execution-timeline" :class="{ live }">
    <!-- Collapse header -->
    <div class="timeline-header" @click="collapsed = !collapsed">
      <span class="toggle-icon">{{ collapsed ? '\u25B6' : '\u25BC' }}</span>
      <span class="timeline-icon">⚙</span>
      <span class="timeline-summary">{{ summary }}</span>
      <span v-if="totalDuration != null" class="timeline-duration">
        {{ formatDuration(totalDuration) }}
      </span>
      <span v-if="live" class="live-badge">LIVE</span>
    </div>

    <!-- Steps list -->
    <div v-if="!collapsed" class="timeline-steps">
      <div class="timeline-line"></div>

      <div
        v-for="step in steps"
        :key="step.id"
        class="timeline-step"
        :class="stepStatusClass(step)"
      >
        <!-- Step dot & connector -->
        <div class="step-dot" :class="stepStatusClass(step)">
          <span>{{ stepIcon(step) }}</span>
        </div>

        <!-- Step content -->
        <div class="step-body">
          <div class="step-row" @click="toggleStep(step.id)">
            <span class="step-name">
              <template v-if="step.type === 'transfer'">
                <span class="transfer-label">delegate to</span>
                <span class="agent-name">{{ step.targetAgent }}</span>
              </template>
              <template v-else>
                {{ step.name }}
              </template>
            </span>
            <span v-if="step.agentName" class="step-agent">{{ step.agentName }}</span>
            <span v-if="step.duration != null" class="step-duration">
              {{ formatDuration(step.duration) }}
            </span>
            <span class="step-status-badge" :class="stepStatusClass(step)">
              {{ step.status }}
            </span>
            <span v-if="step.input || step.output || step.content" class="expand-hint">
              {{ expandedSteps.has(step.id) ? '\u25BC' : '\u25B6' }}
            </span>
          </div>

          <!-- Expanded detail -->
          <div v-if="expandedSteps.has(step.id)" class="step-detail">
            <!-- Input -->
            <div v-if="step.input" class="detail-section">
              <div class="detail-label">Input</div>
              <pre class="detail-content">{{ step.input }}</pre>
            </div>
            <!-- Output -->
            <div v-if="step.output" class="detail-section">
              <div class="detail-label">Output</div>
              <pre class="detail-content" :class="{ error: step.status === 'failed' }">{{ step.output }}</pre>
            </div>
            <!-- Content (reasoning) -->
            <div v-if="step.content" class="detail-section">
              <div class="detail-label">Reasoning</div>
              <pre class="detail-content">{{ step.content }}</pre>
            </div>
            <!-- Metadata -->
            <div v-if="step.tokens || step.cost" class="detail-meta">
              <span v-if="step.tokens">{{ step.tokens }} tokens</span>
              <span v-if="step.cost">${{ step.cost.toFixed(4) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.execution-timeline {
  margin: 4px 0 12px 42px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
  overflow: hidden;
}
.execution-timeline.live {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}

.timeline-header {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 12px; cursor: pointer;
  font-size: 0.82em; color: var(--text-secondary);
  transition: background 0.1s;
}
.timeline-header:hover { background: var(--bg-tertiary); }
.toggle-icon { font-size: 0.7em; width: 10px; color: var(--text-muted); }
.timeline-icon { font-size: 0.9em; }
.timeline-summary { flex: 1; }
.timeline-duration {
  font-family: var(--font-mono); font-size: 0.9em; color: var(--text-muted);
}
.live-badge {
  font-size: 0.65em; font-weight: 700; letter-spacing: 0.5px;
  padding: 1px 5px; border-radius: 3px;
  background: var(--accent); color: #fff;
  animation: pulse-badge 2s infinite;
}
@keyframes pulse-badge {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.timeline-steps {
  position: relative; padding: 4px 12px 8px;
}
.timeline-line {
  position: absolute; left: 24px; top: 0; bottom: 8px;
  width: 1px; background: var(--border);
}

.timeline-step {
  display: flex; gap: 10px; position: relative;
  margin-bottom: 2px;
}

.step-dot {
  width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.65em; z-index: 1; margin-top: 3px;
  background: var(--bg-primary); border: 2px solid var(--border);
}
.step-dot.completed { border-color: var(--success); color: var(--success); }
.step-dot.running {
  border-color: var(--accent); color: var(--accent);
  animation: spin-dot 1.5s linear infinite;
}
.step-dot.failed { border-color: var(--danger); color: var(--danger); }
@keyframes spin-dot {
  0% { border-color: var(--accent); }
  50% { border-color: var(--accent-hover); }
  100% { border-color: var(--accent); }
}

.step-body { flex: 1; min-width: 0; }

.step-row {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 6px; border-radius: 4px; cursor: pointer;
  font-size: 0.82em; transition: background 0.1s;
}
.step-row:hover { background: var(--bg-tertiary); }

.step-name {
  font-family: var(--font-mono); font-weight: 500;
  color: var(--text-primary); white-space: nowrap;
}
.transfer-label { color: var(--text-muted); font-weight: 400; margin-right: 4px; }
.agent-name { color: var(--accent); }

.step-agent {
  font-size: 0.85em; color: var(--text-muted);
  background: var(--bg-tertiary); padding: 0 5px; border-radius: 3px;
  white-space: nowrap;
}
.step-duration {
  font-family: var(--font-mono); font-size: 0.9em;
  color: var(--text-muted); margin-left: auto; white-space: nowrap;
}

.step-status-badge {
  font-size: 0.75em; padding: 0 6px; border-radius: 8px;
  white-space: nowrap;
}
.step-status-badge.completed { color: var(--success); background: color-mix(in srgb, var(--success) 12%, transparent); }
.step-status-badge.running { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.step-status-badge.failed { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }

.expand-hint {
  font-size: 0.6em; color: var(--text-muted); width: 10px;
}

.step-detail {
  padding: 4px 6px 6px 6px;
}
.detail-section { margin-bottom: 6px; }
.detail-label {
  font-size: 0.75em; font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 2px;
}
.detail-content {
  margin: 0; padding: 6px 8px; font-family: var(--font-mono);
  font-size: 0.8em; background: var(--code-bg); border: 1px solid var(--border);
  border-radius: 4px; white-space: pre-wrap; word-break: break-all;
  max-height: 150px; overflow-y: auto; color: var(--text-secondary);
}
.detail-content.error { color: var(--danger); }

.detail-meta {
  display: flex; gap: 12px; font-size: 0.75em; color: var(--text-muted);
  font-family: var(--font-mono); padding-top: 2px;
}
</style>
