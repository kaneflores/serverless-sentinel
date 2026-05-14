# Serverless Sentinel

Serverless Sentinel is a toolkit to integrate configurable brakes into your Cloudflare infrastructure to prevent runaway usage spending, as you see fit.
It is independent and is not affiliated or developed by Cloudflare.

It is designed for agent-assisted adoption: point an agent at this repository and have it audit your Cloudflare architecture. You adapt and extend the reference implementation Worker and budget rules to your app. The operator should review the audit, policy thresholds, brake scope, and validation evidence before enabling reversible brake protection, _especially_ in production. A brake on a production app could be disruptive, so be meticulous.

## What It Does

Serverless Sentinel observes and records Cloudflare platform usage, evaluates rolling budget rules, writes audit snapshots, activates a reversible app brake when configured critical rules trip, and sends a webhook notification after a fresh brake write.

It does not purge queues, delete resources, disable Workers, or perform destructive Cloudflare control-plane actions by default. It enables a brake action. You can extend this as you wish.

The intended adoption sequence is:

1. Map the parts of the app that can create billable Cloudflare work: public request handlers, scheduled jobs, queue producers and consumers, Durable Objects, D1 queries, R2 operations, Workers AI calls, and retry or repair paths.
2. Look for self-amplifying loops before adding automation. In Cloudflare infrastructure, these often look like a queue consumer that re-enqueues too aggressively, a scheduled Worker that keeps waking itself, a retry path that does expensive work after a no-op, or a fanout path where one event can create many downstream events without a durable coalescing key or hard limit.
3. Harden the obvious risky paths first. Prefer durable state before enqueueing, idempotent consumers, bounded retries, bounded fanout, stable wake identities, and no-op exits that stop spending.
4. Start in read-only observation mode. The first goal is to prove the sentinel can see the right usage signals, write snapshots, and describe normal idle and known-good workload behavior without being able to pause the app.
5. Configure rolling budget rules from two sources: observed traffic and operator-defined allowances. Observed traffic tells you what normal spikes and sustained workload look like; allowance budgets tell you how much of your hourly, daily, weekly, or monthly Cloudflare plan usage you are willing to spend in a given window.
6. Enable only narrow reversible brakes after controlled validation proves the action path. A brake should stop new work at clear admission or producer boundaries, notify you, and be easy to inspect and clear.

## Architecture

```mermaid
flowchart TD
  classDef resource fill:#eff6ff,stroke:#2563eb,color:#111827
  classDef data fill:#f8fafc,stroke:#64748b,color:#111827
  classDef process fill:#ecfdf5,stroke:#059669,color:#111827
  classDef decision fill:#fff7ed,stroke:#ea580c,color:#111827
  classDef output fill:#fefce8,stroke:#ca8a04,color:#111827
  classDef action fill:#fef2f2,stroke:#dc2626,color:#111827

  workers[Workers]:::resource
  queues[Queues]:::resource
  d1[D1]:::resource
  r2[R2]:::resource
  do[Durable Objects]:::resource

  usage[(Cloudflare Usage Signals)]:::data
  ledger[(D1 Metric Ledger)]:::data
  allowances[(Configured Usage Allowances)]:::data

  cron([Sentinel Worker Cron]):::process
  record([Write Usage Sample]):::process
  evaluate([Evaluate Rolling Budget Rules]):::process
  writePreAction([Attempt Pre-Action Snapshot]):::process
  writeSnapshot([Write Final Snapshot]):::process

  decision{Budget Exceeded?}:::decision

  noaction[No Action]:::output
  brake[Write Reversible App Brake]:::action
  snapshots[(R2 Snapshot)]:::output
  notify[Notification Webhook]:::output

  workers --> usage
  queues --> usage
  d1 --> usage
  r2 --> usage
  do --> usage

  usage --> cron
  cron --> record
  record --> ledger
  ledger --> evaluate
  allowances --> evaluate
  evaluate --> decision

  decision -->|no| noaction
  decision -->|yes| writePreAction
  writePreAction --> brake

  noaction --> writeSnapshot
  brake --> writeSnapshot
  writeSnapshot --> snapshots
  brake --> notify
```

## Agent Quick Start

This is an agent-assisted workflow, not a fully autonomous setup. The operator should review the audit, budget thresholds, brake scope, and validation evidence before enabling protect mode.

Give your coding agent a prompt like:

```text
Use the Serverless Sentinel skill in this repository to guide me through adapting it to my Cloudflare app. Start by auditing my architecture for runaway billable-operation risks, then identify the configuration choices I need to make before you adapt the reference implementation Worker, budget rules, and reversible app-brake checks. Do not enable protect mode until we have reviewed the policy thresholds, app-brake impact, notification setup, and validation evidence together.
```

Then the agent should:

1. Load `skills/cloudflare-sentinel/SKILL.md`.
2. Run the audit workflow against the target codebase and Cloudflare architecture.
3. Adapt the Cloudflare reference implementation Worker, D1 schemas, R2 snapshot bucket, and budget rules.
4. Add app-side brake checks at admission and producer boundaries.
5. Run the validation playbook before leaving actions enabled.

## How Agents Load It

Serverless Sentinel supports two loading modes:

- **Repository mode:** point an agent at this repository and instruct it to read `skills/cloudflare-sentinel/SKILL.md` first. This works with any coding agent that can read files from a repository.
- **Installed skill mode:** copy or install `skills/cloudflare-sentinel/` into the agent's skill directory, if the agent runtime supports skills. The skill metadata triggers the workflow, and the reference files are loaded only when needed.

In both modes, the skill is the workflow. The Worker, policy, migrations, and brake checks are reference implementations the agent adapts to the target architecture. 

## What You Provide

- Cloudflare account ID.
- Read-only Cloudflare observer API token for resource usage.
- R2 bucket for audit snapshots; required before protect mode.
- D1 database for the sentinel metric ledger; optional for observation, required for protect mode.
- Application state store for the reversible app brake; optional for observation, required for protect mode.
- Budget rules and allowance values that match the target Cloudflare plan and architecture.
- Optional webhook URL and Discord user ID, stored as platform secrets.

Most deployments require a configuration planning stage. The agent should recommend sensible choices for sentinel cadence, protected metrics, allowance values, policy thresholds, brake release mode, validation workload, notification channel, and sentinel mode, then confirm high-impact choices before enabling protect mode.

The bundled Workers Paid-shaped allowance and policy reference files are starting points for development or low-traffic validation. They can inform production configuration, but should not be copied into production blindly. Production thresholds should reflect real user traffic, legitimate peak workloads, support/on-call expectations, false-positive impact, and the cost of blocking new work for active users.

## Safety Model

- Observer credentials stay read-only.
- The default action is a narrow reversible app brake.
- Action writes use an app-owned state binding, not the read-only observer token.
- Protection notifications run only after a fresh successful brake write. Observe-mode would-brake notifications require explicit opt-in and must say no action was taken.
- Repeated active brakes do not spam notifications.
- Policy gaps, stale data, or unsupported metrics block action eligibility instead of guessing.
- Queue bindings are used for `metrics()` only; the reference implementation Worker must not call `send()` or `sendBatch()`.
- Destructive actions are intentionally out of scope for the default implementation.

## Policy Model

Budget rules are evaluated over `windowTicks`, where each tick is one scheduled sentinel run. With a five-minute cron, `1` tick is a spike check, `12` ticks is one hour, `288` ticks is one day, and longer windows are possible when the D1 ledger retains enough history.

The reference implementation policy shapes are:

- `absolute_units`: a metric exceeds a fixed unit cap in the window.
- `allowance_fraction`: a metric burns more than a configured fraction of a daily or monthly allowance.

Use `warn` rules for human-visible diagnostics and `critical` rules for action candidates. A critical rule should still require fresh enough data, a metric that is actually collected, and a reversible action path that matches the offender.

Every rule must explicitly choose `requiredFreshness`. Use `"allow_partial"` when the rule should be allowed to act on the data the sentinel has already observed, even if the full window is not available yet. This is useful for fast protection after first deploy, after missed telemetry, or when a partial window already shows enough usage to justify action. Use `"complete"` when the rule should only act after every tick in the window is present and clean. This is useful for strict accounting rules, but it can delay protection until the full window has been collected. It can also temporarily prevent action after a telemetry gap, because the sentinel no longer has a fully clean window until enough new clean ticks have accumulated.

Immediate protection should include short-window `allow_partial` spike rules; do not rely only on long `complete` windows for protect-mode action candidates.

Forecasting and projected burn-rate predicates are intentionally omitted from the default reference implementation. Reversible brakes should be based on observed usage windows unless an adopter designs and validates a forecasting model for their own system.

For larger policy sets, prefer code-owned presets or generated config modules over very large inline environment variables. Cloudflare Worker text bindings have practical size limits, and large JSON policy blobs are hard to review in dashboard settings.

Treat `references/cloudflare/policy/reference-workers-paid.json` as a dev-oriented Workers Paid reference policy. For production, use it as a starting shape only: define what normal traffic looks like, define which usage patterns are anomalous or risky relative to plan allowances, start with observe-only or warning rules, and promote critical action-eligible rules only after validating their user impact.

## Metric Source Caveats

Cloudflare GraphQL Analytics is a spend-pressure signal, not Cloudflare billing source of truth. Cloudflare's GraphQL Analytics docs say these datasets should not be used as the measure for usage that Cloudflare bills, because billable traffic can exclude activity that GraphQL still counts as measurable usage. GraphQL-backed allowance rules should therefore be treated as conservative anomaly guards rather than exact invoice or entitlement checks.

In our validation, Workers GraphQL Analytics worked well enough for five-minute sentinel ticks in a development environment with integration testing. That does not make it billing truth or prove the same freshness or accuracy profile for production traffic. Treat GraphQL-backed rules as conservative usage-pressure guards, validate them against your own workload, and account for Cloudflare's warning that GraphQL datasets can differ from billable usage.

Malformed GraphQL rows are not treated as clean zero usage. The reference implementation keeps valid rows as lower-bound evidence, records a telemetry gap, and allows action only when the trusted observed usage already exceeds the configured threshold. Rules that require complete freshness are blocked when lower-bound gaps are present.

## Repository Layout

```text
skills/cloudflare-sentinel/
  SKILL.md
  references/
    audit-workflow.md
    brake-design.md
    validation-playbook.md
    cloudflare-metrics.md

references/cloudflare/
  worker/
  migrations/
    ledger/
    app-brake/
  policy/
```

## Reference Implementation Worker

The Cloudflare reference implementation Worker is intentionally small. It shows the integration points an agent should adapt:

- queue binding `metrics()` sampling;
- Cloudflare GraphQL usage probing;
- R2 audit snapshots;
- D1 metric ledger writes;
- rolling budget rule evaluation;
- reversible app-brake writes;
- Discord-compatible webhook notification.

The bundled reference implementation currently collects only a starter set: Workers GraphQL additive deltas for `workers.requests`, `workers.errors`, and `workers.subrequests`, plus queue backlog and byte gauges from Queue binding `metrics()`. The workflow targets broader Cloudflare risks across Workers, Queues, D1, R2, Durable Objects, and other billable surfaces, but an adopter must expand metric collection before writing action-eligible rules for those surfaces.

Do not blindly collect every Cloudflare metric. During adaptation, choose only metrics that support a policy, alert, dashboard, or validation drill. Store additive per-tick usage as rolling usage metrics, keep "right now" values such as queue backlog as current-state diagnostics, and omit metrics for Cloudflare products the app does not use. For instance, an R2-heavy upload app should add app-scoped R2 operation metrics and policies; an app that does not use Workers AI should not collect Workers AI metrics.

The policy reference files include allowance-shaped budgets. Verify the current Cloudflare plan allowances and pricing for the target account before using allowance-fraction rules.

The reference implementation Worker collects a small starter set of signals. Before making a rule action-eligible, confirm the adapted Worker actually writes that metric into the D1 ledger.

Rolling windows require the D1 ledger. If the ledger is unavailable, the Worker can only evaluate explicit `windowTicks: 1` current-tick observations, and multi-tick rules are blocked from action eligibility. Do not rely on a multi-tick rule to degrade into a one-tick rule.

`SENTINEL_WORKER_SCRIPT_NAMES` controls the observed scope for Worker GraphQL request/subrequest metrics. When it is non-empty, `workers.*` metrics are scoped to those configured scripts and Worker rules should declare `"metricScope": "configured_scripts"`. When it is blank, `workers.*` metrics are account-wide and Worker rules should declare `"metricScope": "account"`.

Account-wide Worker rules can be useful for account-level spend protection. If an account-wide critical rule is allowed to brake, set `"acceptsAccountWideBrake": true` and understand the tradeoff: the default app brake only pauses code paths wired to read the brake, so it may not stop the Worker causing spend if that Worker is outside the brake integration. If a rule expects configured-script metrics but the sentinel collected account-wide metrics, or the reverse, action eligibility is blocked as a policy mismatch.

`SENTINEL_MODE` controls whether policy findings can mutate app state:

- `observe`: collect metrics, evaluate policies, write snapshots when R2 is configured, and never write the app brake.
- `protect`: allow the sentinel to write the app brake when critical policy candidates pass all gates.

Protect mode requires `LEDGER_DB`, `SENTINEL_D1_LEDGER_ENABLED=true`, `SNAPSHOTS_BUCKET`, and `APP_BRAKE_DB`. Missing protect-mode prerequisites block app-brake writes. A runtime R2 write failure after the bucket is configured does not block a valid brake; the Worker records the degraded evidence condition and proceeds using D1 policy evidence. Any protect-mode brake with failed R2 evidence should be investigated, and repeated brakes without successful snapshots indicate broken evidence storage or insufficient R2 permissions.

`SENTINEL_APP_BRAKE_KEY` names the app pause switch this sentinel controls. Use `global` for one whole-app brake. 

The D1 ledger uses `SENTINEL_LEDGER_SERIES_ID` as an explicit continuity boundary. Changing cadence should create a new series so old and new tick grids are not mixed in one rolling-window calculation.

Ledger rows are append-once for each `(series_id, metric, tick_id)`. The first successful write wins, which preserves fast cumulative boundary-subtraction math. The tradeoff is deliberate: if analytics later returns a more complete value for the same tick, the policy ledger keeps the original evidence instead of rewriting history. Delayed older ticks are skipped once a newer tick has advanced metric state; skipped ticks remain visible as missing data instead of corrupting cumulative rows.

For expected additive metrics, the reference implementation writes one metric row every tick. A successful read writes the observed value with `gap_count = 0`; a source failure writes `delta_value = 0` with `gap_count = 1`. Each row also stores cumulative usage, cumulative gap count, and `cumulative_recorded_tick_count`. Rolling policy checks can then subtract two boundary rows to compute usage, telemetry gaps, and recorded tick count without scanning every row in a long window.

The reference implementation ledger is append-only by default. It does not automatically prune old metric rows, because pruning adds retention math, boundary-row safety checks, and operational failure modes. The tradeoff is linear storage growth over time, plus gradually larger database indexes and backups. Query cost should remain bounded by indexed boundary lookups rather than total history size; even a 30-day window at a five-minute cadence is `8,640` ticks, and cumulative math needs the current row plus the row before the window, not a scan of all retained ticks.

## Retention and Pruning
Retention must keep at least the largest configured window plus one boundary row per metric; for instance, a 288-tick largest window needs at least 289 retained rows. Use a new ledger series or a custom bounded-sum/rollup design if corrected historical analytics are required.

If an adopter later adds pruning and accidentally removes the boundary row before a window, the reference implementation falls back to a bounded sum over retained in-window rows instead of subtracting from zero. That fallback is slower than the normal cumulative path, but it avoids overcounting and keeps observed in-window evidence usable for protection.

If you add retention, keep the latest accepted metric tick for each metric whenever the corresponding metric-state row is retained. Removing that latest tick while keeping state is treated as unsafe; future writes should stall for that metric rather than restart cumulative counters from incomplete evidence.

## Validation Evidence

Do not publish raw live snapshots by default. Publish sanitized evidence summaries instead: scenario, expected signal, observed signal, and reproduction steps.

Minimum credible proof before enabling protect mode:

- idle scheduled snapshot with no action candidates;
- known-good workload snapshots showing usage growth and recovery to normal state;
- manual brake proof showing admission or producer suppression without downstream fanout;
- observe-mode notification proof showing a would-brake message without app mutation;
- controlled one-tick drill that writes the brake from a temporary tiny threshold;
- repeated-violation proof showing an already-active brake is not rewritten or re-notified;
- degraded-evidence proof showing a runtime R2 write failure is recorded and does not block a valid D1-backed brake;
- restored-config proof showing normal policy, brake cleared, and no lingering candidates.

Install dependencies, run the focused tests, and typecheck the reference implementation only when working on it:

```bash
corepack enable
corepack prepare pnpm@10.33.4 --activate
pnpm install --frozen-lockfile
pnpm test
pnpm run check
```

## Package Security

This repo uses pnpm with a committed lockfile and strict install controls because the reference implementation Worker depends on ordinary JavaScript tooling such as Wrangler, TypeScript, and Vitest. JavaScript package installs can execute dependency lifecycle scripts, so installs should be treated as code execution.

The pnpm workspace is configured to reduce supply-chain risk:

- exact direct dependency versions;
- `pnpm-lock.yaml` for reproducible installs;
- `minimumReleaseAge` to avoid installing packages immediately after publication;
- `blockExoticSubdeps` to block transitive git/tarball-style dependency sources;
- `strictDepBuilds` so unexpected dependency build scripts fail the install;
- an explicit build allowlist for reviewed Cloudflare/tooling dependencies that need install scripts.

Use the lockfile-respecting install path:

```bash
corepack enable
corepack prepare pnpm@10.33.4 --activate
pnpm install --frozen-lockfile
```

When validating this repository as-is, use the lockfile-respecting pnpm install path above. If you adapt the reference implementation into an existing project that uses another package manager, preserve the same security posture: committed lockfile, pinned direct dependencies, reviewed lifecycle scripts, and reproducible CI installs. These controls reduce install-time risk, but they do not replace vulnerability monitoring, lockfile review, or dependency-update automation.

## Status

The first supported target is Cloudflare Workers, Queues, D1, R2, Durable Objects, and related billable surfaces. This project is independent and is not affiliated with Cloudflare.


## Credits

Created by Eric Phillips. Developed with Codex and GPT-5.5.
