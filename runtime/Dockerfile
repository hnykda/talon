# talon runtime image — N persistent interactive Claude Code sessions in tmux,
# each bridged to Mattermost via the channel-server MCP server.
#
# Build context MUST be the repo root, not runtime/, because the image needs
# both runtime/ and channel-server/:
#
#   docker build --platform linux/amd64 -f runtime/Dockerfile -t talon:dev .
#
# Build for the platform your cluster runs on (usually linux/amd64).

FROM node:22-bookworm

# --- OS tooling -------------------------------------------------------------
# gettext-base provides envsubst (optional .mcp.json.tmpl rendering).
# procps gives the supervisor ps/pgrep for debugging inside the pod.
# sqlite3 is the CLI for the history archive (FTS5 queries).
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux \
      git \
      jq \
      python3 \
      python3-venv \
      ripgrep \
      curl \
      ca-certificates \
      gettext-base \
      procps \
      less \
      sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# mikefarah yq v4 (Debian's apt "yq" is the unrelated Python one); the
# supervisor uses it to parse runtime/agents.yaml.
ARG YQ_VERSION=v4.44.6
ARG TARGETARCH=amd64
RUN curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${TARGETARCH}" \
      -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq

# --- Python tool venv (uv, lockfile-pinned) ----------------------------------
# croniter+pyyaml for the cron scheduler, sqlite-vec for semantic search.
# The venv bin dir goes first on PATH so `python3` inside the pod is this
# venv. Agent-driven `uv` use at runtime caches on the PVC (UV_CACHE_DIR).
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
COPY runtime/tools/pyproject.toml runtime/tools/uv.lock /opt/talon-tools/
RUN UV_CACHE_DIR=/opt/uv/cache uv sync --frozen --project /opt/talon-tools --python 3.14 \
    && rm -rf /opt/uv/cache
ENV PATH="/opt/talon-tools/.venv/bin:${PATH}"
ENV UV_CACHE_DIR=/home/claude/.cache/uv

# --- Node tooling -----------------------------------------------------------
# claude: the Claude Code CLI. tsx: TS loader used to run the channel server
# (`node --import tsx /app/channel-server/src/index.ts`, see .mcp.json).
RUN npm install -g @anthropic-ai/claude-code tsx

# --- App --------------------------------------------------------------------
# /app/runtime         supervisor, agents.yaml, agent skeletons, shared config
# /app/channel-server  Mattermost MCP channel server
COPY . /app
RUN chmod +x /app/runtime/supervisor/entrypoint.sh \
    && if [ -f /app/channel-server/package.json ]; then \
         cd /app/channel-server && (npm ci || npm install); \
       fi

# --- Non-root user (uid 1000), HOME on the PVC ------------------------------
# node:22-bookworm ships user "node" with uid 1000; rename it to "claude" and
# point HOME at /home/claude, which is the PVC mountpoint at runtime (Claude
# Code credentials in ~/.claude*, per-agent workdirs in ~/agents/<name>).
RUN groupmod -n claude node \
    && usermod -l claude -d /home/claude node \
    && mkdir -p /home/claude \
    && chown -R 1000:1000 /home/claude /app

ENV HOME=/home/claude
USER 1000:1000
WORKDIR /home/claude

ENTRYPOINT ["/app/runtime/supervisor/entrypoint.sh"]
