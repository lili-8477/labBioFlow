// bioFlow Memory Service — MIT License

import { natsService } from './nats'
import type {
  MemoryListItem, MemoryDetail, MemoryAuditEntry, MemorySearchHit,
  MemoryType, MemorySource, ScopeTier,
} from '@/types'

// ============================================================
// Request types
// ============================================================

export interface ListQuery {
  project_dir?: string
  scope?: ScopeTier
  type?: MemoryType[]
  source?: MemorySource
  include_deleted?: boolean
  sort?: 'created' | 'hit'
  limit?: number
  cursor?: string
}

export interface SearchParams {
  project_dir?: string | null
  query: string
  limit?: number
  types?: string[]
  since?: string
}

export interface WriteParams {
  scope: 'user' | 'project'
  project_dir?: string | null
  type: 'user' | 'feedback' | 'project' | 'reference'
  name: string
  description: string
  body: string
  facets?: Record<string, string[]>
}

export interface UpdateParams {
  memory_id: string
  name: string
  description: string
  body: string
}

// ============================================================
// Response types (unwrapped from adapter)
// ============================================================

export interface ListResponse {
  items: MemoryListItem[]
  next_cursor: string | null
}

export interface WriteResponse {
  memory_id: string | null
}

export interface UpdateResponse {
  ok: boolean
}

export interface ForgetResponse {
  ok: boolean
}

export interface RestoreResponse {
  ok: boolean
}

// ============================================================
// Memory Service
// ============================================================

export const memoryService = {
  /**
   * List memories with pagination and filtering.
   */
  list: async (q: ListQuery): Promise<ListResponse> => {
    const result = await natsService.invoke('memory_list', q as Record<string, unknown>) as { items: MemoryListItem[]; next_cursor: string | null }
    return result
  },

  /**
   * Get a single memory detail including body, facets, and full audit history.
   */
  get: async (id: string): Promise<MemoryDetail> => {
    const result = await natsService.invoke('memory_get', { memory_id: id }) as MemoryDetail
    return result
  },

  /**
   * Search memories by full-text query.
   */
  search: async (p: SearchParams): Promise<MemorySearchHit[]> => {
    const result = await natsService.invoke('memory_search', p as unknown as Record<string, unknown>) as MemorySearchHit[]
    return result
  },

  /**
   * Write a new memory.
   */
  write: async (p: WriteParams): Promise<WriteResponse> => {
    const result = await natsService.invoke('memory_write', p as unknown as Record<string, unknown>) as { memory_id: string | null }
    return result
  },

  /**
   * Update an existing memory's name, description, and body.
   */
  update: async (p: UpdateParams): Promise<UpdateResponse> => {
    const result = await natsService.invoke('memory_update', p as unknown as Record<string, unknown>) as { ok: boolean }
    return result
  },

  /**
   * Soft-delete a memory.
   */
  forget: async (id: string): Promise<ForgetResponse> => {
    const result = await natsService.invoke('memory_forget', { memory_id: id }) as { ok: boolean }
    return result
  },

  /**
   * Restore a soft-deleted memory.
   */
  restore: async (id: string): Promise<RestoreResponse> => {
    const result = await natsService.invoke('memory_restore', { memory_id: id }) as { ok: boolean }
    return result
  },

  /**
   * Get the audit trail for a memory.
   */
  audit: async (id: string): Promise<MemoryAuditEntry[]> => {
    const result = await natsService.invoke('memory_audit', { memory_id: id }) as MemoryAuditEntry[]
    return result
  },
} as const
