import type { PublicationCoverage } from "../../../src/completeness.ts";
export function PublicationNotice({ coverage }: { coverage?: PublicationCoverage }) {
  if (!coverage) return null;
  return (
    <details data-testid="publication-omissions" open={coverage.omitted.length > 0}>
      <summary>
        Complete-sample publication: {coverage.eligible.length} pairs included, {coverage.omitted.length} omitted;{" "}
        {coverage.expected_trials} trials required.
      </summary>
      <p>
        These counts cover the included pairs. Source attempts and retry history remain available in the diagnostic
        artifacts.
      </p>
      {coverage.omitted.map((pair) => (
        <p key={`${pair.eval_id}:${pair.experiment_id}`}>
          {pair.eval_id} × {pair.experiment_id}: {pair.reasons.join("; ")}
        </p>
      ))}
    </details>
  );
}
