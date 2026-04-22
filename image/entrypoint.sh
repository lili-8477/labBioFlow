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

# Stitch shared + per-user skills into ~/.claude/skills. Claude Code only
# auto-discovers skills at that single path; bind-mounts at alternate paths
# (skills-shared, skills-user) are invisible to it. Use symlinks so changes
# on either side propagate without copying.
#
# Precedence: user skills win on a name collision.
stitch_skills() {
    local dest="${HOME}/.claude/skills"
    # Clear stale symlinks (from prior container runs). Leaves real dirs alone.
    find "${dest}" -mindepth 1 -maxdepth 1 -type l -delete 2>/dev/null || true

    # User skills first so they take precedence.
    if [[ -d "${HOME}/.claude/skills-user" ]]; then
        for d in "${HOME}/.claude/skills-user"/*/; do
            [[ -d "$d" ]] || continue
            local name
            name=$(basename "$d")
            ln -sfn "$d" "${dest}/${name}"
        done
    fi

    # Shared skills fill in anything user didn't provide.
    if [[ -d "${HOME}/.claude/skills-shared" ]]; then
        for d in "${HOME}/.claude/skills-shared"/*/; do
            [[ -d "$d" ]] || continue
            local name
            name=$(basename "$d")
            [[ -e "${dest}/${name}" ]] && continue
            ln -s "$d" "${dest}/${name}"
        done
    fi
}
stitch_skills

exec node /opt/adapter/dist/index.js
