import type { D1Database, Queue, R2Bucket, ScheduledController } from '@cloudflare/workers-types'

type Env = {
  SNAPSHOTS_BUCKET?: R2Bucket
  LEDGER_DB?: D1Database
  APP_BRAKE_DB?: D1Database
  CLOUDFLARE_ACCOUNT_ID?: string
  CLOUDFLARE_OBSERVER_API_TOKEN?: string
  SENTINEL_MODE?: string
  SENTINEL_SNAPSHOT_PREFIX?: string
  SENTINEL_QUEUE_BINDINGS?: string
  SENTINEL_WORKER_SCRIPT_NAMES?: string
  SENTINEL_LEDGER_SERIES_ID?: string
  SENTINEL_CADENCE_MINUTES?: string
  SENTINEL_D1_LEDGER_ENABLED?: string
  SENTINEL_BUDGETS_JSON?: string
  SENTINEL_ALLOWANCES_JSON?: string
  SENTINEL_APP_BRAKE_KEY?: string
  SENTINEL_APP_BRAKE_RELEASE_MODE?: string
  SENTINEL_APP_BRAKE_PAUSE_MINUTES?: string
  SENTINEL_NOTIFY_WEBHOOK_ENABLED?: string
  SENTINEL_NOTIFY_OBSERVE_FINDINGS?: string
  SENTINEL_NOTIFY_WEBHOOK_KIND?: string
  SENTINEL_NOTIFY_WEBHOOK_URL?: string
  SENTINEL_NOTIFY_DISCORD_USER_ID?: string
} & Record<string, unknown>

type BudgetRule = {
  id: string
  metric: string
  windowTicks: number
  level: 'warn' | 'critical'
  actionMode: 'observe_only' | 'eligible_after_gates'
  requiredFreshness?: 'complete' | 'allow_partial'
  metricScope?: MetricScope
  acceptsAccountWideBrake?: boolean
} & (
  | {
      kind: 'absolute_units'
      max: number
    }
  | {
      kind: 'allowance_fraction'
      allowancePeriod: 'daily' | 'monthly'
      maxFraction: number
      allowanceUnits?: number
    }
)

type Allowances = Record<string, Partial<Record<'daily' | 'monthly', number>>>
type MetricKind = 'delta' | 'gauge'
type MetricScope = 'configured_scripts' | 'account'
type NotificationKind = 'discord' | 'generic_json'
type SentinelMode = 'observe' | 'protect'

type MetricCollection = {
  deltas: Record<string, number>
  deltaGapCounts: Record<string, number>
  metricScopes: Record<string, MetricScope>
  gauges: Record<string, number>
  gaps: string[]
  actionBlockingGaps: string[]
}

type TickWindow = {
  tickId: number
  windowStart: Date
  windowEnd: Date
}

type WindowUsage = {
  actual: number
  availableTicks: number
  expectedTicks: number
  missingTicks: number
  gapCount: number
  source: 'd1_ledger' | 'd1_ledger_bounded_sum_fallback' | 'current_tick'
}

type MetricTickRow = {
  delta_value: number
  cumulative_value: number
  gap_count: number
  cumulative_gap_count: number
  cumulative_recorded_tick_count: number
}

type QueueSnapshot = {
  binding: string
  ok: boolean
  backlogCount: number | null
  backlogBytes: number | null
  oldestMessageAgeSeconds: number | null
  error?: string
}

type Snapshot = {
  schemaVersion: 1
  generatedAt: string
  storageKey: string
  collectionWindow: {
    tickId: number
    start: string
    end: string
  }
  metrics: Record<string, number>
  metricKinds: Record<string, MetricKind>
  metricScopes: Record<string, MetricScope>
  queues: QueueSnapshot[]
  policy: {
    evaluatedRules: number
    warnings: number
    criticalViolations: number
    brakeCandidates: string[]
    violations: Array<{
      ruleId: string
      metric: string
      kind: BudgetRule['kind']
      actual: number
      evaluatedUsage: number
      threshold: number
      allowanceFraction?: number
      source: WindowUsage['source']
      actionBlocked?: boolean
      actionBlockReason?: string
      scopeWarning?: string
    }>
    actionBlockingGaps: string[]
    gaps: string[]
  }
  actions: {
    enabled: boolean
    taken: Array<{ status: 'written' | 'already_active'; brakeKey: string; candidateRuleIds: string[] }>
    failed: Array<{ status: 'failed'; brakeKey: string; error: string; candidateRuleIds: string[] }>
    gaps: string[]
  }
  notifications: {
    enabled: boolean
    sent: Array<{ kind: NotificationKind; statusCode: number }>
    skipped: Array<{ reason: string }>
    failed: Array<{ kind: NotificationKind; error: string; statusCode?: number }>
    gaps: string[]
  }
}

const API_BASE = 'https://api.cloudflare.com/client/v4'
const EXPECTED_WORKER_DELTA_METRICS = ['workers.requests', 'workers.errors', 'workers.subrequests'] as const

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await collectAndStoreSnapshot(env, controller.scheduledTime)
  },

  async fetch(_request: Request, _env: Env): Promise<Response> {
    return Response.json({ ok: true, service: 'serverless-sentinel' })
  },
}

async function collectAndStoreSnapshot(env: Env, scheduledTimeMs?: number): Promise<Snapshot> {
  // Every scheduled run builds an audit snapshot; R2 persistence depends on the configured mode/bindings.
  const now = new Date()
  const generatedAt = now.toISOString()
  const prefix = env.SENTINEL_SNAPSHOT_PREFIX?.trim() || 'serverless-sentinel'
  const storageKey = `${prefix}/${formatKeyTime(now)}.json`
  const cadenceMinutes = parsePositiveInteger(env.SENTINEL_CADENCE_MINUTES, 5)
  const ledgerSeriesId = normalizeLedgerSeriesId(env.SENTINEL_LEDGER_SERIES_ID, cadenceMinutes)
  const tickWindow = resolveTickWindow(cadenceMinutes, scheduledTimeMs ?? now.getTime())

  const queues = await collectQueueSnapshots(env, now)
  const workerMetrics = await collectWorkerMetrics(env, tickWindow.windowStart, tickWindow.windowEnd)
  const collected: MetricCollection = {
    deltas: {
      ...workerMetrics.deltas,
    },
    deltaGapCounts: {
      ...workerMetrics.deltaGapCounts,
    },
    metricScopes: {
      ...workerMetrics.metricScopes,
    },
    // Gauges are current-state readings. For instance, a queue backlog of 10
    // means "10 messages exist right now", not "10 new billable operations happened".
    gauges: {
      'queues.backlogCount': queues.reduce((sum, queue) => sum + (queue.backlogCount ?? 0), 0),
      'queues.backlogBytes': queues.reduce((sum, queue) => sum + (queue.backlogBytes ?? 0), 0),
    },
    gaps: [
      ...workerMetrics.gaps,
      ...queues.filter((queue) => !queue.ok).map((queue) => `queue ${queue.binding} metrics failed: ${queue.error ?? 'unknown error'}`),
    ],
    actionBlockingGaps: [
      ...workerMetrics.actionBlockingGaps,
      ...queues.filter((queue) => !queue.ok).map((queue) => `queue ${queue.binding} metrics failed`),
    ],
  }
  const metrics = {
    ...collected.deltas,
    ...collected.gauges,
  }
  const metricKinds = {
    ...Object.fromEntries(Object.keys(collected.deltas).map((metric) => [metric, 'delta' as const])),
    ...Object.fromEntries(Object.keys(collected.gauges).map((metric) => [metric, 'gauge' as const])),
  }

  const gaps: string[] = [...collected.gaps]
  const actionBlockingGaps: string[] = [...collected.actionBlockingGaps]
  let ledgerDb = parseBoolean(env.SENTINEL_D1_LEDGER_ENABLED) ? env.LEDGER_DB : undefined
  if (parseBoolean(env.SENTINEL_D1_LEDGER_ENABLED)) {
    if (ledgerDb) {
      try {
        await writeLedgerTick(ledgerDb, {
          seriesId: ledgerSeriesId,
          tickWindow,
          generatedAt,
          cadenceMinutes,
          sourceSnapshotKey: storageKey,
          metrics: collected.deltas,
          metricGapCounts: collected.deltaGapCounts,
        })
      } catch (error) {
        gaps.push(`ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
        actionBlockingGaps.push('ledger write failed')
        ledgerDb = undefined
      }
    } else {
      gaps.push('LEDGER_DB is not configured')
      actionBlockingGaps.push('LEDGER_DB is not configured')
    }
  }

  const rules = parseBudgetRules(env.SENTINEL_BUDGETS_JSON, gaps)
  const policy = await evaluateBudgetRules({
    rules,
    allowances: parseAllowances(env.SENTINEL_ALLOWANCES_JSON, gaps),
    db: ledgerDb,
    seriesId: ledgerSeriesId,
    endTickId: tickWindow.tickId,
    generatedAt,
    cadenceMinutes,
    currentMetrics: collected.deltas,
    currentMetricGapCounts: collected.deltaGapCounts,
    metricScopes: collected.metricScopes,
    currentDeltaMetricNames: new Set(Object.keys(collected.deltas)),
    gaps,
    actionBlockingGaps,
  })
  const mode = parseSentinelMode(env.SENTINEL_MODE)
  const modeActionGaps = protectModeActionGaps(env, mode, ledgerDb)
  applyModeActionGapsToPolicy(policy, rules, modeActionGaps)

  const candidateSnapshot: Snapshot = {
    schemaVersion: 1,
    generatedAt,
    storageKey,
    collectionWindow: {
      tickId: tickWindow.tickId,
      start: tickWindow.windowStart.toISOString(),
      end: tickWindow.windowEnd.toISOString(),
    },
    metrics,
    metricKinds,
    metricScopes: collected.metricScopes,
    queues,
    policy,
    actions: pendingActions(mode, policy.brakeCandidates, modeActionGaps),
    notifications: pendingNotifications(env),
  }

  const preActionEvidenceGaps: string[] = []
  if (env.SNAPSHOTS_BUCKET) {
    try {
      // Write evidence before app mutations when possible. If R2 fails at runtime,
      // protect mode still prioritizes a valid brake backed by D1 policy evidence.
      await env.SNAPSHOTS_BUCKET.put(storageKey, JSON.stringify(candidateSnapshot, null, 2), {
        httpMetadata: { contentType: 'application/json' },
      })
    } catch (error) {
      const message = `pre-action R2 snapshot write failed; proceeding with brake using D1 policy evidence: ${error instanceof Error ? error.message : String(error)}`
      gaps.push(message)
      policy.gaps.push(message)
      preActionEvidenceGaps.push(message)
    }
  }
  const actions = await applyBrakeAction(env, mode, generatedAt, policy.brakeCandidates, modeActionGaps, preActionEvidenceGaps)
  const notifications = await notifyAfterBrake(env, mode, generatedAt, storageKey, actions.taken, policy.brakeCandidates, preActionEvidenceGaps)
  const finalSnapshot: Snapshot = { ...candidateSnapshot, actions, notifications }
  if (env.SNAPSHOTS_BUCKET) {
    try {
      await env.SNAPSHOTS_BUCKET.put(storageKey, JSON.stringify(finalSnapshot, null, 2), {
        httpMetadata: { contentType: 'application/json' },
      })
      await env.SNAPSHOTS_BUCKET.put(`${prefix}/latest-summary.json`, JSON.stringify({
        generatedAt,
        storageKey,
        criticalViolations: policy.criticalViolations,
        brakeCandidates: policy.brakeCandidates.length,
        policyGaps: policy.gaps.length,
        actionBlockingGaps: policy.actionBlockingGaps.length,
        actionsFailed: actions.failed.length,
        notificationsSent: notifications.sent.length,
        notificationsFailed: notifications.failed.length,
      }, null, 2), {
        httpMetadata: { contentType: 'application/json' },
      })
    } catch (error) {
      const message = `final R2 snapshot write failed: ${error instanceof Error ? error.message : String(error)}`
      finalSnapshot.actions.gaps.push(message)
      finalSnapshot.notifications.gaps.push(message)
    }
  }

  return finalSnapshot
}

function pendingActions(mode: SentinelMode, candidateRuleIds: string[], modeActionGaps: string[]): Snapshot['actions'] {
  return {
    enabled: mode === 'protect',
    taken: [],
    failed: [],
    gaps: candidateRuleIds.length > 0 ? ['action_pending_until_evidence_snapshot_is_written', ...modeActionGaps] : [...modeActionGaps],
  }
}

async function collectQueueSnapshots(env: Env, now: Date): Promise<QueueSnapshot[]> {
  const bindings = parseCsv(env.SENTINEL_QUEUE_BINDINGS)
  const snapshots: QueueSnapshot[] = []
  for (const binding of bindings) {
    const queue = env[binding]
    if (!isQueueBinding(queue)) {
      snapshots.push({
        binding,
        ok: false,
        backlogCount: null,
        backlogBytes: null,
        oldestMessageAgeSeconds: null,
        error: 'binding is not a Queue with metrics()',
      })
      continue
    }

    try {
      // Queue bindings are used for realtime metrics only; this reference implementation never sends queue messages.
      const metrics = await queue.metrics()
      const oldest = normalizeDate(metrics.oldestMessageTimestamp)
      snapshots.push({
        binding,
        ok: true,
        backlogCount: finiteNumber(metrics.backlogCount),
        backlogBytes: finiteNumber(metrics.backlogBytes),
        oldestMessageAgeSeconds: oldest ? Math.max(0, (now.getTime() - oldest.getTime()) / 1000) : null,
      })
    } catch (error) {
      snapshots.push({
        binding,
        ok: false,
        backlogCount: null,
        backlogBytes: null,
        oldestMessageAgeSeconds: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return snapshots
}

async function collectWorkerMetrics(env: Env, windowStart: Date, windowEnd: Date): Promise<MetricCollection> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const token = env.CLOUDFLARE_OBSERVER_API_TOKEN?.trim()
  if (!accountId || !token) {
    return missingWorkerMetrics('Worker GraphQL metrics skipped: missing account id or observer token')
  }

  const scriptNames = parseCsv(env.SENTINEL_WORKER_SCRIPT_NAMES)
  const accountWideQuery = `
    query WorkerRequests($accountTag: string!, $datetimeStart: string!, $datetimeEnd: string!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            limit: 100,
            filter: { datetime_geq: $datetimeStart, datetime_lt: $datetimeEnd }
          ) {
            sum { requests errors subrequests }
          }
        }
      }
    }
  `
  const scriptScopedQuery = `
    query WorkerRequests($accountTag: string!, $datetimeStart: string!, $datetimeEnd: string!, $scriptName: string) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            limit: 100,
            filter: { scriptName: $scriptName, datetime_geq: $datetimeStart, datetime_lt: $datetimeEnd }
          ) {
            sum { requests errors subrequests }
          }
        }
      }
    }
  `
  const query = scriptNames.length > 0 ? scriptScopedQuery : accountWideQuery
  const observedScope: MetricScope = scriptNames.length > 0 ? 'configured_scripts' : 'account'
  const gaps = scriptNames.length === 0 ? ['Worker GraphQL metrics are account-wide because SENTINEL_WORKER_SCRIPT_NAMES is empty'] : []
  const actionBlockingGaps: string[] = []
  const rows: Array<{ sum?: Record<string, number> }> = []
  const sourceFailureGaps: string[] = []
  const sourceFailureActionBlockingGaps: string[] = []
  let lowerBoundGap = false

  for (const scriptName of scriptNames.length > 0 ? scriptNames : [undefined]) {
    const result = await fetchWorkerMetricRows({
      token,
      accountId,
      query,
      windowStart,
      windowEnd,
      scriptName,
    })
    // Keep valid rows from every script, but remember if any source was partial.
    // The aggregate is lower-bound evidence: trusted usage is at least this high,
    // while complete-freshness rules must treat the window as degraded.
    rows.push(...result.rows)
    lowerBoundGap = lowerBoundGap || result.lowerBoundGap
    if (result.failed) {
      sourceFailureGaps.push(...result.gaps)
      sourceFailureActionBlockingGaps.push(...result.actionBlockingGaps)
    } else {
      gaps.push(...result.gaps)
      actionBlockingGaps.push(...result.actionBlockingGaps)
    }
  }

  if (sourceFailureGaps.length > 0 && rows.length > 0) {
    lowerBoundGap = true
    gaps.push(...sourceFailureGaps.map((gap) => `${gap}; using successful script rows as lower-bound evidence`))
  } else {
    gaps.push(...sourceFailureGaps)
    actionBlockingGaps.push(...sourceFailureActionBlockingGaps)
  }

  if (sourceFailureGaps.length > 0 && rows.length === 0) {
    return {
      deltas: workerMetricDeltas([]),
      deltaGapCounts: workerMetricGapCounts(1),
      metricScopes: workerMetricScopes(observedScope),
      gauges: {},
      gaps,
      actionBlockingGaps,
    }
  }

  return {
    deltas: workerMetricDeltas(rows),
    deltaGapCounts: workerMetricGapCounts(lowerBoundGap ? 1 : 0),
    metricScopes: workerMetricScopes(observedScope),
    gauges: {},
    gaps,
    actionBlockingGaps,
  }
}

async function fetchWorkerMetricRows(input: {
  token: string
  accountId: string
  query: string
  windowStart: Date
  windowEnd: Date
  scriptName?: string
}): Promise<{
  rows: Array<{ sum?: Record<string, number> }>
  gaps: string[]
  actionBlockingGaps: string[]
  failed: boolean
  lowerBoundGap: boolean
}> {
  const label = input.scriptName ? ` for script ${input.scriptName}` : ''
  try {
    const response = await fetch(`${API_BASE}/graphql`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: input.query,
        variables: {
          accountTag: input.accountId,
          datetimeStart: input.windowStart.toISOString(),
          datetimeEnd: input.windowEnd.toISOString(),
          ...(input.scriptName ? { scriptName: input.scriptName } : {}),
        },
      }),
    })
    if (!response.ok) {
      return missingWorkerRows(`Worker GraphQL metrics failed${label}: HTTP ${response.status}`)
    }
    const body = await response.json<{
      data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: unknown }> } }
      errors?: Array<{ message?: string }>
    }>()
    if (body.errors?.length) {
      const messages = body.errors.map((error) => `Worker GraphQL metrics failed${label}: ${error.message ?? 'unknown GraphQL error'}`)
      return { rows: [], gaps: messages, actionBlockingGaps: messages, failed: true, lowerBoundGap: false }
    }
    const account = body.data?.viewer?.accounts?.[0]
    if (!account) {
      return missingWorkerRows(`Worker GraphQL metrics failed${label}: account was not returned`)
    }
    if (!Array.isArray(account.workersInvocationsAdaptive)) {
      return missingWorkerRows(`Worker GraphQL metrics failed${label}: workersInvocationsAdaptive was not an array`)
    }
    const rows: Array<{ sum?: Record<string, number> }> = []
    // Malformed rows are not clean zero usage. We keep valid rows as a lower-bound
    // signal and mark a metric gap, so a threshold breach from trusted rows can
    // still protect the app while the snapshot records degraded telemetry.
    const malformedRows = account.workersInvocationsAdaptive.filter((row): row is Record<string, unknown> => {
      if (!isWorkerMetricRow(row)) {
        return true
      }
      rows.push(row)
      return false
    }).length
    const malformedGaps = malformedRows > 0
      ? [`Worker GraphQL metrics returned ${malformedRows} malformed row(s)${label}; using valid rows as lower-bound evidence`]
      : []
    return {
      rows,
      gaps: malformedGaps,
      actionBlockingGaps: [],
      failed: false,
      lowerBoundGap: malformedRows > 0,
    }
  } catch (error) {
    return missingWorkerRows(`Worker GraphQL metrics failed${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function missingWorkerMetrics(reason: string): MetricCollection {
  return {
    deltas: workerMetricDeltas([]),
    deltaGapCounts: workerMetricGapCounts(1),
    metricScopes: workerMetricScopes('account'),
    gauges: {},
    gaps: [reason],
    actionBlockingGaps: [reason],
  }
}

function workerMetricDeltas(rows: Array<{ sum?: Record<string, number> }>): Record<string, number> {
  return {
    'workers.requests': rows.reduce((sum, row) => sum + finiteNumber(row.sum?.requests), 0),
    'workers.errors': rows.reduce((sum, row) => sum + finiteNumber(row.sum?.errors), 0),
    'workers.subrequests': rows.reduce((sum, row) => sum + finiteNumber(row.sum?.subrequests), 0),
  }
}

function workerMetricGapCounts(gapCount: number): Record<string, number> {
  return Object.fromEntries(EXPECTED_WORKER_DELTA_METRICS.map((metric) => [metric, gapCount]))
}

function workerMetricScopes(scope: MetricScope): Record<string, MetricScope> {
  return Object.fromEntries(EXPECTED_WORKER_DELTA_METRICS.map((metric) => [metric, scope]))
}

function isWorkerMetricRow(row: unknown): row is { sum: Record<'requests' | 'errors' | 'subrequests', number> } {
  if (!row || typeof row !== 'object') {
    return false
  }
  const sum = (row as { sum?: unknown }).sum
  return Boolean(
    sum &&
      typeof sum === 'object' &&
      typeof (sum as Record<string, unknown>).requests === 'number' &&
      Number.isFinite((sum as Record<string, unknown>).requests) &&
      typeof (sum as Record<string, unknown>).errors === 'number' &&
      Number.isFinite((sum as Record<string, unknown>).errors) &&
      typeof (sum as Record<string, unknown>).subrequests === 'number' &&
      Number.isFinite((sum as Record<string, unknown>).subrequests),
  )
}

function missingWorkerRows(reason: string): { rows: []; gaps: string[]; actionBlockingGaps: string[]; failed: true; lowerBoundGap: false } {
  return { rows: [], gaps: [reason], actionBlockingGaps: [reason], failed: true, lowerBoundGap: false }
}

async function writeLedgerTick(
  db: D1Database,
  input: {
    seriesId: string
    tickWindow: TickWindow
    generatedAt: string
    cadenceMinutes: number
    sourceSnapshotKey: string
    metrics: Record<string, number>
    metricGapCounts?: Record<string, number>
  },
): Promise<void> {
  // Metric ticks are append-once. First write wins so cumulative boundary-subtraction stays stable.
  const tickId = input.tickWindow.tickId
  const series = await db.prepare(`
    SELECT cadence_minutes FROM sentinel_ledger_series WHERE series_id = ?1
  `).bind(input.seriesId).first<{ cadence_minutes: number }>()
  if (series && finiteNumber(series.cadence_minutes) !== input.cadenceMinutes) {
    throw new Error(`ledger series ${input.seriesId} uses cadence ${series.cadence_minutes}, not ${input.cadenceMinutes}`)
  }
  await db.prepare(`
    INSERT INTO sentinel_ledger_series (series_id, cadence_minutes, created_at, reason)
    VALUES (?1, ?2, ?3, 'configured ledger series')
    ON CONFLICT(series_id) DO NOTHING
  `).bind(input.seriesId, input.cadenceMinutes, input.generatedAt).run()
  await db.prepare(`
    INSERT OR IGNORE INTO sentinel_ticks
      (series_id, tick_id, generated_at, cadence_minutes, source_snapshot_key, window_start_ms, window_end_ms, gap_count)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
  `).bind(
    input.seriesId,
    tickId,
    input.generatedAt,
    input.cadenceMinutes,
    input.sourceSnapshotKey,
    input.tickWindow.windowStart.getTime(),
    input.tickWindow.windowEnd.getTime(),
  ).run()

  for (const [metric, value] of Object.entries(input.metrics)) {
    const previous = await db.prepare(`
      SELECT tick_id, cumulative_value, cumulative_gap_count, cumulative_recorded_tick_count
      FROM sentinel_metric_ticks
      WHERE series_id = ?1 AND metric = ?2 AND tick_id < ?3
      ORDER BY tick_id DESC
      LIMIT 1
    `).bind(input.seriesId, metric, tickId).first<{
      tick_id: number
      cumulative_value: number
      cumulative_gap_count: number
      cumulative_recorded_tick_count: number
    }>()
    const prior = finiteNumber(previous?.cumulative_value)
    const previousTickId = Number.isInteger(previous?.tick_id) ? Number(previous?.tick_id) : null
    const delta = Math.max(0, value)
    const gapCount = Math.max(0, Math.trunc(finiteNumber(input.metricGapCounts?.[metric])))
    const cumulative = prior + delta
    const cumulativeGapCount = Math.trunc(finiteNumber(previous?.cumulative_gap_count)) + gapCount
    const cumulativeRecordedTickCount = Math.trunc(finiteNumber(previous?.cumulative_recorded_tick_count)) + 1
    // First-write-wins and monotonic tick acceptance are enforced in one batch.
    // The insert is allowed only when metric state still matches the boundary row
    // used for cumulative math. If another invocation advances state first, this
    // tick is skipped and remains visible as missing data instead of corrupting
    // later cumulative odometer rows.
    await db.batch([
      db.prepare(`
        INSERT OR IGNORE INTO sentinel_metric_ticks
          (series_id, metric, tick_id, delta_value, cumulative_value, gap_count, cumulative_gap_count, cumulative_recorded_tick_count, source)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'serverless-sentinel-reference'
        WHERE NOT EXISTS (
          SELECT 1 FROM sentinel_metric_state
          WHERE series_id = ?1 AND metric = ?2 AND last_tick_id > ?3
        )
        AND (
          (?9 IS NULL AND NOT EXISTS (
            SELECT 1 FROM sentinel_metric_state
            WHERE series_id = ?1 AND metric = ?2
          ))
          OR EXISTS (
            SELECT 1 FROM sentinel_metric_state
            WHERE series_id = ?1 AND metric = ?2 AND last_tick_id = ?9
          )
          OR EXISTS (
            SELECT 1 FROM sentinel_metric_ticks
            WHERE series_id = ?1 AND metric = ?2 AND tick_id = ?3
          )
        )
      `).bind(input.seriesId, metric, tickId, delta, cumulative, gapCount, cumulativeGapCount, cumulativeRecordedTickCount, previousTickId),
      db.prepare(`
        INSERT INTO sentinel_metric_state
          (series_id, metric, last_tick_id, cumulative_value, cumulative_gap_count, cumulative_recorded_tick_count, updated_at)
        SELECT ?1, ?2, ?3, cumulative_value, cumulative_gap_count, cumulative_recorded_tick_count, ?4
        FROM sentinel_metric_ticks
        WHERE series_id = ?1 AND metric = ?2 AND tick_id = ?3
        ON CONFLICT(series_id, metric) DO UPDATE SET
          last_tick_id = excluded.last_tick_id,
          cumulative_value = excluded.cumulative_value,
          cumulative_gap_count = excluded.cumulative_gap_count,
          cumulative_recorded_tick_count = excluded.cumulative_recorded_tick_count,
          updated_at = excluded.updated_at
        WHERE excluded.last_tick_id >= sentinel_metric_state.last_tick_id
      `).bind(input.seriesId, metric, tickId, input.generatedAt),
    ])
  }
}

async function evaluateBudgetRules(input: {
  rules: BudgetRule[]
  allowances: Allowances
  db?: D1Database
  seriesId: string
  endTickId: number
  generatedAt: string
  cadenceMinutes: number
  currentMetrics: Record<string, number>
  currentMetricGapCounts?: Record<string, number>
  metricScopes: Record<string, MetricScope>
  currentDeltaMetricNames: Set<string>
  gaps: string[]
  actionBlockingGaps: string[]
}): Promise<Snapshot['policy']> {
  const violations: Snapshot['policy']['violations'] = []
  const brakeCandidates: string[] = []
  const globalActionBlockingGaps = [...input.actionBlockingGaps]
  const actionBlockingGaps = [...input.actionBlockingGaps]
  let evaluatedRules = 0

  for (const rule of input.rules) {
    if (!input.currentDeltaMetricNames.has(rule.metric)) {
      const message = `rule ${rule.id} metric ${rule.metric} was not collected as an additive delta in this run`
      input.gaps.push(message)
      actionBlockingGaps.push(message)
      continue
    }
    const scopeCheck = validateRuleMetricScope(rule, input.metricScopes[rule.metric])
    if (scopeCheck.blockingReason) {
      input.gaps.push(scopeCheck.blockingReason)
      actionBlockingGaps.push(scopeCheck.blockingReason)
      continue
    }
    // D1 enables true rolling windows. Without it, only explicit one-tick rules
    // can be evaluated from the current collection; multi-tick rules are action-blocked.
    const usage =
      input.db
        ? await queryWindowUsage(input.db, input.seriesId, rule.metric, input.endTickId, rule.windowTicks)
        : {
            actual: finiteNumber(input.currentMetrics[rule.metric]),
            availableTicks: 1,
            expectedTicks: rule.windowTicks,
            missingTicks: 0,
            gapCount: Math.max(0, Math.trunc(finiteNumber(input.currentMetricGapCounts?.[rule.metric]))),
            source: 'current_tick' as const,
          }
    if (rule.requiredFreshness === 'complete' && usage.availableTicks < rule.windowTicks) {
      const message = `rule ${rule.id} requires complete freshness but only ${usage.availableTicks}/${rule.windowTicks} ticks are available`
      input.gaps.push(message)
      actionBlockingGaps.push(message)
      continue
    }
    const ruleActionBlockReasons: string[] = []
    if (usage.gapCount > 0) {
      const gapMessage = `rule ${rule.id} has ${usage.gapCount} lower-bound ledger gap(s) in its evaluated window`
      input.gaps.push(gapMessage)
      if (rule.requiredFreshness === 'complete') {
        ruleActionBlockReasons.push(gapMessage)
      }
    }
    if (!input.db && rule.windowTicks > 1) {
      ruleActionBlockReasons.push(`rule ${rule.id} requires the D1 ledger for action-eligible multi-tick evaluation`)
    }
    const threshold = thresholdForRule(rule, input.allowances, usage, input.gaps)
    if (threshold === null) {
      continue
    }
    actionBlockingGaps.push(...ruleActionBlockReasons)
    evaluatedRules += 1
    if (threshold.evaluatedUsage <= threshold.threshold) {
      continue
    }
    if (scopeCheck.warning) {
      input.gaps.push(scopeCheck.warning)
    }
    if (scopeCheck.actionBlockReason) {
      ruleActionBlockReasons.push(scopeCheck.actionBlockReason)
      actionBlockingGaps.push(scopeCheck.actionBlockReason)
    }
    const actionBlockReason = [...globalActionBlockingGaps, ...ruleActionBlockReasons].join('; ')
    violations.push({
      ruleId: rule.id,
      metric: rule.metric,
      kind: rule.kind,
      actual: usage.actual,
      evaluatedUsage: threshold.evaluatedUsage,
      threshold: threshold.threshold,
      allowanceFraction: threshold.allowanceFraction,
      source: usage.source,
      actionBlocked: actionBlockReason.length > 0 || undefined,
      actionBlockReason: actionBlockReason || undefined,
      scopeWarning: scopeCheck.warning,
    })
    if (rule.level === 'critical' && rule.actionMode === 'eligible_after_gates' && !actionBlockReason) {
      brakeCandidates.push(rule.id)
    }
  }
  return {
    evaluatedRules,
    warnings: violations.filter((violation) => input.rules.find((rule) => rule.id === violation.ruleId)?.level === 'warn').length,
    criticalViolations: violations.filter((violation) => input.rules.find((rule) => rule.id === violation.ruleId)?.level === 'critical').length,
    brakeCandidates,
    violations,
    gaps: input.gaps,
    actionBlockingGaps,
  }
}

async function queryWindowUsage(
  db: D1Database,
  seriesId: string,
  metric: string,
  endTickId: number,
  windowTicks: number,
): Promise<WindowUsage> {
  // Rolling usage, gap count, and recorded-tick freshness are all boundary subtractions over cumulative counters.
  const startTickId = endTickId - windowTicks + 1
  const current = await db.prepare(`
    SELECT cumulative_value, cumulative_gap_count, cumulative_recorded_tick_count
    FROM sentinel_metric_ticks
    WHERE series_id = ?1 AND metric = ?2 AND tick_id <= ?3
    ORDER BY tick_id DESC
    LIMIT 1
  `).bind(seriesId, metric, endTickId).first<{
    cumulative_value: number
    cumulative_gap_count: number
    cumulative_recorded_tick_count: number
  }>()
  const before = await db.prepare(`
    SELECT cumulative_value, cumulative_gap_count, cumulative_recorded_tick_count
    FROM sentinel_metric_ticks
    WHERE series_id = ?1 AND metric = ?2 AND tick_id < ?3
    ORDER BY tick_id DESC
    LIMIT 1
  `).bind(seriesId, metric, startTickId).first<{
    cumulative_value: number
    cumulative_gap_count: number
    cumulative_recorded_tick_count: number
  }>()
  // The first recorded tick lets startup partial windows differ from telemetry holes.
  // Missing ticks before this point predate the ledger; missing ticks after it are evidence gaps.
  const first = await db.prepare(`
    SELECT MIN(tick_id) AS firstTickId
    FROM sentinel_metric_ticks
    WHERE series_id = ?1 AND metric = ?2 AND tick_id <= ?3
  `).bind(seriesId, metric, endTickId).first<{ firstTickId: number | null }>()
  const firstObservedTick = typeof first?.firstTickId === 'number' ? first.firstTickId : null
  const effectiveStartTick = firstObservedTick === null ? endTickId : Math.max(startTickId, firstObservedTick)
  const expectedAvailableTicks = Math.max(0, endTickId - effectiveStartTick + 1)
  const boundaryMissingButHistoryExists =
    before === null &&
    current !== null &&
    Math.trunc(finiteNumber(current.cumulative_recorded_tick_count)) > expectedAvailableTicks

  if (boundaryMissingButHistoryExists) {
    // Cumulative math needs the row immediately before the window. If that
    // boundary was pruned but retained rows prove older history existed, subtracting
    // from zero would overcount. Fall back to a bounded SUM over this window so an
    // observed violation can still trip the brake from trustworthy in-window rows.
    const bounded = await db.prepare(`
      SELECT
        COALESCE(SUM(delta_value), 0) AS actual,
        COUNT(*) AS availableTicks,
        COALESCE(SUM(gap_count), 0) AS gapCount
      FROM sentinel_metric_ticks
      WHERE series_id = ?1 AND metric = ?2 AND tick_id >= ?3 AND tick_id <= ?4
    `).bind(seriesId, metric, startTickId, endTickId).first<{
      actual: number
      availableTicks: number
      gapCount: number
    }>()
    const availableTicks = Math.max(0, Math.trunc(finiteNumber(bounded?.availableTicks)))

    return {
      actual: Math.max(0, finiteNumber(bounded?.actual)),
      availableTicks,
      expectedTicks: windowTicks,
      missingTicks: Math.max(0, expectedAvailableTicks - availableTicks),
      gapCount: Math.max(0, Math.trunc(finiteNumber(bounded?.gapCount))),
      source: 'd1_ledger_bounded_sum_fallback',
    }
  }

  const availableTicks = Math.max(
    0,
    Math.trunc(finiteNumber(current?.cumulative_recorded_tick_count) - finiteNumber(before?.cumulative_recorded_tick_count)),
  )

  return {
    actual: Math.max(0, finiteNumber(current?.cumulative_value) - finiteNumber(before?.cumulative_value)),
    availableTicks,
    expectedTicks: windowTicks,
    missingTicks: Math.max(0, expectedAvailableTicks - availableTicks),
    gapCount: Math.max(0, Math.trunc(finiteNumber(current?.cumulative_gap_count) - finiteNumber(before?.cumulative_gap_count))),
    source: 'd1_ledger',
  }
}

function validateRuleMetricScope(rule: BudgetRule, observedScope: MetricScope | undefined): {
  blockingReason?: string
  actionBlockReason?: string
  warning?: string
} {
  if (!isWorkerDeltaMetric(rule.metric)) {
    return {}
  }
  if (!observedScope) {
    return { blockingReason: `rule ${rule.id} metric ${rule.metric} has no observed Worker metric scope` }
  }
  if (rule.metricScope !== observedScope) {
    if (rule.metricScope === 'configured_scripts' && observedScope === 'account') {
      return {
        blockingReason:
          `rule ${rule.id} expects configured_scripts Worker metrics but observed scope is account; set SENTINEL_WORKER_SCRIPT_NAMES or change metricScope`,
      }
    }
    if (rule.metricScope === 'account' && observedScope === 'configured_scripts') {
      return {
        blockingReason:
          `rule ${rule.id} expects account Worker metrics but observed scope is configured_scripts; remove SENTINEL_WORKER_SCRIPT_NAMES or change metricScope`,
      }
    }
    return { blockingReason: `rule ${rule.id} Worker metric scope does not match observed scope` }
  }
  if (rule.metricScope === 'account' && rule.level === 'critical' && rule.actionMode === 'eligible_after_gates') {
    const warning =
      `rule ${rule.id} uses account-wide Worker metrics; the app brake may not reach the Worker causing spend if it is outside the brake integration`
    if (!rule.acceptsAccountWideBrake) {
      return { actionBlockReason: `${warning}; set acceptsAccountWideBrake=true to allow this rule to brake`, warning }
    }
    return { warning }
  }
  return {}
}

function isWorkerDeltaMetric(metric: string): boolean {
  return (EXPECTED_WORKER_DELTA_METRICS as readonly string[]).includes(metric)
}

function thresholdForRule(
  rule: BudgetRule,
  allowances: Allowances,
  usage: WindowUsage,
  gaps: string[],
): {
  threshold: number
  evaluatedUsage: number
  allowanceFraction?: number
} | null {
  if (rule.kind === 'absolute_units') {
    return { threshold: rule.max, evaluatedUsage: usage.actual }
  }

  const allowanceUnits = rule.allowanceUnits ?? allowances[rule.metric]?.[rule.allowancePeriod]
  if (!allowanceUnits || !Number.isFinite(allowanceUnits) || allowanceUnits <= 0) {
    gaps.push(`rule ${rule.id} is missing ${rule.allowancePeriod} allowance units for ${rule.metric}`)
    return null
  }

  if (rule.kind === 'allowance_fraction') {
    return {
      threshold: allowanceUnits * rule.maxFraction,
      evaluatedUsage: usage.actual,
      allowanceFraction: usage.actual / allowanceUnits,
    }
  }

  return null
}

async function applyBrakeAction(
  env: Env,
  mode: SentinelMode,
  generatedAt: string,
  candidateRuleIds: string[],
  modeActionGaps: string[],
  evidenceGaps: string[],
): Promise<Snapshot['actions']> {
  if (mode !== 'protect') {
    return { enabled: false, taken: [], failed: [], gaps: [] }
  }
  if (candidateRuleIds.length === 0 || modeActionGaps.length > 0) {
    return { enabled: true, taken: [], failed: [], gaps: [...modeActionGaps, ...evidenceGaps] }
  }
  if (!env.APP_BRAKE_DB) {
    return { enabled: true, taken: [], failed: [], gaps: ['APP_BRAKE_DB is not configured', ...evidenceGaps] }
  }

  const brakeKey = env.SENTINEL_APP_BRAKE_KEY?.trim() || 'global'
  const nowMs = Date.parse(generatedAt)
  try {
    const activationId = crypto.randomUUID()
    const reason = `serverless sentinel brake activation ${activationId}; candidates: ${candidateRuleIds.join(',')}`
    const expiresAtMs = resolveBrakeExpiration(env, nowMs)
    // This conditional upsert is the idempotence boundary. It inserts a missing
    // brake row or replaces only inactive/expired rows; currently active rows are
    // left untouched so overlapping invocations cannot both claim a fresh write.
    const results = await env.APP_BRAKE_DB.batch([
      env.APP_BRAKE_DB.prepare(`
        INSERT INTO app_brake (brake_key, enabled, reason, source, set_at_ms, expires_at_ms, updated_at_ms)
        VALUES (?1, 1, ?2, 'serverless-sentinel', ?3, ?4, ?3)
        ON CONFLICT(brake_key) DO UPDATE SET
          enabled = excluded.enabled,
          reason = excluded.reason,
          source = excluded.source,
          set_at_ms = excluded.set_at_ms,
          expires_at_ms = excluded.expires_at_ms,
          updated_at_ms = excluded.updated_at_ms
        WHERE app_brake.enabled = 0 OR (app_brake.expires_at_ms IS NOT NULL AND app_brake.expires_at_ms <= ?5)
      `).bind(brakeKey, reason, nowMs, expiresAtMs, nowMs),
      env.APP_BRAKE_DB.prepare(`
        SELECT brake_key, reason FROM app_brake
        WHERE brake_key = ?1 AND enabled = 1 AND (expires_at_ms IS NULL OR expires_at_ms > ?2)
        LIMIT 1
      `).bind(brakeKey, nowMs),
    ]) as Array<{ results?: Array<{ brake_key?: string; reason?: string }> }>
    const active = results[1]?.results?.[0]
    if (!active?.reason?.includes(activationId)) {
      return {
        enabled: true,
        taken: [{ status: 'already_active', brakeKey, candidateRuleIds }],
        failed: [],
        gaps: [...evidenceGaps],
      }
    }
    return {
      enabled: true,
      taken: [{ status: 'written', brakeKey, candidateRuleIds }],
      failed: [],
      gaps: [...evidenceGaps],
    }
  } catch (error) {
    return {
      enabled: true,
      taken: [],
      failed: [{ status: 'failed', brakeKey, error: error instanceof Error ? error.message : String(error), candidateRuleIds }],
      gaps: ['app brake action failed', ...evidenceGaps],
    }
  }
}

async function notifyAfterBrake(
  env: Env,
  mode: SentinelMode,
  generatedAt: string,
  storageKey: string,
  actions: Snapshot['actions']['taken'],
  candidateRuleIds: string[],
  evidenceGaps: string[],
): Promise<Snapshot['notifications']> {
  if (!parseBoolean(env.SENTINEL_NOTIFY_WEBHOOK_ENABLED)) {
    return { enabled: false, sent: [], skipped: [], failed: [], gaps: [] }
  }
  const observeWouldBrake = mode === 'observe' && parseBoolean(env.SENTINEL_NOTIFY_OBSERVE_FINDINGS) && candidateRuleIds.length > 0
  const notifiableActions = observeWouldBrake
    ? [{ status: 'written' as const, brakeKey: 'observe-mode', candidateRuleIds }]
    : actions
  if (mode === 'observe' && candidateRuleIds.length > 0 && !observeWouldBrake) {
    return { enabled: true, sent: [], skipped: [{ reason: 'observe_findings_notification_disabled' }], failed: [], gaps: [] }
  }
  const url = env.SENTINEL_NOTIFY_WEBHOOK_URL?.trim()
  if (!url) {
    return { enabled: true, sent: [], skipped: [], failed: [], gaps: ['SENTINEL_NOTIFY_WEBHOOK_URL is not configured'] }
  }
  const kind = parseNotificationKind(env.SENTINEL_NOTIFY_WEBHOOK_KIND)
  const validatedUrl = validateWebhookUrl(url, kind)
  if (typeof validatedUrl === 'string') {
    return { enabled: true, sent: [], skipped: [], failed: [], gaps: [validatedUrl] }
  }

  const sent: Snapshot['notifications']['sent'] = []
  const skipped: Snapshot['notifications']['skipped'] = []
  const failed: Snapshot['notifications']['failed'] = []
  const gaps: string[] = []

  for (const action of notifiableActions) {
    // Notify only on fresh brake writes to avoid repeated-alert spam while a violation persists.
    if (action.status !== 'written') {
      skipped.push({ reason: 'action_status_not_notifiable' })
      continue
    }
    try {
      const response = await fetch(validatedUrl.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildWebhookPayload(kind, env, mode, generatedAt, storageKey, action.candidateRuleIds, evidenceGaps)),
      })
      if (response.ok) {
        sent.push({ kind, statusCode: response.status })
      } else {
        failed.push({ kind, statusCode: response.status, error: `webhook returned HTTP ${response.status}` })
        gaps.push(`webhook returned HTTP ${response.status}`)
      }
    } catch (error) {
      failed.push({ kind, error: error instanceof Error ? error.message : String(error) })
      gaps.push('webhook notification failed')
    }
  }

  return { enabled: true, sent, skipped, failed, gaps }
}

function pendingNotifications(env: Env): Snapshot['notifications'] {
  return {
    enabled: parseBoolean(env.SENTINEL_NOTIFY_WEBHOOK_ENABLED),
    sent: [],
    skipped: [{ reason: 'notification_pending_until_evidence_snapshot_is_written' }],
    failed: [],
    gaps: [],
  }
}

function buildWebhookPayload(
  kind: NotificationKind,
  env: Env,
  mode: SentinelMode,
  generatedAt: string,
  storageKey: string,
  candidateRuleIds: string[],
  evidenceGaps: string[],
) {
  if (kind === 'generic_json') {
    return {
      event: mode === 'observe' ? 'serverless_sentinel.observe_would_brake' : 'serverless_sentinel.app_brake_activated',
      generatedAt,
      storageKey,
      candidateRuleIds,
      evidenceGaps,
      actionTaken: mode === 'protect',
    }
  }
  return buildDiscordPayload(env, mode, generatedAt, storageKey, candidateRuleIds, evidenceGaps)
}

function buildDiscordPayload(
  env: Env,
  mode: SentinelMode,
  generatedAt: string,
  storageKey: string,
  candidateRuleIds: string[],
  evidenceGaps: string[],
) {
  const userId = normalizeDiscordUserId(env.SENTINEL_NOTIFY_DISCORD_USER_ID)
  const mention = userId ? `<@${userId}> ` : ''
  const observeMode = mode === 'observe'
  return {
    content: observeMode
      ? `${mention}Serverless Sentinel observe mode would have activated the app brake. No action was taken.`
      : `${mention}Serverless Sentinel activated the app brake.`,
    allowed_mentions: { parse: [], users: userId ? [userId] : [], roles: [] },
    embeds: [
      {
        title: observeMode ? 'Observe mode: app brake would activate' : 'App brake activated',
        color: observeMode ? 0xf59e0b : 0xdc2626,
        timestamp: generatedAt,
        fields: [
          { name: 'Snapshot', value: storageKey, inline: false },
          { name: 'Brake candidates', value: candidateRuleIds.join('\n') || 'unknown', inline: false },
          ...(evidenceGaps.length > 0 ? [{ name: 'Evidence warning', value: evidenceGaps.join('\n').slice(0, 1024), inline: false }] : []),
        ],
      },
    ],
  }
}

function parseNotificationKind(value: string | undefined): NotificationKind {
  return value?.trim() === 'generic_json' ? 'generic_json' : 'discord'
}

function parseSentinelMode(value: string | undefined): SentinelMode {
  return value?.trim() === 'protect' ? 'protect' : 'observe'
}

function protectModeActionGaps(env: Env, mode: SentinelMode, ledgerDb?: D1Database): string[] {
  if (mode !== 'protect') {
    return []
  }
  const gaps: string[] = []
  if (!parseBoolean(env.SENTINEL_D1_LEDGER_ENABLED) || !ledgerDb) {
    gaps.push('SENTINEL_MODE=protect requires LEDGER_DB and SENTINEL_D1_LEDGER_ENABLED=true')
  }
  if (!env.SNAPSHOTS_BUCKET) {
    gaps.push('SENTINEL_MODE=protect requires SNAPSHOTS_BUCKET')
  }
  if (!env.APP_BRAKE_DB) {
    gaps.push('SENTINEL_MODE=protect requires APP_BRAKE_DB')
  }
  return gaps
}

function applyModeActionGapsToPolicy(policy: Snapshot['policy'], rules: BudgetRule[], modeActionGaps: string[]) {
  if (modeActionGaps.length === 0) {
    return
  }
  policy.actionBlockingGaps.push(...modeActionGaps)
  policy.gaps.push(...modeActionGaps)
  const actionRuleIds = new Set(
    rules
      .filter((rule) => rule.level === 'critical' && rule.actionMode === 'eligible_after_gates')
      .map((rule) => rule.id),
  )
  for (const violation of policy.violations) {
    if (!actionRuleIds.has(violation.ruleId)) {
      continue
    }
    violation.actionBlocked = true
    violation.actionBlockReason = [violation.actionBlockReason, ...modeActionGaps].filter(Boolean).join('; ')
  }
  policy.brakeCandidates = []
}

function validateWebhookUrl(raw: string, kind: NotificationKind): URL | string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return 'webhook URL is not a valid URL'
  }
  if (parsed.protocol !== 'https:') {
    return 'webhook URL must use HTTPS'
  }
  if (kind === 'discord') {
    const hostname = parsed.hostname.toLowerCase()
    const isDiscordHost =
      hostname === 'discord.com' ||
      hostname === 'discordapp.com' ||
      hostname.endsWith('.discord.com') ||
      hostname.endsWith('.discordapp.com')
    if (!isDiscordHost || !parsed.pathname.startsWith('/api/webhooks/')) {
      return 'discord webhook URL must use a Discord webhook HTTPS endpoint'
    }
  }
  return parsed
}

function parseBudgetRules(raw: string | undefined, gaps: string[]): BudgetRule[] {
  if (!raw?.trim()) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      gaps.push('SENTINEL_BUDGETS_JSON must be an array')
      return []
    }
    const rules: BudgetRule[] = []
    parsed.forEach((item, index) => {
      const rule = parseBudgetRule(item, gaps, index)
      if (rule) {
        rules.push(rule)
      } else {
        gaps.push(`budget rule at index ${index} is not supported by the reference implementation Worker`)
      }
    })
    return rules
  } catch (error) {
    gaps.push(`SENTINEL_BUDGETS_JSON parse failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

function parseBudgetRule(value: unknown, gaps: string[], index: number): BudgetRule | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate = value as Record<string, unknown>
  const id = typeof candidate.id === 'string' ? candidate.id : null
  const metric = typeof candidate.metric === 'string' ? candidate.metric : null
  const windowTicks =
    typeof candidate.windowTicks === 'number' && Number.isInteger(candidate.windowTicks) && candidate.windowTicks > 0
      ? candidate.windowTicks
      : null
  const level: BudgetRule['level'] | null =
    candidate.level === 'warn' || candidate.level === 'critical' ? candidate.level : null
  const actionMode: BudgetRule['actionMode'] | null =
    candidate.actionMode === 'observe_only' || candidate.actionMode === 'eligible_after_gates'
      ? candidate.actionMode
      : null
  const requiredFreshness: BudgetRule['requiredFreshness'] =
    candidate.requiredFreshness === 'complete' || candidate.requiredFreshness === 'allow_partial'
      ? candidate.requiredFreshness
      : undefined
  if (!('requiredFreshness' in candidate)) {
    gaps.push(`budget rule at index ${index} is missing requiredFreshness`)
    return null
  }
  if ('requiredFreshness' in candidate && requiredFreshness === undefined) {
    gaps.push(`budget rule at index ${index} has invalid requiredFreshness`)
    return null
  }
  const metricScope: MetricScope | undefined =
    candidate.metricScope === 'configured_scripts' || candidate.metricScope === 'account'
      ? candidate.metricScope
      : undefined
  if (metric && isWorkerDeltaMetric(metric) && !('metricScope' in candidate)) {
    gaps.push(`budget rule at index ${index} is missing metricScope for Worker metric ${metric}`)
    return null
  }
  if ('metricScope' in candidate && metricScope === undefined) {
    gaps.push(`budget rule at index ${index} has invalid metricScope`)
    return null
  }
  const acceptsAccountWideBrake = candidate.acceptsAccountWideBrake === true
  if ('acceptsAccountWideBrake' in candidate && typeof candidate.acceptsAccountWideBrake !== 'boolean') {
    gaps.push(`budget rule at index ${index} has invalid acceptsAccountWideBrake`)
    return null
  }

  if (!id || !metric || !windowTicks || !level || !actionMode) {
    return null
  }
  const base = {
    id,
    metric,
    windowTicks,
    level,
    actionMode,
    requiredFreshness,
    metricScope,
    acceptsAccountWideBrake,
  }
  if (candidate.kind === 'absolute_units' && isPositiveFiniteNumber(candidate.max)) {
    return { ...base, kind: 'absolute_units', max: candidate.max }
  }
  if (
    candidate.kind === 'allowance_fraction' &&
    (candidate.allowancePeriod === 'daily' || candidate.allowancePeriod === 'monthly') &&
    isPositiveFiniteNumber(candidate.maxFraction)
  ) {
    return {
      ...base,
      kind: 'allowance_fraction',
      allowancePeriod: candidate.allowancePeriod,
      maxFraction: candidate.maxFraction,
      allowanceUnits: isPositiveFiniteNumber(candidate.allowanceUnits) ? candidate.allowanceUnits : undefined,
    }
  }
  return null
}

function parseAllowances(raw: string | undefined, gaps: string[]): Allowances {
  if (!raw?.trim()) {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      gaps.push('SENTINEL_ALLOWANCES_JSON must be an object')
      return {}
    }
    const allowances: Allowances = {}
    for (const [metric, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        gaps.push(`allowance for ${metric} must be an object`)
        continue
      }
      const periods = value as Record<string, unknown>
      allowances[metric] = {}
      if (isPositiveFiniteNumber(periods.daily)) {
        allowances[metric].daily = periods.daily
      }
      if (isPositiveFiniteNumber(periods.monthly)) {
        allowances[metric].monthly = periods.monthly
      }
    }
    return allowances
  } catch (error) {
    gaps.push(`SENTINEL_ALLOWANCES_JSON parse failed: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

function resolveBrakeExpiration(env: Env, nowMs: number): number | null {
  const mode = env.SENTINEL_APP_BRAKE_RELEASE_MODE?.trim() || 'manual'
  if (mode !== 'timed') {
    return null
  }
  return nowMs + parsePositiveInteger(env.SENTINEL_APP_BRAKE_PAUSE_MINUTES, 60) * 60_000
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

function parseBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true'
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeLedgerSeriesId(value: string | undefined, cadenceMinutes: number): string {
  const trimmed = value?.trim()
  return trimmed && /^[a-zA-Z0-9_.:-]{1,80}$/.test(trimmed) ? trimmed : `default-${cadenceMinutes}m`
}

function resolveTickWindow(cadenceMinutes: number, scheduledTimeMs: number): TickWindow {
  const cadenceMs = cadenceMinutes * 60_000
  const windowEndMs = Math.floor(scheduledTimeMs / cadenceMs) * cadenceMs
  return {
    tickId: Math.floor(windowEndMs / cadenceMs),
    windowStart: new Date(windowEndMs - cadenceMs),
    windowEnd: new Date(windowEndMs),
  }
}

function isQueueBinding(value: unknown): value is Queue<unknown> {
  return Boolean(value && typeof value === 'object' && typeof (value as { metrics?: unknown }).metrics === 'function')
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function normalizeDate(value: Date | string | number | null | undefined): Date | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) {
    return null
  }
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function normalizeDiscordUserId(raw: string | undefined): string | null {
  const trimmed = raw?.trim()
  return trimmed && /^\d{5,32}$/.test(trimmed) ? trimmed : null
}

function formatKeyTime(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

export const __test = {
  collectAndStoreSnapshot,
  collectWorkerMetrics,
  evaluateBudgetRules,
  parseBudgetRules,
  queryWindowUsage,
  resolveTickWindow,
  writeLedgerTick,
}
