#!/bin/bash
# claude-bioflow container entrypoint.
#
# Responsibilities (kept intentionally small — everything else belongs in the adapter):
#   1. Source per-user .env if present (ANTHROPIC_API_KEY, etc.)
#   2. Ensure ~/.claude/{skills,agents} exist even when no bind-mount was attached
#   3. Exec the adapter. SIGTERM handling comes from tini + adapter's signal trap.

set -euo pipefail

ENV_FILE="${WORKSPACE_ROOT:-/workspace}/.env"
if [[ -f "${ENV_FILE}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
fi

mkdir -p "${HOME}/.claude/skills" "${HOME}/.claude/agents" "${HOME}/.claude/projects"

exec node /opt/adapter/dist/index.js
