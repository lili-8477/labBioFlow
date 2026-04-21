<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '@/utils/markdown'
import { extractTextContent } from '@/utils/content'
import type { ChatMessage } from '@/types'

const props = defineProps<{
  message: ChatMessage
  streaming?: boolean
}>()

const isUser = computed(() => props.message.role === 'user')
const isTool = computed(() => props.message.role === 'tool')

const textContent = computed(() => extractTextContent(props.message.content))

const renderedContent = computed(() => {
  const text = textContent.value
  if (!text) return ''
  if (isUser.value) return ''  // user text rendered as plain text in template
  try {
    return renderMarkdown(text)
  } catch {
    return text
  }
})

const toolName = computed(() => {
  if (!isTool.value) return ''
  const msg = props.message as unknown as Record<string, unknown>
  return (msg.tool_name || msg.name || 'tool') as string
})
</script>

<template>
  <div class="chat-message" :class="{ user: isUser, assistant: !isUser && !isTool, tool: isTool }">
    <div class="avatar">
      <span v-if="isUser">U</span>
      <span v-else-if="isTool">T</span>
      <span v-else>A</span>
    </div>
    <div class="bubble">
      <!-- Tool message -->
      <template v-if="isTool">
        <div class="tool-label">{{ toolName }}</div>
        <pre v-if="textContent" class="tool-content">{{ textContent.slice(0, 500) }}{{ textContent.length > 500 ? '...' : '' }}</pre>
      </template>
      <!-- User message -->
      <template v-else-if="isUser">
        <div class="content user-text">{{ textContent }}</div>
      </template>
      <!-- Assistant message -->
      <template v-else>
        <div class="content markdown-body" v-html="renderedContent"></div>
        <span v-if="streaming" class="cursor-blink">|</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.chat-message {
  display: flex; gap: 10px; margin-bottom: 16px; max-width: 85%;
}
.chat-message.user { margin-left: auto; flex-direction: row-reverse; }
.chat-message.assistant { margin-right: auto; }
.chat-message.tool { margin-right: auto; max-width: 70%; }

.avatar {
  width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.8em; font-weight: 600;
}
.user .avatar { background: var(--accent); color: #fff; }
.assistant .avatar { background: var(--bg-tertiary); color: var(--text-secondary); }
.tool .avatar { background: var(--bg-tertiary); color: var(--text-muted); font-size: 0.7em; }

.bubble {
  padding: 10px 14px; border-radius: var(--radius-lg);
  line-height: 1.5; min-width: 0;
}
.user .bubble {
  background: var(--accent); color: #fff;
  border-bottom-right-radius: 4px;
}
.assistant .bubble {
  background: var(--bg-secondary); border: 1px solid var(--border);
  border-bottom-left-radius: 4px;
}
.tool .bubble {
  background: var(--bg-tertiary); border: 1px solid var(--border);
  border-bottom-left-radius: 4px; font-size: 0.85em;
}

.user-text { white-space: pre-wrap; word-break: break-word; }

.tool-label {
  font-size: 0.75em; color: var(--text-muted); font-family: var(--font-mono);
  margin-bottom: 4px;
}
.tool-content {
  margin: 0; font-family: var(--font-mono); font-size: 0.8em;
  color: var(--text-secondary); white-space: pre-wrap; word-break: break-all;
  max-height: 120px; overflow-y: auto;
}

.cursor-blink {
  animation: blink 1s step-end infinite; color: var(--accent);
  font-weight: bold;
}
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
</style>
