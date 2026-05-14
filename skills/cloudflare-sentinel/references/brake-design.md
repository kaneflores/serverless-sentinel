# Brake Design

The default action is a reversible app brake.

The sentinel writes a narrow brake record in D1 when a critical budget rule becomes a brake candidate. Application code reads that record at bounded admission and producer boundaries, then suppresses new work while allowing existing cleanup or operator recovery paths as appropriate. The initial version uses D1 over KV, but I'm sure someone could propose KV for the app brake state and have it meet their needs better.


Operating modes:

- `observe`: collect metrics and evaluate policies, but never write the app brake.
- `protect`: allow app-brake writes after critical policy candidates pass all gates.

Protect mode requires a D1 metric ledger, R2 snapshot bucket, and app-brake write backend to be configured. D1 is required because it is the rolling-window policy evidence. R2 is required as configured audit storage, but a runtime R2 write failure must not prevent a valid brake: record the degraded evidence condition in snapshot/action gaps, include it in notifications when possible, and proceed using D1 policy evidence. Any protect-mode brake with failed R2 evidence should be investigated.

`SENTINEL_APP_BRAKE_KEY` names the pause switch the sentinel controls. Use `global` for one whole-app brake. Use narrower keys, such as `ingest`, `embeddings`, etc, only when the application has matching brake checks that read those same keys. A non-global key has no effect unless the app checks that key at its admission or producer boundaries. Default is just `global`. 

Recommended brake state fields:

- `brake_key`
- `enabled`
- `reason`
- `source`
- `set_at_ms`
- `expires_at_ms`
- `updated_at_ms`

Release modes:

- `manual`: no expiration; an operator clears the brake.
- `timed`: set `expires_at_ms` from a configured pause duration.

Recommend a release mode from the risk profile, then confirm it with the operator. Manual release is safer for real runaway-spend protection because it stays paused until a human investigates. 

Check placement:

- public admission before new durable work is created;
- queue or scheduled producers before optional downstream work is enqueued;
- warmup, probe, repair, reconcile, and operator nudge paths before they create more work.

Avoid checking every internal function. Keep checks at bounded entry points and producer boundaries.

Cache guidance:

Mental model:

1. Sentinel cron detects and writes the brake.
   - Runs every configured cadence.
   - Reads usage metrics.
   - If policy violates, writes durable brake state.
2. App brake checks enforce the brake.
   - Run at upload admission, public admission, queue producer, scheduled repair, or other producer boundaries.
   - Read durable brake state.
   - Block or allow new work.
3. Cache reduces repeated reads.
   - If the last check saw `off`, the app can reuse "allowed" briefly.
   - If the last check saw `on`, the app can reuse "blocked" a little longer.
   - Without the cache, every checked boundary does a brake-store read.
   - With the cache, each warm Worker isolate reads the brake store at most once per TTL window for that brake key.

The cache is only a performance optimization; the durable brake record remains authoritative.

- Cache `off` briefly. `off` means work is allowed, so a stale `off` decision can admit extra work after the sentinel has enabled the brake. Keep this TTL short enough for the operator's risk tolerance.
- Cache `on` longer. `on` means work is blocked, so a stale `on` decision is conservative during an incident. A longer TTL reduces repeated brake-store reads while the system is already paused.
- Use separate TTLs for `off` and `on`. A common starting point is seconds for `off` and tens of seconds for `on`, then tune based on traffic volume, brake-store latency, and how quickly producers must stop.
- Cap any cached `on` decision at `expires_at_ms`. Timed brakes must not keep blocking after their configured release time just because an isolate cached the active state.

Credential split:

- observer token reads analytics and inventory only;
- action path writes only the app-owned brake state through a narrow binding usually
- do not give the observer token queue purge, Worker write, R2 write, D1 write, Secrets Store, or broad account mutation permissions by default.

If the app brake uses D1, remember that a D1 binding grants the sentinel Worker access to that database, not only one table. Prefer a dedicated brake database/table or an adapter with the narrowest practical write surface when adapting this pattern to production.

Notification rule:

- Send after a fresh successful brake write.
- Skip repeated already-active ticks.
- Record notification failures, but do not undo or block the brake.
- In observe mode, send would-brake notifications only when the operator explicitly enables observe finding notifications. The message must say no app-brake action was taken.

Notification configuration is operator-specific. Recommend a simple channel based on the operator's incident workflow, such as a Discord-compatible webhook for phone alerts, another webhook endpoint, or no notification for observe-only deployments. Store webhook URLs and user/channel identifiers as secrets unless the operator explicitly chooses public config for non-sensitive identifiers.
