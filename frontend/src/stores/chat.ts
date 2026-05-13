import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { natsService } from '@/services/nats'
import { extractTextContent } from '@/utils/content'
import type {
  ChatInfo, ChatMessage, StreamMessage, StreamChunk,
  StepMessage, ChatFinished, Suggestion, AgentInfo,
  StepMessageData, TimelineStep, HarnessProgress,
} from '@/types'

export const useChatStore = defineStore('chat', () => {
  const chats = ref<ChatInfo[]>([])
  const activeChatId = ref<string | null>(null)
  const messages = ref<ChatMessage[]>([])
  const streamingText = ref('')
  const isStreaming = ref(false)
  const sending = ref(false)
  const suggestions = ref<Suggestion[]>([])
  const agents = ref<AgentInfo[]>([])
  const activeAgent = ref<string | null>(null)

  // Self-driving (tick harness) state. Active = marker file present in the
  // workspace; installed = the orchestrator command is on disk. Progress is
  // parsed from local_projects/<chat-name>/progress.md by the adapter.
  const harnessActive = ref(false)
  const harnessInstalled = ref(false)
  const harnessProgress = ref<HarnessProgress | null>(null)
  // The project dir the adapter actually matched (chat-name path or fallback).
  // Surfaced in the banner so the user can tell which progress.md is being read.
  const harnessProject = ref<string | null>(null)

  // Live timeline steps for the current turn (while agent is running)
  const liveTimeline = ref<TimelineStep[]>([])
  // Completed timelines keyed by the turn index (message index of the assistant message)
  // After chat finishes, liveTimeline is frozen into completedTimelines
  const completedTimelines = ref<Map<number, TimelineStep[]>>(new Map())

  // Track pending tool calls (tool_call_id -> TimelineStep index)
  const pendingToolCalls = new Map<string, number>()

  let chatSubId: string | null = null
  let stepCounter = 0

  const activeChat = computed(() => chats.value.find(c => c.id === activeChatId.value))

  // ---- Chat CRUD ----

  async function loadChats() {
    try {
      const result = await natsService.invoke('list_chats') as { success: boolean; chats: ChatInfo[] }
      if (result?.success) {
        chats.value = result.chats.sort((a, b) => {
          const da = a.last_activity_date || ''
          const db = b.last_activity_date || ''
          return db.localeCompare(da)
        })
      }
    } catch (e) {
      console.warn('Failed to load chats:', e)
    }
  }

  async function createChat(name?: string): Promise<string | null> {
    const result = await natsService.invoke('create_chat', {
      chat_name: name || undefined,
    }) as { success: boolean; chat_id: string }
    if (result?.success) {
      await loadChats()
      return result.chat_id
    }
    return null
  }

  async function deleteChat(chatId: string) {
    await natsService.invoke('delete_chat', { chat_id: chatId })
    if (activeChatId.value === chatId) {
      activeChatId.value = null
      messages.value = []
    }
    await loadChats()
  }

  async function loadMessages(chatId: string) {
    const result = await natsService.invoke('get_chat_messages', {
      chat_id: chatId,
      filter_out_images: false,
    }) as { success: boolean; messages: ChatMessage[] }
    if (result?.success) {
      messages.value = result.messages || []
      // Build timelines from loaded message history
      buildTimelinesFromHistory()
    }
  }

  // ---- Timeline from message history ----
  // When we load messages from the server (not streaming), we can reconstruct
  // timelines from the tool messages that sit between assistant messages.

  function buildTimelinesFromHistory() {
    completedTimelines.value.clear()
    let currentSteps: TimelineStep[] = []
    let lastAssistantIdx = -1

    for (let i = 0; i < messages.value.length; i++) {
      const msg = messages.value[i] as Record<string, unknown>
      const role = msg.role as string

      if (role === 'assistant') {
        // If we had steps accumulated, attach to the previous assistant
        if (currentSteps.length > 0 && lastAssistantIdx >= 0) {
          completedTimelines.value.set(lastAssistantIdx, [...currentSteps])
        }
        currentSteps = []
        lastAssistantIdx = i

        // Check if this assistant message has tool_calls — add as pending steps
        const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined
        if (toolCalls && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            const fn = tc.function as Record<string, unknown> | undefined
            const name = fn?.name as string || 'unknown'
            let input = ''
            try {
              const args = fn?.arguments
              if (typeof args === 'string') {
                const parsed = JSON.parse(args)
                input = JSON.stringify(parsed, null, 2)
              }
            } catch { /* ignore */ }
            currentSteps.push({
              id: (tc.id as string) || `tc_${i}_${currentSteps.length}`,
              type: 'tool_call',
              status: 'completed',  // if in history, it completed
              name,
              agentName: msg.agent_name as string,
              startTime: (msg.timestamp as number) || 0,
              input,
            })
          }
        }
      } else if (role === 'tool') {
        const toolName = (msg.tool_name || msg.name || 'tool') as string
        const meta = msg._metadata as Record<string, unknown> | undefined
        const duration = meta?.execution_duration as number | undefined
        const isTransfer = msg.transfer as boolean

        const output = extractTextContent(msg.content)

        currentSteps.push({
          id: (msg.id as string) || `tool_${i}`,
          type: isTransfer ? 'transfer' : 'tool_result',
          status: 'completed',
          name: isTransfer ? 'call_agent' : toolName,
          targetAgent: isTransfer ? output : undefined,
          startTime: meta?.start_timestamp as number || 0,
          endTime: meta?.end_timestamp as number || 0,
          duration,
          output: isTransfer ? undefined : (output.length > 500 ? output.slice(0, 500) + '...' : output),
          tokens: meta?.total_tokens as number,
          cost: meta?.current_cost as number,
        })
      }
    }
    // Attach last batch
    if (currentSteps.length > 0 && lastAssistantIdx >= 0) {
      completedTimelines.value.set(lastAssistantIdx, [...currentSteps])
    }
  }

  // ---- Chat selection & streaming ----

  async function selectChat(chatId: string) {
    if (chatSubId) {
      natsService.unsubscribe(chatSubId)
      chatSubId = null
    }

    activeChatId.value = chatId
    streamingText.value = ''
    isStreaming.value = false
    liveTimeline.value = []
    completedTimelines.value.clear()
    pendingToolCalls.clear()
    stepCounter = 0

    await loadMessages(chatId)

    chatSubId = natsService.subscribe(`chat_${chatId}`, handleStreamMessage)

    loadAgents(chatId)
    loadSuggestions(chatId)
  }

  async function loadSuggestions(chatId: string) {
    try {
      const result = await natsService.invoke('get_suggestions', { chat_id: chatId }) as {
        success: boolean; suggestions: Suggestion[]
      }
      if (result?.success) suggestions.value = result.suggestions || []
    } catch { /* ignore */ }
  }

  // ---- Stream message handling ----

  function handleStreamMessage(msg: StreamMessage) {
    if (msg.type !== 'chat') return
    const data = msg.data

    switch (data.type) {
      case 'chunk': {
        const chunk = data as StreamChunk
        if (chunk.chunk?.text) {
          streamingText.value += chunk.chunk.text
          isStreaming.value = true
        }
        break
      }
      case 'step_message': {
        const step = data as StepMessage
        if (step.step_message) {
          processStepMessage(step.step_message)
        }
        break
      }
      case 'chat_finished': {
        finishStreaming()
        break
      }
    }
  }

  function processStepMessage(step: StepMessageData) {
    const now = step.timestamp || Date.now() / 1000
    const meta = step._metadata

    if (step.role === 'assistant') {
      // Assistant message with tool_calls => add pending tool steps
      const toolCalls = step.tool_calls || []
      for (const tc of toolCalls) {
        const name = tc.function?.name || 'unknown'
        let input = ''
        try {
          if (tc.function?.arguments) {
            const parsed = JSON.parse(tc.function.arguments)
            input = JSON.stringify(parsed, null, 2)
          }
        } catch { /* ignore */ }

        const idx = liveTimeline.value.length
        liveTimeline.value.push({
          id: tc.id || `live_${stepCounter++}`,
          type: 'tool_call',
          status: 'running',
          name,
          agentName: step.agent_name,
          startTime: now,
          input,
        })
        pendingToolCalls.set(tc.id, idx)
      }

      // If assistant has reasoning, add as an assistant step
      if (step.reasoning_content) {
        liveTimeline.value.push({
          id: `reasoning_${stepCounter++}`,
          type: 'assistant',
          status: 'completed',
          name: step.agent_name || 'Agent',
          startTime: meta?.start_timestamp || now,
          endTime: meta?.end_timestamp || now,
          duration: meta?.execution_duration,
          content: extractTextContent(step.reasoning_content),
          tokens: meta?.total_tokens,
          cost: meta?.current_cost,
        })
      }
    } else if (step.role === 'tool') {
      if (step.transfer) {
        // Agent delegation
        liveTimeline.value.push({
          id: step.id || `transfer_${stepCounter++}`,
          type: 'transfer',
          status: 'completed',
          name: 'call_agent',
          targetAgent: extractTextContent(step.content),
          startTime: meta?.start_timestamp || now,
          endTime: meta?.end_timestamp || now,
          duration: meta?.execution_duration,
        })
      } else {
        // Tool result — try to match with pending tool_call
        const toolCallId = step.tool_call_id
        const pendingIdx = toolCallId ? pendingToolCalls.get(toolCallId) : undefined

        const output = extractTextContent(step.content)
        const isError = output.toLowerCase().includes('error') || output.toLowerCase().includes('traceback')

        if (pendingIdx !== undefined && pendingIdx < liveTimeline.value.length) {
          // Update the pending tool_call step with result
          const existing = liveTimeline.value[pendingIdx]
          existing.status = isError ? 'failed' : 'completed'
          existing.endTime = meta?.end_timestamp || now
          existing.duration = meta?.execution_duration || (existing.endTime - existing.startTime)
          existing.output = output.length > 500 ? output.slice(0, 500) + '...' : output
          pendingToolCalls.delete(toolCallId!)
          // Trigger reactivity
          liveTimeline.value = [...liveTimeline.value]
        } else {
          // No matching pending call — add as standalone result
          liveTimeline.value.push({
            id: step.id || `tool_${stepCounter++}`,
            type: 'tool_result',
            status: isError ? 'failed' : 'completed',
            name: step.tool_name || step.name || 'tool',
            startTime: meta?.start_timestamp || now,
            endTime: meta?.end_timestamp || now,
            duration: meta?.execution_duration,
            output: output.length > 500 ? output.slice(0, 500) + '...' : output,
          })
        }
      }
    }
  }

  function finishStreaming() {
    // Save live timeline to completed, keyed to the message that will be added
    if (liveTimeline.value.length > 0) {
      // The assistant message will be the next one added
      const willBeIdx = messages.value.length
      if (streamingText.value) {
        messages.value.push({ role: 'assistant', content: streamingText.value })
        completedTimelines.value.set(willBeIdx, [...liveTimeline.value])
      }
    } else if (streamingText.value) {
      messages.value.push({ role: 'assistant', content: streamingText.value })
    }

    streamingText.value = ''
    isStreaming.value = false
    sending.value = false
    liveTimeline.value = []
    pendingToolCalls.clear()
    loadChats()
  }

  // ---- Send / Stop ----

  async function sendMessage(content: string, imagePaths: string[] = []) {
    const trimmed = content.trim()
    if (!activeChatId.value || (!trimmed && imagePaths.length === 0)) return
    sending.value = true
    streamingText.value = ''
    liveTimeline.value = []
    pendingToolCalls.clear()
    stepCounter = 0

    // Prepend `[image: <path>]` lines so Claude Code reads them via the Read
    // tool. The agent sees these as part of the user turn alongside the text.
    const prefix = imagePaths.map(p => `[image: ${p}]`).join('\n')
    const fullContent = prefix
      ? (trimmed ? `${prefix}\n${trimmed}` : prefix)
      : trimmed

    messages.value.push({ role: 'user', content: fullContent })

    const chatId = activeChatId.value
    try {
      await natsService.invoke('chat', {
        chat_id: chatId,
        message: [{ role: 'user', content: fullContent }],
      }, 600_000)
    } catch (e) {
      console.error('Chat error:', e)
    }

    if (activeChatId.value === chatId) {
      await loadMessages(chatId)
      streamingText.value = ''
      isStreaming.value = false
      sending.value = false
      liveTimeline.value = []
      pendingToolCalls.clear()
      loadChats()
    }
  }

  async function stopChat() {
    if (!activeChatId.value) return
    const chatId = activeChatId.value
    try {
      await natsService.invoke('stop_chat', { chat_id: chatId })
    } catch { /* ignore */ }
    await loadMessages(chatId)
    streamingText.value = ''
    isStreaming.value = false
    sending.value = false
    liveTimeline.value = []
    pendingToolCalls.clear()
  }

  // ---- Agents ----

  async function loadAgents(chatId: string) {
    try {
      const result = await natsService.invoke('get_agents', { chat_id: chatId }) as {
        success: boolean; agents: AgentInfo[]; can_switch_agents: boolean
      }
      if (result?.success) agents.value = result.agents || []
    } catch { /* ignore */ }
  }

  async function setActiveAgent(agentName: string) {
    if (!activeChatId.value) return
    await natsService.invoke('set_active_agent', {
      chat_name: activeChatId.value,
      agent_name: agentName,
    })
    activeAgent.value = agentName
  }

  async function updateChatName(chatId: string, name: string) {
    await natsService.invoke('update_chat_name', { chat_id: chatId, chat_name: name })
    await loadChats()
  }

  // ---- Self-driving (tick harness) ----

  async function refreshHarnessMode() {
    try {
      const res = await natsService.invoke('get_harness_mode', {}) as {
        success?: boolean; active?: boolean; installed?: boolean
      }
      harnessActive.value = !!res?.active
      harnessInstalled.value = !!res?.installed
    } catch { /* ignore — keep last known values */ }
  }

  async function refreshHarnessProgress() {
    // Pass the chat name as a hint; the adapter falls back to the most
    // recently-modified progress.md if the chat name doesn't match a project
    // dir, so typed-prompt chats also see their plan.
    const name = activeChat.value?.name
    try {
      const res = await natsService.invoke('get_harness_progress', {
        project_name: name,
      }) as {
        success?: boolean; exists?: boolean;
        progress?: HarnessProgress | null;
        project_name?: string | null;
      }
      if (res?.exists) {
        harnessProgress.value = res.progress ?? null
        harnessProject.value = res.project_name ?? null
      } else {
        harnessProgress.value = null
        harnessProject.value = null
      }
    } catch {
      harnessProgress.value = null
      harnessProject.value = null
    }
  }

  return {
    chats, activeChatId, activeChat, messages, streamingText, isStreaming,
    sending, suggestions, agents, activeAgent,
    liveTimeline, completedTimelines,
    harnessActive, harnessInstalled, harnessProgress, harnessProject,
    loadChats, createChat, deleteChat, selectChat, sendMessage,
    stopChat, loadAgents, setActiveAgent, updateChatName,
    refreshHarnessMode, refreshHarnessProgress,
  }
})
