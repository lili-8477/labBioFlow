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
  hub/workspaces/<user>/.pantheon/     user-level .claude/ bind sources (skills, agents, chats)
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

echo "=== Adding user: ${USERNAME} ==="

# --- 1. Workspace + config scaffolding --------------------------------------
echo "[1/4] Creating workspace at ${WORKSPACE}"
mkdir -p "${WORKSPACE}/.pantheon/skills" \
         "${WORKSPACE}/.pantheon/agents" \
         "${WORKSPACE}/.pantheon/chats" \
         "${WORKSPACE}/.pantheon/claude-projects" \
         "${WORKSPACE}/projects"

# Seed a minimal Claude Code settings file so the CLI has sensible defaults.
if [[ ! -f "${WORKSPACE}/.pantheon/settings.json" ]]; then
    cat > "${WORKSPACE}/.pantheon/settings.json" <<'JSON'
{
  "$schema": "https://claude.ai/schemas/settings.json",
  "model": "claude-sonnet-4-6"
}
JSON
fi

# Shared dirs — created on demand by the first user provisioning.
mkdir -p "${SHARED_DIR}/reference" "${SHARED_DIR}/projects" "${SHARED_DIR}/skills"

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
    # User's private projects — name disambiguated from shared/projects so the
    # file tree shows "local_projects" vs "shared/projects" without confusion.
    -v "${WORKSPACE}/projects:/workspace/local_projects"
    -v "${WORKSPACE}/.pantheon/chats:/workspace/.pantheon/chats"
    -v "${WORKSPACE}/.env:/workspace/.env:ro"
    -v "${WORKSPACE}/.pantheon/skills:/home/node/.claude/skills"
    -v "${WORKSPACE}/.pantheon/agents:/home/node/.claude/agents"
    -v "${WORKSPACE}/.pantheon/settings.json:/home/node/.claude/settings.json"
    # Persist Claude Code session JSONLs across container recreations.
    -v "${WORKSPACE}/.pantheon/claude-projects:/home/node/.claude/projects"
    -v "${SHARED_DIR}/reference:/workspace/shared/reference:ro"
    -v "${SHARED_DIR}/projects:/workspace/shared/projects"
    -v "${SHARED_DIR}/skills:/home/node/.claude/skills-shared:ro"
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

docker run -d \
    --name "${CONTAINER}" \
    --network "${NETWORK}" \
    --restart unless-stopped \
    -e "ID_HASH=${ID_HASH}" \
    -e "NATS_SERVERS=nats://${NATS_HOST}:4222" \
    -e "NATS_USER=agent" \
    -e "WORKSPACE_ROOT=/workspace" \
    -e "DEFAULT_PROJECT=/workspace" \
    -e "HOME=/home/node" \
    "${MOUNTS[@]}" \
    -w /workspace \
    "${IMAGE}"

sleep 2
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "Error: container failed to start. Logs:"
    docker logs "${CONTAINER}" | tail -30
    exit 1
fi

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
  ${WORKSPACE}/.pantheon/skills/<name>/SKILL.md
SUMMARY
