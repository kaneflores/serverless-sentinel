-- Optional D1 schema reference for the Serverless Sentinel metric ledger.
-- Adapt table names and migration style to the target application.

CREATE TABLE IF NOT EXISTS sentinel_ledger_series (
  series_id TEXT PRIMARY KEY,
  cadence_minutes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS sentinel_ticks (
  series_id TEXT NOT NULL,
  tick_id INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  cadence_minutes INTEGER NOT NULL,
  source_snapshot_key TEXT,
  window_start_ms INTEGER NOT NULL,
  window_end_ms INTEGER NOT NULL,
  gap_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (series_id, tick_id),
  FOREIGN KEY (series_id) REFERENCES sentinel_ledger_series(series_id)
);

CREATE TABLE IF NOT EXISTS sentinel_metric_ticks (
  series_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  tick_id INTEGER NOT NULL,
  delta_value REAL NOT NULL,
  cumulative_value REAL NOT NULL,
  gap_count INTEGER NOT NULL DEFAULT 0,
  cumulative_gap_count INTEGER NOT NULL DEFAULT 0,
  cumulative_recorded_tick_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (series_id, metric, tick_id),
  FOREIGN KEY (series_id, tick_id) REFERENCES sentinel_ticks(series_id, tick_id)
);

CREATE INDEX IF NOT EXISTS sentinel_metric_ticks_tick_metric_idx
ON sentinel_metric_ticks (series_id, tick_id, metric);

CREATE TABLE IF NOT EXISTS sentinel_metric_state (
  series_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  last_tick_id INTEGER NOT NULL,
  cumulative_value REAL NOT NULL,
  cumulative_gap_count INTEGER NOT NULL DEFAULT 0,
  cumulative_recorded_tick_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (series_id, metric),
  FOREIGN KEY (series_id) REFERENCES sentinel_ledger_series(series_id)
);

CREATE TABLE IF NOT EXISTS sentinel_metric_catalog (
  metric TEXT PRIMARY KEY,
  unit TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  billable_surface TEXT,
  allowance_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
