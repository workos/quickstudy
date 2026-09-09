import { Worker } from "node:worker_threads";
import type { EvalContext, EvalResult } from "../evals/types.ts";

/** Scorers run in a terminable worker: a deadline also stops late direct file mutations. */
export async function scoreInWorker(
  scorerPath: string,
  context: EvalContext,
  signal: AbortSignal,
): Promise<EvalResult> {
  signal.throwIfAborted();
  const worker = new Worker(
    new URL(import.meta.url.includes("/$bunfs/") ? "./runner/scorer-worker.js" : "./scorer-worker.ts", import.meta.url),
  );
  const methods: Array<(...args: any[]) => unknown> = [];
  function serialize(value: any, depth = 0): any {
    if (depth > 8) throw new Error("client capability exceeds serialization depth");
    if (typeof value === "function") {
      const id = methods.length;
      methods.push(value);
      return { __quickstudyMethod: id };
    }
    if (Array.isArray(value)) return value.map((v) => serialize(v, depth + 1));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          serialize(typeof item === "function" ? item.bind(value) : item, depth + 1),
        ]),
      );
    return value;
  }
  let settled = false;
  try {
    return await new Promise<EvalResult>((resolve, reject) => {
      const abort = () => {
        void worker.terminate();
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      worker.once("exit", () => {
        signal.removeEventListener("abort", abort);
        reject(new Error("scorer worker exited before returning a result"));
      });
      worker.once("error", reject);
      worker.on("message", async (message) => {
        if (message.type === "result") {
          settled = true;
          resolve(message.result);
          return;
        }
        if (message.type === "failure") {
          settled = true;
          reject(Object.assign(new Error(message.error), { judgments: message.judgments }));
          return;
        }
        let response: { value?: unknown; error?: string };
        try {
          signal.throwIfAborted();
          const [first, second] = message.args;
          const value =
            message.method === "exec"
              ? await context.exec(first, second)
              : message.method === "query"
                ? await context.query(first)
                : message.method === "redact"
                  ? ((await context.redact?.(first)) ?? first)
                  : message.method === "getClient"
                    ? context.getClient(first)
                    : message.method === "clientMethod" && methods[first]
                      ? await methods[first]!(...second)
                      : (() => {
                          throw new Error("unsupported scorer capability");
                        })();
          response = { value: serialize(value) };
        } catch (error) {
          response = { error: error instanceof Error ? error.message : String(error) };
        }
        if (settled || signal.aborted) return;
        if (message.type === "sync") {
          const state = new Int32Array(message.buffer, 0, 2);
          let encoded = new TextEncoder().encode(JSON.stringify(response));
          if (encoded.length > message.buffer.byteLength - 8)
            encoded = new TextEncoder().encode('{"error":"client capability exceeds 1 MiB"}');
          new Uint8Array(message.buffer, 8, encoded.length).set(encoded);
          state[1] = encoded.length;
          Atomics.store(state, 0, 1);
          Atomics.notify(state, 0);
        } else if (!signal.aborted) worker.postMessage({ type: "reply", id: message.id, ...response });
      });
      worker.postMessage({
        type: "start",
        scorerPath,
        context: {
          evalId: context.evalId,
          experimentId: context.experimentId,
          trialIndex: context.trialIndex,
          framework: context.framework,
          workspaceDir: context.workspaceDir,
          agentOutput: context.agentOutput,
        },
      });
    });
  } finally {
    settled = true;
    await worker.terminate();
  }
}
