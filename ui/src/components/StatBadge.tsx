/** Small status/count pill, the shared vocabulary for attempt states. */

import type { ReactNode } from "react";
import type { DataAttempt } from "../../../src/export-types.ts";

export type BadgeTone = "green" | "red" | "amber" | "gray" | "blue";

export function StatBadge({ tone, children, title }: { tone: BadgeTone; children: ReactNode; title?: string }): ReactNode {
  return (
    <span className={`badge ${tone}`} {...(title !== undefined ? { title } : {})}>
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
