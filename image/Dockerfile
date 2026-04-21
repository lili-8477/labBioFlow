# claude-bioflow per-user devcontainer image.
#
# Base: pantheon-agents-sc:latest — an existing, stable image that already
# carries Python 3.12 + scanpy + R 4.5.3 + IRkernel + Seurat/SoupX/scDblFinder
# via rpy2. We do NOT use any Pantheon framework code from the base; the
# adapter is the entrypoint, not Pantheon's startup wrapper.
#
# If you want to decouple fully, extract the bio stack into its own
# claude-bioflow-base image. See image/README.md.

FROM pantheon-agents-sc:latest

# 1. Node 20 for the claude CLI + adapter.
#    Use NodeSource for a clean apt install (Debian bookworm).
USER root
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        gnupg \
        tini \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# 2. Claude Code CLI — pinned. Bump deliberately.
RUN npm install -g @anthropic-ai/claude-code@2.1.116

# 3. Adapter bundle + Python kernel bridge.
#    jupyter_client is already in the base image (pantheon-agents-sc's Python env).
WORKDIR /opt/adapter
COPY adapter/package.json adapter/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY adapter/dist/ ./dist/
COPY image/kernel-bridge.py ./kernel-bridge.py

# 4. Entrypoint script launches the adapter under tini (PID 1 signal handling).
COPY image/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 5. Non-root runtime user. Base image ships only root, and NodeSource's
#    apt nodejs package doesn't create a user (unlike the official node:* images).
#    Match the host user's UID so bind-mounted workspace writes stay on the host
#    user. Default 1001 = the `lili` account on this host; override with
#    --build-arg UID=... GID=... for other hosts.
ARG UID=1001
ARG GID=1001
RUN groupadd --gid "${GID}" node \
    && useradd  --uid "${UID}" --gid node --create-home --shell /bin/bash node \
    && mkdir -p /home/node/.claude/skills \
                /home/node/.claude/agents \
                /home/node/.claude/projects \
    && chown -R node:node /home/node/.claude /opt/adapter \
    && chmod +x /opt/adapter/kernel-bridge.py

USER node
WORKDIR /workspace
ENV HOME=/home/node \
    WORKSPACE_ROOT=/workspace \
    DEFAULT_PROJECT=/workspace

ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
