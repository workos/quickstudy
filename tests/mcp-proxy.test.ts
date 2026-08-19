/**
 * MCP token-injecting proxy (src/isolation/mcp-proxy/server.ts) and its
 * harness wiring (src/isolation/mcp.ts).
 *
 * Fully offline: real loopback Bun.serve listeners stand in for the MCP
 * upstream and the OAuth token endpoint, so bearer injection, caching,
 * rotation, retry, and streaming are exercised through the proxy's actual
 * HTTP path — no fetch fakes. The one docker-shaped piece (the sidecar
 * container) is covered by the gated suite in docker.test.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authedMcpServers,
  persistRotatedRefreshToken,
  readMcpAuthMaterialFromConfig,
  rewriteMcpServerConfigs,
  type McpServerConfig,
} from "../src/isolation/mcp.ts";
import { sanitizeServerName, startMcpProxy, type McpUpstream } from "../src/isolation/mcp-proxy/server.ts";
import { discoverEvals } from "../src/evals/discovery.ts";
import type { LoadedExperiment } from "../src/experiments/types.ts";
import { planRun } from "../src/plan.ts";
import { executeRunV3 } from "../src/runner/execute.ts";
import { ArtifactsStore } from "../src/store/artifacts.ts";
import { ResultsStore } from "../src/store/db.ts";

const silent = (): void => {};
const cleanups: Array<() => unknown> = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** Loopback OAuth token endpoint; the handler decides each response. */
function fakeTokenEndpoint(
  handler: (call: number, params: URLSearchParams) => { status?: number; body: Record<string, unknown> } | Promise<{ status?: number; body: Record<string, unknown> }>,
): { url: string; calls: URLSearchParams[] } {
  const calls: URLSearchParams[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const params = new URLSearchParams(await request.text());
      const result = await handler(calls.length, params);
      calls.push(params);
      return Response.json(result.body, { status: result.status ?? 200 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/oauth2/token`, calls };
}

/** Loopback MCP upstream; records what auth/session each request carried. */
function fakeUpstream(
  handler: (seen: { auth: string | null; session: string | null; body: string }) => Response,
): { url: string; seen: Array<{ auth: string | null; session: string | null }> } {
  const seen: Array<{ auth: string | null; session: string | null }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const record = {
        auth: request.headers.get("authorization"),
        session: request.headers.get("mcp-session-id"),
        body: await request.text(),
      };
      seen.push({ auth: record.auth, session: record.session });
      return handler(record);
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/mcp`, seen };
}

function proxyFor(
  upstreams: Record<string, McpUpstream>,
  refreshTokens: Record<string, string>,
  tokenStateDir?: string,
): { base: string } {
  const handle = startMcpProxy({
    upstreams,
    refreshTokens,
    hostname: "127.0.0.1",
    ...(tokenStateDir !== undefined ? { tokenStateDir } : {}),
  });
  cleanups.push(() => handle.close());
  return { base: `http://127.0.0.1:${handle.port}` };
}

const okToken = (token: string, extra: Record<string, unknown> = {}): { body: Record<string, unknown> } => ({
  body: { access_token: token, expires_in: 3600, ...extra },
});

describe("mcp proxy: token injection and forwarding", () => {
  test("injects the bearer, forwards session headers both ways, sends RFC 8707 resource on refresh", async () => {
    const tokens = fakeTokenEndpoint(() => okToken("at-1"));
    const upstream = fakeUpstream(() =>
      Response.json({ ok: true }, { headers: { "mcp-session-id": "sess-9" } }),
    );
    const proxy = proxyFor(
      { svc: { url: upstream.url, tokenEndpoint: tokens.url, clientId: "client-1", resource: upstream.url } },
      { svc: "rt-1" },
    );

    const response = await fetch(`${proxy.base}/svc`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": "sess-9" },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBe("sess-9");
    expect(await response.json()).toEqual({ ok: true });

    expect(upstream.seen[0]?.auth).toBe("Bearer at-1");
    expect(upstream.seen[0]?.session).toBe("sess-9");
    const refresh = tokens.calls[0] as URLSearchParams;
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe("rt-1");
    expect(refresh.get("client_id")).toBe("client-1");
    expect(refresh.get("resource")).toBe(upstream.url);
  });

  test("caches the access token until expiry; expires_in 0 forces re-refresh", async () => {
    const cached = fakeTokenEndpoint((call) => okToken(`at-${call}`));
    const upstream = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = proxyFor(
      { svc: { url: upstream.url, tokenEndpoint: cached.url, clientId: "c" } },
      { svc: "rt-1" },
    );
    await fetch(`${proxy.base}/svc`, { method: "POST", body: "{}" });
    await fetch(`${proxy.base}/svc`, { method: "POST", body: "{}" });
    expect(cached.calls.length).toBe(1);

    const expiring = fakeTokenEndpoint((call) => ({ body: { access_token: `at-${call}`, expires_in: 0 } }));
    const proxy2 = proxyFor(
      { svc: { url: upstream.url, tokenEndpoint: expiring.url, clientId: "c" } },
      { svc: "rt-1" },
    );
    await fetch(`${proxy2.base}/svc`, { method: "POST", body: "{}" });
    await fetch(`${proxy2.base}/svc`, { method: "POST", body: "{}" });
    expect(expiring.calls.length).toBe(2);
  });

  test("persists the initial and every rotated refresh token to the state dir", async () => {
    const stateDir = join(mkdtempSync(join(tmpdir(), "quickstudy-mcp-state-")), "tokens");
    const tokens = fakeTokenEndpoint(() => okToken("at-1", { refresh_token: "rt-2" }));
    const upstream = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = proxyFor(
      { svc: { url: upstream.url, tokenEndpoint: tokens.url, clientId: "c" } },
      { svc: "rt-1" },
      stateDir,
    );

    const stateFile = join(stateDir, `${sanitizeServerName("svc")}.refresh-token`);
    // Written at startup, before any request — teardown read-back never races.
    expect(readFileSync(stateFile, "utf8")).toBe("rt-1\n");
    await fetch(`${proxy.base}/svc`, { method: "POST", body: "{}" });
    expect(readFileSync(stateFile, "utf8")).toBe("rt-2\n");
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
  });

  test("a 401 upstream answer forces one refresh and one retry", async () => {
    const tokens = fakeTokenEndpoint((call) => okToken(`at-${call + 1}`));
    const upstream = fakeUpstream((seen) =>
      seen.auth === "Bearer at-2" ? Response.json({ ok: true }) : new Response("unauthorized", { status: 401 }),
    );
    const proxy = proxyFor(
      { svc: { url: upstream.url, tokenEndpoint: tokens.url, clientId: "c" } },
      { svc: "rt-1" },
    );
    const response = await fetch(`${proxy.base}/svc`, { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    expect(tokens.calls.length).toBe(2);
    expect(upstream.seen.length).toBe(2);
  });

  test("concurrent first requests share a single refresh (rotation makes racing fatal)", async () => {
    const tokens = fakeTokenEndpoint(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return okToken("at-1");
    });
    const upstream = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = proxyFor(
      { svc: { url: upstream.url, tokenEndpoint: tokens.url, clientId: "c" } },
      { svc: "rt-1" },
    );
    const [a, b] = await Promise.all([
      fetch(`${proxy.base}/svc`, { method: "POST", body: "{}" }),
      fetch(`${proxy.base}/svc`, { method: "POST", body: "{}" }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(tokens.calls.length).toBe(1);
  });

  test("unknown server names answer 404, not a forward", async () => {
    const tokens = fakeTokenEndpoint(() => okToken("at-1"));
    const upstream = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = proxyFor(
      { svc: { url: upstream.url, tokenEndpoint: tokens.url, clientId: "c" } },
      { svc: "rt-1" },
    );
    const response = await fetch(`${proxy.base}/nope`, { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
    expect(upstream.seen.length).toBe(0);
  });

  test("refresh failure answers 502 with the OAuth code and no token material", async () => {
    const tokens = fakeTokenEndpoint(() => ({ status: 400, body: { error: "invalid_grant" } }));
    const upstream = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = proxyFor(
      { svc: { url: upstream.url, tokenEndpoint: tokens.url, clientId: "c" } },
      { svc: "rt-secret-value" },
    );
    const response = await fetch(`${proxy.base}/svc`, { method: "POST", body: "{}" });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("invalid_grant");
    expect(text).not.toContain("rt-secret-value");
    expect(upstream.seen.length).toBe(0);
  });

  test("SSE responses stream through with their content type", async () => {
    const tokens = fakeTokenEndpoint(() => okToken("at-1"));
    const frame = `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n`;
    const upstream = fakeUpstream(
      () => new Response(frame, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const proxy = proxyFor(
      { svc: { url: upstream.url, tokenEndpoint: tokens.url, clientId: "c" } },
      { svc: "rt-1" },
    );
    const response = await fetch(`${proxy.base}/svc`, { method: "POST", body: "{}" });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe(frame);
  });
});

describe("mcp wiring helpers", () => {
  const AUTH = {
    kind: "oauth-refresh" as const,
    tokenEndpoint: "https://as.example/token",
    resource: "https://mcp.example/mcp",
    clientIdKey: "CLIENT_ID",
    refreshTokenKey: "REFRESH_TOKEN",
  };

  function credentialsFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "quickstudy-mcp-creds-"));
    const path = join(dir, "auth.env");
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  }

  test("authedMcpServers filters; rewriteMcpServerConfigs swaps URLs and strips auth", () => {
    const servers: Record<string, McpServerConfig> = {
      open: { url: "https://open.example/mcp" },
      locked: { url: "https://mcp.example/mcp", auth: { ...AUTH, credentialsFile: "/nowhere" } },
    };
    expect(Object.keys(authedMcpServers(servers))).toEqual(["locked"]);
    const rewritten = rewriteMcpServerConfigs(servers, "http://10.0.0.2:8914");
    expect(rewritten["open"]).toEqual({ url: "https://open.example/mcp" });
    expect(rewritten["locked"]).toEqual({ url: "http://10.0.0.2:8914/locked" });
  });

  test("readMcpAuthMaterialFromConfig builds sidecar material from the credentials file", () => {
    const path = credentialsFile("# login tooling wrote this\nCLIENT_ID=client-9\nREFRESH_TOKEN=rt-9\n");
    const material = readMcpAuthMaterialFromConfig({
      locked: { url: "https://mcp.example/mcp", auth: { ...AUTH, credentialsFile: path } },
    });
    expect(material.upstreams["locked"]).toEqual({
      url: "https://mcp.example/mcp",
      tokenEndpoint: AUTH.tokenEndpoint,
      clientId: "client-9",
      resource: AUTH.resource,
    });
    expect(material.refreshTokens["locked"]).toBe("rt-9");
  });

  test("missing credentials file and missing keys fail loudly with the operator's fix", () => {
    const servers = (path: string): Record<string, McpServerConfig> => ({
      locked: { url: "https://mcp.example/mcp", auth: { ...AUTH, credentialsFile: path } },
    });
    expect(() => readMcpAuthMaterialFromConfig(servers("/nonexistent/auth.env"))).toThrow(/does not exist.*login tooling/);
    expect(() => readMcpAuthMaterialFromConfig(servers(credentialsFile("CLIENT_ID=c\n")))).toThrow(/lacks/);
  });

  test("server names colliding after sanitization are refused", () => {
    const path = credentialsFile("CLIENT_ID=c\nREFRESH_TOKEN=r\n");
    const spec = { url: "https://mcp.example/mcp", auth: { ...AUTH, credentialsFile: path } };
    expect(() => readMcpAuthMaterialFromConfig({ "svc-a": spec, "svc a": spec })).toThrow(/collide/);
  });

  test("persistRotatedRefreshToken updates in place, preserves other lines, keeps 0600", () => {
    const path = credentialsFile("# comment\nCLIENT_ID=client-9\nREFRESH_TOKEN=rt-old\n");
    const spec: McpServerConfig = { url: "u", auth: { ...AUTH, credentialsFile: path } };
    persistRotatedRefreshToken(spec, "rt-new");
    expect(readFileSync(path, "utf8")).toBe("# comment\nCLIENT_ID=client-9\nREFRESH_TOKEN=rt-new\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const bare = credentialsFile("CLIENT_ID=client-9\n");
    persistRotatedRefreshToken({ url: "u", auth: { ...AUTH, credentialsFile: bare } }, "rt-new");
    expect(readFileSync(bare, "utf8")).toBe("CLIENT_ID=client-9\nREFRESH_TOKEN=rt-new\n");
  });
});

// ---------------------------------------------------------------------------
// Runner fail-fast (no docker needed: the credentials check throws before any
// container work). Successor to the deleted pack-loader/orchestrator guard:
// the shape validation of auth blocks now lives with the runtime authors
// (TypeScript types), while the credentials-file preflight lives in the v3
// runner's treatment setup.
// ---------------------------------------------------------------------------

describe("mcp auth: v3 runner fail-fast", () => {
  test("a run with an mcp treatment refuses to start when the credentials file is absent", async () => {
    const evalsRoot = mkdtempSync(join(tmpdir(), "quickstudy-mcp-evals-"));
    const evalDir = join(evalsRoot, "mcp-guard");
    mkdirSync(evalDir, { recursive: true });
    writeFileSync(join(evalDir, "PROMPT.md"), "---\nid: mcp-guard\nsuite: benchmark\n---\n\nIntegrate widgets.\n");
    writeFileSync(join(evalDir, "EVAL.ts"), "export default async () => ({ passed: true, checks: [] });\n");
    const evals = discoverEvals(evalsRoot);

    const experimentDir = mkdtempSync(join(tmpdir(), "quickstudy-mcp-exp-"));
    const experimentPath = join(experimentDir, "mcp-arm.ts");
    writeFileSync(experimentPath, "// synthetic module for mcp-arm\n");
    const experiments: LoadedExperiment[] = [
      {
        experiment: {
          id: "mcp-arm",
          agent: { adapter: "scripted" },
          runtime: {
            kind: "container",
            image: "alpine:3",
            command: ["true"],
            mcpServers: () => ({
              svc: {
                url: "https://mcp.example/mcp",
                auth: {
                  kind: "oauth-refresh",
                  tokenEndpoint: "https://as.example/token",
                  credentialsFile: "/nonexistent/quickstudy-auth.env",
                  clientIdKey: "CLIENT_ID",
                  refreshTokenKey: "REFRESH_TOKEN",
                },
              },
            }),
          },
        },
        path: experimentPath,
      },
    ];

    const root = mkdtempSync(join(tmpdir(), "quickstudy-mcp-run-"));
    const store = new ResultsStore(join(root, "results.db"));
    const artifacts = new ArtifactsStore(join(root, "results"));
    try {
      await expect(
        executeRunV3({
          evals,
          experiments,
          plan: planRun(evals, experiments.map((entry) => entry.experiment), 1),
          store,
          artifacts,
          log: silent,
        }),
      ).rejects.toThrow(/credentials file .* does not exist/);
      // Fail-fast means no run row was ever inserted.
      expect(store.listRuns()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
