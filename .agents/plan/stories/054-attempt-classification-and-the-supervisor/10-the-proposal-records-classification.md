# Story 10 — The proposal records classification

Epic: `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md`
Depends on: every other story of this epic. It states what they shipped, and it appends
`shippedEpics`, which makes this epic's stories due to `scripts/verify-epic-sequence.ts`.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.

Every path it edits is allowed to one engineer lane by `scripts/lane-check.sh`:
`docs/proposal/**` is the software-engineer lane, `src/http/contract/*.test.ts` and
`test/sequence/conformance.test.ts` are the test-engineer lane, and `scripts/epic-sequence-range.ts`
is the software-engineer lane. It declares no `Executor:` and no `Paths:` line.

**It is last in dispatch order**, because appending `shippedEpics` makes every diagram of every
authored epic up to this one scenario-due. This epic declares no diagram, so the append adds no
scenario file — but it does require every prior epic in the prefix to have shipped, which is what
makes this story last rather than first.

**Two shipped paragraphs contradict this epic, and this story supersedes both.** The epic's story list
does not name them, and each is pinned by a test:

- `docs/proposal/phase-1/state-machine.md:118` — `spends a try` reads "Every closed attempt spends a
  try, whatever its outcome", pinned as a whole-paragraph literal at
  `src/http/contract/proposal-amendment-outcome.test.ts:20` — `spendClause` and asserted at
  `src/http/contract/proposal-amendment-outcome.test.ts:112` — `spendClause`.
- `docs/proposal/database/attempt.md:30` — `attempt_no = attempt_limit` reads "`attempt_no =
attempt_limit` with any non-null `outcome` moves the task to `blocked` with reason
  `attempt-limit`", pinned at `src/http/contract/proposal-amendment-outcome.test.ts:121` — `attempt.md prose widens`.

Both say the limit counts closed attempts. After Story 7 (`07-accounting-by-class`) the limit counts
semantic terminations. **Leaving either in place ships a proposal that states the opposite of the
code**, and the second is what a reader consults to understand why a task blocked.

## Change

### 1 — `docs/proposal/phase-2/attempts-and-classification.md` — the new document

**Create `docs/proposal/phase-2/attempts-and-classification.md`**, in the prose style of
`docs/proposal/phase-2/deliverables-and-pairs.md:3` — `## Deliverables`: an H1 title, one `##` section
per fact, prose paragraphs and Markdown tables. One `##` section per numbered fact below, in this
order. Each quoted sentence is written verbatim here and copied into the document unchanged, because
case 1 asserts each by `includes`.

1. **`## The three classes`** — the table of `termination`, "Consumes an attempt" and "Source", copied
   from `docs/workflow/worker.md:457` — `termination`, plus the sentence:
   `"A termination is semantic, infrastructure or ambiguous, and only a non-accepted attempt carries one."`

2. **`## The evidence union`** — the ten-row table with the columns `kind`, `driver` and `class`,
   exactly as the epic's Decisions state it, plus:
   `"Termination evidence is a closed discriminated union with one kind per case, so two conflicting facts cannot be supplied at once and no precedence rule has to be invented."`
   State that `provider-quota` carries a provider id and a response hash, and that `ancestor-ended`
   carries the run whose ending closed the attempt.

3. **`## The two classifiers`** —
   `"An internal worker has a supervisor that classifies from observed termination, and an external worker has none, so the daemon classifies."`
   State that the two evidence types are disjoint subsets of the union and that one function with a
   driver parameter would let an external value reach an internal rule.

4. **`## The trust boundary`** —
   `"The trust boundary is the transport schema and not a type signature, because a TypeScript signature is erased at run time."`
   State that `node.report` refuses an unknown key rather than stripping it, and that the daemon
   constructs an external termination from its own facts. State
   `"A worker's own claim of quota exhaustion is worker-reported-failure, and only a provider-signed quota response classifies infrastructure."`

5. **`## The ambiguous budget`** —
   `"The ambiguous budget belongs to the node and its current assignment, never to the run, because an unexplained expiry ends the run and a per-run counter would reset on the very event it must count."`
   Plus the boundary:
   `"An ambiguous termination is stored ambiguous while the counter is below the budget, and stored semantic once the counter reaches it, so a budget of 0 converts the first ambiguous termination."`
   Plus the reset:
   `"A worker switch clears the counter, because the budget bounds one worker's crash loop and a new worker starts clean, and node.unblock does not clear it."`
   Plus:
   `"The conversion is applied when the class is decided, and the stored value is what was charged, so the row and the accounting never disagree."`

6. **`## The attempt limit`** —
   `"The attempt limit counts semantic terminations, so an infrastructure failure no longer advances it and a release never exhausts it."`
   State that `attemptsRemaining` counts the same thing. **This section is what supersedes
   section 2's shipped paragraphs**, and it names the number a worker reads.

7. **`## A legacy row prices at zero`** —
   `"No attempt row is backfilled, so every attempt closed before this migration holds a null termination and counts toward neither count."`
   Plus the effect, stated and not hidden:
   `"A live run's earlier failures are forgiven at the upgrade and its attempt limit restarts, because a backfill would assign a class the daemon never observed."`

8. **`## Caller and subject`** —
   `"The caller is the authenticated principal the middleware resolved and the subject is the registered worker the run belongs to, and neither is ever read from a request body."`
   State the three successive values of `caller` — the actor id today, a grant id from EPIC 055, a
   supervisor id from EPIC 110 — and that no row written before this migration carries either, and
   that none is backfilled.

**The document states no wired path.** It names no command file, no operation id and no route: no
path calls the classifier until EPIC 054.1, and each later epic of the family amends this document
with the paths it wires. Case 3 asserts that as a negative with a control.

### 2 — `docs/proposal/phase-1/state-machine.md` — supersede the spend clause

**Replace the bullet at `docs/proposal/phase-1/state-machine.md:118`** — `spends a try`. The new
bullet keeps its first and last sentences and replaces the middle two:

```text
- Attempt accounting belongs to the domain. The attempt counter is `MAX(attempt_no)` of the active task run. The attempt limit counts semantic terminations, so an infrastructure failure no longer advances it. The limit moves the task to `blocked` with reason `attempt-limit`. The default limit is 3, from configuration. See `../phase-2/attempts-and-classification.md`.
```

**`MAX(attempt_no)` stays the attempt counter.** It is still what `accounting.counter` is and what
`nextAttemptNo` is built from; what changed is which counter the limit reads. Deleting that sentence
would leave `attempt_no` unexplained.

**Update the pinned literal at `src/http/contract/proposal-amendment-outcome.test.ts:20`** —
`spendClause` to the new paragraph, byte-for-byte. The negative assertion at
`src/http/contract/proposal-amendment-outcome.test.ts:116` — `Each rejection increments` stays exactly as it is, and a second negative joins it: assert
`!stateMachine.includes("Every closed attempt spends a try, whatever its outcome.")`.

### 3 — `docs/proposal/database/attempt.md` — supersede two prose sentences

**Replace the sentence at `docs/proposal/database/attempt.md:30`** — `attempt_no = attempt_limit`:

```text
The attempt limit counts semantic terminations. An attempt whose `termination` is `semantic` spends a try; an `infrastructure` one does not, and an `ambiguous` one spends a separate budget held on the node. A count of semantic terminations that reaches `attempt_limit` moves the task to `blocked` with reason `attempt-limit`.
```

**Replace the sentence at `docs/proposal/database/attempt.md:46`** — `A third rejection here would
reach`, whose example arithmetic counts rejections rather than terminations, with the same rule stated
over the example's two rows.

**Update the pinned literal at `src/http/contract/proposal-amendment-outcome.test.ts:120`** —
`attempt.md prose widens the limit clause to any non-null outcome`: rename the `it` and assert the new
sentence, plus the negative
`!attempt.includes("with any non-null `outcome`moves the task to`blocked`")`.

**Do not touch the SQL fence of that file.**
`src/services/storage/migration-0007-external-execution.test.ts:1159` — `proposalStatements` pins it
against migration `7`, and `test/helpers/proposal.ts:15` — `sqlFence` reads the fence alone, so the
prose edits above are outside the pin. Story 1 (`01-migration-16`) states the same constraint from
the other side.

### 4 — `scripts/epic-sequence-range.ts` — append `"054"` to `shippedEpics`

**Append `"054"` to `scripts/epic-sequence-range.ts:20`** — `shippedEpics`, and to the pinned literal
at `test/sequence/conformance.test.ts:274` — `shippedEpics`. Story 1 (`01-migration-16`) already put
it in `authoredEpics`, and `test/sequence/conformance.test.ts:275` requires `shippedEpics` to stay a
prefix of `authoredEpics`.

**The prefix rule is a real precondition, and it is not this story's to satisfy alone.** At the time
this story was written `shippedEpics` was `["050", "050.1"]`, so appending `"054"` alone yields
`["050", "050.1", "054"]`, which is **not** a prefix of `authoredEpics` and turns
`test/sequence/conformance.test.ts:254` — `shippedEpics is a prefix of authoredEpics` red. Every epic
between `"050.2"` and `"054"` appends its own entry in its own last story. **An implementing agent
that finds `shippedEpics` not ending at the entry immediately before `"054"` stops and reports the
gap rather than filling it**: the missing entries belong to the epics that own them.

**`test/sequence/conformance.test.ts:83`** — `shipped` scopes `liveDiagrams` to `shippedEpics`, and
this epic declares no live diagram in any story, so the append makes no scenario file due. That is
what makes this append cheap here and expensive in an epic that draws.

## Constraints

- The document names no command file, no operation id and no route. `end-attempt`, `attempt.show` and
  `node.report` appear nowhere in it.
- Every sentence quoted in section 1 is copied verbatim. A reworded sentence fails case 1, and the
  case is the reason the sentences are written here rather than described.
- `docs/proposal/phase-1/state-machine.md` keeps its `MAX(attempt_no)` sentence and its
  `attempt-limit` sentence. Only the spend sentence changes.
- The SQL fence of `docs/proposal/database/attempt.md` is untouched.
- `docs/proposal/database/node.md` is untouched. Its fence is already three columns behind migration
  `11`, and `docs/proposal/database/node.md:42` — `attempt counter` stays true, because
  `ambiguous_used` counts ambiguous terminations and the attempt counter is still `MAX(attempt_no)`.
- `HANDOFF.md` is not edited. This epic asks the dashboard team for nothing.

## Verify

```
node --test src/http/contract/proposal-amendment-attempts-and-classification.test.ts src/http/contract/proposal-amendment-outcome.test.ts test/sequence/conformance.test.ts
```

Add `src/http/contract/proposal-amendment-attempts-and-classification.test.ts`, following
`src/http/contract/proposal-amendment-outcome.test.ts:1` — its imports,
`src/http/contract/proposal-amendment-outcome.test.ts:8` — `read` and
`src/http/contract/proposal-amendment-outcome.test.ts:12` — `squash`: squash the document to
single-spaced text and assert one verbatim sentence per fact.

Add, each as a separate `it`:

1. `"attempts-and-classification.md states each of the thirteen sentences"` — **thirteen**
   `assert.ok(doc.includes(...))` calls, one per quoted sentence of section 1, not eight. Section 1
   has eight `##` facts but thirteen quoted sentences: facts 1, 2, 3, 6 and 8 quote one each, facts 4
   and 7 quote two each, and fact 5 quotes four. Declare the thirteen as a local literal array and
   iterate it, so a sentence added to the story and not to the array fails the length assertion. Add
   `assert.equal(sentences.length, 13)` by value, then one `##` heading assertion per section and
   `indexOf` comparisons proving the eight sections appear in the stated order. This is the epic's
   gate row 22.

2. `"the document states every row of the evidence table"` — iterate a local literal of the ten
   `[kind, driver, class]` triples and assert `doc.includes(kind)`, `doc.includes(driver)` and that
   the kind and its class appear within one table row, by asserting the substring
   `` `<kind>` | `<driver>` | `<class>` `` after squashing. This is what makes a row dropped from the
   document fail, which a per-sentence assertion does not. It is the pair to Story 6
   (`06-the-evidence-union-and-the-classifiers`) case 1, which asserts the same ten rows in code.

3. `"the document states no wired path"` — assert
   `!doc.includes("end-attempt")`, `!doc.includes("attempt.show")`,
   `!doc.includes("node.report")` and `!doc.includes("src/commands/")`. **The control is
   `assert.ok(doc.includes("classifyInternal"))` and
   `assert.ok(doc.includes("ambiguous_used"))`**, which prove the assertion reads a document that
   holds names at all. A negative-only proof without that control passes over an empty file. This is
   the epic's gate row 22.

4. `"state-machine.md states the limit counts semantic terminations"` — update
   `src/http/contract/proposal-amendment-outcome.test.ts:20` — `spendClause` to the new paragraph and
   assert `stateMachine.includes(spendClause)`, keep the shipped negative at
   `src/http/contract/proposal-amendment-outcome.test.ts:115`, and add
   `!stateMachine.includes("Every closed attempt spends a try, whatever its outcome.")`. Rename the
   `it` at `src/http/contract/proposal-amendment-outcome.test.ts:111` accordingly. The two negatives
   are what stop the superseded sentence returning.

5. `"attempt.md prose states the semantic-count limit"` — update
   `src/http/contract/proposal-amendment-outcome.test.ts:121`, asserting the new sentence and the
   negative `!attempt.includes("with any non-null \`outcome\` moves the task to \`blocked\`")`.

5a. `"the attempt.md example paragraph counts terminations and not rejections"` — the oracle for
section 3's **second** replacement, which case 5 does not cover: assert
`!attempt.includes("A third rejection here would reach")` and assert the replacement sentence by
`includes`, written verbatim in section 3. Without this sub-case the example paragraph can be left
contradicting the rule the same file now states three paragraphs above it.

5b. `"the attempt.md SQL fence is unchanged"` — call `proposalStatements("attempt")` at
`test/helpers/proposal.ts:8` and assert its first element deep-equals the literal the shipped
`src/services/storage/migration-0007-external-execution.test.ts:1159` assertion compares. This is
the control that the prose edits did not reach the fence, and it is the case that fails first if a
later author repairs the fence debt without moving that assertion.

6. `"shippedEpics holds 054 and stays a prefix of authoredEpics"` — append `"054"` to
   `scripts/epic-sequence-range.ts:20` — `shippedEpics` and to
   `test/sequence/conformance.test.ts:274` — `shippedEpics`, then assert
   `assert.deepEqual(authoredEpics.slice(0, shippedEpics.length), shippedEpics)` and that
   `shippedEpics.at(-1)` is `"054"`. This is the epic's gate row 23.

7. `"the range gate accepts this epic"` — run `node scripts/verify-epic-sequence.ts` as a
   **build check** and assert it exits 0. There is no assertion to write beyond the exit code:
   `scripts/verify-epic-sequence.test.ts` asserts the gate over the real tree, and this case states
   that this epic's nine story files satisfy it. This is the epic's gate row 23.

8. `"no story of this epic declares a diagram"` — add the case to
   `test/sequence/conformance.test.ts`, beside
   `test/sequence/conformance.test.ts:254` — `shippedEpics is a prefix of authoredEpics`, which is
   where the range data already lives. Assert that no file under
   `.agents/plan/stories/054-attempt-classification-and-the-supervisor/` holds the string
   `Diagrams:`, `Baselines:` or `Seams:`, and that none holds a `sequenceDiagram` fence. The control
   is one file of an epic that does draw — read
   `.agents/plan/stories/053.1-the-review-checkpoint/02-a-review-claim-is-admitted.md` and assert it
   **does** hold `Diagrams:`. This is what makes the epic's "draws no diagram" claim a check rather
   than a sentence, and it is why `shippedEpics` can take `"054"` with no scenario file.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/http/contract/proposal-amendment-attempts-and-classification.test.ts`
in `PASS EPIC-054`.
