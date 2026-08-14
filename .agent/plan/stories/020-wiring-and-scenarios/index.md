# EPIC 020 — Wiring, CLI and the external-drive scenarios — stories

Epic: `.agent/plan/epics/020-wiring-and-scenarios.md`
Prereq: EPIC 019 (sequence order). EPIC 015 supplies `allowedActors`, the actor routes and the `--token-file` capture path; EPIC 016 supplies the ready frontier and the repaired journey oracle; EPICs 017, 018 and 019 supply the node write, claim and report routes with their own CLI rows.

The block is assembled, three hermetic mechanisms prove every seam is bound, and three scenarios drive the packaged binary through the claim-to-close loop, two clients in two namespaces, and a lease takeover.

## Dispatch order

Numeric order, `01` to `16`. **Every story is independently green**: `npm run verify` exits 0 at the close of each one, with no exception. Two notes make that possible.

- **5 + 6** are a coupled pair. The recorder and the reachability test are one mechanism, and the recorder has no consumer until Story 6 lands.
- **Story 12 registers no scenario.** It lands the plan axis, the three ids in the three lists, the assertion-floor mechanism and the four phase-1 manifest entries. **Each of Stories 14, 15 and 16 adds its own `scenarios` entry and its own `expectedAssertions` entry, in the same change as its scenario module.** A declaration referencing a module that does not exist is the one ordering trap this expansion refuses; every story stays green on its own.

Four ordering facts are load-bearing:

- Story 1 precedes everything. It verifies the five sibling epics landed what this epic asserts, and a hole found there is returned to the owning epic.
- Story 3 precedes Story 6, because Story 6 holds one argument row for every `declaredCommands` entry, `event list` included.
- Story 11 precedes Story 12, because the proposal-parity assertion of Story 12 reads the three sections Story 11 writes.
- Stories 9 and 10 precede Story 15, because `P1B-E2` needs the second container and the three driver members.

## Stories

- 1 — the sibling preconditions, verified and not re-landed → `01-sibling-precondition-check.md`
- 2 — the registry-wide authorization inventory → `02-authorization-inventory.md`
- 3 — `kanthord event list`, the one command this epic ships → `03-event-list-command.md`
- 4 — CLI inventory parity for the block, by name → `04-cli-inventory-parity.md`
- 5 — `test/helpers/command-recorder.ts` → `05-command-recorder.md`
- 6 — every declared CLI leaf reaches its operation → `06-cli-reachability.md`
- 7 — the composition root, asserted complete over the block → `07-composition-root-sweep.md`
- 8 — the three-objective fixture and the plan axis → `08-three-objective-fixture.md`
- 9 — the second client, as the infrastructure it is → `09-second-client-topology.md`
- 10 — the driver API, and the secure token capture → `10-driver-api-and-token-capture.md`
- 11 — the proposal declares the three scenario ids → `11-proposal-scenario-declarations.md`
- 12 — the runner axes and the assertion floor → `12-runner-axes-and-assertion-floor.md`
- 13 — the harness loop, written once → `13-harness-loop.md`
- 14 — `P1B-E1`, the single-harness loop → `14-p1b-e1-single-harness.md`
- 15 — `P1B-E2`, the two-client exit journey → `15-p1b-e2-two-client-exit-journey.md`
- 16 — `P1B-E3`, the takeover → `16-p1b-e3-takeover.md`

The EPIC lists fourteen Story bullets. The mapping deviates in three places:

- `020-wiring-and-scenarios.md:50` splits into Story 5 (the recorder plus its own test) and Story 6 (the reachability rows), because the recorder is green on its own and the reachability test is not authorable before it exists.
- `020-wiring-and-scenarios.md:101`, the defects returned to siblings, becomes Story 1 and moves to the front, because it is a precondition of every later story rather than a closing note.
- `020-wiring-and-scenarios.md:81`, the deployment preconditions, introduces no code of its own. Its content lands as Constraints on Stories 15 and 16.

## Corrections this expansion carries

Three EPIC statements were stale against the sibling epics they cite. **All three are now amended in `020-wiring-and-scenarios.md` itself**, so the EPIC and these stories agree. They are recorded here because each changes a number or a mechanism a reader may remember differently.

- **Twelve routed operations, not eleven; five from EPIC 015, not four.** `015-actor-identity.md:66` declares `actor.register`, `actor.list`, `actor.show`, `actor.revoke` and `actor.rotate`, and `:127` raises parity by five. `015-actor-identity.md:39` instructs this epic to carry twelve. `020-wiring-and-scenarios.md:29,52` now say twelve and name `actor.rotate` in the fixture list. Story 7 adds twelve fixtures.
- **The token capture is the CLI `--token-file` option, not a `captureToken` mode.** `015-actor-identity.md:39` states that the option replaces the mode, that `registerActor` runs `cliAs(role, ["actor", "register", "--name", name, "--token-file", path])`, and that `scripts/e2e/podman/bin/e2e-request.mjs` gains no capture mode. `020-wiring-and-scenarios.md:39,68` now describe the option, and add that the credential is an explicit `cliAs` argument rather than driver state. Story 10 follows EPIC 015.
- **`eventView.payload` stays `z.unknown()`.** `019-outcome-report.md:80` and its story `14-event-payload-contract.md` keep `payload: z.unknown()` at `src/http/contract/event.ts:26`, and `src/http/contract/event-payload.ts` reaches a client as named OpenAPI components only. `020-wiring-and-scenarios.md:62` now states that it stays. Story 3 prints the `unknown` payload through its own canonical renderer and edits `src/http/contract/event.ts` not at all.

## Facts (needed for implementation)

- **The registry** — `src/http/contract/registry.ts:24-41`. `registry` is a bytewise-sorted `readonly Operation[]`; `findOperation(id)` is a linear find; `matchRoute(method, pathname)` at `:48-114` matches a live path against `entry.path`. There is no template-string matcher; Story 5 builds the first one.
- **`Operation`** — `src/http/contract/operation.ts:32-47`. `status` is `"routed" | "stubbed"`. EPIC 015 adds the required `allowedActors: readonly RegisteredActorKind[]` after `status`.
- **`renderPath`** — `src/http/contract/path.ts:97-105`. A parameter segment renders as `:id` or `:hash`; the `identity` kind never reaches the rendered string.
- **`src/main.test.ts`** — `pending` at `:18`, the `Fixture` type at `:33-37`, the fixture map from `:44`, the two cases at `:182` and `:220`. The EPIC cites `:181` and `:219`; the file is one line further on. The test calls through the real client with the configured token `"test-token"` at `:140`.
- **`src/main.ts`** — the handler map is `:213-337`, `event.list` is bound at `:313`, and `unimplementedFor(handlers)` is `:338`. `src/http/server/dispatch.ts:26-31` answers `501` for a routed operation with no bound handler.
- **`launchDaemon`** — `test/helpers/daemon.ts` spawns `node src/main.ts [--config] [--home] serve` and waits for `kanthord: ready`. It is the real composition root and never the packaged binary.
- **`ProgramDependencies`** — `src/cli/program.ts:33-51`. The four side-effect dependencies are `fetch` (`:35`), `writeFile` (`:39`), `migrate` (`:47-49`) and `serve` (`:50`). `buildProgram` is `:53`.
- **`declaredCommands`** — `src/cli/inventory.ts:6-71`, fifteen entries today, sorted by path. `commandPaths()` is `:73`. `compareCommandSets` and `programCommandPaths` live in `src/cli/parity.ts:8-30`, not in `inventory.ts`.
- **The block's seventeen commands** — five from EPIC 015 (`14-cli-actor-commands.md:38`), three from EPIC 017 (`15-cli.md:40-57`, where `node delete` names `node.show` first), five from EPIC 018 (`16-cli-commands.md:46-54`), three from EPIC 019 (`19-composition-root-and-cli.md:53-63`), and `event list` from Story 3. Thirty-two paths after the block.
- **The eight routed operations with no CLI command**, computed and confirmed: `blob.show`, `edge.list`, `project.status`, `provider.remove`, `provider.rename`, `provider.setDefault`, `provider.show`, `system.health`. `event.list` left that set because Story 3 ships its command.
- **`DaemonClient.call` gains a query argument** in EPIC 018 story `16-cli-commands.md:14-38`, plus a `CallInput.idempotencyKey`. Story 3 uses the query argument.
- **`src/cli/client.ts:63-73`** builds a fixed header set and admits no arbitrary header, which is why `issueAs` exists at all.
- **`src/cli/options.ts:34-42`** already declares `--api-token-file`; `resolveClientOptions` enforces mode `0600`, rejects a missing file and refuses `--token` with `--api-token-file` together. `requireLoopbackBaseUrl` at `:118-128` refuses `db migrate` against a non-loopback base url.
- **`ScenarioContext.assert(name, expected, actual)`** — `scripts/e2e/lib/scenario/context.ts:11`. `scripts/e2e/lib/bundle.ts:151-164` pushes an `AssertionRecord` and **throws on the first mismatch**, so a failing run records a prefix.
- **The assertion producers emit fixed ordered names** — `runJourney` at `scripts/e2e/lib/scenario/journey.ts` (every `context.assert` is unconditional), the probe rows of `scripts/e2e/lib/driver/origin-probe.ts:36-44`, and the row table of `scripts/e2e/lib/scenario/transport.ts:21-61`. Story 12 writes each expected list as an **independent literal in `assertions.ts`**, which imports no producer module. A fragment computed from the code it checks would shrink with that code and pass a deleted row, so the expectation must be able to disagree.
- **Three copies of the scenario id list** — `scripts/e2e/lib/tag.ts:6`, `scripts/e2e/lib/main.ts:44-48` and `scripts/e2e/lib/record/verdict.ts:20-25`. All three take the three new ids.
- **`--daemon-host` and `--client-host` are already refused for every id** at `scripts/e2e/lib/main.ts:611-622`. Story 12 adds tests and no code.
- **The runner seam for the assertion floor** — `scripts/e2e/lib/main.ts:664` calls `scenario.run(context)`, `:672` derives the outcome. The comparison goes between them, inside the same `try`.
- **`Topology`** — `scripts/e2e/lib/podman/topology.ts:4-17`, twelve fields, pinned at `topology.test.ts:36-53`. The client container run is `:200-215`, joins the network rather than the pod, and carries `sleep infinity`. The ledger order is network, volume, pod, fixture, token secret, master secret, daemon, client — pinned at `topology.test.ts:368-392`.
- **`ExecutionDriver`** — `scripts/e2e/lib/driver/index.ts:41-69`, fifteen members, pinned by name in `driverMethodNames` at `:71-87` and asserted through `Object.keys(driver).sort()` at `interface.test.ts:57-65`. `HostRole` at `:7` is `"daemon" | "client"` today.
- **`containerFor`** — `scripts/e2e/lib/driver/podman.ts:102-106` is a binary ternary, so any role other than `"daemon"` resolves to the one client container today. `startDaemon` delivers the token at `:249-250`; `collectLogs` at `:324` returns two keys.
- **`assertNoDisclosure`** — `scripts/e2e/lib/disclosure.ts:46`; it reads the raw `CommandRecord` at `:92-104` **before** redaction, and inspects containers at `:117-124`. Its happy path records eight assertion names, pinned at `disclosure.test.ts:207`.
- **`createFixtureProfile`** — `scripts/e2e/lib/profile/fixture.ts:86`; the plan constants are `:13-16`; it records one assertion per probe row at `:113` and returns `expectedObjectiveCount: 2`, `expectedTaskCount: 4` at `:132-133`. `p1-e4.ts` imports `fixturePlanSource` directly. `ScenarioProfile` is `scripts/e2e/lib/profile/index.ts:3-13`.
- **`scripts/e2e/lib/fixtures.test.ts` has no source module.** It is a standalone validator pinned to one fixture root, with five cases. Story 8 parametrises it.
- **The two-objective fixture format** — frontmatter keys `kind`, `title`, `depends_on`, `worker` for a task; `kind`, `title`, `repo` for an objective. `depends_on` entries are relative paths, and `docs/proposal/phase-1/plan-format.md:33` admits a sibling path.
- **`runJourney`** — `scripts/e2e/lib/scenario/journey.ts:91-95`, returning `JourneyResult` at `:14-22` with `credentialId`, `repositoryId`, `projectId`, `firstRevision`, `secondRevision`, `accepted` and `token`.
- **The proposal scenario section** — `docs/proposal/phase-1/README.md:57-112`, four `### P1-Ex` sections. `P1-E1` and `P1-E2` carry no `Driver`/`Profile` line; `P1-E4` and `P1-E5` do. The file ends at `:113`.
- **The lease term** — `018-claim-and-lease.md:48` puts `settings.leaseTtlMs` beside `attemptLimit`, default `300000`. `P1B-E3` configures `2000`.
- **`409 lease-held`** is the refusal for a stale fence, a sibling task of a held objective, and the objective itself — `018-claim-and-lease.md:7,26,40`.
- **`node show` gains `attestedObjectId` and `projection`** — `019-outcome-report.md:82`.
- **`test/helpers/proposal.ts`** reads the route matrix and compares `sql` fences with comments stripped. No proposal `sql` fence may move.
