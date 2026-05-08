<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useConnectionStore } from '@/stores/connection'
import { useChatStore } from '@/stores/chat'
import { useFileStore } from '@/stores/files'
import ChatSidebar from '@/components/chat/ChatSidebar.vue'
import ChatPanel from '@/components/chat/ChatPanel.vue'
import ModelSelect from '@/components/layout/ModelSelect.vue'
import FileTree from '@/components/files/FileTree.vue'
import FileViewer from '@/components/files/FileViewer.vue'
import NotebookEditor from '@/components/notebook/NotebookEditor.vue'
import AgentPanel from '@/components/agents/AgentPanel.vue'
import MemoryPanel from '@/components/memory/MemoryPanel.vue'
import SharePanel from '@/components/share/SharePanel.vue'
import SkillsPanel from '@/components/skills/SkillsPanel.vue'
import { useNotebookStore } from '@/stores/notebook'
import { useShareStore } from '@/stores/share'
import { useSkillsStore } from '@/stores/skills'

const conn = useConnectionStore()
const chat = useChatStore()
const files = useFileStore()
const nb = useNotebookStore()
const shareStore = useShareStore()
const skillsStore = useSkillsStore()

type RightPanel = 'none' | 'files' | 'notebook' | 'agents' | 'memory' | 'share' | 'skills'

const STORAGE_KEY = 'bioflow-layout'
interface LayoutState {
  sidebarWidth: number
  rightPanelWidth: number
  sidebarCollapsed: boolean
}

const layout = ref<LayoutState>(
  (() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        return {
          sidebarWidth: parsed.sidebarWidth ?? 280,
          rightPanelWidth: parsed.rightPanelWidth ?? 460,
          sidebarCollapsed: !!parsed.sidebarCollapsed,
        }
      }
    } catch { /* ignore */ }
    return { sidebarWidth: 280, rightPanelWidth: 460, sidebarCollapsed: false }
  })(),
)
const rightPanel = ref<RightPanel>('none')

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout.value))
  } catch { /* ignore */ }
}

onMounted(async () => {
  await chat.loadChats()
  files.loadTree()
  shareStore.loadCapabilities()
})

function togglePanel(panel: RightPanel) {
  rightPanel.value = rightPanel.value === panel ? 'none' : panel
  if (rightPanel.value === 'skills') skillsStore.load()
}

function toggleSidebar() {
  layout.value.sidebarCollapsed = !layout.value.sidebarCollapsed
  persist()
}

function closeRightPanel() {
  rightPanel.value = 'none'
}

function handleFileOpen(path: string) {
  if (path.endsWith('.ipynb')) {
    nb.openNotebook(path)
    rightPanel.value = 'notebook'
  } else {
    files.readFile(path)
  }
}

// ── Resizers ──────────────────────────────────────────────────────
let dragging: 'sidebar' | 'right' | null = null
let startX = 0
let startWidth = 0

function startDrag(e: MouseEvent, which: 'sidebar' | 'right') {
  dragging = which
  startX = e.clientX
  startWidth = which === 'sidebar' ? layout.value.sidebarWidth : layout.value.rightPanelWidth
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onMouseMove(e: MouseEvent) {
  if (!dragging) return
  const dx = e.clientX - startX
  if (dragging === 'sidebar') {
    layout.value.sidebarWidth = Math.max(200, Math.min(520, startWidth + dx))
  } else {
    layout.value.rightPanelWidth = Math.max(320, Math.min(900, startWidth - dx))
  }
}

function onMouseUp() {
  if (dragging) {
    dragging = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    persist()
  }
}

onMounted(() => {
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
})
onUnmounted(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
})

const connStatus = computed(() => {
  if (conn.connected) return { label: 'Connected', cls: 'connected' }
  if (conn.connecting) return { label: 'Connecting…', cls: 'reconnecting' }
  return { label: 'Disconnected', cls: '' }
})
</script>

<template>
  <div class="main-layout">
    <!-- Top bar -->
    <header class="topbar">
      <div class="topbar-left">
        <button
          class="sidebar-toggle"
          @click="toggleSidebar"
          :title="layout.sidebarCollapsed ? 'Show chat list' : 'Hide chat list'"
          :aria-label="layout.sidebarCollapsed ? 'Show chat list' : 'Hide chat list'"
        >
          <span class="hamburger">☰</span>
        </button>
        <span class="logo">bioFlow</span>
        <span class="conn-badge" :class="connStatus.cls">
          <span class="status-dot"></span>
          {{ connStatus.label }}
        </span>
      </div>
      <div class="topbar-actions">
        <ModelSelect />
        <span class="divider" />
        <button
          class="tb-btn"
          :class="{ active: rightPanel === 'agents' }"
          @click="togglePanel('agents')"
          title="Agents"
        >Agents</button>
        <button
          class="tb-btn"
          :class="{ active: rightPanel === 'memory' }"
          @click="togglePanel('memory')"
          title="Memory"
        >Memory</button>
        <button
          class="panel-tab tb-btn"
          :class="{ active: rightPanel === 'skills' }"
          @click="togglePanel('skills')"
          title="Skills (per-user)"
        >Skills</button>
        <button
          class="panel-tab tb-btn"
          :class="{ active: rightPanel === 'share' }"
          :title="'Share with the org'"
          @click="togglePanel('share')"
        >Share<span
            v-if="shareStore.capabilities.is_manager && shareStore.capabilities.pending_inbox_count > 0"
            class="panel-tab-badge"
          >{{ shareStore.capabilities.pending_inbox_count }}</span></button>
        <button
          class="tb-btn"
          :class="{ active: rightPanel === 'files' }"
          @click="togglePanel('files')"
          title="Files"
        >Files</button>
        <button
          class="tb-btn"
          :class="{ active: rightPanel === 'notebook' }"
          @click="togglePanel('notebook')"
          title="Notebook"
        >Notebook</button>
        <span class="divider" />
        <button class="tb-btn disconnect" @click="conn.disconnect()" title="Disconnect">
          Disconnect
        </button>
      </div>
    </header>

    <!-- Main content -->
    <div class="content">
      <!-- Left sidebar (collapsible) -->
      <aside
        v-if="!layout.sidebarCollapsed"
        class="sidebar"
        :style="{ width: layout.sidebarWidth + 'px' }"
      >
        <ChatSidebar />
      </aside>
      <div
        v-if="!layout.sidebarCollapsed"
        class="resizer"
        @mousedown="startDrag($event, 'sidebar')"
        title="Drag to resize"
      />

      <main class="chat-main">
        <ChatPanel />
      </main>

      <!-- Right panel (collapsible via topbar buttons or fold button) -->
      <template v-if="rightPanel !== 'none'">
        <div class="resizer resizer-right" @mousedown="startDrag($event, 'right')" title="Drag to resize">
          <button
            class="fold-handle"
            @mousedown.stop
            @click.stop="closeRightPanel"
            :title="`Hide ${rightPanel} panel`"
            :aria-label="`Hide ${rightPanel} panel`"
          >›</button>
        </div>
        <aside class="right-panel" :style="{ width: layout.rightPanelWidth + 'px' }">
          <FileTree v-if="rightPanel === 'files'" @open-file="handleFileOpen" />
          <NotebookEditor v-else-if="rightPanel === 'notebook'" />
          <AgentPanel v-else-if="rightPanel === 'agents'" />
          <MemoryPanel v-else-if="rightPanel === 'memory'" />
          <SharePanel v-else-if="rightPanel === 'share'" />
          <SkillsPanel v-else-if="rightPanel === 'skills'" />
        </aside>
      </template>
    </div>

    <!-- File viewer overlay -->
    <FileViewer v-if="files.openFile" />
  </div>
</template>

<style scoped>
.main-layout { display: flex; flex-direction: column; height: 100%; }

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 44px;
  padding: 0 14px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.topbar-left { display: flex; align-items: center; gap: 10px; }
.sidebar-toggle {
  width: 28px;
  height: 28px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-secondary);
  border-radius: var(--radius);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1.05em;
  line-height: 1;
  transition: all 0.12s;
}
.sidebar-toggle:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border-color: var(--border);
}
.hamburger { font-size: 14px; }

.logo {
  font-family: var(--font-display);
  font-weight: var(--fw-semi);
  font-size: var(--text-lg);
  letter-spacing: -0.015em;
  color: var(--text-primary);
}
.logo::first-letter {
  color: var(--accent);
}

.conn-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.72em;
  background: var(--bg-tertiary);
  color: var(--text-muted);
}
.conn-badge.connected { color: var(--success); }
.conn-badge.reconnecting { color: var(--warning); }
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.conn-badge.reconnecting .status-dot {
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.topbar-actions { display: flex; gap: 4px; align-items: center; }
.tb-btn {
  padding: 4px 12px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius);
  color: var(--text-secondary);
  font-size: 0.82em;
  transition: all 0.12s;
}
.tb-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.tb-btn.active {
  background: var(--bg-tertiary);
  border-color: var(--border);
  color: var(--accent);
}
.tb-btn.disconnect { color: var(--text-muted); }
.tb-btn.disconnect:hover { color: var(--danger); }
.divider {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 4px;
}

.content { display: flex; flex: 1; overflow: hidden; }

.sidebar {
  flex-shrink: 0;
  background: var(--bg-secondary);
  overflow-y: auto;
}
.chat-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }

.right-panel {
  flex-shrink: 0;
  background: var(--bg-secondary);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.resizer {
  position: relative;
  width: 4px;
  background: var(--border);
  cursor: col-resize;
  flex-shrink: 0;
  transition: background 0.1s;
}
.resizer:hover,
.resizer:active {
  background: var(--accent);
}

/* Fold button centered on the right-panel resizer handle */
.resizer-right .fold-handle {
  position: absolute;
  top: 44px;
  left: -11px;
  width: 18px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-right: none;
  border-radius: 10px 0 0 10px;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 0.9em;
  font-weight: 600;
  line-height: 1;
  padding: 0;
  opacity: 0;
  transition: opacity 0.15s, background 0.12s, color 0.12s;
  z-index: 3;
}
.content:hover .resizer-right .fold-handle,
.resizer-right:hover .fold-handle {
  opacity: 1;
}
.resizer-right .fold-handle:hover {
  background: var(--bg-hover);
  color: var(--accent);
}

.panel-tab-badge {
  margin-left: 4px;
  background: var(--accent);
  color: white;
  border-radius: var(--radius-pill);
  padding: 0 6px;
  font-size: var(--text-2xs);
  font-weight: var(--fw-semi);
  display: inline-block;
  min-width: 16px;
  text-align: center;
}
</style>
