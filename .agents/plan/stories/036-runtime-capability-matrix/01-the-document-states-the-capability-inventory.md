# Story 1 — The document states the capability inventory

Epic: `.agents/plan/epics/036-runtime-capability-matrix.md`

Documentation only. No file under `src/`, `test/` or `scripts/` changes.

`docs/proposal/*` is the software-engineer lane (`scripts/lane-check.sh:99-101`). The test-engineer
writes nothing for this story.

This story creates the file and writes its first three sections. Story 2 appends the operation table,
Story 3 appends the shapes and the gate. No later story rewrites a line this story wrote.

## Change

### Create `docs/proposal/phase-1/runtime-capability-matrix.md`

The file does not exist. Create it with exactly the content between the fence markers, and write
nothing after the last line:

```
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
| `readiness`     | none                                                                       | yes         | yes    | yes     |
| `revision`      | none                                                                       | yes         | yes    | yes     |
| `secret`        | `node:crypto`                                                              | yes         | yes    | yes     |
| `storage`       | `node:sqlite`                                                              | yes         | no     | no      |
| `verify`        | none                                                                       | yes         | yes    | yes     |

Twenty capabilities. Thirteen import no Node built-in at all. On Lambda eighteen are `yes` and two are `no`, and the two are `home-lock` and `storage`. On Workers sixteen are `yes` and four are `no`, and the four are `config`, `git`, `home-lock` and `storage`.

A capability verdict is not an operation verdict. `blob` is `yes` on both targets because it imports `node:crypto` alone, and `blob.show` is still `no` on both, because `src/services/blob/sqlite.ts` persists through the storage transaction that `services/storage` owns. The operation table is the verdict that counts.

### The two boundaries the inventory names

**A subprocess boundary makes git impossible on a Worker.** `src/services/git/launcher.ts` imports `node:child_process`, and every git operation runs the `git` binary through it. A Worker starts no subprocess. The product accepts that boundary: git stays a subprocess capability. A Worker deployment reaches git through a remote capability behind the `Git` interface, or it serves no repository operation at all.

**A local SQLite file is exclusive to one host.** `src/services/storage/connection.ts` and `src/services/storage/sqlite.ts` import `node:sqlite`, and `src/services/home-lock/sqlite.ts` imports it as well. Neither target keeps such a file. `AGENTS.md` requires a state transition and its event append in one transaction, so a replacement driver carries that constraint into its own interface.
```

### Formatting

`lint-staged` runs `prettier --write` over `*.md`, and `npm run format` runs inside `npm run verify`.
Run it so the committed bytes are stable:

```bash
npx prettier --write docs/proposal/phase-1/runtime-capability-matrix.md
```

## Constraints

- **Create one file. Change no other file.** `docs/proposal/README.md`,
  `docs/proposal/phase-1/README.md` and `docs/proposal/phase-1/transport.md` belong to Story 4.
- **Write no operation row.** The operation table is Story 2. A row here that names an operation id
  makes `src/http/contract/runtime-matrix.test.ts` of Story 5 parse the wrong table.
- **Write no deployment shape and no gate list.** Those are Story 3.
- The reviewer line is line 3, plain prose, and it begins with the literal `Reviewer: `. That is the
  convention of every sibling: `transport.md:3`, `domain.md:3`, `plan-format.md:3`.
- Name no epic number for an unblocked epic. The EPIC states that none carries a number.
- The capability set is the twenty directories under `src/services/`, and the built-in sets are
  exact. Do not re-derive them; the values above were read off the tree.

## Verify

```bash
node --test src/http/contract/parity.test.ts src/http/contract/registry.test.ts
```

- Both pass unchanged. This story adds no route and no proposal route row, so
  `parity.test.ts:16` and `:25` keep their current values.
- `test -f docs/proposal/phase-1/runtime-capability-matrix.md` exits 0.
- The scope check must see an **untracked** file, so it is `git status`, not `git diff`. This story
  creates the document, and a bare `git diff --name-only` reports nothing for a file git does not
  track yet. `git status --porcelain -uall` names exactly one entry, and it is
  `?? docs/proposal/phase-1/runtime-capability-matrix.md`. This is the idiom
  `scripts/turn-snapshot.sh:5` already uses.
- `sed -n 3p docs/proposal/phase-1/runtime-capability-matrix.md` starts with `Reviewer: `.
- `grep -c '^| `' docs/proposal/phase-1/runtime-capability-matrix.md`reports`26`— twenty
capability rows and six built-in rows. No other line of the file starts with a backticked cell.
**This count holds at this story only.** Story 2 adds 44 rows that also open with a backticked
cell, taking the same command to`70`. A reviewer running it after Story 2 must expect `70`, not
report `26` as a regression.
- These two report `0`:

```bash
grep -cE '^\| `?(actor|node|project|provider|repository|system|plan|event|edge|blob)\.' docs/proposal/phase-1/runtime-capability-matrix.md
grep -c "EPIC 0" docs/proposal/phase-1/runtime-capability-matrix.md
```

`npm run verify` exits 0.

Proof: this story delivers the `test -f docs/proposal/phase-1/runtime-capability-matrix.md` clause of
the EPIC Proof block. It delivers no `node --test` clause on its own.
