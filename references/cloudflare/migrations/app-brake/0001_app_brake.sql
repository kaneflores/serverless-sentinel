-- Optional D1 schema reference for a reversible application brake.
-- Place this in the application-owned state store, not necessarily in the
-- sentinel ledger database.

CREATE TABLE IF NOT EXISTS app_brake (
  brake_key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  reason TEXT,
  source TEXT,
  set_at_ms INTEGER,
  expires_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);
