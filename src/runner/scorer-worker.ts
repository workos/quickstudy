import { parentPort } from "node:worker_threads";
import { importEvalScorer } from "../evals/discovery.ts";
import { buildEvalContext } from "./context.ts";

if (!parentPort) throw new Error("scorer worker requires a parent");
const port = parentPort;
let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
function revive(value: any): any {
  if (value && typeof value === "object") {
    if (typeof value.__quickstudyMethod === "number")
      return (...args: unknown[]) => rpc("clientMethod", [value.__quickstudyMethod, args]);
    if (Array.isArray(value)) return value.map(revive);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
  }
  return value;
}
function rpc(method: string, args: unknown[]): Promise<any> {
  const id = sequence++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage({ type: "rpc", id, method, args });
  });
}
function getClient(name: string): unknown {
  const buffer = new SharedArrayBuffer(1024 * 1024);
  const state = new Int32Array(buffer, 0, 2);
  port.postMessage({ type: "sync", method: "getClient", args: [name], buffer });
  Atomics.wait(state, 0, 0);
  const result = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, state[1]!)));
  if (result.error) throw new Error(result.error);
  return revive(result.value);
}
port.on("message", async (message) => {
  if (message.type === "reply") {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error));
    else waiter?.resolve(revive(message.value));
    return;
  }
  if (message.type !== "start") return;
  try {
    const scorer = await importEvalScorer(message.scorerPath);
    const context = buildEvalContext({
      ...message.context,
      exec: (cmd, opts) => rpc("exec", [cmd, opts]),
      query: (request) => rpc("query", [request]),
      redact: (text) => rpc("redact", [text]),
      getClient,
    });
    const result = await scorer(context);
    port.postMessage({ type: "result", result });
  } catch (error) {
    port.postMessage({
      type: "failure",
      error: error instanceof Error ? error.message : String(error),
      judgments: (error as { judgments?: unknown })?.judgments,
    });
  }
});
