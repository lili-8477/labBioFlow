#!/bin/bash
# Add a new claude-bioflow user: create workspace, register htpasswd entry,
# spin up the per-user devcontainer.
#
# Usage: ./scripts/add-user.sh <username> [api_key] [options]

set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HTPASSWD_FILE="${HUB_DIR}/htpasswd"
WORKSPACES_DIR="${HUB_DIR}/workspaces"
SHARED_DIR="${WORKSPACES_DIR}/shared"
NETWORK="claude-bioflow_bioflow-net"
NATS_HOST="claude-bioflow-nats"
ENV_FILE="${HUB_DIR}/.env"

ensure_hub_env() {
    if [[ -f "$ENV_FILE" ]] && grep -q '^POSTGRES_PASSWORD=' "$ENV_FILE"; then
        return
    fi
    local pw
    pw=$(openssl rand -base64 32 | tr -d '=+/')
    touch "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    if grep -q '^POSTGRES_PASSWORD=' "$ENV_FILE" 2>/dev/null; then
        return
    fi
    {
        echo "# claude-bioflow hub secrets — do not commit"
        echo "POSTGRES_PASSWORD=${pw}"
    } >> "$ENV_FILE"
    echo "Generated ${ENV_FILE} with a random POSTGRES_PASSWORD."
}

IMAGE="${IMAGE:-claude-bioflow:dev}"
USERNAME=""
API_KEY=""
DATA_MOUNTS=()

usage() {
    cat <<'HELP'
Usage: add-user.sh <username> [api_key] [options]

Options:
  --data, -d PATH[:MOUNT]   Mount a host dir (repeatable). Defaults to /workspace/data/<dirname>.
  --image, -i IMAGE         Override container image (default: claude-bioflow:dev).
  --help, -h                Show this help.

Examples:
  add-user.sh alice sk-ant-api03-xxxxx
  add-user.sh bob --data /home/bob/dataset1 --data /shared/refs:/workspace/shared/refs:ro

The script creates:
  hub/workspaces/<user>/               workspace root, bind-mounted at /workspace
  hub/workspaces/<user>/.env           ANTHROPIC_API_KEY for this user
  hub/workspaces/<user>/.claude/       user-level bind sources (skills, agents, chats, claude-projects)
  hub/workspaces/<user>/projects/      project folders

And spins a container named "claude-bioflow-<user>" on the bioflow-net network.
HELP
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --data|-d)
            shift
            [[ $# -eq 0 ]] && { echo "Error: --data requires a path"; exit 1; }
            DATA_MOUNTS+=("$1"); shift
            ;;
        --image|-i)
            shift
            [[ $# -eq 0 ]] && { echo "Error: --image requires a value"; exit 1; }
            IMAGE="$1"; shift
            ;;
        --help|-h) usage; exit 0 ;;
        *)
            if [[ -z "$USERNAME" ]]; then USERNAME="$1"
            elif [[ -z "$API_KEY" ]]; then API_KEY="$1"
            else echo "Unexpected argument: $1"; exit 1
            fi
            shift
            ;;
    esac
done

if [[ -z "$USERNAME" ]]; then usage; exit 1; fi
if ! [[ "$USERNAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    echo "Error: username must be lowercase alphanumeric (hyphens allowed, no leading hyphen)"
    exit 1
fi

if ! docker network inspect "${NETWORK}" >/dev/null 2>&1; then
    echo "Error: network '${NETWORK}' not found. Run 'docker compose up -d' first."
    exit 1
fi

CONTAINER="claude-bioflow-${USERNAME}"
WORKSPACE="${WORKSPACES_DIR}/${USERNAME}"

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "Error: user '${USERNAME}' already exists. Remove first with ./scripts/remove-user.sh ${USERNAME}"
    exit 1
fi

ensure_hub_env
# Load POSTGRES_PASSWORD from hub/.env into the shell scope so the docker run
# -e "PG_URL=..." substitution below sees it.
set -a
. "${ENV_FILE}"
set +a
echo "=== Adding user: ${USERNAME} ==="

# --- 1. Workspace + config scaffolding --------------------------------------
echo "[1/4] Creating workspace at ${WORKSPACE}"
mkdir -p "${WORKSPACE}/.claude/skills" \
         "${WORKSPACE}/.claude/agents" \
         "${WORKSPACE}/.claude/chats" \
         "${WORKSPACE}/.claude/claude-projects" \
         "${WORKSPACE}/.claude/commands" \
         "${WORKSPACE}/.claude/hooks" \
         "${WORKSPACE}/local_projects" \
         "${WORKSPACE}/.latch"
# .latch holds the Latch CLI token (used by scbench downloads). Credential —
# bind-mounted to /home/node/.latch so it survives container recreates.
chmod 700 "${WORKSPACE}/.latch"

# Seed a minimal Claude Code settings file so the CLI has sensible defaults.
if [[ ! -f "${WORKSPACE}/.claude/settings.json" ]]; then
    cat > "${WORKSPACE}/.claude/settings.json" <<'JSON'
{
  "$schema": "https://claude.ai/schemas/settings.json",
  "model": "claude-sonnet-4-6"
}
JSON
fi

# Install the self-driving tick harness skeleton (orchestrator command,
# tick-* subagents, hook scripts). Idempotent: cp -n leaves user-edited
# copies alone. The harness itself is dormant unless the user toggles
# Self-driving on in the Agents panel (which writes ~/.claude/.harness_active);
# until then the four hooks gate-out as no-ops.
SKELETON_DIR="${HUB_DIR}/skeleton/harness"
if [[ -d "${SKELETON_DIR}" ]]; then
    cp -n "${SKELETON_DIR}/commands/"*.md "${WORKSPACE}/.claude/commands/" 2>/dev/null || true
    cp -n "${SKELETON_DIR}/agents/"tick-*.md "${WORKSPACE}/.claude/agents/" 2>/dev/null || true
    cp -n "${SKELETON_DIR}/hooks/"*.sh "${WORKSPACE}/.claude/hooks/" 2>/dev/null || true
    chmod +x "${WORKSPACE}/.claude/hooks/"*.sh 2>/dev/null || true

    # Merge harness hook entries into settings.json, preserving inode (the
    # file is bind-mounted into the container; atomic-rename would break it).
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

# Shared dirs — created on demand by the first user provisioning.
mkdir -p "${SHARED_DIR}/reference" "${SHARED_DIR}/projects" "${SHARED_DIR}/skills"

# Seed a slim user CLAUDE.md that imports the shared base via Claude Code's
# @<path> memory-import syntax. Shared content lives at /workspace/.bioflow/shared.md
# (bind-mounted from hub/workspaces/shared/CLAUDE.md, see MOUNTS below) so
# edits there flow live into every workspace. User-specific overrides go
# below the import line — later text wins on conflicts.
if [[ ! -f "${WORKSPACE}/CLAUDE.md" ]]; then
    cat > "${WORKSPACE}/CLAUDE.md" <<EOF
@/workspace/.bioflow/shared.md

# ${USERNAME} — local overrides

EOF
fi

# Per-user .env
if [[ ! -f "${WORKSPACE}/.env" ]]; then
    cat > "${WORKSPACE}/.env" <<EOF
# claude-bioflow — user: ${USERNAME}
EOF
    if [[ -n "$API_KEY" ]]; then
        echo "ANTHROPIC_API_KEY=${API_KEY}" >> "${WORKSPACE}/.env"
    else
        echo "#ANTHROPIC_API_KEY=sk-ant-your-key-here" >> "${WORKSPACE}/.env"
    fi
    chmod 600 "${WORKSPACE}/.env"
fi

# Register the bioflow-memory MCP server for this user. Claude Code reads
# .mcp.json from the project root (cwd = /workspace inside the container,
# i.e. ${WORKSPACE} on the host). Merged via Python so we don't clobber
# any pre-existing servers (e.g. an adapter MCP added later); idempotent
# on re-runs since the same key just overwrites itself.
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

# --- 2. HTTP Basic auth entry ------------------------------------------------
echo "[2/4] Setting up HTTP auth"
echo -n "Enter password for ${USERNAME}: "
read -rs PASSWORD
echo ""
touch "${HTPASSWD_FILE}"
if command -v htpasswd &>/dev/null; then
    htpasswd -b "${HTPASSWD_FILE}" "${USERNAME}" "${PASSWORD}"
else
    ENTRY=$(docker run --rm httpd:alpine htpasswd -nb "${USERNAME}" "${PASSWORD}")
    sed -i.bak "/^${USERNAME}:/d" "${HTPASSWD_FILE}" && rm -f "${HTPASSWD_FILE}.bak"
    echo "${ENTRY}" >> "${HTPASSWD_FILE}"
fi
docker exec claude-bioflow-nginx nginx -s reload >/dev/null 2>&1 || true

# --- 3. IDs ------------------------------------------------------------------
echo "[3/4] Generating IDs"
ID_HASH=$(printf 'claude-bioflow-%s' "${USERNAME}" | sha256sum | cut -c1-12)
SERVICE_ID=$(printf '%s' "${ID_HASH}" | sha256sum | cut -c1-64)
echo "  ID_HASH:    ${ID_HASH}"
echo "  service_id: ${SERVICE_ID}"

# --- 4. Spin the container ---------------------------------------------------
echo "[4/4] Starting container"
MOUNTS=(
    # User's private projects — host and container use the same name so
    # the nginx /download/ endpoint (which serves directly from the host dir)
    # maps the UI path 1:1 without special rewrites.
    -v "${WORKSPACE}/local_projects:/workspace/local_projects"
    # Expose the user's whole .claude tree so the file explorer can browse and
    # edit agents/, chats/, claude-projects/, skills/, and settings.json. The
    # /home/node/.claude/* mounts below are still required (Claude Code reads
    # from there); this just adds a second view at /workspace/.claude/.
    -v "${WORKSPACE}/.claude:/workspace/.claude"
    -v "${WORKSPACE}/.env:/workspace/.env:ro"
    # Workspace-level instructions Claude Code auto-loads from cwd.
    -v "${WORKSPACE}/CLAUDE.md:/workspace/CLAUDE.md:ro"
    # Project-scoped MCP server registry — Claude Code reads .mcp.json
    # from cwd (/workspace) on launch. Single-file mount keeps the inode
    # stable across host edits (atomic-rename would break the mount).
    -v "${WORKSPACE}/.mcp.json:/workspace/.mcp.json:ro"
    # Shared CLAUDE.md, mounted live so org-wide edits propagate without
    # touching per-user files. The user CLAUDE.md @-imports this path.
    -v "${SHARED_DIR}/CLAUDE.md:/workspace/.bioflow/shared.md:ro"
    # Skills are split: per-user skills at skills-user, org-wide at skills-shared.
    # The entrypoint symlinks both into ~/.claude/skills/ so Claude Code
    # auto-discovers them. User skills win on name collisions.
    -v "${WORKSPACE}/.claude/skills:/home/node/.claude/skills-user"
    -v "${WORKSPACE}/.claude/agents:/home/node/.claude/agents"
    -v "${WORKSPACE}/.claude/commands:/home/node/.claude/commands"
    -v "${WORKSPACE}/.claude/hooks:/home/node/.claude/hooks"
    -v "${WORKSPACE}/.claude/settings.json:/home/node/.claude/settings.json"
    # Persist Claude Code session JSONLs across container recreations.
    -v "${WORKSPACE}/.claude/claude-projects:/home/node/.claude/projects"
    -v "${WORKSPACE}/.latch:/home/node/.latch"
    -v "${SHARED_DIR}/reference:/workspace/shared/reference:ro"
    -v "${SHARED_DIR}/projects:/workspace/shared/projects"
    -v "${SHARED_DIR}/skills:/home/node/.claude/skills-shared:ro"
    # Also expose the shared skills tree under /workspace so the file
    # explorer can render it for browsing. Read-only; users edit personal
    # skills under their per-user .claude/skills mount above.
    -v "${SHARED_DIR}/skills:/workspace/shared/skills:ro"
)

for spec in "${DATA_MOUNTS[@]+"${DATA_MOUNTS[@]}"}"; do
    if [[ "$spec" == *":"* ]]; then
        host="${spec%%:*}"; tgt="${spec#*:}"
    else
        host="$spec"; tgt="/workspace/data/$(basename "$spec")"
    fi
    [[ -d "$host" ]] || mkdir -p "$host"
    MOUNTS+=(-v "${host}:${tgt}")
done

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
    "${MOUNTS[@]}" \
    -w /workspace \
    "${IMAGE}"

sleep 2
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "Error: container failed to start. Logs:"
    docker logs "${CONTAINER}" | tail -30
    exit 1
fi

# Chown the inherited /venv to node so runtime pip installs (torch,
# scSurvival, jupyter, etc) actually land. Runs once per container,
# takes ~10s, lives in the container's own overlay — NOT in the image.
docker exec -u root "${CONTAINER}" chown -R node:node /venv 2>/dev/null \
    && echo "  chown /venv -> node:node OK" \
    || echo "  chown /venv skipped (already owned, or container not ready)"

cat <<SUMMARY

=== User '${USERNAME}' created ===
  Container:  ${CONTAINER}
  Workspace:  ${WORKSPACE}
  Image:      ${IMAGE}

Frontend connection:
  WebSocket URL: ws://localhost:8088/ws/   (front with TLS for remote access)
  Service ID:    ${SERVICE_ID}
  Username:      ${USERNAME}  (HTTP Basic)

Drop skills into:
  ${WORKSPACE}/.claude/skills/<name>/SKILL.md
SUMMARY
