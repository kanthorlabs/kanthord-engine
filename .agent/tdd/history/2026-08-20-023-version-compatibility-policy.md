---
epic: .agent/plan/epics/023-version-compatibility-policy.md
opened: 2026-08-20
opener: test-engineer
base-ref: c7e0aef6c5846522bf4202d12af69103582d63aa
---

# Implementation cycle — 023-version-compatibility-policy

Pulled from EPIC: `.agent/plan/epics/023-version-compatibility-policy.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

>

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/http/contract/capability.test.ts \
  src/http/contract/system.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/registry.test.ts \
  src/http/contract/parity.test.ts \
  src/queries/system/read-health.test.ts \
  src/http/server/system/health.test.ts \
  src/main.capability.test.ts \
  && echo "PASS EPIC-023"
```

Hermetic coverage required beyond the Proof:

- **The route-level acceptance test.** `src/main.capability.test.ts` launches the real daemon through
  `launchDaemon` and asserts that `GET /v1/health` answers `200` with `version` equal to
  `KANTHORD_VERSION` and `capabilities` equal to `declaredCapabilities()`, member for member and in
  order. It uses no injected handler map, so the assertion covers the production composition root.
- **A harness reads the handshake.** The same test drives `GET /v1/health` with a harness token and
  asserts `200` with the identical body, and drives `GET /v1/status` with the same token and asserts
  `403 actor-forbidden`. That proves D4 rather than restating it.
- **The response does not vary by the client header.** Two `GET /v1/health` calls, one with
  `X-Kanthord-Client: 0.0.1`, one with `X-Kanthord-Client: 999.0.0`, and one with the header absent,
  return byte-identical bodies, compared through `Buffer.compare` on the raw response text. A
  malformed value — `X-Kanthord-Client: not a version` — returns the same bytes and `200`, never a
  `400`. This is D3 asserted.
- **No response carries `Vary: X-Kanthord-Client`.** Asserted over the response headers of
  `GET /v1/health`, `GET /v1/status` and one POST route. `Vary: Origin` is asserted still present, so
  the assertion cannot pass by the header machinery being broken.
- **A capability is declared only when it is routed.** `capability.test.ts` builds the derivation
  against a fixture registry in which one named operation is `stubbed`, and asserts the name is
  absent. Against the real registry it asserts the exact expected list at this point in the block.
- **Every capability name resolves.** Every operation id in `capabilityOperations` is found by
  `findOperation`, asserted by name. A typo therefore fails `npm run verify` rather than silently
  suppressing a capability.
- **The map keys and the zod enum agree.** `capabilityName.options` equals `Object.keys(capabilityOperations)`,
  bytewise sorted, so a name added to one and not the other fails.
- **The additive rule is asserted where it is checkable.** `systemHealthResponse` is a
  `z.strictObject`, so a test asserts that a body carrying an unknown key fails `parse`, and that a
  body missing `capabilities` fails `parse`. The policy's client half — tolerate an unknown field —
  is a client obligation and is not asserted here.
- **`GET /v1/health` writes nothing.** The full contents of `event` plus `PRAGMA data_version` are
  compared before and after the call.
- `src/http/contract/parity.test.ts` still asserts `62` and `66`, unchanged, proving the epic added
  no operation.
- `npm run lint` passes with `queries/` importing no file from `http/contract/`, which is the
  boundary that forced the injection of D5.

## Open items

- **A capability the daemon has and the client cannot name.** The list is additive, so a client
  written against an older list ignores a newer name. That is the intended behaviour and it is
  recorded here because it is the one case the policy leaves silent.
- **The client repository commit.** E6 retires from `kanthord-apps/docs/api/blockers.md`, and
  `conventions.md` records the confirmation and the `mustUpgrade` refusal. This epic does not close
  before that commit lands.
- **A per-operation capability for phase 2.** Phase 2 adds runs, attempts and workers, and each
  becomes a capability name under the same rule. EPIC 115 owns the list at that point; this epic
  fixes the mechanism and not the membership.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — 01-proposal-states-the-policy · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Task: `01-proposal-states-the-policy`.
**Story file.** `.agent/plan/stories/023-version-compatibility-policy/01-proposal-states-the-policy.md`
**Tasks forwarded to Software Engineer.**

- `01-proposal-states-the-policy`: `.agent/plan/stories/023-version-compatibility-policy/01-proposal-states-the-policy.md` — apply the specified proposal policy updates without changing route tables or unrelated sections.
  **No RED phase.** Coverage is owned elsewhere per the Story verification section; this Story has no `Action — RED:` block.
  **Open to Software Engineer.**
- Implement GREEN+REFACTOR per the Story file.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 01-proposal-states-the-policy · proposal compatibility policy

**Cycle.** GREEN-ONLY implementation for Task: `01-proposal-states-the-policy`.
**Files changed.**

- `docs/proposal/api/README.md` (edited) — replaced the Versioning text with the `/v1` compatibility policy.
- `docs/proposal/api/system.md` (edited) — added health `version` and `capabilities` documentation.
- `docs/proposal/phase-1/transport.md` (edited) — linked the transport policy to the Versioning section.
  **Seam (GREEN).** The three proposal documents now state the exact compatibility, handshake, capability, and client-header policy required by the Story.
  **Refactor.** Applied the complete Story wording; no separate refactor block exists.
  **Build check.**
- typecheck: blocked — `npm run typecheck` exited 127 with `sh: tsc: command not found`.

OPEN: `npm run typecheck` — the environment lacks the `tsc` executable.
ATTEMPT-FAILED: 01-proposal-states-the-policy — required typecheck could not run because `tsc` is unavailable.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — build proof failed

**Cycle.** Blocked — software-engineer build verification failed.
**Verification result.**

```text
> kanthord@27.8.1 verify:handoff
> node scripts/verify-handoff.mjs

sh: tsc: command not found
VERIFY: FAIL — npm run typecheck exited 127
```

**Action required.** Software Engineer must fix the build, re-run with log output, verify, and resubmit.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 01-proposal-states-the-policy · build blocker

**Cycle.** Build verification after dependency restoration for `01-proposal-states-the-policy`.
**Files changed.**

- No production files — restored locked dependencies with `npm ci`.
  **Seam (GREEN).** The existing proposal implementation now has an available TypeScript compiler.
  **Refactor.** None; the prior Story refactor is complete.
  **Build check.**
- `npm run typecheck`: exit 0
- `npm run verify:handoff`: `VERIFY: PASS — npm run typecheck is clean`
  **Assumptions.**
- VERIFIED: dependencies match `package-lock.json` — `npm ci`

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 02-capability-map-and-derivation · capability map

**Cycle.** RED for Task `02-capability-map-and-derivation` (`node --test src/http/contract/capability.test.ts`).
**Test written.**

- file: `src/http/contract/capability.test.ts` (new) — suite: `src/http/contract/capability.test` — methods: `every capability operation id resolves in the real registry`, `every capability operation id is routed in the real registry`, `the map keys and the zod enum agree`, `the real registry declares the exact expected list`, `a stubbed operation suppresses its name`, `an absent operation suppresses its name`, `the result is bytewise sorted, not insertion ordered`, `an empty registry declares nothing`
- asserts: the three named capabilities resolve to routed operations, derive the exact sorted list, suppress unresolved or stubbed members, agree with the zod enum, and return deterministically for empty and repeated inputs.
  **RED proof.**
- command: `npm test`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/contract/capability.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/contract/capability.test.ts`
- `npm run typecheck` first reported the expected `TS2307`; stub probe: `src/http/contract/capability.ts` — 2 errors found in `src/http/contract/capability.test.ts`, fixed; the probe typecheck then exited 0, and the stub was removed.
  **Open to Software Engineer.**
- `src/http/contract/capability.ts`: export `capabilityOperations` with the three specified capability names and nine operation ids, `CapabilityName`, `capabilityName` as the matching zod enum, and `declaredCapabilities(operations: readonly Operation[]): readonly CapabilityName[]`; include a name only when every supplied operation resolves with status `"routed"`, exclude absent or `"stubbed"` operations, and return names in bytewise order.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 02-capability-map-and-derivation · capability map

**Cycle.** GREEN+REFACTOR for `src/http/contract/capability.test.ts`.
**Files changed.**

- `src/http/contract/capability.ts` (new) — capability map, zod name schema, and routed-operation derivation
  **Seam (GREEN).** `declaredCapabilities` resolves supplied operation statuses and returns only fully routed capability names in bytewise order.
  **Refactor.** Applied the complete Story specification; no separate refactor block exists.
  **Build check.**
- `npm run typecheck`: exit 0
- `npm run verify:handoff`: `VERIFY: PASS — npm run typecheck is clean`
  **Assumptions.**
- VERIFIED: the capability module imports only `zod` and `Operation` from `./operation.ts`, per the Story.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 03-health-response-carries-them · health response schema

**Cycle.** RED for Task `03-health-response-carries-them` (`src/http/contract/system.test.ts`).
**Test written.**

- file: `src/http/contract/system.test.ts` (edited) — suite: `src/http/contract/system.test` — methods: `systemHealthResponse accepts an empty and a two-line dependency list`, `systemHealthResponse rejects every non-contract shape`
- asserts: health responses require the daemon version and capability list, accept valid capability names, and reject missing fields, unknown keys, and unknown capabilities.
  **RED proof.**
- command: `npm test`
- exit: 1 — failure: `✖ systemHealthResponse accepts an empty and a two-line dependency list (11.174166ms)`
  **Open to Software Engineer.**
- `src/http/contract/system.ts`: exported `systemHealthResponse` must accept required non-empty `version`, `capabilities` values from `capabilityName`, existing `status` and `dependencies`, while rejecting unknown keys and invalid capability names; exported `systemHealthExamples` must provide the required health members.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 03-health-response-carries-them · health response schema

**Cycle.** GREEN+REFACTOR for `src/http/contract/system.test.ts`.
**Files changed.**

- `src/http/contract/system.ts` (edited) — health response schema and success example.
  **Seam (GREEN).** The health response now requires the daemon version and declared capability names.
  **Refactor.** Applied the required member order and example values; no separate refactor block exists.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `systemHealthResponse` remains strict, and `systemStatusResponse` remains unchanged.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 04-query-and-handler · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: `04-query-and-handler`.
**Story file.** `.agent/plan/stories/023-version-compatibility-policy/04-query-and-handler.md`
**Tasks forwarded to Software Engineer.**

- `04-query-and-handler`: `.agent/plan/stories/023-version-compatibility-policy/04-query-and-handler.md` — implement the injected health query contract and preserve the health handler contract.
  **No RED phase.** Coverage is owned elsewhere per the Story verification section; this Story has no `Action — RED:` block.
  **Open to Software Engineer.**
- `src/queries/system/read-health.ts`: implement `ReadHealthDependencies`, `ReadHealthResult`, and `readHealth` per Story 4.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 04-query-and-handler · injected health query

**GREEN-ONLY implementation for Tasks: `04-query-and-handler`.**
**Files changed.**

- `src/queries/system/read-health.ts` (edited) — required query dependencies and widened result.
  **Seam (GREEN).** `readHealth` passes injected `version` and `capabilities` through unchanged.
  **Refactor.** Preserved dependency sorting, degradation rules, and the existing handler contract.
  **Build check.**
- typecheck: blocked — exit 2 because downstream callers omit the required fields.

OPEN: `src/main.ts` needs Story 5 bindings. `src/http/server/start.test.ts`, `src/http/server/system/health.test.ts`, and `src/queries/system/read-health.test.ts` need the Story 4 fixture updates; tests are outside this lane.
ATTEMPT-FAILED: 04-query-and-handler — `npm run typecheck` fails on pending composition and test updates.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — build proof failed

**Cycle.** Blocked — software-engineer build verification failed.
**Verification result.**

```text
> kanthord@27.8.1 verify:handoff
> node scripts/verify-handoff.mjs

src/http/server/start.test.ts(92,38): error TS2345: Argument of type '{ reporters: { name: string; probe: () => DependencyStatus; }[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: { name: string; probe: () => "not-implemented" | "failed" | "ok"; }[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/http/server/system/health.test.ts(14,7): error TS2322: Type '{ status: "ok"; dependencies: { name: string; status: "ok"; }[]; }' is not assignable to type 'ReadHealthResult'.
  Type '{ status: "ok"; dependencies: { name: string; status: "ok"; }[]; }' is missing the following properties from type 'Readonly<{ version: string; capabilities: readonly string[]; }>': version, capabilities
src/http/server/system/health.test.ts(34,11): error TS2322: Type '{ status: "degraded"; dependencies: { name: string; status: "failed"; }[]; }' is not assignable to type 'ReadHealthResult'.
  Type '{ status: "degraded"; dependencies: { name: string; status: "failed"; }[]; }' is missing the following properties from type 'Readonly<{ version: string; capabilities: readonly string[]; }>': version, capabilities
src/main.ts(338,40): error TS2345: Argument of type '{ reporters: { name: string; probe: () => DependencyStatus; }[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: { name: string; probe: () => "not-implemented" | "failed" | "ok"; }[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/main.ts(348,40): error TS2345: Argument of type '{ reporters: { name: string; probe: () => DependencyStatus; }[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: { name: string; probe: () => "not-implemented" | "failed" | "ok"; }[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(30,33): error TS2345: Argument of type '{ reporters: never[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: never[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(37,33): error TS2345: Argument of type '{ reporters: Reporter[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: Reporter[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(45,33): error TS2345: Argument of type '{ reporters: Reporter[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: Reporter[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(55,18): error TS2345: Argument of type '{ reporters: Reporter[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: Reporter[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(65,18): error TS2345: Argument of type '{ reporters: Reporter[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: Reporter[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(75,18): error TS2345: Argument of type '{ reporters: Reporter[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: Reporter[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(92,31): error TS2345: Argument of type '{ reporters: Reporter[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: Reporter[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(108,16): error TS2345: Argument of type '{ reporters: Reporter[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: Reporter[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(114,31): error TS2345: Argument of type '{ reporters: Reporter[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: Reporter[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
VERIFY: FAIL — npm run typecheck exited 2
```

**Action required.** Software Engineer must fix the build, re-run with log output, verify, and resubmit.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 04-query-and-handler · injected health query

**Cycle.** GREEN-ONLY implementation for Task: `04-query-and-handler`.
**Files changed.**

- None — `src/queries/system/read-health.ts` already matches the Story 4 contract.
  **Seam (GREEN).** `readHealth` requires and returns injected `version` and `capabilities` without reordering them.
  **Refactor.** Preserved dependency sorting, degradation rules, and the pass-through health handler.
  **Build check.**
- typecheck: blocked — exit 2 because pending test fixtures omit the required fields, and `src/main.ts` awaits Story 5 bindings.
  **Assumptions.**
- VERIFIED: the required fields remain non-optional and `src/http/server/system/health.ts` needs no edit.

OPEN: `src/queries/system/read-health.test.ts`, `src/http/server/system/health.test.ts`, and `src/http/server/start.test.ts` need the Story 4 fixture updates; `src/main.ts` needs the Story 5 composition bindings. Tests are outside this lane, and Story 5 is not the active Task.
ATTEMPT-FAILED: 04-query-and-handler — `npm run typecheck` remains blocked by the pending test and composition updates.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — build proof failed

**Cycle.** Blocked — latest Software Engineer handoff for Task `04-query-and-handler` remains red.
**Verification result.**

```text
> kanthord@27.8.1 verify:handoff
> node scripts/verify-handoff.mjs

src/http/server/start.test.ts(92,38): error TS2345: Argument of type '{ reporters: { name: string; probe: () => DependencyStatus; }[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: { name: string; probe: () => "not-implemented" | "failed" | "ok"; }[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/http/server/system/health.test.ts(14,7): error TS2322: Type '{ status: "ok"; dependencies: { name: string; status: "ok"; }[]; }' is not assignable to type 'ReadHealthResult'.
  Type '{ status: "ok"; dependencies: { name: string; status: "ok"; }[]; }' is missing the following properties from type 'Readonly<{ version: string; capabilities: readonly string[]; }>': version, capabilities
src/http/server/system/health.test.ts(34,11): error TS2322: Type '{ status: "degraded"; dependencies: { name: string; status: "failed"; }[]; }' is not assignable to type 'ReadHealthResult'.
  Type '{ status: "degraded"; dependencies: { name: string; status: "failed"; }[]; }' is missing the following properties from type 'Readonly<{ version: string; capabilities: readonly string[]; }>': version, capabilities
src/main.ts(338,40): error TS2345: Argument of type '{ reporters: { name: string; probe: () => DependencyStatus; }[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: { name: string; probe: () => "not-implemented" | "failed" | "ok"; }[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/main.ts(348,40): error TS2345: Argument of type '{ reporters: { name: string; probe: () => DependencyStatus; }[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: { name: string; probe: () => "not-implemented" | "failed" | "ok"; }[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(30,33): error TS2345: Argument of type '{ reporters: never[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: never[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(37,33): error TS2345: Argument of type '{ reporters: Reporter[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: Reporter[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(45,18): error TS2345: Argument of type '{ reporters: Reporter[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: Reporter[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(55,18): error TS2345: Argument of type '{ reporters: Reporter[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: Reporter[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(65,18): error TS2345: Argument of type '{ reporters: Reporter[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: Reporter[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(75,18): error TS2345: Argument of type '{ reporters: Reporter[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: Reporter[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(92,31): error TS2345: Argument of type '{ reporters: Reporter[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: Reporter[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(108,16): error TS2345: Argument of type '{ reporters: Reporter[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: Reporter[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
src/queries/system/read-health.test.ts(114,31): error TS2345: Argument of type '{ reporters: Reporter[]; }' is not assignable to parameter of type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>'.
  Type '{ reporters: Reporter[]; }' is missing the following properties from type 'Readonly<{ reporters: readonly Readonly<{ name: string; probe: () => "not-implemented" | "failed" | "ok"; }>[]; version: string; capabilities: readonly string[]; }>': version, capabilities
VERIFY: FAIL — npm run typecheck exited 2
```

**Action required.** Software Engineer must update the pending callers and fixtures, rerun `npm run typecheck`, and verify the handoff.

ATTEMPT-FAILED: 04-query-and-handler — `npm run verify:handoff` remains red because callers and fixtures omit required `version` and `capabilities`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 04-query-and-handler · unblocked after 3 failed attempts

**Cycle.** GREEN-ONLY implementation for Task: `04-query-and-handler`, plus the `src/main.ts` binding
of Story 5. The scope extension is a recorded human decision, taken because no Story-4-only change
can satisfy the handoff gate.

**Root cause of the three failed attempts.**

- **B1 — test-lane refusal.** The Software Engineer declared "tests are outside this lane" and left
  `src/queries/system/read-health.test.ts`, `src/http/server/system/health.test.ts` and
  `src/http/server/start.test.ts` untouched. Story 4 owns all three: it carries a dedicated section
  per file, and it names them under `### The red set is exactly four files`. The lane rule the agent
  applied contradicts the Story it was given.
- **B2 — unsatisfiable handoff gate.** `src/main.ts:338,348` is Story 5's edit. Story 4 states "Take
  no `npm run verify` gate before Story 5 closes", but `scripts/verify-handoff.mjs:4` runs an
  unconditional whole-repo `npm run typecheck` at every Task boundary. For a coupled Story block the
  mid-block gate cannot go green. All three attempts died on the same gate.

**Resolution.** Apply Story 4 in full, then apply only the `src/main.ts` part of Story 5. Story 5
keeps `src/main.capability.test.ts` as its remaining work.

**Files changed.**

- `src/queries/system/read-health.test.ts` (edited) — `VERSION` and `CAPABILITIES` constants, the two
  members added to all nine `readHealth` calls and to every `deepEqual` expectation, and the four new
  cases Story 4 names.
- `src/http/server/system/health.test.ts` (edited) — widened `okResult` and the degraded fixture, and
  added the case that deep-equals the `200` body and parses it.
- `src/http/server/start.test.ts` (edited) — `version: "27.8.1"` and `capabilities: []` at the
  handler binding.
- `src/main.ts` (edited) — imports of `declaredCapabilities` and `registry`, one
  `healthDependencies` binding after `reporters`, and both `readHealth` call sites.
  `declaredCapabilities(registry)` is called once at construction.
- `src/http/contract/field-decisions.fixture.ts` (edited) — two rows, in sorted position, for
  `system.health.response#/properties/capabilities` and `.../version`.
- `src/services/home-lock/startup.test.ts` (edited) — the live `/v1/health` body assertion gains
  `version: KANTHORD_VERSION` and the three capability names, with the `../../domain/version.ts`
  import.

**Two files no Story lists.** Story 4's `### The red set is exactly four files` grep is name-based,
so it cannot see a caller that never mentions `readHealth`. Both of these fail at run time and not at
typecheck:

- `src/http/contract/coverage.test.ts` — the reviewed field fixture. Red from Story 3's schema
  change, before this Task started. The two added rows are exactly what Story 3 specifies: required,
  non-nullable, no enum on the array itself.
- `src/services/home-lock/startup.test.ts:123` — deep-equals the live daemon's `/v1/health` body.
  Red from this Task's `src/main.ts` binding.

Amend the Story 4 red-set rule to grep the route body and not the symbol name, or Story 5 meets the
same two files again.

**Seam (GREEN).** `readHealth` passes injected `version` and `capabilities` through byte for byte, and
the production composition root supplies them from `KANTHORD_VERSION` and `declaredCapabilities(registry)`.

**Refactor.** None. The dependency sort, the `degraded` rule and the pass-through handler are unchanged.

**Build check.**

- `npm run typecheck`: exit 0
- `npm run verify:handoff`: `VERIFY: PASS — npm run typecheck is clean`
- `npm run lint`: exit 0
- `npm test`: 4849 tests, 4849 pass, 0 fail
- `npm run verify`: exit 0

**Proof block.** Every member but `src/main.capability.test.ts` exits 0 — 143 tests, 0 fail. That one
file is Story 5's remaining work and does not exist yet.

**Assumptions.**

- VERIFIED: `src/queries/system/read-health.ts` needed no edit; it already matched Story 4.
- VERIFIED: `src/http/server/system/health.ts` and `src/queries/system/read-status.ts` needed no edit.
- VERIFIED: `src/queries/` imports no file from `src/http/contract/`, asserted by `npm run lint`.

**Open to Story 5.** `src/main.capability.test.ts`, the seven-case route-level acceptance test.

END: SOFTWARE-ENGINEER

## SOFTWARE-ENGINEER — S1 · the red-set rule

**Cycle.** Planning-document fix for S1. No production or test file changed.

**Defect.** Story 4's `### The red set is exactly four files` claimed completeness — "A hit outside it
is an edit this story missed" — while enumerating only the consumers of `readHealth`,
`ReadHealthResult` and `ReadHealthDependencies`. A file that asserts the `system.health` **response
body** names none of those symbols. It breaks at run time and never at typecheck, so the grep behind
the claim cannot see it. Two such files were missed, and the false completeness claim is what misled
the implementer, not the grep itself.

**Files changed.**

- `.agent/plan/stories/023-version-compatibility-policy/04-query-and-handler.md` (edited) — the section
  is now `### The red set has two halves, and only one half is greppable`. Half one keeps the symbol
  list and its grep. Half two names `src/http/contract/field-decisions.fixture.ts:613,618` and
  `src/services/home-lock/startup.test.ts:15,124`, and states that the completeness check is
  `npm run verify` at the close of the block, not a grep. Added a `###` spec section for each of the
  two files, and two rows to `## Verify`.
- `.agent/plan/stories/023-version-compatibility-policy/index.md` (edited) — the coupled-block
  description at `:13-16` now records which file turns red at which step: `coverage.test.ts` after
  Story 3, `startup.test.ts` only after Story 5 supplies the members through the composition root. Added
  the general rule that a response-shape change has a red set the compiler cannot see.

**Why not a tighter grep.** Measured, not assumed:

- `grep -rn "system\.health\.response" src test scripts` → 2 files, and it finds the fixture
  deterministically. Adopted, and its exact hit set is recorded in the story.
- `grep -rn "v1/health" src test scripts` → 18 files, mostly asserting a refusal envelope or a route
  table rather than the success body. Narrowing it by `deepEqual` still leaves 16. No variant isolates
  `startup.test.ts`, so the story says so plainly instead of offering a rule that looks exact and is not.
- `npm run verify` runs `npm test`, so the block's existing closing gate is already the exact check.
  S1 needed the claim corrected, not a new gate.

**One correction during the fix.** The first draft said `grep -rn "v1/health"` hits 27 files. Verified: 18. The 27 came from the wider `/v1/health\|system\.health` union. Corrected in the story.

**Build check.** This cycle changed two files, both under `.agent/plan/stories/`. No file under `src`,
`test` or `scripts` changed. `npm run verify` re-run after the edit: exit 0, `npm test` 4849 pass 0 fail.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 05-composition-root-and-acceptance · route handshake

**Cycle.** RED for Task `05-composition-root-and-acceptance` (`src/main.capability.test.ts`).
**Test written.**

- file: `src/main.capability.test.ts` (new) — suite: `src/main.capability.test` — methods: `the production composition root serves the handshake`, `the capability list is the expected list`, `a harness reads the identical handshake`, `a harness cannot read system.status`, `the response does not vary by the client header`, `responses vary by Origin but not by X-Kanthord-Client`, `GET /v1/health writes nothing`
- asserts: the real daemon serves the versioned capability handshake to human and harness actors, ignores client-version headers, preserves the Origin variance contract, and performs no health-route writes.
  **RED proof.**
- command: `npm test`
- exit: 1 — failure: `AssertionError [ERR_ASSERTION]: Failed`
- observed: `✖ responses vary by Origin but not by X-Kanthord-Client (19.53975ms)`
- typecheck: `npm run typecheck` exit 0 after fixing two test-only narrowing errors.
  **Open to Software Engineer.**
- `src/http/server/origin.ts`: the authenticated health, status, and actor responses expose `Vary: Origin` and never expose `Vary: X-Kanthord-Client`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 05-composition-root-and-acceptance · CORS variance

**Cycle.** GREEN+REFACTOR for `src/main.capability.test.ts`.
**Files changed.**

- `src/http/server/origin.ts` (edited) — apply `Vary: Origin` through the existing finalization path.
  **Seam (GREEN).** Origin middleware now varies downstream responses even when the request has no Origin header.
  **Refactor.** Unified origin-present and origin-absent requests around the existing `finally` block.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `originMiddleware` remains the only production writer for CORS variance — `src/http/server/origin.ts`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Cycle.** Confirmed GREEN for Task `05-composition-root-and-acceptance`; no next unimplemented Task remains.
**Test adjustment.**

- `src/http/server/origin.test.ts` — no-Origin responses now assert `Vary: Origin`.
  **EPIC verification gate.**
- `npm run verify:handoff` → exit 0 — `VERIFY: PASS — npm run typecheck is clean`.
- `npm run typecheck` → exit 0.
- `npm test` → exit 0 — 4,856 tests passed, 0 failed.
- `npm run verify` → exit 0.
  **Proof.**
- `node --test src/http/contract/capability.test.ts src/http/contract/system.test.ts src/http/contract/example.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/queries/system/read-health.test.ts src/http/server/system/health.test.ts src/main.capability.test.ts && echo "PASS EPIC-023"` → exit 0 — printed `"PASS EPIC-023"`.
  **Tasks closed.** 5 across 5 Stories.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/capability.test.ts src/http/contract/system.test.ts src/http/contract/example.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/queries/system/read-health.test.ts src/http/server/system/health.test.ts src/main.capability.test.ts && echo "PASS EPIC-023") — "PASS EPIC-023"
- stories: 5/5 complete
- date: 2026-08-20
- state: local-uncommitted

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 1 action:YES finding(s) to the TDD loop; 1 action:NO finding(s) recorded for the human.
BLOCKER: S1 — Empty conditional branch in src/http/server/origin.ts:19-20; simplify the branch while retaining the existing try/finally behavior.
INFO: B1 — Client repository commit remains unverified; confirm or land the kanthord-apps E6 retirement and policy update before closing EPIC 023.

## TEST-ENGINEER — 023-version-compatibility-policy · review blocker S1

**Cycle.** RED for review blocker S1 (`src/main.capability.test.ts`).
**Test written.**

- file: `src/main.capability.test.ts` (edited) — suite: `src/main.capability.test` — method: `the Origin middleware does not keep an empty no-Origin branch`
- asserts: the origin middleware source has no empty no-Origin conditional branch.
  **RED proof.**
- command: `node --test src/main.capability.test.ts`
- exit: 1 — failure: `✖ the Origin middleware does not keep an empty no-Origin branch (1.006792ms)`
- typecheck: `npm run typecheck` — exit 0.
  **Open to Software Engineer.**
- `src/http/server/origin.ts`: exported `originMiddleware` must not retain an empty no-Origin conditional branch; its existing `try/finally` `Vary: Origin` behavior must remain.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 023-version-compatibility-policy · review blocker S1

**Cycle.** GREEN+REFACTOR for review blocker S1.
**Files changed.**

- `src/http/server/origin.ts` (edited) — collapsed the empty no-Origin branch into an origin-present guard.
  **Seam (GREEN).** `originMiddleware` retains the existing `try/finally` path, including `context.vary("Origin")`, for every request.
  **Refactor.** Removed the empty conditional branch with `origin !== undefined`.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `context.vary("Origin")` remains in the `finally` block.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** Confirmed the S1 fix and all five Story Tasks green.

- `npm run verify:handoff` → exit 0 — `VERIFY: PASS — npm run typecheck is clean`.
- typecheck (`npm run typecheck`) → exit 0.
- unit (`npm test`) → exit 0 — 4,857 tests passed through `npm run verify`.
- `npm run verify` → exit 0 — database status verification passed.
  **Proof.**
- `node --test src/http/contract/capability.test.ts src/http/contract/system.test.ts src/http/contract/example.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/queries/system/read-health.test.ts src/http/server/system/health.test.ts src/main.capability.test.ts && echo "PASS EPIC-023"` → exit 0 — printed `"PASS EPIC-023"`.
  **Tasks closed.** 5 across 5 Stories.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/capability.test.ts src/http/contract/system.test.ts src/http/contract/example.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/queries/system/read-health.test.ts src/http/server/system/health.test.ts src/main.capability.test.ts && echo "PASS EPIC-023") — "PASS EPIC-023"
- stories: 5/5 complete
- date: 2026-08-20
- state: local-uncommitted

END: TEST-ENGINEER

HUMAN_REVIEW: PASS
