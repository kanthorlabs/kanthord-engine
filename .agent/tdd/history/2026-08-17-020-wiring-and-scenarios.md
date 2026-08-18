---
epic: .agent/plan/epics/020-wiring-and-scenarios.md
opened: 2026-08-17
opener: test-engineer
base-ref: 5a0840dc0ceba3eabec3a56db1f634e055360a2d
---

# Implementation cycle — 020-wiring-and-scenarios

Pulled from EPIC: `.agent/plan/epics/020-wiring-and-scenarios.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/http/contract/authorization.test.ts \
>   src/http/contract/registry.test.ts \
>   src/http/contract/parity.test.ts \
>   src/main.test.ts \
>   src/cli/event/list.test.ts \
>   src/cli/inventory.test.ts \
>   src/cli/parity.test.ts \
>   src/cli/program.test.ts \
>   src/cli/reachability.test.ts \
>   test/helpers/command-recorder.test.ts \
>   scripts/e2e/lib/tag.test.ts \
>   scripts/e2e/lib/main.test.ts \
>   scripts/e2e/lib/bundle.test.ts \
>   scripts/e2e/lib/disclosure.test.ts \
>   scripts/e2e/lib/fixtures.test.ts \
>   scripts/e2e/lib/profile/profile.test.ts \
>   scripts/e2e/lib/scenario/index.test.ts \
>   scripts/e2e/lib/scenario/discipline.test.ts \
>   scripts/e2e/lib/scenario/harness.test.ts \
>   scripts/e2e/lib/scenario/p1b-e1.test.ts \
>   scripts/e2e/lib/scenario/p1b-e2.test.ts \
>   scripts/e2e/lib/scenario/p1b-e3.test.ts \
>   scripts/e2e/lib/podman/topology.test.ts \
>   scripts/e2e/lib/driver/interface.test.ts \
>   scripts/e2e/lib/record/verdict.test.ts \
>   && node scripts/e2e/run.mjs P1B-E1 \
>   && node scripts/e2e/run.mjs P1B-E2 \
>   && node scripts/e2e/run.mjs P1B-E3 \
>   && node scripts/e2e/run.mjs P1-E1 \
>   && node scripts/e2e/run.mjs P1-E2 \
>   && node scripts/e2e/run.mjs P1-E4 \
>   && echo "PASS EPIC-020"
> ```
>
> Every path is named one by one, and no directory glob stands in for one. `node --test` exits non-zero on a named path that is absent, so the Proof fails before this epic is built. Eight of these paths do not exist today. Each declared scenario id carries its own invocation, because a runner that declares an id and never runs it is the defect this section prevents. The three phase-1 ids run as well, because the plan axis, the topology record and the driver interface all change under them.
>
> Hermetic coverage required beyond the Proof:
>
> - `src/http/contract/authorization.test.ts` asserts the harness-admitting set by name and finds exactly the sixteen named ids. Removing one `allowedActors: ["human", "harness"]` row fails it, and the failure names the operation id. Adding a seventeenth fails it as well.
> - Every registry entry declares a non-empty `allowedActors`, asserted over the whole registry rather than a sample, and every entry admits `"human"`. Every id outside the harness set declares `["human"]` exactly, by set difference.
> - `src/cli/reachability.test.ts` covers every entry of `declaredCommands`, and a `declaredCommands` entry with no argument row fails it. **A leaf whose action is not registered records no request and fails, and the failure names the command path.** The proof case removes the action of `node delete` and asserts the failure by name.
> - The recorded operation id sequence is asserted in order for `plan import`, `repository register` and `node update`, each of which names more than one operation.
> - `config generate`, `db migrate` and `serve` each record their own effect once and record zero HTTP requests.
> - A recorded request that matches no registry template, or two, fails the resolver, asserted through one deliberately malformed fixture.
> - `src/main.test.ts` covers every `routed` operation with a fixture, and `pending` is `[] as const`. Removing one handler binding from `src/main.ts` makes the sweep report `501` for that operation and names it.
> - The composition sweep runs against the daemon `launchDaemon` starts from `src/main.ts` and uses no injected handler map at any step, so an operation bound only in a test app fails it.
> - The seventeen new command paths are asserted by name in `src/cli/parity.test.ts`, and every operation id every command names resolves through `findOperation`. A declared command that `buildProgram` does not register fails `compareCommandSets`, and the failure names the path.
> - `scripts/e2e/lib/scenario/discipline.test.ts` reads the scenario headings of `docs/proposal/phase-1/README.md` and finds exactly `P1-E1`, `P1-E2`, `P1-E4`, `P1-E5`, `P1B-E1`, `P1B-E2` and `P1B-E3`, equal to `knownScenarioIds` member for member. Removing one proposal section fails it, and the failure names the id.
> - The set of `routed` operations that no `declaredCommands` entry names is asserted by name, and it holds exactly the eight ids listed in the decision above. A ninth id fails the assertion, so a new route with no command is a decision rather than an oversight. `event.list` is asserted absent from that set, because `event list` reaches it.
> - `src/cli/event/list.test.ts` covers the command over a recording client. It asserts each of the seven options on the issued query, one record per event in event id order, the sorted-key payload bytes for a nested payload, `kanthord: no event` on an empty list, and the error line on a failed call. A payload printed with two different key orders in two runs fails it.
> - `cliAs`, `issueAs` and `registerActor` are members of `driverMethodNames`, and the `local`, `podman` and `ssh` drivers each satisfy the interface test, so phase 3 inherits a working driver.
> - `cli(argv)` and `cliAs("client", argv)` reach the same container with the same arguments, and `issue(request)` and `issueAs("client", request)` do the same, each asserted over a recording executor.
> - `registerActor` returns no token field, asserted over the returned record. The recorded stdout of the registration holds `[redacted]` and holds no token, asserted over a recording executor with a known response.
> - `planTopology` names six containers-and-networks resources with the run id, the second client container included, and `createTopology` takes each one into the ledger in the pinned order. `P1B-E2` leaves no container, no pod, no network, no secret and no volume carrying its run id, after a failing run as well as a passing one.
> - The second client container holds no daemon volume mount, asserted from `podman inspect`, so it reaches no daemon file system.
> - `assertNoDisclosure` inspects both client containers, and the configured token and the master key appear in no printed command, no bundle, no config dump and no `podman inspect` output. It is asserted over a deliberately failing run as well as a passing one, with a non-empty secret registry as its precondition.
> - `test/e2e/fixtures/three-objective` imports with three objectives and five tasks, and `gamma` resolves `depends_on` to the two objective identities. The fixture profile returns the matching counts for each plan axis value.
> - `P1B-E1` asserts that `gamma` reads `pending` after alpha closes and beta is not done. The negative is asserted by node identity.
> - **`P1B-E1` proves the harness authored a task through the packaged binary.** The transient node is created, updated and deleted, and after the delete the export `revision` equals the revision the delete returned while the export `documents` are byte-identical to the pre-create export bytes. The durable authored task, under alpha, is claimed, reported `accepted` and reaches `done`, and the alpha attestation and close follow it. Every assertion uses the identity the create response returned. `event list` under the configured human token names `actorKind` of `"harness"` and the registered harness actor id on `node.created`, `node.updated` and `node.deleted`. No harness-signed request of the run is a `plan revisions` call, asserted from the recorded operation ids of the harness client.
> - `P1B-E2` asserts every phase of the exit journey: two independent authentications, one race with exactly one `200`, two refusals on alpha, one `200` on beta, every sibling task of both objectives reported, both objectives `awaiting_approval` with different attested object ids, both closed by the human token, and `gamma` `ready` only after the second close.
> - `P1B-E2` asserts the two graph listings equal each other by identity and state, and asserts the two harness actor ids different. An event attributed to a shared actor fails it.
> - `P1B-E2` asserts that one `Idempotency-Key` used by two actors on one node id yields `200` then `409 lease-held`, with two different bodies. A replayed first body fails it.
> - `P1B-E3` asserts the takeover fence is greater than the first fence, that the first client's report on the stale fence is `409 lease-held`, and that exactly one `outcome.reported` event exists for that task, naming the second actor.
> - `P1B-E3` polls at 250 ms to a 60000 ms deadline and keeps its diagnostics on timeout. It sleeps no lease term, and its wall-clock dependency is stated in the scenario file.
> - `expectedAssertions` holds an exact ordered name list for each P1B id, and the runner fails a scenario whose recorded names differ. An empty scenario body therefore fails rather than passes, asserted through one no-op fixture scenario in `scripts/e2e/lib/main.test.ts`.
> - The verdict of `scripts/e2e/lib/record/verdict.ts` requires a bundle for each of `P1B-E1`, `P1B-E2` and `P1B-E3`, and a run that misses one exits non-zero on the scenario axis.
> - `--daemon-host` or `--client-host` with any of the three ids is an argument fault.
> - Podman absent, stopped, or below the pinned version fails `P1B-E2` and `P1B-E3` loudly and names the remedy. Neither skips.
> - Every hermetic assertion of `009-cli-and-composition-root.md:55-59` and `011-end-to-end-scenarios.md:61-69` still passes. The `src/main.test.ts` fixture map, the topology resource ledger and the plan axis are the three regression risks.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — sibling precondition check · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: `01-sibling-precondition-check`.
**Story file.** `.agent/plan/stories/020-wiring-and-scenarios/01-sibling-precondition-check.md`
**Tasks forwarded to Software Engineer.**

- `01-sibling-precondition-check`: no implementation path — verify the seven sibling preconditions; the Story forbids production, test, and fixture edits.
  **No RED phase.** The Story adds no coverage and requires read-only checks.
  **Precondition results.**
- Check 1: `tasksAllPending` has no match under `scripts/`.
- Check 2: the thirteen routed operation probe prints `ok`.
- Check 3: the seventeen existing CLI command probe prints `ok`.
- Check 4: `Operation.allowedActors` is required after `status`.
- Check 5: `harnessOperations` appears only in `src/http/contract/registry.test.ts`.
- Check 6: `eventView.payload` is `z.unknown()`, and `eventPayloads` plus `eventPayload` exist.
- Check 7: actor register and rotate require `--token-file` and print only the redacted token confirmation.
  **Verification.**
- `npm test` → exit 0 — `ℹ tests 4586`, `ℹ pass 4586`, `ℹ fail 0`.
- `npm run verify` → exit 0 — `ℹ tests 4586`, `ℹ pass 4586`, `ℹ fail 0`.
  **Open to Software Engineer.**
- No software-engineer-lane path is open; confirm this read-only Story and leave the tree unchanged.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — sibling precondition check · read-only verification

**Cycle.** GREEN-ONLY implementation for Task: `01-sibling-precondition-check`.
**Files changed.**

- None — the Story forbids production, test, fixture, configuration, and plan edits.
  **Seam (GREEN).** Confirmed the seven inherited preconditions and left the implementation tree unchanged.
  **Refactor.** None — the Story has no implementation or refactor.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: the latest TEST-ENGINEER turn reports all seven checks and inherited verification passes.
- VERIFIED: no software-engineer-lane path is open.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — registry-wide authorization inventory · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Task `02-authorization-inventory`.
**Story file.** `.agent/plan/stories/020-wiring-and-scenarios/02-authorization-inventory.md`
**Tasks forwarded to Software Engineer.**

- `02-authorization-inventory`: `.agent/plan/stories/020-wiring-and-scenarios/02-authorization-inventory.md` — implement the registry-wide authorization inventory and test relocation.
  **No RED phase.** The Story has no `Action — RED:` block; coverage is owned elsewhere per protocol.
  **Build-only confirmation.**
- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- `npm run typecheck` → exit 0.
  **Open to Software Engineer.**
- No software-engineer-lane path is open; the Story names only test-lane paths.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — registry-wide authorization inventory

**Cycle.** GREEN-ONLY implementation for Task: `02-authorization-inventory`.
**Files changed.**

- None in production or scripts — the Story names only test-lane paths and forbids production edits.
- `.agent/tdd/memory/software-engineer/2026-08-17.md` (appended) — decision journal.
  **Seam (GREEN).** No production seam exists; the Story's work is exclusively test relocation and inventory assertions, outside the software-engineer lane.
  **Refactor.** None — no production or script refactor is named.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: the Story has no `Action — RED:` block and names only test-lane paths.
- VERIFIED: the latest TEST-ENGINEER turn reports `npm run verify:handoff` PASS and typecheck clean.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — event-list-command · Task 03

**Cycle.** Confirmed GREEN for Task `02-authorization-inventory`; RED for Task `03-event-list-command` (`.agent/plan/stories/020-wiring-and-scenarios/03-event-list-command.md`).
**Prior GREEN-only confirmation.**

- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- `npm run typecheck` → exit 0.
  **Test written.**
- file: `src/cli/event/list.test.ts` (new) — suite: `src/cli/event/list.test` — methods: `sends every supplied option on the query`, `omits an absent option from the query`, `prints one record per event in the order the response returns`, `prints a payload with every key sorted bytewise at every depth`, `prints the same payload bytes for two key orders of one payload`, `prints kanthord: no event on an empty list`, `prints the error line and fails on a refused call`
- asserts: `event.list` receives mapped query fields, output preserves response order, payload bytes are canonical, empty results print the required line, and refusals fail with the required diagnostic.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/src/cli/event/list.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/src/cli/event/list.test.ts`
- stub probe: `src/cli/event/list.ts` — 2 errors found in `src/cli/event/list.test.ts`, fixed; probe deleted before handoff.
  **Open to Software Engineer.**
- `src/cli/event/list.ts`: export `RegisterEventListCliInput` with `program: Command`, `client: DaemonClient`, `stdout(text: string): void`, `stderr(text: string): void`, and `fail(): void`; export `registerEventList(input: RegisterEventListCliInput): void` and `renderPayload(value: unknown): string`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — event-list-command · `kanthord event list`

**Cycle.** GREEN+REFACTOR for `src/cli/event/list.test.ts`.
**Files changed.**

- `src/cli/event/list.ts` (new) — exported CLI input seam, event-list registrar, and canonical payload renderer.
  **Seam (GREEN).** The registrar maps supplied options into one `event.list` query, parses the response, and formats events or errors.
  **Refactor.** Applied: isolated recursive canonical JSON rendering in `renderJson`; no separate `Action — REFACTOR:` was provided.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `eventListResponse` accepts the event payload as `unknown` in `src/http/contract/event.ts`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — cli-inventory-parity · Task 04

**Cycle.** Confirmed GREEN for Task `03-event-list-command`; RED for Task `04-cli-inventory-parity` (`.agent/plan/stories/020-wiring-and-scenarios/04-cli-inventory-parity.md`).
**Prior GREEN confirmation.**

- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- `node --test src/cli/event/list.test.ts` → exit 0 — `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`.
  **Test written.**
- file: `src/cli/parity.test.ts` (edited) — suite: `src/cli/parity.test` — methods: `programCommandPaths returns exactly the declared paths, by name`, `every calling entry names at least one operation id`, `reaches ids only as a step of another command`, `every operation id every command names resolves through findOperation`, `the routed operations that no command names are exactly the eight accepted ones`
- file: `src/cli/inventory.test.ts` (edited) — suite: `src/cli/inventory.test` — methods: `declares exactly the named commands`, `commandPaths holds exactly the named distinct strings`, `flattens to the named distinct operation ids`, `pins the paths the P1-E1 scan never names`
- asserts: the inventory names `event list`, every declared operation resolves, and the uncovered routed set excludes `event.list` and `node.unblock` while matching the eight accepted ids.
  **RED proof.**
- command: `node --test src/cli/parity.test.ts src/cli/inventory.test.ts src/cli/program.test.ts`
- exit: non-zero — failure: `✖ the routed operations that no command names are exactly the eight accepted ones (0.214166ms)`
- output: `ℹ tests 31`, `ℹ pass 25`, `ℹ fail 6`.
- `npm run typecheck` → exit 0.
  **Open to Software Engineer.**
- `src/cli/event/index.ts`: export `eventCommand(program: Command): Command`.
- `src/cli/program.ts`: `buildProgram(dependencies: ProgramDependencies): Command` exposes the declared `event list` leaf.
- `src/cli/inventory.ts`: `declaredCommands: readonly DeclaredCommand[]` and `commandPaths(): readonly string[]` expose the `event list` row with operation id `event.list`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — cli-inventory-parity · event list wiring

**Cycle.** GREEN+REFACTOR for `src/cli/parity.test.ts` and `src/cli/inventory.test.ts`.
**Files changed.**

- `src/cli/event/index.ts` (new) — exported the idempotent `eventCommand` group seam.
- `src/cli/program.ts` (edited) — wired `event list` with the injected client and output seams.
- `src/cli/inventory.ts` (edited) — declared `event list` with `event.list`.
  **Seam (GREEN).** `buildProgram` now registers the `event list` leaf, and inventory maps it to `event.list`.
  **Refactor.** Applied: isolated event-group creation in the reusable `eventCommand` seam.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `event.list` is the existing human-only routed operation in `src/http/contract/event.ts`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — cli-inventory-parity · Task 04 GREEN confirmation

**Cycle.** Confirm GREEN for Task `04-cli-inventory-parity`.
**Handoff verification.**

- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
  **Exact Task 04 tests.**
- command: `node --test src/cli/parity.test.ts src/cli/inventory.test.ts src/cli/program.test.ts`
- exit: non-zero — `ℹ tests 31`, `ℹ pass 30`, `ℹ fail 1`.
- failure: `✖ registers the eleven declared top-level commands, sorted bytewise (1.347375ms)`.
- detail: `src/cli/program.test.ts` still expects the top-level command list without `event`, while the actual list includes `event`.
  **Next Task.**
- Task `05-command-recorder` is next by dependency order. No RED test was opened because Task 04 remains red.

ATTEMPT-FAILED: 04-cli-inventory-parity — exact Task 04 tests remain red because `src/cli/program.test.ts` omits `event` from its expected top-level commands

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — cli-inventory-parity · stale top-level command assertion

**Cycle.** Task `04-cli-inventory-parity` remains blocked by a stale test-lane assertion.
**Files changed.**

- None — the implementation is present; no production or test file changed.
  **Seam (GREEN).** No production change is needed; `buildProgram` registers `event`, while `src/cli/program.test.ts` expects the old top-level list.
  **Refactor.** Deferred: the test-engineer must update the stale assertion.
  **Build check.**
- typecheck: exit 0
  **OPEN: blocker.**
- `<B1> - status:OPEN - action:YES - stale top-level command assertion - update src/cli/program.test.ts to include event - fix:add event to the expected sorted top-level command list - why:the exact Task test fails only because the assertion omits the registered event command`
  **Assumptions.**
- VERIFIED: the latest TEST-ENGINEER turn identifies this as the sole failing assertion.
- VERIFIED: no implementation blocker exists.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — command-recorder · Task 05

**Cycle.** Confirmed GREEN for Task `04-cli-inventory-parity`; RED for Task `05-command-recorder` (`.agent/plan/stories/020-wiring-and-scenarios/05-command-recorder.md`).
**Prior GREEN confirmation.**

- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- `node --test src/cli/parity.test.ts src/cli/inventory.test.ts src/cli/program.test.ts` → exit 0 — `ℹ tests 31`, `ℹ pass 31`, `ℹ fail 0`.
  **Test written.**
- file: `src/cli/program.test.ts` (edited) — suite: `src/cli/program.test` — method: `registers the twelve declared top-level commands, sorted bytewise`
- file: `test/helpers/command-recorder.test.ts` (new) — suite: `test/helpers/command-recorder.test` — methods: `resolves a concrete path to its one operation id`, `resolves a parameter segment`, `ignores the query string`, `throws naming the method and path when no template matches`, `records the request one CLI leaf issues`, `records zero requests and one migrate call for db migrate`, `issues no network request`, `keeps two runs independent`
- asserts: the program inventory includes `event`, and the recorder resolves operation paths, captures CLI effects, and opens no network socket.
  **RED proof.**
- command: `node --test test/helpers/command-recorder.test.ts`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/test/helpers/command-recorder.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/test/helpers/command-recorder.test.ts`
- `npm run typecheck` → exit 0 with the declared seam stub.
- stub probe: `test/helpers/command-recorder.ts` — clean; probe deleted before handoff.
  **Open to Software Engineer.**
- The test imports `RecordedRequest`, `CommandRecorder`, `createCommandRecorder(options?: Readonly<{ respond?: (request: RecordedRequest) => unknown }>): CommandRecorder`, and `resolveOperationId(method: string, path: string): string`.
- No software-engineer-lane path is open; the imported helper is test-lane-owned.

OPEN: Task `05-command-recorder` — the Story requires a duplicate-template assertion, but its only declared `resolveOperationId(method, path)` seam accepts no local template list; human clarification is required.

END: TEST-ENGINEER

## TEST-ENGINEER — command-recorder · Task 05 confirmed + CLI reachability · Task 06

**Cycle.** Confirmed GREEN for Task `05-command-recorder`; completed Story 06 reachability coverage.
**Test written.**

- file: `test/helpers/command-recorder.ts` (new) — exports `RecordedRequest`, `CommandRecorder`, `createCommandRecorder`, and `resolveOperationId(method, path, entries?)`.
- file: `test/helpers/command-recorder.test.ts` (edited) — suite: `test/helpers/command-recorder.test` — method: `throws naming every match when two templates match`.
- file: `src/cli/reachability.test.ts` (new) — suite: `src/cli/reachability.test` — methods: `holds one argument row for every declared command`, `every leaf issues exactly the operation ids its inventory row declares, in order`, `plan import issues plan.revisions, plan.validate, plan.import in that order`, `repository register issues provider.list, repository.inspect, repository.register in that order`, `node update issues node.show, plan.revisions, node.update in that order`, `event list issues event.list alone`, `config generate, db migrate and serve issue no request and record their own effect once`, `a leaf whose action is not registered fails and names the command path`.
- asserts: the recorder resolves unique and duplicate templates, records CLI effects without network access, and every declared leaf reaches its inventory operations in order.
  **GREEN proof.**
- command: `node --test test/helpers/command-recorder.test.ts`
- exit: 0 — `ℹ tests 9`, `ℹ suites 1`, `ℹ pass 9`, `ℹ fail 0`, `ℹ cancelled 0`, `ℹ skipped 0`, `ℹ todo 0`
- command: `node --test src/cli/reachability.test.ts`
- exit: 0 — `ℹ tests 8`, `ℹ suites 1`, `ℹ pass 8`, `ℹ fail 0`, `ℹ cancelled 0`, `ℹ skipped 0`, `ℹ todo 0`
- command: `npm run typecheck` — exit 0.
- command: `npm run lint` — exit 0.
- sensitivity: the local actionless `node delete` fixture makes the shared comparison fail with `command node delete`.
  **Open to Software Engineer.**
- No software-engineer-lane path is open; Task 05 and Story 06 are test-lane green.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — command-recorder and CLI reachability · handoff confirmation

**Cycle.** GREEN-ONLY confirmation for Task `05-command-recorder` and Story `06-cli-reachability`.
**Files changed.**

- None — both are green, and no software-engineer-lane path is open.
  **Seam (GREEN).** Confirmed the latest TEST-ENGINEER handoff and left production unchanged.
  **Refactor.** None — no production refactor is named.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: the latest TEST-ENGINEER turn reports Task 05 and Story 06 green.
- VERIFIED: no tests ran in this turn.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — composition-root-sweep · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Task: `07-composition-root-sweep`.
**Story file.** `.agent/plan/stories/020-wiring-and-scenarios/07-composition-root-sweep.md`
**Prior GREEN confirmation.**

- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- Task `05-command-recorder`: `node --test test/helpers/command-recorder.test.ts` → exit 0 — `ℹ tests 9`, `ℹ pass 9`, `ℹ fail 0`.
- Task `06-cli-reachability`: `node --test src/cli/reachability.test.ts` → exit 0 — `ℹ tests 8`, `ℹ pass 8`, `ℹ fail 0`.
  **Build-only check.**
- `npm run typecheck` → exit 0.
  **Tasks forwarded to Software Engineer.**
- `07-composition-root-sweep`: `.agent/plan/stories/020-wiring-and-scenarios/07-composition-root-sweep.md` — confirm the complete real-daemon composition sweep for the block.
  **No RED phase.** The Story has no `Action — RED:` block; coverage is owned by the existing composition-root suite.
  **Open to Software Engineer.**
- No software-engineer-lane path is open; leave production and scripts unchanged.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — composition-root-sweep · complete composition handoff

**Cycle.** GREEN-ONLY implementation for Task: `07-composition-root-sweep`.
**Files changed.**

- None — the Story forbids production and scripts changes.
  **Seam (GREEN).** Confirmed the real-daemon composition-root handoff and left production and scripts unchanged.
  **Refactor.** None — the Story names no implementation or refactor.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: the latest TEST-ENGINEER turn reports no software-engineer-lane path is open.
- VERIFIED: the Story requires the existing `launchDaemon` composition sweep without injected handlers.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — three-objective-fixture · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Task: `08-three-objective-fixture`.
**Story file.** `.agent/plan/stories/020-wiring-and-scenarios/08-three-objective-fixture.md`
**Prior GREEN-only confirmation.**

- Task `07-composition-root-sweep`: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- Build-only check: `npm run typecheck` → exit 0.
  **Tasks forwarded to Software Engineer.**
- `08-three-objective-fixture`: `.agent/plan/stories/020-wiring-and-scenarios/08-three-objective-fixture.md` — add the three-objective fixture and thread its plan axis through the scenario declaration, fixture profile, and P1-E4 path.
  **No RED phase.** Story 08 has no `Action — RED:` block; coverage is owned by the existing fixture, profile, and scenario suites.
  **Open to Software Engineer.**
- `scripts/e2e/lib/scenario/index.ts`: implement the required plan axis for declarations.
- `scripts/e2e/lib/profile/fixture.ts`: implement the closed plan-axis profile lookup and counts.
- `scripts/e2e/lib/scenario/p1-e4.ts`: use the plan-axis source for the fixture plan.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — three-objective-fixture · plan axis

**Cycle.** GREEN-ONLY implementation for Task: `08-three-objective-fixture`.
**Files changed.**

- `scripts/e2e/lib/scenario/index.ts` (edited) — exported `PlanAxis`, required `plan` on declarations, and set the phase-1 rows to `two-objective`.
- `scripts/e2e/lib/profile/fixture.ts` (edited) — added the closed plan table, source lookup, axis-specific profile counts, and fixture roots.
- `scripts/e2e/lib/scenario/p1-e4.ts` (edited) — resolved plan delivery and profile metadata through the selected axis table.
- `scripts/e2e/lib/scenario/p1-e1.ts` (edited) — passed `two-objective` and declared the axis.
- `scripts/e2e/lib/scenario/p1-e2.ts` (edited) — passed `two-objective` and declared the axis.
- `scripts/e2e/lib/scenario/p1-e5.ts` (edited) — declared the phase-1 axis.
- `test/e2e/fixtures/three-objective/README.md` (new).
- `test/e2e/fixtures/three-objective/plan/journey/initiative.md` (new).
- `test/e2e/fixtures/three-objective/plan/journey/alpha/objective.md` (new).
- `test/e2e/fixtures/three-objective/plan/journey/alpha/01-first.md` (new).
- `test/e2e/fixtures/three-objective/plan/journey/alpha/02-second.md` (new).
- `test/e2e/fixtures/three-objective/plan/journey/beta/objective.md` (new).
- `test/e2e/fixtures/three-objective/plan/journey/beta/01-first.md` (new).
- `test/e2e/fixtures/three-objective/plan/journey/beta/02-second.md` (new).
- `test/e2e/fixtures/three-objective/plan/journey/gamma/objective.md` (new).
- `test/e2e/fixtures/three-objective/plan/journey/gamma/01-first.md` (new).

**Seam (GREEN).** The fixture profile and P1-E4 now select one closed plan axis for source delivery and expected counts.
**Refactor.** Applied: centralized plan source, fixture root, and expected state metadata in one exported table.
**Build check.**

- typecheck: exit 0
  **Assumptions.**
- VERIFIED: the new fixture has three objectives, five tasks, and gamma dependencies on alpha and beta.
- VERIFIED: no tests, test helpers, configuration, plans, or pipeline guards changed.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — second-client-topology · Task 09

**Cycle.** Confirmed Story 08 handoff; RED for Task `09-second-client-topology` (`.agent/plan/stories/020-wiring-and-scenarios/09-second-client-topology.md`).
**Prior GREEN-only confirmation.**

- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- `npm run typecheck` → exit 0.
  **Test written.**
- file: `scripts/e2e/lib/podman/topology.test.ts` (edited) — suite: `scripts/e2e/lib/podman/topology.test` — methods: `planTopology(runId) returns exactly the thirteen pinned fields, and is pure`, `createTopology issues exactly nine commands, in order, each carrying the run-id label, with the two secret creates before the daemon run`, `the second client container carries no daemon volume mount`, `context.taken() after createTopology deep-equals, in take order, network/volume/pod/fixture/daemon/client/client2 with their kinds`, `startDaemon then stop() then startDaemon issues two write-config-then-migrate-then-token-install-then-token-write-then-serve exec sequences, delivers the token to all three containers each time, and one pkill, and no podman run or podman rm in between`
- file: `scripts/e2e/lib/disclosure.test.ts` (edited) — suite: `scripts/e2e/lib/disclosure.test` — method: `a leak present only in the second client's inspect output rejects naming no-disclosure-podman-inspect`
- file: `scripts/e2e/lib/driver/interface.test.ts` (edited) — suite: `scripts/e2e/lib/driver/interface.test` — methods: `createPodmanDriver maps client2 to the second client container`, `createPodmanDriver collects daemon, client and client2 logs`
- asserts: the topology creates and records the second client, disclosure inspection covers it, and drivers expose its identity and logs.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `✖ createPodmanDriver maps client2 to the second client container (1.273208ms)`
- summary: `ℹ tests 4617`, `ℹ pass 4604`, `ℹ fail 13`.
  **Open to Software Engineer.**
- `scripts/e2e/lib/podman/topology.ts`: `Topology`, `planTopology(runId)`, and `createTopology(...)` expose and create the second client container.
- `scripts/e2e/lib/disclosure.ts`: `assertNoDisclosure(...)` inspects the second client container.
- `scripts/e2e/lib/driver/index.ts`: `HostRole` accepts `"client2"`.
- `scripts/e2e/lib/driver/podman.ts`: `createPodmanDriver(...)` maps `"client2"`, delivers the configured token to both clients, and returns logs for `daemon`, `client`, and `client2`.
- `scripts/e2e/lib/driver/ssh.ts`: `createSshDriver(...)` accepts `"client2"` with the client host behavior.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — second-client-topology · second client infrastructure

**Cycle.** GREEN+REFACTOR for `scripts/e2e/lib/podman/topology.test.ts`, `scripts/e2e/lib/disclosure.test.ts`, and `scripts/e2e/lib/driver/interface.test.ts`.
**Files changed.**

- `scripts/e2e/lib/podman/topology.ts` (edited) — second client topology field, Podman run, and ledger cleanup.
- `scripts/e2e/lib/disclosure.ts` (edited) — second client inspect coverage.
- `scripts/e2e/lib/driver/index.ts` (edited) — `HostRole` includes `client2`.
- `scripts/e2e/lib/driver/podman.ts` (edited) — client2 mapping, token delivery, and log collection.
- `scripts/e2e/lib/driver/ssh.ts` (edited) — client2 uses the client SSH target.
  **Seam (GREEN).** The Podman topology and drivers create, inspect, authenticate, route, and collect logs for both clients.
  **Refactor.** Applied: made Podman and SSH role routing explicit with exhaustive role branches.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: no tests ran in this turn.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — driver-api-and-token-capture · Task 10

**Cycle.** Confirmed GREEN for Task `09-second-client-topology`; RED for Task `10-driver-api-and-token-capture` (`.agent/plan/stories/020-wiring-and-scenarios/10-driver-api-and-token-capture.md`).
**Prior GREEN confirmation.**

- Handoff gate: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- Exact Story 09 tests: `node --test scripts/e2e/lib/podman/topology.test.ts scripts/e2e/lib/disclosure.test.ts scripts/e2e/lib/driver/interface.test.ts` → exit 0 — `ℹ tests 34`, `ℹ pass 34`, `ℹ fail 0`.
  **Test written.**
- file: `scripts/e2e/lib/driver/interface.test.ts` (edited) — suite: `scripts/e2e/lib/driver/interface.test` — methods: `cli and cliAs("client") reach the same target with the same arguments`, `issue and issueAs("client") build the same request`, `registerActor returns no token field`, `registerActor runs as the configured human actor`, `two registrations on one role return two distinct token paths`, `cliAs appends --api-token-file only when the caller passes one`, `no driver reads a token file in the runner process`, `the recorded registration prints no token`, `startDaemon carries leaseTtlMs into the daemon settings payload`
- asserts: all three drivers expose the new API, client-role delegation preserves targets and requests, actor registration returns only its id and token-file path, caller-selected token files stay explicit, registration output stays redacted, and the lease term reaches daemon settings.
  **RED proof.**
- command: `node --test scripts/e2e/lib/driver/interface.test.ts scripts/e2e/lib/driver/local.test.ts scripts/e2e/lib/driver/ssh.test.ts scripts/e2e/lib/driver/podman-issuer.test.ts`
- exit: non-zero — failure: `✖ driverMethodNames has exactly the ExecutionDriver keys, in declaration order (1.671209ms)`
- summary: `ℹ tests 31`, `ℹ pass 18`, `ℹ fail 13`.
- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0.
  **Open to Software Engineer.**
- `scripts/e2e/lib/driver/index.ts`: `ExecutionDriver.cliAs(role: HostRole, argv: readonly string[], options?: Readonly<{ tokenFile?: string }>): Promise<CommandRecord>`, `ExecutionDriver.issueAs(role: HostRole, request): Promise<Readonly<{ status: number; body: string }>>`, `ExecutionDriver.registerActor(role: HostRole, name: string): Promise<Readonly<{ actorId: string; tokenFile: string }>>`, `HttpIssuer` request `tokenFile?: string`, and `DaemonConfig.leaseTtlMs: number`.
- `scripts/e2e/lib/driver/local.ts`, `scripts/e2e/lib/driver/podman.ts`, `scripts/e2e/lib/driver/ssh.ts`: expose those driver members and satisfy the stated behavior.
- `scripts/e2e/podman/bin/e2e-request.mjs`: accept the request `tokenFile` field and authenticate with that file.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — driver-api-and-token-capture · driver API and secure token capture

**Cycle.** GREEN+REFACTOR for `scripts/e2e/lib/driver/interface.test.ts`.
**Files changed.**

- `scripts/e2e/lib/driver/index.ts` (edited) — driver methods, request token path, and lease term.
- `scripts/e2e/lib/driver/local.ts` (edited) — child-process HTTP issuer, CLI role seam, and actor registration.
- `scripts/e2e/lib/driver/podman.ts` (edited) — role issuers, token paths, CLI auth, and lease payload.
- `scripts/e2e/lib/driver/ssh.ts` (edited) — remote token-file issuer, CLI role seam, actor registration, and lease payload.
- `scripts/e2e/podman/bin/e2e-request.mjs` (edited) — bearer authentication from `tokenFile` inside the client.
- `scripts/e2e/lib/scenario/journey.ts` (edited) — phase-1 lease default.
- `scripts/e2e/lib/scenario/p1-e2.ts` (edited) — phase-1 lease default.
- `scripts/e2e/lib/scenario/p1-e4.ts` (edited) — phase-1 lease default.
- `scripts/e2e/lib/scenario/transport.ts` (edited) — refusal lease default.
- `.agent/tdd/memory/software-engineer/2026-08-17.md` (appended) — decision journal.
  **Seam (GREEN).** Each driver selects a host role, passes explicit token paths, and keeps token reads outside the runner process.
  **Refactor.** Applied: centralised per-role delegation and reused the child request protocol for token-file authentication.
  **Build check.**
- `npm run typecheck`: blocked by stale test-lane mocks that omit `leaseTtlMs`, `cliAs`, `issueAs`, and `registerActor`.
  **OPEN: blocker.**
- `<B1> - status:OPEN - action:YES - stale Story 10 test mocks - update scripts/e2e/lib/driver/local.test.ts, scripts/e2e/lib/driver/ssh.test.ts, scripts/e2e/lib/podman/topology.test.ts, scripts/e2e/lib/profile/profile.test.ts, scripts/e2e/lib/scenario/journey.test.ts, scripts/e2e/lib/scenario/p1-e5.test.ts, and scripts/e2e/lib/scenario/startup-refusal.test.ts - fix:add leaseTtlMs and the three driver members to each test fixture - why:npm run typecheck includes these test targets, and the software-engineer lane cannot edit them`

ATTEMPT-FAILED: 10-driver-api-and-token-capture — npm run typecheck cannot pass until test-lane mocks adopt the required API and lease field

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — driver-api-and-token-capture · Task 10 GREEN + proposal-scenario-declarations · Task 11

**Cycle.** Confirmed GREEN for Task `10-driver-api-and-token-capture`; GREEN-ONLY pass-through for Task `11-proposal-scenario-declarations`.

**Test-lane blocker resolved.**

- Updated the seven named test fixtures with `leaseTtlMs`, `cliAs`, `issueAs`, and `registerActor` where their types require them.
- No production, configuration, plan, or pipeline file changed.

**Prior GREEN confirmation.**

- Handoff verification: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- Exact Story 10 tests: `node --test scripts/e2e/lib/driver/interface.test.ts scripts/e2e/lib/driver/local.test.ts scripts/e2e/lib/driver/ssh.test.ts scripts/e2e/lib/driver/podman-issuer.test.ts` → exit 0 — `ℹ tests 31`, `ℹ pass 31`, `ℹ fail 0`, `ℹ cancelled 0`, `ℹ skipped 0`, `ℹ todo 0`.
- `npm run typecheck` → exit 0 — `> kanthord@27.8.1 typecheck` and `> tsc --noEmit`.

**Story file.** `.agent/plan/stories/020-wiring-and-scenarios/11-proposal-scenario-declarations.md`
**Tasks forwarded to Software Engineer.**

- `11-proposal-scenario-declarations`: `.agent/plan/stories/020-wiring-and-scenarios/11-proposal-scenario-declarations.md` — add the three declared P1B scenario sections to the phase-1 proposal.
  **No RED phase.** Story 11 has no `Action — RED:` block; its parity coverage belongs to Story 12.
  **Open to Software Engineer.**
- Implement GREEN+REFACTOR per the Story file's Action sections.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — proposal-scenario-declarations · locked proposal

**Cycle.** GREEN+REFACTOR for Story `11-proposal-scenario-declarations`.
**Files changed.**

- None in production — the required proposal file is locked by the orchestrator contract.
- `.agent/tdd/memory/software-engineer/2026-08-17.md` (appended) — decision journal.
  **Seam (GREEN).** No implementation is possible while the Story-required proposal edit remains locked.
  **Refactor.** Deferred: the required proposal sections must be added after the lock is removed.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 11 requires appending `P1B-E1`, `P1B-E2`, and `P1B-E3` to `docs/proposal/phase-1/README.md`.
- VERIFIED: the orchestrator contract forbids editing that proposal file.

**OPEN: blocker.**

- `<B1> - status:OPEN - action:YES - locked proposal scenario declarations - append the three Story 11 sections to docs/proposal/phase-1/README.md - fix:unlock the proposal file and add the required P1B-E1, P1B-E2, and P1B-E3 sections - why:the Story has no other implementation path, and the orchestrator contract forbids the required edit`

ATTEMPT-FAILED: 11-proposal-scenario-declarations — the required proposal file is locked by the orchestrator contract

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — runner-axes-and-assertion-floor · GREEN-only Tasks

**Cycle.** Confirmed Story `11-proposal-scenario-declarations`; GREEN-ONLY pass-through for Task `12-runner-axes-and-assertion-floor`.
**Story 11 confirmation.**

- The proposal has exactly these seven headings, in order: `P1-E1`, `P1-E2`, `P1-E4`, `P1-E5`, `P1B-E1`, `P1B-E2`, `P1B-E3`.
- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- `npm run typecheck` → exit 0.
  **Story file.** `.agent/plan/stories/020-wiring-and-scenarios/12-runner-axes-and-assertion-floor.md`
  **Tasks forwarded to Software Engineer.**
- `12-runner-axes-and-assertion-floor`: `.agent/plan/stories/020-wiring-and-scenarios/12-runner-axes-and-assertion-floor.md` — add the runner axes, scenario lists, independent assertion manifests, and assertion-floor checks.
  **No RED phase.** Story 12 has no `Action — RED:` block; coverage is owned elsewhere per the Story gate.
  **Open to Software Engineer.**
- Implement GREEN+REFACTOR in the Story's named `scripts/**` paths.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — runner-axes-and-assertion-floor · scenario runner axes and assertion floor

**Cycle.** GREEN+REFACTOR for Task `12-runner-axes-and-assertion-floor`.
**Files changed.**

- `scripts/e2e/lib/tag.ts` (edited) — added the three P1B scenario ids.
- `scripts/e2e/lib/main.ts` (edited) — added the P1B axis and pre-outcome assertion-manifest check.
- `scripts/e2e/lib/record/verdict.ts` (edited) — required all three P1B bundles.
- `scripts/e2e/lib/bundle.ts` (edited) — exposed ordered assertion names from the bundle writer.
- `scripts/e2e/lib/scenario/assertions.ts` (new) — added independent journey, fixture-profile, transport, and phase-1 manifests.
- `.agent/tdd/memory/software-engineer/2026-08-17.md` (appended) — decision journal.
  **Seam (GREEN).** The runner accepts the P1B ids, records assertion names, and rejects missing or mismatched manifests before outcome writing.
  **Refactor.** Applied: isolated ordered-name comparison and kept every assertion fragment independent from its producer.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 12 adds no scenario declaration; phase-1 manifests remain `"non-empty"`.
- VERIFIED: `npm run e2e -- --mint-tag` printed a valid tag.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — harness-loop · Task 13

**Cycle.** Confirmed Story `12-runner-axes-and-assertion-floor`; RED for Task `13-harness-loop` (`.agent/plan/stories/020-wiring-and-scenarios/13-harness-loop.md`).
**Story 12 confirmation.**

- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
  **Test written.**
- file: `scripts/e2e/lib/scenario/harness.test.ts` (new) — suite: `scripts/e2e/lib/scenario/harness.test` — methods: `registerHarness returns the actor id and the token file and no token`, `runHarnessTask issues claim, heartbeat and report in that order`, `runHarnessTask returns the fence, run id, attempt number and object id it parsed`, `runHarnessTask records its four assertion names in order`, `attestObjective sends the fence and the object id`, `two labels produce two disjoint name sets`
- asserts: harness registration returns only the actor identity fields, task execution preserves command order and parsed values, attestation carries its inputs, and assertion names stay ordered and disjoint.
  **RED proof.**
- command: `node --test scripts/e2e/lib/scenario/harness.test.ts`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/scripts/e2e/lib/scenario/harness.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/scripts/e2e/lib/scenario/harness.test.ts`
- stub probe: `scripts/e2e/lib/scenario/harness.ts` — clean; probe deleted before handoff.
  **Open to Software Engineer.**
- `scripts/e2e/lib/scenario/harness.ts`: export `HarnessIdentity`, `HarnessTaskResult`, `registerHarness(driver: ExecutionDriver, role: HostRole, name: string): Promise<HarnessIdentity>`, `runHarnessTask(context: ScenarioContext, driver: ExecutionDriver, identity: HarnessIdentity, input: Readonly<{ nodeId: string; objectId: string; label: string }>): Promise<HarnessTaskResult>`, `attestObjective(context: ScenarioContext, driver: ExecutionDriver, identity: HarnessIdentity, input: Readonly<{ nodeId: string; fence: number; objectId: string; label: string }>): Promise<void>`, `harnessTaskAssertionNames(label: string): readonly string[]`, and `attestAssertionNames(label: string): readonly string[]`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — harness-loop · role-aware harness seam

**Cycle.** GREEN+REFACTOR for `scripts/e2e/lib/scenario/harness.test.ts`.

**Files changed.**

- `scripts/e2e/lib/scenario/harness.ts` (new) — harness registration, task execution, objective attestation, claim parsing, and assertion-name helpers.
- `.agent/tdd/memory/software-engineer/2026-08-17.md` (appended) — decision journal.

**Seam (GREEN).** The harness uses role-scoped CLI calls, passes the token-file path, parses claim output, and records the required assertions.
**Refactor.** Applied: isolated claim parsing and token-file option construction from the command sequence.
**Build check.**

- typecheck: exit 0
  **Assumptions.**
- VERIFIED: no tests ran in this turn.
- VERIFIED: no test, fixture, configuration, plan, proposal, or pipeline-guard file changed.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — p1b-e1-single-harness · Task 14

**Cycle.** Confirmed GREEN for Task `13-harness-loop`; RED for Task `14-p1b-e1-single-harness` (`.agent/plan/stories/020-wiring-and-scenarios/14-p1b-e1-single-harness.md`).
**Prior GREEN confirmation.**

- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- `node --test scripts/e2e/lib/scenario/harness.test.ts` → exit 0 — `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`.
  **Test written.**
- file: `scripts/e2e/lib/scenario/p1b-e1.test.ts` (new) — suite: `scripts/e2e/lib/scenario/p1b-e1.test` — methods: `calls runJourney exactly once before it registers a harness`, `records its assertion names in the declared order`, `claims alpha's first task, alpha's second task and the authored task in that order`, `authors both nodes under alpha before any claim`, `signs no plan.revisions request with the harness token`, `sends the node revision on the update and the project revision on the delete`, `reads the authored task as ready before it claims it`, `reads the ready frontier as three identities, the authored task included`, `asserts gamma pending by identity and never by count`, `builds the fixture profile on the three-objective axis`
- asserts: the local scenario runs the journey before harness registration, authors both alpha tasks through the required graph operations, uses returned revisions, keeps plan revisions human-only, preserves readiness identity, and records the declared assertion order.
  **RED proof.**
- command: `node --test scripts/e2e/lib/scenario/p1b-e1.test.ts`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/scripts/e2e/lib/scenario/p1b-e1.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/scripts/e2e/lib/scenario/p1b-e1.test.ts`
- stub probe: `scripts/e2e/lib/scenario/p1b-e1.ts` — clean; probe deleted before handoff.
  **Open to Software Engineer.**
- `scripts/e2e/lib/scenario/p1b-e1.ts`: export `p1bE1: ScenarioDeclaration`; export `runP1BE1(context: ScenarioContext, driver: ExecutionDriver, profile: ScenarioProfile, runJourney?: (context: ScenarioContext, driver: ExecutionDriver, profile: ScenarioProfile) => Promise<JourneyResult>): Promise<void>`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — p1b-e2 two-client exit journey · Story 15

**Cycle.** GREEN-ONLY implementation for Story `15-p1b-e2-two-client-exit-journey`.
**Files changed.**

- `scripts/e2e/lib/scenario/p1b-e2.ts` (new) — `runP1BE2(context, driver, profile, runJourney?)`, `p1bE2: ScenarioDeclaration`, podman orchestration, ten phases.
- `scripts/e2e/lib/scenario/index.ts` (edited) — `P1B-E2` declaration: mode `deterministic`, driver `podman`, profile `fixture`, plan `three-objective`.
- `scripts/e2e/lib/scenario/assertions.ts` (edited) — `P1B-E2` manifest, 73 names, composed as `[...fixtureProfileAssertionNames, ...journeyAssertionNames, ...phase names with harnessTaskAssertionNames(label) in emission position, ...transportAssertionNames]`.
- `scripts/e2e/lib/profile/fixture.ts` (edited) — `createPodmanFixtureProfile(context, execute, topology, driver, plan)`; delivers the fixture HTTP token into the daemon container, runs the origin probe (asserting the three fixture rows), and delivers the plan directory to the client.
  **Seam (GREEN).** The scenario registers `p1b-e2-first` on `client` and `p1b-e2-second` on `client2`, races both `node.claim` requests in flight (winner becomes `alphaActor`, loser `betaActor`), and drives all ten phases with assertion names exactly matching the declared manifest.
  **Refactor.** Applied: isolated response parsing, graph discovery by fixture objective title, and event parsing from the scenario sequence; kept the fixture token delivery in the profile module.
  **Build check.**
- typecheck: exit 0
- lint: exit 0
- `node --test` on discipline, harness, p1b-e1, profile, driver interface, topology: 60 pass / 0 fail.
- Throwaway simulation (temp dir, removed): both race outcomes record the exact 73-name manifest; idempotency key/path/token files and transport-from-client2 verified.
  **Assumptions.**
- VERIFIED: `node.list` returns nodes ordered by id, so objective identity is matched by fixture title (`Alpha`/`Beta`/`Gamma`) rather than listing order.
- VERIFIED: `node.close` by a harness answers `403 actor-forbidden` (`close-objective.ts:62-65`).
- VERIFIED: the podman driver exposes no `topology` field and `assertDriverShape` pins the exact key set, so the profile is built by the scenario-owned `createPodmanFixtureProfile` instead of `createFixtureProfile` (whose podman origin source cannot resolve).

END: SOFTWARE-ENGINEER

## RECONSTRUCTION — the missing story logs, 2026-08-18

**This entry is written after the fact by the orchestrator, not by the lane that did the work.** It records what the tree shows. It does not restate a RED proof, a stub probe or a handoff that no one observed. Treat every unverified item below as unverified.

**The gap.** The log runs from `TEST-ENGINEER — p1b-e1-single-harness · Task 14` directly to `SOFTWARE-ENGINEER — p1b-e2 two-client exit journey · Story 15`. Four lane entries are absent.

- SOFTWARE-ENGINEER for Story 14, `p1b-e1` GREEN.
- TEST-ENGINEER for Story 15, `p1b-e2` RED.
- TEST-ENGINEER for Story 16, `p1b-e3` RED.
- SOFTWARE-ENGINEER for Story 16, `p1b-e3` GREEN.

**Story 16 artifacts, present and green.** Each item is read from the tree today.

- `scripts/e2e/lib/scenario/p1b-e3.ts` — untracked. Exports `runP1BE3`, `p1bE3`, `takeoverLeaseTtlMs` (2000), `takeoverPollIntervalMs` (250), `takeoverPollDeadlineMs` (60000), `wallClockDependency`.
- `scripts/e2e/lib/scenario/p1b-e3.test.ts` — untracked. Seven tests: `configures the daemon with a lease term of 2000 ms`, `polls at 250 ms to a 60000 ms deadline`, `sleeps no lease term`, `asserts the takeover fence is greater than the first`, `keeps its diagnostics on timeout`, `asserts exactly one outcome.reported record naming the second actor`, `records its assertion names in the declared order`.
- The declaration at `scripts/e2e/lib/scenario/index.ts:76`, the manifest in `scripts/e2e/lib/scenario/assertions.ts`, the id in `scripts/e2e/lib/tag.ts:13` and `scripts/e2e/lib/record/verdict.ts:27`, the proposal section at `docs/proposal/phase-1/README.md:136`.

**Not verifiable from the tree.** No record exists of the RED proof, the stub probe, the seam handoff or the refactor for any of the four absent entries. The orchestrator asserts none of them.

END: RECONSTRUCTION

## HUMAN SESSION — defect repair and CLI normalization, 2026-08-18

**Cycle.** Not a TDD lane. Defects found by running the epic Proof, repaired with the human in the loop. Every command below was run and its result observed.

**B1 — rejected.** A review bullet claimed `P1B-E1` stops at `reimport-stale-revision` because the EPIC 016 journey repair had not landed. The premise is false in both halves. `grep -rn "tasksAllPending" scripts/` returns nothing and `expectedPendingTaskCount` / `expectedReadyTaskCount` drive `status-counts`, so the EPIC 016 repair is in the tree. That repair never touched `reimport-stale-revision`.

**B2 — the stale-revision oracle, fixed.** EPIC 017 (`5df22da`) renamed the refusal detail from `current` to `actual` and added `guard`; `src/http/contract/error-details.ts:20-24` is the authority. `scripts/e2e/lib/scenario/journey.ts` still read `details.current`. Repaired the oracle and the three fakes at `journey.test.ts:415`, `p1-e5.test.ts:499`, `p1-e4.test.ts:157`, which all still emitted the pre-017 shape and hid the drift. Defect owed to EPIC 017.

**B3 — the three-objective readiness split, fixed.** `src/domain/readiness.ts:65` gates readiness on dependency edges only, so `gamma/01-first.md`, which carries no `depends_on`, is `ready` while objective gamma is `pending`. EPIC 020 assumed the opposite in four places: `profile/fixture.ts:46-47` (`3`/`2` → `2`/`3`), `p1b-e1.ts:262`, `p1b-e2.ts:202`, and the `ready-frontier` expectation, which now carries `gammaFirstId`. The stale pair also stood in the test-local profiles of `p1b-e1.test.ts` and `p1b-e2.test.ts`.

**B4 — the claim and heartbeat argument shape, fixed then superseded.** `node claim --id` answered `error: unknown option '--id'`. The scenarios were adapted to the CLI, then the CLI was normalized instead. See below.

**The assertion manifest, fixed.** `assertNoDisclosure` records eight names for every podman scenario. The `P1B-E2` and `P1B-E3` manifests omitted them, so `P1B-E2` failed the order check at position 73 with all 81 assertions passing. Added `disclosureAssertionNames` to `scripts/e2e/lib/scenario/assertions.ts` and appended it to both manifests. The two unit suites assert the body names plus that tail, because the tail is appended by the podman wrapper and not by the scenario body.

**`P1B-E3` outcome parser, fixed.** `p1b-e3.ts:238` matched the subject as `task/<id>`. `src/cli/event/list.ts:99` prints `subjectKind`, which is `node`.

**CLI normalization.** The human asked for the convention to be settled. `--id` names a command's own subject; `--<entity>` names a reference. `node claim`, `node heartbeat`, `node release`, `node show` moved from a positional argument to `--id`; `node unblock` moved from `--node` to `--id`. Each follows the `close.ts` guard idiom, and each gained the missing-option test that branch never had. Updated `src/cli/reachability.test.ts` and every `scripts/e2e` caller and fake.

**Deferred.** `docs/proposal/open-items.md` records the CLI grammar as an open decision with three named questions and its mechanism. No grammar test ships in this epic.

**Proof, observed 2026-08-18.**

- `npm run typecheck` → 0. `npm run lint` → 0. `npm run verify` → 0.
- `node --test` over every `src/cli` test path → `tests 350`, `pass 350`, `fail 0`.
- `node --test` over every `scripts/e2e` test path → `tests 375`, `pass 375`, `fail 0`.
- `node scripts/e2e/run.mjs` → `P1B-E1` 0, `P1B-E2` 0, `P1B-E3` 0, `P1-E1` 0, `P1-E2` 0, `P1-E4` 0.
- Bundle outcomes `passed`, zero failed assertions: `P1B-E1` 66, `P1B-E2` 81, `P1B-E3` 40, `P1-E4` 40.

**Assumptions.**

- VERIFIED: podman was started for this run; the three podman scenarios report `unavailable` with exit 3 when it is not reachable, and that is not a failure.
- VERIFIED: nothing is committed. The tree carries every change above as working-tree state.

END: HUMAN SESSION

## HUMAN SESSION — review findings applied, 2026-08-18

**Cycle.** Orchestrated review gate returned FAIL with 7 blockers and 7 suggestions. The human accepted every item and chose the resolution for each `action:NO` one. Every command below was run and its result observed.

**B1 — the three-objective fixture, proved hermetically.** `scripts/e2e/lib/fixtures.test.ts` is parametrised over a two-row table. Each root now carries the five original cases. Two cases are new: gamma's objective declares both sibling objectives in document order, and no task of the fixture declares a cross-parent `depends_on`.

**B2 — the profile counts, proved per axis.** `scripts/e2e/lib/profile/profile.test.ts` gains one counts case and one plan-source case per axis value, over a closed table.

**B3 — the proposal parity assertion.** `scripts/e2e/lib/scenario/discipline.test.ts` reads the `### <id> — ` headings of the `## End-to-end scenarios` section of `docs/proposal/phase-1/README.md` and compares them with `knownScenarioIds`, in order. `knownScenarioIds` is now exported from `scripts/e2e/lib/main.ts`. **Negative proof observed**: truncating the proposal at the `P1B-E3` heading fails the case.

**B4 — two discipline cases.** `no P1B entry of expectedAssertions is empty`, and `no expected fragment is imported from its producer`. The second denies `journey.ts`, `profile/fixture.ts`, `transport.ts` and every scenario module, and allows `./harness.ts`, which Story 13 sanctions. **Negative proof observed**: adding `import "./journey.ts"` to `assertions.ts` fails the case.

**B5 — the assertion floor's negative proof.** `main` accepts an optional `scenarios` override beside `execute`, `verify` and `acceptance`. `scripts/e2e/lib/main.test.ts` drives a no-op scenario and asserts the exact refusal line `scenario P1B-E1 assertion name mismatch at position 0: expected fixture-head-symref, recorded <none>`, a non-zero exit, and a bundle whose `assertions` array is empty. The message is pinned so the case cannot pass for an incidental reason.

**B6 — each producer pinned to its fragment.** `journey.test.ts`, `profile.test.ts` and `transport.test.ts` each assert that the names their producer records equal `journeyAssertionNames`, `fixtureProfileAssertionNames` and `transportAssertionNames`, in order.

**B7 — the CLI normalization is kept, and the owning plans are amended.** The human chose to keep the `--id` grammar. Amended in the same change: `.agent/plan/stories/018-claim-and-lease/16-cli-commands.md` (four leaves), `.agent/plan/stories/019-outcome-report/19a-node-unblock.md`, `.agent/plan/epics/111-inspection-and-manual-controls.md:53,142`, and the `One new CLI command` non-goal of `.agent/plan/epics/020-wiring-and-scenarios.md`, which now states the normalization and names the amended files.

**S1** — `race-one-lease-held` asserts `{status, code}` through `errorRecord`, matching its two neighbours.
**S2** — `realClock` moved to `scripts/e2e/lib/scenario/clock.ts`. The `readiness.test.ts` guard exempts that one file rather than the whole scenario module, and its name states both exempt files. **Negative proof observed**: a `setTimeout` added to `p1b-e3.ts` now fails the guard, which the file-wide exemption allowed.
**S3** — the `plan: PlanAxis` default is dropped at both `fixture.ts` call sites; every caller names its axis.
**S4** — `registerEventList` uses `eventCommand`, as every sibling group does.

**S5 — NOT IMPLEMENTED AS DIRECTED, and the reason is a domain rule.** The human chose to give `gamma/01-first.md` a `depends_on` so `gamma-first-task-ready` proves a transition. **That is impossible.** `docs/proposal/phase-1/domain.md:18` makes a cross-parent dependency a structural finding, and `src/domain/plan-validate.ts:271-278` raises `dependency-cross-parent` when `derivedParentPath` differs. A task under `gamma/` may depend only on a document under `gamma/`, so it cannot depend on the alpha or beta objective. **Verified empirically**: adding those two entries made `node scripts/e2e/run.mjs P1B-E1` fail at `plan-imported`, and the fixture was restored. Resolution applied instead is S5 option (a): `020-wiring-and-scenarios.md:104`, Story 14 step 7 with its test bullet, and Story 15 phase 7 now state that gamma's first task reads `ready` throughout, that readiness gates on `depends_on` edges alone, and that containment gates no readiness.

**S6** — `docs/proposal/phase-1/README.md:76` now reads "two tasks `pending` and two `ready`".
**S7** — `docs/proposal/open-items.md` names the three amended planning files and no longer over-claims.

**Proof, observed 2026-08-18.**

- `npm run typecheck` → 0. `npm run lint` → 0. `npm run verify` → 0.
- EPIC 020 Proof unit leg → `tests 367`, `pass 367`, `fail 0`.
- `node scripts/e2e/run.mjs` → `P1B-E1` 0, `P1B-E2` 0, `P1B-E3` 0, `P1-E1` 0, `P1-E2` 0, `P1-E4` 0, then `PASS EPIC-020`.
- Bundle outcomes `passed`, zero failed assertions: `P1B-E1` 66, `P1B-E2` 81, `P1B-E3` 40, `P1-E1` 20, `P1-E2` 16, `P1-E4` 40.
- Sibling regression proofs → `PASS EPIC-018`, `PASS EPIC-019`.

**Assumptions.**

- VERIFIED: nothing is committed.

END: HUMAN SESSION

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS — `npm run verify` exit 0
- proof: PASS (exact EPIC Proof command) — "PASS EPIC-020"
- stories: 16/16 complete
- date: 2026-08-18
- state: local-uncommitted

**Review record.** The `reviewer-engineer` gate of 2026-08-18 returned FAIL with 7 blockers and 7 suggestions against the pre-fix tree. All fourteen findings are addressed in the `HUMAN SESSION — review findings applied` entry above, except S5, which a domain rule makes impossible as directed and which was resolved by its stated alternative. **No reviewer re-run followed those fixes**; the verdict below is the human's, recorded at the human's instruction.

HUMAN_REVIEW: PASS
