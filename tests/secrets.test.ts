import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  collectOptionalHostEnv,
  collectProviderKeys,
  endpointHosts,
  endpointUrl,
  hostSecretEnv,
  InvalidProviderKeyError,
  isSecretEnvName,
  MissingProviderKeyError,
  parseHeaderLines,
  redactSecrets,
  validateProviderKeys,
  type ProviderKeyProbe,
} from "../src/secrets.ts";

const SECRET = "sk-test-abc123def456ghi789";

describe("collectProviderKeys", () => {
  test("fails fast on a missing key, naming the env var and the agent", () => {
    expect(() =>
      collectProviderKeys([{ name: "claude", requiredHostEnv: ["QS_TEST_NEVER_SET_KEY"] }], {}),
    ).toThrow(MissingProviderKeyError);
    expect(() =>
      collectProviderKeys([{ name: "claude", requiredHostEnv: ["QS_TEST_NEVER_SET_KEY"] }], {}),
    ).toThrow(/QS_TEST_NEVER_SET_KEY/);
    expect(() =>
      collectProviderKeys([{ name: "claude", requiredHostEnv: ["QS_TEST_NEVER_SET_KEY"] }], {}),
    ).toThrow(/"claude"/);
  });

  test("an empty value counts as missing", () => {
    expect(() =>
      collectProviderKeys([{ name: "codex", requiredHostEnv: ["QS_TEST_EMPTY_KEY"] }], { QS_TEST_EMPTY_KEY: "" }),
    ).toThrow(MissingProviderKeyError);
  });

  test("collects every required key across adapters", () => {
    const keys = collectProviderKeys(
      [
        { name: "claude", requiredHostEnv: ["QS_KEY_A"] },
        { name: "codex", requiredHostEnv: ["QS_KEY_B"] },
      ],
      { QS_KEY_A: "value-a", QS_KEY_B: "value-b", QS_UNRELATED: "nope" },
    );
    expect(keys).toEqual({ QS_KEY_A: "value-a", QS_KEY_B: "value-b" });
  });

  test("never logs secret values while collecting", () => {
    const spies = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")];
    try {
      collectProviderKeys([{ name: "claude", requiredHostEnv: ["QS_KEY_A"] }], { QS_KEY_A: SECRET });
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(SECRET);
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("redactSecrets", () => {
  test("replaces every occurrence of a known secret with a named marker", () => {
    const env = { PROVIDER_KEY: SECRET };
    const text = `the agent echoed ${SECRET} twice: ${SECRET}`;
    const redacted = redactSecrets(text, env);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toBe("the agent echoed [REDACTED:PROVIDER_KEY] twice: [REDACTED:PROVIDER_KEY]");
  });

  test("redacts multiple secrets independently", () => {
    const env = { KEY_ONE: "secret-one-value", KEY_TWO: "secret-two-value" };
    const redacted = redactSecrets("a secret-one-value b secret-two-value", env);
    expect(redacted).toBe("a [REDACTED:KEY_ONE] b [REDACTED:KEY_TWO]");
  });

  test("trivially short values are left alone (they would shred ordinary text)", () => {
    const redacted = redactSecrets("the word a appears everywhere", { SHORT: "a" });
    expect(redacted).toBe("the word a appears everywhere");
  });

  test("text without secrets passes through unchanged", () => {
    const text = "nothing sensitive here";
    expect(redactSecrets(text, { PROVIDER_KEY: SECRET })).toBe(text);
  });
});

describe("validateProviderKeys", () => {
  const PROBE: ProviderKeyProbe = {
    name: "claude",
    envVars: ["ANTHROPIC_API_KEY"],
    url: "https://api.anthropic.example/v1/models",
    headers: { "x-api-key": "sk-test" },
  };

  function fakeFetch(status: number, calls: string[] = []): typeof fetch {
    return ((url: unknown) => {
      calls.push(String(url));
      return Promise.resolve(new Response("{}", { status }));
    }) as typeof fetch;
  }

  test("a 2xx probe passes and logs acceptance naming the env var and host", async () => {
    const lines: string[] = [];
    await validateProviderKeys([PROBE], { fetchImpl: fakeFetch(200), log: (line) => lines.push(line) });
    expect(lines.some((line) => line.includes("ANTHROPIC_API_KEY") && line.includes("api.anthropic.example"))).toBeTrue();
  });

  test("a 401 stops the run with 'run not starting', naming env var and host — never the value", async () => {
    await expect(validateProviderKeys([PROBE], { fetchImpl: fakeFetch(401) })).rejects.toThrow(InvalidProviderKeyError);
    try {
      await validateProviderKeys([PROBE], { fetchImpl: fakeFetch(401) });
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("run not starting");
      expect(message).toContain("ANTHROPIC_API_KEY");
      expect(message).toContain("api.anthropic.example");
      expect(message).not.toContain("sk-test");
    }
  });

  test("a 403 is also an auth rejection", async () => {
    await expect(validateProviderKeys([PROBE], { fetchImpl: fakeFetch(403) })).rejects.toThrow(InvalidProviderKeyError);
  });

  test("a network failure warns and proceeds — an unreachable probe is not a bad key", async () => {
    const lines: string[] = [];
    const failing = (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch;
    await validateProviderKeys([PROBE], { fetchImpl: failing, log: (line) => lines.push(line) });
    expect(lines.some((line) => line.startsWith("warning:") && line.includes("starting anyway"))).toBeTrue();
  });

  test("a non-auth error status (429/5xx) is inconclusive and proceeds", async () => {
    const lines: string[] = [];
    await validateProviderKeys([PROBE], { fetchImpl: fakeFetch(429), log: (line) => lines.push(line) });
    expect(lines.some((line) => line.includes("inconclusive") && line.includes("starting anyway"))).toBeTrue();
  });

  test("no probes means no fetches", async () => {
    const calls: string[] = [];
    await validateProviderKeys([], { fetchImpl: fakeFetch(200, calls) });
    expect(calls).toEqual([]);
  });
});

afterEach(() => {
  delete process.env["QS_TEST_NEVER_SET_KEY"];
});

describe("endpoint overrides", () => {
  const CLAUDE = {
    name: "claude",
    requiredHostEnv: ["ANTHROPIC_API_KEY"],
    optionalHostEnv: ["ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS"],
  } as const;

  test("collectOptionalHostEnv forwards set overrides and drops absent or empty ones", () => {
    expect(collectOptionalHostEnv([CLAUDE], {})).toEqual({});
    expect(collectOptionalHostEnv([CLAUDE], { ANTHROPIC_BASE_URL: "", ANTHROPIC_CUSTOM_HEADERS: "a: b" })).toEqual({
      ANTHROPIC_CUSTOM_HEADERS: "a: b",
    });
    // An adapter that declares no overrides forwards nothing, whatever the host has.
    expect(collectOptionalHostEnv([{ name: "x", requiredHostEnv: [] }], { ANTHROPIC_BASE_URL: "https://g.example" })).toEqual({});
  });

  test("endpointHosts takes the host of every absolute http(s) URL and ignores everything else", () => {
    expect(
      endpointHosts({
        ANTHROPIC_BASE_URL: "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic",
        ANTHROPIC_CUSTOM_HEADERS: "cf-aig-authorization: Bearer tok",
        OPENAI_BASE_URL: "http://localhost:8080/openai",
        JUNK: "not a url",
      }),
    ).toEqual(["gateway.ai.cloudflare.com", "localhost"]);
    expect(endpointHosts({ OTHER: "ftp://files.example/x" })).toEqual([]);
  });

  test("endpointUrl prefers a set override, tolerating trailing and leading slashes", () => {
    expect(endpointUrl(undefined, "https://api.anthropic.com", "v1/models")).toBe("https://api.anthropic.com/v1/models");
    expect(endpointUrl("", "https://api.anthropic.com", "v1/models")).toBe("https://api.anthropic.com/v1/models");
    expect(endpointUrl("https://g.example/anthropic/", "https://api.anthropic.com", "/v1/models")).toBe(
      "https://g.example/anthropic/v1/models",
    );
  });

  test("parseHeaderLines reads Name: Value lines, splitting on the first colon", () => {
    expect(parseHeaderLines(undefined)).toEqual({});
    expect(parseHeaderLines('cf-aig-authorization: Bearer tok\r\n\nno-colon\n: empty-name\ncf-aig-metadata: {"a":1}')).toEqual({
      "cf-aig-authorization": "Bearer tok",
      "cf-aig-metadata": '{"a":1}',
    });
  });

  test("header bundles count as secrets (they carry a bearer); base URLs do not", () => {
    expect(isSecretEnvName("ANTHROPIC_CUSTOM_HEADERS")).toBeTrue();
    expect(isSecretEnvName("ANTHROPIC_BASE_URL")).toBeFalse();
    const env = hostSecretEnv({
      ANTHROPIC_CUSTOM_HEADERS: "cf-aig-authorization: Bearer tok",
      ANTHROPIC_BASE_URL: "https://g.example",
      PATH: "/bin",
    });
    expect(Object.keys(env)).toEqual(["ANTHROPIC_CUSTOM_HEADERS"]);
  });
});
