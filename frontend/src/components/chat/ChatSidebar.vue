<script setup lang="ts">
import { ref } from 'vue'
import { useChatStore } from '@/stores/chat'
import { formatDate } from '@/utils/format'

const chat = useChatStore()

/** Clean raw XML/tags from chat names that weren't renamed yet */
function cleanName(name: string | undefined): string {
  if (!name) return 'Untitled'
  // Strip XML-like tags: <USER_REQUEST>, <ACTION>, etc.
  let clean = name.replace(/<[^>]+>/g, '').trim()
  // Truncate long names
  if (clean.length > 50) clean = clean.slice(0, 50) + '...'
  return clean || 'Untitled'
}
const editingId = ref<string | null>(null)
const editName = ref('')

async function handleNewChat() {
  const chatId = await chat.createChat()
  if (chatId) chat.selectChat(chatId)
}

function startRename(chatId: string, name: string) {
  editingId.value = chatId
  editName.value = name
}

async function saveRename(chatId: string) {
  if (editName.value.trim()) {
    await chat.updateChatName(chatId, editName.value.trim())
  }
  editingId.value = null
}

async function handleDelete(chatId: string) {
  if (confirm('Delete this chat?')) {
    await chat.deleteChat(chatId)
  }
}
</script>

<template>
  <div class="chat-sidebar">
    <div class="sidebar-header">
      <span class="title">Chats</span>
      <button class="btn-new" @click="handleNewChat" title="New Chat">+</button>
    </div>

    <div class="chat-list">
      <div
        v-for="c in chat.chats"
        :key="c.id"
        class="chat-item"
        :class="{ active: c.id === chat.activeChatId }"
        @click="chat.selectChat(c.id)"
      >
        <div class="chat-item-content">
          <template v-if="editingId === c.id">
            <input
              v-model="editName"
              class="rename-input"
              @keyup.enter="saveRename(c.id)"
              @keyup.escape="editingId = null"
              @blur="saveRename(c.id)"
              @click.stop
              autofocus
            />
          </template>
          <template v-else>
            <div class="chat-name">{{ cleanName(c.name) }}</div>
            <div class="chat-meta">
              <span v-if="c.running" class="running-dot"></span>
              {{ formatDate(c.last_activity_date) }}
            </div>
          </template>
        </div>
        <div class="chat-actions" @click.stop>
          <button class="action-btn" @click="startRename(c.id, c.name || '')" title="Rename">
            &#9998;
          </button>
          <button class="action-btn danger" @click="handleDelete(c.id)" title="Delete">
            &times;
          </button>
        </div>
      </div>

      <div v-if="chat.chats.length === 0" class="empty">
        No chats yet. Click + to start.
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-sidebar { display: flex; flex-direction: column; height: 100%; }
.sidebar-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--border);
}
.title { font-weight: 600; font-size: 0.9em; }
.btn-new {
  width: 28px; height: 28px; background: var(--accent); color: #fff;
  border: none; border-radius: var(--radius); font-size: 1.2em;
  display: flex; align-items: center; justify-content: center;
  line-height: 1;
}
.btn-new:hover { background: var(--accent-hover); }

.chat-list { flex: 1; overflow-y: auto; padding: 4px 8px; }
.chat-item {
  display: flex; align-items: center; padding: 8px 12px;
  border-radius: var(--radius); cursor: pointer;
  margin-bottom: 2px; transition: background 0.1s;
}
.chat-item:hover { background: var(--bg-tertiary); }
.chat-item.active { background: var(--bg-tertiary); border-left: 2px solid var(--accent); }
.chat-item-content { flex: 1; min-width: 0; }
.chat-name {
  font-size: 0.9em; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis;
}
.chat-meta {
  font-size: 0.75em; color: var(--text-muted);
  display: flex; align-items: center; gap: 4px;
}
.running-dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--success);
  display: inline-block; animation: pulse 1.5s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.chat-actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.1s; }
.chat-item:hover .chat-actions { opacity: 1; }
.action-btn {
  width: 24px; height: 24px; background: transparent; border: none;
  color: var(--text-muted); border-radius: 4px; font-size: 0.9em;
  display: flex; align-items: center; justify-content: center;
}
.action-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.action-btn.danger:hover { color: var(--danger); }

.rename-input {
  width: 100%; padding: 2px 4px; background: var(--bg-primary);
  border: 1px solid var(--accent); border-radius: 3px;
  color: var(--text-primary); font-size: 0.9em;
}

.empty {
  padding: 20px 16px; text-align: center;
  color: var(--text-muted); font-size: 0.85em;
}
</style>
