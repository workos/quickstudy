/**
 * Egress proxy unit tests: the allowlist matcher (case, ports, wildcards,
 * raw-IP refusal, trailing dots) and live proxy behavior against local
 * listeners on random ports — allow, deny-with-host-named, raw-IP refusal,
 * plain-HTTP forwarding, and the stability of the denial event shape. No
 * Docker, no network beyond loopback.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createServer, connect, type Server, type Socket } from "node:net";
import {
  AllowlistEntryError,
  composeAllowlistFromHosts,
  hostAllowed,
  isRawIpHost,
  normalizeHost,
  parseHostPort,
  validateAllowlistEntry,
} from "../src/isolation/proxy/allowlist.ts";
import { startEgressProxy, type EgressEvent, type EgressProxyHandle } from "../src/isolation/proxy/server.ts";

describe("allowlist entry validation", () => {
  test("normalizes case and trailing dot", () => {
    expect(validateAllowlistEntry("Api.WorkOS.com")).toBe("api.workos.com");
    expect(validateAllowlistEntry("workos.com.")).toBe("workos.com");
  });

  test("accepts wildcards and single-label hosts", () => {
    expect(validateAllowlistEntry("*.workos.com")).toBe("*.workos.com");
    expect(validateAllowlistEntry("localhost")).toBe("localhost");
    expect(validateAllowlistEntry("origin")).toBe("origin");
  });

  test("rejects schemes, paths, ports, inner wildcards, and IP literals", () => {
    for (const bad of [
      "https://workos.com",
      "workos.com/api",
      "workos.com:443",
      "a.*.workos.com",
      "*.com*",
      "1.2.3.4",
      "*.1.2.3.4",
      "[::1]",
      "2130706433",
      "",
      "  ",
    ]) {
      expect(() => validateAllowlistEntry(bad)).toThrow(AllowlistEntryError);
    }
  });
});

describe("host matching", () => {
  const list = ["workos.com", "*.workos.com", "registry.npmjs.org"];

  test("exact match is case-insensitive and trailing-dot tolerant", () => {
    expect(hostAllowed("workos.com", list)).toBeTrue();
    expect(hostAllowed("WorkOS.COM", list)).toBeTrue();
    expect(hostAllowed("workos.com.", list)).toBeTrue();
    expect(hostAllowed("registry.npmjs.org", list)).toBeTrue();
  });

  test("wildcard matches subdomains at any depth but never the apex alone", () => {
    expect(hostAllowed("api.workos.com", list)).toBeTrue();
    expect(hostAllowed("a.b.workos.com", list)).toBeTrue();
    // apex covered by the separate exact entry, not the wildcard:
    expect(hostAllowed("workos.com", ["*.workos.com"])).toBeFalse();
    // suffix tricks do not match:
    expect(hostAllowed("evilworkos.com", list)).toBeFalse();
    expect(hostAllowed("workos.com.evil.example", list)).toBeFalse();
  });

  test("unlisted hosts and IP literals never match", () => {
    expect(hostAllowed("example.com", list)).toBeFalse();
    expect(hostAllowed("1.2.3.4", [...list, "1.2.3.4"] as string[])).toBeFalse();
  });
});

describe("raw-IP detection", () => {
  test("all IP-literal spellings are refused", () => {
    for (const ip of ["1.2.3.4", "127.0.0.1", "2130706433", "0x7f000001", "::1", "[::1]", "fe80::1", "1.2.3", "10.0"]) {
      expect(isRawIpHost(ip)).toBeTrue();
    }
  });

  test("hostnames are not", () => {
    for (const host of ["example.com", "localhost", "a1.b2.c3", "1password.com", "x0.org"]) {
      expect(isRawIpHost(host)).toBeFalse();
    }
  });
});

describe("CONNECT target parsing", () => {
  test("host:port, default port, bracketed IPv6, junk", () => {
    expect(parseHostPort("example.com:8443")).toEqual({ host: "example.com", port: 8443 });
    expect(parseHostPort("example.com")).toEqual({ host: "example.com", port: 443 });
    expect(parseHostPort("[::1]:443")).toEqual({ host: "[::1]", port: 443 });
    expect(parseHostPort("example.com:99999")).toBeUndefined();
    expect(parseHostPort("example.com:0")).toBeUndefined();
    expect(parseHostPort("example.com:abc")).toBeUndefined();
    expect(parseHostPort("")).toBeUndefined();
  });

  test("normalizeHost lowercases and strips one trailing dot", () => {
    expect(normalizeHost("API.Workos.Com.")).toBe("api.workos.com");
  });
});

describe("allowlist composition", () => {
  test("merges adapter + runtime host contributions, deduped and sorted", () => {
    const composed = composeAllowlistFromHosts([
      // adapter (harness-default) layer
      "api.anthropic.com",
      "*.sentry.io",
      "api.openai.com",
      "api.anthropic.com",
      // runtime layer (product hosts + the planned framework's registry)
      "workos.com",
      "*.workos.com",
      "registry.npmjs.org",
    ]);
    expect(composed).toEqual([
      "*.sentry.io",
      "*.workos.com",
      "api.anthropic.com",
      "api.openai.com",
      "registry.npmjs.org",
      "workos.com",
    ]);
    // rails registry excluded: that framework's runtime hosts were not supplied.
    expect(composed).not.toContain("rubygems.org");
  });

  test("throws on invalid contributions, naming the entry", () => {
    expect(() => composeAllowlistFromHosts(["1.2.3.4"])).toThrow(/1\.2\.3\.4/);
  });
});

/** Read from a socket until the buffer contains `marker` (or timeout). */
function readUntil(socket: Socket, marker: string, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${marker}"; got: ${data}`)), timeoutMs);
    const onData = (chunk: Buffer): void => {
      data += chunk.toString("latin1");
      if (data.includes(marker)) {
        clearTimeout(timer);
        socket.removeListener("data", onData);
        resolve(data);
      }
    };
    socket.on("data", onData);
    socket.on("close", () => {
      if (data.includes(marker)) return;
      clearTimeout(timer);
      reject(new Error(`socket closed before "${marker}"; got: ${data}`));
    });
  });
}

/** Read until the peer closes the socket. */
function readToEnd(socket: Socket, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => reject(new Error(`timeout; got: ${data}`)), timeoutMs);
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("latin1");
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.on("error", () => {});
  });
}

// Live-proxy fixtures (module scope — bun:test describe bodies are sync).
// A TCP echo listener stands in for a TLS origin: CONNECT tunnels are opaque
// byte pipes, so echo proves the tunnel without certificate games.
const echo: Server = createServer((socket) => {
  socket.on("data", (chunk) => socket.write(chunk));
  socket.on("error", () => socket.destroy());
});
await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
const echoPort = (echo.address() as { port: number }).port;

// A plain-HTTP origin for the absolute-form forward path.
const httpOrigin = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req) => new Response(`origin says hello: ${new URL(req.url).pathname}`),
});

const events: EgressEvent[] = [];
const proxy: EgressProxyHandle = await startEgressProxy({
  allowlist: ["localhost", "allowed.test", "*.wild.test"],
  hostname: "127.0.0.1",
  onEvent: (event) => events.push(event),
});

describe("egress proxy (live, loopback)", () => {
  afterAll(async () => {
    await proxy.close();
    echo.close();
    await httpOrigin.stop(true);
  });

  function dialProxy(): Socket {
    const socket = connect(proxy.port, "127.0.0.1");
    socket.on("error", () => {});
    return socket;
  }

  test("CONNECT to an allowlisted host tunnels bytes both ways", async () => {
    const socket = dialProxy();
    socket.write(`CONNECT localhost:${echoPort} HTTP/1.1\r\nHost: localhost:${echoPort}\r\n\r\n`);
    const head = await readUntil(socket, "\r\n\r\n");
    expect(head).toContain("200 Connection Established");
    socket.write("ping-through-tunnel");
    const echoed = await readUntil(socket, "ping-through-tunnel");
    expect(echoed).toContain("ping-through-tunnel");
    socket.destroy();
    const event = events.findLast((e) => e.host === "localhost" && e.method === "CONNECT");
    expect(event?.decision).toBe("allowed");
  });

  test("bytes sent eagerly after the CONNECT head are not lost", async () => {
    const socket = dialProxy();
    // Head and payload in a single write — the early-TLS-hello case.
    socket.write(`CONNECT localhost:${echoPort} HTTP/1.1\r\n\r\nearly-bytes`);
    await readUntil(socket, "200 Connection Established");
    const echoed = await readUntil(socket, "early-bytes");
    expect(echoed).toContain("early-bytes");
    socket.destroy();
  });

  test("case and trailing dot do not bypass matching", async () => {
    const socket = dialProxy();
    socket.write(`CONNECT LOCALHOST.:${echoPort} HTTP/1.1\r\n\r\n`);
    const head = await readUntil(socket, "\r\n\r\n");
    expect(head).toContain("200 Connection Established");
    socket.destroy();
  });

  test("non-allowlisted CONNECT gets 403 naming the host", async () => {
    const socket = dialProxy();
    socket.write("CONNECT evil.example:443 HTTP/1.1\r\n\r\n");
    const response = await readToEnd(socket);
    expect(response).toContain("403 Forbidden");
    expect(response).toContain('"evil.example"');
    expect(response).toContain("allowlist");
    const event = events.findLast((e) => e.host === "evil.example");
    expect(event?.decision).toBe("denied");
    expect(event?.reason).toBe("not_allowlisted");
  });

  test("raw-IP CONNECT targets are refused even when the IP serves an allowlisted host", async () => {
    const socket = dialProxy();
    socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\n\r\n`);
    const response = await readToEnd(socket);
    expect(response).toContain("403 Forbidden");
    expect(response).toContain("127.0.0.1");
    const event = events.findLast((e) => e.host === "127.0.0.1");
    expect(event?.reason).toBe("raw_ip");
  });

  test("wildcard entries admit subdomains through the gate", async () => {
    // What happens after the gate depends on the resolver (some resolve
    // anything under .test) — the DECISION is what this asserts: the gate
    // emits "allowed" and never a 403.
    const socket = dialProxy();
    socket.write("CONNECT sub.wild.test:443 HTTP/1.1\r\n\r\n");
    const deadline = Date.now() + 5_000;
    let event: EgressEvent | undefined;
    while (!(event = events.findLast((e) => e.host === "sub.wild.test")) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    socket.destroy();
    expect(event?.decision).toBe("allowed");
  }, 10_000);

  test("plain-HTTP absolute-form forward works for allowlisted hosts", async () => {
    const socket = dialProxy();
    socket.write(
      `GET http://localhost:${httpOrigin.port}/hello HTTP/1.1\r\nHost: localhost:${httpOrigin.port}\r\n\r\n`,
    );
    const response = await readToEnd(socket);
    expect(response).toContain("200");
    expect(response).toContain("origin says hello: /hello");
  });

  test("plain-HTTP forward to a non-allowlisted host is 403", async () => {
    const socket = dialProxy();
    socket.write("GET http://denied.example/ HTTP/1.1\r\nHost: denied.example\r\n\r\n");
    const response = await readToEnd(socket);
    expect(response).toContain("403 Forbidden");
    expect(response).toContain('"denied.example"');
  });

  test("origin-form requests (non-proxy clients) and malformed CONNECTs get 400", async () => {
    const one = dialProxy();
    one.write("GET /not-absolute HTTP/1.1\r\nHost: x\r\n\r\n");
    expect(await readToEnd(one)).toContain("400 Bad Request");

    const two = dialProxy();
    two.write("CONNECT evil.example:notaport HTTP/1.1\r\n\r\n");
    expect(await readToEnd(two)).toContain("400 Bad Request");
  });

  test("denial event line shape is stable", () => {
    const denial = events.find((e) => e.reason === "not_allowlisted");
    expect(denial).toBeDefined();
    const line = JSON.parse(JSON.stringify(denial)) as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual(["client", "decision", "host", "method", "port", "reason", "ts", "type"]);
    expect(line["type"]).toBe("egress");
    expect(line["decision"]).toBe("denied");
    expect(typeof line["ts"]).toBe("string");
    expect(typeof line["client"]).toBe("string");
    expect(typeof line["port"]).toBe("number");
  });

  test("startEgressProxy rejects a malformed allowlist up front", () => {
    expect(() => startEgressProxy({ allowlist: ["http://nope.example"] })).toThrow(AllowlistEntryError);
  });
});
