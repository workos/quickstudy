/**
 * Attempt artifact viewer: the deep-link target for drill-down links
 * (`#/run/<id>/attempt/<id>/<artifact>[/L<a>-<b>]`). Preserves the check,
 * identity, and error detail alongside the artifact, plus the surface-usage
 * panel (offered treatment vs observed use). Text assets are lazy-fetched;
 * under file:// they degrade to a named error with the serve instruction,
 * never a blank page.
 */

import type { ReactNode } from "react";
import { DiffViewer } from "../components/DiffViewer.tsx";
import { ErrorPanel } from "../components/ErrorPanel.tsx";
import { OutcomeBadges, StatBadge, displayStatus, statusTone } from "../components/StatBadge.tsx";
import { AttemptSurfaceUsage } from "../components/SurfaceUsage.tsx";
import { TranscriptViewer } from "../components/TranscriptViewer.tsx";
import { DataError, loadRun, loadTextAsset } from "../data.ts";
import { useAsync } from "../hooks.ts";
import { links } from "../router.ts";

interface AttemptViewProps {
  runId: string;
  attemptId: string;
  artifact: "transcript" | "diff";
  lines?: [number, number];
}

export function AttemptView({ runId, attemptId, artifact, lines }: AttemptViewProps): ReactNode {
  const loaded = useAsync(async () => {
    const run = await loadRun(runId);
    const attempt = run.attempts.find((candidate) => candidate.id === attemptId);
    if (!attempt) {
      throw new DataError("missing", `data/runs/${runId}/run.json`, `attempt "${attemptId}" is not in this run's export`);
    }
    const assetPath = artifact === "transcript" ? attempt.transcript : attempt.diff;
    if (assetPath === null) {
      throw new DataError(
        "missing",
        `data/runs/${runId}/attempts/${attemptId}`,
        `this attempt has no ${artifact} artifact in the export`,
      );
    }
    const text = await loadTextAsset(runId, assetPath);
    return { attempt, text };
  }, [runId, attemptId, artifact]);

  if (loaded.status === "error") return <ErrorPanel error={loaded.error} />;
  if (loaded.status === "loading") return <div className="loading">Loading {artifact}…</div>;
  const { attempt, text } = loaded.value;

  const other = artifact === "transcript" ? "diff" : "transcript";
  const otherAvailable = (artifact === "transcript" ? attempt.diff : attempt.transcript) !== null;
  const status = displayStatus(attempt);

  return (
    <div data-testid="attempt-view">
      <div className="viewer-head">
        <div>
          <h1 style={{ fontSize: 18, margin: 0 }}>
            {attempt.eval_id} × {attempt.experiment_id}
            {attempt.treatment !== null ? ` · ${attempt.treatment}` : ""} · trial {attempt.trial_index + 1}
          </h1>
          <p className="sub" style={{ margin: "2px 0 0" }}>
            attempt <code>{attempt.id}</code> · {artifact}
            {lines ? ` · lines ${lines[0]}–${lines[1]}` : ""}
          </p>
        </div>
        <div className="controls">
          <StatBadge tone={statusTone(status)}>{status}</StatBadge>
          <OutcomeBadges attempt={attempt} />
          {otherAvailable && <a href={links.attempt(runId, attempt.id, other)}>view {other}</a>}
          <a href={links.cell(runId, { evalId: attempt.eval_id, experimentId: attempt.experiment_id })}>open cell</a>
        </div>
      </div>
      {attempt.error !== null && (
        <div className="notice">
          <code>{attempt.error}</code>
        </div>
      )}
      {attempt.checks !== null && attempt.checks.length > 0 && (
        <div className="attempt-line" style={{ margin: "8px 0" }}>
          {attempt.checks.map((check) => (
            <span key={check.name} className={check.passed ? "crit pass" : "crit fail"} title={check.notes ?? check.name}>
              {check.passed ? "✓" : "✗"} {check.name}
            </span>
          ))}
        </div>
      )}
      <AttemptSurfaceUsage treatment={attempt.treatment} usage={attempt.surface_usage} />
      {artifact === "transcript" ? <TranscriptViewer text={text} lines={lines} /> : <DiffViewer text={text} lines={lines} />}
    </div>
  );
}
