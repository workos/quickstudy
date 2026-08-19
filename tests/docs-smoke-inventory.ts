/**
 * The docs-smoke inventory: every ```bash block in the onboarding docs under
 * smoke (see SMOKE_DOCS in scripts/docs-smoke.ts), classified.
 * `bun scripts/docs-smoke.ts` executes the `runs-keyless` entries and its
 * drift guard fails when this list and the docs disagree in either direction.
 *
 * This lives in tests/ (not next to the script) deliberately: the `match`
 * anchors may quote doc lines that name consumer vendors, and
 * tests/genericity.test.ts forbids consumer names anywhere under scripts/.
 * Importing the data keeps those strings out of the scanned file.
 *
 * Entries whose (doc, match) pair collides (e.g. README's two `bun install`
 * blocks) MUST be listed in document order — pairing consumes them
 * first-match-first.
 */

import type { InventoryEntry } from "../scripts/docs-smoke.ts";

/**
 * Rewrite the installed-binary invocation to its from-source equivalent —
 * the substitution the docs themselves sanction ("Replace `quickstudy` with
 * `bun src/cli.ts`"). The smoke runs from a checkout, not an installed
 * binary.
 */
const FROM_SOURCE = "bun src/cli.ts";

export const INVENTORY: InventoryEntry[] = [
  // ── README.md ────────────────────────────────────────────────────────────
  {
    doc: "README.md",
    match: "bun add quickstudy       # Bun >= 1.1 required; no Node build exists",
    classification: "placeholder",
    note: "registry install — not live until the 1.0.0 npm publish; scripts/pack-check.sh runs the tarball equivalent",
  },
  {
    doc: "README.md",
    match: "bun install",
    classification: "placeholder",
    note: "Install: `mv` into /usr/local/bin is machine-specific",
  },
  {
    doc: "README.md",
    match: "# 1. author a one-check eval and a host echo experiment",
    classification: "runs-keyless",
    substitute: {
      quickstudy: FROM_SOURCE,
      "demo-evals": "<scratch>/demo-evals",
      "demo-experiments": "<scratch>/demo-experiments",
      "<run-id>": "lastRunId",
    },
    storeFlags: true,
  },
  {
    doc: "README.md",
    match: "export ANTHROPIC_API_KEY=sk-...",
    classification: "needs-keys",
    note: "real-agent quickstart: image builds + paid API calls",
  },
  {
    doc: "README.md",
    match: "quickstudy ui                             # serve every run at http://127.0.0.1:4173",
    classification: "output-only",
    note: "long-running server — never executed",
  },
  {
    doc: "README.md",
    match: "quickstudy export <run-id> --out ./site",
    classification: "placeholder",
    note: "GitHub Pages recipe: publishes via npx gh-pages",
  },
  {
    doc: "README.md",
    match: "bun install",
    classification: "needs-docker",
    note: "Development: `bun test` auto-enables Docker-gated suites; CI owns these",
  },
  {
    doc: "README.md",
    match: "bun run ui:dev           # Vite dev server + ui/dev-data at /data (hot reload)",
    classification: "output-only",
    note: "dev servers + Playwright browsers — never executed",
  },

  // ── docs/getting-started.md ──────────────────────────────────────────────
  {
    doc: "docs/getting-started.md",
    match: "git clone <this-repo> && cd quickstudy",
    classification: "placeholder",
    note: "Install: repo placeholder + `mv` into /usr/local/bin is machine-specific",
  },
  {
    doc: "docs/getting-started.md",
    match: "quickstudy images build                 # one-time: agent-runtime, egress-proxy, mcp-proxy",
    classification: "needs-docker",
    note: "image builds against a live Docker daemon",
  },
  {
    doc: "docs/getting-started.md",
    match: "export ANTHROPIC_API_KEY=sk-...",
    classification: "needs-keys",
    note: "the real measurement: containers + a paid agent session",
  },
  {
    doc: "docs/getting-started.md",
    match: "quickstudy report --latest",
    classification: "runs-keyless",
    substitute: { quickstudy: FROM_SOURCE },
    storeFlags: true,
  },
  {
    doc: "docs/getting-started.md",
    match: "mkdir -p demo-evals/hello demo-experiments",
    classification: "runs-keyless",
    substitute: {
      "demo-evals": "<scratch>/demo-evals",
      "demo-experiments": "<scratch>/demo-experiments",
    },
  },
  {
    doc: "docs/getting-started.md",
    match: "quickstudy validate --evals-root demo-evals --experiments-root demo-experiments",
    classification: "runs-keyless",
    substitute: {
      quickstudy: FROM_SOURCE,
      "demo-evals": "<scratch>/demo-evals",
      "demo-experiments": "<scratch>/demo-experiments",
    },
    storeFlags: true,
  },
  {
    doc: "docs/getting-started.md",
    match: "quickstudy report <run-id>",
    classification: "runs-keyless",
    substitute: { quickstudy: FROM_SOURCE, "<run-id>": "lastRunId" },
    storeFlags: true,
  },
  {
    doc: "docs/getting-started.md",
    match: "quickstudy ui             # serve every run at http://127.0.0.1:4173",
    classification: "output-only",
    note: "long-running server — never executed",
  },
  {
    doc: "docs/getting-started.md",
    match: "quickstudy export <run-id> --out ./site",
    classification: "placeholder",
    note: "needs a built UI bundle (`bun run ui:build`) and writes a site directory",
  },
  {
    doc: "docs/getting-started.md",
    match: "quickstudy clean      # remove all quickstudy-labeled containers/networks",
    classification: "needs-docker",
    note: "talks to the Docker daemon",
  },

  // ── docs/writing-an-eval.md ──────────────────────────────────────────────
  {
    doc: "docs/writing-an-eval.md",
    match: "mkdir -p my-evals/hello-config/local",
    classification: "runs-keyless",
    substitute: { "my-evals": "<scratch>/my-evals" },
  },
  {
    doc: "docs/writing-an-eval.md",
    match:
      `printf -- 'export default async (ctx) => { const text = await ctx.readFile("app.config.json"); ` +
      `const ok = text.includes("greeting"); return { passed: ok, checks: [{ name: "config_key_present", ` +
      `passed: ok }] }; };\\n' > my-evals/hello-config/EVAL.ts`,
    classification: "runs-keyless",
    substitute: { "my-evals": "<scratch>/my-evals" },
  },
  {
    doc: "docs/writing-an-eval.md",
    match: "mkdir -p my-experiments",
    classification: "runs-keyless",
    substitute: {
      quickstudy: FROM_SOURCE,
      "my-evals": "<scratch>/my-evals",
      "my-experiments": "<scratch>/my-experiments",
    },
    storeFlags: true,
  },
  {
    doc: "docs/writing-an-eval.md",
    match: "quickstudy report <run-id>",
    classification: "runs-keyless",
    substitute: { quickstudy: FROM_SOURCE, "<run-id>": "lastRunId" },
    storeFlags: true,
  },
  {
    doc: "docs/writing-an-eval.md",
    match: "bun test evals/ scorers/",
    classification: "placeholder",
    note: "consumer-repo command: runs the benchmark repository's eval/scorer tests, not this checkout's",
  },
  {
    doc: "docs/writing-an-eval.md",
    match: "quickstudy run --eval acme-nextjs --experiment claude-docs --trials 1",
    classification: "needs-keys",
    note: "real measurement: containers, a framework image, and a paid agent session",
  },
];
