# Story 16 — `P1B-E3`, the takeover

Epic: `.agent/plan/epics/020-wiring-and-scenarios.md`
Depends on: Story 15.

## Change

### A new `scripts/e2e/lib/scenario/p1b-e3.ts`

Driver `podman`, profile `fixture`, plan `two-objective`, mode `deterministic`. Its topology is the topology of `P1B-E2`. A takeover needs one task and no objective dependency, so it takes the two-objective plan.

**The daemon runs with `leaseTtlMs` of `2000`**, set through the `DaemonConfig` field Story 10 adds.

The phases run in this order.

1. `runJourney` from the first client, then one harness per client, as Story 15 registers them.
2. The first client claims one task through `node claim` and records its fence **and the expiry the claim response reports**. It then **stops calling `node heartbeat`**. Name `first-claim-status`, `first-fence`.

   **Every assertion that must observe the live lease runs before the reported expiry, and each one checks that it did.** Phase 3's first poll and the `state-before-stale-report` read both compare the current time against the recorded expiry and, if the expiry already passed, fail with `assertion-failed` naming the elapsed time rather than recording a misleading pass. A lease term of `2000` ms gives ample margin for one command, and a process pause long enough to break it is a real failure rather than a flake to absorb.

   **Synchronise on the reported expiry, never on a fixed sleep.** The scenario computes its poll window from the claim response's expiry, and issues no `sleep` of a lease term.

3. The second client polls `node claim` on that same task every **250 ms** to a deadline of **60000 ms**. Every answer before the expiry is `409 lease-held`. The first `200` after it carries a **new** fence, asserted **greater than** the first. Names `poll-refused-before-expiry`, `takeover-status`, `takeover-fence-greater`.

   Recovery is claim-driven, so each poll runs the sweep and no background timer exists. **The scenario waits on wall clock, and it controls no clock**, because the daemon exposes no time API. The deadline is thirty times the lease term, which absorbs CI and container scheduling variance.

   On timeout, keep the diagnostics: record the elapsed time, the last status and the last body, then fail with `assertion-failed`.

4. The first client calls `node report --outcome accepted --fence <old fence>` and receives `409 lease-held`. Name `stale-report-status`.
5. **The non-effect is proved by three observables and never by a node field**, because a task carries no reported object id and `node show` proves nothing about one:
   - the stale report response is `409 lease-held`;
   - `node show` reads `running` before it and `running` after it — names `state-before-stale-report`, `state-after-stale-report`;
   - `kanthord event list --type outcome.reported --subject <task id>`, run with the configured human token, prints **exactly one** record for that task after the second client reports, and that record names the **second** actor — names `outcome-events-count`, `outcome-event-actor`.
6. The second client's report then moves the task to `done`. Name `takeover-report-status`, `final-state-done`.

Record the observed takeover latency as a bundle note. It is **diagnostic**, and no assertion reads it.

### The declaration, the manifest and the last discipline case land here

In the same change as the scenario module:

- Add the `P1B-E3` entry to `scenarios` at `scripts/e2e/lib/scenario/index.ts:21`: mode `deterministic`, driver `podman`, profile `fixture`, plan `two-objective`.
- Add the `P1B-E3` entry to `expectedAssertions`, composed in emission order.
- Add the `it("every declared scenario id holds an expectedAssertions entry", ...)` case to `scripts/e2e/lib/scenario/discipline.test.ts`, which Story 12 deferred to here. All seven ids now hold an entry, so the case is total and green.

### A new `scripts/e2e/lib/scenario/p1b-e3.test.ts`

Cases over a fake driver and a recording context:

- `it("configures the daemon with a lease term of 2000 ms", ...)` — assert the `DaemonConfig` field.
- `it("polls at 250 ms to a 60000 ms deadline", ...)` — assert the interval and the deadline against a fake clock in the test, never against wall clock.
- `it("sleeps no lease term", ...)` — assert no single wait exceeds the poll interval.
- `it("asserts the takeover fence is greater than the first", ...)` — drive a fake returning a smaller fence and assert the scenario fails.
- `it("keeps its diagnostics on timeout", ...)` — drive a fake that never yields a 200 and assert the recorded elapsed time, last status and last body.
- `it("asserts exactly one outcome.reported record naming the second actor", ...)` — drive a fake printing two records and assert the scenario fails.
- `it("records its assertion names in the declared order", ...)`.

## Constraints

- **It controls no clock and it sleeps no lease term.** The wall-clock dependency is stated in the scenario file, in the module's own exported description rather than a comment. `020-wiring-and-scenarios.md:38` settles this: `deterministic` is the runner mode axis and not clock control, and the daemon exposes no time API. Do not add one, and do not propose a controllable clock — that is a settled decision, not an open question.
- **The hermeticity rule of `AGENTS.md` governs the `node:test` suite, not a scenario.** A scenario drives a packaged binary and a running daemon by design. `p1b-e3.test.ts` itself stays hermetic and drives every timing case through a fake clock.
- **No assertion that must observe a live lease may run after the reported expiry.** Each such assertion checks the elapsed time against the recorded expiry and fails loudly rather than passing on a stale observation.
- It asserts no node field for the non-effect. Three observables, exactly.
- It takes the `two-objective` plan axis, never `three-objective`.
- It opens no database and imports no `src/` service.
- It drives no merge.

## Verify

- `node --test scripts/e2e/lib/scenario/p1b-e3.test.ts` exits 0.
- `node scripts/e2e/run.mjs P1B-E3` exits 0.
- After a passing run and after a failing run, no resource carrying the run id remains.
- `npm run verify` exits 0.
- **The whole Proof block of the EPIC runs here, as the closing gate of the epic.** Every named path, then `P1B-E1`, `P1B-E2`, `P1B-E3`, then the three phase-1 regression runs `P1-E1`, `P1-E2` and `P1-E4`, ending in `PASS EPIC-020`. The three phase-1 ids run because the plan axis, the topology resource ledger and the driver interface all changed under them, and those are the three regression risks `020-wiring-and-scenarios.md:178` names.
- Proof: `scripts/e2e/lib/scenario/p1b-e3.test.ts`, `node scripts/e2e/run.mjs P1B-E3`, and the complete Proof block. Hermetic coverage: `020-wiring-and-scenarios.md:172`, `:173`, `:177`, `:178`.
