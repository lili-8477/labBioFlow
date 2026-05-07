// bioFlow Frontend Types — MIT License

export * from './memory'

// ============================================================
// NATS / Connection
// ============================================================

export interface NATSMessage {
  method: string
  parameters: Record<string, unknown>
  correlation_id?: string
}

export interface NATSResponse {
  result?: unknown
  error?: string
}

export interface ConnectionConfig {
  url: string
  serviceId: string
  subjectPrefix?: string
  token?: string
}

// ============================================================
// Chat
// ============================================================

export interface ChatInfo {
  id: string
  name: string
  last_activity_date?: string
  running?: boolean
  project_name?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  _llm_content?: unknown
  id?: string
  tool_use?: ToolUse
  raw_content?: unknown
}

export interface ToolUse {
  id: string
  name: string
  input: Record<string, unknown>
  output?: string
  status?: string
}

export interface StreamChunk {
  type: 'chunk'
  chunk: { type: string; text: string }
  chat_id: string
}

export interface StepMessage {
  type: 'step_message'
  step_message: StepMessageData
  chat_id: string
}

/** Actual step_message payload from bioFlow backend */
export interface StepMessageData {
  role: 'assistant' | 'tool' | 'user' | 'system'
  content?: unknown  // string or structured
  id?: string
  timestamp?: number
  agent_name?: string

  // Assistant messages
  tool_calls?: ToolCallInfo[]
  reasoning_content?: string

  // Tool result messages
  tool_name?: string
  name?: string
  tool_call_id?: string
  raw_content?: unknown

  // Transfer / delegation
  transfer?: boolean

  // Metadata with timing and cost
  _metadata?: {
    start_timestamp?: number
    end_timestamp?: number
    execution_duration?: number
    total_tokens?: number
    input_tokens?: number
    output_tokens?: number
    current_cost?: number
    chain_path?: string[]
  }
}

export interface ToolCallInfo {
  id: string
  function: { name: string; arguments: string }
  type: 'function'
}

/** Processed step for the execution timeline UI */
export interface TimelineStep {
  id: string
  type: 'tool_call' | 'tool_result' | 'assistant' | 'transfer'
  status: 'running' | 'completed' | 'failed'
  name: string         // tool name or agent name
  agentName?: string
  startTime: number
  endTime?: number
  duration?: number     // seconds
  // For tool_call: the arguments
  input?: string
  // For tool_result: the output
  output?: string
  // For assistant: thinking text
  content?: string
  // For transfer: target agent
  targetAgent?: string
  // Cost info
  tokens?: number
  cost?: number
}

export interface ChatFinished {
  type: 'chat_finished'
  chat_id: string
}

export interface BgTaskUpdate {
  type: 'bg_task_update'
  task_id: string
  tool_name: string
  status: string
  agent_name: string
  chat_id: string
}

export type StreamData = StreamChunk | StepMessage | ChatFinished | BgTaskUpdate

export interface StreamMessage {
  type: 'chat' | 'notebook' | 'custom'
  session_id: string
  timestamp: number
  data: StreamData
  metadata?: Record<string, unknown>
}

export interface Suggestion {
  text: string
  category?: string
}

// ============================================================
// Agents / Teams
// ============================================================

export interface AgentInfo {
  name: string
  instructions: string
  tools: string[]
  toolsets: string[]
  icon: string
  not_loaded_toolsets: string[]
  model: string | null
  models: string[]
}

export interface TemplateFile {
  path: string
  name: string
  type: string
}

// ============================================================
// File System
// ============================================================

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modified?: number
  children?: FileEntry[]
}

// ============================================================
// Notebook
// ============================================================

export interface NotebookCell {
  id: string
  cell_type: 'code' | 'markdown' | 'raw'
  source: string
  outputs: CellOutput[]
  execution_count: number | null
  metadata: Record<string, unknown>
}

export interface CellOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error'
  name?: string     // stdout, stderr
  text?: string | string[]
  data?: Record<string, unknown>  // mime-type -> content
  metadata?: Record<string, unknown>
  ename?: string
  evalue?: string
  traceback?: string[]
  execution_count?: number
}

export interface Notebook {
  cells: NotebookCell[]
  metadata: Record<string, unknown>
  nbformat: number
  nbformat_minor: number
}

export interface NotebookInfo {
  file_path: string
  version: number
  cell_count: number
  notebook: Notebook
}

export interface VariableInfo {
  name: string
  type: string
  size?: string
  value?: string
}

/** Kernel lifecycle status */
export type KernelStatus = 'idle' | 'busy' | 'starting' | 'dead' | 'unknown'

/** Per-cell UI mode (Jupyter-style) */
export type CellMode = 'command' | 'edit'

/** Markdown cell display mode */
export type MarkdownMode = 'rendered' | 'editing'

/** Clipboard entry for copy/cut/paste cell operations */
export interface ClipboardCell {
  cell_type: 'code' | 'markdown' | 'raw'
  source: string
  metadata?: Record<string, unknown>
}

/** Snapshot for undo/redo stack */
export interface NotebookSnapshot {
  cells: NotebookCell[]
  timestamp: number
  action: string
}

// ============================================================
// Notebook IOPub streaming
// ============================================================

export interface NotebookStreamMessage {
  type: 'notebook'
  session_id: string
  timestamp: number
  data: {
    msg_type: string
    content: Record<string, unknown>
    header?: Record<string, unknown>
    metadata?: Record<string, unknown>
    parent_header?: Record<string, unknown>
  }
  metadata?: {
    source?: string
    cell_id?: string
    notebook_path?: string
    operated_by?: string
  }
}
