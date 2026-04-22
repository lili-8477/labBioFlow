#!/bin/bash
# Recreate a user's container (e.g. after bumping the image) while keeping the
# workspace, htpasswd entry, and IDs.

set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACES_DIR="${HUB_DIR}/workspaces"
SHARED_DIR="${WORKSPACES_DIR}/shared"
NETWORK="claude-bioflow_bioflow-net"
NATS_HOST="claude-bioflow-nats"

IMAGE="${IMAGE:-claude-bioflow:dev}"
USERNAME="${1:-}"

if [[ -z "$USERNAME" ]]; then
    echo "Usage: IMAGE=claude-bioflow:latest $0 <username>"
    exit 1
fi

CONTAINER="claude-bioflow-${USERNAME}"
WORKSPACE="${WORKSPACES_DIR}/${USERNAME}"

[[ -d "$WORKSPACE" ]] || { echo "No workspace at ${WORKSPACE}"; exit 1; }

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    docker stop "${CONTAINER}" >/dev/null
    docker rm "${CONTAINER}" >/dev/null
fi

ID_HASH=$(printf 'claude-bioflow-%s' "${USERNAME}" | sha256sum | cut -c1-12)

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
    -v "${WORKSPACE}/local_projects:/workspace/local_projects" \
    -v "${WORKSPACE}/.pantheon/chats:/workspace/.pantheon/chats" \
    -v "${WORKSPACE}/.env:/workspace/.env:ro" \
    -v "${WORKSPACE}/CLAUDE.md:/workspace/CLAUDE.md:ro" \
    -v "${WORKSPACE}/.pantheon/skills:/home/node/.claude/skills-user" \
    -v "${WORKSPACE}/.pantheon/agents:/home/node/.claude/agents" \
    -v "${WORKSPACE}/.pantheon/settings.json:/home/node/.claude/settings.json" \
    -v "${WORKSPACE}/.pantheon/claude-projects:/home/node/.claude/projects" \
    -v "${SHARED_DIR}/reference:/workspace/shared/reference:ro" \
    -v "${SHARED_DIR}/projects:/workspace/shared/projects" \
    -v "${SHARED_DIR}/skills:/home/node/.claude/skills-shared:ro" \
    -w /workspace \
    "${IMAGE}"

echo "Recreated ${CONTAINER} with image ${IMAGE}."
