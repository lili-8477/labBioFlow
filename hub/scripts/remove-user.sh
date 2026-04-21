#!/bin/bash
# Remove a claude-bioflow user — stops container, removes htpasswd entry.
# Workspace files are PRESERVED on disk; rm them manually if intended.

set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HTPASSWD_FILE="${HUB_DIR}/htpasswd"

USERNAME="${1:-}"
if [[ -z "$USERNAME" ]]; then
    echo "Usage: $0 <username>"
    exit 1
fi

CONTAINER="claude-bioflow-${USERNAME}"

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "Stopping ${CONTAINER}..."
    docker stop "${CONTAINER}" >/dev/null
    docker rm "${CONTAINER}" >/dev/null
else
    echo "No container named ${CONTAINER}."
fi

if [[ -f "${HTPASSWD_FILE}" ]]; then
    sed -i.bak "/^${USERNAME}:/d" "${HTPASSWD_FILE}"
    rm -f "${HTPASSWD_FILE}.bak"
    docker exec claude-bioflow-nginx nginx -s reload >/dev/null 2>&1 || true
    echo "Removed htpasswd entry for ${USERNAME}."
fi

echo "Workspace preserved at ${HUB_DIR}/workspaces/${USERNAME}/"
