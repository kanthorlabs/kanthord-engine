# Story 3 — The document states the deployment shapes and the gate

Epic: `.agents/plan/epics/036-runtime-capability-matrix.md`
Depends on: Story 2 — it appends after the aggregate table.

Documentation only. No file under `src/`, `test/` or `scripts/` changes.
`docs/proposal/*` is the software-engineer lane (`scripts/lane-check.sh:99-101`). The test-engineer
writes nothing for this story.

**The EPIC's shape 2 and the EPIC's Lambda column disagree, and this story reconciles them in the
document.** The shape says a container on Lambda "carries the whole surface". The column says 41 of
44 are `no`. Both are true of different things: the column reads the tree as it stands, and the shape
names what a deployment adds on top of it. The text below states that distinction, and it states the
two operations the shape still does not carry.

## Change

### Append to `docs/proposal/phase-1/runtime-capability-matrix.md`

Append the content between the fence markers to the end of the file. Change no line Story 1 or
Story 2 wrote.

```
## Four deployment shapes, ranked

The columns above read the tree as it stands, with no deployment support added. A shape is what a deployment adds on top of that tree, so a shape lifts a `no` the columns record.

**A shape carries an operation when that operation answers correctly under the shape.** A `degraded` row is not carried: it answers, and it answers with the defect its cell names. Each shape below therefore states one exact count of carried operations, and names every operation it does not carry.

**1. The Node daemon on a long-lived host. It carries 44 of 44.** The shipped shape. Every routed operation is `yes`. The daemon owns the home: `src/main.ts` acquires the home lock and recovers expired leases at startup. Startup recovery is a property of this shape alone.

**2. A container on AWS Lambda, with reserved concurrency `1` and a durable mounted home. It carries 42 of 44.** The serverless shape that carries the most surface. A container image ships the `git` binary and starts a subprocess, so the four repository operations are not blocked here as they are on a Worker. The mounted home restores the SQLite file and the bare home, which lifts the storage `no` and the filesystem `no` of the matrix.

It does not carry `event.list` or `plan.import`. `event.list` holds a connection open, and a held connection outlives no invocation. `plan.import` declares `durable` idempotency, and the tree has no durable store to satisfy it.

Reserved concurrency `1` bounds the shape to one container at a time. It does not make that container immortal: a cold start discards the in-memory idempotency records, so a replay that crosses a cold start still misses. The shape narrows the memory-idempotency defect and does not remove it, and item 2 of the gate is what removes it.

The Hono chain of EPIC 032 carries over with no edit, because the shape changes the packaging and not the request handling.

**3. A Worker with a remote storage driver, and no git. It carries 38 of 44.** A remote storage driver lifts every row whose only obstacle is `sqlite`. It does not carry the four repository operations, because git is a subprocess capability and an isolate starts no subprocess. It does not carry `event.list` or `plan.import`, for the reasons shape 2 gives. An isolate has no equivalent of reserved concurrency, so the memory-idempotency defect is worse here than on shape 2, not better.

Adding git as a remote capability behind the `Git` interface would carry the four repository operations as well, and make this shape carry the whole surface bar `event.list` and `plan.import`. That capability is item 3 of the gate and it is not built, so it is not part of this shape.

**4. A Worker on the tree as it stands today. It carries 1 of 44.** The one is `provider.catalog`. `provider.inspect` and `system.health` answer with the degradations their cells name, and the other 41 do not answer. This is not a product shape. It is stated so the count is on the record.

Hono stays useful in shape 2 and in shape 3. That is the reason the band keeps Hono after this gate.

## The gate

This document unblocks four pieces of work. None of them opens before it lands, and none of them carries an epic number: a number commits the sequence, and this matrix is what decides the sequence.

1. A storage driver behind an interface that names no Node built-in. It carries the transaction rule of `AGENTS.md` into its own interface, because a state transition and its event append are never in two transactions.
2. Durable idempotency, and a durable wait. Both are correctness defects on Lambda too, not Workers limitations.
3. Git as a remote capability behind the `Git` interface. The protocol, the authentication and the lease model for a remote git host are unnamed.
4. The Lambda entrypoint and the Worker entrypoint.

No later epic of the 030–039 band opens before this document lands.
```

### Formatting

```bash
npx prettier --write docs/proposal/phase-1/runtime-capability-matrix.md
```

## Constraints

- **Name no epic number for an unblocked item.** The EPIC makes that deliberate. Writing `EPIC 040`
  or any other number contradicts the sentence that follows the list.
- **Rank the shapes in this order and no other.** Node daemon, Lambda container, Worker with remote
  storage, Worker on the tree today.
- **Define `carries` before the first shape uses it, and use it consistently.** A shape carries an
  operation when that operation answers correctly under the shape. A `degraded` row is not carried.
  Without the definition the four counts are unreadable, because a reader cannot tell which side of
  the count a `degraded` row falls on.
- **The four counts are `44`, `42`, `38` and `1`, and each is derived, not asserted.** Shape 1 is
  every row. Shape 2 is 44 less `event.list` and `plan.import`. Shape 3 is 44 less those two and less
  the four repository operations. Shape 4 is `provider.catalog` alone, because it is the only routed
  row whose Workers cell is `yes`.
- **Shape 2 does not block the repository operations.** A Lambda container image ships the `git`
  binary and starts a subprocess, so `node:child_process` is not the obstacle there that it is on a
  Worker. The mounted home supplies the bare home. Story 1's built-in table already states this;
  do not contradict it here.
- **Do not claim reserved concurrency `1` removes the memory-idempotency defect.** It bounds the
  shape to one container and a cold start still discards the records. Say that it narrows the defect.
- **Shape 3 excludes git.** Do not name git as a remote capability inside the shape and then exclude
  the repository operations from it — that reads as a contradiction. State the shape without git,
  then state what adding the unbuilt capability would carry.
- **Do not restate a cell of the operation table.** The shapes section explains the rows; it does not
  repeat them.
- Change no line Story 1 or Story 2 wrote. Append only.
- Story 4 owns every edit outside this file.

## Verify

```bash
node --test src/http/contract/registry.test.ts src/http/contract/parity.test.ts
```

- Both pass unchanged.
- `git diff --name-only` names exactly one file:
  `docs/proposal/phase-1/runtime-capability-matrix.md`.
- `grep -c '^\*\*[1-4]\. ' docs/proposal/phase-1/runtime-capability-matrix.md` reports `4` — the four
  shapes, each opening with its rank.
- `grep -c 'EPIC 0' docs/proposal/phase-1/runtime-capability-matrix.md` reports `1`, and that one hit
  is the EPIC 032 reference inside shape 2. No gate item names a number.
- `grep -c '^## ' docs/proposal/phase-1/runtime-capability-matrix.md` reports `5` — portable
  built-ins, the capability inventory, the operation matrix, the shapes and the gate.
- The row count of the operation table is still 44:

```bash
grep -cE '^\| `[a-z]+\.[A-Za-z]+` +\|' docs/proposal/phase-1/runtime-capability-matrix.md
```

`npm run verify` exits 0.

Proof: this story delivers no `node --test` clause of the EPIC Proof on its own. The EPIC's Goal names
the shapes and the gate as part of the one artifact, so the epic is incomplete without it.
