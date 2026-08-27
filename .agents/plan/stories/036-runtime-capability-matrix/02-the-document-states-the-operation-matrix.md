# Story 2 — The document states the operation matrix

Epic: `.agents/plan/epics/036-runtime-capability-matrix.md`
Depends on: Story 1 — it appends to the file Story 1 creates.

Documentation only. No file under `src/`, `test/` or `scripts/` changes.
`docs/proposal/*` is the software-engineer lane (`scripts/lane-check.sh:99-101`). The test-engineer
writes nothing for this story.

**Two values here were corrected against the tree, and the EPIC carries the corrections as of
2026-08-27.** They are recorded so a reviewer reading an older copy of the EPIC does not report the
current table as a defect.

- **Eighteen routed operations declare `idempotency: "memory"`, not sixteen.** `28` declare `memory`
  in total; ten of those are `stubbed` and enter no row. The eighteen are named below by value.
- **`system.health` degrades because of its one reporter.** `src/main.ts:337-345` composes exactly
  one reporter, named `storage`, whose probe calls `storage.ping()`
  (`src/services/storage/sqlite.ts:131`). Without a driver that probe throws, `readHealth` records
  the line as `failed`, and the route answers `200` with the aggregate status `degraded`. Ulrich
  settled the verdict as `degraded` on 2026-08-27; the EPIC's Open items record it.

## Change

### Append to `docs/proposal/phase-1/runtime-capability-matrix.md`

Append the content between the fence markers to the end of the file Story 1 created. Change no line
Story 1 wrote.

```
## The operation matrix

One row per `routed` operation of `src/http/contract/registry.ts`, forty-four of them, sorted bytewise by `operationId`, which is the registry order. The twenty-five `stubbed` operations enter no row: each binds to the shared `501` handler and reaches no service.

A capability column holds the capability name or `-`.

| Operation              | Storage  | Git   | Durable wait | Idempotency | Filesystem | Node daemon | Lambda                                                 | Workers                                              |
| ---------------------- | -------- | ----- | ------------ | ----------- | ---------- | ----------- | ------------------------------------------------------ | ---------------------------------------------------- |
| `actor.list`           | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `actor.register`       | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                     | no                                                   |
| `actor.revoke`         | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                     | no                                                   |
| `actor.rotate`         | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                     | no                                                   |
| `actor.show`           | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `blob.show`            | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `edge.list`            | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `event.list`           | `sqlite` | -     | `wait`       | -           | -          | yes         | no                                                     | no                                                   |
| `node.claim`           | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                     | no                                                   |
| `node.create`          | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                     | no                                                   |
| `node.delete`          | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                     | no                                                   |
| `node.heartbeat`       | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                     | no                                                   |
| `node.list`            | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `node.release`         | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                     | no                                                   |
| `node.report`          | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                     | no                                                   |
| `node.show`            | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `node.unblock`         | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                     | no                                                   |
| `node.update`          | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                     | no                                                   |
| `plan.export`          | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `plan.import`          | `sqlite` | -     | -            | `durable`   | -          | yes         | no                                                     | no                                                   |
| `plan.revisions`       | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `plan.validate`        | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                     | no                                                   |
| `project.create`       | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                     | no                                                   |
| `project.graph`        | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `project.list`         | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `project.nodes`        | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `project.repositories` | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `project.show`         | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `project.status`       | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `provider.catalog`     | -        | -     | -            | -           | -          | yes         | yes                                                    | yes                                                  |
| `provider.inspect`     | -        | -     | -            | `memory`    | -          | yes         | degraded — the replay record dies with the container   | degraded — the replay record dies with the isolate   |
| `provider.list`        | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `provider.register`    | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                     | no                                                   |
| `provider.remove`      | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `provider.rename`      | `sqlite` | -     | -            | `memory`    | -          | yes         | no                                                     | no                                                   |
| `provider.setDefault`  | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `provider.show`        | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `repository.inspect`   | `sqlite` | `git` | -            | `memory`    | bare home  | yes         | no                                                     | no                                                   |
| `repository.list`      | `sqlite` | `git` | -            | -           | bare home  | yes         | no                                                     | no                                                   |
| `repository.register`  | `sqlite` | `git` | -            | `memory`    | bare home  | yes         | no                                                     | no                                                   |
| `repository.show`      | `sqlite` | `git` | -            | -           | bare home  | yes         | no                                                     | no                                                   |
| `system.db`            | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |
| `system.health`        | -        | -     | -            | -           | -          | yes         | degraded — the one storage reporter has no driver      | degraded — the one storage reporter has no driver    |
| `system.status`        | `sqlite` | -     | -            | -           | -          | yes         | no                                                     | no                                                   |

### What the columns mean

`Storage` holds `sqlite` for every row that reaches `services/storage` or `services/blob`. Three rows hold `-`: `provider.catalog` and `provider.inspect` reach `services/model-catalog` alone, and `system.health` reaches the injected reporter set alone.

`Git` holds `git` for the four rows that reach `services/git`, and `Filesystem` holds `bare home` for the same four. No other routed operation touches either.

`Durable wait` holds `wait` for `event.list`. `src/http/server/event/wait.ts` keeps the long-poll registry in the process and polls at `POLL_INTERVAL_MS = 250`. A held connection outlives no Worker request and no Lambda invocation.

`Idempotency` holds `durable` for `plan.import`, `memory` for the eighteen routed operations that declare it, and `-` for the remaining twenty-five. `src/http/server/idempotency-store.ts` holds every record in memory, at `ttlSeconds: 300`, `joinTimeoutSeconds: 30`, `maxEntries: 256` and `maxBytes: 8388608`. Lambda runs many containers and Workers runs many isolates, so a replay that reaches a second container or a second isolate misses the record and the operation runs twice. That is a correctness defect on Lambda too, not a Workers limitation.

`system.health` degrades rather than fails because `src/main.ts` composes one reporter, named `storage`, whose probe calls `storage.ping()`. Without a driver that probe throws, `readHealth` records the line as `failed`, and the route answers `200` with the aggregate status `degraded`. A non-Node root composes a different reporter set, and the shorter list is a decision the tree does not settle.

### The aggregate

Counted from the rows above, not asserted ahead of them.

| Runtime     | `yes` | `degraded` | `no` |
| ----------- | ----- | ---------- | ---- |
| Node daemon | 44    | 0          | 0    |
| Lambda      | 1     | 2          | 41   |
| Workers     | 1     | 2          | 41   |

On the Node daemon 44 of 44 are `yes`. On Lambda and on Workers the single `yes` is `provider.catalog`, and the two `degraded` are `provider.inspect` and `system.health`.
```

### Formatting

```bash
npx prettier --write docs/proposal/phase-1/runtime-capability-matrix.md
```

Prettier normalises the column widths of both tables. Read the diff afterwards and confirm it
changed whitespace only.

## Constraints

- **Forty-four rows, no more and no fewer.** The set is the `routed` set of
  `src/http/contract/registry.ts`. Story 5's test compares the two sets in both directions, so a
  forty-fifth row and a missing row both fail.
- **Name no `stubbed` operation.** The twenty-five are `agent.list`, `attempt.show`,
  `binding.worker.project`, `gitOperation.list`, `instructions.resolve`, `node.abandon`,
  `node.approvalEvidence`, `node.approve`, `node.attempts`, `node.checks`, `node.discard`,
  `node.waive`, `profile.export`, `profile.import`, `profile.instantiate`, `profile.verify`,
  `repository.publish`, `repository.reconcile`, `run.cancel`, `run.list`, `run.show`, `run.start`,
  `template.list`, `template.show` and `worker.list`. Ten of them declare `idempotency: "memory"`;
  that is why the total memory count is `28` and the routed count is `18`.
- **The eighteen `memory` rows are exactly these**, and no other row may carry `memory`:
  `actor.register`, `actor.revoke`, `actor.rotate`, `node.claim`, `node.create`, `node.delete`,
  `node.heartbeat`, `node.release`, `node.report`, `node.unblock`, `node.update`, `plan.validate`,
  `project.create`, `provider.inspect`, `provider.register`, `provider.rename`,
  `repository.inspect`, `repository.register`.
- **`project.repositories`, `provider.remove` and `provider.setDefault` carry `-`.** All three are
  non-`GET` and none declares `idempotency`. Do not infer the field from the method.
- **A `degraded` cell names its degradation in the same cell.** Write no bare `degraded`.
- **State no product-level verdict before the table.** The aggregate follows the rows.
- Change no line Story 1 wrote. Append only.
- Write no deployment shape and no gate list. Those are Story 3.

## Verify

```bash
node --test src/http/contract/registry.test.ts src/http/contract/coverage.test.ts src/http/contract/parity.test.ts
```

- All three pass unchanged. This story edits one markdown file and no contract input.
- `git diff --name-only` names exactly one file:
  `docs/proposal/phase-1/runtime-capability-matrix.md`.
- The row count is 44:

```bash
grep -cE '^\| `[a-z]+\.[A-Za-z]+` +\|' docs/proposal/phase-1/runtime-capability-matrix.md
```

- The cell counts are exact:

```bash
grep -cE '^\| `[a-z]+\.[A-Za-z]+` +\| .*`memory`' docs/proposal/phase-1/runtime-capability-matrix.md   # 18
grep -cE '^\| `[a-z]+\.[A-Za-z]+` +\| .*`durable`' docs/proposal/phase-1/runtime-capability-matrix.md  # 1
grep -cE '^\| `repository\.[a-z]+` +\| .*`git`' docs/proposal/phase-1/runtime-capability-matrix.md     # 4
grep -cE '^\| `[a-z]+\.[A-Za-z]+` +\| .*bare home' docs/proposal/phase-1/runtime-capability-matrix.md  # 4
grep -cE '^\| `event\.list` +\| .*`wait`' docs/proposal/phase-1/runtime-capability-matrix.md           # 1
grep -o 'degraded — ' docs/proposal/phase-1/runtime-capability-matrix.md | wc -l                       # 4 cells, on 2 rows
```

- `grep -c 'home lock reporter\|bare home reporter' docs/proposal/phase-1/runtime-capability-matrix.md`
  reports `0`. Neither reporter exists in `src/main.ts`.
- The aggregate table states `44 | 0 | 0`, `1 | 2 | 41` and `1 | 2 | 41`.

`npm run verify` exits 0.

Proof: this story delivers the EPIC gate bullets **The matrix names every routed operation, by
value**, **The matrix names no stubbed operation** and **The document adds no operation the registry
lacks**. Story 5 supplies the mechanism that proves all three.
