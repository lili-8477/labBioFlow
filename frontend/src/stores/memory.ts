// bioFlow Memory Store — MIT License

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { memoryService, type ListQuery, type WriteParams } from '@/services/memory'
import type { MemoryListItem, MemoryDetail, MemoryAuditEntry, MemoryType, MemorySource, ScopeTier } from '@/types'

export const useMemoryStore = defineStore('memory', () => {
  const items = ref<MemoryListItem[]>([])
  const loading = ref(false)
  const cursor = ref<string | null>(null)
  const filters = ref<{
    scope?: ScopeTier
    type?: MemoryType[]
    source?: MemorySource
    include_deleted: boolean
    sort: 'created' | 'hit'
  }>({
    include_deleted: false,
    sort: 'created',
  })
  const selected = ref<MemoryDetail | null>(null)
  const audit = ref<MemoryAuditEntry[]>([])
  const editDirty = ref(false)
  const editDraft = ref<{ name: string; description: string; body: string } | null>(null)
  const error = ref<string | null>(null)

  async function loadFirstPage() {
    loading.value = true
    cursor.value = null
    error.value = null
    try {
      const query: ListQuery = {
        ...filters.value,
        cursor: undefined,
      }
      const response = await memoryService.list(query)
      items.value = response.items
      cursor.value = response.next_cursor
    } catch (e) {
      error.value = (e as Error)?.message || 'Failed to load memories'
      items.value = []
    } finally {
      loading.value = false
    }
  }

  async function loadMore() {
    if (cursor.value === null) return
    loading.value = true
    error.value = null
    try {
      const query: ListQuery = {
        ...filters.value,
        cursor: cursor.value,
      }
      const response = await memoryService.list(query)
      items.value = [...items.value, ...response.items]
      cursor.value = response.next_cursor
    } catch (e) {
      error.value = (e as Error)?.message || 'Failed to load more memories'
    } finally {
      loading.value = false
    }
  }

  async function select(id: string) {
    error.value = null
    try {
      const [detail, auditTrail] = await Promise.all([
        memoryService.get(id),
        memoryService.audit(id),
      ])
      selected.value = detail
      audit.value = auditTrail
      editDraft.value = null
      editDirty.value = false
    } catch (e) {
      error.value = (e as Error)?.message || 'Failed to load memory detail'
    }
  }

  async function saveEdit() {
    if (!selected.value || !editDraft.value) return
    error.value = null
    try {
      const response = await memoryService.update({
        memory_id: selected.value.memory_id,
        name: editDraft.value.name,
        description: editDraft.value.description,
        body: editDraft.value.body,
      })
      if (response.ok) {
        // Refetch the selected item and audit trail
        await select(selected.value.memory_id)
        editDraft.value = null
        editDirty.value = false
      }
    } catch (e) {
      error.value = (e as Error)?.message || 'Failed to save memory'
    }
  }

  async function forget(id: string) {
    error.value = null
    try {
      const response = await memoryService.forget(id)
      if (response.ok) {
        // Mark the item as deleted in the local list
        const idx = items.value.findIndex(m => m.memory_id === id)
        if (idx >= 0) {
          items.value[idx].deleted_at = new Date().toISOString()
        }
        // If the selected item was just deleted, refetch it to get the updated state
        if (selected.value?.memory_id === id) {
          await select(id)
        }
      }
    } catch (e) {
      error.value = (e as Error)?.message || 'Failed to forget memory'
    }
  }

  async function restore(id: string) {
    error.value = null
    try {
      const response = await memoryService.restore(id)
      if (response.ok) {
        // Clear deleted_at on the matching item
        const idx = items.value.findIndex(m => m.memory_id === id)
        if (idx >= 0) {
          items.value[idx].deleted_at = null
        }
        // If the selected item was just restored, refetch it
        if (selected.value?.memory_id === id) {
          await select(id)
        }
      }
    } catch (e) {
      error.value = (e as Error)?.message || 'Failed to restore memory'
    }
  }

  async function memorize(p: WriteParams) {
    error.value = null
    try {
      const response = await memoryService.write(p)
      if (response.memory_id) {
        // Reload the first page to include the newly created memory
        await loadFirstPage()
      }
    } catch (e) {
      error.value = (e as Error)?.message || 'Failed to write memory'
    }
  }

  function startEdit() {
    if (!selected.value) return
    editDraft.value = {
      name: selected.value.name,
      description: selected.value.description,
      body: selected.value.body,
    }
    editDirty.value = false
  }

  function cancelEdit() {
    editDraft.value = null
    editDirty.value = false
  }

  function setFilter(f: Partial<typeof filters.value>) {
    Object.assign(filters.value, f)
    loadFirstPage()
  }

  return {
    items,
    loading,
    cursor,
    filters,
    selected,
    audit,
    editDirty,
    editDraft,
    error,
    loadFirstPage,
    loadMore,
    select,
    saveEdit,
    forget,
    restore,
    memorize,
    startEdit,
    cancelEdit,
    setFilter,
  }
})
