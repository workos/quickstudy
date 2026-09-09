/**
 * Container environment assembly and secret hygiene.
 *
 * Two sources feed an attempt's environment:
 *   (a) shared provider keys, read from the HOST env per selected adapter
 *       (ANTHROPIC_API_KEY for claude, OPENAI_API_KEY for codex; each
 *       adapter declares its own `requiredHostEnv`, nothing here is
 *       per-vendor) — validated fail-fast before any container is created,
 *       and each attempt only receives the keys its own adapter requires;
 *   (b) per-attempt credentials from the experiment runtime's provision
 *       hook.
 *
 * Invariants: secret VALUES are never logged and never written to artifacts —
 * `credential_ref` (an identifier, never the secret) is what lands in the
 * attempt row, and every transcript/stderr write passes through
 * {@link redactSecrets} first.
 */

/** A provider key required by a selected adapter is absent from the host env. */
export class MissingProviderKeyError extends Error {
  readonly adapter: string;
  readonly envVar: string;

  constructor(adapter: string, envVar: string) {
    super(
      `agent "${adapter}" requires the ${envVar} environment variable, which is not set — ` +
        `export it before running (it is injected into attempt containers at create, never mounted or persisted)`,
    );
    this.name = "MissingProviderKeyError";
    this.adapter = adapter;
    this.envVar = envVar;
  }
}

/** A provider key is present but the provider's API rejected it. */
export class InvalidProviderKeyError extends Error {
  constructor(adapter: string, envVars: readonly string[], host: string, status: number) {
    super(
      `run not starting: agent "${adapter}" key (${envVars.join(", ")}) was rejected by ${host} (HTTP ${status}) — ` +
        `nothing was created; fix or re-export the key and re-run`,
    );
    this.name = "InvalidProviderKeyError";
  }
}

export interface ProviderKeyRequirement {
  /** The adapter (agent axis value) that needs the keys. */
  name: string;
  /** Host env var names the adapter requires. */
  requiredHostEnv: readonly string[];
}

/** One preflight probe: a cheap authenticated GET a provider will 401 on a bad key. */
export interface ProviderKeyProbe {
  /** The adapter whose key is being probed. */
  name: string;
  /** The env var names the probe's key came from (for messages; values never appear). */
  envVars: readonly string[];
  url: string;
  headers: Record<string, string>;
}

/** Probe responses take at most this long before the run proceeds unvalidated. */
const KEY_PROBE_TIMEOUT_MS = 10_000;

/**
 * Live provider-key preflight: probe each adapter's endpoint once, BEFORE any
 * container or sidecar exists. Only an explicit auth rejection (401/403)
 * stops the run — a key that is present but rejected would otherwise burn a
 * container per attempt just to fail identically inside it. Network failures
 * and non-auth statuses warn and proceed: an unreachable or rate-limiting
 * probe is not evidence the key is bad.
 */
export async function validateProviderKeys(
  probes: readonly ProviderKeyProbe[],
  opts: { fetchImpl?: typeof fetch; log?: (line: string) => void; timeoutMs?: number } = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? KEY_PROBE_TIMEOUT_MS;
  for (const probe of probes) {
    const host = new URL(probe.url).host;
    let status: number;
    try {
      const response = await fetchImpl(probe.url, {
        method: "GET",
        headers: probe.headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
    } catch (err) {
      log(
        `warning: could not validate ${probe.envVars.join(", ")} against ${host} ` +
          `(${err instanceof Error ? err.message : String(err)}) — starting anyway`,
      );
      continue;
    }
    if (status === 401 || status === 403) {
      throw new InvalidProviderKeyError(probe.name, probe.envVars, host, status);
    }
    if (status >= 200 && status < 300) {
      log(`preflight: ${probe.envVars.join(", ")} accepted by ${host}`);
    } else {
      log(`preflight: ${probe.envVars.join(", ")} check against ${host} inconclusive (HTTP ${status}) — starting anyway`);
    }
  }
}

/**
 * Read every required provider key from the host env, failing fast — before
 * any container is created — on the first missing or empty variable, naming
 * both the variable and the agent that needs it.
 */
export function collectProviderKeys(
  requirements: readonly ProviderKeyRequirement[],
  hostEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const requirement of requirements) {
    for (const envVar of requirement.requiredHostEnv) {
      const value = hostEnv[envVar];
      if (value === undefined || value === "") {
        throw new MissingProviderKeyError(requirement.name, envVar);
      }
      keys[envVar] = value;
    }
  }
  return keys;
}

/** Values shorter than this are never redacted (they would shred ordinary text). */
const MIN_REDACTABLE_LENGTH = 6;

/**
 * Replace every known secret value in `text` with `[REDACTED:<name>]`.
 * Applied to transcripts and stderr before they are written to artifacts —
 * an agent that echoes its env must not persist a live key.
 */
export function redactSecrets(text: string, env: Record<string, string>): string {
  let redacted = text;
  for (const [name, value] of Object.entries(env)) {
    if (value.length < MIN_REDACTABLE_LENGTH) continue;
    redacted = redacted.replaceAll(value, `[REDACTED:${name}]`);
  }
  return redacted;
}

/** Provider/judge secret env only; ordinary PATH and workspace values are evidence. */
export function hostSecretEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => /key|token|password|secret|credential/i.test(name) && typeof value === "string")) as Record<string, string>;
}
