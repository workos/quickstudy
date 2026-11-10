/**
 * `agent.endpoint` resolution: the experiment names the HOST ENV VARS that
 * carry an agent's API key, base URL and extra headers; the adapter fills in
 * its vendor defaults for whatever is unset and checks the names before any
 * container starts. Names, never values, live here — the values stay on the
 * host and ride the same channels the vendor defaults always have.
 */

import { isSecretEnvName } from "../secrets.ts";
import type { AgentEndpointSpec } from "./types.ts";

/** POSIX env var names the shell shims interpolate verbatim; nothing else is accepted. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export const WIRE_APIS = ["responses", "chat"] as const;
export type WireApi = (typeof WIRE_APIS)[number];

/** An adapter's endpoint with every field decided. */
export interface ResolvedEndpoint {
  apiKeyEnv: string;
  baseUrlEnv: string;
  headersEnv: string;
  wireApi: WireApi;
}

/** Thrown for an `agent.endpoint` the harness refuses; the message names the field. */
export class InvalidAgentEndpointError extends Error {
  constructor(detail: string) {
    super(`agent.endpoint: ${detail}`);
    this.name = "InvalidAgentEndpointError";
  }
}

/**
 * Check an experiment's `agent.endpoint` without an adapter: every name must
 * be a POSIX env var name, the key and headers variables must be
 * secret-named (so they are redacted from artifacts like a key), the base
 * URL variable must not be (its value is identity and joins the egress
 * allowlist), and the three must differ. `wireApi` is codex's alone.
 */
export function validateAgentEndpoint(spec: AgentEndpointSpec | undefined, adapter: string): void {
  if (spec === undefined) return;
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new InvalidAgentEndpointError("must be an object");
  }
  const names = new Map<string, string>();
  for (const field of ["apiKeyEnv", "baseUrlEnv", "headersEnv"] as const) {
    const value = spec[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !ENV_NAME.test(value)) {
      throw new InvalidAgentEndpointError(
        `${field} must be an env var name matching ${ENV_NAME} (got ${JSON.stringify(value)})`,
      );
    }
    const clash = names.get(value);
    if (clash !== undefined) throw new InvalidAgentEndpointError(`${field} and ${clash} both name ${value}`);
    names.set(value, field);
  }
  if (spec.apiKeyEnv !== undefined && !isSecretEnvName(spec.apiKeyEnv)) {
    throw new InvalidAgentEndpointError(
      `apiKeyEnv ${spec.apiKeyEnv} must be secret-named (contain KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL) so its value is redacted`,
    );
  }
  if (spec.headersEnv !== undefined && !isSecretEnvName(spec.headersEnv)) {
    throw new InvalidAgentEndpointError(
      `headersEnv ${spec.headersEnv} must be secret-named (a HEADERS suffix will do) so its value is redacted`,
    );
  }
  if (spec.baseUrlEnv !== undefined && isSecretEnvName(spec.baseUrlEnv)) {
    throw new InvalidAgentEndpointError(
      `baseUrlEnv ${spec.baseUrlEnv} must not be secret-named: a base URL is identity and must survive redaction`,
    );
  }
  if (spec.wireApi !== undefined) {
    if (!(WIRE_APIS as readonly string[]).includes(spec.wireApi)) {
      throw new InvalidAgentEndpointError(`wireApi must be one of ${WIRE_APIS.join(", ")} (got ${JSON.stringify(spec.wireApi)})`);
    }
    if (adapter !== "codex") {
      throw new InvalidAgentEndpointError(`wireApi applies to the codex adapter only (this experiment uses "${adapter}")`);
    }
  }
}

/** Validate `spec` for `adapter` and fill the unset fields from `defaults`. */
export function resolveEndpoint(adapter: string, defaults: ResolvedEndpoint, spec: AgentEndpointSpec = {}): ResolvedEndpoint {
  validateAgentEndpoint(spec, adapter);
  return {
    apiKeyEnv: spec.apiKeyEnv ?? defaults.apiKeyEnv,
    baseUrlEnv: spec.baseUrlEnv ?? defaults.baseUrlEnv,
    headersEnv: spec.headersEnv ?? defaults.headersEnv,
    wireApi: spec.wireApi ?? defaults.wireApi,
  };
}
