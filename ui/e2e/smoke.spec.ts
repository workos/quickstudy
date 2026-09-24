/**
 * UI smoke suite (v3 shapes):
 *   - served mode: matrix / compare / report render with data
 *   - offline mode: file:// load with every network scheme aborted → the
 *     heatmap still renders (inline data index)
 *   - the heatmap cell states (incl. graded timeouts) render distinctly and drill down correctly
 *   - attempt deep links land on a highlighted transcript/diff range
 *   - diagnosis: findings grouped by target with evidence deep links into the
 *     line-anchored viewers; a diagnosis-less run renders the command-hint
 *     empty state (served and file://)
 *   - schemaVersion mismatch → banner; empty data dir → friendly empty state;
 *     retired (pre-v3) link formats → explicit notice, never a blank page
 */

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = join(E2E_DIR, ".fixtures", "site");

interface FixtureMeta {
  runs: Array<{ id: string; eval_ids: string[]; experiment_ids: string[] }>;
}

interface FixtureRun {
  attempts: Array<{
    id: string;
    eval_id: string;
    experiment_id: string;
    trial_index: number;
    status: string;
    transcript: string | null;
    diff: string | null;
  }>;
}

function fixtureMeta(): FixtureMeta {
  return JSON.parse(readFileSync(join(SITE_DIR, "data", "meta.json"), "utf8")) as FixtureMeta;
}

function fixtureRun(runId: string): FixtureRun {
  return JSON.parse(readFileSync(join(SITE_DIR, "data", "runs", runId, "run.json"), "utf8")) as FixtureRun;
}

/** meta lists newest first: [full sweep, cell-states, trials-1]. */
function runIds(): { sweep: string; cellStates: string; n1: string } {
  const runs = fixtureMeta().runs;
  expect(runs).toHaveLength(3);
  return { sweep: runs[0]!.id, cellStates: runs[1]!.id, n1: runs[2]!.id };
}

/** The seeded 600-turn transcript lives on claude-mcp × auth-nextjs trial 0. */
function longTranscriptAttempt(): { id: string } {
  const { sweep } = runIds();
  const attempt = fixtureRun(sweep).attempts.find(
    (candidate) => candidate.experiment_id === "claude-mcp" && candidate.eval_id === "auth-nextjs" && candidate.trial_index === 0,
  );
  if (!attempt) throw new Error("fixture invariant broken: no claude-mcp/auth-nextjs trial 0 attempt");
  return attempt;
}

test.describe("served mode: three routes render with data", () => {
  test("matrix renders the eval × experiment heatmap with KPI totals", async ({ page }) => {
    await page.goto("/site/index.html#/");
    await expect(page.getByTestId("matrix-view")).toBeVisible();
    await expect(page.getByTestId("cell-auth-nextjs-claude-docs")).toBeVisible();
    await expect(page.getByTestId("cell-auth-rails-claude-mcp")).toBeVisible();
    await expect(page.getByTestId("cell-auth-django-codex-cli")).toBeVisible();
    await expect(page.locator(".kpi-row")).toContainText("Overall pass rate");
    await expect(page.getByRole("link", { name: "Matrix" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: "Compare" })).not.toHaveAttribute("aria-current", "page");
    // The suite toggle renders (the sweep seeds a regression eval) and
    // defaults to benchmark.
    await expect(page.getByTestId("suite-benchmark")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("suite-regression")).toHaveAttribute("aria-pressed", "false");
  });

  test("metadata filters narrow the eval rows without touching run identity", async ({ page }) => {
    await page.goto("/site/index.html#/");
    await expect(page.getByTestId("cell-auth-rails-claude-docs")).toBeVisible();
    await page.getByTestId("filter-framework").selectOption("nextjs");
    await expect(page.getByTestId("cell-auth-nextjs-claude-docs")).toBeVisible();
    await expect(page.getByTestId("cell-auth-rails-claude-docs")).toHaveCount(0);
    await page.getByTestId("filter-framework").selectOption("all");
    await expect(page.getByTestId("cell-auth-rails-claude-docs")).toBeVisible();
  });

  test("compare renders one compared and one withheld group", async ({ page }) => {
    const { sweep } = runIds();
    await page.goto(`/site/index.html#/compare/${sweep}`);
    await expect(page.getByTestId("compare-view")).toBeVisible();
    await expect(page.getByRole("link", { name: "Compare" })).toHaveAttribute("aria-current", "page");

    // claude: compared — raw counts per arm, no intervals anywhere.
    const claudeTable = page.getByTestId("group-table-claude");
    await expect(claudeTable).toBeVisible();
    await expect(page.getByTestId("arm-auth-nextjs-claude-docs")).toContainText("3/3");
    await expect(page.getByTestId("arm-auth-nextjs-claude-mcp")).toContainText("0/3");

    // codex: withheld — the component diff names the mismatched model, and
    // no comparison table renders.
    await expect(page.getByTestId("group-withheld-codex")).toBeVisible();
    await expect(page.getByTestId("group-diff-codex")).toContainText("model");
    await expect(page.getByTestId("group-table-codex")).toHaveCount(0);

    // Three trials per pair and every listed arm scored: no not-comparable notice.
    await expect(page.getByTestId("compare-n-notice")).toHaveCount(0);
  });

  test("compare states counts are not comparable on a trials-1 run", async ({ page }) => {
    const { n1 } = runIds();
    await page.goto(`/site/index.html#/compare/${n1}`);
    await expect(page.getByTestId("group-table-claude")).toBeVisible();
    const notice = page.getByTestId("compare-n-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("this run: 1");
    await expect(notice).toContainText("not comparable");
    // Counts stay listed.
    await expect(page.getByTestId("arm-auth-nextjs-claude-docs")).toContainText("1/1");
  });

  test("report renders totals, per-pair rates, groups, and methodology", async ({ page }) => {
    const { sweep } = runIds();
    await page.goto(`/site/index.html#/report/${sweep}`);
    await expect(page.getByTestId("report-view")).toBeVisible();
    await expect(page.getByTestId("pairs-table")).toBeVisible();
    await expect(page.getByTestId("pairs-table")).toContainText("auth-nextjs");
    await expect(page.getByTestId("report-groups")).toBeVisible();
    await expect(page.getByTestId("report-group-claude")).toContainText("raw counts");
    await expect(page.getByTestId("report-group-codex")).toContainText("withheld");
    await expect(page.getByTestId("usage-summary")).toBeVisible();
    await expect(page.getByTestId("methodology")).toContainText("raw counts are the honest statement");
    await expect(page.getByTestId("sdk-recall")).toContainText("SDK recall 0/");
    await expect(page.getByTestId("pairs-table").getByTestId("ungraded-tag").first()).toBeVisible();
  });
});

test.describe("matrix cell states + drill-down", () => {
  test("0%, 100%, flaky, incomplete and timeout cells render distinctly", async ({ page }) => {
    const { cellStates } = runIds();
    await page.goto(`/site/index.html#/run/${cellStates}`);
    await expect(page.getByTestId("cell-auth-nextjs-claude-docs")).toHaveAttribute("data-rate", "0");
    await expect(page.getByTestId("cell-auth-rails-claude-docs")).toHaveAttribute("data-rate", "100");
    await expect(page.getByTestId("cell-auth-django-claude-docs")).toHaveAttribute("data-flaky", "true");
    await expect(page.getByTestId("cell-auth-nextjs-claude-mcp")).toHaveAttribute("data-incomplete", "true");
    // Graded timeouts are completed attempts: a scored 0% cell, not an incomplete one.
    await expect(page.getByTestId("cell-auth-rails-claude-mcp")).toHaveAttribute("data-rate", "0");
    await expect(page.getByTestId("cell-auth-rails-claude-mcp")).not.toHaveAttribute("data-incomplete", "true");
  });

  test("the timeout cell's drill-down shows the limit badge; a plain completed attempt shows none", async ({ page }) => {
    const { cellStates } = runIds();
    await page.goto(`/site/index.html#/run/${cellStates}/cell/auth-rails/claude-mcp`);
    await expect(page.getByTestId("drill-down")).toBeVisible();
    expect(await page.getByTestId("drill-attempt").count()).toBe(3);
    await expect(page.getByTestId("drill-attempt").first()).toContainText("failed");
    await expect(page.getByTestId("drill-attempt").first().getByTestId("limit-badge")).toHaveText("timeout");
    await expect(page.getByTestId("drill-down").getByTestId("error-kind-badge")).toHaveCount(0);

    await page.goto(`/site/index.html#/run/${cellStates}/cell/auth-rails/claude-docs`);
    await expect(page.getByTestId("drill-down")).toBeVisible();
    await expect(page.getByTestId("drill-down").getByTestId("limit-badge")).toHaveCount(0);
  });

  test("the seeded error attempt shows its error-kind badge", async ({ page }) => {
    const { sweep } = runIds();
    await page.goto(`/site/index.html#/run/${sweep}/cell/auth-django/codex-mcp`);
    await expect(page.getByTestId("drill-down")).toBeVisible();
    await expect(page.getByTestId("drill-down").getByTestId("error-kind-badge")).toHaveText("agent");
  });

  test("clicking a cell opens the URL-addressable drill-down with attempt detail", async ({ page }) => {
    const { cellStates } = runIds();
    await page.goto(`/site/index.html#/run/${cellStates}`);
    await page.getByTestId("cell-auth-nextjs-claude-docs").click();

    await expect(page.getByTestId("drill-down")).toBeVisible();
    expect(page.url()).toContain(`#/run/${cellStates}/cell/auth-nextjs/claude-docs`);
    expect(await page.getByTestId("drill-attempt").count()).toBe(3);
    await expect(page.getByTestId("drill-attempt").first()).toContainText("failed");
    // Check chips render per named check.
    await expect(page.getByTestId("drill-down").locator(".crit").first()).toBeVisible();

    await page.getByTestId("drill-close").click();
    await expect(page.getByTestId("drill-down")).not.toBeVisible();
  });

  test("heatmap cells are keyboard-operable", async ({ page }) => {
    const { cellStates } = runIds();
    await page.goto(`/site/index.html#/run/${cellStates}`);
    const cell = page.getByTestId("cell-auth-nextjs-claude-docs");
    await cell.focus();
    await expect(cell).toBeFocused();
    await cell.press("Enter");
    await expect(page.getByTestId("drill-down")).toBeVisible();
  });

  test("drill-down is a modal dialog with trapped focus, Escape close, and focus return", async ({ page }) => {
    const { cellStates } = runIds();
    await page.goto(`/site/index.html#/run/${cellStates}`);
    const cell = page.getByTestId("cell-auth-nextjs-claude-docs");
    await cell.click();

    const dialog = page.getByRole("dialog");
    const close = page.getByTestId("drill-close");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toHaveAttribute("aria-labelledby", /.+/);
    await expect(dialog).toHaveAccessibleName(/auth-nextjs.*claude-docs/i);
    await expect(close).toBeFocused();

    const focusables = dialog.locator('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
    const last = focusables.last();
    await last.focus();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(last).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(cell).toBeFocused();
  });

  test("mobile layout exposes horizontal-scroll guidance without clipping controls", async ({ page }) => {
    const { cellStates } = runIds();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/site/index.html#/run/${cellStates}`);
    await expect(page.locator(".scroll-hint")).toBeVisible();
    await expect(page.getByTestId("run-select")).toBeVisible();
  });

  test("deep-linking the drill-down URL opens the panel directly", async ({ page }) => {
    const { cellStates } = runIds();
    await page.goto(`/site/index.html#/run/${cellStates}/cell/auth-rails/claude-docs`);
    await expect(page.getByTestId("drill-down")).toBeVisible();
    await expect(page.getByTestId("drill-attempt").first()).toContainText("passed");
  });

  test("drill-down tags the ungraded check and the cell counts graded checks only", async ({ page }) => {
    const { sweep } = runIds();
    // claude-docs passes all 3 trials but never wires the SDK: an ungraded miss.
    await page.goto(`/site/index.html#/run/${sweep}`);
    // 3 trials × 3 graded checks; the ungraded sdk-wired check is excluded (else 9/12).
    await expect(page.getByTestId("cell-auth-nextjs-claude-docs").locator(".cell-sub")).toContainText("9/9 checks");
    await page.goto(`/site/index.html#/run/${sweep}/cell/auth-nextjs/claude-docs`);
    await expect(page.getByTestId("drill-down")).toBeVisible();
    const first = page.getByTestId("drill-attempt").first();
    await expect(first).toContainText("passed");
    await expect(first.getByTestId("ungraded-tag")).toBeVisible();
    await expect(first.locator(".crit.fail")).toContainText("sdk-wired");
  });

  test("the drill-down shows the offered≠used surface case", async ({ page }) => {
    const { sweep } = runIds();
    // claude-cli's failing trial read the docs despite the cli treatment.
    await page.goto(`/site/index.html#/run/${sweep}/cell/auth-nextjs/claude-cli`);
    await expect(page.getByTestId("drill-down")).toBeVisible();
    await expect(page.getByTestId("drill-down")).toContainText("cross-arm use: docs");
  });
});

test.describe("attempt deep links + artifact viewers", () => {
  test("a transcript deep link lands on a highlighted line in the 600-turn window", async ({ page }) => {
    const { sweep } = runIds();
    const attempt = longTranscriptAttempt();
    await page.goto(`/site/index.html#/run/${sweep}/attempt/${attempt.id}/transcript/L542-545`);

    await expect(page.getByTestId("attempt-view")).toBeVisible();
    await expect(page.getByTestId("transcript-viewer")).toBeVisible();
    const loadAll = page.getByTestId("load-all");
    await expect(loadAll).toBeVisible();
    await expect(loadAll).toContainText("600");
    const anchor = page.locator("#L542");
    await expect(anchor).toBeVisible();
    await expect(anchor).toHaveClass(/highlight/);
    await expect(anchor).toBeInViewport();

    await loadAll.click();
    await expect(page.locator("#L1")).toBeAttached();
    await expect(page.locator("#L600")).toBeAttached();
  });

  test("a diff deep link renders the diff viewer with the cited lines highlighted", async ({ page }) => {
    const { sweep } = runIds();
    const attempt = fixtureRun(sweep).attempts.find((candidate) => candidate.diff !== null);
    expect(attempt).toBeDefined();
    await page.goto(`/site/index.html#/run/${sweep}/attempt/${attempt!.id}/diff/L1-3`);
    await expect(page.getByTestId("diff-viewer")).toBeVisible();
    await expect(page.locator("#L1")).toHaveClass(/highlight/);
  });

  test("the attempt view carries the surface-usage panel", async ({ page }) => {
    const { sweep } = runIds();
    const attempt = longTranscriptAttempt();
    await page.goto(`/site/index.html#/run/${sweep}/attempt/${attempt.id}/transcript`);
    await expect(page.getByTestId("attempt-view")).toBeVisible();
    await expect(
      page.getByTestId("surface-usage").or(page.getByTestId("surface-usage-unavailable")),
    ).toBeVisible();
  });
});

test.describe("diagnosis view", () => {
  test("findings render grouped by target with the disclaimer and provenance header", async ({ page }) => {
    const { sweep } = runIds();
    await page.goto(`/site/index.html#/diagnosis/${sweep}`);

    await expect(page.getByTestId("diagnosis-view")).toBeVisible();
    await expect(page.getByRole("link", { name: "Diagnosis" })).toHaveAttribute("aria-current", "page");
    // The artifact self-labels: the disclaimer renders before any finding.
    await expect(page.getByTestId("diagnosis-disclaimer")).toContainText("hypotheses, not verdicts");
    await expect(page.getByTestId("diagnosis-provenance")).toContainText("model-a-analyst");

    // Findings cluster by (eval, failing graded checks) from the report,
    // largest first; the ungraded sdk-wired miss never enters a heading.
    const clusters = page.getByTestId("diagnosis-cluster");
    await expect(clusters).toHaveCount(3);
    await expect(clusters.filter({ hasText: "auth-nextjs · flow-wired failed under 1 arm · 1 finding" })).toHaveCount(1);
    await expect(clusters.filter({ hasText: "auth-nextjs · build-passes failed under 1 arm" })).toHaveCount(1);
    await expect(clusters.filter({ hasText: "sdk-wired" })).toHaveCount(0);

    // The seeded fixture spans three targets; each renders its own section.
    await expect(page.getByTestId("diagnosis-target-mcp")).toBeVisible();
    await expect(page.getByTestId("diagnosis-target-cli")).toBeVisible();
    await expect(page.getByTestId("diagnosis-target-sdk")).toBeVisible();
    expect(await page.getByTestId("diagnosis-finding").count()).toBe(3);
    await expect(page.getByTestId("diagnosis-finding").first()).toContainText("confidence");

    // The unanalyzable pair is recorded, never silently dropped.
    await expect(page.getByTestId("diagnosis-errors")).toContainText("codex-mcp");

    // Target filter buttons still narrow within clusters.
    await page.getByTestId("diagnosis-target-filter").getByRole("button", { name: "mcp (1)" }).click();
    await expect(page.getByTestId("diagnosis-finding")).toHaveCount(1);
    await expect(clusters).toHaveCount(1);
    await expect(page.getByTestId("diagnosis-target-cli")).toHaveCount(0);
    await page.getByTestId("diagnosis-target-filter").getByRole("button", { name: "all (3)" }).click();
    await expect(page.getByTestId("diagnosis-finding")).toHaveCount(3);
  });

  test("an evidence link deep-links to the highlighted line window in the transcript", async ({ page }) => {
    const { sweep } = runIds();
    await page.goto(`/site/index.html#/diagnosis/${sweep}`);

    const evidence = page.getByTestId("diagnosis-target-mcp").getByTestId("evidence-link");
    await expect(evidence).toContainText("transcript L542");
    await evidence.click();

    await expect(page.getByTestId("attempt-view")).toBeVisible();
    await expect(page.getByTestId("transcript-viewer")).toBeVisible();
    const anchor = page.locator("#L542");
    await expect(anchor).toBeVisible();
    await expect(anchor).toHaveClass(/highlight/);
    await expect(anchor).toBeInViewport();
  });

  test("a diagnosis-less run renders the empty state naming the command", async ({ page }) => {
    const { cellStates } = runIds();
    await page.goto(`/site/index.html#/diagnosis/${cellStates}`);
    await expect(page.getByTestId("diagnosis-empty")).toBeVisible();
    await expect(page.getByTestId("diagnosis-empty")).toContainText(`quickstudy diagnose ${cellStates}`);
    await expect(page.getByTestId("diagnosis-finding")).toHaveCount(0);
  });
});

test.describe("offline file:// mode", () => {
  test("heatmap renders from file:// with all network schemes blocked", async ({ page }) => {
    // Abort anything that is not the local file protocol.
    await page.route(
      (url) => url.protocol === "http:" || url.protocol === "https:",
      (route) => route.abort(),
    );
    await page.goto(`file://${join(SITE_DIR, "index.html")}#/`);

    await expect(page.getByTestId("matrix-view")).toBeVisible();
    await expect(page.getByTestId("cell-auth-nextjs-claude-docs")).toBeVisible();
    await expect(page.locator(".kpi-row")).toContainText("Overall pass rate");
  });

  test("report + compare also work offline (inline index)", async ({ page }) => {
    const { sweep } = runIds();
    await page.goto(`file://${join(SITE_DIR, "index.html")}#/report/${sweep}`);
    await expect(page.getByTestId("pairs-table")).toBeVisible();

    await page.goto(`file://${join(SITE_DIR, "index.html")}#/compare/${sweep}`);
    await page.reload();
    await expect(page.getByTestId("group-table-claude")).toBeVisible();
  });

  test("diagnosis renders offline from the inline index; absence degrades to the empty state", async ({ page }) => {
    const { sweep, cellStates } = runIds();
    await page.goto(`file://${join(SITE_DIR, "index.html")}#/diagnosis/${sweep}`);
    await expect(page.getByTestId("diagnosis-target-mcp")).toBeVisible();

    // No inline diagnosis + blocked file:// fetch → the empty state, never an error panel.
    await page.goto(`file://${join(SITE_DIR, "index.html")}#/diagnosis/${cellStates}`);
    await page.reload();
    await expect(page.getByTestId("diagnosis-empty")).toBeVisible();
  });

  test("lazy transcript assets degrade to a named error offline, never a blank page", async ({ page }) => {
    const { sweep } = runIds();
    const attempt = longTranscriptAttempt();
    await page.goto(`file://${join(SITE_DIR, "index.html")}#/run/${sweep}/attempt/${attempt.id}/transcript`);
    await expect(page.getByTestId("error-panel")).toBeVisible();
    await expect(page.getByTestId("error-panel")).toContainText("file://");
  });
});

test.describe("edge states", () => {
  test("schemaVersion mismatch renders the explicit banner, not a blank page", async ({ page }) => {
    await page.goto("/site-mismatch/index.html#/");
    await expect(page.getByTestId("schema-banner")).toBeVisible();
    await expect(page.getByTestId("schema-banner")).toContainText("schemaVersion 999");
  });

  test("empty data dir renders the friendly getting-started state", async ({ page }) => {
    await page.goto("/site-empty/index.html#/");
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await expect(page.getByTestId("empty-state")).toContainText("quickstudy run --eval");
  });

  test("a retired v2 cell link (three segments) shows the link-format notice on the matrix", async ({ page }) => {
    const { sweep } = runIds();
    await page.goto(`/site/index.html#/run/${sweep}/cell/seed-auth/nextjs/docs`);
    await expect(page.getByTestId("legacy-link-notice")).toBeVisible();
    await expect(page.getByTestId("matrix-view")).toBeVisible();
  });

  test("a retired #/trend link falls back to the matrix with the notice", async ({ page }) => {
    await page.goto("/site/index.html#/trend");
    await expect(page.getByTestId("legacy-link-notice")).toBeVisible();
    await expect(page.getByTestId("matrix-view")).toBeVisible();
  });
});

for (const mode of ["served", "offline"]) {
  test(`${mode}: single suites render and switching runs clears stale filters`, async ({ page }) => {
    const base = mode === "served" ? "/site-single/index.html" : `file://${join(E2E_DIR, ".fixtures/site-single/index.html")}`;
    await page.goto(`${base}#/run/regression`);
    await expect(page.getByTestId("cell-auth-nextjs-claude-docs")).toBeVisible();
    await page.getByTestId("filter-product").selectOption("regression");
    await page.getByTestId("filter-framework").selectOption("regression");
    await page.getByTestId("filter-topic").selectOption("regression");
    await page.getByTestId("run-select").selectOption("other");
    await expect(page.getByTestId("cell-auth-nextjs-claude-docs")).toBeVisible();
    await expect(page.getByTestId("filter-product")).toHaveValue("all");
    await expect(page.getByTestId("filter-framework")).toHaveValue("all");
    await expect(page.getByTestId("filter-topic")).toHaveValue("all");
    await page.reload();
    await expect(page.getByTestId("cell-auth-nextjs-claude-docs")).toBeVisible();
  });
}


test("hosted mode loads only the selected run and keeps transcript assets lazy", async ({ page }) => {
  const { sweep, cellStates } = runIds();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const started = Date.now();
  await page.goto(`/site-hosted/index.html#/run/${sweep}`);
  await expect(page.getByTestId("cell-auth-nextjs-claude-docs")).toBeVisible();
  expect(requests.some((url) => url.includes(`/runs/${sweep}/snapshots/`))).toBe(true);
  expect(requests.some((url) => url.includes(`/runs/${cellStates}/`))).toBe(false);
  expect(requests.some((url) => url.includes(".transcript.txt"))).toBe(false);
  console.log(JSON.stringify({ hostedLocalMatrixMs: Date.now() - started, requests: requests.length }));
  await page.getByTestId("run-select").selectOption(cellStates);
  await expect(page.getByTestId("cell-auth-nextjs-claude-docs")).toHaveAttribute("data-rate", "0");
  expect(requests.some((url) => url.includes(`/runs/${cellStates}/snapshots/`))).toBe(true);
});
