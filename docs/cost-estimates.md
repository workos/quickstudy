# Retrospective token-cost estimates

Codex's JSONL stream reports tokens, including cached input, but not a dollar
amount. Quickstudy can estimate that missing token cost **after execution** from
saved transcripts. No agents, containers, provider calls, or API keys are needed.
Provider-reported costs remain unchanged; estimates are a separate report field.

## Supply prices at report time

Create a pricing JSON file. These are **illustrative rates, not current vendor
prices**; replace the model, dates, source URL and prices with the schedule that
applied to your run:

```json
{
  "version": "my-reviewed-rates-v1",
  "currency": "USD",
  "rates": [
    {
      "provider": "openai",
      "model": "your-exact-model-id",
      "effective_from": "2026-09-01T00:00:00Z",
      "effective_until": "2026-10-01T00:00:00Z",
      "source": "https://example.com/your-price-source",
      "input_usd_per_million": 2,
      "cached_input_usd_per_million": 0.5,
      "output_usd_per_million": 8
    }
  ]
}
```

`effective_from` is inclusive, `effective_until` exclusive and optional. Times
must be ISO 8601 with a timezone. A rate is selected by the recorded provider,
exact model ID and attempt start time (run start time for older rows without an
attempt timestamp). Overlapping intervals for a model are rejected. Rates must
be finite, non-negative USD per million tokens. `version` and `source` identify
the operator-supplied schedule; Quickstudy does not fetch or certify prices.

```bash
quickstudy report RUN_ID --pricing ./pricing.json --db ./results.db --results ./results
quickstudy export RUN_ID --out ./site --mode hosted --db ./results.db --results ./results
```

The export preserves the saved report's pricing snapshot and rechecks its source
usage. `quickstudy ui` uses the same export path. To explicitly recalculate at
export time, including a publication filtered with `--expected-trials`:

```bash
quickstudy export RUN_ID --pricing ./pricing.json --out ./site --mode hosted
```

The rates are read from disk on invocation, not baked into a binary or image.
Changing the file and repeating `report --pricing` or `export --pricing` changes
only the derived estimate. A plain `report` without `--pricing` writes the usual
reported-only report. `--strict` still checks attempt completeness/errors, not
pricing coverage.

## Retained data and coverage

You need the original `results.db` plus transcripts. A restored artifact tree
under `--results/RUN_ID/ATTEMPT_ID/transcript.jsonl` takes precedence over the
old absolute transcript reference in the database. Summary token counts alone
cannot recover cached-input usage. This command does not download hosted bundles.

For attempts without a reported cost, the calculator supports Codex thread
`turn.completed` usage and legacy cumulative `token_count` usage followed by
`task_complete`. Cached tokens are a subset of input, and reasoning tokens are
already included in output: neither is added twice. Malformed, truncated or
missing usage remains unpriced. Nonzero separate cache-write usage is currently
unsupported and remains unpriced too.

This is a **flat-rate agent token-cost estimate, not an invoice**. Use rates for
the actual service tier; tiered/context-dependent tariffs are not modeled.
Tool charges, diagnosis and infrastructure are excluded. Like existing reported
telemetry, estimates cover the report's selected attempts: superseded retries
and omitted publication pairs do not enter its subtotal. Missing usage/prices
and unsupported adapters have explicit per-attempt reasons, never zero costs.

## Report contract

Existing `telemetry.cost_usd` and `telemetry.cost_attempts` stay provider-reported.
An optional `cost_estimate` object adds:

- `cost_usd`: the estimated subtotal **in addition to** reported cost; `null`
  when nothing could be estimated, never a zero-filled total.
- `cost_attempts` / `unpriced_attempts`: estimated attempts and attempts still
  lacking either kind of cost.
- `pricing`: the complete validated rate snapshot, including version and sources.
- `attempts`: one entry for each attempt without a reported cost, with its
  `attempt_id`, estimated `cost_usd`, usage, transcript SHA-256 and `rate_index`,
  or an explicit `unpriced_reason`.

The text report and exported Report view show the estimated subtotal and coverage
separately. Repeated processing replaces the same derived report; it does not
increment costs or modify attempt records, run identity, outcomes or timestamps.
