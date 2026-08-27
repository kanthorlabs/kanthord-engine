# EPIC 036 — The runtime capability matrix

Status: **draft**. It sits after EPIC 035 in the sequence, inside phase 1b. It depends on EPIC 035,
which splits the composition roots and declares the Node root as the only built root. It ships one
document under `docs/proposal/` and one completeness test. It ships no runtime code.

## Goal

The band 030–039 states one target: a transport that runs on Cloudflare Workers or on AWS Lambda.
Hono replaces Koa, and that alone delivers no such target. A count of Node built-ins across the
repository decides nothing either, because the CLI, the migration tooling and the Node service
implementations never enter a Worker bundle.

One artifact decides it: a matrix with one row per routed operation. Each row names the capability
the operation needs, and each row carries a verdict for the Node daemon, for AWS Lambda and for
Cloudflare Workers. The aggregate verdict follows from the rows.

This epic is a gate. It unblocks four later epics, and it opens none of them.

## Non-goals

- **No adapter.** EPIC 034 owns the Node adapter. This epic builds no second adapter.
- **No storage driver.** `node:sqlite` stays the only storage implementation.
- **No entrypoint.** No Lambda handler, no Worker module, no `wrangler` artifact.
- **No dependency.** `package.json` stays unchanged.
- **No behaviour change.** No file under `src/` changes behaviour. The one new file is a test.

## Decisions

- **The document is `docs/proposal/phase-1/runtime-capability-matrix.md`.** It is a transport
  decision, so it sits beside `phase-1/transport.md`. `docs/proposal/README.md` names the transport
  file under phase 1, and the matrix carries the same reviewer: the architect, and whoever owns the
  network.

- **A verdict is per operation, never per product.** The document states no product-level verdict
  before the table. It states the table, then counts the rows, then reports the aggregate as a count.
  `44` operations carry `routed` in `src/http/contract/registry.ts`. `25` carry `stubbed`, and a
  `stubbed` row enters no table, because it binds to the shared `501` handler and reaches no service.

- **The verdict values are `yes`, `no` and `degraded`.** A `degraded` cell names the degradation in
  the same cell. A cell holds no bare `degraded`.

- **A subprocess boundary makes git impossible on a Worker.** `src/services/git/launcher.ts` imports
  `node:child_process`, and every git operation runs the `git` binary through it. A Worker has no
  subprocess. Four routed operations reach `services/git`: `repository.register`,
  `repository.inspect`, `repository.list` and `repository.show`. Each is `no` on Workers.

  **The product accepts that boundary.** Git stays a subprocess capability. A Worker deployment
  reaches git through a remote capability behind the `Git` interface, or it serves no repository
  operation at all. This epic states the choice and builds neither side.

- **Per-process state is a correctness defect on Lambda too, not a Workers limitation.** Two stores
  hold per-process state.

  `src/http/server/idempotency-store.ts` holds every idempotency record in memory.
  `defaultIdempotencySettings` is `ttlSeconds: 300`, `joinTimeoutSeconds: 30`, `maxEntries: 256`,
  `maxBytes: 8388608`. Lambda runs many containers, and Workers runs many isolates. A replay that
  reaches a second container or a second isolate misses the record, and the operation runs twice.
  `18` routed operations declare `idempotency: "memory"`, and `plan.import` declares `durable`.
  `28` operations declare `memory` in total; the other `10` are `stubbed` and enter no row.

  `src/http/server/event/wait.ts` holds the long-poll registry in the process, and it polls at
  `POLL_INTERVAL_MS = 250`. One routed operation uses it: `event.list`. A held connection outlives no
  Worker request and no Lambda invocation.

- **Storage decides most rows.** `src/services/storage/sqlite.ts` and
  `src/services/storage/connection.ts` import `node:sqlite`, and `src/services/home-lock/sqlite.ts`
  imports it as well. A local SQLite file is exclusive to one host. Neither target keeps one.
  `AGENTS.md` requires a state transition and its event append in one transaction, so a replacement
  driver carries that constraint into its own interface.

- **A daemon owns the home.** `src/main.ts` acquires the home lock and recovers expired leases at
  startup. A Worker has no home, and a Lambda container keeps no home between invocations. Startup
  recovery is therefore a property of the Node root alone.

- **Four deployment shapes, ranked.** The document names them in this order.

  1. **The Node daemon on a long-lived host.** The shipped shape. It carries `44` of `44`, and
     every routed operation is `yes`.
  2. **A container on AWS Lambda, with reserved concurrency `1` and a durable mounted home.** It
     carries `42` of `44`, and it is the serverless shape that carries the most. A container image
     ships the `git` binary and starts a subprocess, and the mounted home supplies both the SQLite
     file and the bare home. It does not carry `event.list`, which holds a connection open, or
     `plan.import`, which has no durable store. Reserved concurrency `1` narrows the memory
     idempotency defect and does not remove it, because a cold start discards the records. The Hono
     chain of EPIC 032 carries over with no edit, because the shape changes the packaging and not
     the request handling.
  3. **A Worker with a remote storage driver, and no git.** It carries `38` of `44`. The driver lifts
     every row whose only obstacle is `sqlite`. It carries no repository operation, because an
     isolate starts no subprocess, and it carries neither `event.list` nor `plan.import`. Adding git
     as a remote capability would carry the four repository operations too; that capability is gate
     item 3 and it is not built, so it is not part of this shape.
  4. **A Worker on the tree as it stands today.** It carries `1` of `44`, and the one is
     `provider.catalog`. The document reports the count and states that the shape is not a product
     shape.

  A shape **carries** an operation when that operation answers correctly under the shape. A
  `degraded` row is not carried: it answers, and it answers with the defect its cell names. The
  document states that definition before the first shape uses it.

  Hono stays useful in shape 2 and shape 3. The document states that, and it states it as the reason
  the band keeps Hono after this gate.

- **The gate list.** This document unblocks four epics, and none of them opens before the document
  lands.

  1. A storage driver behind an interface that names no Node built-in.
  2. Durable idempotency, and a durable wait.
  3. Git as a remote capability behind the `Git` interface.
  4. The Lambda entrypoint and the Worker entrypoint.

  None carries an epic number. That is deliberate: a number commits the sequence, and the matrix
  decides the sequence.

- **Completeness is a mechanism, not a promise.** One test reads the document and extracts the
  operation column. It compares that set against the `routed` set of the registry. A missing row
  fails the test, and an unknown row fails it too.

## Stories

Author with `/author`. The sequence below is the dependency order; each story is one commit.

1. **The document states the capability inventory.** Create
   `docs/proposal/phase-1/runtime-capability-matrix.md`. Write the header, the reviewer line, and one
   table with one row per service capability under `src/services/`. The 20 capabilities are `agent`,
   `blob`, `clock`, `config`, `crypto`, `document`, `event`, `execution`, `git`, `graph`, `home-lock`,
   `ids`, `lease`, `model-catalog`, `plan`, `readiness`, `revision`, `secret`, `storage` and `verify`.
   Each row names the Node built-ins the shipped implementation imports, and the verdict for each of
   the three runtimes. The built-in facts are exact:
   - `config` imports `node:fs` and `node:path`.
   - `git` imports `node:child_process`, `node:crypto`, `node:fs`, `node:path` and `node:stream`.
   - `home-lock` imports `node:fs`, `node:path` and `node:sqlite`.
   - `storage` imports `node:sqlite`.
   - `blob`, `crypto` and `secret` import `node:crypto` and nothing else.
   - The other 13 import no Node built-in.

   State that `node:crypto` is portable, because both targets expose Web Crypto, and that
   `node:path` and `node:stream` are portable for the same reason. State that `node:sqlite` is
   portable to neither target. State that `node:child_process` and `node:fs` divide the two targets:
   a Lambda container image starts a subprocess and carries a file system, and an isolate does
   neither. A column answers one question — does the shipped implementation run on the bare target,
   with no deployment support added. No code.

2. **The document states the operation matrix.** Add one table with the columns `Operation`,
   `Storage`, `Git`, `Durable wait`, `Idempotency`, `Filesystem`, `Node daemon`, `Lambda` and
   `Workers`. Write 44 rows, one per `routed` operation of `src/http/contract/registry.ts`, sorted by
   `operationId` bytewise, which is the registry order. Fill every cell. A capability column holds the
   capability name or `-`. The eight classes below cover all 44 rows, and each class fixes every cell
   of its rows.

   | Class                                    | Operations                                                                                                                                                                                                                                                                                                                | Node  | Lambda                                                 | Workers                                              |
   | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------ | ---------------------------------------------------- |
   | catalog only, no storage, no idempotency | `provider.catalog`                                                                                                                                                                                                                                                                                                        | `yes` | `yes`                                                  | `yes`                                                |
   | catalog only, memory idempotency         | `provider.inspect`                                                                                                                                                                                                                                                                                                        | `yes` | `degraded — the replay record dies with the container` | `degraded — the replay record dies with the isolate` |
   | health, injected reporters               | `system.health`                                                                                                                                                                                                                                                                                                           | `yes` | `degraded — the one storage reporter has no driver`    | `degraded — the one storage reporter has no driver`  |
   | git                                      | `repository.inspect`, `repository.list`, `repository.register`, `repository.show`                                                                                                                                                                                                                                         | `yes` | `no`                                                   | `no`                                                 |
   | durable wait                             | `event.list`                                                                                                                                                                                                                                                                                                              | `yes` | `no`                                                   | `no`                                                 |
   | durable idempotency                      | `plan.import`                                                                                                                                                                                                                                                                                                             | `yes` | `no`                                                   | `no`                                                 |
   | storage read, no idempotency             | `actor.list`, `actor.show`, `blob.show`, `edge.list`, `node.list`, `node.show`, `plan.export`, `plan.revisions`, `project.graph`, `project.list`, `project.nodes`, `project.show`, `project.status`, `provider.list`, `provider.show`, `system.db`, `system.status`                                                       | `yes` | `no`                                                   | `no`                                                 |
   | storage, non-GET method                  | `actor.register`, `actor.revoke`, `actor.rotate`, `node.claim`, `node.create`, `node.delete`, `node.heartbeat`, `node.release`, `node.report`, `node.unblock`, `node.update`, `plan.validate`, `project.create`, `project.repositories`, `provider.register`, `provider.remove`, `provider.rename`, `provider.setDefault` | `yes` | `no`                                                   | `no`                                                 |

   The `Git` cell holds `git` for the four git rows and `-` elsewhere. The `Filesystem` cell holds
   `bare home` for the four git rows and `-` elsewhere. The `Durable wait` cell holds `wait` for
   `event.list` and `-` elsewhere. The `Idempotency` cell holds `durable` for `plan.import`, `memory`
   for the 18 operations that declare `idempotency: "memory"`, and `-` for the rest. The `Storage`
   cell holds `sqlite` for every row that reaches `services/storage` or `services/blob`, and `-` for
   `provider.catalog`, `provider.inspect` and `system.health`.

   Close the table with the aggregate, derived from the rows and stated as counts: on the Node daemon
   44 of 44 are `yes`; on Lambda 1 is `yes`, 2 are `degraded` and 41 are `no`; on Workers 1 is `yes`,
   2 are `degraded` and 41 are `no`. No code.

3. **The document states the deployment shapes and the gate.** Add the four shapes in the ranked order
   of the Decisions. Add the gate list of four unblocked epics, and state that none carries a number.
   State that no later epic of the band opens before this document lands. No code.

4. **The proposal links the document.** Add one row to the Files table of `docs/proposal/README.md`,
   directly under the `phase-1/transport.md` row, with the subject `per-operation runtime verdicts,
deployment shapes` and the reviewer `architect and whoever owns the network`. Add the same file to
   the Files table of `docs/proposal/phase-1/README.md`, directly under the `transport.md` row. Add
   one paragraph to `docs/proposal/phase-1/transport.md`, at the end of the section
   `## HTTP is the surface, the CLI calls it`, that names the matrix as the source of truth for which
   operation runs on which runtime. No code.

5. **A test proves the matrix is complete.** Add `src/http/contract/runtime-matrix.test.ts`. It reads
   `docs/proposal/phase-1/runtime-capability-matrix.md` from the repository root, extracts the first
   column of every data row of the operation table, and compares that set against the `routed`
   operation ids of `registry`. A `routed` id missing from the document fails the test and names the
   id. A document row that names no `routed` id fails the test and names the row. The test asserts the
   extracted count equals 44 by value. It reads the file through `node:fs` and resolves the path from
   `import.meta.url`, so it takes no working directory from the caller.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
test -f docs/proposal/phase-1/runtime-capability-matrix.md \
  && node --test \
    src/http/contract/runtime-matrix.test.ts \
    src/http/contract/registry.test.ts \
    src/http/contract/coverage.test.ts \
    src/http/contract/parity.test.ts \
  && echo "PASS EPIC-036"
```

Hermetic coverage required beyond the Proof:

- **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
  `verify-db-status`. A document edit breaks no contract test, and this is the proof of it.
- **The matrix names every routed operation, by value.** The test asserts the extracted set equals the
  `routed` set of the registry, and asserts the count is 44.
- **The matrix names no stubbed operation.** A `stubbed` id in the document fails the test.
- **A removed row fails the test.** The test names the missing operation id in its failure message,
  so a future registry addition reports which row to write.
- **The document adds no operation the registry lacks.** The comparison runs in both directions.
- **No production file changes.** `git diff --name-only` for this epic names only files under
  `docs/proposal/` and the one new `*.test.ts` file.
- **The test is hermetic.** It resolves the document path from `import.meta.url`, reads one file, and
  touches no network, no clock and no temporary directory.

## Open items

- **The `AGENTS.md` test-boundary TODO is not a blocker here.** That clause forbids opening another
  **phase-2** epic before it closes. This epic is phase 1b.
- **`system.health` is settled: `degraded`, and the cell names the one storage reporter.** Resolved
  by Ulrich on 2026-08-27. `src/main.ts:337-345` composes exactly one reporter, named `storage`,
  whose probe calls `storage.ping()`. Without a driver that probe throws, `readHealth` records the
  line as `failed`, and the route answers `200` with the aggregate status `degraded`. The earlier
  wording of this item named a home lock reporter and a bare home reporter; neither exists. A
  non-Node root that composes a different reporter set is a later decision, and it moves this cell
  and the aggregate together.
- **`blob.show` reads a SQLite-backed blob store.** `src/services/blob/sqlite.ts` is the only
  implementation. Whether blobs move to an object store, or follow the storage driver, is a decision
  for the storage epic. The matrix records `no` for the tree as it stands.
- **Git as a remote capability has no named protocol.** The decision above accepts the boundary. It
  names no transport, no authentication and no lease model for the remote git host. Ulrich decides
  whether that capability is a product deliverable or a deferral.
