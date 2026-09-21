/**
 * The transcript and diff viewers as a library entry point — the package's `./ui/viewers`
 * export, with styles at `./ui/viewers.css`.
 *
 * A host that already renders a run's data in its own design (a control plane over
 * exported bundles, say) can render an attempt's artifacts with the same turn parsing,
 * roles, collapsing and L<n> anchors this UI uses, instead of copying the components. Both
 * components import React only; the host fetches the text (the bundle lazy-loads it the
 * same way) and defines the CSS custom properties viewers.css reads.
 */

export {
  TranscriptViewer,
  type TranscriptViewerProps,
  parseTranscript,
  parseTurn,
} from "./components/TranscriptViewer.tsx";
export { DiffViewer, type DiffViewerProps } from "./components/DiffViewer.tsx";
