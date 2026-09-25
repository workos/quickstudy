/**
 * The oracle adapter: applies the eval's reference solution and does nothing
 * else.
 *
 * A bench is only trustworthy when a reference solution scores 1.0 on every
 * eval (and a no-op — the echo adapter — scores 0). The oracle declares
 * `startingState: "solution"`, so the runner's shared workspace prep overlays
 * `solution/` on `local/` before the adapter runs; both the host and the
 * container variant are then no-ops. No model runs: turns and cost are true
 * zeros, token counts are unavailable (null).
 */

import { cp } from "node:fs/promises";
import type { AgentAdapter, AttemptContext, AttemptMetrics, AttemptOutcome, ContainerAgentAdapter } from "./types.ts";

/** The oracle adapter's pinned identity — what a manifest records for it. */
export const ORACLE_IDENTITY = {
  provider: "local", model: "oracle-v1", reasoning: "none", cliVersion: "built-in",
  surfacePolicies: { docs: "no-network", mcp: "no-network", cli: "no-network" },
  nativeWebControl: "controlled" as const,
  reproducible: true,
};

function oracleMetrics(): AttemptMetrics {
  return { tokensIn: null, tokensOut: null, turns: 0, costUsd: 0 };
}

/** Host variant: the prepared fixture already carries the solution overlay. */
export class OracleAdapter implements AgentAdapter {
  readonly name = "oracle";
  readonly role = "positive-control" as const;
  readonly identity = ORACLE_IDENTITY;
  readonly startingState = "solution" as const;

  async runAttempt(ctx: AttemptContext): Promise<AttemptOutcome> {
    await cp(ctx.fixtureDir, ctx.workspaceDir, { recursive: true });
    return {
      transcript: [{ role: "assistant", content: "oracle: applied the reference solution", at: new Date().toISOString() }],
      diff: "",
      metrics: oracleMetrics(),
    };
  }
}

/**
 * Container variant: the runner `docker cp`s the overlaid source into
 * /workspace, so the agent command is a no-op. Experiments using it must not
 * set `runtime.command` (that bypasses adapter resolution).
 */
export class OracleContainerAdapter implements ContainerAgentAdapter {
  readonly kind = "container" as const;
  readonly name = "oracle";
  readonly identity = ORACLE_IDENTITY;
  readonly startingState = "solution" as const;
  readonly role = "positive-control" as const;
  readonly requiredHostEnv: readonly string[] = [];

  setupFiles(): Record<string, string> {
    return {};
  }

  command(): string[] {
    return ["true"];
  }

  /** The no-op command prints nothing; input is ignored. */
  parseStream(_raw: string): AttemptMetrics {
    return oracleMetrics();
  }
}
