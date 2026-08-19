/**
 * Egress allowlist: composition and matching.
 *
 * The allowlist composes from two layers, both recorded into the run's
 * config_json for auditability:
 *   (1) harness defaults — each container agent adapter declares the LLM
 *       endpoints its CLI needs (`egressHosts` on the adapter);
 *   (2) runtime contribution — the experiment runtime's
 *       `egressHosts(metadata)` (product endpoints, package registries).
 *
 * Matching is deliberately narrow: exact hostnames and `*.domain` subdomain
 * wildcards only — no path rules, no IP rules, no CIDR. Raw-IP CONNECT
 * targets are refused outright (closing the resolve-then-dial DNS bypass),
 * so IP literals in the allowlist itself are rejected at compose time.
 */

/** An allowlist entry is invalid (IP literal, port, scheme, path, bad wildcard). */
export class AllowlistEntryError extends Error {
  constructor(entry: string, problem: string) {
    super(`invalid egress allowlist entry "${entry}": ${problem}`);
    this.name = "AllowlistEntryError";
  }
}

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Normalize one host for matching: lowercase, strip a single trailing dot
 * (DNS absolute form — `evil.com.` resolves identically to `evil.com` and
 * must match the same allowlist entries, never bypass them).
 */
export function normalizeHost(host: string): string {
  const lowered = host.toLowerCase();
  return lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
}

/**
 * Is this host an IP literal (any form)? The proxy refuses raw-IP CONNECTs
 * regardless of allowlist, so this is deliberately over-broad: dotted quads,
 * anything with a colon (IPv6), bracketed literals, all-digit decimal forms
 * (`http://2130706433/`), and 0x-prefixed hex forms all count.
 */
export function isRawIpHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h.length === 0) return true;
  if (h.includes(":") || h.startsWith("[")) return true; // IPv6 / bracketed
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // dotted quad
  if (/^\d+$/.test(h)) return true; // decimal int form
  if (/^0x[0-9a-f]+$/.test(h)) return true; // hex int form
  if (/^[\d.]+$/.test(h)) return true; // partial numeric forms (1.2.3, 1.2)
  return false;
}

/** Validate one entry (exact host or `*.domain`); returns its normalized form. */
export function validateAllowlistEntry(entry: string): string {
  const normalized = normalizeHost(entry.trim());
  if (normalized.length === 0) throw new AllowlistEntryError(entry, "empty");
  if (/[/?#\s]/.test(normalized) || normalized.includes("://")) {
    throw new AllowlistEntryError(entry, "must be a bare hostname (no scheme, path, or spaces)");
  }
  if (normalized.includes(":")) {
    throw new AllowlistEntryError(entry, "must not carry a port (allowlisting is hostname-granularity)");
  }
  const body = normalized.startsWith("*.") ? normalized.slice(2) : normalized;
  if (body.includes("*")) {
    throw new AllowlistEntryError(entry, "wildcards are subdomain-only: a single leading `*.` label");
  }
  if (isRawIpHost(body)) {
    throw new AllowlistEntryError(entry, "IP literals are refused by the proxy — allowlist hostnames only");
  }
  // Single-label hosts are legal: Docker-network service names ("origin")
  // and localhost matter for tests and runtime-provisioned local services.
  const labels = body.split(".");
  if (!labels.every((label) => LABEL.test(label))) {
    throw new AllowlistEntryError(entry, "not a valid hostname");
  }
  return normalized;
}

/**
 * Does `host` match the allowlist? Exact entries match the whole hostname
 * (case-insensitively, trailing dot stripped); `*.domain` entries match any
 * subdomain of `domain` — at least one extra label, never `domain` itself
 * (which is why runtimes list both `example.com` and `*.example.com`).
 * IP literals never match anything.
 */
export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = normalizeHost(host);
  if (isRawIpHost(h)) return false;
  for (const entry of allowlist) {
    const e = normalizeHost(entry);
    if (e.startsWith("*.")) {
      const suffix = e.slice(1); // ".domain"
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (h === e) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a CONNECT authority-form target (`host:port`, `[v6]:port`) or a bare
 * host. Returns undefined for garbage. The port defaults to 443 — CONNECT
 * targets are overwhelmingly TLS.
 */
export function parseHostPort(target: string): { host: string; port: number } | undefined {
  const trimmed = target.trim();
  if (trimmed.length === 0) return undefined;
  let host: string;
  let portText: string | undefined;
  if (trimmed.startsWith("[")) {
    // Bracketed IPv6 literal: [::1]:443 — kept intact so isRawIpHost sees it.
    const end = trimmed.indexOf("]");
    if (end === -1) return undefined;
    host = trimmed.slice(0, end + 1);
    const rest = trimmed.slice(end + 1);
    if (rest.startsWith(":")) portText = rest.slice(1);
    else if (rest !== "") return undefined;
  } else {
    const colon = trimmed.lastIndexOf(":");
    // A second colon means an unbracketed IPv6 literal: keep whole as host.
    if (colon !== -1 && trimmed.indexOf(":") === colon) {
      host = trimmed.slice(0, colon);
      portText = trimmed.slice(colon + 1);
    } else {
      host = trimmed;
    }
  }
  if (host.length === 0) return undefined;
  if (portText === undefined) return { host, port: 443 };
  if (!/^\d{1,5}$/.test(portText)) return undefined;
  const port = Number(portText);
  if (port < 1 || port > 65535) return undefined;
  return { host, port };
}

/**
 * Compose a validated allowlist from an explicit host list (the runner
 * unions runtime- and adapter-declared hosts before calling). Validated,
 * normalized, deduplicated, sorted — the sorted list is what lands in
 * config_json, so two identical runs record identical allowlists.
 */
export function composeAllowlistFromHosts(hosts: readonly string[]): string[] {
  const entries = new Set<string>();
  for (const host of hosts) entries.add(validateAllowlistEntry(host));
  return [...entries].sort();
}
