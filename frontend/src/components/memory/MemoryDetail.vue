<script setup lang="ts">
import { ref, computed } from 'vue'
import { useMemoryStore } from '@/stores/memory'

const store = useMemoryStore()

const confirmedThisSession = ref(false)

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(iso))
}

function actionLabel(action: string): string {
  const map: Record<string, string> = { write: 'Created', update: 'Edited', forget: 'Forgotten', restore: 'Restored' }
  return map[action] ?? action
}

const facetChips = computed(() => {
  if (!store.selected) return []
  const chips: { key: string; value: string }[] = []
  for (const [k, vals] of Object.entries(store.selected.facets)) {
    for (const v of vals) chips.push({ key: k, value: v })
  }
  return chips
})

function diffKeys(before: unknown, after: unknown): string[] {
  if (before == null || after == null) return []
  const b = before as Record<string, unknown>
  const a = after as Record<string, unknown>
  const keys = new Set([...Object.keys(b), ...Object.keys(a)])
  return [...keys].filter(k => JSON.stringify(b[k]) !== JSON.stringify(a[k]))
}

function handleForget() {
  if (!store.selected) return
  if (!confirmedThisSession.value) {
    if (!confirm('Forget this memory? You can restore it later.')) return
    confirmedThisSession.value = true
  }
  store.forget(store.selected.memory_id)
}

function handleRestore() {
  if (!store.selected) return
  if (!confirmedThisSession.value) {
    if (!confirm('Restore this memory?')) return
    confirmedThisSession.value = true
  }
  store.restore(store.selected.memory_id)
}
</script>

<template>
  <div v-if="!store.selected" class="empty-state">
    <span class="empty-text">Select a memory to inspect</span>
  </div>

  <div v-else class="memory-detail">
    <div class="detail-scroll">

      <!-- Header -->
      <div class="detail-header">
        <div class="header-top">
          <h2 class="memory-name font-display">{{ store.selected.name }}</h2>
          <div class="header-timestamps">
            <span class="ts-label">created</span>
            <span class="ts-val">{{ relTime(store.selected.created_at) }}</span>
            <span class="ts-sep">·</span>
            <span class="ts-label">updated</span>
            <span class="ts-val">{{ relTime(store.selected.updated_at) }}</span>
          </div>
        </div>
        <p v-if="store.selected.description" class="memory-desc">{{ store.selected.description }}</p>
        <div class="header-badges">
          <span class="badge badge-scope">[{{ store.selected.scope_tier }}]</span>
          <span class="badge badge-source">{{ store.selected.source === 'distilled' ? '[distilled]' : '[manual]' }}</span>
          <span class="badge badge-type">[{{ store.selected.type }}]</span>
          <span v-if="store.selected.deleted_at !== null" class="badge badge-deleted">[deleted]</span>
        </div>
      </div>

      <div class="divider" />

      <!-- Body -->
      <section class="detail-section">
        <h3 class="section-label">Body</h3>
        <pre class="memory-body">{{ store.selected.body }}</pre>
      </section>

      <!-- Facets -->
      <section v-if="facetChips.length > 0" class="detail-section">
        <h3 class="section-label">Facets</h3>
        <div class="facets">
          <span
            v-for="chip in facetChips"
            :key="chip.key + '=' + chip.value"
            class="facet-chip"
          >{{ chip.key }}={{ chip.value }}</span>
        </div>
      </section>

      <!-- Edit form (user-authored + draft active) -->
      <section
        v-if="store.selected.source === 'user' && store.editDraft !== null"
        class="detail-section edit-form"
      >
        <h3 class="section-label">Edit</h3>
        <div class="form-field">
          <label class="field-label">Name</label>
          <input v-model="store.editDraft.name" class="field-input" @input="store.editDirty = true" />
        </div>
        <div class="form-field">
          <label class="field-label">Description</label>
          <input v-model="store.editDraft.description" class="field-input" @input="store.editDirty = true" />
        </div>
        <div class="form-field">
          <label class="field-label">Body</label>
          <textarea v-model="store.editDraft.body" class="field-textarea" rows="8" @input="store.editDirty = true" />
        </div>
        <div class="form-actions">
          <button class="btn-primary" :disabled="!store.editDirty" @click="store.saveEdit()">Save</button>
          <button class="btn-secondary" @click="store.cancelEdit()">Cancel</button>
        </div>
      </section>

      <!-- Audit trail -->
      <section class="detail-section">
        <details class="audit-details">
          <summary class="section-label audit-summary">History ({{ store.audit.length }})</summary>
          <ul v-if="store.audit.length > 0" class="audit-list">
            <li v-for="entry in store.audit" :key="entry.audit_id" class="audit-entry">
              <div class="audit-main">
                <span class="audit-action">{{ actionLabel(entry.action) }}</span>
                <span class="audit-time">{{ relTime(entry.created_at) }}</span>
                <span class="audit-actor">{{ entry.actor }}</span>
              </div>
              <ul
                v-if="entry.action === 'update' && diffKeys(entry.before, entry.after).length > 0"
                class="audit-diff"
              >
                <li v-for="k in diffKeys(entry.before, entry.after)" :key="k" class="diff-key">
                  {{ k }} changed
                </li>
              </ul>
            </li>
          </ul>
          <p v-else class="audit-empty">No history yet.</p>
        </details>
      </section>

    </div><!-- /detail-scroll -->

    <!-- Action bar -->
    <div class="action-bar">
      <button
        class="btn-action"
        :disabled="store.selected.source !== 'user'"
        :title="store.selected.source !== 'user' ? 'Distilled memories are read-only.' : 'Edit this memory'"
        @click="store.startEdit()"
      >Edit</button>
      <button
        v-if="store.selected.deleted_at === null"
        class="btn-action btn-danger"
        @click="handleForget"
      >Forget</button>
      <button
        v-if="store.selected.deleted_at !== null"
        class="btn-action btn-restore"
        @click="handleRestore"
      >Restore</button>
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex; align-items: center; justify-content: center; height: 100%;
  color: var(--text-muted);
}
.empty-text { font-size: var(--text-md); }

.memory-detail { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

.detail-scroll {
  flex: 1; overflow-y: auto; padding: var(--space-4);
  scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-bg);
}
.detail-scroll::-webkit-scrollbar { width: 6px; }
.detail-scroll::-webkit-scrollbar-track { background: var(--scrollbar-bg); }
.detail-scroll::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 3px; }

.detail-header { margin-bottom: var(--space-3); }
.header-top {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: var(--space-3); margin-bottom: var(--space-2);
}
.memory-name {
  font-family: var(--font-display); font-size: var(--text-xl); font-weight: var(--fw-semi);
  color: var(--text-primary); letter-spacing: -0.01em; line-height: 1.2; flex: 1; min-width: 0;
}
.header-timestamps {
  display: flex; align-items: center; gap: var(--space-1);
  font-size: var(--text-2xs); color: var(--text-muted); flex-shrink: 0; white-space: nowrap;
}
.ts-val { color: var(--text-secondary); }
.memory-desc { font-size: var(--text-sm); color: var(--text-secondary); margin-bottom: var(--space-2); line-height: 1.4; }
.header-badges { display: flex; gap: var(--space-1); flex-wrap: wrap; }

/* Badges — same pattern as MemoryList */
.badge { font-size: var(--text-2xs); padding: 1px 5px; border-radius: var(--radius-pill); white-space: nowrap; font-weight: var(--fw-medium); }
.badge-scope   { background: var(--accent-soft); color: var(--accent); }
.badge-source  { background: var(--success-soft); color: var(--success); }
.badge-type    { background: color-mix(in oklch, var(--info) 14%, transparent); color: var(--info); }
.badge-deleted { background: var(--danger-soft); color: var(--danger); }

.divider { border: none; border-top: 1px solid var(--border-soft); margin: var(--space-3) 0; }

.detail-section { margin-bottom: var(--space-4); }
.section-label {
  font-size: var(--text-xs); font-weight: var(--fw-semi); color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: var(--space-2);
}

.memory-body {
  white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono); font-size: 0.92em;
  background: var(--code-bg); border: 1px solid var(--border-soft); border-radius: var(--radius);
  padding: var(--space-3) var(--space-4); color: var(--text-primary); line-height: 1.55; margin: 0;
}

.facets { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.facet-chip {
  font-family: var(--font-mono); font-size: var(--text-xs); padding: 2px 8px;
  border-radius: var(--radius-pill); background: var(--bg-tertiary);
  border: 1px solid var(--border-soft); color: var(--text-secondary);
}

.edit-form { background: var(--bg-secondary); border-radius: var(--radius); padding: var(--space-3); border: 1px solid var(--border-soft); }
.form-field { margin-bottom: var(--space-3); }
.field-label { display: block; font-size: var(--text-xs); color: var(--text-secondary); margin-bottom: var(--space-1); }
.field-input,
.field-textarea {
  width: 100%; background: var(--bg-primary); border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--text-primary);
  padding: var(--space-2) var(--space-3); font-size: var(--text-sm); transition: border-color 0.15s;
}
.field-input:focus, .field-textarea:focus { border-color: var(--accent); outline: none; }
.field-textarea { resize: vertical; font-family: var(--font-mono); line-height: 1.5; }
.form-actions { display: flex; gap: var(--space-2); }

.audit-details { border: 1px solid var(--border-soft); border-radius: var(--radius); padding: var(--space-2) var(--space-3); }
.audit-summary { cursor: pointer; user-select: none; list-style: none; }
.audit-summary::-webkit-details-marker { display: none; }
.audit-details[open] .audit-summary { margin-bottom: var(--space-2); }
.audit-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.audit-entry { font-size: var(--text-xs); border-left: 2px solid var(--border-soft); padding-left: var(--space-2); }
.audit-main { display: flex; align-items: center; gap: var(--space-2); }
.audit-action { font-weight: var(--fw-semi); color: var(--text-primary); }
.audit-time   { color: var(--text-muted); }
.audit-actor  { color: var(--text-muted); font-style: italic; margin-left: auto; }
.audit-diff { list-style: none; padding: var(--space-1) 0 0 var(--space-2); margin: 0; display: flex; flex-direction: column; gap: 2px; }
.diff-key { font-size: var(--text-2xs); color: var(--text-secondary); }
.diff-key::before { content: '• '; color: var(--text-muted); }
.audit-empty { font-size: var(--text-xs); color: var(--text-muted); margin: var(--space-1) 0 0; }

.action-bar {
  display: flex; gap: var(--space-2); padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-soft); background: var(--bg-secondary); flex-shrink: 0;
}
.btn-primary, .btn-secondary, .btn-action {
  padding: var(--space-1) var(--space-3); border-radius: var(--radius);
  font-size: var(--text-sm); border: 1px solid transparent; transition: background 0.1s, opacity 0.1s;
}
.btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-secondary { background: var(--bg-tertiary); color: var(--text-primary); border-color: var(--border); }
.btn-secondary:hover { background: var(--bg-hover); }
.btn-action { background: var(--bg-tertiary); color: var(--text-primary); border-color: var(--border); }
.btn-action:hover:not(:disabled) { background: var(--bg-hover); }
.btn-action:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-danger { background: var(--danger-soft); color: var(--danger); border-color: color-mix(in oklch, var(--danger) 30%, transparent); }
.btn-danger:hover { background: color-mix(in oklch, var(--danger) 22%, transparent); }
.btn-restore { background: var(--success-soft); color: var(--success); border-color: color-mix(in oklch, var(--success) 30%, transparent); }
.btn-restore:hover { background: color-mix(in oklch, var(--success) 22%, transparent); }
</style>
