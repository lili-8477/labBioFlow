#!/usr/bin/env bash
# Stop hook — re-prompt "/tick" after every stop unless paused or complete.
# Emits a JSON decision on stdout. Pause: `touch ~/.claude/.tick_paused`.
set -euo pipefail

LOG="$HOME/.claude/.harness_active.log"
log() { printf '%s stop_tick %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

# Harness toggle: stay no-op unless self-driving mode is enabled.
# Enabled when ~/.claude/.harness_active exists (toggled from the frontend).
[[ -f "$HOME/.claude/.harness_active" ]] || { log "noop: marker absent"; exit 0; }

# When triggered, the cwd is the project the user ran /tick from.
PROGRESS="${HARNESS_DIR:-$PWD}/progress.md"
PAUSE="$HOME/.claude/.tick_paused"

# Pause file → no re-prompt
if [[ -f "$PAUSE" ]]; then
  log "noop: paused (cwd=$PWD)"
  exit 0
fi

# Terminal status → no re-prompt
if [[ -f "$PROGRESS" ]] && grep -q '^## Status: complete' "$PROGRESS"; then
  log "noop: complete (progress=$PROGRESS)"
  exit 0
fi

# Otherwise re-prompt with the /tick slash command.
log "reprompt: cwd=$PWD progress_exists=$([[ -f "$PROGRESS" ]] && echo yes || echo no)"
cat <<'JSON'
{"decision":"block","reason":"Run /tick to advance the harness. To pause, touch ~/.claude/.tick_paused."}
JSON
