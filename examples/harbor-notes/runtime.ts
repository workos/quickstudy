import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "quickstudy";

/** A complete local provisioning lifecycle; replace this notebook store with your API. */
export function harborRuntime(scripted = true): Runtime {
  return {
    kind: "container",
    config: { notebookSchema: 1, scripted },
    containerImage: () => (scripted ? "alpine:3" : "quickstudy/agent-runtime"),
    ...(scripted
      ? { command: ["sh", "-c", `printf '%s\n' '{"title":"First note","body":"Hello from Harbor"}' > note.json`] }
      : {}),
    egressHosts: () => [],
    webPolicy: () => "native-web-blocked",
    // Observation does not offer a docs or CLI treatment. A scripted run has
    // no supported agent telemetry stream and records usage as unavailable.
    observationTargets: { docsHosts: ["docs.harbor.example"], cliCommands: ["harbor"] },
    async provision(ctx) {
      ctx.signal?.throwIfAborted();
      const notebook = await mkdtemp(join(tmpdir(), "harbor-notebook-"));
      try {
        await writeFile(
          join(notebook, "expected.json"),
          JSON.stringify({ title: "First note", body: "Hello from Harbor" }),
        );
        ctx.signal?.throwIfAborted();
        return {
          env: { HARBOR_NOTEBOOK: notebook },
          teardown: async () => {
            await rm(notebook, { recursive: true, force: true });
          },
        };
      } catch (error) {
        await rm(notebook, { recursive: true, force: true });
        throw error;
      }
    },
    scorerCapabilities: (ctx) => ({
      query: async (request) => {
        ctx.signal?.throwIfAborted();
        if (request !== "expected-note") throw new Error("unknown notebook query");
        return JSON.parse(await readFile(join(ctx.env.HARBOR_NOTEBOOK!, "expected.json"), "utf8"));
      },
    }),
  };
}
