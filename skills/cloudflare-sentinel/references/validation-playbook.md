# Validation Playbook

Run validation in a non-production environment first.

Before live drills, run the reference implementation Worker test suite after any policy or ledger change:

```bash
corepack enable
corepack prepare pnpm@10.33.4 --activate
pnpm install --frozen-lockfile
pnpm test
pnpm run check
```

1. No-action snapshot: run the scheduled sentinel with normal rules and confirm no brake candidates.
2. Manual brake check: enable the brake manually and confirm an app admission or producer boundary blocks new work.
3. Clear check: clear the brake and confirm the same path admits work again.
4. Controlled predicate drill: temporarily configure a harmless one-tick rule for a known nonzero additive delta metric collected by the Worker. Replace the placeholder metric and positive threshold in `references/cloudflare/policy/controlled-drill.json` before using it.
5. Observe notification proof: in `observe` mode, enable observe finding notifications and confirm the message says the brake would have activated but no action was taken.
6. Fresh brake proof: switch to `protect` mode only after D1 ledger, R2 snapshots, and app-brake storage are configured, then confirm the sentinel writes the brake and sends one notification.
7. Repeated-active proof: leave the drill active for one more tick and confirm the brake is already active and no second notification is sent.
8. Tick math proof: run two adjacent ticks with known synthetic or controlled deltas and confirm their collection windows are adjacent, non-overlapping, gap-free, and produce the expected rolling usage.
9. Source-gap proof: force or mock one expected additive metric source failure and confirm the ledger records zero-value metric rows with nonzero gap counts, then confirm affected action candidates are blocked.
10. R2 evidence degradation proof: in a non-production drill, simulate or mock a pre-action R2 snapshot failure and confirm a valid protect-mode brake still writes while the snapshot/action gaps report degraded evidence.
11. Restore: restore normal rules, return to `observe` if the deployment is not ready for protection, clear the brake, and confirm a final no-action snapshot.

Minimum evidence to capture:

- snapshot key for the no-action run;
- app-brake status before and after manual enable/clear;
- snapshot key for the controlled drill;
- observe notification result showing no action was taken;
- notification result for the fresh brake write;
- repeated-active result showing no second notification;
- tick math evidence showing adjacent window bounds and expected rolling usage;
- source-gap evidence showing durable gap rows and blocked action eligibility;
- degraded-evidence result showing R2 write failure did not block a valid D1-backed brake;
- final restored snapshot key.

Action-mode drill rules:

- save the normal config before the drill;
- use a temporary tiny threshold on a harmless nonzero metric;
- enable only the narrow reversible action adapter;
- verify the app-owned brake row or state record, not just logs;
- verify a risky admission or producer path is blocked without downstream fanout;
- restore normal policy and clear the brake immediately after the drill.


Do not leave temporary drill rules active after validation.
