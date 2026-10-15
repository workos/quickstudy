/goal Implement the evals.workos.tools half of "Prove the Bench" in this repo (cwd /Users/gjtorikian/workos/evals.workos.tools).

The plan is /Users/gjtorikian/workos/quickstudy/docs/ideation/prove-the-bench/hosted-site-goal.md. Read it in full first, then AGENTS.md here; both bind. Field shapes come from node_modules/@workos/quickstudy/src/report/{report,aggregate,scorer-health}.ts and src/export-types.ts (0.4.0 is installed), never from memory.

Loop:
1. Ship Group A (items 1-5: infra-failed label, one-line cost cell, metadata folded behind Details, /compare change columns greyed when any run has trials < 3 with a `trials` note, Matrix headers led by model · reasoning). Commit as one conventional commit on branch prove-the-bench/hosted.
2. Ship Group B (items 6-11: loose optional schema fields; leaderboard from experiments[].aggregate + sdk_recall sorted by discriminating pass rate with a "predates the leaderboard" note when absent; bands with uniform bands collapsed and a scorer-health callout above the tabs; "recorded, not graded" tags for graded:false checks; error-kind and timeout badges on attempts; Diagnosis clustered by (eval, failing graded checks) then target, eval-defect first at >=25%). All counts computed in workers/results.ts or workers/compare.ts; the browser only formats. Commit separately.
3. Run the validation set below. On any failure fix and rerun. Never loosen a check, never edit fixtures/routing.json, app/vendor/design-system, workers/fixes.ts, workers/findings.ts, or the Cloudflare toolchain pins. Do not implement re-export or re-report of stored runs.

Done when every line exits 0 in one pass:
- npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && npm run deploy:dry-run
- test -f fixtures/report-sample-next.json && grep -q '"schema_version": 9' fixtures/report-sample-next.json && test -f fixtures/run-sample-next.json && grep -q '"error_kind"' fixtures/run-sample-next.json
- npx vitest run --project workers workers/results.test.ts workers/compare.test.ts workers/attempts.test.ts app/lib/runFormat.test.ts app/lib/compareFormat.test.ts app/lib/resultsFormat.test.ts app/components/RunResults.test.tsx app/components/Diagnosis.test.tsx app/components/AttemptsTable.test.tsx
- grep -q 'predates the leaderboard' app/components/RunResults.test.tsx && grep -q 'infra failed' app/lib/runFormat.test.ts && grep -q 'lowTrials' workers/compare.test.ts
and fixtures/report-sample.json (schema 5) and fixtures/run-sample.json still pass every test they pass today. Leave the final command outputs in the conversation. Stop if two consecutive passes fail on identical checks and name them.
