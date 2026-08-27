# Story 5 — A test proves the matrix is complete

Epic: `.agents/plan/epics/036-runtime-capability-matrix.md`
Depends on: Story 2 — the test parses the table Story 2 writes.

**Test only.** This story adds one file, `src/http/contract/runtime-matrix.test.ts`, and changes no
production file. `scripts/lane-check.sh:72-83` puts a `*.test.ts` under `src/` in the test-engineer
lane and denies it to the software-engineer, so the software-engineer writes nothing for this story.

**There is no RED step against the product, and that is correct for this story.** The document
Stories 1 to 3 landed is already complete, so the test passes the first time it runs. An absent file
is not a failing test, and this story must not pretend otherwise.

Get the RED signal from the failure modes instead. Write the test, then run the four mutations of the
`## Verify` section against a scratch copy of the document and watch each one fail with the message
it should produce. A test that cannot be made to fail proves nothing, and those four runs are the
proof that it can.

**If the test fails on the unmutated document, diagnose — do not weaken the test.** Two causes are
possible and they need opposite fixes. Either this test is wrong, which is the test-engineer's to
repair, or the document does not match what Story 2 pinned, which is the software-engineer's, since
`scripts/lane-check.sh:99-101` denies `docs/proposal/**` to the test-engineer. Compare the failing
id against Story 2's table before changing a line, and escalate the second case rather than editing
around it.

## Change

### Create `src/http/contract/runtime-matrix.test.ts`

One new file. It reads the matrix document, extracts the first column of every data row of the
operation table, and compares that set against the `routed` operation ids of the registry.

**Imports.** Follow the convention of the three sibling contract tests:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { registry } from "./registry.ts";
```

`describe`/`it` and `node:assert/strict` are the style of `registry.test.ts:1-2`,
`coverage.test.ts:1-2` and `parity.test.ts:1-2`. `eslint.config.js` permits `node:fs` and
`node:path` here: the `no-restricted-imports` block for `src/http/contract/**/*.ts` at lines 309-334
carries `ignores: ["src/**/*.test.ts"]`, and `coverage.test.ts:3` already imports `node:fs`.

**Path resolution.** Resolve from `import.meta.dirname`, which is the idiom of every contract test
that reads a proposal file — `proposal-amendment.test.ts:6`,
`proposal-amendment-outcome.test.ts:6`, `proposal-amendment-execution.test.ts:8`:

```ts
const document = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../docs/proposal/phase-1/runtime-capability-matrix.md",
  ),
  "utf8",
);
```

The test takes no working directory from the caller. It reads one file. It touches no network, no
clock and no temporary directory.

**Extraction — isolate the table first, then take every data row.** Do not scan the whole document
for rows that look like operations. That inverts the requirement: it recognises only rows already
shaped like an operation id, so a malformed row, an unbackticked row, or a row with a stray
character is invisible to the test rather than a failure. Extract in three steps.

1. **Isolate the section.** Take the text from the line `## The operation matrix` up to the next
   line that starts with `## `, or the end of the file. Assert the section was found. This is what
   stops a table in another section from contributing a row.

2. **Isolate the table — the FIRST contiguous run of table lines, and only that run.** The section
   holds two tables: the operation table, then prose, then the aggregate table under
   `### The aggregate`. A filter that collects every `|` line in the section collects both, and the
   aggregate's five lines then arrive as five bogus data rows. Walk from the first line that starts
   with `|` and stop at the first line that does not. Drop the header row and the `| --- |`
   separator row; everything left in that run is a data row. Assert the run was found.

3. **Take the first cell of every data row, verbatim.** Split each row on `|`, take index 1, trim it,
   and strip one pair of surrounding backticks if both are present. Do **not** filter by a pattern
   and do **not** skip a cell that fails to match one. A cell of `run.start`, of `Node.Create`, of
   `plan_import` or of an empty string must all reach the comparison, because assertion 2 is what
   reports them.

```ts
const section = document.split("\n## The operation matrix\n")[1];
assert.ok(section, "the section `## The operation matrix` is absent");
const lines = section
  .split("\n## ")[0]
  .split("\n")
  .map((line) => line.trim());
const start = lines.findIndex((line) => line.startsWith("|"));
assert.ok(start !== -1, "the operation table is absent");
let end = start;
while (end < lines.length && lines[end].startsWith("|")) end += 1;
const rows = lines.slice(start, end);
assert.ok(rows.length > 2, "the operation table has no data row");
const documented = rows.slice(2).map((row) =>
  row
    .split("|")[1]
    .trim()
    .replace(/^`(.*)`$/, "$1"),
);
```

The `while` loop is what stops the walk at the blank line after the operation table, so the aggregate
table further down the same section never contributes a row. `rows.slice(2)` drops the header and the
separator. `documented` is `string[]`, in document order.

**Also assert the shape of every data row.** After the slice, assert every data row has nine cells:
`assert.deepEqual(rows.slice(2).map((row) => row.split("|").length - 2).filter((n) => n !== 9), [])`.
A row that lost or gained a column is a broken row even when its first cell is a valid operation id,
and without this the table can rot around a correct Operation column.

**The expected set.**

```ts
const routed = registry
  .filter((entry) => entry.status === "routed")
  .map((entry) => entry.operationId);
```

`registry` is `readonly Operation[]`, exported at `registry.ts:25`, and it is sorted bytewise by
`operationId` at `registry.ts:37-39`. `status` is typed `"routed" | "stubbed"` at
`operation.ts:38`. No exported helper returns the routed ids; `registry.test.ts:66` builds the same
filter inline, so this test does too.

**Suite name.** `describe("src/http/contract/runtime-matrix.test", () => {` — the module path
without the extension, matching `registry.test.ts:48`, `coverage.test.ts:101` and
`parity.test.ts:11`.

**Five assertions, in this order.**

1. **`it("names every routed operation")`** — for each id in `routed` that is not in `documented`,
   collect it; assert the collected array deep-equals `[]`. The assertion message names the missing
   ids, so a future registry addition reports which row to write. Use
   `assert.deepEqual(missing, [], \`the matrix is missing: ${missing.join(", ")}\`)`.

2. **`it("names no operation the registry lacks")`** — for each id in `documented` that is not in
   `routed`, collect it; assert the collected array deep-equals `[]`, with a message naming the
   unknown ids. This is the second direction of the comparison, and it is what makes a `stubbed` id
   in the document a failure.

3. **`it("documents exactly 44 routed operations")`** — assert
   `assert.equal(documented.length, 44)` and `assert.equal(routed.length, 44)`. The count is
   asserted by value, per the EPIC. A duplicated row fails this even when both set comparisons pass.

4. **`it("lists the operations in registry order")`** — assert
   `assert.deepEqual(documented, routed)`. The registry is sorted bytewise, and Story 2 wrote the
   rows in that order, so the document order is pinned rather than left to the writer.

5. **`it("gives every data row nine cells")`** — assert the widths array of the shape check above
   deep-equals `[]`, with a message naming the row index and the width of each offender. Assertions
   1 to 4 read the first cell only, so without this one the other eight columns can lose a cell and
   every other test stays green.

Assertion 4 subsumes assertions 1, 2 and 3 for a document that parses. Keep all four: each names its
own failure in its own message, and the literal `44` of assertion 3 is what a registry addition
trips first.

Every assertion compares a value against a value. None asserts "some value".

## Constraints

- **Add one file. Change nothing else.** No production file changes in this epic — the EPIC's gate
  states that the epic's change set names only files under `docs/proposal/` and this one new
  `*.test.ts`. The epic-wide form of that check is in `index.md`; this story proves only its own
  contribution.
- **Do not edit the matrix document.** It is the software-engineer lane, it is already correct, and
  `scripts/lane-check.sh:99-101` denies the path to the test-engineer.
- **Do not add a helper to `src/http/contract/`.** A non-test file there is the production contract,
  and this test needs none: the filter is three lines.
- **Do not import `services/`, `commands/`, `queries/` or `http/server/`.** The test needs
  `./registry.ts`, `node:fs`, `node:path`, `node:test` and `node:assert/strict`, and nothing else.
- **Isolate the section before you read a row, and never scan the whole document.** The document
  carries backticked operation ids in prose — `blob.show` in the capability section, `event.list`
  and `plan.import` in the column notes, `provider.catalog` in the shapes section — and it carries
  two other tables. A document-wide scan turns prose into phantom rows and makes the capability
  table a candidate source of rows.
- **Stop the table walk at the first non-table line.** `### The aggregate` sits inside the same
  `##` section as the operation table, and its table has four columns. Collecting every `|` line of
  the section yields 49 rows, not 44, and five of them fail the nine-cell assertion for no real
  reason. Take the first contiguous run only.
- **Filter data rows by table position, never by what the cell contains.** A pattern that matches
  only well-formed operation ids cannot report a malformed one: the bad row simply does not appear,
  and assertion 2 has nothing to fail on. Every row between the separator and the end of the table
  is a data row, whatever its first cell holds.
- **Strip at most one pair of surrounding backticks, and trim.** Do not strip a backtick from the
  middle of a cell, and do not lowercase or otherwise normalise the value — assertion 2 must be able
  to report `Node.Create` as unknown rather than silently repairing it.
- **The two `stubbed` ids that are easy to miss are `gitOperation.list`, which carries a capital
  inside its first part, and `binding.worker.project`, which carries two dots.** Verbatim extraction
  reports both. Any grammar-based filter risks dropping one.
- The count `44` is a literal in this test. It is the routed count of the registry today, asserted
  by value on purpose, so a registry addition fails here and forces the matching document row.

## Verify

```bash
node --test src/http/contract/runtime-matrix.test.ts
```

All five tests pass.

The full EPIC Proof block:

```bash
test -f docs/proposal/phase-1/runtime-capability-matrix.md \
  && node --test \
    src/http/contract/runtime-matrix.test.ts \
    src/http/contract/registry.test.ts \
    src/http/contract/coverage.test.ts \
    src/http/contract/parity.test.ts \
  && echo "PASS EPIC-036"
```

prints `PASS EPIC-036`.

Prove the five failure modes against a scratch copy of the document, and revert each edit before the
next. Copy the file aside first — these mutations must never reach a commit:

```bash
cp docs/proposal/phase-1/runtime-capability-matrix.md /tmp/matrix.backup.md
```

- Delete one data row from the operation table. `it("names every routed operation")` fails and its
  message names the deleted operation id.
- Add a row for `run.start`, a `stubbed` id. `it("names no operation the registry lacks")` fails and
  its message names `run.start`.
- Duplicate one data row. `it("documents exactly 44 routed operations")` fails on `45` against `44`.
- Swap two adjacent data rows. `it("lists the operations in registry order")` fails.
- Delete one `|` from the middle of a data row. `it("gives every data row nine cells")` fails and
  names that row. The other four stay green, which is the point of the fifth assertion.
- Replace one data row's first cell with `run.start`, unbackticked and with no other change.
  `it("names no operation the registry lacks")` still fails and names `run.start`. This is the case
  a pattern-filtered extraction would miss entirely.

Restore afterwards, and confirm the restore:

```bash
cp /tmp/matrix.backup.md docs/proposal/phase-1/runtime-capability-matrix.md
git diff --quiet docs/proposal/phase-1/runtime-capability-matrix.md && echo restored
```

Hermetic check: `grep -c 'mkdtemp\|Date.now\|fetch(\|http' src/http/contract/runtime-matrix.test.ts`
reports `0`.

Scope check: this story creates a file, so a bare `git diff --name-only` reports nothing for it.
Use `git status --porcelain -uall`; it names exactly one entry, and it is
`?? src/http/contract/runtime-matrix.test.ts`.

`npm run verify` exits 0 — `typecheck`, the full `node:test` suite, `eslint .` and
`verify-db-status`. A document edit breaks no contract test, and this run is the proof of it.

Proof: this story delivers the `node --test src/http/contract/runtime-matrix.test.ts` clause and the
`PASS EPIC-036` line of the EPIC Proof block. It delivers the gate bullets **The matrix names every
routed operation, by value**, **The matrix names no stubbed operation**, **A removed row fails the
test**, **The document adds no operation the registry lacks** and **The test is hermetic**.
