# Audit Workflow

Audit first. Do not start by deploying a brake.

1. Inventory Cloudflare billable surfaces: Workers, Queues, D1, R2, Durable Objects, Containers, Workers AI, Vectorize, and any other account-specific products.
2. Identify producers: request handlers, queue consumers, scheduled jobs, Durable Object alarms, retries, repair loops, warmups, and operator endpoints.
3. Find loops and fanout paths where one event can create more work.
4. Identify admission and producer boundaries where a reversible brake check can stop new work.
5. Harden obvious runaway paths before adding automated action rules.
6. Document which platform usage signals and budget rules will protect each risky surface.

Classify each producer as one of:

- public admission or user-triggered request;
- scheduled task or cron;
- queue job payload;
- queue wake, doorbell, or continuation;
- retry, redrive, or DLQ replay;
- repair, reconcile, or backfill;
- warmup, probe, keepalive, or health check;
- operator/admin action;
- Durable Object alarm, event, or coordinator action;
- service-binding or internal Worker fanout;
- external API, model, or storage call trigger;


For each producer, answer:

- What event, request, schedule, alarm, or callback starts this producer?
- What durable state proves work should exist before it enqueues, redrives, calls, or fans out?
- Can one input create more than one downstream operation, message, request, storage write, or external call?
- Is there a stable logical identity or coalescing key for equivalent work?
- Does the chain have a bounded max count, max age, timeout, retry policy, or backoff?
- What happens when the producer or consumer finds no work to do?
- Are duplicate deliveries, retries, or callbacks idempotent across writes, completions, sends, and external effects?
- Does the path keep spending if product progress is stalled, impossible, or already complete?
- Which Cloudflare billable surfaces grow when this path loops?
- Which metric would distinguish legitimate work from a runaway or no-progress loop?

Hardening should favor durable truth before work creation, stable logical identities, coalescing for equivalent wakes, bounded fanout, bounded redrive, idempotent consumers and callbacks, no-op accounting, explicit failure release or expiry, and representative evidence before protect mode.

Output a short audit report with risky producers, current mitigations, proposed hardening, proposed brake check points, metrics to observe, configuration choices that need operator confirmation, and validation drills to run.
