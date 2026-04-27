#!/bin/bash
# Recreate a user's container (e.g. after bumping the image) while keeping the
# workspace, htpasswd entry, and IDs.

set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACES_DIR="${HUB_DIR}/workspaces"
SHARED_DIR="${WORKSPACES_DIR}/shared"
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
    -v "${WORKSPACE}/local_projects:/workspace/local_projects" \
    -v "${WORKSPACE}/.claude/chats:/workspace/.claude/chats" \
    -v "${WORKSPACE}/.env:/workspace/.env:ro" \
    -v "${WORKSPACE}/CLAUDE.md:/workspace/CLAUDE.md:ro" \
    -v "${SHARED_DIR}/CLAUDE.md:/workspace/.bioflow/shared.md:ro" \
    -v "${WORKSPACE}/.claude/skills:/home/node/.claude/skills-user" \
    -v "${WORKSPACE}/.claude/agents:/home/node/.claude/agents" \
    -v "${WORKSPACE}/.claude/settings.json:/home/node/.claude/settings.json" \
    -v "${WORKSPACE}/.claude/claude-projects:/home/node/.claude/projects" \
    -v "${SHARED_DIR}/reference:/workspace/shared/reference:ro" \
    -v "${SHARED_DIR}/projects:/workspace/shared/projects" \
    -v "${SHARED_DIR}/skills:/home/node/.claude/skills-shared:ro" \
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
