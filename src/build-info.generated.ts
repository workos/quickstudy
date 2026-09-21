/** Populated temporarily by scripts/build-binary.ts for compiled releases. */
export const EMBEDDED_BUILD_INFO: {
  version: string;
  revision: string | null;
  dirty: boolean | null;
  sourceHash: string | null;
} = {
  // release-please's generic updater bumps this semver on the release PR
  // (the `x-release-please-version` marker anchors the replacement). It is
  // restored as-is after a binary build (scripts/build-binary.ts), so the
  // committed source `--version` stays in lockstep with package.json.
  version: "0.3.0", // x-release-please-version
  revision: null,
  dirty: null,
  sourceHash: null,
};
