<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{
  x: number
  y: number
  type: 'file' | 'directory'
  shareable?: boolean
}>()

const emit = defineEmits<{
  (e: 'rename'): void
  (e: 'move-to'): void
  (e: 'new-file'): void
  (e: 'new-folder'): void
  (e: 'delete'): void
  (e: 'share'): void
  (e: 'close'): void
}>()

const root = ref<HTMLElement | null>(null)

function onClickOutside(ev: MouseEvent) {
  if (!root.value) return
  if (!root.value.contains(ev.target as Node)) emit('close')
}
function onKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape') emit('close')
}

onMounted(() => {
  document.addEventListener('mousedown', onClickOutside, true)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onClickOutside, true)
  document.removeEventListener('keydown', onKey)
})

function pick(action: 'rename' | 'move-to' | 'new-file' | 'new-folder' | 'delete' | 'share') {
  switch (action) {
    case 'rename': emit('rename'); break
    case 'move-to': emit('move-to'); break
    case 'new-file': emit('new-file'); break
    case 'new-folder': emit('new-folder'); break
    case 'delete': emit('delete'); break
    case 'share': emit('share'); break
  }
  emit('close')
}
</script>

<template>
  <div
    ref="root"
    class="ctx-menu"
    :style="{ left: x + 'px', top: y + 'px' }"
    role="menu"
  >
    <button
      v-if="shareable"
      class="ctx-item ctx-item-accent"
      role="menuitem"
      @click="pick('share')"
    >Share with org</button>
    <div v-if="shareable" class="ctx-sep" />
    <button class="ctx-item" role="menuitem" @click="pick('rename')">Rename</button>
    <button class="ctx-item" role="menuitem" @click="pick('move-to')">Move to…</button>
    <div class="ctx-sep" />
    <button class="ctx-item" role="menuitem" @click="pick('new-file')">
      New File{{ props.type === 'directory' ? ' in this folder' : '' }}
    </button>
    <button class="ctx-item" role="menuitem" @click="pick('new-folder')">
      New Folder{{ props.type === 'directory' ? ' in this folder' : '' }}
    </button>
    <div class="ctx-sep" />
    <button class="ctx-item ctx-danger" role="menuitem" @click="pick('delete')">Delete</button>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 1000;
  min-width: 200px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
  padding: 4px 0;
  font-size: 0.88em;
}
.ctx-item {
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  color: var(--text-primary);
  padding: 6px 12px;
  cursor: pointer;
}
.ctx-item:hover { background: var(--bg-tertiary); }
.ctx-danger { color: var(--danger); }
.ctx-item-accent { color: var(--accent); font-weight: var(--fw-semi); }
.ctx-item-accent:hover { background: var(--accent-soft); }
.ctx-sep {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}
</style>
