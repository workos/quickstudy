# quickstudy egress-proxy sidecar image.
#
# One per run: attempt containers sit on an internal Docker network with no
# default route, and this proxy (attached to BOTH the internal network and
# the bridge) is their only way out — an HTTP CONNECT / absolute-form forward
# proxy enforcing the run's host allowlist (src/isolation/proxy/server.ts).
# No TLS interception: for HTTPS the proxy sees only the CONNECT host:port.
#
# Build context is src/isolation/proxy (the image needs exactly two files):
#   docker build -t quickstudy/egress-proxy -f images/egress-proxy/Dockerfile src/isolation/proxy
# or simply `quickstudy images build`, which builds this alongside the
# agent-runtime image.
#
# Config via env at `docker run`:
#   QUICKSTUDY_EGRESS_ALLOWLIST  comma-separated hosts / *.wildcards (required)
#   QUICKSTUDY_EGRESS_PORT       listen port (default 3128)

FROM oven/bun:1.3-slim

WORKDIR /app

COPY allowlist.ts server.ts ./proxy/

EXPOSE 3128

# Decisions (allowed + denied) stream to stdout as JSON lines; the harness
# reads them back with `docker logs` for per-attempt denial artifacts.
ENTRYPOINT ["bun", "/app/proxy/server.ts"]
