# Cloudflare Metrics

Serverless Sentinel uses Cloudflare platform usage signals.

Use official Cloudflare docs when adapting metric access. Some relevant observability APIs are new or fast-moving, especially Queues realtime backlog metrics.

Sources used:

- Cloudflare GraphQL Analytics for time-window usage buckets.
- Queue binding `metrics()` for current queue backlog and oldest message age.
- D1 ledger tables for rolling-window budget evaluation.
- R2 snapshots for audit history.
- Verified plan allowance values for allowance-fraction rules.

Useful metric families:

- Queues: billable operations, retry counts, backlog count, backlog age.
- Workers: requests, errors, subrequests, CPU time when available.
- D1: rows read, rows written, query counts, latency when available.
- Durable Objects: requests and storage read/write metrics when available.
- R2: operation counts by bucket/action when available, derived Class A/Class B operation counts when operation detail is sufficient, response bytes, storage/object context when available.

The reference implementation Worker is not a complete Cloudflare metrics collector. During adaptation, add product-specific metrics for the target app's actual billable surfaces. For instance, if the app uses Workers AI, add the relevant usage metrics such as requests or tokens where available. If the app uses Durable Objects heavily, add DO request or storage read/write metrics where available. Do not add those metrics for apps that do not use those products.

Prefer metrics that can be collected by a scheduled Worker without interactive CLI state.

Metric selection rule:

Do not blindly collect every Cloudflare metric. During the audit, identify the app's actual billable surfaces and select only metrics that support a policy, alert, dashboard, or validation drill. For each candidate metric, choose one role:

- Store as a rolling usage metric when each tick represents new usage that can be added over time, such as requests, rows read, rows written, operations, tokens, or bytes transferred.
- Keep as a current-state diagnostic when the value is a "right now" reading, such as queue backlog, oldest message age, active consumers, or current storage size. These values should not be added across ticks as if they were new usage.
- Omit the metric when the app does not use that Cloudflare product, when the value does not support a policy, alert, dashboard, or validation drill, or when collecting it would add noise without improving protection.

Reference implementation cases:


- If the app writes user uploads to R2, collect R2 operation metrics for the app buckets. When the source exposes enough operation or action detail, derive app-scoped Class A and Class B operation counts and use those in rules that protect against runaway write/list/read loops. Exclude sentinel-owned buckets such as the snapshot bucket from app-scoped R2 policies.
- If the app does not use Workers AI, Durable Objects, or another Cloudflare product, do not collect metrics for that product.
- If queue backlog helps explain a runaway but is not billable usage itself, keep it as a current-state diagnostic and pair it with operation/retry/billable-operation metrics when queue spend protection is needed.
- If a metric does not feed a rule, alert, dashboard, or validation drill, remove it.

The class (A or B) of an R2 operation may need to be derived. Query R2 operation metrics by bucket/action when available, map action types into the current Cloudflare Class A/Class B billing categories, and exclude sentinel-owned buckets from app-scoped R2 policies.

Use this split:

- GraphQL Analytics: delayed or approximate trend and billable-pressure context.
- Queue binding `metrics()`: realtime per-queue state for backlog and age.
- D1 sentinel ledger: exact rolling-window math over the metrics the sentinel has already collected.
- Wrangler or dashboard views: useful for humans, but not an unattended production control plane.

Cloudflare's GraphQL Analytics docs say GraphQL datasets should not be used as the measure for usage that Cloudflare bills. Billable traffic can exclude activity that GraphQL still counts as measurable usage (like DDOS protection), so GraphQL-backed allowance rules should be treated as conservative guards rather than exact invoice or entitlement checks. It seems the risk is overcounting usage, rather than undercounting; but users must weigh their desire for guardrail spending against their disclaimer.

In Serverless Sentinel validation, Workers GraphQL Analytics worked for five-minute ticks in a development environment with integration testing. Do not assume that proves production freshness or billing accuracy; validate GraphQL-backed rules against the target workload. 

Every metric in the adapted report should be labeled for:

- source: API, binding, D1 ledger, Wrangler-only, or unavailable;
- freshness: realtime, delayed, approximate, or unknown;
- action usability: safe for future Worker/cron action evaluation or diagnostic only.

Do not treat bundled allowance references as pricing documentation. Confirm current Cloudflare plan limits and operation classes before enabling action-eligible budget rules.

Operator-configured choices:

- Cron cadence controls sentinel overhead and detection opportunity. Shorter intervals run the sentinel more often, which increases Worker invocations, R2 snapshot writes, D1 ledger operations, and API calls. They can improve perceived protection from rapid billable usage over a handful of minutes, especially for realtime sources such as queue binding `metrics()`, but may not improve freshness for delayed or approximate GraphQL Analytics datasets.
- Treat cadence changes as a ledger boundary. If cadence changes, start a new ledger series instead of mixing old and new tick IDs in one rolling-window sequence.
- Rolling windows require the D1 ledger. Use explicit one-tick rules for current-tick observations; multi-tick rules should not degrade to current-tick behavior when the ledger is unavailable.
- Store D1 metric ticks as append-once policy evidence. First write wins for each `(series_id, metric, tick_id)` so cumulative boundary-subtraction remains stable. This intentionally gives up retroactive correction of a tick if analytics later returns a different value.
- Enforce monotonic tick acceptance per metric. If an older delayed tick arrives after a newer tick advanced `sentinel_metric_state`, skip it rather than inserting an out-of-order cumulative row. The skipped tick becomes missing data for the affected windows.
- For every expected additive metric, write a row each tick. Source success writes the observed delta with `gap_count = 0`; source failure writes `delta_value = 0` with `gap_count = 1`. The row should carry cumulative usage, cumulative gap count, and `cumulative_recorded_tick_count` so policy math can subtract boundary rows for usage, gap count, and freshness.
- Do not add pruning by default. Let the ledger be append-only until linear storage growth, larger indexes, backup/export size, or insert overhead justify the added correctness burden. Cumulative policy queries should stay bounded by indexed boundary lookups, not total retained history. At a 5-minute cadence, a 30-day window is `8,640` ticks, but cumulative usage only needs the current row and the row immediately before the window.
- If pruning is added later, keep the latest accepted metric tick whenever `sentinel_metric_state` for that metric is retained. Deleting the latest metric tick while keeping state is unsafe; the writer should skip future rows rather than restart cumulative counters from incomplete evidence.
- Retained ledger history must cover the largest configured window plus one boundary row per metric because cumulative subtraction needs the row immediately before the window. For a 5-minute cadence, `288` ticks is one day and `2016` ticks is seven days, so a seven-day maximum window needs at least `2017` retained rows per metric.
- If retention/pruning removes the boundary row but retained rows prove prior cumulative history existed, fall back to bounded `SUM(delta_value)`, `SUM(gap_count)`, and `COUNT(*)` over the requested window. This defensive branch is slower, but avoids overcounting from subtracting a missing boundary as zero.
- Treat malformed analytics rows and partial multi-script source failures as lower-bound telemetry gaps, not clean zero usage. Keep valid rows, record the gap, and allow action only when trusted observed usage already exceeds the threshold. `requiredFreshness: "complete"` should block action when lower-bound gaps are present.
- Allowance values should come from the operator's actual plan and current pricing docs, not from reference implementations.
- Thresholds should be chosen per metric. Sparse dev projects often benefit from allowance-fraction or fixed absolute-unit rules more than learned p95 baselines.
- Production thresholds can use dev references as a starting shape, but should be tuned from known-good workload evidence, expected peak traffic, anomaly definitions, spend-risk tolerance, and brake impact before a rule becomes action-eligible.
- Freshness requirements should match the metric source. Realtime queue backlog can be strict; delayed GraphQL analytics may need explicit delay/gap handling.
- For Workers GraphQL metrics, align rule scope with observed scope. A non-empty `SENTINEL_WORKER_SCRIPT_NAMES` collects `workers.*` metrics for the configured script list and rules should use `metricScope: "configured_scripts"`. A blank script list collects account-wide `workers.*` metrics and rules should use `metricScope: "account"`.
- Account-wide Worker rules can protect account-level spend, but the default app brake only affects code paths wired to read the brake. If an account-wide critical rule may brake, require `acceptsAccountWideBrake: true` and warn that the brake may not reach the Worker causing spend if it is outside the brake integration.
- Treat Cloudflare GraphQL Analytics as usage-pressure context, not exact billing truth. Use conservative thresholds and explain false-positive and other user impact before enabling actions.
- Every rule must explicitly declare `requiredFreshness`. Use `"allow_partial"` when observed data should be allowed to trigger protection even if the full window is not available yet. Use `"complete"` when every tick in the window must be present and clean. Complete windows are useful for strict accounting, but they can delay protection after first deploy and temporarily prevent action after a telemetry gap until enough new clean ticks accumulate.
- For each high-risk billable surface, prefer at least one short-window `allow_partial` rule. Long `complete` windows are useful for strict accounting, but a policy set made only of long complete windows has a startup blind spot and should not be considered ready for protect mode.
- Forecasting and projected burn-rate predicates are intentionally omitted from the default reference implementation. Reversible brakes should be based on observed usage windows unless the adopter designs and validates a forecasting model for their own system.

Official reference starting points:

- Cloudflare GraphQL Analytics API: `https://developers.cloudflare.com/analytics/graphql-api/`
- GraphQL API limits: `https://developers.cloudflare.com/analytics/graphql-api/limits/`
- Queues metrics: `https://developers.cloudflare.com/queues/observability/metrics/`
- Queues JavaScript APIs: `https://developers.cloudflare.com/queues/configuration/javascript-apis/`
- Queues realtime backlog changelog, Apr 28 2026: `https://developers.cloudflare.com/changelog/post/2026-04-28-improved-queues-metrics/`
- Queue REST metrics endpoint: `https://developers.cloudflare.com/api/resources/queues/methods/get_metrics`
- Workers metrics and analytics: `https://developers.cloudflare.com/workers/observability/metrics-and-analytics/`
- D1 metrics and analytics: `https://developers.cloudflare.com/d1/observability/metrics-analytics/`
- D1 billing metrics: `https://developers.cloudflare.com/d1/observability/billing/`
- Durable Objects metrics and analytics: `https://developers.cloudflare.com/durable-objects/observability/graphql-analytics/`
- R2 metrics and analytics: `https://developers.cloudflare.com/r2/reference/metrics-analytics/`
- Containers metrics with GraphQL: `https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/`
