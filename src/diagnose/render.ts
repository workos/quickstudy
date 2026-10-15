/**
 * Terminal rendering for diagnosis.json. Renders FROM the JSON, never the
 * store — the artifact is the contract, the text is a view of it.
 */

import { join } from "node:path";
import { DIAGNOSIS_TARGETS, type DiagnosisEvidence, type DiagnosisJson } from "./types.ts";

function evidencePath(resultsDir: string, runId: string, evidence: DiagnosisEvidence): string {
  const file = evidence.artifact === "transcript" ? "transcript.jsonl" : "diff.patch";
  return `${join(resultsDir, runId, evidence.attempt_id, file)}:L${evidence.lines[0]}-${evidence.lines[1]}`;
}

/** Render the diagnosis as plain text, findings grouped by target. */
export function renderDiagnosisText(diagnosis: DiagnosisJson, resultsDir: string): string {
  const lines: string[] = [];
  lines.push(`diagnosis: run ${diagnosis.run_id}`);
  lines.push(`  model: ${diagnosis.model.requested}${diagnosis.model.resolved !== null ? ` (resolved: ${diagnosis.model.resolved})` : ""}`);
  lines.push(
    `  pairs: ${diagnosis.pairs_diagnosed} diagnosed, ${diagnosis.pairs_skipped} skipped (passing or control)` +
      (diagnosis.errors.length > 0 ? `, ${diagnosis.errors.length} errored` : ""),
  );

  if (diagnosis.findings.length === 0) {
    lines.push("");
    lines.push("no findings.");
  }

  for (const target of DIAGNOSIS_TARGETS) {
    const grouped = diagnosis.findings.filter((finding) => finding.target === target);
    if (grouped.length === 0) continue;
    lines.push("");
    lines.push(`${target} (${grouped.length} finding${grouped.length === 1 ? "" : "s"})`);
    for (const finding of grouped) {
      lines.push(`  ${finding.eval_id} × ${finding.experiment_id} [confidence: ${finding.confidence}]`);
      lines.push(`    claim: ${finding.claim}`);
      lines.push(`    suggested change: ${finding.suggested_change}`);
      for (const evidence of finding.evidence) {
        lines.push(`    evidence: ${evidencePath(resultsDir, diagnosis.run_id, evidence)}`);
      }
    }
  }

  if (diagnosis.errors.length > 0) {
    lines.push("");
    lines.push("pairs that failed to diagnose:");
    for (const error of diagnosis.errors) {
      lines.push(`  ${error.eval_id} × ${error.experiment_id}: ${error.error}`);
    }
  }

  lines.push("");
  lines.push(`note: ${diagnosis.disclaimer}`);
  return lines.join("\n");
}
