#!/usr/bin/env bun
/**
 * docs-smoke: prove the onboarding docs' keyless commands actually run.
 *
 * Extracts every fenced ```bash block from the onboarding docs, pairs each
 * block with an explicit inventory entry, executes the `runs-keyless` blocks
 * in document order, and lists the rest. Two ways to fail:
 *
 *   - drift: a block with no inventory entry (or a stale entry with no
 *     block) fails BEFORE anything executes — a new or moved block must be
 *     classified first;
 *   - execution: a keyless command exits non-zero — the remaining blocks
 *     still run, then every failure is reported (doc, block, exit code,
 *     captured output) and the script exits 1.
 *
 * The inventory itself lives in tests/docs-smoke-inventory.ts, NOT here:
 * its match strings quote doc lines that may name consumer products, and
 * the genericity suite forbids consumer names anywhere under scripts/. This
 * file only reads doc content at runtime, which is not scanned.
 *
 *   bun scripts/docs-smoke.ts          # drift check + execute keyless blocks
 *   bun scripts/docs-smoke.ts --list   # print the classified inventory only
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INVENTORY } from "../tests/docs-smoke-inventory.ts";

/**
 * The onboarding docs under smoke, in execution order. Order matters: run
 * ids captured from an executed `run` command satisfy later `<run-id>`
 * substitutions, so a doc's report blocks must follow its run blocks.
 */
export const SMOKE_DOCS = ["README.md", "docs/getting-started.md", "docs/writing-an-eval.md"] as const;

export type BlockClass = "runs-keyless" | "needs-docker" | "needs-keys" | "placeholder" | "output-only";

export interface InventoryEntry {
  /** Doc path relative to the repo root, e.g. "docs/getting-started.md". */
  doc: string;
  /**
   * First line of the block, exact — a position-independent anchor, so doc
   * edits can reorder blocks without touching the inventory. Blocks sharing
   * a first line within one doc pair up with their entries in document
   * order, so same-`match` entries must be listed in that order.
   */
  match: string;
  classification: BlockClass;
  /**
   * Literal text replacements applied to each command before execution. The
   * special value "lastRunId" substitutes the run id captured from the most
   * recently executed `run` command's output. Literal replacement values may
   * contain `<scratch>`, which resolves to this smoke run's throwaway
   * directory. This keeps checkout-free scaffold examples checkout-free in
   * the docs without letting the acceptance test write into the repository.
   */
  substitute?: Record<string, "lastRunId" | string>;
  /**
   * Append `--db <scratch> --results <scratch>` to the block's
   * run/report/export/ui commands, so executing the docs never writes to the
   * developer's real results stores.
   */
  storeFlags?: boolean;
  /** Why a block has its classification — shown by --list. */
  note?: string;
}

export interface DocBlock {
  doc: string;
  firstLine: string;
  body: string;
  /** 0-based order of this block within its doc. */
  index: number;
}

/** Extract every ```bash fenced block, in order. Other fences are ignored. */
export function extractBashBlocks(doc: string, content: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  let inFence = false;
  let fenceIsBash = false;
  let current: string[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    if (!inFence && line.startsWith("```")) {
      inFence = true;
      fenceIsBash = line === "```bash";
      current = [];
      continue;
    }
    if (inFence && line === "```") {
      inFence = false;
      if (fenceIsBash) {
        blocks.push({ doc, firstLine: current[0] ?? "", body: current.join("\n"), index: blocks.length });
      }
      continue;
    }
    if (inFence && fenceIsBash) current.push(rawLine);
  }
  return blocks;
}

export interface PairResult {
  pairs: Array<{ block: DocBlock; entry: InventoryEntry }>;
  problems: string[];
}

/**
 * Pair every extracted block with exactly one inventory entry by
 * (doc, first line), consuming same-anchor entries in document order.
 * Any block or entry left unpaired is drift.
 */
export function pairBlocksWithInventory(blocks: DocBlock[], inventory: readonly InventoryEntry[]): PairResult {
  const pairs: PairResult["pairs"] = [];
  const problems: string[] = [];
  const unconsumed = [...inventory];
  for (const block of blocks) {
    const at = unconsumed.findIndex((entry) => entry.doc === block.doc && entry.match === block.firstLine);
    if (at === -1) {
      problems.push(
        `unclassified bash block in ${block.doc} (block ${block.index + 1}, first line: ${JSON.stringify(block.firstLine)})` +
          ` — add an entry for it to tests/docs-smoke-inventory.ts`,
      );
      continue;
    }
    pairs.push({ block, entry: unconsumed[at] as InventoryEntry });
    unconsumed.splice(at, 1);
  }
  for (const entry of unconsumed) {
    problems.push(
      `stale inventory entry for ${entry.doc} (match: ${JSON.stringify(entry.match)})` +
        ` — no such bash block; update or remove it in tests/docs-smoke-inventory.ts`,
    );
  }
  return { pairs, problems };
}

/**
 * A block body → executable commands: join `\` continuations, drop blank and
 * comment-only lines, strip trailing ` # …` comments (so injected flags land
 * in the command, not inside a comment).
 */
export function blockCommands(body: string): string[] {
  const joined: string[] = [];
  let pending = "";
  for (const line of body.split("\n")) {
    const merged = pending + line;
    if (merged.trimEnd().endsWith("\\")) {
      pending = merged.trimEnd().slice(0, -1) + " ";
      continue;
    }
    pending = "";
    joined.push(merged);
  }
  if (pending !== "") joined.push(pending);
  return joined
    .map((line) => {
      const hashAt = line.indexOf(" #");
      return (hashAt === -1 ? line : line.slice(0, hashAt)).trim();
    })
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** Subcommands that accept the store-isolation flags. */
const STORE_SUBCOMMANDS = new Set(["run", "report", "export", "ui"]);

/** Whether this command is a harness invocation that reads/writes the stores. */
export function isStoreCommand(command: string): boolean {
  if (!command.includes("quickstudy") && !command.includes("cli.ts")) return false;
  return command.split(/\s+/).some((token) => STORE_SUBCOMMANDS.has(token));
}

export interface ExecutionContext {
  /** Run id captured from the most recent executed `run` command. */
  lastRunId?: string;
  scratchDir: string;
  dbPath: string;
  resultsDir: string;
}

/** Apply an entry's substitutions and store-flag injection to one command. */
export function prepareCommand(command: string, entry: InventoryEntry, ctx: ExecutionContext): string {
  let prepared = command;
  const replacements: Array<{ marker: string; value: string }> = [];
  for (const [index, [needle, value]] of Object.entries(entry.substitute ?? {}).entries()) {
    if (!prepared.includes(needle)) continue;
    let resolved: string;
    if (value === "lastRunId") {
      if (ctx.lastRunId === undefined) {
        throw new Error(`command needs a captured run id but no run has executed yet: ${command}`);
      }
      resolved = ctx.lastRunId;
    } else {
      resolved = value.replaceAll("<scratch>", ctx.scratchDir);
    }
    // Stage through markers so an overlapping substitution such as
    // `quickstudy` cannot rewrite the `quickstudy-tour` replacement path.
    const marker = `__QUICKSTUDY_DOCS_SMOKE_REPLACEMENT_${index}__`;
    prepared = prepared.replaceAll(needle, marker);
    replacements.push({ marker, value: resolved });
  }
  for (const replacement of replacements) {
    prepared = prepared.replaceAll(replacement.marker, replacement.value);
  }
  if (entry.storeFlags && isStoreCommand(prepared)) {
    prepared += ` --db ${ctx.dbPath} --results ${ctx.resultsDir}`;
  }
  return prepared;
}

/** The run summary line the CLI prints, e.g. "run 01ABC…: 6 attempts — …". */
const RUN_ID_PATTERN = /^run (\S+): \d+ attempts/m;

interface CommandFailure {
  doc: string;
  firstLine: string;
  command: string;
  exitCode: number;
  output: string;
}

function main(): void {
  const listOnly = process.argv.includes("--list");
  const root = join(import.meta.dir, "..");

  const blocks = SMOKE_DOCS.flatMap((doc) => extractBashBlocks(doc, readFileSync(join(root, doc), "utf8")));
  const { pairs, problems } = pairBlocksWithInventory(blocks, INVENTORY);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`docs-smoke: DRIFT: ${problem}`);
    console.error(`docs-smoke: ${problems.length} drift problem(s) — nothing was executed`);
    process.exit(1);
  }

  if (listOnly) {
    for (const doc of SMOKE_DOCS) {
      console.log(`${doc}:`);
      for (const { block, entry } of pairs.filter((pair) => pair.block.doc === doc)) {
        console.log(`  [${entry.classification}] ${block.firstLine}${entry.note ? `  — ${entry.note}` : ""}`);
      }
    }
    console.log(`${pairs.length} block(s), ${pairs.filter((p) => p.entry.classification === "runs-keyless").length} executable keyless`);
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), "docs-smoke-"));
  const ctx: ExecutionContext = {
    scratchDir: scratch,
    dbPath: join(scratch, "r.db"),
    resultsDir: join(scratch, "results"),
  };
  const failures: CommandFailure[] = [];
  let executed = 0;

  for (const { block, entry } of pairs) {
    if (entry.classification !== "runs-keyless") continue;
    console.log(`docs-smoke: ${block.doc} :: ${block.firstLine}`);
    for (const command of blockCommands(block.body)) {
      let prepared: string;
      try {
        prepared = prepareCommand(command, entry, ctx);
      } catch (err) {
        failures.push({
          doc: block.doc,
          firstLine: block.firstLine,
          command,
          exitCode: -1,
          output: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      // Keyless means keyless: the judge and analyst silently switch on when
      // a provider key is present (including via Bun's .env auto-load), and a
      // doc smoke must never place paid API calls.
      const result = Bun.spawnSync(["bash", "-c", prepared], {
        cwd: root,
        env: { ...process.env, ANTHROPIC_API_KEY: "" },
      });
      executed += 1;
      const output = result.stdout.toString() + result.stderr.toString();
      const runId = RUN_ID_PATTERN.exec(result.stdout.toString())?.[1];
      if (runId !== undefined) ctx.lastRunId = runId;
      if (result.exitCode === 0) {
        console.log(`  ok: ${prepared}`);
      } else {
        console.log(`  FAIL (exit ${result.exitCode}): ${prepared}`);
        failures.push({ doc: block.doc, firstLine: block.firstLine, command: prepared, exitCode: result.exitCode, output });
      }
    }
  }

  const skipped = pairs.length - pairs.filter((p) => p.entry.classification === "runs-keyless").length;
  console.log(`docs-smoke: ${executed} command(s) executed across ${pairs.length} block(s) (${skipped} listed, not executed)`);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`\ndocs-smoke: FAILED in ${failure.doc}`);
      console.error(`  block:   ${failure.firstLine}`);
      console.error(`  command: ${failure.command}`);
      console.error(`  exit:    ${failure.exitCode}`);
      console.error(`  output:\n${failure.output.replace(/^/gm, "    ")}`);
    }
    console.error(`\ndocs-smoke: ${failures.length} command(s) failed`);
    process.exit(1);
  }
}

if (import.meta.main) main();
