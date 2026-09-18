import { useEffect, useState, type ReactNode } from "react";

// `navigator.clipboard` exists only in a secure context (HTTPS, localhost, file://). Off
// one, the property is undefined and `writeText` would throw synchronously — before any
// promise handler. Going through an async function turns that into a rejection too.
async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    throw new Error("the clipboard API needs a secure context (HTTPS, localhost or file://)");
  }
  await navigator.clipboard.writeText(text);
}

/** Copies `text` to the clipboard; the label flips to "Copied" briefly, or "Copy failed" with the reason as its tooltip. */
export function CopyButton({ text, label = "Copy", testId }: { text: () => string; label?: string; testId?: string }): ReactNode {
  const [state, setState] = useState<{ kind: "idle" } | { kind: "copied" } | { kind: "failed"; reason: string }>({ kind: "idle" });
  useEffect(() => {
    if (state.kind === "idle") return;
    const timer = setTimeout(() => setState({ kind: "idle" }), state.kind === "failed" ? 4000 : 1500);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className="copy-button"
      data-testid={testId}
      title={state.kind === "failed" ? state.reason : undefined}
      onClick={() =>
        copyToClipboard(text()).then(
          () => setState({ kind: "copied" }),
          (err: unknown) => setState({ kind: "failed", reason: err instanceof Error ? err.message : String(err) }),
        )
      }
    >
      {state.kind === "idle" ? label : state.kind === "copied" ? "Copied" : "Copy failed"}
    </button>
  );
}
