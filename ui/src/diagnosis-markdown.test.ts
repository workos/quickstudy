import { expect, test } from "bun:test";
import { DIAGNOSIS_PROMPT_VERSION, DIAGNOSIS_SCHEMA_VERSION, type DiagnosisFinding, type DiagnosisJson } from "../../src/diagnose/types.ts";
import { diagnosisMarkdown, findingMarkdown } from "./diagnosis-markdown.ts";

const finding: DiagnosisFinding = {
  eval_id: "authkit-django",
  experiment_id: "claude-cli",
  target: "docs",
  claim: "No Django guide was bundled.",
  suggested_change: "Add one.",
  confidence: "medium",
  evidence: [{ attempt_id: "01A", artifact: "transcript", lines: [1, 40] }],
};

const url = () => "https://x.test/#/run/r/attempt/01A/transcript/L1-40";

test("a finding copies as Markdown with an absolute evidence link", () => {
  const md = findingMarkdown(finding, url);
  expect(md).toBe(
    "**No Django guide was bundled.** — medium confidence\n" +
      "`authkit-django` × `claude-cli` · docs\n" +
      "Suggested change: Add one.\n" +
      "Evidence: [transcript L1–40](https://x.test/#/run/r/attempt/01A/transcript/L1-40)",
  );
  expect(findingMarkdown({ ...finding, evidence: [] }, url)).toContain("Evidence: none");
});

test("a diagnosis copies grouped by target with provenance and unanalyzed pairs", () => {
  const diagnosis: DiagnosisJson = {
    schema_version: DIAGNOSIS_SCHEMA_VERSION,
    run_id: "r",
    generated_at: "2026-09-17T16:00:00Z",
    model: { requested: "claude-sonnet-5", resolved: null },
    prompt_version: DIAGNOSIS_PROMPT_VERSION,
    disclaimer: "Hypotheses, not verdicts.",
    pairs_diagnosed: 2,
    pairs_skipped: 1,
    findings: [{ ...finding, target: "sdk" }, finding],
    errors: [{ eval_id: "e", experiment_id: "x", error: "truncated" }],
  };
  const md = diagnosisMarkdown(diagnosis, url);
  expect(md.startsWith("# Run diagnosis r\n\n_Hypotheses, not verdicts._\n\nModel claude-sonnet-5 (resolved unavailable) · prompt v" + DIAGNOSIS_PROMPT_VERSION)).toBe(true);
  expect(md.indexOf("## docs findings (1)")).toBeLessThan(md.indexOf("## sdk findings (1)"));
  expect(md).toContain("## Pairs not analyzed\n\n- `e` × `x`: truncated");
});
