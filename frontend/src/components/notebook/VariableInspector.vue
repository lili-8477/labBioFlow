<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useNotebookStore } from '@/stores/notebook'
import type { VariableInfo } from '@/types'

const nb = useNotebookStore()
const query = ref('')
const expanded = ref<Set<string>>(new Set())
const sortKey = ref<'name' | 'type' | 'size'>('name')
const sortAsc = ref(true)

onMounted(() => {
  nb.loadVariables()
})

const filtered = computed<VariableInfo[]>(() => {
  const all = Object.values(nb.variables)
  const q = query.value.trim().toLowerCase()
  const out = q
    ? all.filter((v) => v.name.toLowerCase().includes(q) || v.type.toLowerCase().includes(q))
    : all

  const dir = sortAsc.value ? 1 : -1
  return [...out].sort((a, b) => {
    const ka = String(a[sortKey.value] ?? '')
    const kb = String(b[sortKey.value] ?? '')
    return ka.localeCompare(kb) * dir
  })
})

function toggleSort(key: 'name' | 'type' | 'size') {
  if (sortKey.value === key) sortAsc.value = !sortAsc.value
  else {
    sortKey.value = key
    sortAsc.value = true
  }
}

function toggleRow(name: string) {
  if (expanded.value.has(name)) expanded.value.delete(name)
  else expanded.value.add(name)
}

function typeColor(type: string): string {
  const lc = type.toLowerCase()
  if (/int|float|bool|complex/.test(lc)) return 'var(--warning)'
  if (/str|bytes/.test(lc)) return 'var(--success)'
  if (/list|tuple|set|dict|array|series|dataframe/.test(lc)) return 'var(--accent)'
  if (/none|null/.test(lc)) return 'var(--text-muted)'
  return 'var(--text-secondary)'
}
</script>

<template>
  <div class="variable-inspector">
    <div class="vi-header">
      <span class="title">Variables</span>
      <span class="count">{{ Object.keys(nb.variables).length }}</span>
      <input
        v-model="query"
        class="search"
        placeholder="Filter…"
        @keydown.esc="query = ''"
      />
      <button class="refresh-btn" @click="nb.loadVariables()" title="Refresh">⟳</button>
    </div>

    <div v-if="Object.keys(nb.variables).length === 0" class="empty">
      No variables yet. Execute a cell to populate the kernel namespace.
    </div>
    <div v-else-if="filtered.length === 0" class="empty">
      No matches for “{{ query }}”.
    </div>
    <table v-else class="var-table">
      <thead>
        <tr>
          <th @click="toggleSort('name')" class="sortable">
            Name <span v-if="sortKey === 'name'">{{ sortAsc ? '↑' : '↓' }}</span>
          </th>
          <th @click="toggleSort('type')" class="sortable">
            Type <span v-if="sortKey === 'type'">{{ sortAsc ? '↑' : '↓' }}</span>
          </th>
          <th @click="toggleSort('size')" class="sortable">
            Size <span v-if="sortKey === 'size'">{{ sortAsc ? '↑' : '↓' }}</span>
          </th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="v in filtered" :key="v.name">
          <tr @click="toggleRow(v.name)" class="row">
            <td class="var-name">{{ v.name }}</td>
            <td class="var-type" :style="{ color: typeColor(v.type) }">{{ v.type }}</td>
            <td class="var-size">{{ v.size || '—' }}</td>
            <td class="var-value" :class="{ expanded: expanded.has(v.name) }">
              {{ v.value || '' }}
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.variable-inspector {
  border-bottom: 1px solid var(--border);
  background: var(--bg-primary);
  flex-shrink: 0;
  max-height: 260px;
  overflow-y: auto;
}
.vi-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--bg-secondary);
  z-index: 1;
}
.title { font-weight: 600; font-size: 0.82em; }
.count {
  font-size: 0.7em;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 1px 6px;
  border-radius: 8px;
  font-family: var(--font-mono);
}
.search {
  flex: 1;
  min-width: 80px;
  padding: 3px 8px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-primary);
  font-size: 0.78em;
}
.refresh-btn {
  width: 22px;
  height: 22px;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  border-radius: 4px;
}
.refresh-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }

.empty {
  padding: 14px 12px;
  color: var(--text-muted);
  font-size: 0.82em;
  text-align: center;
  font-style: italic;
}

.var-table {
  width: 100%;
  font-size: 0.82em;
  border-collapse: collapse;
}
.var-table th {
  text-align: left;
  padding: 4px 10px;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  font-weight: 500;
  font-size: 0.82em;
  position: sticky;
  top: 33px;
}
.var-table th.sortable { cursor: pointer; user-select: none; }
.var-table th.sortable:hover { color: var(--text-primary); }
.var-table td {
  padding: 4px 10px;
  border-top: 1px solid var(--border);
  vertical-align: top;
}
.row { cursor: pointer; }
.row:hover td { background: var(--bg-tertiary); }

.var-name { font-family: var(--font-mono); color: var(--accent); }
.var-type { font-family: var(--font-mono); font-size: 0.95em; }
.var-size { color: var(--text-muted); font-family: var(--font-mono); }
.var-value {
  font-family: var(--font-mono);
  color: var(--text-secondary);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.var-value.expanded {
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
