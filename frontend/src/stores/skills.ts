import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { SkillSummary } from '@/types/skills';
import { skillsService } from '@/services/skills';
import { useShareStore } from '@/stores/share';

export const useSkillsStore = defineStore('skills', () => {
  const skills  = ref<SkillSummary[]>([]);
  const loading = ref(false);
  const error   = ref<string | null>(null);

  async function load() {
    loading.value = true;
    error.value   = null;
    try {
      skills.value = await skillsService.list();
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  /** Delegates to useShareStore().submit. Throws on failure — caller must catch. */
  async function submitShare(name: string, note?: string) {
    const share = useShareStore();
    return await share.submit({ kind: 'skill', ref: name, note });
  }

  return { skills, loading, error, load, submitShare };
});
