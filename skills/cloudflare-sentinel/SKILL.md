---
name: cloudflare-sentinel
description: Audit and adapt Serverless Sentinel for Cloudflare Workers applications. Use when a user wants an agent to identify runaway billable-operation risks, harden admission and producer paths, configure usage-based budget rules, deploy a scheduled Cloudflare Worker sentinel, add a reversible app brake, and run validation drills.
---

# Cloudflare Sentinel

Use this skill to adapt Serverless Sentinel to a Cloudflare application.

## Workflow

1. Audit the app before generating automation. Read `references/audit-workflow.md`.
2. Run configuration planning before writing config. Recommend sensible settings and confirm operator choices using `## Configuration Planning`.
3. Identify Cloudflare platform usage signals available to the app. Read `references/cloudflare-metrics.md` when mapping metrics.
4. Design the reversible app brake and app-side checks. Read `references/brake-design.md`.
5. Adapt the reference implementation Worker, schema references, and budget rules under `references/cloudflare/`.
6. Run the validation playbook before leaving actions enabled. Read `references/validation-playbook.md`.

## Configuration Planning

Help the operator choose configuration in one planning stage. Recommend defaults from the audit and target environment, explain tradeoffs briefly, and confirm any high-impact choices before enabling protect mode.

- Sentinel cron cadence, balancing lower overhead against faster detection.
- Snapshot retention expectations and R2 bucket naming.
- How much rolling history to retain in the D1 Ledger.
- Cloudflare plan allowances per protected metric, verified from current plan/pricing docs.
- Policy thresholds by metric: absolute units, allowance fraction, severity, action mode, and freshness requirement.
- Metric selection: for each candidate metric, decide whether it is rolling usage, current-state diagnostic, or omitted because it does not support a policy, alert, dashboard, or validation drill.
- Which metrics should be warning-only and which may become action-eligible.
- Startup coverage: include short `allow_partial` spike rules if protect-mode action candidates should work before long complete windows have filled.
- For each high-risk billable surface, prefer at least one short-window `allow_partial` rule. A policy set made only of long `complete` windows has a startup blind spot and should not be considered ready for protect mode.
- Sentinel mode: start in `observe`; switch to `protect` only after D1 ledger, R2 snapshots, app-brake backend, policies, notifications, and validation drills are ready.
- Whether the target is dev, staging, or production. Treat bundled Workers Paid-shaped reference implementations as dev-oriented starting points and production starting shapes; production needs normal-traffic evidence, anomaly definitions, spend-risk tolerance, and user-impact review before action-eligible thresholds.
- Brake release mode: manual clear or timed pause.
- App-side brake storage backend and admission/producer check locations.
- Notification channel, if any: Discord webhook, generic JSON webhook, or none.
- Secret names and provisioning plan for observer token, Cloudflare Account ID, webhook URL, user/channel identifiers, and any app-action credential.
- Validation workload and controlled drill metric.

## Expected Outputs

- A short architecture audit listing risky billable-operation producers and hardening gaps.
- A tailored scheduled sentinel Worker configuration and metric coverage map.
- D1/R2 setup for the metric ledger, audit snapshots, and optional app brake.
- Budget rules that name metric, window, threshold kind, freshness requirement, severity, and action mode.
- App-side brake check locations at admission and producer boundaries.
- Validation evidence showing read-only observation, manual brake behavior, controlled action drill, repeated-active idempotence, and restored normal config.

## Rules

- Keep observer credentials read-only.
- Do not add queue purge, Worker deletion, resource deletion, or destructive control-plane actions by default.
- Store webhook URLs, API tokens, and user identifiers as platform secrets.
- Notify only after a fresh successful brake write.
- Treat reference implementations as adaptation sources. Replace names, bindings, budgets, schemas, and check locations for the target app.
- Treat repository tags as the skill version. Revalidate the adapted Worker when upgrading Wrangler, Workers compatibility dates, or Cloudflare API metric queries.
