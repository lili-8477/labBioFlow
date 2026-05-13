<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useChatStore } from '@/stores/chat'
import { natsService } from '@/services/nats'
import type { TemplateFile } from '@/types'

const chat = useChatStore()
const templates = ref<TemplateFile[]>([])
const loadingTemplates = ref(false)
const harnessBusy = ref(false)

async function toggleHarness() {
  if (harnessBusy.value) return
  harnessBusy.value = true
  try {
    const next = !chat.harnessActive
    await natsService.invoke('set_harness_mode', { enabled: next })
    await chat.refreshHarnessMode()
  } catch (e) {
    console.error('Failed to toggle harness mode:', e)
  } finally {
    harnessBusy.value = false
  }
}

onMounted(async () => {
  if (chat.activeChatId) {
    await chat.loadAgents(chat.activeChatId)
  }
  await chat.refreshHarnessMode()
  loadTemplates()
})

async function loadTemplates() {
  loadingTemplates.value = true
  try {
    const result = await natsService.invoke('list_template_files', {
      file_type: 'teams',
    }) as { success: boolean; files: TemplateFile[] }
    if (result?.success !== false && result?.files) {
      templates.value = result.files
    }
  } catch { /* ignore */ }
  loadingTemplates.value = false
}

async function applyTemplate(template: TemplateFile) {
  if (!chat.activeChatId) return
  try {
    // Read the template first
    const tpl = await natsService.invoke('read_template_file', {
      file_path: template.path,
      resolve_refs: true,
    }) as { success: boolean; content: Record<string, unknown> }
    if (tpl?.success !== false && tpl?.content) {
      await natsService.invoke('setup_team_for_chat', {
        chat_id: chat.activeChatId,
        template_obj: tpl.content,
      })
      await chat.loadAgents(chat.activeChatId)
    }
  } catch (e) {
    console.error('Failed to apply template:', e)
  }
}
</script>

<template>
  <div class="agent-panel">
    <div class="panel-header">
      <span class="title">Agents</span>
    </div>

    <!-- Mode -->
    <div class="section">
      <div class="section-title">Mode</div>
      <div class="mode-card" :class="{ disabled: !chat.harnessInstalled }">
        <div class="mode-row">
          <span class="mode-icon">&#x21BB;</span>
          <div class="mode-info">
            <span class="mode-name">Self-driving</span>
            <span class="mode-desc">
              <template v-if="!chat.harnessInstalled">Tick harness not installed for this workspace.</template>
              <template v-else-if="chat.harnessActive">Hooks active — Stop re-prompts /tick, progress.md auto-commits, every tool call audited.</template>
              <template v-else>Hooks idle — chat behaves as a normal Claude Code session.</template>
            </span>
          </div>
          <button
            class="btn-toggle"
            :class="{ on: chat.harnessActive }"
            :disabled="!chat.harnessInstalled || harnessBusy"
            @click="toggleHarness()"
            :title="chat.harnessActive ? 'Disable self-driving' : 'Enable self-driving'"
          >
            {{ chat.harnessActive ? 'On' : 'Off' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Current agents -->
    <div class="section">
      <div class="section-title">Active Team</div>
      <div v-if="chat.agents.length === 0" class="empty">
        No agents loaded. Select a chat first.
      </div>
      <div v-for="agent in chat.agents" :key="agent.name" class="agent-card">
        <div class="agent-header">
          <span class="agent-icon">{{ agent.icon || '🤖' }}</span>
          <div class="agent-info">
            <span class="agent-name">{{ agent.name }}</span>
            <span v-if="agent.model" class="agent-model">{{ agent.model }}</span>
          </div>
          <button
            class="btn-activate"
            :class="{ active: chat.activeAgent === agent.name }"
            @click="chat.setActiveAgent(agent.name)"
            title="Set as active"
          >
            {{ chat.activeAgent === agent.name ? 'Active' : 'Activate' }}
          </button>
        </div>
        <div v-if="agent.instructions" class="agent-desc">
          {{ agent.instructions.slice(0, 120) }}{{ agent.instructions.length > 120 ? '...' : '' }}
        </div>
        <div v-if="agent.tools.length > 0" class="agent-tools">
          <span v-for="tool in agent.tools.slice(0, 5)" :key="tool" class="tool-tag">
            {{ tool }}
          </span>
          <span v-if="agent.tools.length > 5" class="tool-more">
            +{{ agent.tools.length - 5 }} more
          </span>
        </div>
      </div>
    </div>

    <!-- Templates -->
    <div class="section">
      <div class="section-title">
        Team Templates
        <button class="refresh-btn" @click="loadTemplates">&#8635;</button>
      </div>
      <div v-if="loadingTemplates" class="empty">Loading...</div>
      <div v-else-if="templates.length === 0" class="empty">No templates found.</div>
      <div
        v-for="tpl in templates"
        :key="tpl.path"
        class="template-item"
        @click="applyTemplate(tpl)"
      >
        <span class="tpl-name">{{ tpl.name }}</span>
        <span class="tpl-apply">Apply</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-panel { display: flex; flex-direction: column; height: 100%; overflow-y: auto; }
.panel-header {
  padding: 12px 16px; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg-secondary); z-index: 5;
}
.title { font-weight: 600; font-size: 0.9em; }

.section { padding: 12px 16px; border-bottom: 1px solid var(--border); }
.section-title {
  font-size: 0.8em; font-weight: 600; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.5px;
  margin-bottom: 8px; display: flex; align-items: center; gap: 8px;
}
.refresh-btn {
  background: transparent; border: none; color: var(--text-muted);
  font-size: 0.9em; cursor: pointer;
}

.empty { color: var(--text-muted); font-size: 0.85em; padding: 4px 0; }

.agent-card {
  padding: 10px 12px; background: var(--bg-primary);
  border: 1px solid var(--border); border-radius: var(--radius);
  margin-bottom: 8px;
}
.agent-header { display: flex; align-items: center; gap: 8px; }
.agent-icon { font-size: 1.4em; }
.agent-info { flex: 1; min-width: 0; }
.agent-name { font-weight: 600; font-size: 0.9em; display: block; }
.agent-model {
  font-size: 0.75em; color: var(--text-muted); font-family: var(--font-mono);
}

.btn-activate {
  padding: 3px 10px; background: transparent;
  border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text-secondary); font-size: 0.75em;
}
.btn-activate:hover { border-color: var(--accent); color: var(--accent); }
.btn-activate.active {
  background: var(--accent); border-color: var(--accent); color: #fff;
}

.agent-desc {
  margin-top: 6px; font-size: 0.8em; color: var(--text-secondary);
  line-height: 1.4;
}

.agent-tools {
  display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;
}
.tool-tag {
  padding: 1px 6px; background: var(--bg-tertiary);
  border-radius: 3px; font-size: 0.7em; color: var(--text-muted);
  font-family: var(--font-mono);
}
.tool-more { font-size: 0.7em; color: var(--text-muted); padding: 1px 4px; }

.template-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 10px; border-radius: var(--radius); cursor: pointer;
  margin-bottom: 4px; transition: background 0.1s;
}
.template-item:hover { background: var(--bg-tertiary); }
.tpl-name { font-size: 0.9em; }
.tpl-apply {
  font-size: 0.75em; color: var(--accent); opacity: 0;
  transition: opacity 0.15s;
}
.template-item:hover .tpl-apply { opacity: 1; }

.mode-card {
  padding: 10px 12px; background: var(--bg-primary);
  border: 1px solid var(--border); border-radius: var(--radius);
}
.mode-card.disabled { opacity: 0.6; }
.mode-row { display: flex; align-items: center; gap: 8px; }
.mode-icon { font-size: 1.4em; line-height: 1; }
.mode-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mode-name { font-weight: 600; font-size: 0.9em; }
.mode-desc { font-size: 0.78em; color: var(--text-secondary); line-height: 1.3; }
.btn-toggle {
  padding: 3px 14px; background: transparent;
  border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text-secondary); font-size: 0.75em; min-width: 48px;
}
.btn-toggle:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.btn-toggle.on {
  background: var(--accent); border-color: var(--accent); color: #fff;
}
.btn-toggle:disabled { cursor: not-allowed; opacity: 0.5; }
</style>
