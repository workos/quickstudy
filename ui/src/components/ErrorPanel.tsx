/**
 * Per-view error surface: names the failing path/reason, never white-screens.
 * A schemaVersion mismatch gets its own loud banner styling (the failure-mode
 * table's "explicit banner, not a blank page").
 */

import { Component, type ReactNode } from "react";
import { DataError } from "../data.ts";

export function ErrorPanel({ error }: { error: Error }): ReactNode {
  if (error instanceof DataError && error.kind === "schema") {
    return (
      <div className="error-banner" data-testid="schema-banner" role="alert">
        <strong>Data schema mismatch.</strong> {error.message}
      </div>
    );
  }
  const path = error instanceof DataError ? error.path : null;
  return (
    <div className="error-panel" data-testid="error-panel" role="alert">
      <strong>Could not load this view.</strong>
      {path !== null && (
        <div>
          Failing path: <code>{path}</code>
        </div>
      )}
      <div>{error.message}</div>
    </div>
  );
}

interface BoundaryProps {
  children: ReactNode;
}

interface BoundaryState {
  error: Error | null;
}

/** Render-time crashes inside a view degrade to the same named error panel. */
export class ViewErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override render(): ReactNode {
    if (this.state.error !== null) return <ErrorPanel error={this.state.error} />;
    return this.props.children;
  }
}
