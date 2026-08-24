# Story 12 — The scenario declarations, the runner axes and the assertion floor

Epic: `.agents/plan/epics/020-wiring-and-scenarios.md`
Depends on: Story 8, Story 11.

## Change

### The three ids, in three lists

`ScenarioId` is declared once and copied twice. All three lists gain `P1B-E1`, `P1B-E2` and `P1B-E3`, in that order, after `P1-E5`:

- `scripts/e2e/lib/tag.ts:6` — the `ScenarioId` union.
- `scripts/e2e/lib/main.ts:44-48` — `knownScenarioIds`.
- `scripts/e2e/lib/record/verdict.ts:20-25` — `knownScenarioIds`, so EPIC 025 cannot close the block on a partial run.

`tagPattern` at `scripts/e2e/lib/main.ts:55` validates `--tag` only and is not edited.

`--daemon-host` and `--client-host` are already refused unconditionally at `scripts/e2e/lib/main.ts:611-622`, before any per-id branch. **Add no code for that refusal.** Add one case per new id to `scripts/e2e/lib/main.test.ts` asserting `invalid-argument` for each flag.

### No declaration lands here

`scripts/e2e/lib/scenario/index.ts:21` gains **no entry in this story**. A declaration references a scenario module, and no scenario module exists yet. **Each of Stories 14, 15 and 16 adds its own declaration entry and its own `expectedAssertions` manifest, in the same change as its scenario module.** That keeps every story green and removes any need for a placeholder.

This story lands the `plan` axis on the `ScenarioDeclaration` type, the three ids in the three lists, and the floor mechanism. `expectedAssertions` lands here holding the four phase-1 entries only.

### The assertion floor

**A passed bundle with no assertion is possible today**, because the runner enforces no minimum: an empty scenario file plus a declaration reaches `PASS EPIC-020`.

1. **The expected fragments are independent literals, and no producer exports its own expectation.** A list derived from the row table that drives emission is a tautology: deleting a transport row would shrink the recorded names and the expected names together, and every test would still pass. The expectation must be able to disagree with the code.

   A new `scripts/e2e/lib/scenario/assertions.ts` holds every fragment as a hand-written ordered literal, and imports nothing from `journey.ts`, `fixture.ts` or `transport.ts`:

   ```ts
   export const journeyAssertionNames: readonly string[] = [ ... ];
   export const fixtureProfileAssertionNames: readonly string[] = [ ... ];
   export const transportAssertionNames: readonly string[] = [ ... ];
   ```

   Take each literal from the producer's current source order once, at authoring time, then never regenerate it from the producer. `journeyAssertionNames` is the ordered names of every `context.assert` call in `runJourney`; every one of those calls is unconditional, so the list is total. `fixtureProfileAssertionNames` is the probe-row names of `scripts/e2e/lib/driver/origin-probe.ts:36-44`. `transportAssertionNames` is the names the loop at `scripts/e2e/lib/scenario/transport.ts:108-116` emits over the row table at `:21-61`.

2. **Each producer is pinned against its independent fragment**, so a removed row fails rather than passes:
   - `scripts/e2e/lib/scenario/journey.test.ts` — a recorded `runJourney` emits exactly `journeyAssertionNames`, in order.
   - `scripts/e2e/lib/profile/profile.test.ts` — a recorded `createFixtureProfile` emits exactly `fixtureProfileAssertionNames`, in order.
   - `scripts/e2e/lib/scenario/transport.test.ts` — a recorded `runTransportCases` emits exactly `transportAssertionNames`, in order.

   Deleting one transport row must fail this pin. Assert that by deleting one row locally and confirming the failure names the missing assertion.

3. **`expectedAssertions`**, in the same file:

   ```ts
   export const expectedAssertions: Readonly<
     Record<ScenarioId, readonly string[] | "non-empty">
   >;
   ```

   Each phase-1 id takes `"non-empty"`. Each P1B id takes an **exact ordered name list**, composed by spreading the fragments above plus that scenario's own literal names, in emission order. Stories 14, 15 and 16 each add their own entry.

4. **`scripts/e2e/lib/bundle.ts`** gains `assertionNames(): readonly string[]` on `BundleWriter` at `:62-80`, returning the `name` of each record in `assertions` at `:117`, in push order. Add it beside `printedLines()`.

5. **`scripts/e2e/lib/main.ts`** compares the recorded names with the declaration **after `run(context)` returns at `:664` and before the outcome is derived at `:672`**, inside the same `try`, so a difference sets `runError`:
   - `"non-empty"` requires at least one recorded name.
   - A list requires deep equality with `writer.assertionNames()`.
   - A difference raises `RunnerError("assertion-failed", …)` whose message names the first differing position, the expected name and the recorded name.

   The bundle therefore records `fail`.

### `scripts/e2e/lib/scenario/discipline.test.ts`

Add these cases, keeping the existing teardown-token and context cases:

- `it("every declared scenario id holds an expectedAssertions entry", ...)` — iterate `knownScenarioIds` and assert a key exists for each. This case goes red between this story and Story 16 by design: each scenario story adds its own entry. Land it in Story 16, and land the two cases below here.
- `it("no P1B entry is empty", ...)` — assert each P1B value present in the map is an array with length greater than zero, never `"non-empty"`. It holds vacuously here and gains force as each scenario story lands.
- `it("no expected fragment is imported from its producer", ...)` — assert `scripts/e2e/lib/scenario/assertions.ts` imports nothing from `journey.ts`, `profile/fixture.ts` or `transport.ts`, by reading the file and matching its import specifiers. This is the structural guard that keeps the oracle independent.
- `it("the proposal declares exactly the known scenario ids, in order", ...)` — read `docs/proposal/phase-1/README.md`, take the `## End-to-end scenarios` section, match every `### <id> — ` heading, and compare the id list with `knownScenarioIds` member for member and in order. Expect exactly `P1-E1`, `P1-E2`, `P1-E4`, `P1-E5`, `P1B-E1`, `P1B-E2`, `P1B-E3`.

### `scripts/e2e/lib/main.test.ts`

Add `it("a scenario that records no assertion fails rather than passes", ...)` — register a no-op fixture scenario whose `run` records nothing, drive the runner over it, and assert the bundle outcome is `fail` and the error code is `assertion-failed`.

## Constraints

- Compare recorded names **before** the outcome is written, never after.
- `context.assert` at `scripts/e2e/lib/bundle.ts:151-164` throws on the first mismatch, so a failing run records a prefix. The floor runs only on the path where `run` returned without throwing.
- Add no assertion name to a phase-1 scenario, and change no phase-1 assertion name. Each phase-1 id stays `"non-empty"`.
- State no assertion count anywhere. Every P1B entry is a name list.
- **`assertions.ts` imports no producer module.** Every fragment is a hand-written literal. A fragment computed from the code it checks is the defect this design exists to avoid.
- Add no scenario declaration here.

## Verify

- `node --test scripts/e2e/lib/tag.test.ts scripts/e2e/lib/main.test.ts scripts/e2e/lib/bundle.test.ts scripts/e2e/lib/scenario/index.test.ts scripts/e2e/lib/scenario/discipline.test.ts scripts/e2e/lib/record/verdict.test.ts scripts/e2e/lib/scenario/journey.test.ts scripts/e2e/lib/scenario/transport.test.ts scripts/e2e/lib/profile/profile.test.ts` exits 0.
- Deleting one row from the transport row table fails the `transport.test.ts` pin, and the failure names the missing assertion. Restore the row.
- Removing the `### P1B-E3` section from the proposal fails the parity case, and the failure names `P1B-E3`. Restore it.
- Deleting one `context.assert` call from a P1B scenario makes that run fail with `assertion-failed`.
- `npm run verify` exits 0.
- Proof: `scripts/e2e/lib/tag.test.ts`, `scripts/e2e/lib/main.test.ts`, `scripts/e2e/lib/bundle.test.ts`, `scripts/e2e/lib/scenario/index.test.ts`, `scripts/e2e/lib/scenario/discipline.test.ts`, `scripts/e2e/lib/record/verdict.test.ts`. Hermetic coverage: `020-wiring-and-scenarios.md:174`, `:175`, `:176`.
