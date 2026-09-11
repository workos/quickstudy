import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MACOS_GETENT = join(ROOT, "scripts/sfw-macos-getent.sh");
const RUN_ID_EXTRACTOR = join(ROOT, "scripts/ci/extract-smoke-run-id.sh");
const RELEASE_WORKFLOW = Bun.file(join(ROOT, ".github/workflows/release.yml"));

function fixtureDscacheutil(): string {
  const dir = mkdtempSync(join(tmpdir(), "qs-dscacheutil-"));
  const path = join(dir, "dscacheutil");
  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 1 ] && [ "$1" = "-flushcache" ]; then
  exit 0
fi
if [ "$#" -ne 5 ] || [ "$1" != "-q" ] || [ "$2" != "host" ] || [ "$3" != "-a" ] || [ "$4" != "name" ]; then
  echo "unsupported dscacheutil invocation: $*" >&2
  exit 64
fi
host="$5"
case "\${SFW_DSCACHEUTIL_CASE:?}" in
  public)
    printf 'name: %s\\n' "$host"
    printf 'ip_address: 104.16.0.1\\n'
    printf 'ipv6_address: 2606:4700::6810:1\\n'
    ;;
  ipv4-loopback)
    printf 'ip_address: 127.0.0.1\\n'
    ;;
  ipv6-loopback)
    printf 'ipv6_address: ::1\\n'
    ;;
  mixed)
    printf 'ip_address: 104.16.0.1\\n'
    printf 'ip_address: 127.0.0.1\\n'
    printf 'ipv6_address: 2606:4700::6810:1\\n'
    ;;
  empty)
    printf 'name: %s\\n' "$host"
    ;;
  query-failed-empty)
    exit 1
    ;;
  query-failed-partial-public)
    printf 'ip_address: 104.16.0.1\\n'
    exit 1
    ;;
  unknown-address)
    printf 'ip_address: unknown\\n'
    ;;
  malformed-address)
    printf 'ip_address: definitely-not-an-ip\\n'
    ;;
  malformed-empty-record)
    printf 'ip_address:\\n'
    ;;
  malformed-extra-fields)
    printf 'ip_address: 104.16.0.1 extra\\n'
    ;;
  *)
    echo "unknown fixture: $SFW_DSCACHEUTIL_CASE" >&2
    exit 65
    ;;
esac
`,
    { mode: 0o755 },
  );
  return path;
}

function runGetent(caseName: string, args = ["ahosts", "registry.npmjs.org"]) {
  return Bun.spawnSync(["bash", MACOS_GETENT, "__test_getent", fixtureDscacheutil(), ...args], {
    cwd: ROOT,
    env: { ...process.env, SFW_DSCACHEUTIL_CASE: caseName },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function canonicalDnsPredicateAccepts(stdout: string): boolean {
  return stdout.length > 0 && !/^(127\.|::1\s)/m.test(stdout);
}

function extractRunId(input: string) {
  const dir = mkdtempSync(join(tmpdir(), "qs-run-id-"));
  const inputPath = join(dir, "run-output.txt");
  writeFileSync(inputPath, input, "utf8");
  return Bun.spawnSync(["bash", "-c", 'bash "$1" < "$2"', "_", RUN_ID_EXTRACTOR, inputPath], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("Socket Firewall macOS getent shim", () => {
  test("formats public IPv4 and IPv6 records for the canonical predicate", () => {
    const result = runGetent("public");
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("104.16.0.1 STREAM registry.npmjs.org");
    expect(stdout).toContain("2606:4700::6810:1 STREAM registry.npmjs.org");
    expect(canonicalDnsPredicateAccepts(stdout)).toBe(true);
  });

  test("preserves loopback records so canonical teardown fails closed", () => {
    for (const caseName of ["ipv4-loopback", "ipv6-loopback", "mixed"]) {
      const result = runGetent(caseName);
      const stdout = result.stdout.toString();

      expect(result.exitCode).toBe(0);
      if (caseName === "mixed") {
        expect(stdout).toContain("104.16.0.1 STREAM registry.npmjs.org");
        expect(stdout).toContain("127.0.0.1 STREAM registry.npmjs.org");
      }
      expect(canonicalDnsPredicateAccepts(stdout)).toBe(false);
    }
  });

  test("emits no success-shaped output for query errors, empty records, or malformed records", () => {
    for (const caseName of [
      "empty",
      "query-failed-empty",
      "query-failed-partial-public",
      "unknown-address",
      "malformed-address",
      "malformed-empty-record",
      "malformed-extra-fields",
    ]) {
      const result = runGetent(caseName);
      const stdout = result.stdout.toString();

      expect(result.exitCode).not.toBe(0);
      expect(stdout).toBe("");
      expect(canonicalDnsPredicateAccepts(stdout)).toBe(false);
    }
  });

  test("rejects unsupported getent invocations", () => {
    const result = runGetent("public", ["hosts", "registry.npmjs.org"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
  });
});

describe("release workflow source wiring", () => {
  test("uses the strict source shim on both macOS release runners before teardown", async () => {
    const workflow = await RELEASE_WORKFLOW.text();

    expect(workflow).toContain("runner: macos-15-intel");
    expect(workflow).toContain("runner: macos-15");
    expect(workflow).toContain("if: ${{ always() && runner.os == 'macOS' && steps.sfw.outputs.active == 'true' }}");
    expect(workflow).toContain("run: bash scripts/sfw-macos-getent.sh install");
    expect(workflow.indexOf("run: bash scripts/sfw-macos-getent.sh install")).toBeLessThan(
      workflow.indexOf("uses: workos/setup-socket-firewall/teardown@ca93dd8aa351f54f4729fe3377a9be23c631c25d"),
    );
  });

  test("prefetches exact Bun 1.3.11 compile runtimes and passes the local executable to compile", async () => {
    const workflow = await RELEASE_WORKFLOW.text();

    for (const packageName of [
      "@oven/bun-linux-x64-baseline",
      "@oven/bun-linux-aarch64",
      "@oven/bun-darwin-x64",
      "@oven/bun-darwin-aarch64",
    ]) {
      expect(workflow).toContain(`bun_compile_package: '${packageName}'`);
    }
    expect(workflow).toContain("BUN_VERSION: '1.3.11'");
    expect(workflow).toContain("bun build --help | grep -F -- '--compile-executable-path'");
    expect(workflow).toContain('npm pack --pack-destination "$runtime_dir" "$BUN_COMPILE_PACKAGE@$BUN_VERSION"');
    expect(workflow).toContain('--compile-executable-path "$BUN_COMPILE_EXECUTABLE_PATH"');
  });

  test("the smoke parser is sourced from the checked-out helper", async () => {
    const workflow = await RELEASE_WORKFLOW.text();

    expect(workflow).toContain('bash "$GITHUB_WORKSPACE/scripts/ci/extract-smoke-run-id.sh"');
    expect(workflow).not.toContain("sed -n 's/^run ");
  });
});

describe("release smoke run-id extractor", () => {
  const id = "01M23C91HCESFPQHPJ66JSKN6P";

  test("ignores the saved run starting line and returns the actual run ID", () => {
    const result = extractRunId(`run starting: 1 attempt(s)\nrun ${id}: 1 attempts — 1 passed, 0 failed, 0 incomplete, 0 errors\n`);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(`${id}\n`);
  });

  test("rejects false positives, empty output, and ambiguous IDs", () => {
    const cases = [
      "run starting: 1 attempt(s)\n",
      "",
      `run ${id}: 1 attempts — ok\nrun 01M23C91HCESFPQHPJ66JSKN6Q: 1 attempts — ok\n`,
    ];

    for (const input of cases) {
      const result = extractRunId(input);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
    }
  });
});
