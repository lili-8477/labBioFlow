<script setup lang="ts">
// Pinned to the top of the chat panel whenever self-driving mode is on.
// Combines two roles:
//   1. The "is it really on?" banner — answers a question the toggle in
//      AgentPanel can't, since the user is usually looking at the chat.
//   2. A live checklist parsed from progress.md so the user can watch
//      planner / executor / reviewer tick items off as /tick advances.
//
// Display rules:
//   - harnessActive=false → render nothing (component itself is wrapped in
//     a parent v-if for the same reason; this is a belt-and-braces guard).
//   - harnessProgress=null (no progress.md yet) → show the banner with a
//     "no plan yet — bootstrap on first prompt" note. The user sees that
//     the mode IS on; the plan will appear once tick-bootstrap runs.
//   - harnessProgress.complete → green check + "complete" badge.
import { computed } from 'vue'
import type { HarnessProgress, HarnessStep } from '@/types'

const props = defineProps<{
  progress: HarnessProgress | null
  projectName: string | null
}>()

const stepLabel = (s: HarnessStep): string => {
  if (s.reviewed) return 'reviewed'
  if (s.done)     return 'done'
  return 'pending'
}

const totalDone = computed(() => props.progress?.steps.filter(s => s.done).length ?? 0)
const totalSteps = computed(() => props.progress?.steps.length ?? 0)
</script>

<template>
  <div class="harness-checklist">
    <!-- Banner row — always visible while the component is mounted. -->
    <div class="banner" :class="{ complete: progress?.complete }">
      <span class="banner-dot"></span>
      <span class="banner-title">Self-driving mode</span>
      <span v-if="projectName" class="banner-sep">·</span>
      <span v-if="projectName" class="banner-project"><code>{{ projectName }}</code></span>
      <span class="banner-sep">·</span>
      <span class="banner-route">routed via <code>/tick</code></span>
      <span v-if="progress" class="banner-progress">
        {{ totalDone }} / {{ totalSteps }} steps
      </span>
      <span v-if="progress?.complete" class="banner-done-badge">complete</span>
    </div>

    <!-- No progress.md yet — the bootstrap will create one on the next /tick. -->
    <div v-if="!progress" class="empty-plan">
      No plan yet. Send a prompt — <code>tick-bootstrap</code> will scaffold
      <code>progress.md</code> and the checklist will appear here.
    </div>

    <!-- Plan exists but contains no items (planner hasn't run yet). -->
    <div v-else-if="progress.steps.length === 0" class="empty-plan">
      Plan is empty. Waiting for <code>tick-planner</code> to fill it on the next tick.
    </div>

    <ol v-else class="step-list">
      <li
        v-for="(s, i) in progress.steps"
        :key="s.name + i"
        class="step"
        :class="{
          done: s.done,
          reviewed: s.reviewed,
          'next-up': i === progress.nextStepIndex,
        }"
      >
        <span class="step-box" :title="stepLabel(s)">
          <template v-if="s.done">☑</template>
          <template v-else>☐</template>
        </span>
        <span class="step-name">{{ s.name }}</span>
        <span v-if="s.description" class="step-desc">{{ s.description }}</span>
        <span v-if="s.reviewed" class="step-badge reviewed-badge">reviewed</span>
        <span v-else-if="i === progress.nextStepIndex" class="step-badge next-badge">next</span>
      </li>
    </ol>

    <div v-if="progress && progress.pendingFeedback > 0" class="feedback-note">
      ⚠ {{ progress.pendingFeedback }} unaddressed review note{{ progress.pendingFeedback === 1 ? '' : 's' }} — executor will handle on the next tick.
    </div>
  </div>
</template>

<style scoped>
.harness-checklist {
  margin: 8px 16px 12px;
  background: var(--bg-secondary);
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-radius: var(--radius);
  overflow: hidden;
}

.banner {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  font-size: 0.85em; color: var(--text-secondary);
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border));
}
.banner.complete {
  background: color-mix(in srgb, var(--success) 12%, transparent);
  border-bottom-color: color-mix(in srgb, var(--success) 25%, var(--border));
}
.banner-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 50%, transparent);
  animation: pulse-dot 2s infinite;
}
.banner.complete .banner-dot {
  background: var(--success); animation: none;
}
@keyframes pulse-dot {
  0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 60%, transparent); }
  70%  { box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 0%, transparent); }
  100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
}
.banner-title { font-weight: 600; color: var(--text-primary); }
.banner-sep { opacity: 0.5; }
.banner-project code, .banner-route code, .empty-plan code {
  background: var(--bg-tertiary); padding: 0 4px; border-radius: 3px;
  font-size: 0.95em; font-family: var(--font-mono);
}
.banner-progress {
  margin-left: auto;
  font-family: var(--font-mono); font-size: 0.9em;
  color: var(--text-muted);
}
.banner-done-badge {
  font-size: 0.7em; font-weight: 700; letter-spacing: 0.5px;
  padding: 1px 6px; border-radius: 10px;
  background: var(--success); color: #fff;
  text-transform: uppercase;
}

.empty-plan {
  padding: 10px 12px;
  font-size: 0.82em; color: var(--text-muted); line-height: 1.5;
}

.step-list {
  list-style: none; margin: 0; padding: 6px 0;
  max-height: 240px; overflow-y: auto;
}
.step {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 12px;
  font-size: 0.85em; color: var(--text-secondary);
  border-left: 2px solid transparent;
  transition: background 0.15s, border-color 0.15s;
}
.step.done { color: var(--text-primary); }
.step.reviewed .step-box { color: var(--success); }
.step:not(.done) .step-box { color: var(--text-muted); }
.step.next-up {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border-left-color: var(--accent);
}

.step-box {
  font-family: var(--font-mono); font-size: 1.05em; width: 14px;
  flex-shrink: 0;
}
.step-name {
  font-family: var(--font-mono); font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
}
.step:not(.done):not(.next-up) .step-name { color: var(--text-secondary); }
.step-desc {
  flex: 1; min-width: 0;
  font-size: 0.92em; color: var(--text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.step-badge {
  font-size: 0.7em; font-weight: 600; letter-spacing: 0.3px;
  padding: 1px 6px; border-radius: 8px; text-transform: uppercase;
  flex-shrink: 0;
}
.reviewed-badge {
  background: color-mix(in srgb, var(--success) 15%, transparent);
  color: var(--success);
}
.next-badge {
  background: var(--accent); color: #fff;
}

.feedback-note {
  padding: 6px 12px;
  font-size: 0.8em; color: var(--warning, var(--text-secondary));
  background: color-mix(in srgb, var(--warning, var(--accent)) 8%, transparent);
  border-top: 1px solid var(--border);
}
</style>
