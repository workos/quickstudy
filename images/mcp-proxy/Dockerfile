# quickstudy mcp-proxy sidecar image.
#
# One per run, only when the runtime's mcpServers declare `auth`: attempt
# containers speak credential-free HTTP to this proxy, which forwards to the
# real MCP server injecting a Bearer access token it mints (and re-mints)
# from a refresh token (src/isolation/mcp-proxy/server.ts). Refresh tokens
# rotate on use; the current one is persisted inside the container at
# /run/quickstudy-mcp/ for the harness to read back at teardown.
#
# Build context is src/isolation/mcp-proxy (the image needs exactly one file):
#   docker build -t quickstudy/mcp-proxy -f images/mcp-proxy/Dockerfile src/isolation/mcp-proxy
# or simply `quickstudy images build`, which builds this alongside the
# agent-runtime and egress-proxy images.
#
# Config via env at `docker run` (secrets arrive via --env-file, never argv):
#   QUICKSTUDY_MCP_UPSTREAMS             JSON {name: {url, tokenEndpoint, clientId, resource?}}
#   QUICKSTUDY_MCP_REFRESH_TOKEN_<NAME>  initial refresh token per server
#   QUICKSTUDY_MCP_PORT                  listen port (default 8914)

FROM oven/bun:1.3-slim

WORKDIR /app

COPY server.ts ./mcp-proxy/

EXPOSE 8914

# Events (forwards + token refreshes) stream to stdout as JSON lines; token
# values never appear in them.
ENTRYPOINT ["bun", "/app/mcp-proxy/server.ts"]
