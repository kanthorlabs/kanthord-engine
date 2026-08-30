# Runtime capability matrix

Reviewer: architect, and whoever owns the network. This file states which routed operation runs on which runtime.

A count of Node built-ins across the repository decides nothing, because the CLI, the migration tooling and the Node service implementations never enter a Worker bundle. This file decides per operation instead. It states the capability inventory, then one row per routed operation, then the deployment shapes the rows permit.

The three runtimes are the Node daemon on a long-lived host, a container on AWS Lambda, and a Cloudflare Worker. Every verdict below reads the tree as it stands. A verdict is `yes`, `no` or `degraded`, and a `degraded` cell names the degradation in the same cell.

## Which Node built-ins are portable

| Built-in             | Lambda | Workers | Why                                                                 |
| -------------------- | ------ | ------- | ------------------------------------------------------------------- |
| `node:crypto`        | yes    | yes     | both targets expose Web Crypto                                      |
| `node:path`          | yes    | yes     | string manipulation, with no host resource behind it                |
| `node:stream`        | yes    | yes     | both targets expose the Web Streams equivalent                      |
| `node:fs`            | yes    | no      | a container has a file system, an isolate has none                  |
| `node:child_process` | yes    | no      | a container image starts a subprocess, an isolate does not          |
| `node:sqlite`        | no     | no      | a local SQLite file is exclusive to one host, and neither keeps one |

`node:sqlite` is the one that is portable to neither target: a capability that imports it is `no` on both. `node:child_process` and `node:fs` divide the two targets rather than ruling out both.

A column here answers one question: does the shipped implementation run on the bare target, with no deployment support added? A mounted volume, a reserved concurrency setting and a replacement driver are deployment support, and the shapes section states what each of them lifts.

## The capability inventory

One row per capability under `src/services/`. The built-ins are those the shipped implementation imports, not those its tests import.

| Capability      | Node built-ins                                                             | Node daemon | Lambda | Workers |
| --------------- | -------------------------------------------------------------------------- | ----------- | ------ | ------- |
| `agent`         | none                                                                       | yes         | yes    | yes     |
| `blob`          | `node:crypto`                                                              | yes         | yes    | yes     |
| `clock`         | none                                                                       | yes         | yes    | yes     |
| `config`        | `node:fs`, `node:path`                                                     | yes         | yes    | no      |
| `crypto`        | `node:crypto`                                                              | yes         | yes    | yes     |
| `document`      | none                                                                       | yes         | yes    | yes     |
| `event`         | none                                                                       | yes         | yes    | yes     |
| `execution`     | none                                                                       | yes         | yes    | yes     |
| `git`           | `node:child_process`, `node:crypto`, `node:fs`, `node:path`, `node:stream` | yes         | yes    | no      |
| `graph`         | none                                                                       | yes         | yes    | yes     |
| `home-lock`     | `node:fs`, `node:path`, `node:sqlite`                                      | yes         | no     | no      |
| `ids`           | none                                                                       | yes         | yes    | yes     |
| `lease`         | none                                                                       | yes         | yes    | yes     |
| `model-catalog` | none                                                                       | yes         | yes    | yes     |
| `plan`          | none                                                                       | yes         | yes    | yes     |
| `provider-auth` | none                                                                       | yes         | yes    | yes     |
| `readiness`     | none                                                                       | yes         | yes    | yes     |
| `revision`      | none                                                                       | yes         | yes    | yes     |
| `secret`        | `node:crypto`                                                              | yes         | yes    | yes     |
| `storage`       | `node:sqlite`                                                              | yes         | no     | no      |
| `verify`        | none                                                                       | yes         | yes    | yes     |

Twenty-one capabilities. Fourteen import no Node built-in at all. On Lambda nineteen are `yes` and two are `no`, and the two are `home-lock` and `storage`. On Workers seventeen are `yes` and four are `no`, and the four are `config`, `git`, `home-lock` and `storage`.

A capability verdict is not an operation verdict. `blob` is `yes` on both targets because it imports `node:crypto` alone, and `blob.show` is still `no` on both, because `src/services/blob/sqlite.ts` persists through the storage transaction that `services/storage` owns. The operation table is the verdict that counts.

### The two boundaries the inventory names

**A subprocess boundary makes git impossible on a Worker.** `src/services/git/launcher.ts` imports `node:child_process`, and every git operation runs the `git` binary through it. A Worker starts no subprocess. The product accepts that boundary: git stays a subprocess capability. A Worker deployment reaches git through a remote capability behind the `Git` interface, or it serves no repository operation at all.

**A local SQLite file is exclusive to one host.** `src/services/storage/connection.ts` and `src/services/storage/sqlite.ts` import `node:sqlite`, and `src/services/home-lock/sqlite.ts` imports it as well. Neither target keeps such a file. `AGENTS.md` requires a state transition and its event append in one transaction, so a replacement driver carries that constraint into its own interface.

## The operation matrix

One row per `routed` operation of `src/http/contract/registry.ts`, forty-eight of them, sorted bytewise by `operationId`, which is the registry order. The twenty-five `stubbed` operations enter no row: each binds to the shared `501` handler and reaches no service.

A capability column holds the capability name or `-`.

| Operation                | Storage  | Git   | Durable wait | Idempotency | Filesystem | Node daemon | Lambda                                               | Workers                                            |
| ------------------------ | -------- | ----- | ------------ | ----------- | ---------- | ----------- | ---------------------------------------------------- | -------------------------------------------------- |
| `actor.list`             | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `actor.register`         | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `actor.revoke`           | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `actor.rotate`           | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `actor.show`             | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `blob.show`              | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `edge.list`              | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `event.list`             | `sqlite` | -     | `wait`       | -           | -          | yes         | no                                                   | no                                                 |
| `node.claim`             | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `node.create`            | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `node.delete`            | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `node.heartbeat`         | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `node.list`              | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `node.release`           | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `node.report`            | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `node.show`              | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `node.unblock`           | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `node.update`            | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `plan.export`            | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `plan.import`            | `sqlite` | -     | -            | `durable`   | -          | yes         | no                                                   | no                                                 |
| `plan.revisions`         | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `plan.validate`          | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `project.create`         | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `project.graph`          | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `project.list`           | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `project.nodes`          | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `project.repositories`   | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `project.show`           | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `project.status`         | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `provider.catalog`       | -        | -     | -            | -           | -          | yes         | yes                                                  | yes                                                |
| `provider.inspect`       | -        | -     | -            | `memory`    | -          | yes         | degraded — the replay record dies with the container | degraded — the replay record dies with the isolate |
| `provider.list`          | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `provider.loginCancel`   | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `provider.loginComplete` | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `provider.loginStart`    | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `provider.register`      | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `provider.remove`        | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `provider.rename`        | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `provider.setDefault`    | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `provider.show`          | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `provider.verify`        | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                   | no                                                 |
| `repository.inspect`     | `sqlite` | `git` | -            | `memory`    | bare home  | yes         | no                                                   | no                                                 |
| `repository.list`        | `sqlite` | `git` | -            | -           | bare home  | yes         | no                                                   | no                                                 |
| `repository.register`    | `sqlite` | `git` | -            | `memory`    | bare home  | yes         | no                                                   | no                                                 |
| `repository.show`        | `sqlite` | `git` | -            | -           | bare home  | yes         | no                                                   | no                                                 |
| `system.db`              | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |
| `system.health`          | -        | -     | -            | -           | -          | yes         | degraded — the one storage reporter has no driver    | degraded — the one storage reporter has no driver  |
| `system.status`          | `sqlite` | -     | -            | -           | -          | yes         | no                                                   | no                                                 |

### What the columns mean

`Storage` holds `sqlite` for every row that reaches `services/storage` or `services/blob`. Three rows hold `-`: `provider.catalog` and `provider.inspect` reach `services/model-catalog` alone, and `system.health` reaches the injected reporter set alone.

`Git` holds `git` for the four rows that reach `services/git`, and `Filesystem` holds `bare home` for the same four. No other routed operation touches either.

`Durable wait` holds `wait` for `event.list`. `src/http/server/event/wait.ts` keeps the long-poll registry in the process and polls at `POLL_INTERVAL_MS = 250`. A held connection outlives no Worker request and no Lambda invocation.

`Idempotency` holds `durable` for `plan.import`, `memory` for the twenty-two routed operations that declare it, and `-` for the remaining twenty-five. `src/http/server/idempotency-store.ts` holds every record in memory, at `ttlSeconds: 300`, `joinTimeoutSeconds: 30`, `maxEntries: 256` and `maxBytes: 8388608`. Lambda runs many containers and Workers runs many isolates, so a replay that reaches a second container or a second isolate misses the record and the operation runs twice. That is a correctness defect on Lambda too, not a Workers limitation.

`system.health` degrades rather than fails because `src/main.ts` composes one reporter, named `storage`, whose probe calls `storage.ping()`. Without a driver that probe throws, `readHealth` records the line as `failed`, and the route answers `200` with the aggregate status `degraded`. A non-Node root composes a different reporter set, and the shorter list is a decision the tree does not settle.

### The aggregate

Counted from the rows above, not asserted ahead of them.

| Runtime     | `yes` | `degraded` | `no` |
| ----------- | ----- | ---------- | ---- |
| Node daemon | 48    | 0          | 0    |
| Lambda      | 1     | 2          | 45   |
| Workers     | 1     | 2          | 45   |

On the Node daemon 48 of 48 are `yes`. On Lambda and on Workers the single `yes` is `provider.catalog`, and the two `degraded` are `provider.inspect` and `system.health`.

## Four deployment shapes, ranked

The columns above read the tree as it stands, with no deployment support added. A shape is what a deployment adds on top of that tree, so a shape lifts a `no` the columns record.

**A shape carries an operation when that operation answers correctly under the shape.** A `degraded` row is not carried: it answers, and it answers with the defect its cell names. Each shape below therefore states one exact count of carried operations, and names every operation it does not carry.

**1. The Node daemon on a long-lived host. It carries 48 of 48.** The shipped shape. Every routed operation is `yes`. The daemon owns the home: `src/main.ts` acquires the home lock and recovers expired leases at startup. Startup recovery is a property of this shape alone.

**2. A container on AWS Lambda, with reserved concurrency `1` and a durable mounted home. It carries 46 of 48.** The serverless shape that carries the most surface. A container image ships the `git` binary and starts a subprocess, so the four repository operations are not blocked here as they are on a Worker. The mounted home restores the SQLite file and the bare home, which lifts the storage `no` and the filesystem `no` of the matrix.

It does not carry `event.list` or `plan.import`. `event.list` holds a connection open, and a held connection outlives no invocation. `plan.import` declares `durable` idempotency, and the tree has no durable store to satisfy it.

Reserved concurrency `1` bounds the shape to one container at a time. It does not make that container immortal: a cold start discards the in-memory idempotency records, so a replay that crosses a cold start still misses. The shape narrows the memory-idempotency defect and does not remove it, and item 2 of the gate is what removes it.

The Hono chain of EPIC 032 carries over with no edit, because the shape changes the packaging and not the request handling.

**3. A Worker with a remote storage driver, and no git. It carries 42 of 48.** A remote storage driver lifts every row whose only obstacle is `sqlite`. It does not carry the four repository operations, because git is a subprocess capability and an isolate starts no subprocess. It does not carry `event.list` or `plan.import`, for the reasons shape 2 gives. An isolate has no equivalent of reserved concurrency, so the memory-idempotency defect is worse here than on shape 2, not better.

Adding git as a remote capability behind the `Git` interface would carry the four repository operations as well, and make this shape carry the whole surface bar `event.list` and `plan.import`. That capability is item 3 of the gate and it is not built, so it is not part of this shape.

**4. A Worker on the tree as it stands today. It carries 1 of 48.** The one is `provider.catalog`. `provider.inspect` and `system.health` answer with the degradations their cells name, and the other 45 do not answer. This is not a product shape. It is stated so the count is on the record.

Hono stays useful in shape 2 and in shape 3. That is the reason the band keeps Hono after this gate.

## The gate

This document unblocks four pieces of work. None of them opens before it lands, and none of them carries an epic number: a number commits the sequence, and this matrix is what decides the sequence.

1. A storage driver behind an interface that names no Node built-in. It carries the transaction rule of `AGENTS.md` into its own interface, because a state transition and its event append are never in two transactions.
2. Durable idempotency, and a durable wait. Both are correctness defects on Lambda too, not Workers limitations.
3. Git as a remote capability behind the `Git` interface. The protocol, the authentication and the lease model for a remote git host are unnamed.
4. The Lambda entrypoint and the Worker entrypoint.

No later epic of the 030–039 band opens before this document lands.
