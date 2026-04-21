<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{
  step: {
    role: string
    content: string
    tool_use?: unknown
  }
}>()

const expanded = ref(false)

const toolUse = computed(() => {
  if (!props.step.tool_use) return null
  const tu = props.step.tool_use as Record<string, unknown>
  return {
    name: tu.name as string || 'unknown',
    input: tu.input || {},
    output: tu.output as string || '',
    status: tu.status as string || '',
  }
})

const summary = computed(() => {
  if (toolUse.value) return `Tool: ${toolUse.value.name}`
  if (props.step.content) {
    const text = props.step.content
    return text.length > 80 ? text.slice(0, 80) + '...' : text
  }
  return 'Agent step'
})
</script>

<template>
  <div class="step-message">
    <div class="step-header" @click="expanded = !expanded">
      <span class="step-icon">{{ expanded ? '&#9660;' : '&#9654;' }}</span>
      <span class="step-summary">{{ summary }}</span>
      <span v-if="toolUse?.status" class="step-status" :class="toolUse.status">
        {{ toolUse.status }}
      </span>
    </div>
    <div v-if="expanded" class="step-detail">
      <div v-if="step.content" class="step-content">{{ step.content }}</div>
      <div v-if="toolUse" class="tool-detail">
        <div class="tool-input">
          <span class="label">Input:</span>
          <pre>{{ JSON.stringify(toolUse.input, null, 2) }}</pre>
        </div>
        <div v-if="toolUse.output" class="tool-output">
          <span class="label">Output:</span>
          <pre>{{ toolUse.output }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.step-message { font-size: 0.85em; margin-bottom: 4px; }
.step-header {
  display: flex; align-items: center; gap: 6px; cursor: pointer;
  padding: 4px 0; color: var(--text-secondary);
}
.step-header:hover { color: var(--text-primary); }
.step-icon { font-size: 0.7em; width: 12px; }
.step-summary { flex: 1; }
.step-status {
  font-size: 0.75em; padding: 1px 6px; border-radius: 10px;
  background: var(--bg-tertiary);
}
.step-status.completed { color: var(--success); }
.step-status.error { color: var(--danger); }

.step-detail {
  padding: 8px 0 8px 18px; color: var(--text-secondary);
}
.step-content { white-space: pre-wrap; margin-bottom: 8px; }
.label { font-weight: 600; color: var(--text-muted); font-size: 0.85em; }
pre {
  background: var(--code-bg); padding: 8px; border-radius: var(--radius);
  overflow-x: auto; font-size: 0.85em; margin-top: 4px;
  font-family: var(--font-mono); border: 1px solid var(--border);
  max-height: 200px;
}
</style>
