<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useShareStore } from '@/stores/share'
import ShareList from './ShareList.vue'
import ShareDetail from './ShareDetail.vue'

const store = useShareStore()

// ── Tab toggle ────────────────────────────────────────────────────────────────

const inboxCount = computed(() => store.capabilities.pending_inbox_count)

function setView(v: 'outbox' | 'inbox') {
  store.setView(v)
}

// ── Split pane (vertical) ─────────────────────────────────────────────────────

const SPLIT_KEY = 'bioflow-share-split'
const splitPercent = ref<number>(
  (() => {
    try {
      const v = localStorage.getItem(SPLIT_KEY)
      if (v !== null) {
        const n = Number(v)
        if (n >= 20 && n <= 80) return n
      }
    } catch { /* ignore */ }
    return 40
  })()
)

let splitDragging = false
let splitStartY = 0
let splitStartPct = 0
let panelEl: HTMLElement | null = null

function onSplitMousedown(e: MouseEvent) {
  splitDragging = true
  splitStartY = e.clientY
  splitStartPct = splitPercent.value
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
}

function onSplitMousemove(e: MouseEvent) {
  if (!splitDragging || !panelEl) return
  const totalH = panelEl.getBoundingClientRect().height
  if (totalH === 0) return
  const dy = e.clientY - splitStartY
  const newPct = splitStartPct + (dy / totalH) * 100
  splitPercent.value = Math.max(20, Math.min(80, newPct))
}

function onSplitMouseup() {
  if (!splitDragging) return
  splitDragging = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  try { localStorage.setItem(SPLIT_KEY, String(Math.round(splitPercent.value))) } catch { /* ignore */ }
}

// ── Mount / unmount ───────────────────────────────────────────────────────────

const splitBodyRef = ref<HTMLElement | null>(null)

onMounted(async () => {
  panelEl = splitBodyRef.value
  await store.loadCapabilities()
  await store.loadFirstPage()

  window.addEventListener('mousemove', onSplitMousemove)
  window.addEventListener('mouseup', onSplitMouseup)
})

onUnmounted(() => {
  // Intentionally do NOT reset store state so the user's view+selection
  // survives navigating away and back.
  window.removeEventListener('mousemove', onSplitMousemove)
  window.removeEventListener('mouseup', onSplitMouseup)
})
</script>

<template>
  <div class="share-panel">
    <!-- ── Header ─────────────────────────────────────────────────── -->
    <div class="panel-header">
      <div class="tab-row" role="tablist" aria-label="Share view">
        <button
          class="scope-tab"
          :class="{ active: store.view === 'outbox' }"
          role="tab"
          :aria-selected="store.view === 'outbox'"
          @click="setView('outbox')"
        >Outbox</button>
        <button
          v-if="store.capabilities.is_manager"
          class="scope-tab"
          :class="{ active: store.view === 'inbox' }"
          role="tab"
          :aria-selected="store.view === 'inbox'"
          @click="setView('inbox')"
        >Inbox<span v-if="inboxCount > 0"> ({{ inboxCount }})</span></button>
      </div>
    </div>

    <!-- ── Dual-pane vertical split ───────────────────────────────── -->
    <div class="split-body" ref="splitBodyRef">
      <!-- List pane (top) -->
      <div
        class="split-pane pane-list"
        :style="{ height: splitPercent + '%' }"
      >
        <ShareList class="pane-fill" />
      </div>

      <!-- Drag handle -->
      <div class="split-resizer" @mousedown.prevent="onSplitMousedown" />

      <!-- Detail pane (bottom) -->
      <div class="split-pane pane-detail">
        <ShareDetail class="pane-fill" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.share-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg-primary);
}

/* ── Header ──────────────────────────────────────────────────────────────── */
.panel-header {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}

.tab-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  flex-wrap: wrap;
}

.scope-tab {
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  background: transparent;
  border: 1px solid transparent;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.1s;
  white-space: nowrap;
}
.scope-tab:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}
.scope-tab.active {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: color-mix(in oklch, var(--accent) 30%, transparent);
  font-weight: var(--fw-medium);
}

/* ── Dual-pane split ─────────────────────────────────────────────────────── */
.split-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.split-pane {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.pane-detail {
  flex: 1; /* takes the remaining space below the list pane */
}

.split-resizer {
  flex-shrink: 0;
  height: 4px;
  background: var(--border);
  cursor: row-resize;
  transition: background 0.1s;
}
.split-resizer:hover,
.split-resizer:active {
  background: var(--accent);
}

.pane-fill {
  height: 100%;
  overflow: hidden;
}
</style>
