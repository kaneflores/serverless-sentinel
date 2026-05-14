import { afterEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { __test } from './index'

const LEDGER_SCHEMA = `
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
`

let currentMiniflare: Miniflare | null = null

afterEach(async () => {
  await currentMiniflare?.dispose()
  currentMiniflare = null
})

describe('D1 ledger SQL smoke', () => {
  it('preserves first-write-wins and updates state from canonical D1 rows', async () => {
    const db = await freshLedgerDb()
    const tickWindow = __test.resolveTickWindow(5, Date.parse('2026-05-11T12:05:00Z'))

    await __test.writeLedgerTick(db, {
      seriesId: 'default-5m',
      tickWindow,
      generatedAt: '2026-05-11T12:05:01.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/first.json',
      metrics: { 'workers.requests': 100 },
      metricGapCounts: { 'workers.requests': 0 },
    })
    await __test.writeLedgerTick(db, {
      seriesId: 'default-5m',
      tickWindow,
      generatedAt: '2026-05-11T12:05:10.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/retry.json',
      metrics: { 'workers.requests': 999 },
      metricGapCounts: { 'workers.requests': 1 },
    })

    await expect(metricTick(db, tickWindow.tickId)).resolves.toMatchObject({
      delta_value: 100,
      cumulative_value: 100,
      gap_count: 0,
      cumulative_gap_count: 0,
      cumulative_recorded_tick_count: 1,
    })
    await expect(metricState(db)).resolves.toMatchObject({
      last_tick_id: tickWindow.tickId,
      cumulative_value: 100,
      cumulative_gap_count: 0,
      cumulative_recorded_tick_count: 1,
    })
  })

  it('skips metric inserts when state no longer matches the cumulative boundary row', async () => {
    const db = await freshLedgerDb()
    const tick100 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:20:00Z'))
    const tick101 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:25:00Z'))

    await __test.writeLedgerTick(db, {
      seriesId: 'default-5m',
      tickWindow: tick100,
      generatedAt: '2026-05-11T08:20:01.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/100.json',
      metrics: { 'workers.requests': 10 },
      metricGapCounts: { 'workers.requests': 0 },
    })
    await db.prepare(`
      UPDATE sentinel_metric_state
      SET last_tick_id = ?1,
          cumulative_value = 40,
          cumulative_gap_count = 0,
          cumulative_recorded_tick_count = 2
      WHERE series_id = 'default-5m' AND metric = 'workers.requests'
    `).bind(tick101.tickId + 1).run()

    await __test.writeLedgerTick(db, {
      seriesId: 'default-5m',
      tickWindow: tick101,
      generatedAt: '2026-05-11T08:25:01.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/101-raced.json',
      metrics: { 'workers.requests': 20 },
      metricGapCounts: { 'workers.requests': 0 },
    })

    await expect(metricTick(db, tick101.tickId)).resolves.toBeNull()
    await expect(metricState(db)).resolves.toMatchObject({
      last_tick_id: tick101.tickId + 1,
      cumulative_value: 40,
    })
  })
})

async function freshLedgerDb(): Promise<D1Database> {
  currentMiniflare = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response("ok") } }',
    d1Databases: ['LEDGER_DB'],
  })
  const db = await currentMiniflare.getD1Database('LEDGER_DB')
  for (const statement of LEDGER_SCHEMA.split(';').map((sql) => sql.trim()).filter(Boolean)) {
    await db.prepare(statement).run()
  }
  return db
}

async function metricTick(db: D1Database, tickId: number) {
  return db.prepare(`
    SELECT delta_value, cumulative_value, gap_count, cumulative_gap_count, cumulative_recorded_tick_count
    FROM sentinel_metric_ticks
    WHERE series_id = 'default-5m' AND metric = 'workers.requests' AND tick_id = ?1
  `).bind(tickId).first()
}

async function metricState(db: D1Database) {
  return db.prepare(`
    SELECT last_tick_id, cumulative_value, cumulative_gap_count, cumulative_recorded_tick_count
    FROM sentinel_metric_state
    WHERE series_id = 'default-5m' AND metric = 'workers.requests'
  `).first()
}
