# EPIC 010 — End-to-end scenarios

Status: **draft**.

## Goal

The packaged binary, the configuration discovery, the daemon lifecycle and the CLI-to-HTTP wiring are proven connected. P1-E1, P1-E2 and P1-E3 run through `scripts/e2e/run.mjs` and write evidence bundles.

## Non-goals

- No assertion that restates a `node:test` case through the CLI. A scenario that does is deleted, because it is a second specification that drifts.
- No live mode and no provider account. Phase 1 scenarios are `deterministic`, except P1-E3, which is `deployment`.

## Stories

- **The runner** — `scripts/e2e/run.mjs <id>`, with setup, invocation, assertion, cleanup, and every underlying command printed so a human reproduces any step by hand. One runner, not one script per scenario.
- **The evidence bundle** — the scenario id and schema version, the commit under test, the timestamp and host identity, the daemon and CLI versions, the fixture hashes, the pinned `git` version, the object ids involved, every assertion result, and sanitized logs.
- **P1-E1 — the onboarding journey** — register a credential, register the fixture remote with `--upstream`, import the two-objective fixture, export byte-identical, re-import at the same revision and at the previous one, read status, and confirm `kanthord run` exits non-zero with `not-implemented` and leaves status unchanged.
- **P1-E2 — the hostile client** — direct HTTP against the running daemon. No token is `401`, a wrong token is `401`, an `Origin` header is `403`, a `Host` outside the allow list is `403`, an allowed `Host` is `200`, and the daemon refuses to start on a non-loopback address with no token. The token is redacted in the evidence.
- **P1-E3 — the VPN run** — P1-E1 with the CLI on one host and the daemon on another. Every assertion goes through the public surface, and the ref layout is asserted through `repository show` rather than through the bare home directory.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node scripts/e2e/run.mjs P1-E1 && node scripts/e2e/run.mjs P1-E2 \
  && echo "PASS EPIC-010"
```

P1-E3 needs two reachable hosts. It carries `NEEDS-HUMAN:` until they exist, and it is the phase-1 exit criterion rather than a gate a laptop can run.
