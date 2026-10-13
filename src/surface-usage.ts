/**
 * Observable use of the developer surfaces offered to an attempt.
 *
 * Availability is recorded in the experiment manifest; this module answers a
 * different question: did the agent actually call an MCP tool, invoke the
 * product CLI, or reach for the product documentation? Extraction is
 * deliberately conservative and stores only redacted identifiers. Full shell
 * commands and URL query strings can contain credentials and must remain in
 * the protected raw transcript, never in aggregate telemetry.
 *
 * Docs evidence comes only from fetches (native web tools, shell fetchers
 * such as curl) and from web searches that name the product. A docs URL
 * inside a file the agent WROTE is not a page it opened and is never
 * counted. `docs.count` is the number of docs events (fetches + searches);
 * `docs.urls` lists only the fetched pages, so a count above the URL total
 * means searches. A docs host may carry a path prefix (`acme.com/docs`) so
 * API calls to the same domain do not count as reading.
 */

import { parseJsonlLines } from "./adapters/parse.ts";

export type SurfaceUsageVendor = "claude" | "codex" | "cursor" | "gemini";

export interface SurfaceUsage {
  docs: { count: number; urls: string[] };
  mcp: { count: number; tools: string[] };
  cli: { count: number; commands: string[] };
}

export interface SurfaceUsageConfig {
  /** Exact host or parent domain; subdomains also match. */
  docsHosts?: readonly string[];
  /** Product CLI executable names, without arguments. */
  cliCommands?: readonly string[];
  /** MCP server names as configured for the attempt. */
  mcpServers?: readonly string[];
}

interface ToolInvocation {
  id?: string;
  name: string;
  input: unknown;
  kind?: "command" | "mcp" | "web";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pushUnique(signal: { count: number }, values: string[], value: string): void {
  signal.count += 1;
  if (!values.includes(value)) values.push(value);
}

function claudeInvocations(event: Record<string, unknown>): ToolInvocation[] {
  if (event["type"] !== "assistant") return [];
  const message = record(event["message"]);
  const content = Array.isArray(message["content"]) ? message["content"] : [];
  return content.flatMap((part): ToolInvocation[] => {
    const item = record(part);
    if (item["type"] !== "tool_use" || typeof item["name"] !== "string") return [];
    return [{
      ...(typeof item["id"] === "string" ? { id: item["id"] } : {}),
      name: item["name"],
      input: item["input"],
      ...(/^web(fetch|search)$/i.test(item["name"]) ? { kind: "web" as const } : {}),
      ...(/^bash$/i.test(item["name"]) ? { kind: "command" as const } : {}),
    }];
  });
}

function codexInvocations(event: Record<string, unknown>): ToolInvocation[] {
  if (event["type"] !== "item.started" && event["type"] !== "item.completed") return [];
  const item = record(event["item"]);
  const identity = typeof item["id"] === "string" ? { id: item["id"] } : {};
  const type = item["type"];
  if (type === "command_execution" && typeof item["command"] === "string") {
    return [{ ...identity, name: "command_execution", input: item["command"], kind: "command" }];
  }
  if (type === "mcp_tool_call") {
    const server = typeof item["server"] === "string" ? item["server"] : "";
    const tool = typeof item["tool"] === "string" ? item["tool"] : typeof item["name"] === "string" ? item["name"] : "tool";
    return [{ ...identity, name: server === "" ? tool : `${server}__${tool}`, input: item["arguments"] ?? item["input"], kind: "mcp" }];
  }
  if (type === "web_search") {
    // The started phase carries an empty query; only the completed item says
    // what was searched. Keyed by the same id, so it still counts once.
    if (event["type"] !== "item.completed") return [];
    return [{ ...identity, name: "web_search", input: { query: item["query"], action: item["action"] }, kind: "web" }];
  }
  return [];
}

function cursorInvocations(event: Record<string, unknown>): ToolInvocation[] {
  if (event["type"] !== "tool_call") return [];
  const call = record(event["tool_call"]);
  const entry = Object.entries(call)[0];
  if (!entry) return [];
  const [name, body] = entry;
  return [{
    ...(typeof event["call_id"] === "string" ? { id: event["call_id"] } : {}),
    name,
    input: record(body)["args"] ?? body,
  }];
}

function geminiInvocations(event: Record<string, unknown>): ToolInvocation[] {
  if (event["type"] !== "tool_use" || typeof event["tool_name"] !== "string") return [];
  return [{
    ...(typeof event["tool_id"] === "string" ? { id: event["tool_id"] } : {}),
    name: event["tool_name"],
    input: event["parameters"],
  }];
}

function invocationsFor(vendor: SurfaceUsageVendor, event: Record<string, unknown>): ToolInvocation[] {
  if (vendor === "claude") return claudeInvocations(event);
  if (vendor === "codex") return codexInvocations(event);
  if (vendor === "cursor") return cursorInvocations(event);
  return geminiInvocations(event);
}

function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) allStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) allStrings(item, out);
  }
  return out;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>)}\]]+/giu;

/**
 * A configured documentation target: a host (subdomains match) with an
 * optional path prefix — `docs.acme.test`, or `acme.com/docs` so that API
 * traffic to `api.acme.com` is never mistaken for reading the docs.
 */
interface DocsTarget {
  host: string;
  pathPrefix: string | null;
}

function docsTargets(hosts: readonly string[]): DocsTarget[] {
  return hosts
    .map((entry) => entry.trim().toLowerCase().replace(/^https?:\/\//u, "").replace(/^\.+/u, ""))
    .filter(Boolean)
    .map((entry) => {
      const slash = entry.indexOf("/");
      if (slash === -1) return { host: entry.replace(/\.+$/u, ""), pathPrefix: null };
      const prefix = entry.slice(slash).replace(/\/+$/u, "");
      return { host: entry.slice(0, slash).replace(/\.+$/u, ""), pathPrefix: prefix === "" ? null : prefix };
    });
}

function matchesDocsTarget(url: URL, targets: readonly DocsTarget[]): boolean {
  const host = url.hostname.toLowerCase();
  return targets.some(
    (target) =>
      (host === target.host || host.endsWith(`.${target.host}`)) &&
      (target.pathPrefix === null || url.pathname === target.pathPrefix || url.pathname.startsWith(`${target.pathPrefix}/`)),
  );
}

/** Product tokens a web-search query must mention to count as a docs search (`acme` from `docs.acme.test`). */
function productTokens(targets: readonly DocsTarget[]): string[] {
  const tokens = new Set<string>();
  for (const target of targets) {
    const labels = target.host.split(".").filter((label) => label !== "www" && label !== "docs");
    const token = labels.length >= 2 ? labels[labels.length - 2]! : labels[0];
    if (token && token.length >= 3) tokens.add(token);
  }
  return [...tokens];
}

/**
 * URLs a shell command actually fetched: only arguments of a fetching
 * program (`curl`, `wget`, …). A URL inside a heredoc, an echo, or a file
 * body written through the shell is not a page the agent opened.
 */
const SHELL_FETCH = /(?:^|[\s|;&(])(?:curl|wget|xh|http|https|httpie|aria2c|lynx|w3m)\b([^\n|;&]*)/giu;

function fetchedUrlsInCommand(command: string): string[] {
  const urls: string[] = [];
  for (const match of command.matchAll(SHELL_FETCH)) {
    for (const url of match[1]?.match(URL_PATTERN) ?? []) urls.push(url);
  }
  return urls;
}

function sanitizeUrl(raw: string, targets: readonly DocsTarget[]): string | null {
  try {
    const url = new URL(raw);
    if (!matchesDocsTarget(url, targets)) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // A transcript fragment that merely resembles a URL is not evidence.
    return null;
  }
}

/**
 * Documentation evidence from ONE invocation: the URLs it fetched (web tools
 * and shell fetchers only — never the body of a file the agent wrote) and
 * whether it was a web search naming the product (counted as a docs event,
 * never listed as a URL: a query is not a page).
 */
function docsEvidence(invocation: ToolInvocation, targets: readonly DocsTarget[]): { urls: string[]; search: boolean } {
  if (targets.length === 0) return { urls: [], search: false };
  const urls: string[] = [];
  const push = (raw: string): void => {
    const safe = sanitizeUrl(raw, targets);
    if (safe !== null && !urls.includes(safe)) urls.push(safe);
  };
  const isSearch = /search/i.test(invocation.name);
  const isFetch = invocation.kind === "web" || /fetch/i.test(invocation.name);
  if (isSearch || isFetch) {
    const strings = allStrings(invocation.input);
    for (const text of strings) for (const raw of text.match(URL_PATTERN) ?? []) push(raw);
    if (urls.length === 0 && isSearch) {
      const tokens = productTokens(targets);
      const query = strings.join(" ").toLowerCase();
      return { urls, search: query.trim() !== "" && tokens.some((token) => query.includes(token)) };
    }
    return { urls, search: false };
  }
  if (invocation.kind === "command" || /bash|shell|terminal|command/i.test(invocation.name)) {
    const command = typeof invocation.input === "string" ? invocation.input : allStrings(invocation.input).join("\n");
    for (const raw of fetchedUrlsInCommand(command)) push(raw);
  }
  return { urls, search: false };
}

/** Heredoc bodies (`cat <<EOF … EOF`) are file contents, not commands. */
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/gu;

function shellSegments(command: string): string[] {
  // Unwrap the common structured-stream representation `bash -lc '<body>'`.
  // This is intentionally not a full shell parser; it only finds the leading
  // executable of each simple pipeline/list segment and never executes text.
  const wrapped = /^\s*(?:\/bin\/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/u.exec(command);
  const body = (wrapped?.[2] ?? command).replace(HEREDOC, "");
  return body.split(/(?:&&|\|\||[;|\n])/u).map((segment) => segment.trim().replace(/^['"(]+|['")]+$/g, ""));
}

/** Return a non-secret command label such as `product widgets`, or null. */
function cliLabel(input: unknown, executables: readonly string[]): string | null {
  const command = typeof input === "string" ? input : allStrings(input).join("\n");
  for (const segment of shellSegments(command)) {
    // Remove command prefixes without retaining their values. Environment
    // assignments, `env`, and `sudo` commonly precede the real executable.
    const tokens = segment.split(/\s+/u).filter(Boolean);
    let index = 0;
    while (tokens[index] === "sudo" || tokens[index] === "env" || /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(tokens[index] ?? "")) {
      index += 1;
    }
    const invoked = (tokens[index] ?? "").replace(/^['"]|['"]$/g, "");
    for (const executable of executables) {
      const trimmed = executable.trim();
      if (trimmed === "") continue;
      const basename = invoked.split("/").at(-1);
      if (invoked !== trimmed && basename !== trimmed) continue;
      const rawSubcommand = tokens[index + 1]?.replace(/^['"]|['"]$/g, "");
      // `acme = Client()` is a line of source, not a CLI call.
      if (rawSubcommand !== undefined && /^[=:]/u.test(rawSubcommand)) continue;
      const subcommand = rawSubcommand && !rawSubcommand.startsWith("-") ? rawSubcommand : undefined;
      return subcommand ? `${trimmed} ${subcommand}` : trimmed;
    }
  }
  return null;
}

function isMcpInvocation(invocation: ToolInvocation, serverNames: readonly string[]): boolean {
  if (invocation.kind === "mcp") return true;
  const name = invocation.name.toLowerCase();
  if (name.startsWith("mcp__") || name.includes("mcp_tool")) return true;
  return serverNames.some((server) => {
    const normalized = server.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    return normalized !== "" && (name.startsWith(`${normalized}__`) || name.includes(`__${normalized}__`));
  });
}

function mcpLabel(name: string): string {
  // Tool names are identifiers, but cap them so a malformed stream cannot
  // bloat report JSON. No tool inputs are ever retained here.
  return name.replace(/[^a-zA-Z0-9_.:/-]+/g, "_").slice(0, 160) || "mcp_tool";
}

/** The adapter names whose raw streams extraction understands; null = store NULL usage. */
export function surfaceUsageVendor(adapter: string): SurfaceUsageVendor | null {
  return adapter === "claude" || adapter === "codex" || adapter === "cursor" || adapter === "gemini"
    ? adapter
    : null;
}

/**
 * Derive the OFFERED surface configuration from an experiment's runtime
 * config. By convention the treatment's identity-bearing settings live at
 * `runtime.config[treatment]`; rather than hard-coding treatment names, the
 * derivation scans every config subtree for the well-known keys `hosts`
 * (documentation hosts) and `commands` (product CLI executables). MCP server
 * names come from the runner's already-resolved server map — calling
 * `runtime.mcpServers()` here could re-trigger credential checks.
 */
export function surfaceUsageConfigFromRuntime(
  config: Record<string, unknown> | undefined,
  mcpServerNames: readonly string[],
): SurfaceUsageConfig {
  const docsHosts: string[] = [];
  const cliCommands: string[] = [];
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "hosts" || key === "docsHosts") && Array.isArray(item)) {
        // Wildcard entries ("*.example.com") reduce to their parent domain —
        // the matcher already covers subdomains of a configured parent.
        for (const host of item) if (typeof host === "string") docsHosts.push(host.replace(/^\*\./u, ""));
      } else if ((key === "commands" || key === "cliCommands") && Array.isArray(item)) {
        for (const command of item) if (typeof command === "string") cliCommands.push(command);
      } else {
        visit(item);
      }
    }
  };
  visit(config);
  return {
    docsHosts: [...new Set(docsHosts)],
    cliCommands: [...new Set(cliCommands)],
    mcpServers: [...new Set(mcpServerNames)],
  };
}

/**
 * Extract aggregate, redacted usage from a vendor's raw JSONL stream.
 *
 * A returned all-zero object means the supported stream was inspected and no
 * configured product surface was observed. Callers must store `null`, rather
 * than an all-zero object, when no supported raw stream was available.
 */
export function extractSurfaceUsage(
  vendor: SurfaceUsageVendor,
  raw: string,
  config: SurfaceUsageConfig,
): SurfaceUsage {
  const usage: SurfaceUsage = {
    docs: { count: 0, urls: [] },
    mcp: { count: 0, tools: [] },
    cli: { count: 0, commands: [] },
  };
  const targets = docsTargets(config.docsHosts ?? []);
  const cliCommands = config.cliCommands ?? [];
  const mcpServers = config.mcpServers ?? [];
  const seenInvocations = new Set<string>();

  for (const rawEvent of parseJsonlLines(raw)) {
    const event = record(rawEvent);
    for (const invocation of invocationsFor(vendor, event)) {
      if (invocation.id !== undefined) {
        if (seenInvocations.has(invocation.id)) continue;
        seenInvocations.add(invocation.id);
      }
      if (isMcpInvocation(invocation, mcpServers)) {
        pushUnique(usage.mcp, usage.mcp.tools, mcpLabel(invocation.name));
      }

      const command = invocation.kind === "command" || /bash|shell|terminal|command/i.test(invocation.name)
        ? cliLabel(invocation.input, cliCommands)
        : null;
      if (command) pushUnique(usage.cli, usage.cli.commands, command);

      const docs = docsEvidence(invocation, targets);
      for (const url of docs.urls) pushUnique(usage.docs, usage.docs.urls, url);
      if (docs.search) usage.docs.count += 1;
    }
  }

  return usage;
}

/** Observe offered surfaces plus explicitly shared targets, without changing offered state. */
export function observationConfig(offered: SurfaceUsageConfig, targets?: SurfaceUsageConfig): SurfaceUsageConfig {
  return {
    docsHosts: [...new Set([...(offered.docsHosts ?? []), ...(targets?.docsHosts ?? [])])].sort(),
    cliCommands: [...new Set([...(offered.cliCommands ?? []), ...(targets?.cliCommands ?? [])])].sort(),
    mcpServers: [...new Set([...(offered.mcpServers ?? []), ...(targets?.mcpServers ?? [])])].sort(),
  };
}
