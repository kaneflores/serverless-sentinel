import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test } from './index'

type MetricRow = {
  delta_value: number
  cumulative_value: number
  gap_count: number
  cumulative_gap_count: number
  cumulative_recorded_tick_count: number
}

class FakeD1 {
  readonly series = new Map<string, { cadence_minutes: number }>()
  readonly metricTicks = new Map<string, MetricRow>()
  readonly metricState = new Map<string, {
    last_tick_id: number
    cumulative_value: number
    cumulative_gap_count: number
    cumulative_recorded_tick_count: number
  }>()
  readonly appBrake = new Map<string, { enabled: number; expires_at_ms: number | null; reason?: string }>()
  throwOnAppBrakeRead = false
  throwOnAppBrakeWrite = false
  throwOnMetricWindowScan = false
  onAppBrakeWrite?: () => void
  onBeforeMetricInsert?: () => void

  prepare(sql: string) {
    return new FakeD1Statement(this, sql)
  }

  async batch(statements: FakeD1Statement[]) {
    const results = []
    for (const statement of statements) {
      if (statement.isSelect()) {
        const row = await statement.first()
        results.push({ results: row ? [row] : [] })
      } else {
        await statement.run()
        results.push({ results: [] })
      }
    }
    return results
  }

  seedMetricTick(seriesId: string, metric: string, tickId: number, delta: number, cumulative: number, gapCount = 0) {
    const previous = latestMetricBefore(this, seriesId, metric, tickId)
    this.metricTicks.set(metricKey(seriesId, metric, tickId), {
      delta_value: delta,
      cumulative_value: cumulative,
      gap_count: gapCount,
      cumulative_gap_count: (previous?.cumulative_gap_count ?? 0) + gapCount,
      cumulative_recorded_tick_count: (previous?.cumulative_recorded_tick_count ?? 0) + 1,
    })
  }
}

class FakeD1Statement {
  private args: unknown[] = []

  constructor(private readonly db: FakeD1, private readonly sql: string) {}

  bind(...args: unknown[]) {
    this.args = args
    return this
  }

  isSelect(): boolean {
    return normalizeSql(this.sql).startsWith('select')
  }

  async first<T>(): Promise<T | null> {
    const sql = normalizeSql(this.sql)
    if (sql.includes('select cadence_minutes from sentinel_ledger_series')) {
      return (this.db.series.get(String(this.args[0])) ?? null) as T | null
    }
    if (sql.includes('select last_tick_id from sentinel_metric_state')) {
      return (this.db.metricState.get(`${String(this.args[0])}:${String(this.args[1])}`) ?? null) as T | null
    }
    if (sql.includes('select delta_value, cumulative_value, gap_count, cumulative_gap_count, cumulative_recorded_tick_count')) {
      return (this.db.metricTicks.get(metricKey(String(this.args[0]), String(this.args[1]), Number(this.args[2]))) ?? null) as T | null
    }
    if (sql.includes('from sentinel_metric_ticks') && sql.includes('tick_id < ?3') && sql.includes('order by tick_id desc')) {
      const entry = latestMetricEntry(this.db, String(this.args[0]), String(this.args[1]), (candidate) => candidate < Number(this.args[2]))
      return (entry ? { tick_id: entry.tickId, ...cumulativeProjection(entry.row) } : null) as T | null
    }
    if (sql.includes('from sentinel_metric_ticks') && sql.includes('tick_id <= ?3') && sql.includes('order by tick_id desc')) {
      const row = latestMetricAtOrBefore(this.db, String(this.args[0]), String(this.args[1]), Number(this.args[2]))
      return (row ? cumulativeProjection(row) : null) as T | null
    }
    if (sql.includes('select count(*) as availableticks')) {
      if (this.db.throwOnMetricWindowScan) {
        throw new Error('metric window scan should not be used')
      }
      const rows = metricRowsBetween(this.db, String(this.args[0]), String(this.args[1]), Number(this.args[2]), Number(this.args[3]))
      return {
        availableTicks: rows.length,
        gapCount: rows.reduce((sum, row) => sum + row.gap_count, 0),
      } as T
    }
    if (sql.includes('coalesce(sum(delta_value), 0) as actual')) {
      const rows = metricRowsBetween(this.db, String(this.args[0]), String(this.args[1]), Number(this.args[2]), Number(this.args[3]))
      return {
        actual: rows.reduce((sum, row) => sum + row.delta_value, 0),
        availableTicks: rows.length,
        gapCount: rows.reduce((sum, row) => sum + row.gap_count, 0),
      } as T
    }
    if (sql.includes('select min(tick_id) as firsttickid')) {
      const firstTickId = firstMetricAtOrBefore(this.db, String(this.args[0]), String(this.args[1]), Number(this.args[2]))
      return { firstTickId } as T
    }
    if (sql.startsWith('select') && sql.includes('from app_brake')) {
      if (this.db.throwOnAppBrakeRead) {
        throw new Error('app brake read failed')
      }
      const row = this.db.appBrake.get(String(this.args[0]))
      const nowMs = Number(this.args[1])
      return (row?.enabled === 1 && (row.expires_at_ms === null || row.expires_at_ms > nowMs)
        ? { brake_key: this.args[0], reason: row.reason }
        : null) as T | null
    }
    throw new Error(`unsupported D1 first query: ${sql}`)
  }

  async run(): Promise<{ success: true }> {
    const sql = normalizeSql(this.sql)
    if (sql.includes('insert into sentinel_ledger_series')) {
      const seriesId = String(this.args[0])
      if (!this.db.series.has(seriesId)) {
        this.db.series.set(seriesId, { cadence_minutes: Number(this.args[1]) })
      }
      return { success: true }
    }
    if (sql.includes('insert or ignore into sentinel_ticks')) {
      return { success: true }
    }
    if (sql.includes('insert or ignore into sentinel_metric_ticks')) {
      const key = metricKey(String(this.args[0]), String(this.args[1]), Number(this.args[2]))
      this.db.onBeforeMetricInsert?.()
      this.db.onBeforeMetricInsert = undefined
      const state = this.db.metricState.get(`${String(this.args[0])}:${String(this.args[1])}`)
      const stale = state !== undefined && Number(this.args[2]) < state.last_tick_id
      const previousTickId = this.args[8] === null ? null : Number(this.args[8])
      const stateMatchesBoundary =
        (previousTickId === null && state === undefined) ||
        state?.last_tick_id === previousTickId ||
        this.db.metricTicks.has(key)
      if (!stale && stateMatchesBoundary && !this.db.metricTicks.has(key)) {
        this.db.metricTicks.set(key, {
          delta_value: Number(this.args[3]),
          cumulative_value: Number(this.args[4]),
          gap_count: Number(this.args[5]),
          cumulative_gap_count: Number(this.args[6]),
          cumulative_recorded_tick_count: Number(this.args[7]),
        })
      }
      return { success: true }
    }
    if (sql.includes('insert into sentinel_metric_ticks')) {
      this.db.metricTicks.set(metricKey(String(this.args[0]), String(this.args[1]), Number(this.args[2])), {
        delta_value: Number(this.args[3]),
        cumulative_value: Number(this.args[4]),
        gap_count: Number(this.args[5]),
        cumulative_gap_count: Number(this.args[6]),
        cumulative_recorded_tick_count: Number(this.args[7]),
      })
      return { success: true }
    }
    if (sql.includes('insert into sentinel_metric_state')) {
      const key = `${String(this.args[0])}:${String(this.args[1])}`
      if (sql.includes('from sentinel_metric_ticks')) {
        const canonical = this.db.metricTicks.get(metricKey(String(this.args[0]), String(this.args[1]), Number(this.args[2])))
        if (!canonical) {
          return { success: true }
        }
        const existing = this.db.metricState.get(key)
        const next = {
          last_tick_id: Number(this.args[2]),
          cumulative_value: canonical.cumulative_value,
          cumulative_gap_count: canonical.cumulative_gap_count,
          cumulative_recorded_tick_count: canonical.cumulative_recorded_tick_count,
        }
        if (!existing || next.last_tick_id >= existing.last_tick_id) {
          this.db.metricState.set(key, next)
        }
        return { success: true }
      }
      const existing = this.db.metricState.get(key)
      const next = {
        last_tick_id: Number(this.args[2]),
        cumulative_value: Number(this.args[3]),
        cumulative_gap_count: Number(this.args[4]),
        cumulative_recorded_tick_count: Number(this.args[5]),
      }
      if (!existing || next.last_tick_id >= existing.last_tick_id) {
        this.db.metricState.set(key, next)
      }
      return { success: true }
    }
    if (sql.includes('insert into app_brake')) {
      if (this.db.throwOnAppBrakeWrite) {
        throw new Error('app brake write failed')
      }
      this.db.onAppBrakeWrite?.()
      const brakeKey = String(this.args[0])
      const existing = this.db.appBrake.get(brakeKey)
      const nowMs = Number(this.args[4] ?? this.args[2])
      const mayWrite = !existing || existing.enabled === 0 || (existing.expires_at_ms !== null && existing.expires_at_ms <= nowMs)
      if (mayWrite) {
        this.db.appBrake.set(brakeKey, {
          enabled: 1,
          reason: String(this.args[1]),
          expires_at_ms: this.args[3] === null ? null : Number(this.args[3]),
        })
      }
      return { success: true }
    }
    throw new Error(`unsupported D1 run query: ${sql}`)
  }
}

class FakeR2 {
  readonly puts: Array<{ key: string; body: string }> = []
  throwOnPut = false
  throwOnPutKeyPattern: string | null = null

  async put(key: string, value: string): Promise<void> {
    if (this.throwOnPut || (this.throwOnPutKeyPattern && key.includes(this.throwOnPutKeyPattern))) {
      throw new Error('R2 put failed')
    }
    this.puts.push({ key, body: value })
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('tick windows', () => {
  it('aligns collection windows to fixed cadence boundaries', () => {
    const scheduledTime = Date.parse('2026-05-11T12:05:17Z')
    const window = __test.resolveTickWindow(5, scheduledTime)

    expect(window.windowStart.toISOString()).toBe('2026-05-11T12:00:00.000Z')
    expect(window.windowEnd.toISOString()).toBe('2026-05-11T12:05:00.000Z')
    expect(window.tickId).toBe(Math.floor(Date.parse('2026-05-11T12:05:00Z') / (5 * 60_000)))
  })
})

describe('ledger rolling usage', () => {
  it('keeps same-tick writes append-once so cumulative math stays stable', async () => {
    const db = new FakeD1()
    const tickWindow = __test.resolveTickWindow(5, Date.parse('2026-05-11T12:05:00Z'))

    await __test.writeLedgerTick(db as never, {
      seriesId: 'default-5m',
      tickWindow,
      generatedAt: '2026-05-11T12:05:01.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/first.json',
      metrics: { 'workers.requests': 100 },
      metricGapCounts: { 'workers.requests': 0 },
    })
    await __test.writeLedgerTick(db as never, {
      seriesId: 'default-5m',
      tickWindow,
      generatedAt: '2026-05-11T12:05:10.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/retry.json',
      metrics: { 'workers.requests': 999 },
      metricGapCounts: { 'workers.requests': 0 },
    })

    const usage = await __test.queryWindowUsage(db as never, 'default-5m', 'workers.requests', tickWindow.tickId, 1)

    expect(usage.actual).toBe(100)
    expect(db.metricTicks.get(metricKey('default-5m', 'workers.requests', tickWindow.tickId))?.delta_value).toBe(100)
    expect(db.metricState.get('default-5m:workers.requests')).toMatchObject({
      last_tick_id: tickWindow.tickId,
      cumulative_value: 100,
      cumulative_gap_count: 0,
      cumulative_recorded_tick_count: 1,
    })
  })

  it('skips delayed older ticks so out-of-order writes cannot corrupt cumulative rows', async () => {
    const db = new FakeD1()
    const tick100 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:20:00Z'))
    const tick101 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:25:00Z'))
    const tick102 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:30:00Z'))
    const tick103 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:35:00Z'))

    await __test.writeLedgerTick(db as never, {
      seriesId: 'default-5m',
      tickWindow: tick100,
      generatedAt: '2026-05-11T08:20:01.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/100.json',
      metrics: { 'workers.requests': 10 },
      metricGapCounts: { 'workers.requests': 0 },
    })
    await __test.writeLedgerTick(db as never, {
      seriesId: 'default-5m',
      tickWindow: tick102,
      generatedAt: '2026-05-11T08:30:01.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/102.json',
      metrics: { 'workers.requests': 30 },
      metricGapCounts: { 'workers.requests': 0 },
    })
    await __test.writeLedgerTick(db as never, {
      seriesId: 'default-5m',
      tickWindow: tick101,
      generatedAt: '2026-05-11T08:25:30.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/101-delayed.json',
      metrics: { 'workers.requests': 20 },
      metricGapCounts: { 'workers.requests': 0 },
    })
    await __test.writeLedgerTick(db as never, {
      seriesId: 'default-5m',
      tickWindow: tick103,
      generatedAt: '2026-05-11T08:35:01.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/103.json',
      metrics: { 'workers.requests': 40 },
      metricGapCounts: { 'workers.requests': 0 },
    })

    expect(db.metricTicks.has(metricKey('default-5m', 'workers.requests', tick101.tickId))).toBe(false)
    expect(db.metricTicks.get(metricKey('default-5m', 'workers.requests', tick103.tickId))).toMatchObject({
      delta_value: 40,
      cumulative_value: 80,
      cumulative_recorded_tick_count: 3,
    })
    await expect(__test.queryWindowUsage(db as never, 'default-5m', 'workers.requests', tick103.tickId, 4)).resolves.toMatchObject({
      actual: 80,
      availableTicks: 3,
      missingTicks: 1,
    })
  })

  it('rejects an older adjacent tick if state advanced before the insert boundary', async () => {
    const db = new FakeD1()
    const tick100 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:20:00Z'))
    const tick101 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:25:00Z'))
    const tick102 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:30:00Z'))

    await __test.writeLedgerTick(db as never, {
      seriesId: 'default-5m',
      tickWindow: tick100,
      generatedAt: '2026-05-11T08:20:01.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/100.json',
      metrics: { 'workers.requests': 10 },
      metricGapCounts: { 'workers.requests': 0 },
    })
    db.metricState.set('default-5m:workers.requests', {
      last_tick_id: tick102.tickId,
      cumulative_value: 40,
      cumulative_gap_count: 0,
      cumulative_recorded_tick_count: 2,
    })

    await __test.writeLedgerTick(db as never, {
      seriesId: 'default-5m',
      tickWindow: tick101,
      generatedAt: '2026-05-11T08:25:30.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/101-raced.json',
      metrics: { 'workers.requests': 20 },
      metricGapCounts: { 'workers.requests': 0 },
    })

    expect(db.metricTicks.has(metricKey('default-5m', 'workers.requests', tick101.tickId))).toBe(false)
    expect(db.metricState.get('default-5m:workers.requests')).toMatchObject({ last_tick_id: tick102.tickId })
  })

  it('skips a newer tick when an older adjacent tick advances state after the boundary read', async () => {
    const db = new FakeD1()
    const tick100 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:20:00Z'))
    const tick101 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:25:00Z'))
    const tick102 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:30:00Z'))

    await __test.writeLedgerTick(db as never, {
      seriesId: 'default-5m',
      tickWindow: tick100,
      generatedAt: '2026-05-11T08:20:01.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/100.json',
      metrics: { 'workers.requests': 10 },
      metricGapCounts: { 'workers.requests': 0 },
    })
    db.onBeforeMetricInsert = () => {
      db.metricTicks.set(metricKey('default-5m', 'workers.requests', tick101.tickId), {
        delta_value: 20,
        cumulative_value: 30,
        gap_count: 0,
        cumulative_gap_count: 0,
        cumulative_recorded_tick_count: 2,
      })
      db.metricState.set('default-5m:workers.requests', {
        last_tick_id: tick101.tickId,
        cumulative_value: 30,
        cumulative_gap_count: 0,
        cumulative_recorded_tick_count: 2,
      })
    }

    await __test.writeLedgerTick(db as never, {
      seriesId: 'default-5m',
      tickWindow: tick102,
      generatedAt: '2026-05-11T08:30:01.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/102-raced.json',
      metrics: { 'workers.requests': 30 },
      metricGapCounts: { 'workers.requests': 0 },
    })

    expect(db.metricTicks.has(metricKey('default-5m', 'workers.requests', tick102.tickId))).toBe(false)
    expect(db.metricState.get('default-5m:workers.requests')).toMatchObject({
      last_tick_id: tick101.tickId,
      cumulative_value: 30,
    })
  })

  it('preserves a same-tick first write when state has already advanced beyond that tick', async () => {
    const db = new FakeD1()
    const tick101 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:25:00Z'))
    const tick102 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:30:00Z'))
    db.metricTicks.set(metricKey('default-5m', 'workers.requests', tick101.tickId), {
      delta_value: 20,
      cumulative_value: 30,
      gap_count: 0,
      cumulative_gap_count: 0,
      cumulative_recorded_tick_count: 2,
    })
    db.metricState.set('default-5m:workers.requests', {
      last_tick_id: tick102.tickId,
      cumulative_value: 60,
      cumulative_gap_count: 0,
      cumulative_recorded_tick_count: 3,
    })

    await __test.writeLedgerTick(db as never, {
      seriesId: 'default-5m',
      tickWindow: tick101,
      generatedAt: '2026-05-11T08:25:30.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/101-retry.json',
      metrics: { 'workers.requests': 999 },
      metricGapCounts: { 'workers.requests': 1 },
    })

    expect(db.metricTicks.get(metricKey('default-5m', 'workers.requests', tick101.tickId))).toMatchObject({
      delta_value: 20,
      cumulative_value: 30,
      gap_count: 0,
    })
    expect(db.metricState.get('default-5m:workers.requests')).toMatchObject({
      last_tick_id: tick102.tickId,
      cumulative_value: 60,
    })
  })

  it('does not restart cumulative math when metric state exists but no prior metric row is visible', async () => {
    const db = new FakeD1()
    const tick101 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:25:00Z'))
    db.metricState.set('default-5m:workers.requests', {
      last_tick_id: tick101.tickId - 1,
      cumulative_value: 10,
      cumulative_gap_count: 0,
      cumulative_recorded_tick_count: 1,
    })

    await __test.writeLedgerTick(db as never, {
      seriesId: 'default-5m',
      tickWindow: tick101,
      generatedAt: '2026-05-11T08:25:01.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/101-after-unsafe-prune.json',
      metrics: { 'workers.requests': 20 },
      metricGapCounts: { 'workers.requests': 0 },
    })

    expect(db.metricTicks.has(metricKey('default-5m', 'workers.requests', tick101.tickId))).toBe(false)
    expect(db.metricState.get('default-5m:workers.requests')).toMatchObject({
      last_tick_id: tick101.tickId - 1,
      cumulative_value: 10,
    })
  })

  it('uses cumulative recorded tick and gap counters instead of scanning the full metric window', async () => {
    const db = new FakeD1()
    db.seedMetricTick('series', 'workers.requests', 100, 10, 10)
    db.seedMetricTick('series', 'workers.requests', 101, 0, 10, 1)
    db.seedMetricTick('series', 'workers.requests', 102, 30, 40)
    db.throwOnMetricWindowScan = true

    await expect(__test.queryWindowUsage(db as never, 'series', 'workers.requests', 102, 3)).resolves.toMatchObject({
      actual: 40,
      availableTicks: 3,
      gapCount: 1,
      missingTicks: 0,
    })
  })

  it('subtracts cumulative boundaries for adjacent rolling windows', async () => {
    const db = new FakeD1()
    db.seedMetricTick('series', 'workers.requests', 100, 10, 10)
    db.seedMetricTick('series', 'workers.requests', 101, 20, 30)
    db.seedMetricTick('series', 'workers.requests', 102, 30, 60)

    await expect(__test.queryWindowUsage(db as never, 'series', 'workers.requests', 102, 2)).resolves.toMatchObject({
      actual: 50,
      availableTicks: 2,
      missingTicks: 0,
    })
    await expect(__test.queryWindowUsage(db as never, 'series', 'workers.requests', 102, 3)).resolves.toMatchObject({
      actual: 60,
      availableTicks: 3,
      missingTicks: 0,
    })
  })

  it('falls back to bounded sums when the cumulative boundary row was pruned', async () => {
    const completeDb = new FakeD1()
    completeDb.seedMetricTick('series', 'workers.requests', 100, 10, 10)
    completeDb.seedMetricTick('series', 'workers.requests', 101, 20, 30)
    completeDb.seedMetricTick('series', 'workers.requests', 102, 30, 60)
    await expect(__test.queryWindowUsage(completeDb as never, 'series', 'workers.requests', 102, 2)).resolves.toMatchObject({
      actual: 50,
    })

    const prunedBoundaryDb = new FakeD1()
    prunedBoundaryDb.seedMetricTick('series', 'workers.requests', 101, 20, 30)
    prunedBoundaryDb.seedMetricTick('series', 'workers.requests', 102, 30, 60)
    prunedBoundaryDb.metricTicks.set(metricKey('series', 'workers.requests', 101), {
      ...prunedBoundaryDb.metricTicks.get(metricKey('series', 'workers.requests', 101))!,
      cumulative_gap_count: 0,
      cumulative_recorded_tick_count: 2,
    })
    prunedBoundaryDb.metricTicks.set(metricKey('series', 'workers.requests', 102), {
      ...prunedBoundaryDb.metricTicks.get(metricKey('series', 'workers.requests', 102))!,
      cumulative_gap_count: 0,
      cumulative_recorded_tick_count: 3,
    })
    await expect(__test.queryWindowUsage(prunedBoundaryDb as never, 'series', 'workers.requests', 102, 2)).resolves.toMatchObject({
      actual: 50,
      availableTicks: 2,
      source: 'd1_ledger_bounded_sum_fallback',
    })
  })

  it('reports complete freshness only when every tick in the requested window is retained', async () => {
    const db = new FakeD1()
    db.seedMetricTick('series', 'workers.requests', 100, 10, 10)
    db.seedMetricTick('series', 'workers.requests', 102, 30, 40)

    const policy = await __test.evaluateBudgetRules({
      rules: [
        {
          id: 'complete-window',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 3,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'complete',
          kind: 'absolute_units',
          max: 1,
        },
      ],
      allowances: {},
      db: db as never,
      seriesId: 'series',
      endTickId: 102,
      generatedAt: '2026-05-11T12:05:00.000Z',
      cadenceMinutes: 5,
      currentMetrics: { 'workers.requests': 1 },
      metricScopes: { 'workers.requests': 'configured_scripts' },
      currentDeltaMetricNames: new Set(["workers.requests"]),
      gaps: [],
      actionBlockingGaps: [],
    })

    expect(policy.evaluatedRules).toBe(0)
    expect(policy.actionBlockingGaps).toContain('rule complete-window requires complete freshness but only 2/3 ticks are available')
    expect(policy.brakeCandidates).toEqual([])
  })

  it('blocks complete-freshness action when a delayed older tick was skipped', async () => {
    const db = new FakeD1()
    const tick100 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:20:00Z'))
    const tick101 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:25:00Z'))
    const tick102 = __test.resolveTickWindow(5, Date.parse('2026-05-11T08:30:00Z'))

    await __test.writeLedgerTick(db as never, {
      seriesId: 'default-5m',
      tickWindow: tick100,
      generatedAt: '2026-05-11T08:20:01.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/100.json',
      metrics: { 'workers.requests': 10 },
      metricGapCounts: { 'workers.requests': 0 },
    })
    await __test.writeLedgerTick(db as never, {
      seriesId: 'default-5m',
      tickWindow: tick102,
      generatedAt: '2026-05-11T08:30:01.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/102.json',
      metrics: { 'workers.requests': 100 },
      metricGapCounts: { 'workers.requests': 0 },
    })
    await __test.writeLedgerTick(db as never, {
      seriesId: 'default-5m',
      tickWindow: tick101,
      generatedAt: '2026-05-11T08:25:30.000Z',
      cadenceMinutes: 5,
      sourceSnapshotKey: 'snapshots/101-delayed.json',
      metrics: { 'workers.requests': 20 },
      metricGapCounts: { 'workers.requests': 0 },
    })

    const completePolicy = await __test.evaluateBudgetRules({
      rules: [
        {
          id: 'complete-out-of-order',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 3,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'complete',
          kind: 'absolute_units',
          max: 1,
        },
      ],
      allowances: {},
      db: db as never,
      seriesId: 'default-5m',
      endTickId: tick102.tickId,
      generatedAt: '2026-05-11T08:30:01.000Z',
      cadenceMinutes: 5,
      currentMetrics: { 'workers.requests': 100 },
      metricScopes: { 'workers.requests': 'configured_scripts' },
      currentDeltaMetricNames: new Set(["workers.requests"]),
      gaps: [],
      actionBlockingGaps: [],
    })
    const partialPolicy = await __test.evaluateBudgetRules({
      rules: [
        {
          id: 'partial-out-of-order',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 3,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 50,
        },
      ],
      allowances: {},
      db: db as never,
      seriesId: 'default-5m',
      endTickId: tick102.tickId,
      generatedAt: '2026-05-11T08:30:01.000Z',
      cadenceMinutes: 5,
      currentMetrics: { 'workers.requests': 100 },
      metricScopes: { 'workers.requests': 'configured_scripts' },
      currentDeltaMetricNames: new Set(["workers.requests"]),
      gaps: [],
      actionBlockingGaps: [],
    })

    expect(completePolicy.evaluatedRules).toBe(0)
    expect(completePolicy.actionBlockingGaps).toContain('rule complete-out-of-order requires complete freshness but only 2/3 ticks are available')
    expect(completePolicy.brakeCandidates).toEqual([])
    expect(partialPolicy.brakeCandidates).toEqual(['partial-out-of-order'])
  })

  it('distinguishes startup partial windows from interior missing ticks', async () => {
    const startupDb = new FakeD1()
    startupDb.seedMetricTick('series', 'workers.requests', 102, 30, 30)
    await expect(__test.queryWindowUsage(startupDb as never, 'series', 'workers.requests', 102, 3)).resolves.toMatchObject({
      availableTicks: 1,
      missingTicks: 0,
    })

    const missingDb = new FakeD1()
    missingDb.seedMetricTick('series', 'workers.requests', 100, 10, 10)
    missingDb.seedMetricTick('series', 'workers.requests', 102, 30, 40)
    await expect(__test.queryWindowUsage(missingDb as never, 'series', 'workers.requests', 102, 3)).resolves.toMatchObject({
      availableTicks: 2,
      missingTicks: 1,
    })
  })

  it('rejects writes that reuse a ledger series with a different cadence', async () => {
    const db = new FakeD1()
    db.series.set('default-5m', { cadence_minutes: 5 })
    const tickWindow = __test.resolveTickWindow(2, Date.parse('2026-05-11T12:06:00Z'))

    await expect(__test.writeLedgerTick(db as never, {
      seriesId: 'default-5m',
      tickWindow,
      generatedAt: '2026-05-11T12:06:01.000Z',
      cadenceMinutes: 2,
      sourceSnapshotKey: 'snapshots/cadence-mismatch.json',
      metrics: { 'workers.requests': 1 },
      metricGapCounts: { 'workers.requests': 0 },
    })).rejects.toThrow('ledger series default-5m uses cadence 5, not 2')

    expect(db.metricTicks.size).toBe(0)
  })
})

describe('budget policy evaluation', () => {
  it('allows actual-usage rules to brake on observed partial usage even with interior missing ticks', async () => {
    const db = new FakeD1()
    db.seedMetricTick('series', 'workers.requests', 100, 10, 10)
    db.seedMetricTick('series', 'workers.requests', 102, 30, 40)

    const policy = await __test.evaluateBudgetRules({
      rules: [
        {
          id: 'actual-across-hole',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 3,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 20,
        },
      ],
      allowances: {},
      db: db as never,
      seriesId: 'series',
      endTickId: 102,
      generatedAt: '2026-05-11T12:05:00.000Z',
      cadenceMinutes: 5,
      currentMetrics: { 'workers.requests': 1 },
      metricScopes: { 'workers.requests': 'configured_scripts' },
      currentDeltaMetricNames: new Set(["workers.requests"]),
      gaps: [],
      actionBlockingGaps: [],
    })

    expect(policy.brakeCandidates).toEqual(['actual-across-hole'])
  })

  it('rejects invalid optional safety fields instead of softening gates', () => {
    const gaps: string[] = []
    const rules = __test.parseBudgetRules(JSON.stringify([
      {
        id: 'bad-freshness',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
        windowTicks: 1,
        level: 'critical',
        actionMode: 'eligible_after_gates',
        requiredFreshness: 'complet',
        kind: 'absolute_units',
        max: 10,
      },
      {
        id: 'unsupported-projection',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
        windowTicks: 1,
        level: 'critical',
        actionMode: 'eligible_after_gates',
        kind: 'projected_allowance_exhaustion',
        allowancePeriod: 'monthly',
        maxProjectedFraction: 0.01,
        projectionHorizonHours: 1,
      },
    ]), gaps)

    expect(rules).toEqual([])
    expect(gaps).toContain('budget rule at index 0 has invalid requiredFreshness')
    expect(gaps).toContain('budget rule at index 1 is not supported by the reference implementation Worker')
  })

  it('requires requiredFreshness on every budget rule', () => {
    const gaps: string[] = []
    const rules = __test.parseBudgetRules(JSON.stringify([
      {
        id: 'missing-freshness-action',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
        windowTicks: 1,
        level: 'critical',
        actionMode: 'eligible_after_gates',
        kind: 'absolute_units',
        max: 10,
      },
      {
        id: 'missing-freshness-observe',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
        windowTicks: 1,
        level: 'warn',
        actionMode: 'observe_only',
        kind: 'absolute_units',
        max: 10,
      },
    ]), gaps)

    expect(rules).toEqual([])
    expect(gaps).toContain('budget rule at index 0 is missing requiredFreshness')
    expect(gaps).toContain('budget rule at index 1 is missing requiredFreshness')
  })

  it('requires metricScope on Worker metric rules', () => {
    const gaps: string[] = []
    const rules = __test.parseBudgetRules(JSON.stringify([
      {
        id: 'missing-worker-scope',
        metric: 'workers.requests',
        windowTicks: 1,
        level: 'critical',
        actionMode: 'eligible_after_gates',
        requiredFreshness: 'allow_partial',
        kind: 'absolute_units',
        max: 10,
      },
    ]), gaps)

    expect(rules).toEqual([])
    expect(gaps).toContain('budget rule at index 0 is missing metricScope for Worker metric workers.requests')
  })

  it('does not evaluate or brake when action-eligible freshness is omitted', async () => {
    const gaps: string[] = []
    const rules = __test.parseBudgetRules(JSON.stringify([
      {
        id: 'missing-freshness-action',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
        windowTicks: 1,
        level: 'critical',
        actionMode: 'eligible_after_gates',
        kind: 'absolute_units',
        max: 10,
      },
    ]), gaps)
    const policy = await __test.evaluateBudgetRules({
      rules,
      allowances: {},
      seriesId: 'series',
      endTickId: 100,
      generatedAt: '2026-05-11T12:05:00.000Z',
      cadenceMinutes: 5,
      currentMetrics: { 'workers.requests': 100 },
      metricScopes: { 'workers.requests': 'configured_scripts' },
      currentDeltaMetricNames: new Set(['workers.requests']),
      gaps,
      actionBlockingGaps: [],
    })

    expect(policy.evaluatedRules).toBe(0)
    expect(policy.brakeCandidates).toEqual([])
    expect(policy.gaps).toContain('budget rule at index 0 is missing requiredFreshness')
  })

  it('requires D1 for action-eligible multi-tick windows unless explicitly allowed', async () => {
    const policy = await __test.evaluateBudgetRules({
      rules: [
        {
          id: 'multi-tick-without-ledger',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 12,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 10,
        },
      ],
      allowances: {},
      seriesId: 'series',
      endTickId: 100,
      generatedAt: '2026-05-11T12:05:00.000Z',
      cadenceMinutes: 5,
      currentMetrics: { 'workers.requests': 100 },
      metricScopes: { 'workers.requests': 'configured_scripts' },
      currentDeltaMetricNames: new Set(["workers.requests"]),
      gaps: [],
      actionBlockingGaps: [],
    })

    expect(policy.violations[0]).toMatchObject({ actionBlocked: true })
    expect(policy.brakeCandidates).toEqual([])
  })

  it('propagates current-tick lower-bound gaps when the D1 ledger is unavailable', async () => {
    const policy = await __test.evaluateBudgetRules({
      rules: [
        {
          id: 'complete-current-gap',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'complete',
          kind: 'absolute_units',
          max: 10,
        },
      ],
      allowances: {},
      seriesId: 'series',
      endTickId: 100,
      generatedAt: '2026-05-11T12:05:00.000Z',
      cadenceMinutes: 5,
      currentMetrics: { 'workers.requests': 100 },
      currentMetricGapCounts: { 'workers.requests': 1 },
      metricScopes: { 'workers.requests': 'configured_scripts' },
      currentDeltaMetricNames: new Set(["workers.requests"]),
      gaps: [],
      actionBlockingGaps: [],
    })

    expect(policy.violations[0]).toMatchObject({ ruleId: 'complete-current-gap', actionBlocked: true })
    expect(policy.brakeCandidates).toEqual([])
    expect(policy.gaps).toContain('rule complete-current-gap has 1 lower-bound ledger gap(s) in its evaluated window')
  })

  it('does not treat unsupported policy metrics as zero-usage protection', async () => {
    const gaps: string[] = []
    const policy = await __test.evaluateBudgetRules({
      rules: [
        {
          id: 'uncollected-d1-writes',
          metric: 'd1.rowsWritten',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ],
      allowances: {},
      seriesId: 'series',
      endTickId: 100,
      generatedAt: '2026-05-11T12:05:00.000Z',
      cadenceMinutes: 5,
      currentMetrics: { 'workers.requests': 100 },
      metricScopes: { 'workers.requests': 'configured_scripts' },
      currentDeltaMetricNames: new Set(['workers.requests']),
      gaps,
      actionBlockingGaps: [],
    })

    const expectedGap = 'rule uncollected-d1-writes metric d1.rowsWritten was not collected as an additive delta in this run'
    expect(policy.evaluatedRules).toBe(0)
    expect(policy.brakeCandidates).toEqual([])
    expect(policy.gaps).toContain(expectedGap)
    expect(policy.actionBlockingGaps).toContain(expectedGap)
  })
})

describe('metric collection and run ordering', () => {
  it('records failed GraphQL reads as zero-value delta metrics with per-metric gap counts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down')
    }))

    const metrics = await __test.collectWorkerMetrics({
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
    } as never, new Date('2026-05-11T12:00:00Z'), new Date('2026-05-11T12:05:00Z'))

    expect(metrics.deltas).toEqual({
      'workers.requests': 0,
      'workers.errors': 0,
      'workers.subrequests': 0,
    })
    expect(metrics.deltaGapCounts).toEqual({
      'workers.requests': 1,
      'workers.errors': 1,
      'workers.subrequests': 1,
    })
    expect(metrics.actionBlockingGaps).toContain('Worker GraphQL metrics failed for script app-worker: network down')
  })

  it('persists GraphQL source failures as durable per-metric ledger gap rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down')
    }))
    const db = new FakeD1()
    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: new FakeR2(),
      LEDGER_DB: db,
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-one-tick',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      APP_BRAKE_DB: new FakeD1(),
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    const tickId = __test.resolveTickWindow(5, Date.parse('2026-05-11T12:05:00Z')).tickId
    expect(db.metricTicks.get(metricKey('default-5m', 'workers.requests', tickId))).toMatchObject({
      delta_value: 0,
      cumulative_value: 0,
      gap_count: 1,
      cumulative_gap_count: 1,
      cumulative_recorded_tick_count: 1,
    })
    expect(db.metricTicks.get(metricKey('default-5m', 'workers.errors', tickId))).toMatchObject({
      delta_value: 0,
      gap_count: 1,
    })
    expect(snapshot.policy.violations).toEqual([])
    expect(snapshot.policy.actionBlockingGaps).toContain('Worker GraphQL metrics failed for script app-worker: network down')
    expect(snapshot.actions.taken).toEqual([])
  })

  it('keeps valid GraphQL rows as lower-bound evidence when another row is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphqlResponse([
      { sum: { requests: 100, errors: 0, subrequests: 0 } },
      { sum: { requests: 5 } },
    ])))
    const db = new FakeD1()
    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: new FakeR2(),
      LEDGER_DB: db,
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-one-tick',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 50,
        },
      ]),
      SENTINEL_MODE: 'protect',
      APP_BRAKE_DB: new FakeD1(),
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    const tickId = __test.resolveTickWindow(5, Date.parse('2026-05-11T12:05:00Z')).tickId
    expect(db.metricTicks.get(metricKey('default-5m', 'workers.requests', tickId))).toMatchObject({
      delta_value: 100,
      gap_count: 1,
      cumulative_gap_count: 1,
    })
    expect(snapshot.policy.gaps.some((gap) => gap.includes('malformed row'))).toBe(true)
    expect(snapshot.policy.gaps).toContain('rule workers-one-tick has 1 lower-bound ledger gap(s) in its evaluated window')
    expect(snapshot.policy.violations[0]).toMatchObject({
      ruleId: 'workers-one-tick',
      actual: 100,
      actionBlocked: undefined,
    })
    expect(snapshot.policy.brakeCandidates).toEqual(['workers-one-tick'])
    expect(snapshot.actions.taken).toEqual([{ status: 'written', brakeKey: 'global', candidateRuleIds: ['workers-one-tick'] }])
  })

  it('blocks complete-freshness action candidates when malformed rows create lower-bound gaps', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphqlResponse([
      { sum: { requests: 100, errors: 0, subrequests: 0 } },
      { sum: { requests: 5 } },
    ])))
    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: new FakeR2(),
      LEDGER_DB: new FakeD1(),
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-one-tick-complete',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'complete',
          kind: 'absolute_units',
          max: 50,
        },
      ]),
      SENTINEL_MODE: 'protect',
      APP_BRAKE_DB: new FakeD1(),
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.policy.violations[0]).toMatchObject({
      ruleId: 'workers-one-tick-complete',
      actionBlocked: true,
    })
    expect(snapshot.policy.brakeCandidates).toEqual([])
    expect(snapshot.actions.taken).toEqual([])
  })

  it('keeps successful script rows as lower-bound evidence when another script query fails', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { scriptName?: string } }
      if (body.variables?.scriptName === 'worker-b') {
        return new Response('unavailable', { status: 500 })
      }
      return graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])
    })
    vi.stubGlobal('fetch', fetchMock)
    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: new FakeR2(),
      LEDGER_DB: new FakeD1(),
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'worker-a,worker-b',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-partial-script',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 50,
        },
      ]),
      SENTINEL_MODE: 'protect',
      APP_BRAKE_DB: new FakeD1(),
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(snapshot.metrics['workers.requests']).toBe(100)
    expect(snapshot.policy.gaps).toContain('Worker GraphQL metrics failed for script worker-b: HTTP 500; using successful script rows as lower-bound evidence')
    expect(snapshot.policy.gaps).toContain('rule workers-partial-script has 1 lower-bound ledger gap(s) in its evaluated window')
    expect(snapshot.policy.violations[0]).toMatchObject({
      ruleId: 'workers-partial-script',
      actual: 100,
      actionBlocked: undefined,
    })
    expect(snapshot.policy.brakeCandidates).toEqual(['workers-partial-script'])
  })

  it('blocks complete-freshness candidates when one of multiple script queries fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { scriptName?: string } }
      if (body.variables?.scriptName === 'worker-b') {
        return new Response('unavailable', { status: 500 })
      }
      return graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])
    }))
    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: new FakeR2(),
      LEDGER_DB: new FakeD1(),
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'worker-a,worker-b',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-complete-script',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'complete',
          kind: 'absolute_units',
          max: 50,
        },
      ]),
      SENTINEL_MODE: 'protect',
      APP_BRAKE_DB: new FakeD1(),
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.metrics['workers.requests']).toBe(100)
    expect(snapshot.policy.violations[0]).toMatchObject({
      ruleId: 'workers-complete-script',
      actionBlocked: true,
    })
    expect(snapshot.policy.brakeCandidates).toEqual([])
    expect(snapshot.actions.taken).toEqual([])
  })

  it('collects account-wide Worker GraphQL metrics when script names are blank', async () => {
    let requestBody: { query?: string; variables?: Record<string, unknown> } = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      return graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])
    }))

    const metrics = await __test.collectWorkerMetrics({
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: '',
    } as never, new Date('2026-05-11T12:00:00Z'), new Date('2026-05-11T12:05:00Z'))

    expect(metrics.deltas).toEqual({
      'workers.requests': 100,
      'workers.errors': 0,
      'workers.subrequests': 0,
    })
    expect(metrics.metricScopes).toEqual({
      'workers.requests': 'account',
      'workers.errors': 'account',
      'workers.subrequests': 'account',
    })
    expect(metrics.gaps).toContain('Worker GraphQL metrics are account-wide because SENTINEL_WORKER_SCRIPT_NAMES is empty')
    expect(metrics.actionBlockingGaps).toEqual([])
    expect(requestBody.query).not.toContain('$scriptName')
    expect(requestBody.variables).not.toHaveProperty('scriptName')
  })

  it('allows account-wide Worker rules to brake only when account-wide brake risk is accepted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])))
    const brakeDb = new FakeD1()

    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: new FakeR2(),
      LEDGER_DB: new FakeD1(),
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: '',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'account-workers-one-tick',
          metric: 'workers.requests',
          metricScope: 'account',
          acceptsAccountWideBrake: true,
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      APP_BRAKE_DB: brakeDb,
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.metricScopes['workers.requests']).toBe('account')
    expect(snapshot.policy.brakeCandidates).toEqual(['account-workers-one-tick'])
    expect(snapshot.policy.gaps).toContain('Worker GraphQL metrics are account-wide because SENTINEL_WORKER_SCRIPT_NAMES is empty')
    expect(snapshot.policy.gaps).toContain(
      'rule account-workers-one-tick uses account-wide Worker metrics; the app brake may not reach the Worker causing spend if it is outside the brake integration',
    )
    expect(snapshot.actions.taken).toEqual([{ status: 'written', brakeKey: 'global', candidateRuleIds: ['account-workers-one-tick'] }])
    expect(brakeDb.appBrake.size).toBe(1)
  })

  it('blocks account-wide Worker rules from braking without explicit account-wide acceptance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])))
    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: new FakeR2(),
      LEDGER_DB: new FakeD1(),
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: '',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'account-workers-no-acceptance',
          metric: 'workers.requests',
          metricScope: 'account',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      APP_BRAKE_DB: new FakeD1(),
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.policy.violations[0]).toMatchObject({
      ruleId: 'account-workers-no-acceptance',
      actionBlocked: true,
    })
    expect(snapshot.policy.violations[0]?.actionBlockReason).toContain('set acceptsAccountWideBrake=true')
    expect(snapshot.policy.brakeCandidates).toEqual([])
    expect(snapshot.actions.taken).toEqual([])
  })

  it('blocks configured-script Worker rules when observed metrics are account-wide', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])))
    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: new FakeR2(),
      LEDGER_DB: new FakeD1(),
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: '',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'configured-scope-with-account-data',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      APP_BRAKE_DB: new FakeD1(),
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.policy.gaps).toContain(
      'rule configured-scope-with-account-data expects configured_scripts Worker metrics but observed scope is account; set SENTINEL_WORKER_SCRIPT_NAMES or change metricScope',
    )
    expect(snapshot.policy.brakeCandidates).toEqual([])
    expect(snapshot.actions.taken).toEqual([])
  })

  it('blocks account Worker rules when observed metrics are scoped to configured scripts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])))
    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: new FakeR2(),
      LEDGER_DB: new FakeD1(),
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'account-scope-with-configured-data',
          metric: 'workers.requests',
          metricScope: 'account',
          acceptsAccountWideBrake: true,
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      APP_BRAKE_DB: new FakeD1(),
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.policy.gaps).toContain(
      'rule account-scope-with-configured-data expects account Worker metrics but observed scope is configured_scripts; remove SENTINEL_WORKER_SCRIPT_NAMES or change metricScope',
    )
    expect(snapshot.policy.brakeCandidates).toEqual([])
    expect(snapshot.actions.taken).toEqual([])
  })

  it('does not allow a queue backlog gauge to satisfy additive budget rules', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphqlResponse([{ sum: { requests: 0, errors: 0, subrequests: 0 } }])))
    const r2 = new FakeR2()
    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: r2,
      APP_QUEUE: {
        metrics: async () => ({
          backlogCount: 500,
          backlogBytes: 1000,
          oldestMessageTimestamp: null,
        }),
      },
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_QUEUE_BINDINGS: 'APP_QUEUE',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'backlog-as-spend',
          metric: 'queues.backlogCount',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      APP_BRAKE_DB: new FakeD1(),
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.metrics['queues.backlogCount']).toBe(500)
    expect(snapshot.metricKinds['queues.backlogCount']).toBe('gauge')
    expect(snapshot.policy.evaluatedRules).toBe(0)
    expect(snapshot.policy.brakeCandidates).toEqual([])
    expect(snapshot.policy.gaps).toContain('rule backlog-as-spend metric queues.backlogCount was not collected as an additive delta in this run')
    expect(snapshot.actions.taken).toEqual([])
  })

  it('blocks actions when configured queue metrics fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])))
    const r2 = new FakeR2()
    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: r2,
      APP_QUEUE: { metrics: async () => { throw new Error('queue unavailable') } },
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_QUEUE_BINDINGS: 'APP_QUEUE',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-one-tick',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      APP_BRAKE_DB: new FakeD1(),
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.policy.brakeCandidates).toEqual([])
    expect(snapshot.policy.actionBlockingGaps).toContain('queue APP_QUEUE metrics failed')
    expect(snapshot.actions.taken).toEqual([])
  })

  it('treats queue oldest timestamp zero as unknown instead of a 1970 age', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphqlResponse([{ sum: { requests: 0, errors: 0, subrequests: 0 } }])))
    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: new FakeR2(),
      APP_QUEUE: {
        metrics: async () => ({
          backlogCount: 0,
          backlogBytes: 0,
          oldestMessageTimestamp: 0,
        }),
      },
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_QUEUE_BINDINGS: 'APP_QUEUE',
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.queues[0]).toMatchObject({
      binding: 'APP_QUEUE',
      ok: true,
      oldestMessageAgeSeconds: null,
    })
  })

  it('blocks protect-mode actions when the D1 ledger is not configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])))

    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: new FakeR2(),
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-one-tick',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      APP_BRAKE_DB: new FakeD1(),
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.policy.brakeCandidates).toEqual([])
    expect(snapshot.policy.actionBlockingGaps).toContain('SENTINEL_MODE=protect requires LEDGER_DB and SENTINEL_D1_LEDGER_ENABLED=true')
    expect(snapshot.actions.taken).toEqual([])
  })

  it('blocks protect-mode actions when the R2 snapshot bucket is not configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])))

    const snapshot = await __test.collectAndStoreSnapshot({
      LEDGER_DB: new FakeD1(),
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-one-tick',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      APP_BRAKE_DB: new FakeD1(),
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.policy.brakeCandidates).toEqual([])
    expect(snapshot.policy.actionBlockingGaps).toContain('SENTINEL_MODE=protect requires SNAPSHOTS_BUCKET')
    expect(snapshot.actions.taken).toEqual([])
  })

  it('sends observe-mode would-brake notifications without writing the app brake', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/graphql')) {
        return graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { actionTaken?: boolean; event?: string }
      expect(body).toMatchObject({
        event: 'serverless_sentinel.observe_would_brake',
        actionTaken: false,
      })
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const brakeDb = new FakeD1()

    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: new FakeR2(),
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-one-tick',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_NOTIFY_WEBHOOK_ENABLED: 'true',
      SENTINEL_NOTIFY_OBSERVE_FINDINGS: 'true',
      SENTINEL_NOTIFY_WEBHOOK_KIND: 'generic_json',
      SENTINEL_NOTIFY_WEBHOOK_URL: 'https://webhook.invalid/webhook',
      APP_BRAKE_DB: brakeDb,
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.policy.brakeCandidates).toEqual(['workers-one-tick'])
    expect(snapshot.actions.enabled).toBe(false)
    expect(snapshot.actions.taken).toEqual([])
    expect(brakeDb.appBrake.size).toBe(0)
    expect(snapshot.notifications.sent).toEqual([{ kind: 'generic_json', statusCode: 204 }])
  })

  it('writes evidence before sending notifications for a newly written brake', async () => {
    const events: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/graphql')) {
        return graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])
      }
      events.push('webhook')
      return new Response(null, { status: 204 })
    }))
    const r2 = new FakeR2WithEvents(events)

    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: r2,
      LEDGER_DB: new FakeD1(),
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-one-tick',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      SENTINEL_NOTIFY_WEBHOOK_ENABLED: 'true',
      SENTINEL_NOTIFY_WEBHOOK_KIND: 'generic_json',
      SENTINEL_NOTIFY_WEBHOOK_URL: 'https://webhook.invalid/webhook',
      APP_BRAKE_DB: new FakeD1(),
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.actions.taken).toHaveLength(1)
    expect(snapshot.notifications.sent).toEqual([{ kind: 'generic_json', statusCode: 204 }])
    expect(events.slice(0, 3)).toEqual(['r2:pending', 'webhook', 'r2:final'])
  })

  it('writes candidate evidence before mutating the app brake', async () => {
    const events: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/graphql')) {
        return graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])
      }
      return new Response(null, { status: 204 })
    }))
    const r2 = new FakeR2WithEvents(events)
    const brakeDb = new FakeD1()
    brakeDb.onAppBrakeWrite = () => events.push('brake-write')

    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: r2,
      LEDGER_DB: new FakeD1(),
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-one-tick',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      SENTINEL_NOTIFY_WEBHOOK_ENABLED: 'true',
      SENTINEL_NOTIFY_WEBHOOK_KIND: 'generic_json',
      SENTINEL_NOTIFY_WEBHOOK_URL: 'https://webhook.invalid/webhook',
      APP_BRAKE_DB: brakeDb,
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.actions.taken).toHaveLength(1)
    expect(events.slice(0, 2)).toEqual(['r2:pending', 'brake-write'])
    expect(JSON.parse(r2.puts[0]?.body ?? '{}')).toMatchObject({
      actions: {
        enabled: true,
        taken: [],
        failed: [],
        gaps: ['action_pending_until_evidence_snapshot_is_written'],
      },
    })
  })

  it('does not notify again when the app brake is already active', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/graphql')) {
        return graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])
      }
      throw new Error('webhook should not be called for already-active brakes')
    })
    vi.stubGlobal('fetch', fetchMock)
    const brakeDb = new FakeD1()
    brakeDb.appBrake.set('global', { enabled: 1, expires_at_ms: null })

    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: new FakeR2(),
      LEDGER_DB: new FakeD1(),
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-one-tick',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      SENTINEL_NOTIFY_WEBHOOK_ENABLED: 'true',
      SENTINEL_NOTIFY_WEBHOOK_KIND: 'generic_json',
      SENTINEL_NOTIFY_WEBHOOK_URL: 'https://webhook.invalid/webhook',
      APP_BRAKE_DB: brakeDb,
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.actions.taken).toEqual([{ status: 'already_active', brakeKey: 'global', candidateRuleIds: ['workers-one-tick'] }])
    expect(snapshot.notifications.sent).toEqual([])
    expect(snapshot.notifications.skipped).toEqual([{ reason: 'action_status_not_notifiable' }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('replaces an expired app brake and reports a fresh write', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])))
    const brakeDb = new FakeD1()
    brakeDb.appBrake.set('global', {
      enabled: 1,
      expires_at_ms: Date.parse('2026-05-11T12:00:00Z'),
      reason: 'old expired brake',
    })

    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: new FakeR2(),
      LEDGER_DB: new FakeD1(),
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-one-tick',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      APP_BRAKE_DB: brakeDb,
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.actions.taken).toEqual([{ status: 'written', brakeKey: 'global', candidateRuleIds: ['workers-one-tick'] }])
    expect(brakeDb.appBrake.get('global')?.reason).toContain('serverless sentinel brake activation')
  })

  it('records app-brake D1 read failures as failed actions and still writes evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])))
    const r2 = new FakeR2()
    const brakeDb = new FakeD1()
    brakeDb.throwOnAppBrakeRead = true

    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: r2,
      LEDGER_DB: new FakeD1(),
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-one-tick',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      APP_BRAKE_DB: brakeDb,
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.actions.failed[0]?.error).toBe('app brake read failed')
    expect(r2.puts.some((put) => !put.key.endsWith('/latest-summary.json'))).toBe(true)
  })

  it('does not count failed app-brake writes as taken actions or send notifications', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/graphql')) {
        return graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])
      }
      throw new Error('webhook should not be called when brake write fails')
    })
    vi.stubGlobal('fetch', fetchMock)
    const r2 = new FakeR2()
    const brakeDb = new FakeD1()
    brakeDb.throwOnAppBrakeWrite = true

    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: r2,
      LEDGER_DB: new FakeD1(),
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-one-tick',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      SENTINEL_NOTIFY_WEBHOOK_ENABLED: 'true',
      SENTINEL_NOTIFY_WEBHOOK_KIND: 'generic_json',
      SENTINEL_NOTIFY_WEBHOOK_URL: 'https://webhook.invalid/webhook',
      APP_BRAKE_DB: brakeDb,
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.actions.taken).toEqual([])
    expect(snapshot.actions.failed[0]?.error).toBe('app brake write failed')
    expect(snapshot.notifications.sent).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r2.puts.some((put) => !put.key.endsWith('/latest-summary.json'))).toBe(true)
  })

  it('writes the brake and records degraded evidence when the pre-action R2 snapshot write fails', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/graphql')) {
        return graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { evidenceGaps?: string[] }
      expect(body.evidenceGaps?.[0]).toContain('pre-action R2 snapshot write failed')
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r2 = new FakeR2()
    r2.throwOnPut = true
    const brakeDb = new FakeD1()

    const snapshot = await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: r2,
      LEDGER_DB: new FakeD1(),
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-one-tick',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      SENTINEL_NOTIFY_WEBHOOK_ENABLED: 'true',
      SENTINEL_NOTIFY_WEBHOOK_KIND: 'generic_json',
      SENTINEL_NOTIFY_WEBHOOK_URL: 'https://webhook.invalid/webhook',
      APP_BRAKE_DB: brakeDb,
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    expect(snapshot.actions.taken).toEqual([{ status: 'written', brakeKey: 'global', candidateRuleIds: ['workers-one-tick'] }])
    expect(snapshot.actions.gaps[0]).toContain('pre-action R2 snapshot write failed')
    expect(snapshot.policy.gaps.some((gap) => gap.includes('pre-action R2 snapshot write failed'))).toBe(true)
    expect(snapshot.notifications.sent).toEqual([{ kind: 'generic_json', statusCode: 204 }])
    expect(brakeDb.appBrake.size).toBe(1)
  })

  it('writes failure and gap counts to latest summary', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/graphql')) {
        return graphqlResponse([{ sum: { requests: 100, errors: 0, subrequests: 0 } }])
      }
      return new Response(null, { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r2 = new FakeR2()
    const brakeDb = new FakeD1()
    brakeDb.throwOnAppBrakeWrite = true

    await __test.collectAndStoreSnapshot({
      SNAPSHOTS_BUCKET: r2,
      LEDGER_DB: new FakeD1(),
      SENTINEL_D1_LEDGER_ENABLED: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_OBSERVER_API_TOKEN: 'token',
      SENTINEL_WORKER_SCRIPT_NAMES: 'app-worker',
      SENTINEL_BUDGETS_JSON: JSON.stringify([
        {
          id: 'workers-one-tick',
          metric: 'workers.requests',
          metricScope: 'configured_scripts',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
        {
          id: 'unsupported',
          metric: 'd1.rowsWritten',
          windowTicks: 1,
          level: 'critical',
          actionMode: 'eligible_after_gates',
          requiredFreshness: 'allow_partial',
          kind: 'absolute_units',
          max: 1,
        },
      ]),
      SENTINEL_MODE: 'protect',
      SENTINEL_NOTIFY_WEBHOOK_ENABLED: 'true',
      SENTINEL_NOTIFY_WEBHOOK_KIND: 'generic_json',
      SENTINEL_NOTIFY_WEBHOOK_URL: 'https://webhook.invalid/webhook',
      APP_BRAKE_DB: brakeDb,
    } as never, Date.parse('2026-05-11T12:05:00Z'))

    const latest = r2.puts.find((put) => put.key.endsWith('/latest-summary.json'))
    expect(latest).toBeDefined()
    expect(JSON.parse(latest?.body ?? '{}')).toMatchObject({
      policyGaps: 1,
      actionBlockingGaps: 1,
      actionsFailed: 1,
      notificationsSent: 0,
      notificationsFailed: 0,
    })
  })
})

class FakeR2WithEvents extends FakeR2 {
  constructor(private readonly events: string[]) {
    super()
  }

  override async put(key: string, value: string): Promise<void> {
    await super.put(key, value)
    if (!key.endsWith('/latest-summary.json')) {
      const parsed = JSON.parse(value) as { notifications?: { skipped?: Array<{ reason?: string }> } }
      this.events.push(parsed.notifications?.skipped?.[0]?.reason === 'notification_pending_until_evidence_snapshot_is_written' ? 'r2:pending' : 'r2:final')
    }
  }
}

function graphqlResponse(rows: unknown[]): Response {
  return Response.json({
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptive: rows,
          },
        ],
      },
    },
  })
}

function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ').trim()
}

function metricKey(seriesId: string, metric: string, tickId: number): string {
  return `${seriesId}:${metric}:${tickId}`
}

function parseMetricKey(key: string): { seriesId: string; metric: string; tickId: number } {
  const [seriesId, metric, tickId] = key.split(':')
  if (!seriesId || !metric || !tickId) {
    throw new Error(`invalid metric key: ${key}`)
  }
  return { seriesId, metric, tickId: Number(tickId) }
}

function metricRowsBetween(db: FakeD1, seriesId: string, metric: string, startTick: number, endTick: number): MetricRow[] {
  return [...db.metricTicks.entries()]
    .map(([key, row]) => ({ ...parseMetricKey(key), row }))
    .filter((entry) => entry.seriesId === seriesId && entry.metric === metric && entry.tickId >= startTick && entry.tickId <= endTick)
    .map((entry) => entry.row)
}

function cumulativeProjection(row: MetricRow) {
  return {
    cumulative_value: row.cumulative_value,
    cumulative_gap_count: row.cumulative_gap_count,
    cumulative_recorded_tick_count: row.cumulative_recorded_tick_count,
  }
}

function latestMetricBefore(db: FakeD1, seriesId: string, metric: string, tickId: number): MetricRow | null {
  return latestMetric(db, seriesId, metric, (candidate) => candidate < tickId)
}

function latestMetricAtOrBefore(db: FakeD1, seriesId: string, metric: string, tickId: number): MetricRow | null {
  return latestMetric(db, seriesId, metric, (candidate) => candidate <= tickId)
}

function latestMetric(db: FakeD1, seriesId: string, metric: string, accepts: (tickId: number) => boolean): MetricRow | null {
  return latestMetricEntry(db, seriesId, metric, accepts)?.row ?? null
}

function latestMetricEntry(db: FakeD1, seriesId: string, metric: string, accepts: (tickId: number) => boolean): { tickId: number; row: MetricRow } | null {
  return [...db.metricTicks.entries()]
    .map(([key, row]) => ({ ...parseMetricKey(key), row }))
    .filter((entry) => entry.seriesId === seriesId && entry.metric === metric && accepts(entry.tickId))
    .sort((a, b) => b.tickId - a.tickId)[0] ?? null
}

function firstMetricAtOrBefore(db: FakeD1, seriesId: string, metric: string, tickId: number): number | null {
  return [...db.metricTicks.keys()]
    .map(parseMetricKey)
    .filter((entry) => entry.seriesId === seriesId && entry.metric === metric && entry.tickId <= tickId)
    .sort((a, b) => a.tickId - b.tickId)[0]?.tickId ?? null
}
