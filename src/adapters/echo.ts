/**
 * The echo adapter: a no-op agent for pipeline testing.
 *
 * It copies the fixture into the workspace, writes a canned transcript, and
 * makes exactly one trivial file edit (NOTES.md). This proves the full
 * run -> grade -> persist pipeline end-to-end without Docker or LLM spend,
 * and gives every later phase a fast integration-test target.
 */

import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter, AttemptContext, AttemptOutcome, TranscriptEvent } from "./types.ts";

export class EchoAdapter implements AgentAdapter {
  readonly name: string;
  /** Does nothing, so every eval must fail it: a scorer it passes rewards doing nothing. */
  readonly role = "negative-control" as const;
  readonly identity = {
    provider: "local", model: "echo-v1", reasoning: "none", cliVersion: "built-in",
    surfacePolicies: { docs: "no-network", mcp: "no-network", cli: "no-network" },
    nativeWebControl: "controlled" as const,
    reproducible: true,
  };

  constructor(name = "echo") {
    this.name = name;
  }

  async runAttempt(ctx: AttemptContext): Promise<AttemptOutcome> {
    await cp(ctx.fixtureDir, ctx.workspaceDir, { recursive: true });

    const notes =
      `# Notes\n\n` +
      `Echo adapter placeholder: no-op pipeline smoke for attempt ${ctx.attemptId} ` +
      `(trial ${ctx.trialIndex}).\n`;
    await writeFile(join(ctx.workspaceDir, "NOTES.md"), notes, "utf8");

    const transcript: TranscriptEvent[] = [
      { role: "user", content: ctx.prompt, at: new Date().toISOString() },
      {
        role: "assistant",
        content: `Copied the fixture and wrote NOTES.md (echo pipeline smoke).`,
        at: new Date().toISOString(),
      },
    ];

    const noteLines = notes.trimEnd().split("\n");
    const diff =
      `--- /dev/null\n+++ b/NOTES.md\n@@ -0,0 +1,${noteLines.length} @@\n` +
      noteLines.map((line) => `+${line}`).join("\n") +
      "\n";

    return {
      transcript,
      diff,
      metrics: { tokensIn: ctx.prompt.length, tokensOut: notes.length, turns: 1, costUsd: 0 },
    };
  }
}
