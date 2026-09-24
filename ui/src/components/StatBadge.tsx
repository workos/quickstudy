/** Small status/count pill, the shared vocabulary for attempt states. */

import type { ReactNode } from "react";
import type { DataAttempt } from "../../../src/export-types.ts";

export type BadgeTone = "green" | "red" | "amber" | "gray" | "blue";

export function StatBadge({ tone, children, title, testId }: { tone: BadgeTone; children: ReactNode; title?: string; testId?: string }): ReactNode {
  return (
    <span className={`badge ${tone}`} {...(title !== undefined ? { title } : {})} {...(testId !== undefined ? { "data-testid": testId } : {})}>
      <span className="dot" aria-hidden="true" />
      {children}
    </span>
  );
}

/** What one attempt row displays: the scorer's verdict when completed, the status otherwise. */
export type AttemptDisplayStatus = "passed" | "failed" | "incomplete" | "error";

export function displayStatus(attempt: Pick<DataAttempt, "status" | "passed">): AttemptDisplayStatus {
  if (attempt.status === "incomplete") return "incomplete";
  if (attempt.status === "error") return "error";
  return attempt.passed === true ? "passed" : "failed";
}

export function statusTone(status: AttemptDisplayStatus): BadgeTone {
  if (status === "passed") return "green";
  if (status === "failed") return "red";
  if (status === "incomplete") return "gray";
  return "amber";
}

/** Which stage failed: infrastructure (environment, harness) reads apart from the agent and the scorer. */
export function errorKindTone(kind: NonNullable<DataAttempt["error_kind"]>): BadgeTone {
  if (kind === "environment") return "amber";
  if (kind === "agent") return "red";
  if (kind === "scorer") return "blue";
  return "gray";
}

/** The error-kind and limit badges an attempt carries, if any (none on a plain completed attempt). */
export function OutcomeBadges({ attempt }: { attempt: Pick<DataAttempt, "error_kind" | "limit"> }): ReactNode {
  return (
    <>
      {attempt.error_kind !== null && (
        <StatBadge tone={errorKindTone(attempt.error_kind)} testId="error-kind-badge" title="the stage that failed">
          {attempt.error_kind}
        </StatBadge>
      )}
      {attempt.limit === "timeout" && (
        <StatBadge tone="gray" testId="limit-badge" title="the agent hit its time limit; the workspace it left was graded">
          timeout
        </StatBadge>
      )}
    </>
  );
}
