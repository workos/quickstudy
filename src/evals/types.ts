/**
 * The v3 eval vocabulary: one directory = one eval, described by a PROMPT.md
 * (frontmatter metadata + task body) and scored by an EVAL.ts whose default
 * export is an {@link EvalScorer}. No dialect, no registry — the scorer is
 * plain TypeScript handed an {@link EvalContext} over the finished workspace.
 */

/** Closed set of eval suites. `regression` never moves headline scores. */
export const EVAL_SUITES = ["benchmark", "regression", "other"] as const;
export type EvalSuite = (typeof EVAL_SUITES)[number];

/** PROMPT.md frontmatter. New fields require a proven filtering/reporting use case. */
export interface EvalMetadata {
  /** Must equal the eval's directory name (prevents silent aliasing). */
  id: string;
  suite: EvalSuite;
  product?: string;
  framework?: string;
  topics?: string[];
}

/** One discovered eval directory, validated and ready to plan. */
export interface LoadedEval {
  metadata: EvalMetadata;
  /** Absolute path of the eval directory. */
  dir: string;
  /** Absolute path of PROMPT.md. */
  promptPath: string;
  /** The task body after the frontmatter, passed through verbatim. */
  promptBody: string;
  /** Absolute path of EVAL.ts (imported lazily at score time). */
  scorerPath: string;
  /** Absolute path of the optional `local/` starting-state directory, or null. */
  localDir: string | null;
}

/** A pointer at evidence backing a check verdict (workspace-relative path). */
export interface EvidenceReference {
  path: string;
  note?: string;
}

/** One named check's verdict inside an eval result. */
export interface CheckResult {
  name: string;
  passed: boolean;
  notes?: string;
  evidence?: EvidenceReference[];
}

/** What a scorer returns for one attempt. */
export interface JudgeRecord {
  provenance: "semantic-judge";
  provider: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}
export interface AgentOutput {
  finalReport: string | null;
  transcript: string | null;
  truncated: boolean;
}
export interface EvalResult {
  judgments?: JudgeRecord[];
  passed: boolean;
  checks: CheckResult[];
}

/** Output of a command run through {@link EvalContext.exec}. */
export interface EvalExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the command was killed by its wall-clock timeout. */
  timedOut: boolean;
}

/**
 * What a scorer gets. File helpers read the EXPORTED workspace (stable on
 * disk); `exec` runs in the live sandbox when the experiment ran in a
 * container — the runner keeps it alive until the scorer resolves — or in
 * the exported workspace directory for host experiments. Capability helpers
 * (`query`, `getClient`) are wired by experiment runtimes in a later phase;
 * a runtime that does not provide one makes the helper throw with
 * "this experiment runtime does not provide X".
 */
export interface EvalContext {
  agentOutput?: AgentOutput;
  /** Redact known runtime/provider secrets before sending evidence to a judge. */
  redact?(text: string): Promise<string>;
  /** Aborted when the current stage expires. Implementations must stop work. */
  signal?: AbortSignal;
  evalId: string;
  experimentId: string;
  trialIndex: number;
  /** The eval's framework (`metadata.framework`); absent for framework-neutral evals. */
  framework?: string;
  /** Absolute path of the exported workspace being scored. */
  workspaceDir: string;
  /** Does this workspace-relative path exist? */
  fileExists(path: string): Promise<boolean>;
  /** Read a workspace-relative file as UTF-8. Throws when missing. */
  readFile(path: string): Promise<string>;
  /** Run a command in the sandbox (container) or workspace dir (host). */
  exec(cmd: string[], opts?: { timeoutMs?: number }): Promise<EvalExecResult>;
  /** Runtime-provided data query capability (wired by runtimes later). */
  query(request: unknown): Promise<unknown>;
  /** Runtime-provided client capability (wired by runtimes later). */
  getClient(name: string): unknown;
}

/** EVAL.ts's default export. */
export type EvalScorer = ((ctx: EvalContext) => Promise<EvalResult>) & { identity?: Record<string, unknown> };
