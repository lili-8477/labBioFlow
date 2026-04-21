<script setup lang="ts">
import { useConnectionStore } from '@/stores/connection'

const conn = useConnectionStore()

function handleConnect() {
  conn.connect()
}
</script>

<template>
  <div class="dialog-overlay">
    <div class="dialog">
      <div class="dialog-header">
        <h2>Connect to bioFlow</h2>
        <p class="subtitle">Enter your NATS WebSocket endpoint and service ID</p>
      </div>

      <form @submit.prevent="handleConnect" class="dialog-form">
        <div class="field">
          <label>WebSocket URL</label>
          <input
            v-model="conn.url"
            type="text"
            placeholder="wss://example.com/ws/"
            spellcheck="false"
          />
        </div>

        <div class="field">
          <label>Service ID</label>
          <input
            v-model="conn.serviceId"
            type="text"
            placeholder="64-character hex service ID"
            spellcheck="false"
          />
        </div>

        <details class="advanced">
          <summary>Advanced</summary>
          <div class="field">
            <label>Subject Prefix (optional)</label>
            <input v-model="conn.subjectPrefix" type="text" placeholder="e.g. hub_001" />
          </div>
          <div class="field">
            <label>Token (optional)</label>
            <input v-model="conn.token" type="password" placeholder="NATS auth token" />
          </div>
        </details>

        <div v-if="conn.error" class="error">{{ conn.error }}</div>

        <button type="submit" class="btn-primary" :disabled="conn.connecting">
          {{ conn.connecting ? 'Connecting...' : 'Connect' }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.dialog-overlay {
  display: flex; align-items: center; justify-content: center;
  height: 100%; background: var(--bg-primary);
}
.dialog {
  background: var(--bg-secondary); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 32px; width: 440px; max-width: 90vw;
}
.dialog-header { margin-bottom: 24px; }
.dialog-header h2 {
  font-family: var(--font-display);
  font-weight: var(--fw-semi);
  font-size: var(--text-2xl);
  letter-spacing: -0.02em;
  margin-bottom: var(--space-2);
}
.subtitle { color: var(--text-secondary); font-size: 0.9em; }
.field { margin-bottom: 16px; }
.field label {
  display: block; margin-bottom: 6px; font-size: 0.85em;
  color: var(--text-secondary); font-weight: 500;
}
.field input {
  width: 100%; padding: 8px 12px; background: var(--bg-primary);
  border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text-primary); font-family: var(--font-mono); font-size: 0.85em;
}
.field input:focus { outline: none; border-color: var(--accent); }
.advanced { margin-bottom: 16px; }
.advanced summary {
  cursor: pointer; color: var(--text-secondary); font-size: 0.85em;
  margin-bottom: 12px;
}
.error {
  background: rgba(248, 81, 73, 0.1); border: 1px solid var(--danger);
  color: var(--danger); padding: 8px 12px; border-radius: var(--radius);
  font-size: 0.85em; margin-bottom: 16px;
}
.btn-primary {
  width: 100%; padding: 10px; background: var(--accent); color: #fff;
  border: none; border-radius: var(--radius); font-weight: 600;
  font-size: 0.95em; transition: background 0.15s;
}
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
