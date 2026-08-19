/**
 * Playwright config for the UI smoke suite. The webServer seeds fixture
 * sites (full sweep + cell-states run, schema-mismatch and empty variants)
 * through the REAL export pipeline and serves ui/e2e/.fixtures with the same
 * static server `quickstudy ui` uses — the tests exercise the exact bytes a
 * user would ship.
 *
 * Run via `bun run ui:e2e`, after `bun run ui:build` (the fixture seeder
 * needs the built bundle) and a one-time `bunx playwright install` (the
 * browsers this suite drives are a host dependency, not an npm one).
 */

import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PORT = 4519;

export default defineConfig({
  testDir: E2E_DIR,
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [["line"]],
  use: {
    baseURL: `http://127.0.0.1:${FIXTURE_PORT}`,
    screenshot: "only-on-failure",
    trace: "off",
  },
  webServer: {
    command: "bun ui/e2e/fixture-server.ts",
    cwd: join(E2E_DIR, "../.."),
    url: `http://127.0.0.1:${FIXTURE_PORT}/site/index.html`,
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
