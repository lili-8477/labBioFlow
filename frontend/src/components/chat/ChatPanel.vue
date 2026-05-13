<script setup lang="ts">
import { ref, nextTick, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import { useChatStore } from '@/stores/chat'
import { isDisplayableMessage, extractTextContent } from '@/utils/content'
import type { ChatMessage } from '@/types'
import ChatMessageComp from '@/components/chat/ChatMessage.vue'
import ExecutionTimeline from '@/components/chat/ExecutionTimeline.vue'
import HarnessChecklist from '@/components/chat/HarnessChecklist.vue'
import { isImage, makeAttachment, uploadAttachment, discardAttachmentFile, type ChatAttachment } from '@/services/chat-attachments'
import { createProjectWithFiles, composeKickoffMessage, type CreatedProject } from '@/services/project-from-drop'
import { queueUpload } from '@/services/upload'
import { isSupported as voiceSupported, startVoice, type VoiceSession } from '@/services/voice'

const chat = useChatStore()
const input = ref('')
const messagesEl = ref<HTMLElement | null>(null)

const attachments = ref<ChatAttachment[]>([])
const isDragging = ref(false)
const dragDepth = ref(0)
const creatingProject = ref(false)
const projectError = ref<string | null>(null)
// A drop creates the project + uploads files, but the kickoff message waits
// here until the user actually hits Send. They can type more context first,
// or just send for the default "what can you do with this" overview.
const pendingProject = ref<CreatedProject | null>(null)
const voiceOn = ref(false)
const voiceSupportedFlag = voiceSupported()
let voiceSession: VoiceSession | null = null
// Text already in the textarea when recording starts; new transcript is
// appended to it so we don't clobber a partially-typed message.
let voiceBaseText = ''

const anyUploading = computed(() => attachments.value.some(a => a.state === 'uploading'))
const hasContent = computed(
  () => (
    input.value.trim().length > 0
    || attachments.value.some(a => a.state === 'done')
    || pendingProject.value !== null
  ) && !anyUploading.value,
)

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

// Assistant turns that emitted only tool_use blocks have no text — skip the
// empty bubble. The timeline rendered below the (now-absent) bubble still
// shows what the agent did.
function hasBubbleBody(msg: ChatMessage): boolean {
  if (msg.role !== 'assistant') return true
  return extractTextContent(msg.content).trim().length > 0
}

function send() {
  if (!hasContent.value || chat.sending) return
  if (voiceOn.value) stopVoice()
  const paths = attachments.value
    .filter(a => a.state === 'done' && a.workspacePath)
    .map(a => a.workspacePath)
  const text = pendingProject.value
    ? composeKickoffMessage(pendingProject.value, input.value.trim())
    : input.value.trim()
  pendingProject.value = null
  chat.sendMessage(text, paths)
  input.value = ''
  clearAttachments()
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

// ---- Image attachments ----

function addFiles(files: FileList | File[]) {
  for (const f of Array.from(files)) {
    if (!isImage(f)) continue
    const att = makeAttachment(f)
    attachments.value.push(att)
    const id = att.id

    // Mutate via the reactive proxy (look up by id) so Vue's `set` trap
    // fires and the chip re-renders. Mutating the local `att` reference
    // updates the underlying object but skips reactivity tracking.
    const patch = (p: Partial<ChatAttachment>) => {
      const cur = attachments.value.find(a => a.id === id)
      if (cur) Object.assign(cur, p)
    }

    uploadAttachment(id, (pct) => patch({ progress: pct }))
      .then(path => patch({ workspacePath: path, state: 'done', progress: 100 }))
      .catch(err => patch({ state: 'error', error: err.message || String(err) }))
  }
}

function removeAttachment(id: string) {
  const idx = attachments.value.findIndex(a => a.id === id)
  if (idx < 0) return
  URL.revokeObjectURL(attachments.value[idx].previewUrl)
  attachments.value.splice(idx, 1)
  discardAttachmentFile(id)
}

function clearAttachments() {
  for (const a of attachments.value) {
    URL.revokeObjectURL(a.previewUrl)
    discardAttachmentFile(a.id)
  }
  attachments.value = []
}

function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  const files: File[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind === 'file') {
      const f = it.getAsFile()
      if (f && isImage(f)) files.push(f)
    }
  }
  if (files.length > 0) {
    e.preventDefault()
    addFiles(files)
  }
}

function onDragEnter(e: DragEvent) {
  if (!hasFilesInDrag(e)) return
  e.preventDefault()
  dragDepth.value++
  isDragging.value = true
}
function onDragOver(e: DragEvent) {
  if (!hasFilesInDrag(e)) return
  e.preventDefault()
}
function onDragLeave(e: DragEvent) {
  if (!hasFilesInDrag(e)) return
  e.preventDefault()
  dragDepth.value = Math.max(0, dragDepth.value - 1)
  if (dragDepth.value === 0) isDragging.value = false
}
function onDrop(e: DragEvent) {
  if (!e.dataTransfer) return
  e.preventDefault()
  dragDepth.value = 0
  isDragging.value = false
  const fileList = e.dataTransfer.files
  if (!fileList || fileList.length === 0) return
  const all = Array.from(fileList)
  // Images keep attaching to the current chat. Anything else (CSV, FASTQ,
  // PDF, …) kicks off a brand-new project in local_projects/ and opens a
  // fresh chat bound to that folder.
  const images = all.filter(isImage)
  const others = all.filter(f => !isImage(f))
  if (images.length > 0) addFiles(images)
  if (others.length > 0) void startProjectFromFiles(others)
}
function hasFilesInDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  // dataTransfer.items isn't reliable across browsers during dragenter, so we
  // accept any drag carrying Files; onDrop decides how to route each file.
  for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true
  return false
}

// ---- Drop-to-project ----

async function startProjectFromFiles(files: File[]) {
  if (creatingProject.value || chat.sending) return
  creatingProject.value = true
  projectError.value = null
  try {
    if (pendingProject.value) {
      // Additional files dropped before the user sent — append them to the
      // pending project rather than creating a second one.
      const proj = pendingProject.value
      for (const f of files) {
        const { promise } = queueUpload(f, proj.projectDir)
        await promise
        proj.files.push({ name: f.name, workspacePath: `${proj.workspaceDir}/${f.name}` })
      }
    } else {
      pendingProject.value = await createProjectWithFiles(files)
    }
  } catch (err) {
    projectError.value = (err as Error)?.message || String(err)
  } finally {
    creatingProject.value = false
  }
}

function discardPendingProject() {
  pendingProject.value = null
}

// ---- Voice ----

function toggleVoice() {
  if (voiceOn.value) stopVoice()
  else startVoiceSession()
}

function startVoiceSession() {
  if (!voiceSupportedFlag) return
  voiceBaseText = input.value
  try {
    voiceSession = startVoice({
      onTranscript: (text) => {
        input.value = (voiceBaseText ? voiceBaseText + ' ' : '') + text
      },
      onError: () => stopVoice(),
      onEnd: () => { voiceOn.value = false; voiceSession = null },
    })
    voiceOn.value = true
  } catch {
    voiceOn.value = false
  }
}

function stopVoice() {
  voiceSession?.stop()
  voiceSession = null
  voiceOn.value = false
}

// If a drag escapes the chat panel and the user releases over an unhandled
// region, the browser would otherwise navigate the tab to the dropped file —
// which unloads the SPA and blanks everything. Swallow window-level drag/drop
// so a stray miss is a no-op instead of a navigation.
function swallow(e: DragEvent) {
  if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
}

// Poll the harness state while self-driving is on. Two cadences:
//   - mode (active/installed) — every 5s, cheap and tells us the marker file
//     is still present (catches container restarts that wipe the flag).
//   - progress.md — every 3s while sending or active, every 8s when idle,
//     so the checklist ticks in near-real-time during a /tick run but doesn't
//     hammer NATS when nothing's happening.
let harnessModeTimer: number | null = null
let harnessProgressTimer: number | null = null

function startHarnessPolling() {
  stopHarnessPolling()
  harnessModeTimer = window.setInterval(() => { void chat.refreshHarnessMode() }, 5000)
  const tick = () => {
    void chat.refreshHarnessProgress()
    const cadence = chat.sending ? 3000 : 8000
    harnessProgressTimer = window.setTimeout(tick, cadence)
  }
  tick()
}
function stopHarnessPolling() {
  if (harnessModeTimer != null) { clearInterval(harnessModeTimer); harnessModeTimer = null }
  if (harnessProgressTimer != null) { clearTimeout(harnessProgressTimer); harnessProgressTimer = null }
}

// React to mode + chat changes. When harness flips on or the user switches
// chats, kick a fresh fetch immediately so the checklist updates without
// waiting for the next poll cycle.
watch(() => chat.harnessActive, (active) => {
  if (active) startHarnessPolling()
  else {
    stopHarnessPolling()
    chat.harnessProgress = null
    chat.harnessProject = null
  }
})
watch(() => chat.activeChatId, () => {
  if (chat.harnessActive) void chat.refreshHarnessProgress()
})

onMounted(() => {
  window.addEventListener('dragover', swallow)
  window.addEventListener('drop', swallow)
  // The first refreshHarnessMode happens via AgentPanel on its own mount,
  // but Chat may render before Agents if it's the visible tab. Do our own
  // first fetch so the banner shows up immediately on a hard refresh.
  void chat.refreshHarnessMode().then(() => {
    if (chat.harnessActive) startHarnessPolling()
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('dragover', swallow)
  window.removeEventListener('drop', swallow)
  stopHarnessPolling()
  voiceSession?.abort()
  clearAttachments()
})

// If the user navigates to a different chat before sending, the pending
// kickoff no longer makes sense — drop it. The project folder + files stay
// on disk; only the unsent kickoff is discarded.
watch(() => chat.activeChatId, (id) => {
  if (pendingProject.value && pendingProject.value.chatId !== id) {
    pendingProject.value = null
  }
})

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
  <div
    class="chat-panel"
    :class="{ 'panel-drag-active': isDragging }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Empty state -->
    <div v-if="!chat.activeChatId" class="empty-state">
      <div class="empty-icon">&#x1F4AC;</div>
      <h3>Select or create a chat</h3>
      <p>Choose a chat from the sidebar or create a new one to get started.</p>
    </div>

    <!-- Chat content -->
    <template v-else>
      <!-- Self-driving banner + live checklist. Pinned above messages so it
           stays visible as the scroll grows. Hidden entirely when the mode
           is off — the chat behaves exactly as before in that case. -->
      <HarnessChecklist
        v-if="chat.harnessActive"
        :progress="chat.harnessProgress"
        :project-name="chat.harnessProject"
      />

      <div ref="messagesEl" class="messages">
        <!-- Rendered messages with inline timelines -->
        <template v-for="(msg, i) in displayMessages" :key="i">
          <ChatMessageComp v-if="hasBubbleBody(msg)" :message="msg" />
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
      <div
        class="input-area"
        :class="{ 'drag-active': isDragging }"
      >
        <div v-if="attachments.length > 0" class="attachment-strip">
          <div
            v-for="a in attachments"
            :key="a.id"
            class="attachment-chip"
            :class="{ 'chip-error': a.state === 'error' }"
            :title="a.state === 'error' ? a.error : a.fileName"
          >
            <img :src="a.previewUrl" alt="" class="chip-thumb" />
            <div v-if="a.state === 'uploading'" class="chip-progress">
              <div class="chip-progress-bar" :style="{ width: a.progress + '%' }"></div>
              <span class="chip-progress-pct">{{ a.progress }}%</span>
            </div>
            <span v-else-if="a.state === 'error'" class="chip-error-icon">!</span>
            <button class="chip-remove" @click="removeAttachment(a.id)" title="Remove">&times;</button>
          </div>
        </div>

        <div v-if="isDragging" class="drop-overlay">
          <div>Drop file</div>
          <div class="drop-overlay-sub">images attach &middot; everything else starts a new project</div>
        </div>

        <div v-if="creatingProject" class="project-status">
          <span class="project-status-spinner"></span>
          <span>Uploading to project…</span>
        </div>
        <div v-else-if="pendingProject" class="project-status">
          <span class="project-status-icon">&#x1F4C1;</span>
          <span>
            Project <code>{{ pendingProject.projectName }}</code> ready &middot;
            {{ pendingProject.files.length }} file{{ pendingProject.files.length === 1 ? '' : 's' }} &middot;
            add context or hit send
          </span>
          <button class="project-status-dismiss" @click="discardPendingProject" title="Discard pending project">&times;</button>
        </div>
        <div v-if="projectError" class="project-status project-status-error">
          <span>Project creation failed: {{ projectError }}</span>
          <button class="project-status-dismiss" @click="projectError = null" title="Dismiss">&times;</button>
        </div>

        <div class="input-row">
          <textarea
            v-model="input"
            class="message-input"
            placeholder="Type a message. Drop an image to attach, or any other file to start a new project."
            @keydown="handleKeydown"
            @paste="handlePaste"
            rows="1"
          ></textarea>
          <button
            v-if="voiceSupportedFlag"
            class="btn-mic"
            :class="{ 'mic-on': voiceOn }"
            :disabled="chat.sending"
            @click="toggleVoice"
            :title="voiceOn ? 'Stop recording' : 'Record voice'"
          >
            <svg v-if="!voiceOn" class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="12" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <line x1="12" y1="18" x2="12" y2="22" />
            </svg>
            <svg v-else class="icon mic-rec" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="12" r="6" />
            </svg>
          </button>
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
  position: relative;
  padding: 12px 16px; border-top: 1px solid var(--border);
  background: var(--bg-secondary);
}
.input-area.drag-active { background: var(--bg-tertiary); }
.drop-overlay {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border: 2px dashed var(--accent);
  border-radius: var(--radius);
  color: var(--accent); font-weight: 600; pointer-events: none;
  z-index: 1;
}
.drop-overlay-sub {
  font-weight: 400; font-size: 0.8em; opacity: 0.85;
}

.project-status {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 8px; padding: 6px 10px;
  background: var(--bg-primary); border: 1px solid var(--border);
  border-radius: var(--radius); font-size: 0.85em; color: var(--text-secondary);
}
.project-status-error {
  border-color: var(--danger); color: var(--danger);
  justify-content: space-between;
}
.project-status code {
  background: var(--bg-tertiary); padding: 0 4px; border-radius: 3px;
  font-size: 0.95em;
}
.project-status-icon { font-size: 1em; }
.project-status-spinner {
  width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.project-status-dismiss {
  background: transparent; border: none; color: inherit;
  cursor: pointer; font-size: 1.1em; line-height: 1; padding: 0 4px;
}

.attachment-strip {
  display: flex; gap: 8px; flex-wrap: wrap;
  margin-bottom: 8px;
}
.attachment-chip {
  position: relative; width: 64px; height: 64px;
  border-radius: var(--radius); overflow: hidden;
  border: 1px solid var(--border); background: var(--bg-primary);
}
.attachment-chip.chip-error { border-color: var(--danger); }
.chip-thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
.chip-progress {
  position: absolute; inset: 0;
  background: color-mix(in srgb, var(--bg-primary) 55%, transparent);
  display: flex; align-items: flex-end; justify-content: center;
  padding-bottom: 4px;
}
.chip-progress-bar {
  position: absolute; left: 0; bottom: 0; height: 3px;
  background: var(--accent);
  transition: width 120ms ease-out;
}
.chip-progress-pct {
  font-size: 0.7em; font-weight: 600;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--bg-primary) 80%, transparent);
  padding: 1px 5px; border-radius: 10px;
}
.chip-error-icon {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--danger) 30%, transparent);
  color: #fff; font-weight: 700;
}
.chip-remove {
  position: absolute; top: 2px; right: 2px;
  width: 18px; height: 18px; border-radius: 50%;
  background: rgba(0,0,0,0.6); color: #fff; border: none;
  font-size: 0.85em; line-height: 1; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.chip-remove:hover { background: rgba(0,0,0,0.85); }

.input-row { display: flex; gap: 8px; align-items: flex-end; position: relative; z-index: 0; }
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

.btn-mic {
  width: 40px; height: 40px; border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--bg-primary);
  color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
}
.btn-mic .icon { width: 20px; height: 20px; }
.btn-mic:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.btn-mic:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-mic.mic-on { background: var(--danger); color: #fff; border-color: var(--danger); }
.btn-mic.mic-on .icon { width: 14px; height: 14px; }
.mic-rec { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
