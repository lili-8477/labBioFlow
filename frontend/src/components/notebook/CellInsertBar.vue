<script setup lang="ts">
defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{
  (e: 'insert', type: 'code' | 'markdown'): void
}>()
</script>

<template>
  <div class="cell-insert-bar" :class="{ disabled }">
    <div class="line" />
    <div class="buttons">
      <button class="insert-btn" @click="emit('insert', 'code')" title="Insert code cell">+ Code</button>
      <button class="insert-btn" @click="emit('insert', 'markdown')" title="Insert markdown cell">+ Md</button>
    </div>
    <div class="line" />
  </div>
</template>

<style scoped>
.cell-insert-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 14px;
  margin: 2px 0;
  opacity: 0;
  transition: opacity 0.15s, height 0.15s;
}
.cell-insert-bar:hover {
  opacity: 1;
  height: 26px;
}
.line { flex: 1; height: 1px; background: var(--border); opacity: 0.6; }
.buttons { display: flex; gap: 2px; }
.insert-btn {
  padding: 1px 8px;
  font-size: 0.72em;
  background: var(--bg-secondary);
  color: var(--text-muted);
  border: 1px dashed var(--border);
  border-radius: 10px;
  line-height: 1.4;
}
.insert-btn:hover {
  border-color: var(--accent);
  border-style: solid;
  color: var(--accent);
}
</style>
