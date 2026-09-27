# ERD 1 plan decisions

The plans cite these decisions as D1 to D16. Each decision binds every plan and every task.

## D1 — A blocker is only a real gap

A blocker is a behavior question that no page, sibling, ERD page or CLI page answers, or a real conflict between two of them. Grep the sources before you write a blocker. Cite the line that proves the gap. Cross-plan alignment, reading a source, splitting a task and a one-line fix are plan work, never a blocker.

## D2 — Error codes

Every error code has at least three parts (`architecture.impl.md:339`, enforced by `engine/src/kernel/errors.ts:8`). Ulrich ruled on 2026-09-27 that the pages carry every code that ERD 1 needs; Aelita chose the codes, and the owning pages name them. A CLI code follows the command rule of `architecture.impl.md` "the error codes". A plan uses each code verbatim from its page and invents none.

## D3 — Reads use `caller.commit`

`architecture.impl.md:618` and `:683` rule that every operation declares the store that `caller.commit` opens, and a handler performs one `caller.commit` on it. `engine/src/gateway/invocation.ts:326` refuses the commit when no idempotency reservation exists, which breaks every read. This is a code defect. Plan 07 owns the fix: task 07.0 (first task of Plan 07) allows exactly one `caller.commit` for every operation and completes the idempotency record only when a reservation exists. Every service plan uses `caller.commit` for its reads and raises no blocker about it. Plans 01–06 test handlers with a fake `CallerContext`; HTTP tests of reads come in Plan 07 after 07.0.

## D4 — Collaborations are required

Every cross-service collaboration in a `Dependencies` type is required, never optional and never defaulted to an empty answer. A missing dependency check must not permit a write silently. Colocated tests inject fakes. Plan 07 wires the real implementations.

## D5 — Repository seam

Plan 04 publishes `class RepositoryComponent` in `src/repository/index.ts`: `constructor(dependencies: { health?: HealthRegistry } = {})` runs `checkRepositoryTools()` and registers the `repository` component healthcheck; `gitLsRemote(sshUrl: string, context: Context, deadlineMs: number): Promise<void>`. Plan 05 declares a matching `RepositoryConnector` interface inline in its own `contract.ts` with exactly this method. Plan 07 constructs `new RepositoryComponent({ health })` and injects it into the Project Service. The call runs before `caller.commit`, as asynchronous work (`architecture.impl.md:681–683`).

## D6 — Worker catalog

Plan 03 creates the static catalog `src/worker/catalog.ts`. Project reads a catalog fact only through a Worker collaboration (a service reads no peer module internals). If Plan 05 needs a catalog fact beyond `validateEntry` (for example the worker kind: native or externally hosted, or the agent names of a worker), Plan 03's `contract.ts` declares the collaboration and Plan 05 consumes it; Aelita adds it to the index.

## D7 — Mission binding lookup

`resolveBinding(tx, projectId, bindingName): { bindingId: string; resourceIdentity: string } | null`. The kind is the first part of `resourceIdentity` (`01-setup.md:201`). Owner Plan 05, consumer Plan 06.

## D8 — Scope cuts

- No 503 stubs. An operation outside ERD 1 is absent.
- No Tracking wiring in ERD 1 until Ulrich rules (no page gives the interface methods).
- Configuration fields that only ERD 2 code reads (`worker.heartbeatWindow`, `worker.globalPrompt`) are out of ERD 1.

Blocker B4 removed the health-probe cut: every service and component has a component healthcheck, and Custody, Worker and Project implement their ERD 1 resource healthchecks (index "Shared conventions").

## D9 — Operation service key

`engine/src/gateway/openapi.ts:51` refuses an operation id that does not start with `<operation.service>.`. Custody declares `credential.*` operations (`custody.impl.md:169`), so their `service` value is `credential`.

## D10 — Pagination

Ulrich ruled on 2026-09-27, until a later ruling: a list that answers one item for each group key (one credential for each name, one enablement for each agent name) orders by that key in ascending alphabetical order, and the next page reads the keys greater than the cursor (`architecture.impl.md` "pagination"). Every other list orders by its primary key in descending order.

## D11 — `Text` fields

Ulrich ruled on 2026-09-27: a `Text` value is a nonblank string of at most `mission.textMaxBytes` UTF-8 bytes, and the configuration field defaults to `32768` (`mission-service.impl.md` "Configuration" and "Operation contracts"). The wire schema checks the nonblank rule; the handler checks the configured bound, because a configured value cannot live in a static schema. The bound applies at a write only. Node create, update, move, rebind, dependency edits, criterion set, retirement and the import are ERD 1 and are implemented.

## D12 — CLI groups

`architecture.impl.md:529–535` closes the set of top-level names; it does not require an empty group. Plan 08 adds no group without an ERD 1 command (no Intake or Tracking stub) and registers no BLOCKED command. A command outside ERD 1 is absent.

## D13 — Vertical slices and the E2E section

Ulrich ruled on 2026-09-27: each plan is a vertical slice. It wires its own service or component into `composeServices`, adds its own CLI group, and ends with an `## E2E` section and a last task `NN.E`.

- The test file is `src/apps/server/e2e-<plan slug>.test.ts`, and `pnpm run verify` runs it. `gatewayFixture` starts the real server on a loopback port with an in-memory store. `kanthord(args, env)` from `src/apps/server/cli-support.ts` runs the CLI as a subprocess with disposable XDG state.
- The scenario table holds the id `E<plan>.<n>`, the exact commands, the exit codes and the expected stdout fields or error code. Every command, option, output field and code comes verbatim from the CLI page and the owning design page.
- Setup goes through the CLI. The state check is a CLI read, never a store read. A capability with no CLI command (liveness, the health report) is driven over HTTP in the same file.
- A remote service is faked through a fixture injection point, never reached over the network.
- The task that declares a service's routes also adds its operations to `apiOperations` of `src/apps/server/openapi-integration.test.ts` and to `src/apps/cli/index.ts:298`, and regenerates `static/openapi.yaml` and `static/openapi/**`.

## D14 — Unwired peers and stand-ins

A plan constructs its service in `src/apps/server/index.ts` in the construction order scheduler, custody, worker, mission, project, gateway. For a peer that a later plan wires, it passes `unwired("<seam name>")` from `src/apps/server/unwired.ts` (Plan 01 creates it): the function throws `new CodedError("system.composition.unwired", "<seam name> is not wired.")`, so the production server fails closed.

Ulrich ruled on 2026-09-27 the stand-in rule. `composeServices` takes an optional `standIns` option, and only `gatewayFixture` passes it. A stand-in answers the true state of the absent peer: a dependency query answers `[]`, and `createMission` answers without a write. The plan that wires the real peer deletes the stand-in and adds the E2E scenario that proves the real rule. Plan 07 deletes `unwired.ts` and the `standIns` option, and a Plan 07 test asserts that no `unwired` import remains.

| Seam                                                               | Placed by | Replaced by |
| ------------------------------------------------------------------ | --------- | ----------- |
| Custody `agentProvidersDependentOn`, `enablementsDependentOnModel` | 01        | 03          |
| Custody `bindingsNaming`                                           | 01        | 05          |
| Worker `entriesOfAgent`                                            | 03        | 05          |
| Project `createMission`, `liveNodesPinning`                        | 05        | 06          |

## D15 — Table name

Ulrich ruled on 2026-09-27: the Custody table stays `credential` with no prefix. Custody is a component, not a service. The migration test carries one exemption (Plan 01). The Custody migration service name is `custody`; the Custody operation service key is `credential` (D9). Keep them as two named constants.

## D16 — Pre-existing deviations are findings, not blockers

Ulrich removed `gateway_token_denylist` on 2026-09-27, so the Gateway owns no table as `gateway-service.impl.md:487` rules. `static/openapi.yaml` (against `gateway-service.impl.md:217`) predates ERD 1. No ERD 1 plan changes it.
