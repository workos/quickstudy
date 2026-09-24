/**
 * Compare view: the run's declared comparison groups. A `compared` group
 * renders a per-group table of eval rows × treatment columns with RAW counts
 * ("3/3" vs "1/3") — no intervals, no estimates, no deltas. A `withheld`
 * group renders its component diff (the identity-diff details recorded at run
 * time) and never a comparison; its raw per-experiment results stay visible
 * in the matrix. Singleton groups have nothing to compare and say so.
 */

import { useMemo, type ReactNode } from "react";
import type { ComparisonGroup } from "../../../src/experiments/groups.ts";
import type { DataAttempt, DataMeta, DataRun } from "../../../src/export-types.ts";
import { sharedAgentLabel } from "../agent-label.ts";
import { ErrorPanel } from "../components/ErrorPanel.tsx";
import { StatBadge } from "../components/StatBadge.tsx";
import { loadRun } from "../data.ts";
import { useAsync } from "../hooks.ts";
import { links, navigate } from "../router.ts";

interface CompareProps {
  meta: DataMeta;
  runId?: string;
}

interface ArmCount {
  passed: number;
  scored: number;
}

/** eval id -> experiment id -> raw scored counts. */
function countArms(attempts: DataAttempt[]): Map<string, Map<string, ArmCount>> {
  const byEval = new Map<string, Map<string, ArmCount>>();
  for (const attempt of attempts) {
    if (attempt.status !== "completed") continue;
    let byExperiment = byEval.get(attempt.eval_id);
    if (!byExperiment) {
      byExperiment = new Map();
      byEval.set(attempt.eval_id, byExperiment);
    }
    const count = byExperiment.get(attempt.experiment_id) ?? { passed: 0, scored: 0 };
    count.scored += 1;
    if (attempt.passed === true) count.passed += 1;
    byExperiment.set(attempt.experiment_id, count);
  }
  return byEval;
}

/**
 * Eval rows a compared group lists: evals where any member has a scored
 * attempt, plus shared evals (every member attempted) that nothing scored —
 * the not-comparable notice names those, so they must render as dashes.
 */
export function groupEvalIds(
  group: ComparisonGroup,
  arms: Map<string, Map<string, ArmCount>>,
  attempted: Map<string, Set<string>>,
): string[] {
  const scored = [...arms.keys()].filter((evalId) => group.experimentIds.some((experimentId) => arms.get(evalId)?.has(experimentId)));
  const sharedUnscored = [...attempted.keys()].filter((evalId) =>
    group.experimentIds.every((experimentId) => attempted.get(evalId)?.has(experimentId) === true),
  );
  return [...new Set([...scored, ...sharedUnscored])].sort((a, b) => a.localeCompare(b));
}

const isCompared = (group: ComparisonGroup): boolean =>
  group.comparison === "allowed" && group.experimentIds.length >= 2;

/** eval id -> experiment ids with any attempt (any status): the arms that actually ran. */
function attemptedArms(attempts: DataAttempt[]): Map<string, Set<string>> {
  const byEval = new Map<string, Set<string>>();
  for (const attempt of attempts) {
    const experiments = byEval.get(attempt.eval_id) ?? new Set<string>();
    experiments.add(attempt.experiment_id);
    byEval.set(attempt.eval_id, experiments);
  }
  return byEval;
}

/**
 * The not-comparable statement(s) for a run's compared groups: fewer than 3
 * trials per pair, and/or a shared eval (every member has attempts) where some
 * arm scored nothing (an arm with no completed attempt has no `countArms`
 * entry at all) — including one where no arm scored anything. An eval only some members ran — a suite scoped to one
 * treatment — is not shared, so its dashes do not trigger the notice. Empty
 * when neither applies or no group is compared. Counts stay listed either way.
 */
export function nNoticeSentences(
  trials: number,
  groups: ComparisonGroup[],
  arms: Map<string, Map<string, ArmCount>>,
  attempted: Map<string, Set<string>>,
): string[] {
  const compared = groups.filter(isCompared);
  if (compared.length === 0) return [];
  const sentences: string[] = [];
  if (trials < 3) {
    sentences.push(
      `With fewer than 3 trials per pair (this run: ${trials}), per-arm counts are listed but not comparable.`,
    );
  }
  const emptyArm = compared.some((group) =>
    [...attempted.keys()].some(
      (evalId) =>
        group.experimentIds.every((experimentId) => attempted.get(evalId)?.has(experimentId) === true) &&
        group.experimentIds.some((experimentId) => (arms.get(evalId)?.get(experimentId)?.scored ?? 0) === 0),
    ),
  );
  if (emptyArm) {
    sentences.push("Some shared evals have an arm with nothing scored; those rows are listed but not comparable.");
  }
  return sentences;
}

function treatmentOf(run: DataRun, experimentId: string): string | null {
  return run.manifest.experiments[experimentId]?.components.treatment ?? null;
}

/**
 * Card heading: the members' shared pinned model leads (the axis that
 * matters), the operator-chosen group name demotes to a sublabel. Withheld
 * groups may mix models, in which case the group name stays the heading.
 */
function GroupHeading({ run, group }: { run: DataRun; group: ComparisonGroup }): ReactNode {
  const label = sharedAgentLabel(run, group.experimentIds);
  if (label === null) return <h3>{group.group}</h3>;
  return (
    <h3>
      {label} <span className="group-sub">{group.group}</span>
    </h3>
  );
}

function GroupCard({
  run,
  group,
  arms,
  attempted,
}: {
  run: DataRun;
  group: ComparisonGroup;
  arms: Map<string, Map<string, ArmCount>>;
  attempted: Map<string, Set<string>>;
}): ReactNode {
  if (group.comparison === "withheld") {
    return (
      <div className="card" data-testid={`group-${group.group}`}>
        <div className="head">
          <GroupHeading run={run} group={group} />
          <StatBadge tone="amber">comparison withheld</StatBadge>
        </div>
        <div className="body">
          <p className="viewer-note" data-testid={`group-withheld-${group.group}`}>
            Members differ beyond their declared treatment, so no automatic comparison is rendered. Raw
            per-experiment results remain visible in the matrix. The differing components:
          </p>
          <ul className="identity-diff" data-testid={`group-diff-${group.group}`}>
            {group.details.map((detail) => (
              <li key={detail}>
                <code>{detail}</code>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (group.experimentIds.length < 2) {
    return (
      <div className="card" data-testid={`group-${group.group}`}>
        <div className="head">
          <GroupHeading run={run} group={group} />
          <StatBadge tone="gray">single experiment</StatBadge>
        </div>
        <div className="body">
          <p className="viewer-note">
            This group declares one experiment — nothing to compare. Its raw results render in the matrix.
          </p>
        </div>
      </div>
    );
  }

  const evalIds = groupEvalIds(group, arms, attempted);

  return (
    <div className="card" data-testid={`group-${group.group}`}>
      <div className="head">
        <GroupHeading run={run} group={group} />
        <StatBadge tone="green">compared — raw counts</StatBadge>
      </div>
      <div className="body">
        <table className="data" data-testid={`group-table-${group.group}`}>
          <thead>
            <tr>
              <th>eval</th>
              {group.experimentIds.map((experimentId) => (
                <th key={experimentId}>
                  <code>{experimentId}</code>
                  {treatmentOf(run, experimentId) !== null && (
                    <div className="attribution-reason">{treatmentOf(run, experimentId)}</div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {evalIds.map((evalId) => (
              <tr key={evalId}>
                <td>
                  <code>{evalId}</code>
                </td>
                {group.experimentIds.map((experimentId) => {
                  const count = arms.get(evalId)?.get(experimentId);
                  return (
                    <td key={experimentId} data-testid={`arm-${evalId}-${experimentId}`}>
                      {count === undefined ? "—" : `${count.passed}/${count.scored}`}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="viewer-note">
          Raw passed/scored counts per arm. Incomplete and errored attempts are excluded from these counts and
          reported in the matrix drill-down.
        </p>
      </div>
    </div>
  );
}

export function Compare({ meta, runId }: CompareProps): ReactNode {
  const activeRunId = runId ?? "";
  const run = useAsync(() => loadRun(activeRunId), [activeRunId]);

  const arms = useMemo(
    () => (run.status === "ready" ? countArms(run.value.attempts) : null),
    [run],
  );

  if (activeRunId === "") {
    return (
      <div data-testid="compare-view">
        <div className="empty-state">
          <h2>No run selected</h2>
          <p>Pick a run to see its comparison groups.</p>
        </div>
      </div>
    );
  }
  if (run.status === "error") return <ErrorPanel error={run.error} />;
  if (run.status === "loading" || arms === null) return <div className="loading">Loading run…</div>;

  const groups = run.value.groups;
  const attempted = attemptedArms(run.value.attempts);
  const nNotice = nNoticeSentences(run.value.run.trials, groups, arms, attempted);

  return (
    <div data-testid="compare-view">
      <div className="page-head">
        <div>
          <h1>Comparison groups</h1>
          <p className="sub">
            Raw per-arm counts for experiments declared as treatments of one configuration; mismatched groups are
            withheld with their component diff.
          </p>
        </div>
        <div className="control">
          <label htmlFor="compare-run">Run</label>
          <select
            id="compare-run"
            data-testid="compare-run-select"
            value={activeRunId}
            onChange={(event) => navigate(links.compare(event.currentTarget.value))}
          >
            {meta.runs.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.id.slice(0, 10)}… · {candidate.started_at.slice(0, 10)} · {candidate.attempts} attempts
              </option>
            ))}
          </select>
        </div>
      </div>

      {run.value.run.finished_at === null && (
        <div className="notice" data-testid="incomplete-banner">
          Incomplete run — this run never finished. Counts are partial.
        </div>
      )}

      {nNotice.length > 0 && (
        <div className="notice" data-testid="compare-n-notice">
          {nNotice.join(" ")}
        </div>
      )}

      {groups.length === 0 ? (
        <div className="empty-state" data-testid="no-groups">
          <h2>No comparison groups in this run</h2>
          <p>
            Declare <code>comparisonGroup</code> on experiments meant to be treatments of one configuration, then
            re-run.
          </p>
        </div>
      ) : (
        groups.map((group) => <GroupCard key={group.group} run={run.value} group={group} arms={arms} attempted={attempted} />)
      )}
    </div>
  );
}
