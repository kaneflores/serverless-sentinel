# Cloudflare Reference Implementation

These files are a reference implementation for adapting Serverless Sentinel to a Cloudflare application.

They intentionally use placeholder names and IDs. Do not copy them blindly into production.

Contents:

- `worker/`: scheduled sentinel Worker reference implementation.
- `migrations/`: optional D1 schema references for a metric ledger and app brake.
- `policy/`: dev-oriented Workers Paid-shaped rolling budget rules, allowance value references, and controlled validation drills.

## Adaptation Checklist

1. Replace placeholder Worker, queue, R2, D1, and account values in `worker/wrangler.toml`.
   After adapting the config, run `pnpm --dir references/cloudflare/worker exec wrangler types` from the repository root if you want generated binding types for your local project.
2. Create a sentinel snapshot bucket.
3. Create the optional D1 ledger database and apply `migrations/ledger/0001_sentinel_ledger.sql` (but no protect mode without a Ledger)
4. Choose app-brake storage ownership. For a dedicated brake D1 database, keep the `APP_BRAKE_DB` binding and `migrations_dir = "../migrations/app-brake"` in `worker/wrangler.toml`. For an existing app-owned database, remove or adapt that migration path and apply `migrations/app-brake/0001_app_brake.sql` in the app's own migration flow. You can also adapt the Worker to another state backend.
5. Set the read-only observer token with Wrangler. Give this token only the read permissions required by the audit for analytics and inventory metadata.


For local `wrangler dev`, put any local-only secrets in `worker/.dev.vars` if the local run needs them. Do not commit `worker/.dev.vars`. The repository `.gitignore` excludes `.dev.vars`, `.env`, `*.local`, `.wrangler/`, `dist/`, `coverage/`, and `node_modules/`.

This reference implementation uses root-level Wrangler configuration. If you add Wrangler environments such as `[env.dev]` or `[env.production]`, duplicate the required bindings and vars under that environment and pass `--env <name>` to Wrangler commands. Wrangler environments do not automatically inherit every binding from the root config.

6. Start with `SENTINEL_MODE="observe"`.
7. Replace `SENTINEL_BUDGETS_JSON` with adapted rules from `policy/reference-workers-paid.json`.
8. Replace `SENTINEL_ALLOWANCES_JSON` with verified plan allowances. `policy/reference-allowances.json` is a shape reference, not a pricing source of truth.
9. Run the validation playbook before enabling protect mode.

When editing the reference implementation Worker, run from the repository root:

```bash
corepack enable
corepack prepare pnpm@10.33.4 --activate
pnpm install --frozen-lockfile
pnpm test
pnpm run check
```

This repo uses pnpm with a committed lockfile, delayed-package install settings, blocked exotic transitive dependencies, and an explicit build-script allowlist for reviewed Cloudflare/tooling dependencies. When validating this repository as-is, use the lockfile-respecting pnpm install path above. If you adapt the reference implementation into an existing project that uses another package manager, preserve the same security posture: committed lockfile, pinned direct dependencies, reviewed lifecycle scripts, and reproducible CI installs.

The reference implementation Worker is intentionally conservative. It currently collects Workers GraphQL additive deltas for `workers.requests`, `workers.errors`, and `workers.subrequests`, plus queue backlog and byte gauges from Queue binding `metrics()`. A production adaptation should expand metric coverage and budget rules based on the audit findings for the target app.

Choose metrics from the audit, not from a universal checklist. Store additive per-tick usage as rolling usage metrics, keep current-state values such as queue backlog as current-state diagnostics, and omit metrics for Cloudflare products the app does not use. For R2 policies, Class A/Class B operation counts may need to be derived from bucket/action operation metrics; exclude sentinel snapshot buckets from app-scoped R2 rules.

Rolling policy windows require the D1 ledger. Use `windowTicks: 1` for explicit current-tick observations; do not expect multi-tick rules to fall back to current-tick behavior when the ledger is disabled.

The Wrangler reference disables Workers Logs observability by default. Enable `[observability]` deliberately when you want dashboard logs for debugging or operations, and choose a sampling rate that matches the target traffic and cost tolerance.

`SENTINEL_WORKER_SCRIPT_NAMES` controls the observed scope for Worker GraphQL request/subrequest metrics. When it is non-empty, `workers.*` metrics are scoped to those configured scripts and Worker rules should declare `"metricScope": "configured_scripts"`. When it is blank, `workers.*` metrics are account-wide and Worker rules should declare `"metricScope": "account"`.

Account-wide Worker rules can be useful for account-level spend protection. If an account-wide critical rule is allowed to brake, set `"acceptsAccountWideBrake": true` and understand the tradeoff: the default app brake only pauses code paths wired to read the brake, so it may not stop the Worker causing spend if that Worker is outside the brake integration. Scope mismatches block action eligibility.

## Metric Source Caveats

Cloudflare GraphQL Analytics is a spend-pressure signal, not Cloudflare billing source of truth. Cloudflare's GraphQL Analytics docs say these datasets should not be used as the measure for usage that Cloudflare bills, because billable traffic can exclude activity that GraphQL still counts as measurable usage. GraphQL-backed allowance rules should therefore be treated as conservative anomaly guards rather than exact invoice or entitlement checks.

Malformed GraphQL rows and partial multi-script GraphQL failures create lower-bound telemetry gaps. Valid rows are still counted, and an `allow_partial` rule can remain action-eligible when trusted observed usage already exceeds the threshold. Use `requiredFreshness: "complete"` when lower-bound gaps should block action.

`SENTINEL_MODE` is the main operating-mode switch:

- `observe`: collect metrics, evaluate policies, write snapshots when R2 is configured, and never write the app brake.
- `protect`: allow the sentinel to write the app brake when critical policy candidates pass all gates.

Protect mode requires `LEDGER_DB`, `SENTINEL_D1_LEDGER_ENABLED=true`, `SNAPSHOTS_BUCKET`, and `APP_BRAKE_DB`. Missing protect-mode prerequisites block app-brake writes. A runtime R2 write failure after the bucket is configured does not block a valid brake; the Worker records the degraded evidence condition and proceeds using D1 policy evidence. Any protect-mode brake with failed R2 evidence should be investigated, and repeated brakes without successful snapshots indicate broken evidence storage or insufficient R2 permissions.

`SENTINEL_APP_BRAKE_KEY` names the pause switch this sentinel controls. Use `global` for one whole-app brake. Use narrower keys such as `ingest`, `embeddings`, or `tenant:<id>` only if the application has matching brake checks that read those keys. A non-global key does nothing unless the app checks that same key at admission or producer boundaries.

Keep `SENTINEL_LEDGER_SERIES_ID` tied to the cadence and metric schema. Changing `SENTINEL_CADENCE_MINUTES` should start a new ledger series, such as `default-2m`, so rolling windows do not mix incompatible tick grids.

Ledger metric ticks are append-once. A second run for the same `(series_id, metric, tick_id)` does not rewrite the D1 policy ledger; this keeps cumulative rolling-window math stable. The tradeoff is that later, more complete analytics for that same tick are not retroactively applied.

Delayed older ticks are skipped once a newer tick has advanced the metric state. That protects the cumulative ledger from out-of-order odometer corruption. The skipped tick remains visible to policy evaluation as missing data, so `complete` rules block and `allow_partial` rules can still act only from observed usage.

The ledger writes one row per expected additive metric per tick. Successful source reads write the observed value with no gap. Failed source reads write a zero-value row with a gap count, so future rolling windows remember that telemetry was missing instead of treating the failed tick as clean zero usage. Cumulative usage, cumulative gap count, and `cumulative_recorded_tick_count` let policy checks compute usage and freshness by subtracting boundary rows instead of scanning every retained row in the window.

This reference implementation does not prune the ledger automatically. That is deliberate: pruning adds retention math, boundary-row safety checks, and operational failure modes. The tradeoff is linear storage growth over time, plus gradually larger database indexes and backups. Rolling-window queries should stay bounded by indexed cumulative boundary lookups. A 30-day window at a five-minute cadence is `8,640` ticks, but the cumulative query needs the current row and the row before the window rather than a scan of all `8,640` rows.

Retention must keep at least the largest configured window plus one boundary row per metric; for instance, a 288-tick largest window needs at least 289 retained rows.

If the boundary row is missing but retained rows prove prior cumulative history existed, the Worker uses a bounded-sum fallback over the requested window. This is a slower defensive branch for unsafe retention/pruning states, not the normal query path.

If you later add pruning, never delete the latest accepted `sentinel_metric_ticks` row for a metric while leaving its `sentinel_metric_state` row behind. The write guard will skip future rows rather than restart cumulative math from unsafe state.

Only make a budget rule action-eligible after confirming the adapted Worker collects that metric and writes it to the ledger.

The bundled Workers Paid-shaped policy is a development reference and a starting shape for production adaptation. Production rules should be based on current plan allowances, observed normal traffic, expected peak user activity, anomaly definitions, spend-risk tolerance, and the user impact of a brake triggering. Start production with observe-only or warning rules before enabling reversible brake actions.

Every budget rule must declare `requiredFreshness`. Use `"allow_partial"` when observed usage should be allowed to trigger protection before the whole window is available or after a telemetry gap. Use `"complete"` when every tick in the window must be present and clean before the rule can act. Avoid relying only on long windows with `"complete"`: a complete 24-hour window cannot evaluate until 24 hours of ticks exist, and one telemetry gap can prevent action until that gap ages out of the rolling window. Pair long strict windows with short `allow_partial` spike rules if the sentinel should protect immediately after deployment.

Forecasting and projected burn-rate predicates are intentionally omitted from the reference implementation Worker. The bundled action predicates use observed usage windows only.

If the adapted policy set becomes large, move it into reviewed code or a generated preset instead of stuffing a large JSON blob into a Worker text binding.

For a controlled action drill, replace the metric and threshold in `policy/controlled-drill.json` with a harmless metric that reliably exceeds the positive threshold in the target dev environment. Restore the normal policy immediately after the drill.

If notifications are enabled, provision the webhook secrets separately after choosing the notification channel:

```bash
pnpm --dir references/cloudflare/worker exec wrangler secret put SENTINEL_NOTIFY_WEBHOOK_URL
pnpm --dir references/cloudflare/worker exec wrangler secret put SENTINEL_NOTIFY_DISCORD_USER_ID
```

`SENTINEL_NOTIFY_WEBHOOK_KIND` supports `discord` and `generic_json`. Discord mode validates that the secret points at a Discord webhook endpoint before sending.

Set `SENTINEL_NOTIFY_OBSERVE_FINDINGS=true` only when testing notifications in observe mode. Observe notifications are labeled as would-brake findings and do not mean app state was mutated.
