<script setup lang="ts">
import { onMounted } from 'vue'
import { useConnectionStore } from '@/stores/connection'
import ConnectionDialog from '@/components/layout/ConnectionDialog.vue'
import MainLayout from '@/components/layout/MainLayout.vue'

const conn = useConnectionStore()

onMounted(() => {
  conn.loadFromUrl()
  conn.loadFromStorage()
  const params = new URLSearchParams(window.location.search)
  if (params.get('auto') === 'true' && conn.url && conn.serviceId) {
    conn.connect()
  }
})
</script>

<template>
  <div class="app">
    <MainLayout v-if="conn.connected" />
    <ConnectionDialog v-else />
  </div>
</template>

<style>
/*
 * bioFlow design tokens.
 *
 * Palette: warm-slate dark with a faint green-yellow tint (bioFlow hue = 135°).
 * Neutrals are OKLCH-defined so lightness steps are perceptually even.
 * Accents (coral primary, sage success, amber warning, oxblood danger) are
 * chosen to feel like pigments from scientific illustration — *not*
 * corporate-tech saturation.
 *
 * Typography: Bricolage Grotesque (display), Manrope (UI body), JetBrains
 * Mono (code). Deliberately *not* Inter/Plex/DM.
 */

:root {
  /* ── Surfaces (slate tinted 135° — near-neutral, barely green) ─── */
  --bg-primary:   oklch(0.172 0.008 135);
  --bg-secondary: oklch(0.215 0.010 135);
  --bg-tertiary:  oklch(0.260 0.012 135);
  --bg-hover:     oklch(0.315 0.014 135);
  --border:       oklch(0.310 0.013 135);
  --border-soft:  oklch(0.250 0.011 135);

  /* ── Text (warm off-white, tinted 85°) ─────────────────────────── */
  --text-primary:   oklch(0.945 0.013 85);
  --text-secondary: oklch(0.740 0.018 95);
  --text-muted:     oklch(0.580 0.016 120);

  /* ── Accents (scientific-illustration pigments, not neon) ──────── */
  /* Coral-terracotta primary — distinct from any Tailwind/GitHub default */
  --accent:       oklch(0.725 0.148 35);
  --accent-hover: oklch(0.790 0.118 38);
  --accent-soft:  oklch(0.725 0.148 35 / 0.14);

  /* Sage-green success (Seurat plot energy, not neon green) */
  --success:      oklch(0.760 0.105 148);
  --success-soft: oklch(0.760 0.105 148 / 0.14);

  /* Saffron-amber warning */
  --warning:      oklch(0.785 0.138 78);
  --warning-soft: oklch(0.785 0.138 78 / 0.14);

  /* Oxblood / burgundy error (warm, not fire-engine red) */
  --danger:       oklch(0.650 0.175 22);
  --danger-soft:  oklch(0.650 0.175 22 / 0.14);

  /* Secondary accent — a quiet cornflower for informational states only */
  --info:         oklch(0.735 0.110 240);

  /* ── Code surfaces ─────────────────────────────────────────────── */
  --code-bg:        oklch(0.150 0.008 135);
  --code-bg-inline: oklch(0.245 0.010 135);

  /* Scrollbar */
  --scrollbar-bg:    oklch(0.215 0.010 135);
  --scrollbar-thumb: oklch(0.330 0.015 135);

  /* ── Typography ────────────────────────────────────────────────── */
  --font-display: 'Bricolage Grotesque', ui-serif, Georgia, serif;
  --font-sans:    'Manrope', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono:    'JetBrains Mono', ui-monospace, 'SF Mono', Consolas, monospace;

  /* Modular scale, 1.25 ratio. Fixed rem for app UI — fluid type is for
     marketing pages, not data-dense product UI. */
  --text-2xs: 0.6875rem;  /* 11px */
  --text-xs:  0.75rem;    /* 12px */
  --text-sm:  0.8125rem;  /* 13px */
  --text-md:  0.875rem;   /* 14px — base UI */
  --text-lg:  1rem;       /* 16px */
  --text-xl:  1.25rem;    /* 20px */
  --text-2xl: 1.5rem;     /* 24px */
  --text-3xl: 1.875rem;   /* 30px */

  /* Weights — Manrope variable */
  --fw-regular: 400;
  --fw-medium:  500;
  --fw-semi:    600;
  --fw-bold:    700;

  /* ── Radii & spacing ───────────────────────────────────────────── */
  --radius:    6px;
  --radius-lg: 10px;
  --radius-pill: 999px;

  /* 4pt scale */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
  --space-8: 64px;

  /* Elevation */
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.3);
  --shadow-md: 0 4px 12px rgb(0 0 0 / 0.4), 0 1px 3px rgb(0 0 0 / 0.25);
  --shadow-lg: 0 10px 28px rgb(0 0 0 / 0.45), 0 2px 6px rgb(0 0 0 / 0.3);

  /* Motion */
  --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);
  --ease-out-expo:  cubic-bezier(0.16, 1, 0.3, 1);
}

* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #app { height: 100%; overflow: hidden; }

body {
  font-family: var(--font-sans);
  font-feature-settings: 'ss01', 'ss02', 'cv11';
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: var(--text-md);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

/* Display face used selectively — logo, notebook title, empty-state headline */
.font-display {
  font-family: var(--font-display);
  font-weight: var(--fw-semi);
  letter-spacing: -0.01em;
}

.app { height: 100%; display: flex; flex-direction: column; }

/* ── Scrollbars (tinted to match surfaces) ──────────────────────── */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: var(--radius-pill);
  border: 2px solid var(--bg-primary);
}
::-webkit-scrollbar-thumb:hover { background: var(--bg-hover); }

/* ── Selection tinted to the brand coral ────────────────────────── */
::selection {
  background: oklch(0.725 0.148 35 / 0.32);
  color: var(--text-primary);
}

/* ── Markdown body styling (used by chat + notebook markdown cells) */
.markdown-body {
  color: var(--text-primary);
  line-height: 1.65;
  word-wrap: break-word;
  max-width: 75ch;
}
.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4,
.markdown-body h5,
.markdown-body h6 {
  font-family: var(--font-display);
  margin-top: 1.2em;
  margin-bottom: 0.5em;
  font-weight: var(--fw-semi);
  letter-spacing: -0.005em;
}
.markdown-body h1 { font-size: var(--text-2xl); line-height: 1.2; }
.markdown-body h2 { font-size: var(--text-xl); line-height: 1.25; }
.markdown-body h3 { font-size: var(--text-lg); line-height: 1.3; }
.markdown-body h4,
.markdown-body h5,
.markdown-body h6 {
  font-family: var(--font-sans);
  font-size: var(--text-md);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.markdown-body p { margin: 0.6em 0; }
.markdown-body pre {
  background: var(--code-bg);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius);
  overflow-x: auto;
  margin: 0.6em 0;
  border: 1px solid var(--border-soft);
  font-family: var(--font-mono);
  font-size: 0.92em;
  line-height: 1.55;
}
.markdown-body code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  font-feature-settings: 'liga' 0;  /* no ligatures for code clarity */
}
.markdown-body :not(pre) > code {
  background: var(--code-bg-inline);
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--text-primary);
}
.markdown-body ul,
.markdown-body ol { padding-left: 1.4em; margin: 0.5em 0; }
.markdown-body li { margin: 0.25em 0; }
.markdown-body blockquote {
  border-left: 2px solid var(--border);
  padding: 2px 0 2px 14px;
  color: var(--text-secondary);
  margin: 0.6em 0;
  font-style: italic;
}
.markdown-body table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.6em 0;
  font-size: 0.92em;
}
.markdown-body th,
.markdown-body td {
  border: 1px solid var(--border-soft);
  padding: var(--space-1) var(--space-3);
  text-align: left;
}
.markdown-body th {
  background: var(--bg-tertiary);
  font-weight: var(--fw-semi);
  font-size: 0.85em;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.markdown-body a {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
  text-decoration-color: color-mix(in oklch, var(--accent) 40%, transparent);
}
.markdown-body a:hover {
  color: var(--accent-hover);
  text-decoration-color: currentColor;
}
.markdown-body img {
  max-width: 100%;
  border-radius: var(--radius);
}

button { cursor: pointer; font-family: inherit; font-size: inherit; }
input, textarea, select { font-family: inherit; font-size: inherit; }

/* Focus ring — visible, not aggressive */
*:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 3px;
}

/* Reduced motion respected globally */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
</style>
