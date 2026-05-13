#!/usr/bin/env bash
# UserPromptSubmit hook — when self-driving mode is ON, route the user's
# message into the /tick orchestrator instead of letting the agent respond
# directly. Pure plumbing: outputs additionalContext on stdout, no judgement.
#
# Disabled when ~/.claude/.harness_active is absent (the toggle in the
# frontend Mode panel writes/removes this file). Also a no-op when the user
# already started their message with a slash command.
set -euo pipefail

LOG="$HOME/.claude/.harness_active.log"
log() { printf '%s userprompt_route %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }

# Harness toggle: stay no-op unless self-driving mode is enabled.
[[ -f "$HOME/.claude/.harness_active" ]] || { log "noop: marker absent"; exit 0; }

# Read the JSON envelope from stdin; extract the prompt field.
INPUT="$(cat)"
PROMPT="$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(d.get("prompt",""), end="")
except Exception:
    pass' 2>/dev/null || true)"

# User-initiated slash commands pass through untouched.
case "$PROMPT" in
  /*) log "passthrough: slash command (${PROMPT:0:60})"; exit 0 ;;
esac

log "inject: routing to /tick (prompt=${PROMPT:0:80})"

# Inject orchestration context. Claude Code appends this stdout as additional
# context to the user prompt, so the agent sees the directive alongside the
# original message.
cat <<'EOF'
[Self-driving mode is ON. The harness gate marker ~/.claude/.harness_active is present.]

Your ONLY action for this turn: invoke the /tick slash command via the SlashCommand tool. The orchestrator will read the user's latest message and:
  - if no progress.md exists in cwd, dispatch tick-bootstrap (scaffolds a new project from the instruction),
  - otherwise dispatch the next subagent in the priority chain (planner / executor / reviewer).

Do not answer the user's request directly. Do not run other tools first. The Stop hook will keep re-prompting /tick after each turn until ## Status: complete is written or the user pauses (touch ~/.claude/.tick_paused) or toggles self-driving Off.
EOF
