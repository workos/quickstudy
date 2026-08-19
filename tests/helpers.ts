/**
 * Shared test gating helpers.
 *
 * `requireDockerOrSkip` is the docker-gated suite idiom: probe the daemon
 * and required images ONCE at module load (top-level await), then hand back
 * `describe` when everything is ready or `describe.skip` with a loud banner
 * when it is not. Under `QUICKSTUDY_REQUIRE_DOCKER=1` a missing daemon or
 * image FAILS the suite instead of skipping — CI machines that promise
 * Docker coverage must never silently deliver a skip.
 *
 * `wireWidgetsEndpoint` hand-wires the demo pack's alpha fixture into a
 * solved workspace (the `GET /widgets` endpoint per the Widgets spec) for
 * suites that grade a genuinely correct attempt — grading-container reuse
 * and the live HTTP probe. Written directly, never derived from a patch:
 * answer-key artifacts were removed from packs in v3.
 */

import { describe } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dockerDaemonReachable, imageExists } from "../src/isolation/docker.ts";

/** The callable shape shared by `describe` and `describe.skip`. */
export type DescribeFn = (label: string, fn: () => void) => void;

export async function requireDockerOrSkip(images: readonly string[], suiteName: string): Promise<DescribeFn> {
  let reason: string | undefined;
  if (!(await dockerDaemonReachable())) {
    reason = "no Docker daemon reachable";
  } else {
    for (const image of images) {
      if (!(await imageExists(image))) {
        reason = `image ${image} not built (build it with \`bun src/cli.ts images build\`)`;
        break;
      }
    }
  }

  if (reason === undefined) return describe;
  if (process.env["QUICKSTUDY_REQUIRE_DOCKER"] === "1") {
    throw new Error(`${suiteName}: QUICKSTUDY_REQUIRE_DOCKER=1 but ${reason}`);
  }
  console.warn(
    `\n⚠️  SKIPPING ${suiteName} — ${reason}.\n` +
      `   Start Docker (and build the images) to cover this path, or set QUICKSTUDY_REQUIRE_DOCKER=1 to make this fatal.\n`,
  );
  return describe.skip;
}

/**
 * Overwrite `server.js` in a copy of the demo pack's alpha fixture with a
 * correct `GET /widgets` implementation (active-only, sku-ascending,
 * `{"widgets": [...]}` envelope — the rules the fixture's docs/widgets-api.md
 * states). The result is a solved workspace the demo scenario's graders and
 * the app-http-probe must pass.
 */
export async function wireWidgetsEndpoint(workspaceDir: string): Promise<void> {
  await writeFile(
    join(workspaceDir, "server.js"),
    `// alpha: a dependency-free CommonJS HTTP app, with the GET /widgets\n` +
      `// endpoint wired per docs/widgets-api.md.\n` +
      `const http = require("node:http");\n` +
      `const { readFileSync } = require("node:fs");\n` +
      `const { join } = require("node:path");\n` +
      `\n` +
      `const server = http.createServer((req, res) => {\n` +
      `  if (req.method === "GET" && req.url === "/") {\n` +
      `    res.writeHead(200, { "content-type": "text/plain" });\n` +
      `    res.end("alpha app is running\\n");\n` +
      `    return;\n` +
      `  }\n` +
      `  if (req.method === "GET" && req.url === "/widgets") {\n` +
      `    const catalog = JSON.parse(readFileSync(join(__dirname, "data", "widgets.json"), "utf8"));\n` +
      `    const widgets = catalog.widgets\n` +
      `      .filter((widget) => widget.status === "active")\n` +
      `      .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));\n` +
      `    res.writeHead(200, { "content-type": "application/json" });\n` +
      `    res.end(JSON.stringify({ widgets }));\n` +
      `    return;\n` +
      `  }\n` +
      `  res.writeHead(404, { "content-type": "text/plain" });\n` +
      `  res.end("not found\\n");\n` +
      `});\n` +
      `\n` +
      `const port = Number(process.env.PORT ?? 3000);\n` +
      `server.listen(port, () => {\n` +
      `  console.log(\`alpha app listening on \${port}\`);\n` +
      `});\n`,
    "utf8",
  );
}
