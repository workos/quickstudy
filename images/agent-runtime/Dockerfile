# quickstudy agent-runtime base image.
#
# Debian-slim + git + node, with the agent CLIs installed at PINNED versions:
# vendor CLIs change their stream formats between releases, and the parsers in
# src/adapters/parse.ts are tested against fixtures captured from these exact
# versions. Bump the pins deliberately (`quickstudy images build --pull`) and
# re-capture fixtures when you do.
#
# Framework toolchains (Rails, Django, ...) layer on top in Phase 3 — this
# image stays agent-only.

FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.215
ARG CODEX_VERSION=0.144.6
ARG GEMINI_CLI_VERSION=0.51.0
# cursor-agent is not an npm package: it ships as versioned tarballs (the
# vendor install script pins the same way). Fixture streams in
# tests/__fixtures__/streams/cursor/ correspond to this pin.
ARG CURSOR_AGENT_VERSION=2026.07.17-3e2a980

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git procps ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  "@openai/codex@${CODEX_VERSION}" \
  "@google/gemini-cli@${GEMINI_CLI_VERSION}"

RUN arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
       amd64) cursor_arch=x64 ;; \
       arm64) cursor_arch=arm64 ;; \
       *) echo "unsupported architecture for cursor-agent: $arch" >&2; exit 1 ;; \
     esac \
  && mkdir -p /opt/cursor-agent \
  && curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${cursor_arch}/agent-cli-package.tar.gz" \
     | tar --strip-components=1 -xzf - -C /opt/cursor-agent \
  && ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent

# The fixture-baseline commit (and any commits the agent makes) need an
# identity; system-level config applies to whichever user runs.
RUN git config --system user.name "quickstudy" \
  && git config --system user.email "quickstudy@localhost" \
  && git config --system init.defaultBranch main \
  && git config --system --add safe.directory /workspace

# Claude Code refuses --dangerously-skip-permissions as root unless it can
# tell it is inside a sandbox. The container IS the security boundary here —
# that is the entire point of this phase.
ENV IS_SANDBOX=1

WORKDIR /workspace

# The harness drives everything through `docker exec`; the main process just
# keeps the container alive until teardown.
CMD ["sleep", "infinity"]
