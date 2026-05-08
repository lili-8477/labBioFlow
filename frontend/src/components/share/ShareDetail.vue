<script setup lang="ts">
import { ref, computed } from 'vue'
import { useShareStore } from '@/stores/share'
import { shareService } from '@/services/share'
import type { SkillSnapshotMeta } from '@/types/share'

const store = useShareStore()

const comment = ref('')

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Memory snapshot fields ────────────────────────────────────────────────────

const snap = computed(() => {
  if (!store.selected || store.selected.artifact_kind !== 'memory') return null
  const m = store.selected.snapshot_meta as any
  return {
    name: m.name as string | undefined,
    description: m.description as string | undefined,
    body: m.body as string | undefined,
    type: m.type as string | undefined,
    source: m.source as string | undefined,
    hit_count: m.hit_count as number | undefined,
    facets: (m.facets ?? {}) as Record<string, string[]>,
  }
})

const facetChips = computed(() => {
  if (!snap.value) return []
  const chips: { key: string; value: string }[] = []
  for (const [k, vals] of Object.entries(snap.value.facets)) {
    for (const v of vals) chips.push({ key: k, value: v })
  }
  return chips
})

// ── Promotion result ──────────────────────────────────────────────────────────

const promotionText = computed(() => {
  const pr = store.selected?.promotion_result as any
  if (!pr) return null
  if (store.selected?.artifact_kind === 'skill') {
    return pr.dest_path ? `Installed to ${pr.dest_path}` : 'Skill installed to shared/skills/'
  }
  if (pr.deduped) return `Already in org as memory ${pr.existing_memory_id}`
  return `Promoted to org as memory ${pr.promoted_memory_id}`
})

// ── Capability checks ─────────────────────────────────────────────────────────

const isManager = computed(() => store.capabilities.is_manager)
const isPending = computed(() => store.selected?.status === 'pending')
const isRequester = computed(
  () => store.selected?.requester === store.capabilities.actor_username
)

// ── Actions ───────────────────────────────────────────────────────────────────

async function approve() {
  if (!store.selected) return
  const id = store.selected.share_id
  await store.decide(id, { decision: 'approve', comment: comment.value || undefined })
  comment.value = ''
}

async function reject() {
  if (!store.selected) return
  if (!comment.value) {
    if (!confirm('Reject without a comment?')) return
  }
  const id = store.selected.share_id
  await store.decide(id, { decision: 'reject', comment: comment.value || undefined })
  comment.value = ''
}

async function withdraw() {
  if (!store.selected) return
  if (!confirm('Withdraw this share request?')) return
  await store.withdraw(store.selected.share_id)
}

// ── Skill snapshot ────────────────────────────────────────────────────────────

const skillSnap = computed<SkillSnapshotMeta | null>(() => {
  if (!store.selected || store.selected.artifact_kind !== 'skill') return null
  return store.selected.snapshot_meta as SkillSnapshotMeta
})

const filePreview = ref<{ path: string; body: string } | null>(null)

async function openFile(relPath: string) {
  if (!store.selected) return
  try {
    const body = await shareService.fetchSnapshotFile(store.selected.share_id, relPath)
    filePreview.value = { path: relPath, body }
  } catch (e) {
    filePreview.value = { path: relPath, body: `failed to load: ${(e as Error).message}` }
  }
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <div v-if="!store.selected" class="empty-state">
    <span class="empty-text">Select a request to inspect</span>
  </div>

  <div v-else class="share-detail">
    <div class="detail-scroll">

      <!-- ── Header ──────────────────────────────────────────────── -->
      <div class="detail-header">
        <div class="header-top">
          <h2 class="detail-name">
            {{ store.selected.artifact_kind === 'memory'
              ? ((store.selected.snapshot_meta as any).name ?? store.selected.artifact_ref)
              : store.selected.artifact_ref }}
          </h2>
        </div>

        <!-- Meta line -->
        <div class="header-meta">
          <span class="badge" :class="`status-${store.selected.status}`">{{ store.selected.status }}</span>
          <span class="meta-sep">·</span>
          <span class="meta-item">{{ store.selected.artifact_kind }}</span>
          <span class="meta-sep">·</span>
          <span class="meta-item">requested by <strong>{{ store.selected.requester }}</strong></span>
          <span class="meta-sep">·</span>
          <span class="meta-item">reviewer <strong>{{ store.selected.reviewer }}</strong></span>
          <span class="meta-sep">·</span>
          <span class="meta-item">{{ relTime(store.selected.created_at) }}</span>
          <template v-if="store.selected.decided_at">
            <span class="meta-sep">·</span>
            <span class="meta-item">decided {{ relTime(store.selected.decided_at) }}</span>
          </template>
        </div>

        <!-- Requester note -->
        <p v-if="store.selected.requester_note" class="note">"{{ store.selected.requester_note }}"</p>
      </div>

      <div class="divider" />

      <!-- ── Memory snapshot preview ─────────────────────────────── -->
      <section v-if="store.selected.artifact_kind === 'memory' && snap" class="detail-section">
        <h3 class="section-label">Snapshot</h3>
        <p v-if="snap.description" class="snap-desc">{{ snap.description }}</p>
        <div class="snap-meta">
          <span v-if="snap.type" class="meta-chip">{{ snap.type }}</span>
          <span v-if="snap.source" class="meta-chip">{{ snap.source }}</span>
          <span v-if="snap.hit_count != null" class="meta-chip">{{ snap.hit_count }} hits</span>
        </div>
        <pre v-if="snap.body" class="memory-body">{{ snap.body }}</pre>
        <div v-if="facetChips.length > 0" class="facets">
          <span
            v-for="chip in facetChips"
            :key="chip.key + '=' + chip.value"
            class="facet-chip"
          >{{ chip.key }}={{ chip.value }}</span>
        </div>
      </section>

      <!-- ── Skill snapshot preview ────────────────────────────── -->
      <section v-else-if="store.selected.artifact_kind === 'skill' && skillSnap" class="detail-section">
        <h3 class="section-label">Manifest (SKILL.md)</h3>
        <pre class="manifest-body">{{ skillSnap.manifest }}</pre>

        <h3 class="section-label" style="margin-top: var(--space-4)">Files</h3>
        <ul class="file-list">
          <li v-for="f in skillSnap.files" :key="f.path">
            <button class="file-row" @click="openFile(f.path)">
              <span class="file-path">{{ f.path }}</span>
              <span class="file-size">{{ humanSize(f.size_bytes) }}</span>
            </button>
          </li>
        </ul>

        <div v-if="filePreview" class="file-preview">
          <h4 class="section-label">{{ filePreview.path }}</h4>
          <pre class="manifest-body">{{ filePreview.body }}</pre>
          <button class="close-preview" @click="filePreview = null">Close</button>
        </div>
      </section>

      <!-- ── Folder placeholder (phase 3) ─────────────────────── -->
      <section v-else-if="store.selected.artifact_kind === 'folder'" class="detail-section">
        <p class="preview-unavailable">
          Folder preview not available yet — coming in phase 3.
        </p>
      </section>

      <!-- ── Review comment ─────────────────────────────────────── -->
      <section v-if="store.selected.review_comment != null" class="detail-section">
        <h3 class="section-label">Review comment</h3>
        <p class="note">{{ store.selected.review_comment }}</p>
      </section>

      <!-- ── Promotion result ───────────────────────────────────── -->
      <section v-if="store.selected.promotion_result != null" class="detail-section">
        <h3 class="section-label">Promotion</h3>
        <p class="promo-result">{{ promotionText }}</p>
      </section>

    </div><!-- /detail-scroll -->

    <!-- ── Action bar ──────────────────────────────────────────── -->
    <div class="action-bar">
      <!-- Comment textarea: only for managers on pending requests -->
      <textarea
        v-if="isPending && isManager"
        v-model="comment"
        class="comment-input"
        rows="2"
        placeholder="Review comment (optional for approve, recommended for reject)…"
      />

      <div class="action-buttons">
        <button
          v-if="isPending && isManager"
          class="btn-action btn-approve"
          @click="approve"
        >Approve</button>
        <button
          v-if="isPending && isManager"
          class="btn-action btn-danger"
          @click="reject"
        >Reject</button>
        <button
          v-if="isPending && isRequester"
          class="btn-action btn-withdraw"
          @click="withdraw"
        >Withdraw</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex; align-items: center; justify-content: center; height: 100%;
  color: var(--text-muted);
}
.empty-text { font-size: var(--text-md); }

.share-detail { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

.detail-scroll {
  flex: 1; overflow-y: auto; padding: var(--space-4);
  scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-bg);
}
.detail-scroll::-webkit-scrollbar { width: 6px; }
.detail-scroll::-webkit-scrollbar-track { background: var(--scrollbar-bg); }
.detail-scroll::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 3px; }

/* Header */
.detail-header { margin-bottom: var(--space-3); }
.header-top { margin-bottom: var(--space-2); }
.detail-name {
  font-size: var(--text-xl); font-weight: var(--fw-semi);
  color: var(--text-primary); letter-spacing: -0.01em; line-height: 1.2;
  margin: 0 0 var(--space-2);
}

.header-meta {
  display: flex; align-items: center; gap: var(--space-1);
  flex-wrap: wrap; font-size: var(--text-xs); color: var(--text-muted);
  margin-bottom: var(--space-2);
}
.meta-sep { color: var(--border); }
.meta-item { color: var(--text-secondary); }
.meta-item strong { color: var(--text-primary); font-weight: var(--fw-semi); }

/* Status badges */
.badge {
  font-size: var(--text-2xs); padding: 1px 5px; border-radius: var(--radius-pill);
  white-space: nowrap; font-weight: var(--fw-medium);
}
.status-pending   { background: var(--accent-soft);   color: var(--accent); }
.status-approved  { background: var(--success-soft);  color: var(--success); }
.status-rejected  { background: var(--danger-soft);   color: var(--danger); }
.status-withdrawn { background: var(--bg-tertiary);   color: var(--text-muted); }

.note {
  font-size: var(--text-sm); color: var(--text-secondary);
  font-style: italic; margin: 0 0 var(--space-2);
  border-left: 2px solid var(--border-soft); padding-left: var(--space-2);
}

.divider { border: none; border-top: 1px solid var(--border-soft); margin: var(--space-3) 0; }

.detail-section { margin-bottom: var(--space-4); }
.section-label {
  font-size: var(--text-xs); font-weight: var(--fw-semi); color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: var(--space-2);
}

/* Snapshot */
.snap-desc { font-size: var(--text-sm); color: var(--text-secondary); margin-bottom: var(--space-2); line-height: 1.4; }
.snap-meta { display: flex; gap: var(--space-1); flex-wrap: wrap; margin-bottom: var(--space-2); }
.meta-chip {
  font-size: var(--text-2xs); padding: 1px 6px; border-radius: var(--radius-pill);
  background: var(--bg-tertiary); border: 1px solid var(--border-soft);
  color: var(--text-secondary);
}
.memory-body {
  white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono); font-size: 0.92em;
  background: var(--code-bg); border: 1px solid var(--border-soft); border-radius: var(--radius);
  padding: var(--space-3) var(--space-4); color: var(--text-primary); line-height: 1.55; margin: 0 0 var(--space-2);
}
.facets { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.facet-chip {
  font-family: var(--font-mono); font-size: var(--text-xs); padding: 2px 8px;
  border-radius: var(--radius-pill); background: var(--bg-tertiary);
  border: 1px solid var(--border-soft); color: var(--text-secondary);
}

.preview-unavailable {
  font-size: var(--text-sm); color: var(--text-muted); font-style: italic; margin: 0;
}

/* Promotion result */
.promo-result {
  font-size: var(--text-sm); color: var(--text-secondary);
  font-family: var(--font-mono); margin: 0;
}

/* Action bar */
.action-bar {
  display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-soft); background: var(--bg-secondary); flex-shrink: 0;
}
.comment-input {
  width: 100%; background: var(--bg-primary); border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--text-primary);
  padding: var(--space-2) var(--space-3); font-size: var(--text-sm);
  resize: vertical; transition: border-color 0.15s; font-family: inherit; line-height: 1.4;
}
.comment-input:focus { border-color: var(--accent); outline: none; }

.action-buttons {
  display: flex; gap: var(--space-2);
}
.btn-action {
  padding: var(--space-1) var(--space-3); border-radius: var(--radius);
  font-size: var(--text-sm); border: 1px solid transparent;
  cursor: pointer; transition: background 0.1s, opacity 0.1s;
}
.btn-approve {
  background: var(--success-soft); color: var(--success);
  border-color: color-mix(in oklch, var(--success) 30%, transparent);
}
.btn-approve:hover { background: color-mix(in oklch, var(--success) 22%, transparent); }
.btn-danger {
  background: var(--danger-soft); color: var(--danger);
  border-color: color-mix(in oklch, var(--danger) 30%, transparent);
}
.btn-danger:hover { background: color-mix(in oklch, var(--danger) 22%, transparent); }
.btn-withdraw {
  background: var(--bg-tertiary); color: var(--text-secondary);
  border-color: var(--border);
}
.btn-withdraw:hover { background: var(--bg-hover); color: var(--text-primary); }

/* Skill snapshot preview */
.manifest-body {
  white-space: pre-wrap; word-break: break-word;
  font-family: var(--font-mono); font-size: 0.92em;
  background: var(--code-bg); border: 1px solid var(--border-soft);
  border-radius: var(--radius); padding: var(--space-3) var(--space-4);
  color: var(--text-primary); line-height: 1.55; margin: 0 0 var(--space-2);
  max-height: 240px; overflow: auto;
}
.file-list { list-style: none; padding: 0; margin: 0; }
.file-row {
  width: 100%; display: flex; justify-content: space-between; align-items: center;
  padding: var(--space-1) var(--space-2); border: 1px solid var(--border-soft);
  border-radius: var(--radius); margin-bottom: 2px; background: var(--bg-secondary);
  cursor: pointer; font-family: var(--font-mono); font-size: var(--text-xs);
  text-align: left;
}
.file-row:hover { background: var(--bg-hover); }
.file-path { color: var(--text-primary); }
.file-size { color: var(--text-muted); }
.file-preview { margin-top: var(--space-3); }
.close-preview {
  padding: 2px 8px; border-radius: var(--radius); border: 1px solid var(--border);
  background: var(--bg-secondary); cursor: pointer; font-size: var(--text-2xs);
}
</style>
