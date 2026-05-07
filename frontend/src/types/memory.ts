// bioFlow Memory Types — MIT License

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'session_summary' | 'observation'
export type MemorySource = 'user' | 'distilled'
export type ScopeTier = 'org' | 'user' | 'project'

export interface MemoryListItem {
  memory_id: string
  type: MemoryType
  source: MemorySource
  scope_tier: ScopeTier
  name: string
  description: string
  created_at: string
  updated_at: string
  hit_count: number
  last_hit_at: string | null
  deleted_at: string | null
}

export interface MemoryDetail extends MemoryListItem {
  body: string
  facets: Record<string, string[]>
  source_session_id: string | null
}

export interface MemoryAuditEntry {
  audit_id: number
  action: 'write' | 'update' | 'forget' | 'restore'
  actor: string
  before: unknown
  after: unknown
  created_at: string
}

// Search hit with snippet and relevance score
export interface MemorySearchHit extends MemoryListItem {
  snippet: string
  score: number
}
