<script setup lang="ts">
import { useShareStore } from '@/stores/share'
import type { ShareRequest, ArtifactKind, ShareStatus } from '@/types/share'

const store = useShareStore()

function kindIcon(kind: ArtifactKind): string {
  if (kind === 'memory') return '◍'
  if (kind === 'skill') return '◑'
  return '◐'
}

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

function statusClass(status: ShareStatus): string {
  const map: Record<ShareStatus, string> = {
    pending: 'status-pending',
    approved: 'status-approved',
    rejected: 'status-rejected',
    withdrawn: 'status-withdrawn',
  }
  return map[status]
}

function snapshotName(item: ShareRequest): string {
  return (item.snapshot_meta as any).name ?? item.artifact_ref
}
</script>

<template>
  <div class="share-list">
    <!-- Error banner -->
    <div v-if="store.error" class="error-banner" role="alert">
      <span class="error-msg">{{ store.error }}</span>
      <button class="link-btn" @click="store.loadFirstPage()">Retry</button>
    </div>

    <!-- Scrollable list -->
    <div class="list-scroll">
      <!-- Empty state -->
      <div v-if="store.items.length === 0 && !store.loading" class="empty">
        <p class="empty-title">
          {{ store.view === 'outbox'
            ? 'You have not submitted any share requests'
            : 'No pending requests' }}
        </p>
      </div>

      <button
        v-for="item in store.items"
        :key="item.share_id"
        class="share-row"
        :class="{ selected: store.selected?.share_id === item.share_id }"
        @click="store.select(item.share_id)"
      >
        <div class="row-main">
          <span class="row-kind">{{ kindIcon(item.artifact_kind) }}</span>
          <span class="row-name">
            {{ item.artifact_kind === 'memory' ? snapshotName(item) : item.artifact_ref }}
          </span>
          <span class="row-time">{{ relTime(item.created_at) }}</span>
        </div>
        <div class="row-sub">
          <span class="row-meta">
            {{ store.view === 'outbox' ? `→ ${item.reviewer}` : `← ${item.requester}` }}
          </span>
          <span class="badge" :class="statusClass(item.status)">{{ item.status }}</span>
        </div>
      </button>

      <!-- Loading indicator -->
      <div v-if="store.loading" class="loading-row">
        <span class="spinner" />
        <span>Loading…</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.share-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* Error banner */
.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: color-mix(in srgb, var(--danger) 12%, var(--bg-secondary));
  border-bottom: 1px solid var(--border);
  font-size: var(--text-xs);
  color: var(--danger);
  flex-shrink: 0;
}
.error-msg { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.link-btn { background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font-size: inherit; flex-shrink: 0; }
.link-btn:hover { text-decoration: underline; }

/* Scroll container */
.list-scroll {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-1) 0;
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-bg);
}
.list-scroll::-webkit-scrollbar { width: 6px; }
.list-scroll::-webkit-scrollbar-track { background: var(--scrollbar-bg); }
.list-scroll::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 3px; }

/* Row */
.share-row {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-left: 3px solid transparent;
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  transition: background 0.1s;
  min-height: 52px;
}
.share-row:hover { background: var(--bg-hover); }
.share-row.selected {
  background: var(--bg-tertiary);
  border-left-color: var(--accent);
}
.share-row.selected .row-name { color: var(--accent); }

/* Row layout */
.row-main {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: 2px;
}
.row-kind {
  font-size: var(--text-sm);
  color: var(--text-muted);
  flex-shrink: 0;
}
.row-name {
  font-size: var(--text-sm);
  font-weight: var(--fw-semi);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.row-time {
  font-size: var(--text-2xs);
  color: var(--text-muted);
  flex-shrink: 0;
  white-space: nowrap;
}

.row-sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.row-meta {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

/* Status badges */
.badge {
  font-size: var(--text-2xs);
  padding: 1px 5px;
  border-radius: var(--radius-pill);
  white-space: nowrap;
  font-weight: var(--fw-medium);
  flex-shrink: 0;
}
.status-pending   { background: var(--accent-soft);   color: var(--accent); }
.status-approved  { background: var(--success-soft);  color: var(--success); }
.status-rejected  { background: var(--danger-soft);   color: var(--danger); }
.status-withdrawn { background: var(--bg-tertiary);   color: var(--text-muted); }

/* Loading */
.loading-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  color: var(--text-muted);
  font-size: var(--text-xs);
}
.spinner {
  display: inline-block;
  width: 10px; height: 10px;
  border: 1.5px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Empty state */
.empty {
  padding: var(--space-6) var(--space-4);
  text-align: center;
  color: var(--text-muted);
}
.empty-title { font-size: var(--text-md); font-weight: var(--fw-semi); margin: 0; }
</style>
