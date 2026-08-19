/**
 * Observable use of the developer surfaces offered to an attempt.
 *
 * Availability is recorded in the experiment manifest; this module answers a
 * different question: did the agent actually call an MCP tool, invoke the
 * product CLI, or open a product documentation URL? Extraction is deliberately
 * conservative and stores only redacted identifiers. Full shell commands and
 * URL query strings can contain credentials and must remain in the protected
 * raw transcript, never in aggregate telemetry.
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
    return [{ ...identity, name: "web_search", input: item, kind: "web" }];
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

function sanitizedDocsUrls(input: unknown, hosts: readonly string[]): string[] {
  if (hosts.length === 0) return [];
  const configured = hosts.map((host) => host.trim().toLowerCase().replace(/^\.+|\.+$/g, "")).filter(Boolean);
  const urls: string[] = [];
  for (const text of allStrings(input)) {
    for (const raw of text.match(URL_PATTERN) ?? []) {
      try {
        const url = new URL(raw);
        const host = url.hostname.toLowerCase();
        if (!configured.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) continue;
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        const safe = url.toString();
        if (!urls.includes(safe)) urls.push(safe);
      } catch {
        // A transcript fragment that merely resembles a URL is not evidence.
      }
    }
  }
  return urls;
}

function shellSegments(command: string): string[] {
  // Unwrap the common structured-stream representation `bash -lc '<body>'`.
  // This is intentionally not a full shell parser; it only finds the leading
  // executable of each simple pipeline/list segment and never executes text.
  const wrapped = /^\s*(?:\/bin\/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/u.exec(command);
  const body = wrapped?.[2] ?? command;
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
  const docsHosts = config.docsHosts ?? [];
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

      for (const url of sanitizedDocsUrls(invocation.input, docsHosts)) {
        pushUnique(usage.docs, usage.docs.urls, url);
      }
    }
  }

  return usage;
}
