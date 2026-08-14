# Story 14 — `P1B-E1`, the single-harness loop and the readiness negative

Epic: `.agent/plan/epics/020-wiring-and-scenarios.md`
Depends on: Story 13.

## Change

### A new `scripts/e2e/lib/scenario/p1b-e1.ts`

Driver `local`, profile `fixture`, plan `three-objective`, mode `deterministic`. Follow the module shape of `scripts/e2e/lib/scenario/p1-e1.ts`: build the driver, build the profile, run, and export a `ScenarioDeclaration`.

```ts
const driver = await createLocalDriver(context);
const profile = await createFixtureProfile(context, driver, "three-objective");
const journey = await runJourney(context, driver, profile);
```

`runJourney` yields the project, the bound repository and the imported plan. Reuse it unchanged.

Then drive the whole external loop through the packaged binary, in this order. Every state is asserted **by node identity, never by count**.

1. `registerHarness(driver, "client", "p1b-e1-harness")` mints one harness identity.
2. `node list --state ready --kind task` returns the ready frontier of EPIC 016. Assert the returned identities equal exactly alpha's first task and beta's first task, sorted bytewise. Assertion name `ready-frontier`.
3. For each alpha task, in dependency order — alpha's first task then alpha's second:
   - `runHarnessTask` with the label `alpha-1` then `alpha-2`, and a distinct fixed object id per task, taken from `profile.expectedObjectIds`.
   - The first claim answers attempt number `1`.
   - After each report, `node show --id <task>` reads `done`. Assertion names `alpha-1-state` and `alpha-2-state`.
4. `attestObjective` with the label `alpha`, the fence the objective claim returned, and one combined object id. `node show --id <alpha>` then reads `awaiting_approval`, and returns that same `attestedObjectId` and the computed `projection`, both added to `NodeView` by `019-outcome-report.md:82`. Assertion names `alpha-state-attested`, `alpha-attested-object-id`, `alpha-projection`.
5. An attest by the **human** token is `403 actor-forbidden`. Issue it through `driver.issueAs("client", …)` with the configured token, and assert the status and the code. Assertion names `attest-human-status`, `attest-human-code`.
6. `node close --id <alpha>` with the **configured human token** moves alpha to `done`. Assertion name `alpha-state-closed`.
7. **`gamma` still reads `pending`**, because beta is not done, and beta's first task still reads `ready`. Assertion names `gamma-state-pending`, `beta-first-state-ready`.

### The declaration and the manifest land here

Record the assertion names in exactly the emission order above. In the same change:

- Add the `P1B-E1` entry to `scenarios` at `scripts/e2e/lib/scenario/index.ts:21`: mode `deterministic`, driver `local`, profile `fixture`, plan `three-objective`.
- Add the `P1B-E1` entry to `expectedAssertions` in `scripts/e2e/lib/scenario/assertions.ts`, composed as `[...fixtureProfileAssertionNames, ...journeyAssertionNames, ...<the names above, as a literal>]`.

Story 12 landed the axis, the ids and the floor mechanism and deliberately declared no scenario, so this story is the first that registers one.

### A new `scripts/e2e/lib/scenario/p1b-e1.test.ts`

Suite name `"scripts/e2e/lib/scenario/p1b-e1.test"`. Drive `run` over a fake driver and a recording context, in the shape `scripts/e2e/lib/scenario/p1-e4.test.ts` uses. Cases:

- `it("calls runJourney exactly once before it registers a harness", ...)`.
- `it("records its assertion names in the declared order", ...)` — assert the recorded names deep-equal the `P1B-E1` entry of `expectedAssertions`.
- `it("claims each alpha task in dependency order", ...)` — assert the recorded claim argv order.
- `it("asserts gamma pending by identity and never by count", ...)` — assert the recorded expected value is the node identity and its state.
- `it("builds the fixture profile on the three-objective axis", ...)`.

## Constraints

- **The scenario drives the CLI and direct HTTP only.** It opens no database, imports no `src/` service and calls no internal function.
- It asserts no fact `P1B-E2` establishes, and combines none.
- It runs one client. It names no second role.
- Every object id and every node id it sends is derived from a command's own output or from `profile.expectedObjectIds`. It mints none.
- No assertion restates a `node:test` case. Each one names a rule against the packaged binary and a running daemon.

## Verify

- `node --test scripts/e2e/lib/scenario/p1b-e1.test.ts` exits 0.
- `node scripts/e2e/run.mjs P1B-E1` exits 0, and the bundle records `pass` with the assertion names of the declaration.
- `npm run verify` exits 0.
- Proof: `scripts/e2e/lib/scenario/p1b-e1.test.ts`, and `node scripts/e2e/run.mjs P1B-E1`. Hermetic coverage: `020-wiring-and-scenarios.md:168`.
