#!/bin/bash
# Recreate a user's container (e.g. after bumping the image) while keeping the
# workspace, htpasswd entry, and IDs.

set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACES_DIR="${HUB_DIR}/workspaces"
SHARED_DIR="${WORKSPACES_DIR}/shared"
SKELETON_DIR="${HUB_DIR}/skeleton/harness"
NETWORK="claude-bioflow_bioflow-net"
NATS_HOST="claude-bioflow-nats"
ENV_FILE="${HUB_DIR}/.env"

IMAGE="${IMAGE:-claude-bioflow:dev}"
USERNAME="${1:-}"

if [[ -z "$USERNAME" ]]; then
    echo "Usage: IMAGE=claude-bioflow:latest $0 <username>"
    exit 1
fi

CONTAINER="claude-bioflow-${USERNAME}"
WORKSPACE="${WORKSPACES_DIR}/${USERNAME}"

[[ -d "$WORKSPACE" ]] || { echo "No workspace at ${WORKSPACE}"; exit 1; }

if [[ ! -f "$ENV_FILE" ]]; then
    echo "Missing ${ENV_FILE}; run add-user.sh once (or create the file) to generate POSTGRES_PASSWORD."
    exit 1
fi
# Load POSTGRES_PASSWORD so the docker run -e "PG_URL=..." substitution sees it.
set -a
. "${ENV_FILE}"
set +a

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    docker stop "${CONTAINER}" >/dev/null
    docker rm "${CONTAINER}" >/dev/null
fi

# Refresh harness skeleton + memory wiring on the existing workspace so
# recreating a pre-memory user gains the SessionStart hook, the slash
# commands, and the bioflow-memory MCP server. All three operations are
# idempotent (cp -n + Python merges) so re-running does not clobber
# user-edited files.
# Per-user Latch CLI token directory. Bind-mounted to /home/node/.latch so
# `latch cp` (used by scbench dataset downloads) keeps its token across
# container recreates. mode 700 — it holds a credential.
mkdir -p "${WORKSPACE}/.latch"
chmod 700 "${WORKSPACE}/.latch"

if [[ -d "${SKELETON_DIR}" ]]; then
    mkdir -p "${WORKSPACE}/.claude/commands" \
             "${WORKSPACE}/.claude/agents" \
             "${WORKSPACE}/.claude/hooks"
    cp -n "${SKELETON_DIR}/commands/"*.md "${WORKSPACE}/.claude/commands/" 2>/dev/null || true
    cp -n "${SKELETON_DIR}/agents/"tick-*.md "${WORKSPACE}/.claude/agents/" 2>/dev/null || true
    cp -n "${SKELETON_DIR}/hooks/"*.sh "${WORKSPACE}/.claude/hooks/" 2>/dev/null || true
    chmod +x "${WORKSPACE}/.claude/hooks/"*.sh 2>/dev/null || true

    # Merge harness hook entries into settings.json (idempotent overwrite of
    # the harness-managed keys). Preserves inode for the bind mount.
    if [[ -f "${WORKSPACE}/.claude/settings.json" ]]; then
        python3 - "${WORKSPACE}/.claude/settings.json" <<'PY'
import json, sys, pathlib
HARNESS_HOOKS = {
    "SessionStart": [
        {"hooks": [{"type": "command", "command": "$HOME/.claude/hooks/memory_session_start.sh"}]}
    ],
    "UserPromptSubmit": [
        {"hooks": [{"type": "command", "command": "$HOME/.claude/hooks/userprompt_route.sh"}]}
    ],
    "PreToolUse": [
        {"matcher": "Bash|Write|Edit",
         "hooks": [{"type": "command", "command": "$HOME/.claude/hooks/pretool_audit.sh"}]}
    ],
    "PostToolUse": [
        {"matcher": "Write|Edit",
         "hooks": [{"type": "command", "command": "$HOME/.claude/hooks/posttool_commit.sh"}]},
        {"matcher": "Bash",
         "hooks": [{"type": "command", "command": "$HOME/.claude/hooks/posttool_jobid.sh"}]}
    ],
    "Stop": [
        {"hooks": [{"type": "command", "command": "$HOME/.claude/hooks/stop_tick.sh"}]}
    ],
}
p = pathlib.Path(sys.argv[1])
cur = json.loads(p.read_text())
hooks = cur.setdefault("hooks", {})
for k, v in HARNESS_HOOKS.items(): hooks[k] = v
ordered = {}
for k in ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]:
    if k in hooks: ordered[k] = hooks[k]
cur["hooks"] = ordered
with p.open("w") as f:
    json.dump(cur, f, indent=2); f.write("\n")
PY
    fi
fi

# Ensure the bioflow-memory MCP server is registered in the per-user
# .mcp.json. Mirrors add-user.sh; merge keeps any pre-existing servers.
MCP_FILE="${WORKSPACE}/.mcp.json"
[[ -f "$MCP_FILE" ]] || echo '{}' > "$MCP_FILE"
python3 - "$MCP_FILE" "$USERNAME" <<'PY'
import json, sys, pathlib
p, username = pathlib.Path(sys.argv[1]), sys.argv[2]
try:
    cur = json.loads(p.read_text() or "{}")
except json.JSONDecodeError:
    cur = {}
servers = cur.setdefault("mcpServers", {})
servers["bioflow-memory"] = {
    "command": "bioflow-memory-mcp",
    "env": {
        "USERNAME": username,
        "MEMORY_API_URL": "http://claude-bioflow-indexer:8400",
    },
}
with p.open("w") as f:
    json.dump(cur, f, indent=2); f.write("\n")
PY

ID_HASH=$(printf 'claude-bioflow-%s' "${USERNAME}" | sha256sum | cut -c1-12)

# GPU passthrough: pass --gpus all when nvidia-container-toolkit is present
# on the host. Without the toolkit `--gpus all` fails hard, so we detect.
# Override with GPU=0 to force-disable.
GPU_FLAGS=()
if [[ "${GPU:-auto}" != "0" ]] && command -v nvidia-ctk >/dev/null 2>&1; then
    GPU_FLAGS=(--gpus all)
    echo "  [gpu] --gpus all (detected nvidia-container-toolkit)"
fi

docker run -d \
    --name "${CONTAINER}" \
    --network "${NETWORK}" \
    --restart unless-stopped \
    "${GPU_FLAGS[@]}" \
    -e "ID_HASH=${ID_HASH}" \
    -e "NATS_SERVERS=nats://${NATS_HOST}:4222" \
    -e "NATS_USER=agent" \
    -e "WORKSPACE_ROOT=/workspace" \
    -e "DEFAULT_PROJECT=/workspace" \
    -e "PG_URL=postgres://bioflow:${POSTGRES_PASSWORD}@claude-bioflow-postgres:5432/bioflow" \
    -e "USERNAME=${USERNAME}" \
    -e "SIDECAR_IMPORT_ON_BOOT=1" \
    -e "HOME=/home/node" \
    -e "MEMORY_API_URL=http://claude-bioflow-indexer:8400" \
    -e "MEMORY_ENABLED=1" \
    -v "${WORKSPACE}/local_projects:/workspace/local_projects" \
    -v "${WORKSPACE}/.claude:/workspace/.claude" \
    -v "${WORKSPACE}/.env:/workspace/.env:ro" \
    -v "${WORKSPACE}/CLAUDE.md:/workspace/CLAUDE.md:ro" \
    -v "${WORKSPACE}/.mcp.json:/workspace/.mcp.json:ro" \
    -v "${SHARED_DIR}/CLAUDE.md:/workspace/.bioflow/shared.md:ro" \
    -v "${WORKSPACE}/.claude/skills:/home/node/.claude/skills-user" \
    -v "${WORKSPACE}/.claude/agents:/home/node/.claude/agents" \
    -v "${WORKSPACE}/.claude/commands:/home/node/.claude/commands" \
    -v "${WORKSPACE}/.claude/hooks:/home/node/.claude/hooks" \
    -v "${WORKSPACE}/.claude/settings.json:/home/node/.claude/settings.json" \
    -v "${WORKSPACE}/.claude/claude-projects:/home/node/.claude/projects" \
    -v "${WORKSPACE}/.latch:/home/node/.latch" \
    -v "${SHARED_DIR}/reference:/workspace/shared/reference:ro" \
    -v "${SHARED_DIR}/projects:/workspace/shared/projects" \
    -v "${SHARED_DIR}/skills:/home/node/.claude/skills-shared:ro" \
    -v "${SHARED_DIR}/skills:/workspace/shared/skills:ro" \
    -w /workspace \
    "${IMAGE}"

# The base image's /venv is owned by root:root so runtime `pip install`
# (torch, scSurvival, etc) fails with "Permission denied". Fix it once
# per container — lives in the container's overlay, takes ~10s, and does
# NOT bloat the shared image layer. Best-effort; don't fail the recreate
# if it hiccups.
docker exec -u root "${CONTAINER}" chown -R node:node /venv 2>/dev/null \
    && echo "  chown /venv -> node:node OK" \
    || echo "  chown /venv skipped (already owned, or container not ready)"

echo "Recreated ${CONTAINER} with image ${IMAGE}."
