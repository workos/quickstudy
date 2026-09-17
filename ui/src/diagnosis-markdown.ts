/**
 * diagnosis.json → Markdown for the clipboard (Slack, Linear, PRs). Pure: the
 * caller supplies `evidenceUrl` so evidence links are absolute to the hosted
 * bundle; nothing here touches the DOM.
 */

import { DIAGNOSIS_TARGETS, type DiagnosisEvidence, type DiagnosisFinding, type DiagnosisJson } from "../../src/diagnose/types.ts";

export type EvidenceUrl = (evidence: DiagnosisEvidence) => string;

export function findingMarkdown(finding: DiagnosisFinding, evidenceUrl: EvidenceUrl): string {
  const evidence = finding.evidence
    .map((e) => `[${e.artifact} L${e.lines[0]}–${e.lines[1]}](${evidenceUrl(e)})`)
    .join(", ");
  return [
    `**${finding.claim}** — ${finding.confidence} confidence`,
    `\`${finding.eval_id}\` × \`${finding.experiment_id}\` · ${finding.target}`,
    `Suggested change: ${finding.suggested_change}`,
    evidence ? `Evidence: ${evidence}` : "Evidence: none",
  ].join("\n");
}

export function diagnosisMarkdown(diagnosis: DiagnosisJson, evidenceUrl: EvidenceUrl): string {
  const sections = DIAGNOSIS_TARGETS.flatMap((target) => {
    const findings = diagnosis.findings.filter((f) => f.target === target);
    if (findings.length === 0) return [];
    return [`## ${target} findings (${findings.length})`, ...findings.map((f) => findingMarkdown(f, evidenceUrl))];
  });
  const errors = diagnosis.errors.length
    ? ["## Pairs not analyzed", ...diagnosis.errors.map((e) => `- \`${e.eval_id}\` × \`${e.experiment_id}\`: ${e.error}`)]
    : [];
  return [
    `# Run diagnosis ${diagnosis.run_id}`,
    `_${diagnosis.disclaimer}_`,
    `Model ${diagnosis.model.requested} (resolved ${diagnosis.model.resolved ?? "unavailable"}) · prompt v${diagnosis.prompt_version} · generated ${diagnosis.generated_at} · ${diagnosis.pairs_diagnosed} pairs diagnosed, ${diagnosis.pairs_skipped} skipped, ${diagnosis.findings.length} findings`,
    ...sections,
    ...errors,
  ].join("\n\n");
}
