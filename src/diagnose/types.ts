/**
 * The diagnosis.json contract: LLM-drafted, harness-evidenced hypotheses for
 * one run's failing (eval × experiment) pairs.
 *
 * diagnosis.json is a SEPARATE artifact from report.json, deliberately exempt
 * from the report's BANNED_LANGUAGE guard — it self-labels with
 * {@link DIAGNOSIS_DISCLAIMER} instead, and nothing under `src/report/`
 * reads or writes it. Evidence is harness-owned: every finding's evidence
 * points at a deterministic excerpt window the harness selected; the model
 * only ever referenced attempts by 1-based index.
 */

/** Loud, CLI-friendly diagnose failures (unknown run, empty evidence, ...). */
export class DiagnoseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnoseError";
  }
}

export const DIAGNOSIS_SCHEMA_VERSION = 1;

/**
 * Bumped whenever the system/user prompt text changes shape. v2: excerpt
 * windows anchor on the last marker cluster.
 */
export const DIAGNOSIS_PROMPT_VERSION = 2;

/** Fixed self-labeling carried inside every diagnosis.json. */
export const DIAGNOSIS_DISCLAIMER =
  "These findings are model-drafted hypotheses, not verdicts. Scope is this single run: " +
  "no cross-run claims, no attribution beyond the cited evidence. Each evidence link names a " +
  "harness-selected excerpt (artifact + 1-indexed line range) — verify the cited lines before acting.";

/**
 * The generic surface taxonomy a finding can implicate. Concrete surface
 * names (hosts, commands, server names) come from the run's recorded config —
 * the taxonomy itself stays consumer-neutral.
 */
export type DiagnosisTarget = "docs" | "mcp" | "cli" | "sdk" | "environment" | "eval-defect";

export const DIAGNOSIS_TARGETS: readonly DiagnosisTarget[] = [
  "docs",
  "mcp",
  "cli",
  "sdk",
  "environment",
  "eval-defect",
];

/** Rule-derived from pair shape + mapped evidence — never model-asserted. */
export type DiagnosisConfidence = "high" | "medium" | "low";

export interface DiagnosisEvidence {
  attempt_id: string;
  artifact: "transcript" | "diff";
  /** 1-indexed inclusive line range inside the artifact — always a harness-selected window. */
  lines: [number, number];
}

export interface DiagnosisFinding {
  eval_id: string;
  experiment_id: string;
  target: DiagnosisTarget;
  claim: string;
  suggested_change: string;
  confidence: DiagnosisConfidence;
  evidence: DiagnosisEvidence[];
}

/** A pair whose analysis failed (model error after retries) — recorded, never silently dropped. */
export interface PairDiagnosisError {
  eval_id: string;
  experiment_id: string;
  error: string;
}

export interface DiagnosisJson {
  schema_version: typeof DIAGNOSIS_SCHEMA_VERSION;
  run_id: string;
  generated_at: string;
  /** Requested model (pin or env override) and the model id the API reported back. */
  model: { requested: string; resolved: string | null };
  prompt_version: typeof DIAGNOSIS_PROMPT_VERSION;
  /** Fixed self-labeling: hypotheses with evidence links, not verdicts; single-sweep scope. */
  disclaimer: string;
  pairs_diagnosed: number;
  /** Pairs never sent to the model: passing-only pairs and control (oracle / no-op) pairs. */
  pairs_skipped: number;
  findings: DiagnosisFinding[];
  errors: PairDiagnosisError[];
}
