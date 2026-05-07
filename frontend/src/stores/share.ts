// frontend/src/stores/share.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { shareService } from '@/services/share';
import type { ShareRequest, ShareCapabilities, ArtifactKind } from '@/types/share';

export const useShareStore = defineStore('share', () => {
  const items = ref<ShareRequest[]>([]);
  const cursor = ref<string | null>(null);
  const view = ref<'outbox' | 'inbox'>('outbox');
  const loading = ref(false);
  const error = ref<string | null>(null);
  const selected = ref<ShareRequest | null>(null);
  const capabilities = ref<ShareCapabilities>({
    is_manager: false,
    manager_username: null,
    pending_inbox_count: 0,
    actor_username: '',
  });

  async function loadCapabilities() {
    try {
      capabilities.value = await shareService.capabilities();
    } catch (e) {
      error.value = (e as Error)?.message ?? 'Failed to load capabilities';
    }
  }

  async function loadFirstPage() {
    loading.value = true;
    cursor.value = null;
    error.value = null;
    try {
      const r = await shareService.list({ role: view.value });
      items.value = r.items;
      cursor.value = r.next_cursor;
    } catch (e) {
      error.value = (e as Error)?.message ?? 'Failed to load share requests';
      items.value = [];
    } finally {
      loading.value = false;
    }
  }

  async function setView(v: 'outbox' | 'inbox') {
    view.value = v;
    await loadFirstPage();
  }

  async function select(id: string) {
    error.value = null;
    try {
      selected.value = await shareService.get(id);
    } catch (e) {
      error.value = (e as Error)?.message ?? 'Failed to load share request';
    }
  }

  async function submit(p: { kind: ArtifactKind; ref: string; note?: string }) {
    error.value = null;
    try {
      await shareService.submit(p);
      // Refresh outbox if visible, then refresh capabilities so manager's inbox count updates.
      if (view.value === 'outbox') await loadFirstPage();
      await loadCapabilities();
    } catch (e) {
      error.value = (e as Error)?.message ?? 'Failed to submit share request';
      throw e;  // bubble up so the modal can show the failure
    }
  }

  async function decide(id: string, p: { decision: 'approve'|'reject'; comment?: string }) {
    error.value = null;
    try {
      await shareService.decide(id, p);
      // Refetch the row so its status flips visibly + reload list + capabilities.
      if (selected.value?.share_id === id) await select(id);
      await loadFirstPage();
      await loadCapabilities();
    } catch (e) {
      error.value = (e as Error)?.message ?? 'Failed to decide share request';
    }
  }

  async function withdraw(id: string) {
    error.value = null;
    try {
      await shareService.withdraw(id);
      if (selected.value?.share_id === id) await select(id);
      await loadFirstPage();
    } catch (e) {
      error.value = (e as Error)?.message ?? 'Failed to withdraw share request';
    }
  }

  return {
    items, cursor, view, loading, error, selected, capabilities,
    loadCapabilities, loadFirstPage, setView, select, submit, decide, withdraw,
  };
});
