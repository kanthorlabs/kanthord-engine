# EPIC 054.1 — The end-attempt command — stories

Epic: `.agents/plan/epics/054.1-the-end-attempt-command.md`
Prereq: EPIC 054 (sequence order). Story 1 (`01-a-semantic-ending-and-an-accepted-one`) reads its
`"054"` entry in `authoredEpics`, its `CloseAttemptInput.termination` and `AttemptRecord.termination`
from Story 3 (`03-the-close-writes-the-termination`), its `plan.readNodeAmbiguousUsed` from Story 4
(`04-the-node-ambiguous-counter`), its evidence union, kind arrays, classifiers and
`convertOnExhaustion` from Story 6 (`06-the-evidence-union-and-the-classifiers`), its
`accountAttempts().semanticCount` from Story 7 (`07-accounting-by-class`), its `attempt.ended` type
and payload variant from Story 8, and its `ambiguousBudget` from Story 9. Story 2
(`02-an-ambiguous-ending-increments-the-counter`) reads its `plan.incrementNodeAmbiguousUsed`.
Story 3 (`03-a-settlement-over-a-closed-attempt-writes-nothing`) reads its close, amended to answer
`null`. Story 4 (`04-the-proposal-records-the-command`) amends its
`docs/proposal/phase-2/attempts-and-classification.md`.

One command ends an attempt, in the transaction it receives. It reads the accounting and the node
counter, classifies a non-accepted ending from the driver on the attempt row, converts an exhausted
ambiguous class, closes, charges an ambiguous ending and appends one `attempt.ended`. A settlement
over an attempt another operation already closed writes nothing and appends nothing.

## One story, one path

Three of the four stories carry a diagram. Story 4 is a `story-foundation` and draws nothing.

**Every prior set in this epic is empty, so this epic draws no `baseline-` diagram and every token of
every diagram is `+`.** `src/commands/attempt/end-attempt.ts` does not exist, and no directory
`src/commands/attempt/` exists at all, so there is nothing to draw a `baseline-` diagram of. **No
story of this epic supersedes a diagram**, so this epic writes no `Superseded by:` line into an
earlier story and asks for none.

| story | diagram                 | steps | terminal |
| ----- | ----------------------- | ----- | -------- |
| 1     | `end-attempt-semantic`  | 4     | `ok`     |
| 2     | `end-attempt-ambiguous` | 5     | `ok`     |
| 3     | `end-attempt-settled`   | 3     | `ok`     |

**Each diagram differs from `end-attempt-semantic` by the tokens one story adds or drops.** The
ambiguous path adds `plan.incrementNodeAmbiguousUsed` between the close and the append — one token.
The settled path drops `events.append:attempt.ended:A` — one token — and never reaches the charge, so
it differs from `end-attempt-ambiguous` by **two** tokens and from `end-attempt-semantic` by one.
Each difference is one story.

**Every terminal is `ok`, and no diagram of this epic is a refusal.** A no-op settlement is not a
refusal: `test/helpers/sequence-conformance.ts:303` — `resultTerminal` reads `ok` from any result that
is not an `Error` and carries no `ok: false`, and `EndAttemptResult` carries neither key.

**The drawn set is every branch of this command's product paths, and "product path" is doing work in
that sentence.** Four further paths exist and all four throw a bare `Error`: an attempt id no row of
the run carries, an attempt whose `runId` or `attemptNo` disagrees with the input, a node id no row
carries, and evidence whose kind the attempt's driver cannot produce. **Each is a precondition
violation, not a branch of the operation.** They are drawable —
`test/helpers/sequence-conformance.ts:303` — `resultTerminal` maps an `Error` with no string
`refusal` to `refuse:error` — so the omission is a decision and not a grammar limit. The decision:
a precondition violation states that a caller is wrong, its seam prefix carries no product meaning,
and every invariant breach of a shipped command throws the same way and none is drawn —
`src/commands/outcome/report-outcome.ts:218` — `throw` is the shipped form. Story 1's cases 12 and 13
carry all four. **The fourth is contested**: EPIC 054.4 reaches the driver mismatch on a product path,
and the report of this epic raises that as a blocker.

**Three arms share `end-attempt-semantic`, and none of them is a fourth diagram.** A `semantic`
ending, an `infrastructure` ending and an **accepted** ending all make the four drawn calls in the
same order and differ only in what they store and what the payload holds.
`.agents/plan/authoring.md:165` — `Draw a path only when its seam set or its seam order differs`
groups them by construction, so this is not an omission. Story 1's cases 3 and 8 store
`infrastructure`, case 1 stores `semantic`, and Story 4's case 1 replays the accepted arm against the
diagram, which is what proves the sharing rather than asserting it.

## Dispatch order

`1 → 2 → 3 → 4`

- 1 first, because it creates `src/commands/attempt/end-attempt.ts`, its two types and its result
  union, and because its `authoredEpics` entry is what makes this epic's stories visible to
  `scripts/verify-epic-sequence.ts`.
- 2 next, because it inserts one statement into the command 1 wrote, between the close and the append.
- 3 after 2, because its guard must sit above the charge 2 added. Dispatched before 2, the guard would
  land in a command with no charge to skip, and 2 would have to move it.
- 4 last, because appending `shippedEpics` makes all three diagrams due and every scenario file must
  already exist — `scripts/verify-epic-sequence.ts:759` — `owner.source` refuses a due live diagram
  whose owner does not name its scenario path, and
  `scripts/verify-epic-sequence.ts:757` — `error` refuses one with no scenario file.

No story depends on a later one.

## Stories

- 1 — the command, the semantic ending, the accepted ending and the `authoredEpics` entry →
  `01-a-semantic-ending-and-an-accepted-one.md` — draws `end-attempt-semantic`
- 2 — the ambiguous charge and the conversion cases →
  `02-an-ambiguous-ending-increments-the-counter.md` — draws `end-attempt-ambiguous`
- 3 — the no-op settlement → `03-a-settlement-over-a-closed-attempt-writes-nothing.md` — draws
  `end-attempt-settled`
- 4 — the proposal, the replay proofs and `shippedEpics` → `04-the-proposal-records-the-command.md` —
  draws nothing

No story is a groundwork story. `scripts/lane-check.sh test-engineer <path>` or
`scripts/lane-check.sh software-engineer <path>` allows every path this epic edits, including
`scripts/epic-sequence-range.ts` and `docs/proposal/phase-2/attempts-and-classification.md`, so no
`Paths:` line is legal and none is written.

## Facts (needed for implementation)

- **Nothing this epic builds on exists in `src/` yet.** `scripts/epic-sequence-range.ts:1` —
  `authoredEpics` ends at `"054"` and `shippedEpics` is `["050", "050.1"]`, so `src/commands/attempt/`, `src/domain/termination.ts`,
  `attempt.termination`, `node.ambiguous_used`, `attempt.ended` and
  `docs/proposal/phase-2/attempts-and-classification.md` are all authored-unshipped or unauthored.
  Every story states the epic and story that creates what it reads.
- **`scripts/epic-sequence-range.ts` moves while the EPIC 054 family is being authored.** Its
  `authoredEpics` held `"054.1"` at one point during this authoring and does not now, so Story 1
  asserts the end state rather than blindly inserting, and every citation into that file is
  line-anchored at `scripts/epic-sequence-range.ts:1` — `authoredEpics` where it can be.
- **EPIC 054 Stories 8, 9 and 10 are not authored, so this epic cites them by ordinal alone.**
  `scripts/verify-epic-sequence.ts:884` — `byEpic` checks a stem only when it can resolve the epic's
  story list, and inventing a stem now would plant a gate failure.
  `.agents/plan/authoring.md:420` — `an ordinal alone` grandfathers the form.
- **`execution.attemptsOfRun` and `plan.readNodeAmbiguousUsed` draw bare tokens.** Both take a bare id
  as the last argument, and `test/helpers/sequence-conformance.ts:121` — `args.at(-1)` projects only an
  object, so the entry at `test/helpers/sequence-conformance.ts:61` — `execution.attemptsOfRun` never
  fires. Each may be called once per path.
- **`plan.incrementNodeAmbiguousUsed` draws a bare token for the other reason.** It takes an object,
  so `args.at(-1)` sees one, but `test/helpers/sequence-conformance.ts:50` — `projections` holds no
  entry for the method, so `test/helpers/sequence-conformance.ts:125` — `labels` is empty. No
  projection edit is needed anywhere in this epic.
- **`events.append` projects the type then the subject, and a `reason` key would add a third label.**
  `test/helpers/sequence-conformance.ts:72` — `events.append` and
  `test/helpers/sequence-conformance.ts:81` — `reason`. The `attempt.ended` payload holds no top-level
  `reason`, so the token is `events.append:attempt.ended:A`.
- **The attempt row carries the run's driver.** `src/services/execution/index.ts:31` — `driver` on
  `AttemptRecord`, from `src/domain/attempt.ts:22` — `driver`. The command therefore selects the
  classifier from the rows step 1 already read, and needs no run read.
- **Every attempt opened today carries `driver = 'external'`.**
  `src/services/execution/sqlite.ts:273` — `external` hardcodes it in the insert, and EPIC 054 Story 5
  (`05-the-open-records-caller-and-subject`) adds `caller` and `subject` without changing it. An
  internal-driver attempt exists only where a test seeds the row, as
  `test/helpers/rows.ts:789` — `seedAttemptRow` does.
- **`InternalEvidence` and `ExternalEvidence` are `Extract` subsets that overlap on six kinds.**
  `.agents/plan/stories/054-attempt-classification-and-the-supervisor/06-the-evidence-union-and-the-classifiers.md:76`
  — `export type InternalEvidence`. A `TerminationEvidence` is assignable to neither classifier, so
  the command narrows with two module-local type predicates over the exported
  `internalEvidenceKinds` and `externalEvidenceKinds` arrays.
- **`readNodeAmbiguousUsed` returns `number | null`, and the two values differ.**
  `.agents/plan/stories/054-attempt-classification-and-the-supervisor/04-the-node-ambiguous-counter.md:32`
  — `readNodeAmbiguousUsed`. `null` is "no node carries that id"; `0` is "a null or a zero counter".
- **`attemptLimit` lives on the run row and nowhere a command can reach without a read.**
  `src/services/execution/index.ts:16` — `attemptLimit`, written from
  `src/commands/node/claim-node.ts:393` — `attemptLimit` at run open, and read by
  `src/commands/outcome/report-outcome.ts:245` — `attemptLimit` and
  `src/commands/node/release-node.ts:121` — `attemptLimit`. `Execution` declares no read by run id.
- **`config` is never a dependency key on a command.** `src/commands/node/claim-node.ts:98` —
  `attemptLimit` is a plain number, bound at `src/main.ts:570` — `attemptLimit`. `ambiguousBudget`
  follows that shape.
- **A command may not import another command, and a type-only import counts.**
  `src/domain/layout.test.ts:184` — `no file under src/commands/` resolves every relative specifier
  matching `from "…"`, so a caller receives `endAttempt` as an injected function, as
  `src/commands/outcome/report-outcome.ts:59` — `reportObjective` does.
- **A nested command takes `at` on its input and holds no `Clock`.**
  `src/commands/outcome/aggregate-initiative.ts:17` — `at` and
  `src/commands/outcome/aggregate-initiative.ts:9` — `AggregateInitiativeDependencies`, which also
  holds no `storage`.
- **A returned verdict is the shipped shape for a nested command's decision.**
  `src/commands/repository/assert-repository-accepts-work.ts:3` — `RepositoryWorkVerdict` returns a
  discriminated union from a `(transaction, input)` command and never throws, and
  `src/commands/provider/complete-provider-login.ts:77` — `replay` is the shipped name for
  _already settled, here is the prior answer_. No nested command in the tree throws a refusal class.
- **The accounting projection over an unwritten row is a shipped idiom.**
  `src/commands/node/release-node.ts:113` — `projected` and
  `src/commands/node/release-node.ts:118` — `cancelled` substitute the row the command is about to
  write, then branch on `src/commands/node/release-node.ts:123` — `exhausted`.
- **`semanticCountAfter` is `accountAttempts().semanticCount` and never `counter`.**
  `.agents/plan/stories/054-attempt-classification-and-the-supervisor/07-accounting-by-class.md:45`
  — `semanticCount: number`. `counter` is the highest attempt number and stays for
  `src/commands/outcome/report-outcome.ts:255`.
- **`authoredEpics` and `shippedEpics` are each asserted as a literal in a test.**
  `test/sequence/conformance.test.ts:255` — `authoredEpics` and
  `test/sequence/conformance.test.ts:274` — `shippedEpics`. An edit to
  `scripts/epic-sequence-range.ts` without the matching edit there fails that case, and the two files
  sit in different engineer lanes.
- **A `+` token is scoped to one diagram, not to the epic.**
  `scripts/verify-epic-sequence.ts:680` — `localDeclarations` prefers the story's own `Seams:` line for
  that diagram, so `+execution.attemptsOfRun` may be declared by all three stories, each for its own
  diagram.

- **The diagram fixes a total order over a product-required partial order, and only part of it is
  forced.** Forced: the attempts read precedes the classification, because it supplies `driver`; the
  counter read precedes the close, because the stored termination is the converted class; the close
  precedes the charge and the append, because a close answering `null` must do neither. Chosen by the
  epic: the attempts read before the counter read, and the charge before the append. Both writes sit
  in one transaction and neither is visible to any reader before commit, so no publication argument
  forces the second. The diagram pins the choice; it does not prove the code had no alternative.
- **The command validates two of its four denormalized input members and cannot validate the other
  two.** `subject.runId` and `subject.attemptNo` come free from step 1 and Story 1 asserts them.
  `input.nodeId` owning `input.runId`, and `input.attemptLimit` equalling the run's, need the run row
  this command does not read, so a valid-but-wrong value charges the wrong node's budget or publishes
  a wrong limit with no error branch. The report of this epic raises it as a blocker.

## Decisions taken during authoring, and now recorded in the EPIC

- **`at` and `attemptLimit` are members of `EndAttemptInput`.** The payload carries `attemptLimit`,
  that value lives only on the run row at `src/services/execution/index.ts:16` — `attemptLimit`,
  `Execution` declares no read by run id, and the epic's story list fixes the drawn set at four, five
  and three steps, so a run read is not drawable. Every caller already reads the run for exactly that
  field, and `src/commands/outcome/aggregate-initiative.ts:17` — `at` is the shipped nested-command
  idiom for the instant. See `01-a-semantic-ending-and-an-accepted-one.md`.
- **`execution.closeAttempt` answers `AttemptRecord | null`, and EPIC 054 Story 3
  (`03-the-close-writes-the-termination`) makes the change with its five callers.**
  `src/services/execution/sqlite.ts:305` — `row === undefined` throws today, so the zero-row result
  reaches no caller as a value, and this epic's Decision rules that the zero-row result decides the
  no-op. **That story currently states the opposite**, at
  `.agents/plan/stories/054-attempt-classification-and-the-supervisor/03-the-close-writes-the-termination.md:118`
  — `The zero-row path does not change`, so the amendment is a deletion of authored text and not an
  addition. See `03-a-settlement-over-a-closed-attempt-writes-nothing.md`.
- **The counter seams are EPIC 054 Story 4's own `readNodeAmbiguousUsed(transaction, id)` and
  `incrementNodeAmbiguousUsed(transaction, { id })`, adopted unchanged.** That story landed while this
  epic was being authored and names both, with `number | null` on the read and an input object on the
  write to match `src/services/plan/index.ts:123` — `setNodeAssignment`. This epic's diagrams take
  those tokens rather than asking for a rename, because EPIC 054 owns the seam. See
  `02-an-ambiguous-ending-increments-the-counter.md`.
- **The evidence narrowing is two module-local type predicates in the command, and EPIC 054 Story 6
  needs no amendment.** That story exports `internalEvidenceKinds` and `externalEvidenceKinds` as
  run-time arrays, which is all a predicate needs, and one command classifies, so a domain guard would
  have one caller. See `01-a-semantic-ending-and-an-accepted-one.md`.
- **A driver-and-evidence mismatch throws a bare `Error`, and it is not drawn.** It states that a
  caller supplied evidence the attempt's driver cannot produce, which is the same class of breach as
  `src/commands/outcome/report-outcome.ts:218` — `throw`. It is reachable in the product, and the
  report of this epic raises that against EPIC 054.4. See
  `01-a-semantic-ending-and-an-accepted-one.md`.
- **`EndAttemptResult` is a two-arm union discriminated on `settlement`, with `"ended"` and
  `"already-settled"`.** The `"ended"` arm carries `termination`, `semanticCountAfter`,
  `ambiguousUsedAfter` and `exhausted`, so a caller that must decide `attempt-limit` reads the count
  this command already computed rather than counting again. It carries no `ok` key and no `refusal`
  key, or `test/helpers/sequence-conformance.ts:303` — `resultTerminal` would read a refusal. See
  `03-a-settlement-over-a-closed-attempt-writes-nothing.md`.
- **Story 1 and Story 4 each also edit `test/sequence/conformance.test.ts`**, because `authoredEpics`
  and `shippedEpics` are asserted as literals there. The epic's dispatch note names only
  `scripts/epic-sequence-range.ts`. See `01-a-semantic-ending-and-an-accepted-one.md` and
  `04-the-proposal-records-the-command.md`.
- **The two `authoredEpics` and `shippedEpics` amendments, and the `closeAttempt` amendment, belong in
  the EPIC's `## Amendments this epic asks of other epics` section.**
  `.agents/plan/authoring.md:52` — `An amendment asked of another epic lives until it is applied`
  places a pending ask there, and that section of
  `.agents/plan/epics/054.1-the-end-attempt-command.md:71` — `## Amendments this epic asks of other epics`
  currently names only EPIC 056. `/author` may not edit the epic, so this file and the report carry
  the asks until a human moves them.
- **A precondition violation is not drawn, and that is a decision rather than a grammar limit.**
  `test/helpers/sequence-conformance.ts:303` — `resultTerminal` maps a bare `Error` to `refuse:error`,
  so each of the four throwing paths is drawable. They are omitted because a precondition violation
  states that a caller is wrong and its seam prefix carries no product meaning. See
  `01-a-semantic-ending-and-an-accepted-one.md`.
