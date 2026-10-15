/**
 * Reusable probe scaffolding for checks that boot the attempt's app and
 * inspect it from the outside — over plain HTTP or through a Playwright
 * spec run against the live sandbox.
 *
 * Originally shared with the legacy `app-http-probe` built-in family and
 * v2 sidecar graders (both deleted with the v2 authoring stack); the only
 * remaining consumers are consumer scorer libraries, which call it directly
 * with an eval context's `exec`.
 *
 * The shell shape generalizes the probes consumers hand-rolled before this
 * module existed: `set -e`, background the start command with its output in
 * {@link PROBE_LOG_PATH} (inspectable via `--debug-keep`), poll readiness on
 * a bounded budget, re-assert readiness, then fetch the path under grading.
 * The fetch deliberately does NOT use `curl -f`: a probe may expect a
 * non-2xx status (`expectStatus: 404`), so the script captures the status
 * code separately from the body instead of letting curl abort on it.
 */

/** Output of a command run through a probe's exec facility. */
export interface ProbeExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The exec facility a probe drives: a container grader's `ctx.exec` or a v3
 * eval context's `exec` (both return supersets of {@link ProbeExecResult}).
 */
export type ProbeExecFn = (cmd: string[], opts?: { timeoutMs?: number }) => Promise<ProbeExecResult>;

/**
 * In-container log file the backgrounded start command writes to. Diagnostic
 * detail lives here and only here (probes return plain booleans); inspect it
 * with `--debug-keep`.
 */
export const PROBE_LOG_PATH = "/tmp/quickstudy-probe.log";

/** Budget for one whole probe script run (start + poll + fetch). */
export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

/** Default readiness poll: 40 attempts × 250ms ≈ 10s of app boot budget. */
export const DEFAULT_POLL_ATTEMPTS = 40;
export const DEFAULT_POLL_INTERVAL_MS = 250;

/** What {@link buildStartScript} needs to compose the probe shell script. */
export interface ProbeScriptOptions {
  /** Shell command that starts the app; backgrounded, output to {@link PROBE_LOG_PATH}. */
  start: string;
  /** TCP port the app listens on (composed into 127.0.0.1 URLs). */
  port: number;
  /** Path polled until it answers 2xx before the request fires. */
  readinessPath: string;
  /** Path fetched once ready; its status and body become the script's stdout. */
  requestPath: string;
  /**
   * HTTP method for the request fetch. Omitted = curl's default (GET),
   * keeping the composed script byte-identical for existing consumers.
   */
  requestMethod?: string;
  /** Readiness poll budget; defaults {@link DEFAULT_POLL_ATTEMPTS} × {@link DEFAULT_POLL_INTERVAL_MS}. */
  pollAttempts?: number;
  pollIntervalMs?: number;
}

/**
 * Build the `sh -c` probe script: start the app in the background, poll the
 * readiness path on a bounded budget, re-assert readiness (so a flapping app
 * fails loudly), then fetch the request path. stdout is the response body
 * followed by a newline and the three-digit HTTP status — parse it with
 * {@link fetchViaExec}. Any failure before the fetch (app never came up,
 * readiness lost) exits nonzero via `set -e`.
 */
export function buildStartScript(opts: ProbeScriptOptions): string {
  const attempts = opts.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const intervalSeconds = (opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS) / 1000;
  const base = `http://127.0.0.1:${opts.port}`;
  const readinessUrl = `${base}${opts.readinessPath}`;
  const method = opts.requestMethod === undefined ? "" : `-X ${opts.requestMethod} `;
  return `
set -e
cd /workspace
(${opts.start} >${PROBE_LOG_PATH} 2>&1 &)
i=0
while [ $i -lt ${attempts} ]; do
  if curl -sf -o /dev/null "${readinessUrl}"; then break; fi
  i=$((i + 1))
  sleep ${intervalSeconds}
done
curl -sf -o /dev/null "${readinessUrl}"
curl -s ${method}-w '\\n%{http_code}' "${base}${opts.requestPath}"
`;
}

/** A captured HTTP response: the status code and the raw body text. */
export interface ProbeResponse {
  status: number;
  body: string;
}

/**
 * Run a probe script (see {@link buildStartScript}) in the attempt container
 * and split its stdout into status + body. Returns `undefined` when the
 * script exited nonzero or its stdout carries no status line — the app never
 * came up, readiness failed, or curl could not connect: a failed check, not
 * a crash. Deliberately no try/catch around `exec`: a rejecting exec is the
 * facility itself failing, which must reach the runner's errors map instead
 * of masquerading as a failed check.
 */
export async function fetchViaExec(
  exec: ProbeExecFn,
  script: string,
  opts?: { timeoutMs?: number },
): Promise<ProbeResponse | undefined> {
  const result = await exec(["sh", "-c", script], { timeoutMs: opts?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS });
  if (result.exitCode !== 0) return undefined;
  // The script's last output is `\n` + the three-digit status; everything
  // before that separator is the body, byte-exact (its own trailing newline,
  // if any, sits before the separator and survives).
  const trimmed = result.stdout.trimEnd();
  const separator = trimmed.lastIndexOf("\n");
  const statusText = (separator === -1 ? trimmed : trimmed.slice(separator + 1)).trim();
  if (!/^\d{3}$/.test(statusText)) return undefined;
  return {
    status: Number.parseInt(statusText, 10),
    body: separator === -1 ? "" : trimmed.slice(0, separator),
  };
}

// ── Playwright-spec probes ───────────────────────────────────────────────────
//
// The second probe shape: boot the workspace's dev server in the background,
// wait for it to answer, deliver a Playwright spec into the sandbox's
// preinstalled probe project, and run it (optionally `--grep`-scoped so one
// spec file can serve several independently-scored checks). Everything runs
// through the probe's exec facility, so the same code drives a live attempt
// container or a scripted fake in tests.

/** Where sandbox images preinstall the Playwright probe project. */
export const DEFAULT_PROBE_PROJECT_DIR = "/opt/quickstudy/probe";

/** Shell expression resolving the probe project dir inside the sandbox. */
const PROBE_DIR_EXPR = `\${QUICKSTUDY_PROBE_DIR:-${DEFAULT_PROBE_PROJECT_DIR}}`;

/** Budget for one Playwright spec run (browser flows are slow). */
export const PLAYWRIGHT_RUN_TIMEOUT_MS = 3 * 60 * 1000;

/** Dev-server readiness: generous, first boots compile. */
export const SERVER_READY_TIMEOUT_MS = 90 * 1000;
export const SERVER_POLL_INTERVAL_MS = 1500;

/** In-sandbox log/pid files for the backgrounded dev server. */
export const APP_LOG_PATH = "/tmp/quickstudy-dev.log";
export const APP_PID_PATH = "/tmp/quickstudy-dev.pid";

/**
 * Start a dev server in the background inside the sandbox. The command runs
 * in its own process group (`setsid`) so {@link stopBackgroundApp} can kill
 * the whole tree, with output captured in {@link APP_LOG_PATH}.
 */
export async function startAppInBackground(exec: ProbeExecFn, start: string): Promise<void> {
  await exec(
    ["sh", "-c", `nohup setsid sh -c 'exec ${start}' > ${APP_LOG_PATH} 2>&1 & echo $! > ${APP_PID_PATH}`],
    { timeoutMs: 15_000 },
  );
}

/**
 * Poll the app until any HTTP answer arrives (readiness means "listening",
 * not "healthy" — probes assert health themselves). `baseUrlExpr` is a shell
 * expression evaluated inside the sandbox, so credentials and per-attempt
 * URLs never appear in the composed command line.
 */
export async function waitForAppReady(
  exec: ProbeExecFn,
  baseUrlExpr: string,
  opts?: { readyTimeoutMs?: number; pollIntervalMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<boolean> {
  const sleep = opts?.sleep ?? ((ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const deadline = Date.now() + (opts?.readyTimeoutMs ?? SERVER_READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const poll = await exec(["sh", "-c", `curl -s -o /dev/null "${baseUrlExpr}"`], { timeoutMs: 10_000 });
    if (poll.exitCode === 0) return true;
    await sleep(opts?.pollIntervalMs ?? SERVER_POLL_INTERVAL_MS);
  }
  return false;
}

/** The last lines of the backgrounded dev server's log, for failure notes. */
export async function readAppLogTail(exec: ProbeExecFn, lines = 40): Promise<string> {
  const tail = await exec(["sh", "-c", `tail -n ${lines} ${APP_LOG_PATH} 2>/dev/null || true`], {
    timeoutMs: 10_000,
  });
  return tail.stdout;
}

/** Kill the backgrounded dev server (process group first, pid as fallback). */
/**
 * Every process in the app's process group, read from /proc so no `ps`,
 * `pkill` or external `kill` is needed. dash's builtin `kill` rejects a
 * negative pid ("Illegal number"), so `kill -- -<pgid>` only ever worked
 * under bash and busybox; on the Debian-based sandbox images it failed and
 * the fallback signalled the group leader alone.
 */
const GROUP_MEMBERS_SH =
  'members() { for d in /proc/[0-9]*; do [ -r "$d/stat" ] || continue; ' +
  'pg=$(sed "s/^.*) //" "$d/stat" 2>/dev/null | cut -d" " -f3); ' +
  '[ "$pg" = "$pid" ] && echo "${d#/proc/}"; done; }; ' +
  // Without /proc (a host runtime on macOS) fall back to the shell's group kill.
  'signal() { if [ -d /proc/self ]; then m=$(members); [ -n "$m" ] || return 1; kill -s "$1" $m 2>/dev/null; ' +
  'else kill -s "$1" -- "-$pid" 2>/dev/null; fi; }; ' +
  'alive() { if [ -d /proc/self ]; then [ -n "$(members)" ]; else kill -0 -- "-$pid" 2>/dev/null; fi; }; ';

export async function stopBackgroundApp(exec: ProbeExecFn): Promise<void> {
  // SIGTERM the group, give it five seconds, then SIGKILL whatever is left.
  // Dev servers that fork a worker outlive a TERM to the leader: Next.js's
  // `start-server` child stayed bound to the port after `npm run dev` exited,
  // so the next probe booted on another port while the stale server answered
  // the probe's requests (500s on routes it had never compiled).
  await exec(
    [
      "sh",
      "-c",
      `pid="$(cat ${APP_PID_PATH} 2>/dev/null)"; [ -n "$pid" ] || exit 0; ` +
        GROUP_MEMBERS_SH +
        'signal TERM || kill -s TERM "$pid" 2>/dev/null || true; ' +
        'i=0; while [ "$i" -lt 10 ] && alive; do sleep 0.5; i=$((i + 1)); done; ' +
        'signal KILL || kill -s KILL "$pid" 2>/dev/null || true',
    ],
    { timeoutMs: 20_000 },
  );
}

/**
 * Deliver a spec's source into the sandbox's probe project. Images
 * preinstall the Playwright toolchain at QUICKSTUDY_PROBE_DIR but never bake
 * spec files, so specs travel at probe time — as an exec argument, never
 * interpolated into the script itself.
 */
export async function deliverSpecSource(exec: ProbeExecFn, specFile: string, specSource: string): Promise<void> {
  await exec(
    ["sh", "-c", `dir="${PROBE_DIR_EXPR}" && mkdir -p "$dir" && printf "%s\\n" "$1" > "$dir/${specFile}"`, "sh", specSource],
    { timeoutMs: 10_000 },
  );
}

/** One Playwright spec run inside the sandbox's probe project. */
export interface PlaywrightRunOptions {
  /** Spec filename inside the probe project (delivered beforehand). */
  specFile: string;
  /**
   * Environment handed to the run as `NAME="<expr>"` pairs. Values are shell
   * expressions expanded inside the sandbox (`$PROVISIONED_VAR`), so secrets
   * stay out of the composed command line.
   */
  env: Record<string, string>;
  /** `--grep` scope, so one spec file can serve several independent checks. */
  grep?: string;
  timeoutMs?: number;
}

/**
 * Run a delivered Playwright spec. The exit code is the verdict (0 = the
 * probed flow held); stdout/stderr carry the line-reporter output for
 * failure notes. No try/catch: a rejecting exec is an infrastructure fault.
 */
export async function runPlaywrightSpec(exec: ProbeExecFn, opts: PlaywrightRunOptions): Promise<ProbeExecResult> {
  const envPairs = Object.entries(opts.env)
    .map(([key, expr]) => `${key}="${expr}"`)
    .join(" ");
  const grep = opts.grep === undefined ? "" : `--grep ${opts.grep} `;
  return exec(
    ["sh", "-c", `cd "${PROBE_DIR_EXPR}" && ${envPairs} npx playwright test ${opts.specFile} ${grep}--reporter=line`],
    { timeoutMs: opts.timeoutMs ?? PLAYWRIGHT_RUN_TIMEOUT_MS },
  );
}

/** Bound failure-note output so notes stay readable in reports. */
export function truncateOutput(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed;
}

// ── declarative JSON assertions ──────────────────────────────────────────────

/**
 * A declarative check over a JSON response body. `path` is a deliberate
 * subset of jsonPath — `$`, dot keys, `[<index>]`, and at most one `[*]`
 * projection (e.g. `$.widgets[*].sku`) — not a jsonpath engine; anything
 * richer is a sidecar case.
 */
export type JsonAssertion =
  | { path: string; equals: unknown }
  | { path: string; ascending: true }
  | { path: string; every: { equals: unknown } };

/** A parsed probe path: segments before and (optionally) after one `[*]`. */
interface ParsedProbePath {
  prefix: Array<string | number>;
  /** Present only when the path contains a `[*]` projection. */
  projected?: Array<string | number>;
}

/**
 * Parse the jsonPath subset. Throws a plain Error on malformed paths — a
 * syntactically bad path is a programming error (the built-in family rejects
 * it at load time; sidecars surface it as a grader error), while a
 * well-formed path that doesn't match the body is a failed CHECK.
 */
export function parseProbePath(path: string): ParsedProbePath {
  if (!path.startsWith("$")) {
    throw new Error(`assertion path must start with "$" (got "${path}")`);
  }
  const prefix: Array<string | number> = [];
  let projected: Array<string | number> | undefined;
  let current = prefix;
  let i = 1;
  while (i < path.length) {
    if (path[i] === ".") {
      const match = /^[^.[\]]+/.exec(path.slice(i + 1));
      if (!match) throw new Error(`empty key segment at position ${i} in "${path}"`);
      current.push(match[0]);
      i += 1 + match[0].length;
    } else if (path.startsWith("[*]", i)) {
      if (projected !== undefined) throw new Error(`at most one "[*]" projection is supported (got "${path}")`);
      projected = [];
      current = projected;
      i += 3;
    } else if (path[i] === "[") {
      const close = path.indexOf("]", i);
      if (close === -1) throw new Error(`unclosed "[" at position ${i} in "${path}"`);
      const inner = path.slice(i + 1, close);
      if (!/^\d+$/.test(inner)) {
        throw new Error(`bracket segments must be "*" or a non-negative integer index (got "[${inner}]" in "${path}")`);
      }
      current.push(Number(inner));
      i = close + 1;
    } else {
      throw new Error(`unexpected character "${path[i]}" at position ${i} in "${path}"`);
    }
  }
  return projected === undefined ? { prefix } : { prefix, projected };
}

/** Walk plain segments into a value; `found: false` when any hop is missing. */
function resolveSegments(value: unknown, segments: ReadonlyArray<string | number>): { found: boolean; value: unknown } {
  let current = value;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) return { found: false, value: undefined };
      current = current[segment];
    } else {
      if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, segment)) {
        return { found: false, value: undefined };
      }
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return { found: true, value: current };
}

type ProbePathResolution = { kind: "missing" } | { kind: "one"; value: unknown } | { kind: "many"; values: unknown[] };

/**
 * Resolve a parsed path against a body. A missing key, an out-of-range
 * index, a `[*]` over a non-array, or a projected segment absent from any
 * element all resolve to "missing" — which fails the assertion (missing is a
 * wrong answer, never an error).
 */
function resolveProbePath(body: unknown, parsed: ParsedProbePath): ProbePathResolution {
  const head = resolveSegments(body, parsed.prefix);
  if (!head.found) return { kind: "missing" };
  if (parsed.projected === undefined) return { kind: "one", value: head.value };
  if (!Array.isArray(head.value)) return { kind: "missing" };
  const values: unknown[] = [];
  for (const element of head.value) {
    const resolved = resolveSegments(element, parsed.projected);
    if (!resolved.found) return { kind: "missing" };
    values.push(resolved.value);
  }
  return { kind: "many", values };
}

/**
 * Semantic (key-order-independent) deep equality over JSON data. Arrays are
 * order-sensitive; objects compare by key set + values; primitives by `===`.
 */
export function deepJsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepJsonEqual(item, b[index]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const aKeys = Object.keys(a);
    const bRecord = b as Record<string, unknown>;
    return (
      aKeys.length === Object.keys(bRecord).length &&
      aKeys.every((key) => Object.hasOwn(bRecord, key) && deepJsonEqual((a as Record<string, unknown>)[key], bRecord[key]))
    );
  }
  return false;
}

/**
 * Ordering check for `ascending: true`. All values must be strings (compared
 * by code unit, so "W-102" < "W-103") or all numbers (compared numerically);
 * a mixed or non-orderable list is false. Adjacent equals are allowed
 * (non-strict order), and zero or one value is vacuously true — including a
 * `[*]` projection over an empty array.
 */
function isAscending(values: readonly unknown[]): boolean {
  if (values.length <= 1) return true;
  const allStrings = values.every((value) => typeof value === "string");
  const allNumbers = values.every((value) => typeof value === "number");
  if (!allStrings && !allNumbers) return false;
  for (let i = 1; i < values.length; i++) {
    if ((values[i] as string | number) < (values[i - 1] as string | number)) return false;
  }
  return true;
}

/** The list a list-shaped operator (`ascending`, `every`) works over, or undefined. */
function asList(resolution: ProbePathResolution): unknown[] | undefined {
  if (resolution.kind === "many") return resolution.values;
  if (resolution.kind === "one" && Array.isArray(resolution.value)) return resolution.value;
  return undefined;
}

function evaluateAssertion(body: unknown, assertion: JsonAssertion): boolean {
  const resolution = resolveProbePath(body, parseProbePath(assertion.path));
  if (resolution.kind === "missing") return false;
  if ("equals" in assertion) {
    return deepJsonEqual(resolution.kind === "many" ? resolution.values : resolution.value, assertion.equals);
  }
  const list = asList(resolution);
  if (list === undefined) return false;
  if ("ascending" in assertion) return isAscending(list);
  // `every` over an empty list is vacuously true, matching `[*]` semantics.
  return list.every((value) => deepJsonEqual(value, assertion.every.equals));
}

/**
 * Evaluate a list of declarative assertions against a parsed JSON body; they
 * AND together, and an empty list is vacuously true. Pure — safe to call
 * from sidecars against any decoded response. Malformed assertion paths
 * throw (see {@link parseProbePath}); everything else is a boolean verdict.
 */
export function evaluateAssertions(body: unknown, assertions: readonly JsonAssertion[]): boolean {
  return assertions.every((assertion) => evaluateAssertion(body, assertion));
}
