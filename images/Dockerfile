FROM node:24.15.0-bookworm-slim
ARG CODEX_VERSION=0.162.1
ARG CLAUDE_VERSION=2.1.263
ARG OPENCODE_VERSION=1.18.34
# 系统工具由可信构建阶段安装，开发容器不保留网络管理权限。
RUN apt-get update && apt-get install -y --no-install-recommends nftables iproute2 git python3 curl wget ca-certificates procps && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_VERSION} opencode-ai@${OPENCODE_VERSION}
RUN mkdir -p /workspace /home/node/.config && chown -R node:node /workspace /home/node
ENV HOME=/home/node
WORKDIR /workspace
USER node
CMD ["sleep", "infinity"]
