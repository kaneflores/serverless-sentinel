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

`workers.subrequests` is included as a fanout-pressure signal, not as a Workers Paid allowance metric; see the metrics reference before using it in policy.

Choose metrics from the audit, not from a universal checklist. Store additive per-tick usage as rolling usage metrics, keep current-state values such as queue backlog as current-state diagnostics, and omit metrics for Cloudflare products the app does not use. For R2 policies, Class A/Class B operation counts may need to be derived from bucket/action operation metrics; exclude sentinel snapshot buckets from app-scoped R2 rules.

Rolling policy windows require the D1 ledger. Use `windowTicks: 1` for explicit current-tick observations; do not expect multi-tick rules to fall back to current-tick behavior when the ledger is disabled.

The Wrangler reference disables Workers Logs observability by default. Enable `[observability]` deliberately when you want dashboard logs for debugging or operations, and choose a sampling rate that matches the target traffic and cost tolerance.

`SENTINEL_WORKER_SCRIPT_NAMES` controls the observed scope for Worker GraphQL request/subrequest metrics. When it is non-empty, `workers.*` metrics are scoped to those configured scripts and Worker rules should declare `"metricScope": "configured_scripts"`. When it is blank, `workers.*` metrics are account-wide and Worker rules should declare `"metricScope": "account"`.

Account-wide Worker rules can be useful for account-level spend protection. If an account-wide critical rule is allowed to brake, set `"acceptsAccountWideBrake": true` and understand the tradeoff: the default app brake only pauses code paths wired to read the brake, so it may not stop the Worker causing spend if that Worker is outside the brake integration. Scope mismatches block action eligibility.

## Worker Behavior And Pointers

The reference implementation Worker starts in `observe` mode. It can collect metrics, evaluate policies, and write snapshots without mutating app state. `protect` mode allows a critical policy candidate to write the reversible app brake after prerequisites and gates pass.

Only make a budget rule action-eligible after confirming the adapted Worker collects that metric and writes it to the ledger. The bundled Workers Paid-shaped policy is a development reference and a starting shape for production adaptation; start production with observe-only or warning rules before enabling reversible brake actions.

Detailed behavior lives in the skill references:

- Metrics, policy rules, GraphQL caveats, freshness, Worker metric scope, ledger continuity, and retention: `../../skills/cloudflare-sentinel/references/cloudflare-metrics.md`
- Reversible app-brake storage, brake keys, cache behavior, and protect-mode action semantics: `../../skills/cloudflare-sentinel/references/brake-design.md`
- Validation drills, evidence expectations, and controlled action tests: `../../skills/cloudflare-sentinel/references/validation-playbook.md`

For a controlled action drill, replace the metric and threshold in `policy/controlled-drill.json` with a harmless metric that reliably exceeds the positive threshold in the target dev environment. Restore the normal policy immediately after the drill.

If notifications are enabled, provision the webhook secrets separately after choosing the notification channel:

```bash
pnpm --dir references/cloudflare/worker exec wrangler secret put SENTINEL_NOTIFY_WEBHOOK_URL
pnpm --dir references/cloudflare/worker exec wrangler secret put SENTINEL_NOTIFY_DISCORD_USER_ID
```

`SENTINEL_NOTIFY_WEBHOOK_KIND` supports `discord` and `generic_json`. Discord mode validates that the secret points at a Discord webhook endpoint before sending.

Set `SENTINEL_NOTIFY_OBSERVE_FINDINGS=true` only when testing notifications in observe mode. Observe notifications are labeled as would-brake findings and do not mean app state was mutated.
