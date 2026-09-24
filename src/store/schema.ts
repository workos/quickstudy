/**
 * The results-store schema (v3: eval × experiment), as code.
 *
 * Inlined here (rather than read from a `schema.sql` file at runtime) so the
 * compiled single-file binary carries it in its bundle — a `readFileSync`
 * against `import.meta.dir` resolves to a path that does not exist inside the
 * binary's `$bunfs` virtual filesystem. It's small and changes rarely, so a
 * TypeScript string is the simplest portable home for it.
 */
export const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,            -- ulid
  started_at INTEGER NOT NULL,    -- epoch milliseconds
  finished_at INTEGER,            -- NULL = run incomplete; reporting warns loudly
  config_json TEXT NOT NULL,      -- selectors, trials, roots, comparison groups
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,            -- ulid
  run_id TEXT NOT NULL REFERENCES runs(id),
  eval_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  suite TEXT NOT NULL DEFAULT 'benchmark',
  trial_index INTEGER NOT NULL,
  attempt_identity_hash TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'completed' | 'incomplete' | 'error'
  result_json TEXT,               -- the scorer's EvalResult (completed attempts)
  surface_usage_json TEXT,        -- NULL = telemetry unavailable (never zero-filled)
  transcript_ref TEXT, diff_ref TEXT,
  cost_usd REAL,                  -- NULL = telemetry unavailable (never zero-filled)
  tokens_in INTEGER, tokens_out INTEGER,
  turns INTEGER,                  -- agent steps; NULL = no adapter stream (scripted commands)
  started_at INTEGER, finished_at INTEGER,
  error TEXT,                     -- only when status = 'error'
  -- Outcome taxonomy + agent-phase timing. NULL = unavailable / not applicable
  -- (rows written before these columns existed read NULL; never backfilled).
  limit_hit TEXT,                 -- 'timeout' when the agent hit its wall-clock limit and the tree it left was graded
  error_kind TEXT,                -- 'environment' | 'agent' | 'scorer' | 'harness' (status = 'error' only)
  agent_started_at INTEGER,       -- epoch ms; agent phase only
  agent_finished_at INTEGER       -- epoch ms; agent phase only
);

CREATE INDEX IF NOT EXISTS idx_attempts_run_pair ON attempts(run_id, eval_id, experiment_id);
`;
