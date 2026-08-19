/**
 * docs-smoke drift guard and unit coverage for its pure pieces: the block
 * extractor, the (doc, first-line) pairing, command normalization, and the
 * substitution/store-flag preparation. No doc block is EXECUTED here —
 * execution is `bun scripts/docs-smoke.ts` itself, an acceptance command.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blockCommands,
  extractBashBlocks,
  isStoreCommand,
  pairBlocksWithInventory,
  prepareCommand,
  SMOKE_DOCS,
  type ExecutionContext,
  type InventoryEntry,
} from "../scripts/docs-smoke.ts";
import { INVENTORY } from "./docs-smoke-inventory.ts";

const ROOT = join(import.meta.dir, "..");

const SAMPLE_MD = `# Title

\`\`\`bash
first command
second command
\`\`\`

Some prose, then a non-bash fence the extractor must skip:

\`\`\`
output only
\`\`\`

\`\`\`ts
const notBash = true;
\`\`\`

\`\`\`bash
first command
different body, same first line
\`\`\`
`;

function entry(overrides: Partial<InventoryEntry>): InventoryEntry {
  return { doc: "sample.md", match: "first command", classification: "runs-keyless", ...overrides };
}

describe("extractBashBlocks", () => {
  test("finds only ```bash fences, in order, with first-line anchors", () => {
    const blocks = extractBashBlocks("sample.md", SAMPLE_MD);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.firstLine).toBe("first command");
    expect(blocks[0]?.body).toBe("first command\nsecond command");
    expect(blocks[1]?.firstLine).toBe("first command");
    expect(blocks[1]?.body).toContain("different body");
    expect(blocks.map((b) => b.index)).toEqual([0, 1]);
  });
});

describe("pairBlocksWithInventory", () => {
  test("an unclassified block fails the drift guard, naming its first line", () => {
    const blocks = extractBashBlocks("sample.md", SAMPLE_MD);
    const { problems } = pairBlocksWithInventory(blocks, [entry({})]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("unclassified bash block in sample.md");
    expect(problems[0]).toContain('"first command"');
    expect(problems[0]).toContain("tests/docs-smoke-inventory.ts");
  });

  test("a stale inventory entry (no matching block) also fails", () => {
    const { problems } = pairBlocksWithInventory([], [entry({ match: "gone command" })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("stale inventory entry");
    expect(problems[0]).toContain('"gone command"');
  });

  test("duplicate first-line anchors pair with entries in document order", () => {
    const blocks = extractBashBlocks("sample.md", SAMPLE_MD);
    // README has two blocks opening with `bun install`; this mirrors that:
    // same (doc, match), distinguished only by order.
    const first = entry({ classification: "placeholder" });
    const second = entry({ classification: "needs-docker" });
    const { pairs, problems } = pairBlocksWithInventory(blocks, [first, second]);
    expect(problems).toEqual([]);
    expect(pairs[0]?.entry.classification).toBe("placeholder");
    expect(pairs[1]?.entry.classification).toBe("needs-docker");
  });

  test("the real docs and the real inventory agree in both directions", () => {
    const blocks = SMOKE_DOCS.flatMap((doc) => extractBashBlocks(doc, readFileSync(join(ROOT, doc), "utf8")));
    expect(blocks.length).toBeGreaterThan(0);
    const { pairs, problems } = pairBlocksWithInventory(blocks, INVENTORY);
    expect(problems).toEqual([]);
    expect(pairs).toHaveLength(INVENTORY.length);
  });
});

describe("blockCommands", () => {
  test("joins continuations, drops blanks/comments, strips trailing comments", () => {
    const body = [
      "# a leading comment",
      "",
      "run something \\",
      "  --with continuation",
      "plain command      # trailing comment",
    ].join("\n");
    // Interior whitespace from the continuation join is irrelevant to bash.
    expect(blockCommands(body).map((c) => c.replace(/\s+/g, " "))).toEqual([
      "run something --with continuation",
      "plain command",
    ]);
  });
});

describe("prepareCommand", () => {
  const ctx = (lastRunId?: string): ExecutionContext => ({
    ...(lastRunId !== undefined ? { lastRunId } : {}),
    scratchDir: "/scratch",
    dbPath: "/scratch/r.db",
    resultsDir: "/scratch/results",
  });

  test("substitutes the captured run id for <run-id>", () => {
    const e = entry({ substitute: { quickstudy: "bun src/cli.ts", "<run-id>": "lastRunId" } });
    expect(prepareCommand("quickstudy report <run-id>", e, ctx("01ABC"))).toBe("bun src/cli.ts report 01ABC");
  });

  test("a command needing <run-id> before any run executed is an error", () => {
    const e = entry({ substitute: { "<run-id>": "lastRunId" } });
    expect(() => prepareCommand("quickstudy report <run-id>", e, ctx())).toThrow(/no run has executed/);
  });

  test("resolves <scratch> inside literal substitutions", () => {
    const e = entry({ substitute: { "sample-pack": "<scratch>/sample-pack" } });
    expect(prepareCommand("quickstudy validate sample-pack", e, ctx())).toBe(
      "quickstudy validate /scratch/sample-pack",
    );
  });

  test("overlapping substitutions do not rewrite replacement values", () => {
    const e = entry({
      substitute: {
        "quickstudy-tour": "<scratch>/quickstudy-tour",
        quickstudy: "bun src/cli.ts",
      },
    });
    expect(prepareCommand("mkdir quickstudy-tour && quickstudy validate", e, ctx())).toBe(
      "mkdir /scratch/quickstudy-tour && bun src/cli.ts validate",
    );
  });

  test("store flags are appended to run/report commands, not to validate", () => {
    const e = entry({ substitute: { quickstudy: "bun src/cli.ts" }, storeFlags: true });
    expect(prepareCommand("quickstudy run --pack p --agent echo", e, ctx())).toBe(
      "bun src/cli.ts run --pack p --agent echo --db /scratch/r.db --results /scratch/results",
    );
    expect(prepareCommand("quickstudy validate p", e, ctx())).toBe("bun src/cli.ts validate p");
  });

  test("isStoreCommand only matches harness invocations", () => {
    expect(isStoreCommand("bun src/cli.ts run --pack p")).toBeTrue();
    expect(isStoreCommand("quickstudy export id --out ./site")).toBeTrue();
    expect(isStoreCommand("bun run build")).toBeFalse();
    expect(isStoreCommand("docker run something")).toBeFalse();
  });
});

describe("inventory invariants", () => {
  test("every executable block that touches the stores declares storeFlags", () => {
    // The store-pollution failure mode: executing a doc's `run` verbatim
    // would write the developer's real results.db. Assert the inventory
    // marks every such block for store-flag injection.
    const blocks = SMOKE_DOCS.flatMap((doc) => extractBashBlocks(doc, readFileSync(join(ROOT, doc), "utf8")));
    const { pairs } = pairBlocksWithInventory(blocks, INVENTORY);
    for (const { block, entry: paired } of pairs) {
      if (paired.classification !== "runs-keyless") continue;
      const substituted = blockCommands(block.body).map((command) => {
        let out = command;
        for (const [needle, value] of Object.entries(paired.substitute ?? {})) {
          if (value !== "lastRunId") out = out.replaceAll(needle, value);
        }
        return out;
      });
      if (substituted.some((command) => isStoreCommand(command))) {
        expect(paired.storeFlags).toBeTrue();
      }
    }
  });

  test("inventory docs are exactly the smoke docs", () => {
    const docs = new Set(INVENTORY.map((item) => item.doc));
    expect([...docs].sort()).toEqual([...SMOKE_DOCS].sort());
  });
});
