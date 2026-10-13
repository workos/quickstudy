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
 * counted. `docs.count` is the number of docs events (every fetch and every
 * product-naming search); `docs.urls` lists each fetched page once, so a
 * count above the URL total comes from repeated fetches, searches, or both.
 * A docs host may carry a path prefix (`acme.com/docs`) so API calls to the
 * same domain do not count as reading.
 */

import { parseJsonlLines } from "./adapters/parse.ts";

export type SurfaceUsageVendor = "claude" | "codex" | "cursor" | "gemini";

export interface SurfaceUsage {
  docs: { count: number; urls: string[] };
  mcp: { count: number; tools: string[] };
  cli: { count: number; commands: string[] };
}

export interface SurfaceUsageConfig {
  /** Exact host or parent domain (subdomains also match), optionally with a path prefix. */
  docsHosts?: readonly string[];
  /**
   * Words a web search must mention to count as a docs search. Optional:
   * derived from the docs hosts' product labels when absent — set it when
   * the docs live on a hosting domain (`acme.readthedocs.io`) or the product
   * name is not in the hostname.
   */
  searchTokens?: readonly string[];
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
    .map((entry) => entry.trim().replace(/^https?:\/\//iu, "").replace(/^\.+/u, ""))
    .filter(Boolean)
    .map((entry) => {
      // Hostnames are case-insensitive; paths are not, so only the host is lowercased.
      const slash = entry.indexOf("/");
      const host = (slash === -1 ? entry : entry.slice(0, slash)).toLowerCase().replace(/\.+$/u, "");
      const prefix = slash === -1 ? "" : entry.slice(slash).replace(/\/+$/u, "");
      return { host, pathPrefix: prefix === "" ? null : prefix };
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

/** Subdomain labels that name a kind of site, never the product. */
const SITE_LABELS = new Set(["www", "docs", "doc", "developer", "developers", "dev", "api", "app", "apps", "help", "support"]);

/** Second-level labels of multi-part public suffixes (`co.uk`, `com.au`, `ac.jp`). */
const SECOND_LEVEL_SUFFIXES = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or"]);

/**
 * The product tokens a web-search query must mention to count as a docs
 * search. Explicit `searchTokens` win; otherwise every host label that is
 * neither a site label (`docs`, `www`), the TLD, nor a second-level suffix:
 * `acme` from `docs.acme.com`, `acme.cloud` and `docs.acme.co.uk`; `acme`
 * and `readthedocs` from `acme.readthedocs.io`. A TLD such as `cloud` is
 * never a product name.
 */
function productTokens(targets: readonly DocsTarget[], explicit: readonly string[]): string[] {
  const configured = explicit.map((token) => token.trim().toLowerCase()).filter((token) => token !== "");
  if (configured.length > 0) return [...new Set(configured)];
  const tokens = new Set<string>();
  for (const target of targets) {
    const labels = target.host.split(".").filter(Boolean);
    while (labels.length > 1 && SITE_LABELS.has(labels[0]!)) labels.shift();
    if (labels.length >= 2) labels.pop(); // the TLD
    if (labels.length >= 2 && SECOND_LEVEL_SUFFIXES.has(labels[labels.length - 1]!)) labels.pop();
    for (const label of labels) if (label.length >= 3) tokens.add(label);
  }
  return [...tokens];
}

/** Programs whose arguments are pages the agent opened. */
const FETCHERS = new Set(["curl", "wget", "xh", "http", "https", "httpie", "aria2c", "lynx", "w3m"]);

/**
 * URLs a shell command actually fetched: the arguments of a fetching program
 * that is the leading executable of its pipeline segment. `echo "curl …"`,
 * a heredoc body, or a file written through the shell is not a page the
 * agent opened (heredoc bodies are dropped by shellSegments).
 */
function fetchedUrlsInCommand(command: string): string[] {
  const urls: string[] = [];
  for (const segment of shellSegments(command)) {
    const lead = leadingExecutable(segment);
    if (lead === null || !FETCHERS.has(lead.name)) continue;
    for (const token of lead.rest) {
      for (const url of token.replace(/^['"]|['"]$/g, "").match(URL_PATTERN) ?? []) urls.push(url);
    }
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

/** The vendors' native web tools, by exact name: a search is an event, a fetch is a page. */
const WEB_SEARCH_TOOL = /^(?:web_?search|google_web_search)$/i;
const WEB_FETCH_TOOL = /^(?:web_?fetch)$/i;

/** The page a fetch tool was asked for: its URL field, never a URL mentioned in a prompt or query. */
function fetchUrlOf(input: unknown): string | null {
  const fields = record(input);
  for (const key of ["url", "URL", "uri", "href"]) {
    const value = fields[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/** A search tool's query text (Claude `query`, Codex `query`/`action.query`), for the product-token test. */
function searchQueryOf(input: unknown): string {
  const fields = record(input);
  const action = record(fields["action"]);
  return [fields["query"], action["query"], ...(Array.isArray(action["queries"]) ? action["queries"] : [])]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

/**
 * Documentation evidence from ONE invocation: the page a web-fetch tool or
 * a shell fetcher opened, or a web search naming the product (a docs event,
 * never a URL: a query is not a page). MCP tools never count here — an
 * MCP `search_docs` is MCP use, tallied on its own channel. A URL that only
 * appears in a prompt, a query, or a file the agent wrote is not evidence.
 */
function docsEvidence(
  invocation: ToolInvocation,
  targets: readonly DocsTarget[],
  searchTokens: readonly string[],
): { urls: string[]; search: boolean } {
  const none = { urls: [] as string[], search: false };
  if (targets.length === 0 || invocation.kind === "mcp" || /^mcp__/i.test(invocation.name)) return none;
  const urls: string[] = [];
  const push = (raw: string): void => {
    const safe = sanitizeUrl(raw, targets);
    if (safe !== null && !urls.includes(safe)) urls.push(safe);
  };
  if (WEB_FETCH_TOOL.test(invocation.name)) {
    const url = fetchUrlOf(invocation.input);
    if (url !== null) push(url);
    return { urls, search: false };
  }
  if (WEB_SEARCH_TOOL.test(invocation.name)) {
    // Codex reports an opened page as a search item with `action.url`.
    const opened = fetchUrlOf(record(invocation.input)["action"]);
    if (opened !== null) {
      push(opened);
      return { urls, search: false };
    }
    const query = searchQueryOf(invocation.input).toLowerCase();
    const tokens = productTokens(targets, searchTokens);
    return { urls, search: query.trim() !== "" && tokens.some((token) => query.includes(token)) };
  }
  if (invocation.kind === "command" || /bash|shell|terminal|command/i.test(invocation.name)) {
    const command = typeof invocation.input === "string" ? invocation.input : allStrings(invocation.input).join("\n");
    for (const raw of fetchedUrlsInCommand(command)) push(raw);
  }
  return { urls, search: false };
}

/**
 * Heredoc bodies (`cat <<EOF … EOF`) are file contents, not commands. Only
 * the body goes; the opener line keeps whatever follows the redirection
 * (`cat <<EOF > README.md && acme --help` still runs `acme --help`).
 */
const HEREDOC = /(<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/gu;

/** A backslash-newline continues the same command. */
const LINE_CONTINUATION = /\\\n/gu;

function shellSegments(command: string): string[] {
  // Unwrap the common structured-stream representation `bash -lc '<body>'`.
  // This is intentionally not a full shell parser; it only finds the leading
  // executable of each simple pipeline/list segment and never executes text.
  const wrapped = /^\s*(?:\/bin\/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/u.exec(command);
  const body = (wrapped?.[2] ?? command).replace(LINE_CONTINUATION, " ").replace(HEREDOC, "$1");
  return body.split(/(?:&&|\|\||[;|\n])/u).map((segment) => segment.trim().replace(/^['"(]+|['")]+$/g, ""));
}

/** Words that precede the real executable of a segment without changing what runs. */
const COMMAND_PREFIXES = new Set([
  "sudo", "env", "command", "exec", "nohup", "time", "timeout", "nice", "xargs",
  "if", "elif", "while", "until", "then", "do", "else", "!", "{", "(",
]);

/**
 * The executable a segment runs (after prefixes such as `sudo`, `command`,
 * `if`, and VAR=value) and its arguments. `command -v x` / `-V x` only look
 * `x` up and run nothing, so they yield no executable.
 */
function leadingExecutable(segment: string): { name: string; rest: string[] } | null {
  const tokens = segment.split(/\s+/u).filter(Boolean);
  let index = 0;
  while (
    index < tokens.length &&
    (COMMAND_PREFIXES.has(tokens[index]!) ||
      /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(tokens[index]!) ||
      (tokens[index]!.startsWith("-") && index > 0 && COMMAND_PREFIXES.has(tokens[index - 1]!)))
  ) {
    // `command -v x` / `-V x` (after any prefix: `if command -v x`) looks x up and runs nothing.
    if (tokens[index] === "command" && (tokens[index + 1] === "-v" || tokens[index + 1] === "-V")) return null;
    index += 1;
  }
  const invoked = (tokens[index] ?? "").replace(/^['"]|['"]$/g, "");
  if (invoked === "") return null;
  return { name: invoked.split("/").at(-1) ?? invoked, rest: tokens.slice(index + 1) };
}

/** Return a non-secret command label such as `product widgets`, or null. */
function cliLabel(input: unknown, executables: readonly string[]): string | null {
  const command = typeof input === "string" ? input : allStrings(input).join("\n");
  for (const segment of shellSegments(command)) {
    const lead = leadingExecutable(segment);
    if (lead === null) continue;
    for (const executable of executables) {
      const trimmed = executable.trim();
      if (trimmed === "" || lead.name !== trimmed) continue;
      const rawSubcommand = lead.rest[0]?.replace(/^['"]|['"]$/g, "");
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
  const searchTokens: string[] = [];
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "searchTokens" && Array.isArray(item)) {
        for (const token of item) if (typeof token === "string") searchTokens.push(token);
      } else if ((key === "hosts" || key === "docsHosts") && Array.isArray(item)) {
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
    ...(searchTokens.length > 0 ? { searchTokens: [...new Set(searchTokens)] } : {}),
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

      const docs = docsEvidence(invocation, targets, config.searchTokens ?? []);
      for (const url of docs.urls) pushUnique(usage.docs, usage.docs.urls, url);
      if (docs.search) usage.docs.count += 1;
    }
  }

  return usage;
}

/** Observe offered surfaces plus explicitly shared targets, without changing offered state. */
/** The words a web search must mention for THIS config: its explicit tokens, else those derived from its own docs hosts. */
export function resolveSearchTokens(config: SurfaceUsageConfig): string[] {
  return productTokens(docsTargets(config.docsHosts ?? []), config.searchTokens ?? []);
}

export function observationConfig(offered: SurfaceUsageConfig, targets?: SurfaceUsageConfig): SurfaceUsageConfig {
  // Resolve each side on its own first: explicit tokens for one target must
  // never replace the words derived for another target's hosts.
  const searchTokens = [...new Set([...resolveSearchTokens(offered), ...(targets ? resolveSearchTokens(targets) : [])])].sort();
  return {
    docsHosts: [...new Set([...(offered.docsHosts ?? []), ...(targets?.docsHosts ?? [])])].sort(),
    cliCommands: [...new Set([...(offered.cliCommands ?? []), ...(targets?.cliCommands ?? [])])].sort(),
    mcpServers: [...new Set([...(offered.mcpServers ?? []), ...(targets?.mcpServers ?? [])])].sort(),
    ...(searchTokens.length > 0 ? { searchTokens } : {}),
  };
}
