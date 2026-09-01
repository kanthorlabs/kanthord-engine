# EPIC 047 — The deliverable and the node pair

Status: **draft**. It follows EPIC 046 by sequence order, and it opens the worker-model block.

## Goal

A node declares an outcome, never a method:

- `deliverable` admits `test`, `implementation`, `review` and `expansion`;
- the `(kind, deliverable)` pair is legal, or the daemon refuses the node;
- every node declares a `verify` block that holds `paths` and `commands`;
- migration `11` adds `deliverable`, `verify_json` and `assignment` to `node`, each nullable, and changes no existing row.

## Non-goals

- **No routing, and `assignment` is a column only.** Migration `11` creates `node.assignment`. No domain schema names it, no write path sets it, and no response publishes it. EPIC 048 defines the worker id grammar and EPIC 050 writes and publishes the column. Publishing an unconstrained string before the grammar exists would create an externally observable state no schema can refuse.
- **No command execution.** Nothing runs a `verify.commands` entry here. EPIC 051 runs them against an immutable checkout.
- **No removal of `worker`.** `node.worker` stays, and `workerKinds` stays. EPIC 057 drops both.
- **No plan-document change.** `planFrontmatter` in `src/domain/plan-document.ts:16` does not gain a key here. EPIC 049 owns dual-read parsing.
- **No non-null constraint.** Every added column is nullable, so migration `11` is additive and a stored row keeps its meaning.
- **No new route.** `node.show` and `project.graph` gain `deliverable` and `verify` in their response schema, and no operation id is added.

## Decisions

- **`deliverable` is a closed set of four, in the order of `worker.md` section 2.** `src/domain/deliverable.ts` exports `deliverables` as a `readonly` tuple `["test", "implementation", "review", "expansion"]`, and `deliverable` as the zod enum over it. `worker.md` section 2 lists a fifth, `research`, and this phase does no research work, so the enum omits it. `worker.md` states the set grows; a later epic adds `research` together with the runner that executes it. Shipping a value no worker can claim would publish a state the product cannot leave. The order is observable, because the pair table iterates it, and a test asserts the tuple by deep equality. The file mirrors `src/domain/worker.ts:3`.

- **The pair table is one pure function, and it is the only legality authority.** `src/domain/node-pair.ts` exports `nodePairLegality(kind, deliverable)`. It returns `{ legal: true; shape: "parent" | "atomic"; stateOwner: "aggregate" | "attestation-then-human" | "report" }`, or `{ legal: false; refusal: "pair-illegal" }`. The atomic-objective owner is `attestation-then-human` and not `attestation`, because `worker.md` section 2 writes "Attestation, then a human" and section 6 states an objective reaches a terminal state only when a human closes it. A value that names the attestation alone would let EPIC 053 read the checkpoint as the terminal authority. The table is exactly the table of `worker.md` section 2:

  | `kind`       | `deliverable`                      | shape    | state owner              |
  | ------------ | ---------------------------------- | -------- | ------------------------ |
  | `initiative` | `expansion`                        | `parent` | `aggregate`              |
  | `objective`  | `expansion`                        | `parent` | `aggregate`              |
  | `objective`  | `test`, `implementation`, `review` | `atomic` | `attestation-then-human` |
  | `task`       | `test`, `implementation`, `review` | `atomic` | `report`                 |

  The matrix holds 3 kinds by 4 deliverables, so it holds 12 concrete pairs: **8 legal and 4 illegal**. The four illegal pairs are `(initiative, test)`, `(initiative, implementation)`, `(initiative, review)` and `(task, expansion)`. Every test enumerates the 12 concrete pairs, never the 4 grouped rows above, because a grouped row is prose and the function takes a scalar.

- **`nodePairLegality` is the one implementation, and every other mechanism derives from it.** `nodeRow` does not restate the rule: its `.refine` calls `nodePairLegality` and refuses when the result is not legal. Only the SQLite CHECK is a second expression of the rule, and it exists because a row written by a future writer that bypasses the domain must still fail at the storage boundary. Two expressions are the minimum; three would drift. `src/services/storage/migration-0011-deliverable.ts` adds:

  ```sql
  CHECK (deliverable IS NULL OR deliverable IN
        ('test', 'implementation', 'review', 'expansion'))
  CHECK (deliverable IS NULL OR kind <> 'initiative' OR deliverable = 'expansion')
  CHECK (deliverable IS NULL OR kind <> 'task' OR deliverable <> 'expansion')
  ```

  A test in `pnpm run verify` enumerates all 12 concrete pairs, computes the legal set from `nodePairLegality`, computes the legal set from real SQLite by attempting one insert per pair, and asserts the two sets are deep-equal. The assertion drives real SQLite, per the `AGENTS.md` test rules. It fails whether the domain or the schema drifts, and it names which one.

- **`verify` is one canonical JSON column, not two tables.** `node.verify_json` holds an object with exactly two keys, `paths` and `commands`, in that key order, each an array of strings. `src/domain/verify-block.ts` exports `verifyBlock`, `renderVerifyBlock(block): string` and `parseVerifyBlock(text)`. Child tables with an ordinal column could preserve the command order too; the column wins because EPIC 049 renders these exact bytes into a plan document, and reassembling canonical bytes from rows re-introduces an ordering problem the column does not have.

- **`verifyBlock` is a strict object, and an unknown key is a refusal.** `z.strictObject` refuses a third key rather than stripping it, because a stripped key would make a round trip lose bytes silently.

- **`parseVerifyBlock` is the one reader, and a malformed stored value is a query error, not a null.** `parseVerifyBlock` refuses with `VerifyBlockError` and code `verify-json-malformed`. `src/queries/node/show-node.ts` maps `verify_json` to the contract's `verify` object through it, and a malformed row surfaces as a `500` naming the node id. Returning null would let a corrupted row read as a node that declares nothing.

- **SQLite refuses text that is not JSON.** Migration `11` adds `CHECK (verify_json IS NULL OR json_valid(verify_json))`. The pair CHECK clauses exist because a future writer may bypass the domain; the same argument applies here, and `json_valid` is the strongest check SQL can make.

- **`paths` sorts, and `commands` does not.** `paths` is a set, so `renderVerifyBlock` sorts it with `comparePaths` from `src/domain/plan-path.ts` and rejects a duplicate. `commands` is a sequence a worker runs in order, so the order is the author's and it is preserved verbatim. A duplicate command is legal.

- **An empty `commands` list asserts nothing, and what follows from that depends on the pair.** `worker.md` section 2 states the list asserts nothing. `verifyBlock` accepts `{"paths": [], "commands": []}`. For an initiative and a parent objective that is the correct and final value, because a structural checkpoint runs no command. For an atomic node it means the node declares no check, and `worker.md` section 12 states such a node stays ineligible. This epic stores the value and draws no eligibility conclusion. EPIC 049 records the ineligibility in the conversion report, and EPIC 050 owns the claim-time rule. The distinction is stated here so a later epic does not read "asserts nothing" as "claimable".

- **A `paths` entry is a well-formed absolute path, and a `commands` entry is a shell string.** `verifyBlock` accepts absolute paths only and refuses relative paths. It does not reuse `parseSubmittedPath` from `src/domain/plan-path.ts`, because that grammar requires a `plan/` prefix and a `.md` suffix, and a verify path names source, not a plan document. `src/domain/verify-block.ts` holds its own path check, and it refuses only a structurally invalid value: an empty string, a NUL byte, an unpaired surrogate, a backslash, an empty segment, a `.` or `..` segment, and a trailing slash. `domain/` is pure, so no check reaches the file system; a path that does not exist is not a parse error. A command is an opaque string here, because the daemon runs it through a shell in EPIC 051, and no shape check would be honest.

- **`assignment` is a nullable text column and nothing else in this epic.** No format check lands here, because EPIC 048 defines the worker id grammar. The column is therefore absent from `nodeRow`, from `StoredNode`, from the plan store's read and write paths and from every response schema until EPIC 050. Creating it now keeps migration `11` the only additive migration this block needs on `node`; publishing it now would expose a string no schema can refuse.

- **The pair is fixed once the node holds a child or an accepted checkpoint, and this epic proves the rule cannot be violated yet.** The only writer of `deliverable` in this epic is `plan import`, which replaces a whole document set against a new revision and never edits a node in place. `node.update` cannot reach the field, because `deliverable` joins neither `proseFields` nor `structuralFields` at `src/domain/node-write-legality.ts:6` and `:7`. A story asserts both facts, so the deferral rests on a proof and not on an assumption. EPIC 052 enforces the rule at the structural patch, which is the first path that can change a pair in place.

- **Two of the three columns reach the read contract in this epic, so the epic closes on a route.** `src/http/contract/graph.ts` gains `deliverable` and `verify` on the node projection, each nullable. `assignment` follows in EPIC 050. `AGENTS.md` states a capability that no route can reach does not close.

## Stories

1. **The deliverable enum.** Add `src/domain/deliverable.ts` with the four-element tuple in the fixed order and the zod enum. Add `src/domain/deliverable.test.ts` asserting the tuple by deep equality, asserting each value parses, and asserting `"expansions"`, `"impl"` and `""` are refused by value.

2. **The node pair table.** Add `src/domain/node-pair.ts` with `nodePairLegality`. Add `src/domain/node-pair.test.ts` enumerating all 12 concrete pairs by iterating `nodeKinds` against `deliverables`: assert the 8 legal pairs by their full result object, including `shape` and `stateOwner`, and assert each of the 4 illegal pairs returns `{ legal: false, refusal: "pair-illegal" }`. Assert the legal count is 8 and the illegal count is 4, so a table edit fails the test.

3. **The verify block.** Add `src/domain/verify-block.ts` with `verifyBlock` as a `z.strictObject`, `renderVerifyBlock` and `parseVerifyBlock`. Add `src/domain/verify-block.test.ts` asserting: a `paths` list emits bytewise sorted, including a non-ASCII path compared through `Buffer.compare`; a duplicate path is refused; `commands` order is preserved verbatim across a round trip; an empty block renders exactly `{"paths":[],"commands":[]}`; an absolute path is accepted and a relative path is refused; an empty string, a NUL byte, an unpaired surrogate, a backslash, an empty segment, a `.` segment, a `..` segment and a trailing slash are each refused with the issue path `paths`; a third key is refused rather than stripped; `parseVerifyBlock` refuses `"{"`, `"[]"` and `'{"paths":[]}'` with `verify-json-malformed`, asserted by error code.

4. **Migration 11.** Add `src/services/storage/migration-0011-deliverable.ts` at version `11`, adding `deliverable`, `verify_json` and `assignment` to `node` with the three pair CHECK clauses and the `json_valid` CHECK of the Decisions. Register it in `src/services/storage/migrations.ts:13`. Add `src/services/storage/migration-0011-deliverable.test.ts` asserting the migration applies to a database holding rows, leaves every existing row unchanged and every added column null, refuses each of the 4 illegal pairs by insert, admits each of the 8 legal pairs by insert, and refuses `verify_json = '{'` by the `json_valid` CHECK. `src/services/storage/schema-parity.test.ts` passes unchanged in intent.

5. **The node row carries the two fields.** Extend `nodeRow` in `src/domain/node.ts:9` with `deliverable: deliverable.nullable()` and `verifyJson: z.string().nullable()`, plus one `.refine` that calls `nodePairLegality` and refuses when the result is not legal. `assignment` is not added to `nodeRow`. Extend `StoredNode` in `src/domain/plan-graph.ts:3` with the same two fields. Update `src/domain/node.test.ts` asserting the refine refuses each of the 4 illegal pairs and admits each of the 8 legal ones, and asserting `nodeRow` holds no `assignment` key.

6. **The plan store reads and writes the two columns.** Extend the node read and write paths of `src/services/plan/sqlite.ts` so a stored node round-trips `deliverable` and `verify_json`. The write path is reached by `plan import` only. Add cases to `src/services/plan/sqlite.test.ts` asserting a node written with a `verify_json` value reads back byte-identical, asserting a node written with both null reads back null, and asserting the write path never sets `assignment`.

7. **No writer can change a pair in place.** Add cases to `src/commands/node/update-node.test.ts` and `src/domain/node-write-legality.test.ts` asserting `deliverable` is in neither `proseFields` nor `structuralFields`, and asserting `node.update` carrying a `deliverable` field is refused as an unknown field. The two cases are the proof the pair-fixing deferral rests on.

8. **The read contract publishes the two fields.** Add `deliverable` and `verify` to the node projection in `src/http/contract/graph.ts`, each nullable, with `verify` shaped as the strict two-key object. Update `src/http/contract/graph.test.ts`, `src/http/contract/example.test.ts` and the example literals in `src/http/contract/example-literal.ts`. Map `verify_json` to `verify` through `parseVerifyBlock` in `src/queries/node/show-node.ts` and `src/queries/project/show-project-graph.ts`. Add `src/queries/node/show-node.test.ts` and `src/queries/project/show-project-graph.test.ts` cases asserting both fields for a node that holds them, null for a node that does not, and a `verify-json-malformed` error for a row holding invalid JSON.

9. **The proposal records the model.** Add `docs/proposal/phase-2/deliverables-and-pairs.md` stating the four deliverables, and that `research` is deliberately absent in this phase, the pair table with its 8 legal and 4 illegal pairs, the shape and state owner per pair, the `verify` block contract, the pair-fixing rule and its enforcement owner, and the transitional meaning of a null `deliverable`. State that a deliverable is an outcome and never carries an agent name. State that `node.worker` is legacy and that EPIC 057 removes it.

## Verification Gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/deliverable.test.ts \
  src/domain/node-pair.test.ts \
  src/domain/verify-block.test.ts \
  src/domain/node.test.ts \
  src/services/storage/migration-0011-deliverable.test.ts \
  src/services/plan/sqlite.test.ts \
  src/domain/node-write-legality.test.ts \
  src/commands/node/update-node.test.ts \
  src/queries/node/show-node.test.ts \
  src/queries/project/show-project-graph.test.ts \
  src/http/contract/graph.test.ts \
  && echo "PASS EPIC-047"
```

Hermetic coverage required beyond the Proof:

- `deliverables` deep-equals the four-element array in the fixed order. The assertion names every element.
- The pair matrix is enumerated over all 12 concrete pairs by iterating `nodeKinds` against `deliverables`. The legal count is 8 and the illegal count is 4, each asserted as a number.
- `nodePairLegality` returns the exact result object for each of the 8 legal pairs, including `shape` and `stateOwner`. No test asserts `legal` alone. The atomic-objective rows return `attestation-then-human`.
- Each of the 4 illegal pairs is refused by value: `(initiative, test)`, `(initiative, implementation)`, `(initiative, review)` and `(task, expansion)`.
- The domain function and the SQLite CHECK clauses admit and refuse the same 12 pairs. The SQLite half runs one insert per pair against a real temporary database, and the assertion compares the two legal sets by deep equality.
- `nodeRow`'s refine calls `nodePairLegality`. The test runner is `node:test`, which has no module mock, so the assertion is a parity assertion: for each of the 12 concrete pairs, `nodePairLegality(kind, deliverable).legal` equals `nodeRow.safeParse` success for that same pair. A mirrored second implementation in `nodeRow` fails it at the first pair where the two diverge.
- `verifyBlock` refuses a third key rather than stripping it, asserted by comparing the parsed output to the input.
- `parseVerifyBlock` refuses invalid JSON and a missing key with `verify-json-malformed`, asserted by error code.
- SQLite refuses `verify_json = '{'` through the `json_valid` CHECK.
- `nodeRow` holds no `assignment` key, and the plan store's write path never sets the column. Both are asserted, so the column stays unpublished until EPIC 050.
- `deliverable` is in neither `proseFields` nor `structuralFields`, and `node.update` carrying it is refused. The two assertions are the proof that no writer can change a pair in place.
- `node.show` and `project.graph` return `verify` as a parsed object, and a row holding invalid JSON surfaces as `verify-json-malformed` rather than as null.
- `renderVerifyBlock` emits `{"paths":[],"commands":[]}` for the empty block, byte-exact.
- A `paths` list holding a non-ASCII entry sorts bytewise, asserted through `Buffer.compare`.
- A `commands` list holding two identical entries round-trips with both entries, in order.
- Migration `11` applied to a database holding one initiative, one objective and one task leaves every column of every row unchanged, asserted field by field, and sets the three added columns to null.
- A node row written with `deliverable = 'expansion'` and `kind = 'task'` is refused by SQLite, and the refusal message names the CHECK.
