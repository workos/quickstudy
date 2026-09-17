import { useEffect, useState, type ReactNode } from "react";

/** Copies `text` to the clipboard; the label flips to "Copied" briefly, or "Copy failed". */
export function CopyButton({ text, label = "Copy", testId }: { text: () => string; label?: string; testId?: string }): ReactNode {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className="copy-button"
      data-testid={testId}
      onClick={() => navigator.clipboard.writeText(text()).then(() => setState("copied"), () => setState("failed"))}
    >
      {state === "idle" ? label : state === "copied" ? "Copied" : "Copy failed"}
    </button>
  );
}
