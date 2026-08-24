# EPIC 009 — CLI surface and composition root — stories

Epic: `.agents/plan/epics/009-cli-and-composition-root.md`
Prereq: EPIC 007.5 (sequence order), expanded at `.agents/plan/stories/007.5-startup-recovery/` and not built. EPIC 008 is expanded at `.agents/plan/stories/008-project-and-plan/` and not built; this epic assembles what 007 and 008 wrote, so 008 must land first.

The program is assembled. Every declared CLI command exists and reaches a registered operation, every `routed` operation this phase has implemented is bound in `src/main.ts`, the daemon stops cleanly, and `npm run verify` proves it against a daemon it starts itself.

## Dispatch order

```
01 ─┬─→ 05 ─┬─→ 03
    ├─→ 06 ─┤
    └─→ 09 ─┤
02 ─────────┤
04 ─→ 05    │
            └─→ 07 ─→ 08
```

- **`01`, `02` and `04` depend on nothing in this epic.** Dispatch them in parallel. `01` and `02` touch no common file; `04` touches only `src/http/contract/`, `src/queries/`, `src/http/server/` and the `handlers` object of `src/main.ts`.
- `05` needs `01` (it registers into `buildProgram`) and `04` (it parses `systemStatusResponse`).
- `06` needs `01` only.
- **`05` and `06` each edit the subcommand literal in `src/cli/program.test.ts`.** They must not run concurrently. Order is `05` then `06`; whichever lands second writes the final eight-name list.
- `09` needs `01`, because it edits the `serve` function that story extracts. It is otherwise independent and may run beside `05` and `06`.
- `03` needs `01`, `02`, `05` and `06`. Its parity equality is false until `status` and `run` exist in the program.
- `07` needs `04`, `05`, `06`, `09` and every EPIC 008 handler binding: it drives both CLI commands against the started daemon and asserts the shutdown path. It is the last story that can fail on a missing binding. `03` and `07` are independent of each other and may run in parallel.
- `08` needs `07`, and it lands last, so the gate every earlier story ran is the gate this story leaves behind. `.agents/plan/stories/001-runtime-foundation/09-staged-verify.md:4` uses the same rule for the same reason. **The `package.json` line is the last edit of the epic** — applied before the script exists it turns `npm run verify` red for all nine stories. See B3.

## Stories

- 01 — the extracted program builder, `src/cli/program.ts` → `01-program-builder.md`
- 02 — the declared CLI inventory, `src/cli/inventory.ts` → `02-declared-cli-inventory.md`
- 03 — CLI inventory parity, `src/cli/parity.ts` → `03-cli-inventory-parity.md`
- 04 — the `system.status` route: schema, query, handler, binding → `04-system-status-route.md`
- 05 — `kanthord status` → `05-kanthord-status.md`
- 06 — `kanthord run` → `06-kanthord-run.md`
- 07 — the composition root, asserted complete, `src/main.test.ts` → `07-composition-root-asserted-complete.md`
- 08 — daemon-backed `npm run verify` → `08-daemon-backed-verify.md`
- 09 — graceful shutdown, `src/http/server/shutdown.ts` → `09-graceful-shutdown.md`

Nine stories for eight EPIC bullets. `01` is the one addition this expansion makes; see O1. `04` and `09` are additions the EPIC now declares, because the EPIC gained a `system.status` bullet (B1) and a shutdown bullet (S4).

## Where the code lands

| Directory            | Files this epic adds                                              |
| -------------------- | ----------------------------------------------------------------- |
| `src/cli/`           | `program.ts`, `inventory.ts`, `parity.ts`, `status.ts`, `run.ts`  |
| `src/domain/`        | `health.ts`                                                       |
| `src/queries/`       | `system/read-status.ts`                                           |
| `src/http/server/`   | `system/status.ts`, `shutdown.ts`, `unimplementedFor` on `app.ts` |
| `src/http/contract/` | `systemStatusResponse` on `system.ts`                             |
| `src/`               | `main.test.ts`                                                    |
| `test/helpers/`      | `port.ts`, `exit()` on `daemon.ts`                                |
| `scripts/`           | `verify-db-status.ts`                                             |

## Facts (needed for implementation)

State of the tree at the start of this epic. EPIC 007.5 and EPIC 008 are expanded and not built, so the CLI commands `project create`, `project list`, `project show`, `project repository`, `plan import` and `plan export` are contracts of `.agents/plan/stories/008-project-and-plan/14-project-cli.md` and `15-plan-cli-handshake.md` rather than code.

- **A test may not import `src/main.ts`.** `eslint.config.js:314-334` disallows both a test file and a test helper from reaching the `composition-root` category, and `AGENTS.md` states "Nothing imports `main.ts`". `src/main.ts` exports nothing and runs `await program.parseAsync(process.argv)` at `:406` on import. This one fact forces Story 01 and shapes Story 07.
- **The commander program is built inline in `src/main.ts:79-405`.** There is no `src/cli/program.ts`. Eleven `register*` calls, each taking a hand-built dependency object; `serve` is registered at `:87-278` with the whole daemon body inside its action.
- **`src/main.ts` binds nine handlers** at `:188-235` and derives `unimplemented` at `:236-239`. Fourteen `routed` operations have no handler today: `blob.show`, `edge.list`, `event.list`, `node.list`, `node.show`, `plan.export`, `plan.import`, `plan.revisions`, `plan.validate`, `project.create`, `project.list`, `project.repositories`, `project.show`, `system.status`. EPIC 008 binds eleven of them, this epic binds `system.status`, and EPIC 010 binds the last two.
- **`bindingOffenders` already enforces the exclusive-or.** `src/http/server/app.ts:90-117` throws `BindingError` when an operation is in both `handlers` and `unimplemented`, or in neither. So a `routed` operation is never unaccounted for — it is either bound or explicitly declared unimplemented, and Story 07's assertion is that the second list is only two names long.
- **The `501` for an unbound `routed` operation is distinguishable.** `src/http/server/dispatch.ts:16-28` writes `<id> ships in <introducedIn>` for a `stubbed` operation and `<id> is not implemented yet` for a `routed` one with no handler.
- **`test/helpers/app.ts:16-23` duplicates the `unimplemented` derivation** of `src/main.ts:236-239` verbatim. Story 07 section 2 collapses the two into `unimplementedFor` on `src/http/server/app.ts`. S3.
- **The daemon has no stop path today.** `src/main.ts:252` discards the `ListeningServer` that `src/http/server/start.ts:11` returns, `held` from `:105` is never referenced after `publishIdentity`, `storage.close()` at `:260` runs only when `reachedListen` is false, and no `process.on` exists in any non-test file under `src/`. `test/helpers/daemon.ts:122` therefore terminates the process outright. Story 09 builds the stop path, and Story 07 asserts it from outside. S4.
- **`ListeningServer.close()` is already idempotent.** `src/http/server/start.ts:26-35` guards on a `closed` flag and resolves. Story 09 needs no timeout of its own.
- **The home lock is released by closing a connection.** `src/services/home-lock/sqlite.ts:151-156`; `acquire` at `:69-85` holds a `BEGIN IMMEDIATE` open for the process lifetime with `busy_timeout = 0`. That is why the lock is the last shutdown step, and why `db migrate` on a home a live daemon holds prints `kanthord: home-locked:` (`test/helpers/cli.test.ts:97-126`).
- **`src/http/server/` may not import a service.** The import matrix gives it `domain/`, `commands/`, `queries/`, `http/contract/` and `http/server/`. `createShutdown` therefore takes `{ name, run }` pairs and names no capability.
- **`launchDaemon` spawns the real binary with an empty environment.** `test/helpers/daemon.ts:41`; `ready()` at `:71-111` resolves on the literal `"kanthord: ready\n"` with a 5000 ms timeout. It allocates no port — the port comes from the config file.
- **`test/helpers/home.ts:23,25` hardcodes `7421` twice**, once as `http.port` and once inside `allowedHosts`. `writeConfig` merges `http` shallowly and does not recompute `allowedHosts`, so a caller overriding the port must override both or every request answers `403 host-forbidden`. `test/helpers/cli.test.ts:100` overrides only the port and gets away with it because it never sends a request.
- **`reservePort` is duplicated verbatim in four test files** — `test/helpers/daemon.test.ts:14`, `test/helpers/cli.test.ts:17`, `src/http/server/start.test.ts:21`, `src/services/home-lock/startup.test.ts:26`. None is exported. Story 07 section 1 replaces all four with `test/helpers/port.ts`. S2.
- **Every path parameter is named `id`.** `src/http/contract/path.ts:88` builds `{ kind: "parameter", value: "id", identity }`, and `parameterNames` at `:116` returns the `value`. `run.start`'s `project` parameter is therefore keyed `id` on the wire, which is what `src/cli/repository/show.ts:39` already does.
- **`src/cli/client.ts:36,48-61` refuses to percent-encode.** A parameter value outside `/^[A-Za-z0-9_:.-]+$/` throws a plain `Error`. Every id in this epic is a prefixed ULID, which matches.
- **`src/cli/exit-code.ts:8-30` is `Readonly<Record<ErrorCode, number>>`** and pinned at 21 entries by `src/cli/exit-code.test.ts`. This epic adds no error code, so neither file is edited. `not-implemented` is `220`.
- **There are two established CLI shapes, and this epic uses both.** Shape (a): an injected `DaemonClient` with `fail()` — `src/cli/repository/show.ts:1-49`. Shape (b): a `ClientDependencies` factory with `exit(code)` — `src/cli/db/status.ts:1-49`. Story 05 takes (a). Story 06 takes (a)'s client with (b)'s exit, because it is the one command whose exit code is part of the oracle.
- **`docs/proposal/api/` declares no exit-code table.** `.agents/plan/stories/004-transport-skeleton/07-cli-program-skeleton.md:173` decided the whole scheme, and `:337` already cites this epic's `kanthord run` as the reason `not-implemented` is asserted on its own.
- **The registry counts move by nothing.** `src/http/contract/registry.test.ts:14-16` (53 entries), `:29-38` (23 routed / 30 stubbed) and `parity.test.ts:12-22` are untouched. This epic adds no operation. It moves the response-schema count only: `registry.test.ts:88-99` from nine ids to ten, and `system.test.ts:168,173` with it.
- **`systemHealthResponse` and `readHealth` are the shape to mirror.** `src/http/contract/system.ts:8-16`; `src/queries/system/read-health.ts` sorts its dependency lines bytewise through `Buffer.compare` and derives `degraded` from any `failed`.
- **A query may not import another query.** `eslint.config.js:117-129`. `readStatus` therefore takes `health` as an injected function, the same way `src/main.ts:220` injects `readRepositoryView` into `registerRepository`.
- **`Transaction` is synchronous.** `src/services/storage/index.ts:1-5`; `connection.ts:90-101` rolls back and throws on a returned promise. `readStatus` is synchronous end to end.
- **The three tables `readStatus` reads all exist.** `node` at `src/services/storage/migration-0002-graph-and-plan.ts:17`, `repository` in `migration-0001-core-entities.ts`, `lease` at `src/services/storage/migration-0003-execution-and-journal.ts:20-29` with `PRIMARY KEY (subject_kind, subject_id)`. No migration is added.
- **`repository.state = 'needs-reconcile'` is exactly the both-oids-present case.** `src/domain/repository.ts:23-30` refines it, so the `system.status` repository line cannot carry a null object id.
- **`scripts/` is an out-of-tree consumer.** `eslint.config.js:335-343` gives it a parser and no boundary rule, and eight files under `scripts/e2e/007/` already import `test/helpers/`. That precedent is what lets Story 08 put the step in a helper and the entry point in a script.
- **`scripts/lane-check.sh:41` locks `package.json`** and `:87-90` makes every file under `scripts/` the software-engineer lane. Both bite Story 08. See B3 and S1.
- **`npm test` is `node --test --test-timeout=60000` with no path** (`package.json:16`). It discovers every `*.test.ts` in the repository, so `test/helpers/verify-db-status.test.ts` is collected without a manifest edit.
- **`src/domain/layout.test.ts` pins no CLI count.** Its only whole-tree walk that reaches `src/cli/` is `:302-319`, which forbids the literals `scripts/e2e` and `.env.e2e` in any file under `src/` or `test/`. Story 08's helper lives under `test/`, so it must not name the e2e harness.
- **`src/domain/loopback.test.ts` asserts exactly two non-test files under `src/` hold a `127.` or `"localhost"` literal.** No CLI file this epic adds may hold one.

### Source facts the stories depend on

- The P1-E1 oracle is `docs/proposal/phase-1/README.md:66-78`. It names eight `kanthord` commands and is the only complete phase-1 CLI list — see B2.
- `system.status`'s contents are `docs/proposal/api/system.md:50-65`; the lease list covering both subject kinds is `:59`.
- `db status` is an HTTP client command and `db migrate` is not, `docs/proposal/api/system.md:42-48`. The staged `verify` and its five steps are `docs/proposal/phase-1/domain.md:41-43`.
- `run.start` returns `501` and writes no state in phase 1, `docs/proposal/api/execution.md:20-24`.
- The CLI routes on `code` and never parses `message`, `docs/proposal/api/README.md:163` and `api/new-decisions.md:15`.
- The lifecycle values and the `501`-versus-`404` split are `docs/proposal/api/README.md:45-56`.

## Decisions this expansion settled

- **The commander program moves to `src/cli/program.ts`, and `src/main.ts` keeps every implementation.** The EPIC requires an assertion that each declared command exists in the program; the lint forbids a test from importing the composition root; `src/main.ts` exports nothing. Extraction is the only one of the three that can move.
- **`buildProgram` takes `env` and `fetch`, not a client factory.** The factory closes over the program it is registered into, so it must be built inside the builder.
- **`ProgramDependencies` is the post-EPIC-008 bag, not the current-tree one.** It carries `cwd` and a five-member `fs`, because `.agents/plan/stories/008-project-and-plan/15-plan-cli-handshake.md:101` registers `plan import` and `plan export` with them. Story 01 also tables the exact input of each of the eleven `register*` calls, so the implementer assembles the bag rather than inferring it.
- **`MigrateHandler` gains `config`.** The migrate closure reads `program.opts().config` today. After extraction it no longer holds the program, so the value arrives through the handler input rather than through a captured reference.
- **`serve` is injected into the builder and its body stays in `src/main.ts`.** The daemon boot constructs thirteen implementations; moving it would make `src/cli/` import them.
- **The inventory is data and the parity is a comparator.** `src/http/contract/parity.ts:1-89` is the precedent: a pure `compareCommandSets` lets a drift case be asserted without mutating the real program.
- **`serve` is in the inventory.** The EPIC says `db migrate` is the one entry naming no route; `serve` names none either. Including it makes the program-to-inventory comparison a clean two-way equality with no exception list, and an exception list in a parity test is the drift the test exists to catch. Recorded as S5.
- **An inventory entry names every operation its command calls, in call order.** `.agents/plan/epics/009-cli-and-composition-root.md:20` requires the parity assertion to prove "no command calls an operation absent from the registry", and a single terminal id cannot carry that clause: `repository register` calls three operations and `plan import` calls three, and a terminal-only field would drop four of the seventeen ids from every check. Seventeen ids across twelve calling entries, all distinct, both counts pinned.
- **`run` is the only phase-2 command in the inventory, and it is there because P1-E1 names it.** `repository reconcile` and `instructions resolve` front `stubbed` routes too and are excluded, because no phase-1 oracle names them.
- **The inventory is checked against the P1-E1 oracle by scanning the proposal.** The api Source column is incomplete — see B2 — and `docs/proposal/phase-1/README.md:66-78` is the list a phase-1 human actually runs. `test/helpers/proposal.ts` already establishes a test reading a proposal document.
- **`system.status` ships in this epic, not in EPIC 010.** See B1.
- **`startedAt` is an ISO-8601 string captured at process entry**, above `const program = new Command()` at `src/main.ts:79`, and passed into the query. `docs/proposal/api/system.md:55` says "the process start time"; capturing it after config load, home-lock acquisition and the tool probe would report when the daemon finished booting instead.
- **`DependencyStatus`, `DependencyLine` and `HealthResult` move to `src/domain/health.ts`.** `readStatus` needs all three and a query may not import another query (`eslint.config.js:117-129`), so `domain/` is the only place one copy can live. The alternative was a structurally duplicated type in the `readStatus` signature.
- **Every `system.status` column is aliased to its result name in SQL.** `Transaction.all` returns `readonly unknown[]`, and this query derives no computed field, so the row is cast and pushed. `src/queries/repository/list-repository.ts:29-33` rebuilds by hand because it derives four; that shape is not the default.
- **`blockReason` and `owner` are present and `null`, never absent**, and the CLI renders each `null` as `-`. A short line would make the output unparseable by column.
- **An empty list prints one `no …` line and exits zero.** `.agents/plan/stories/008-project-and-plan/14-project-cli.md:54` already fixed that spelling for `project list`.
- **`kanthord status` uses `fail()` and `kanthord run` uses `exit(code)`.** Only `run` has an oracle that names the failure, `docs/proposal/phase-1/README.md:77`.
- **Story 07 drives the real binary and asserts a status, never a body.** A response shape belongs to the epic that owns the handler; this file proves the wire.
- **Story 07 also runs the two CLI commands themselves.** A `call()` to `system.status` skips registration, client-option resolution and rendering, so it cannot satisfy the EPIC's "answer against the started daemon rather than a stub". Four cases go through `runCli`: status answers, run exits `220` with `not-implemented`, status is unchanged across the run call (`docs/proposal/phase-1/README.md:77`), and the daemon and CLI report one version (`:69`). The last two are provable in no other place in phase 1.
- **The two git fixtures point at a reserved-then-closed loopback port.** `repository.inspect` and `repository.register` need a body that is valid in shape and reaches no network, and a refused connection on `127.0.0.1` is both. The refusal code stays unpinned because it depends on which check fires first, and pinning it would re-specify EPIC 007 from a second place.
- **The verify step's lifecycle lives in `scripts/verify-db-status.ts` and the test imports it.** The reverse — logic in `test/helpers/` behind a thin script — would put a gate step of `npm run verify` behind a test helper, against `AGENTS.md`. It costs one prerequisite: the lane guard must route `scripts/*.test.ts` to the test-engineer. See S1.
- **Story 07's fixture table is asserted to cover the registry.** `Object.keys(fixtures)` is compared to the routed set minus a two-name `pending` constant, so a new routed operation cannot slip past the sweep.
- **`repository.inspect` and `repository.register` are asserted `any-but-501` only.** Both reach a git remote, and the hermetic remote is EPIC 005's loopback fixture, which `scripts/e2e/007/` already drives.
- **The verify step calls the real `db status` CLI, not `fetch`.** `docs/proposal/api/system.md:44` makes it a client command, and a step that bypassed the client would not prove the client.
- **The daemon step is the last of the four.** It is the slowest, and a lint failure should not cost a daemon boot.

- **The shutdown sequencer names no capability.** `src/http/server/` may not import a service, so `createShutdown` takes `{ name, run }` pairs and `src/main.ts` supplies the three closures. That also makes the step order visible in the composition root, which is where it belongs.
- **The shutdown order is listener, storage, home lock.** No request may reach a closed database, and the lock is released last because `src/services/home-lock/sqlite.ts:151-156` closes the connection holding `BEGIN IMMEDIATE`; a successor acquiring the home while this daemon still held an open database would race it.
- **A failing shutdown step does not stop the sequence.** A listener that refuses to close must not leak the home lock.
- **No shutdown timeout.** `docs/proposal/` fixes no deadline, and inventing one would be a decision with no source. `src/http/server/start.ts:26-35` already makes `close()` idempotent.

## Open items

Three blockers and six suggestions. **Every one is now applied.** Six of the nine changed a file outside `.agents/plan/stories/`, and those six are listed with what changed.

| item | applied in                                                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1   | `.agents/plan/epics/009-cli-and-composition-root.md`, `.agents/plan/epics/010-contract-completion.md`, `.agents/plan/epics/000-phase-1-overview.md` |
| B2   | `.agents/plan/epics/009-cli-and-composition-root.md` — the Proof block and the inventory-source line                                                |
| B3   | Story 08 section 3 — the line is authored and its ordering is fixed. **Not applied to `package.json`, on purpose.**                                 |
| S1   | `scripts/lane-check.sh:87-94`                                                                                                                       |
| S2   | Story 07 section 1 — `test/helpers/port.ts`                                                                                                         |
| S3   | Story 07 section 2 — `unimplementedFor` on `src/http/server/app.ts`                                                                                 |
| S4   | Story 09, and a new EPIC bullet                                                                                                                     |
| S5   | recorded, unchanged                                                                                                                                 |
| S6   | `.agents/plan/epics/009-cli-and-composition-root.md` — the "complete" claim now states its scope                                                    |

- B1 - **done** - system-status-was-owned-by-two-epics - EPIC 009 required `kanthord status` to report nodes by kind and state and to answer against a started daemon, and required the composition root complete against every routed operation. `system.status` had no schema, no query and no handler, and EPIC 010:13,23 owned all three while running after 009. As written the two epics could not both be true.

  Ulrich settled it: 009 gains `system.status` only. Applied in three files. EPIC 009's non-goal now records the one exception and its Stories list carries a `system.status` bullet. EPIC 010's "What EPIC 009.5 already did" section and its non-goals now state that 009 owns it, and its Stories list drops the bullet. The phase overview moves the story counts — 009 from six to nine, 010 from five to four, total 130 to 132 — and its "Why 009 exists" paragraph names the route and the shutdown path.

- B2 - **done** - the-epic-proof-missed-four-of-the-eight-stories - the Proof was `node --test src/cli/**/*.test.ts src/main.test.ts`. Story 04 writes into `src/queries/`, `src/http/server/` and three contract test files; Story 08 writes `scripts/verify-db-status.test.ts`; Story 09 writes `src/http/server/shutdown.test.ts`. None was inside the glob, so the Proof would have printed `PASS EPIC-009` with the `system.status` route, the shutdown path and the verify step entirely unbuilt. EPIC 007's B3 and EPIC 008's B1, a third time.

  Applied: the Proof block now names nine globs, exactly the directories of the "Where the code lands" table, and states under the block why one glob is not enough. `Gates: npm run verify` is untouched and stays the real collector.

  The same edit corrected the inventory-source line. EPIC 009:19 said the api Source column "is the source"; it is not sufficient, because `docs/proposal/api/project.md:12-14` names no command for `project.list`, `project.show` or `project.repositories` and `credential.md:17` names none for `provider.register`. The bullet now names both sources, and Story 02 scans the P1-E1 block of `docs/proposal/phase-1/README.md:66-78`.

  The coverage line was strengthened at the same time, because no glob can satisfy it: `kanthord status` and `kanthord run` must answer **through the real binary**, `run` must leave `status` unchanged, and the daemon and CLI must report one version.

- B3 - **done as a sequencing rule, deliberately not applied to `package.json`** - the-manifest-is-locked-against-both-implementing-roles - `scripts/lane-check.sh:41` denies `package.json` to the test-engineer and the software-engineer alike, so `/work` cannot make this edit and a human must.

  The line was applied and then reverted, because applying it early is worse than not applying it. `node scripts/verify-db-status.ts` on a missing file exits `1`, so `npm run verify` — this epic's own `Gates:` line — goes red for all nine stories the moment the line lands and stays red until Story 08 finishes. Measured, not reasoned: `exit=1`, `MODULE_NOT_FOUND`.

  So the fix is the ordering, and it is now written into Story 08 section 3 as the last edit of the epic: test green, script green by hand, **then** the line, then `npm run verify`. `.agents/plan/stories/001-runtime-foundation/09-staged-verify.md` removed this same step for the mirror-image reason, and it also landed as a human edit.

- S1 - **done** - a-test-under-scripts-belonged-to-the-wrong-role - `scripts/lane-check.sh:87-90` routed every path under `scripts/` to the software-engineer, including a `*.test.ts`, while `src/*.ts` at `:79-86` split on the `.test.ts` suffix. The first draft dodged it by putting the lifecycle in `test/helpers/verify-db-status.ts` behind a thin script — which inverts the dependency, because a step of `npm run verify` would then import a test helper and `AGENTS.md` states "No production file imports a test or a test helper". The `scripts/e2e/007/` precedent does not cover it: the e2e harness is not a gate step.

  Applied to `scripts/lane-check.sh:87-94`: the `scripts/*` case now branches on `is_test`, mirroring the `src/*.ts` case above it. `scripts/lane-check.test.sh` passes, and the four combinations were checked by hand — the test-engineer may write `scripts/verify-db-status.test.ts` and not `scripts/verify-db-status.ts`, the software-engineer the reverse, and `scripts/lane-check.sh` stays locked to both. Story 08 now keeps its lifecycle in the script.

- S2 - **done** - reserveport-was-duplicated-five-times - the same eight-line body sat in `test/helpers/daemon.test.ts:14`, `test/helpers/cli.test.ts:17`, `src/http/server/start.test.ts:21` and `src/services/home-lock/startup.test.ts:26`, and Stories 07 and 08 were adding a fifth and sixth. Story 07 section 1 now creates `test/helpers/port.ts`, replaces the four local definitions with an import, and asserts the helper itself. `test/helpers/remote/ssh.ts:94` keeps `reserveLoopbackPort`: it rejects with a fixture-specific message rather than casting `AddressInfo`, and it is a fixture concern.

- S3 - **done** - the-unimplemented-derivation-existed-twice - `test/helpers/app.ts:16-23` and `src/main.ts:236-239` held the same four-line filter. Story 07 section 2 exports `unimplementedFor` from `src/http/server/app.ts`, beside the `bindingOffenders` that enforces the same rule; `src/main.ts` calls it, and `test/helpers/app.ts` re-exports it so the eleven test files that import it need no edit. A test helper may import `http/server` — `eslint.config.js:314-334` disallows only the composition root — so the duplicate collapses without the helper reaching `src/main.ts`. `app.test.ts:160-165` keeps its `21`.

- S4 - **done** - the-daemon-had-no-graceful-stop - `src/main.ts:252` discarded the `ListeningServer`, `held` from `:105` was never referenced again, `storage.close()` ran only on a boot failure, and no `process.on` handler existed in any non-test file under `src/`. Every consumer killed the process outright, which is correct for a test and wrong for a product, and it left the home lock to be reclaimed by the next daemon's recovery rather than released.

  Applied as Story 09 plus a new EPIC bullet: `src/http/server/shutdown.ts` sequences named steps, `src/main.ts` supplies listener, storage and home lock in that order, and `SIGTERM` and `SIGINT` both reach it. `test/helpers/daemon.ts` gains `exit()`, which Stories 07 and 08 need to tell "the port is free" from "the child is gone". Story 07 asserts the whole path from outside: exit code `0`, a `kanthord: stopped` line, and a `db migrate` on the same home succeeding afterwards — the one assertion in the repository that proves the lock was released rather than orphaned.

- S5 - action:NO - serve-is-in-the-inventory - EPIC 009:19 said `db migrate` was "the one entry that names no route". Story 02 holds two, because `serve` is a command of the program and excluding it would put a subtraction inside the parity equality of Story 03, and an exception list in a parity test is exactly the drift the test exists to catch. The EPIC bullet now says "two entries", so this is no longer a divergence — recorded because the wording changed.

- S6 - **done** - the-composition-root-test-blessed-two-unbound-routes - Story 07 pins `["blob.show", "event.list"]` as `pending`, which is an exception list inside an assertion the EPIC called "asserted complete". The weakening was real, and it is the direct consequence of B1.

  Three fixes were possible. Absorbing both routes into this epic removes the list but puts a media contract and a cursor pager into an epic about assembly, duplicating two EPIC 010 stories. Reordering 010 before 009 breaks the phase chain. The third — taken — is to make the claim honest and the constant self-policing.

  Applied in the EPIC: the composition-root bullet now states that "complete" means every `routed` operation this phase has implemented, and that the two remaining are pinned as an exact set rather than ignored. The mechanism was already right and stays: the residue is a bytewise deep-equal against a two-element constant, so a third unbound operation fails the assertion and names itself, and `src/http/server/app.ts:90-117` independently refuses to construct an app where any routed operation is neither bound nor declared. EPIC 010 now carries the obligation to empty the constant, written into its own "What EPIC 009.5 already did" section with the file path of the test that holds it.

- O1 - **the one addition this expansion still makes is Story 01.** `src/cli/program.ts` is declared by no EPIC bullet. It exists because the EPIC requires an assertion that each declared command is in the commander program, `eslint.config.js:314-334` forbids a test importing `src/main.ts`, and `src/main.ts` exports nothing and parses argv on import. Extraction is the only one of those three that can move.
