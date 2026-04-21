<script setup lang="ts">
import { ref, nextTick, watch, computed } from 'vue'
import { useChatStore } from '@/stores/chat'
import { isDisplayableMessage } from '@/utils/content'
import ChatMessageComp from '@/components/chat/ChatMessage.vue'
import ExecutionTimeline from '@/components/chat/ExecutionTimeline.vue'

const chat = useChatStore()
const input = ref('')
const messagesEl = ref<HTMLElement | null>(null)

const hasContent = computed(() => input.value.trim().length > 0)

// Filter messages for display — hide tool/system messages
const displayMessages = computed(() =>
  chat.messages.filter(m => isDisplayableMessage(m as Record<string, unknown>))
)

// Map from display index to original message index for timeline lookup
const displayToOriginalIndex = computed(() => {
  const map = new Map<number, number>()
  let displayIdx = 0
  for (let i = 0; i < chat.messages.length; i++) {
    if (isDisplayableMessage(chat.messages[i] as Record<string, unknown>)) {
      map.set(displayIdx, i)
      displayIdx++
    }
  }
  return map
})

function getTimelineForDisplayMsg(displayIdx: number) {
  const origIdx = displayToOriginalIndex.value.get(displayIdx)
  if (origIdx == null) return null
  return chat.completedTimelines.get(origIdx) || null
}

function send() {
  if (!hasContent.value || chat.sending) return
  chat.sendMessage(input.value.trim())
  input.value = ''
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

function useSuggestion(text: string) {
  input.value = text
  send()
}

// Auto-scroll
watch(
  [() => chat.messages.length, () => chat.streamingText, () => chat.liveTimeline.length],
  () => {
    nextTick(() => {
      if (messagesEl.value) {
        messagesEl.value.scrollTop = messagesEl.value.scrollHeight
      }
    })
  },
)
</script>

<template>
  <div class="chat-panel">
    <!-- Empty state -->
    <div v-if="!chat.activeChatId" class="empty-state">
      <div class="empty-icon">&#x1F4AC;</div>
      <h3>Select or create a chat</h3>
      <p>Choose a chat from the sidebar or create a new one to get started.</p>
    </div>

    <!-- Chat content -->
    <template v-else>
      <div ref="messagesEl" class="messages">
        <!-- Rendered messages with inline timelines -->
        <template v-for="(msg, i) in displayMessages" :key="i">
          <ChatMessageComp :message="msg" />
          <!-- Show timeline below assistant messages that had tool activity -->
          <ExecutionTimeline
            v-if="msg.role === 'assistant' && getTimelineForDisplayMsg(i)"
            :steps="getTimelineForDisplayMsg(i)!"
          />
        </template>

        <!-- Streaming response -->
        <div v-if="chat.streamingText" class="streaming-msg">
          <ChatMessageComp
            :message="{ role: 'assistant', content: chat.streamingText }"
            :streaming="true"
          />
        </div>

        <!-- Live execution timeline (during streaming) -->
        <ExecutionTimeline
          v-if="chat.liveTimeline.length > 0"
          :steps="chat.liveTimeline"
          :live="true"
        />

        <!-- Sending indicator (no streaming yet) -->
        <div v-if="chat.sending && !chat.streamingText && !chat.isStreaming && chat.liveTimeline.length === 0" class="thinking">
          <div class="thinking-dots">
            <span></span><span></span><span></span>
          </div>
          <span class="thinking-text">Agent is thinking...</span>
        </div>
      </div>

      <!-- Suggestions -->
      <div v-if="chat.suggestions.length > 0 && !chat.sending" class="suggestions">
        <button
          v-for="(s, i) in chat.suggestions.slice(0, 3)"
          :key="i"
          class="suggestion-btn"
          @click="useSuggestion(s.text)"
        >
          {{ s.text }}
        </button>
      </div>

      <!-- Input -->
      <div class="input-area">
        <div class="input-row">
          <textarea
            v-model="input"
            class="message-input"
            placeholder="Type a message..."
            @keydown="handleKeydown"
            rows="1"
          ></textarea>
          <button
            v-if="chat.sending"
            class="btn-stop"
            @click="chat.stopChat()"
            title="Stop"
          >&#9632;</button>
          <button
            v-else
            class="btn-send"
            :disabled="!hasContent"
            @click="send"
            title="Send"
          >&#10148;</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-panel {
  display: flex; flex-direction: column; height: 100%;
  background: var(--bg-primary);
}

.empty-state {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center; color: var(--text-muted);
}
.empty-icon { font-size: 3em; margin-bottom: 16px; opacity: 0.5; }
.empty-state h3 { margin-bottom: 8px; color: var(--text-secondary); }
.empty-state p { font-size: 0.9em; }

.messages { flex: 1; overflow-y: auto; padding: 16px; }

.streaming-msg { opacity: 0.95; }

.thinking {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 0; color: var(--text-muted);
}
.thinking-dots { display: flex; gap: 4px; }
.thinking-dots span {
  width: 6px; height: 6px; background: var(--text-muted);
  border-radius: 50%; animation: bounce 1.4s infinite;
}
.thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes bounce {
  0%, 80%, 100% { transform: translateY(0); }
  40% { transform: translateY(-6px); }
}
.thinking-text { font-size: 0.85em; font-style: italic; }

.suggestions { display: flex; gap: 8px; padding: 8px 16px; flex-wrap: wrap; }
.suggestion-btn {
  padding: 6px 14px; background: var(--bg-secondary);
  border: 1px solid var(--border); border-radius: 20px;
  color: var(--text-secondary); font-size: 0.85em;
  transition: all 0.15s; white-space: nowrap;
}
.suggestion-btn:hover {
  background: var(--bg-tertiary); color: var(--accent); border-color: var(--accent);
}

.input-area {
  padding: 12px 16px; border-top: 1px solid var(--border);
  background: var(--bg-secondary);
}
.input-row { display: flex; gap: 8px; align-items: flex-end; }
.message-input {
  flex: 1; padding: 10px 14px; background: var(--bg-primary);
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  color: var(--text-primary); resize: none;
  min-height: 40px; max-height: 200px;
  font-size: 0.95em; line-height: 1.4;
}
.message-input:focus { outline: none; border-color: var(--accent); }

.btn-send, .btn-stop {
  width: 40px; height: 40px; border-radius: var(--radius);
  border: none; display: flex; align-items: center; justify-content: center;
  font-size: 1.1em;
}
.btn-send { background: var(--accent); color: #fff; }
.btn-send:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-send:hover:not(:disabled) { background: var(--accent-hover); }
.btn-stop { background: var(--danger); color: #fff; }
.btn-stop:hover { opacity: 0.85; }
</style>
