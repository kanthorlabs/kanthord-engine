# EPIC 054 — Attempt classification and the supervisor — stories

Epic: `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md`
Prereq: EPIC 053.1 (sequence order). Story 1 (`01-migration-16`) inserts `"054"` after its `"053.1"`
entry in `authoredEpics`, and Story 10 (`10-the-proposal-records-classification`) appends `"054"` to
`shippedEpics` behind its append. Story 1 also needs migration versions `13` to `15`, which the
051, 052 and 053 families own: `src/services/storage/migrations.ts:15` — `migrations` tops out at
version `12` in the tree today, and a version added out of ship order applies in a different order on
an upgraded database than on a fresh one.

The vocabulary of a failed attempt, and every statement that stores it. A termination is `semantic`,
`infrastructure` or `ambiguous`; two total classifiers decide it from a closed evidence union; an
exhausted ambiguous budget converts the class at classification time; the attempt limit counts
semantic terminations; and `caller` and `subject` are derived from authenticated state and from the
run row.

## One story, one path

**No story of this epic carries a diagram, and every story is a `story-foundation`.** The epic's
`## Sequence` states it and this expansion confirms it against the recorder, on three checks a
reviewer can repeat:

- `test/helpers/sequence-conformance.ts:60` — `execution.openAttempt` projects `input.runId` alone
  and `test/helpers/sequence-conformance.ts:64` — `execution.closeAttempt` projects
  `input.attemptId` alone, so the input fields Story 3 (`03-the-close-writes-the-termination`) and
  Story 5 (`05-the-open-records-caller-and-subject`) add change no token of any drawn path.
- `accountAttempts` is a pure-domain call, so Story 7 (`07-accounting-by-class`) moves no message even
  though it edits two commands. `test/helpers/sequence-conformance.ts:72` — `events.append` projects
  `type`, `subjectId` and `payload.reason`, and never `payload.attemptsRemaining`.
- Story 5 adds **no read**. `src/commands/node/claim-node.ts:107` — `actorId` is already an input
  member and `src/commands/node/claim-node.ts:387` — `openRun` already returns the `RunRecord` whose
  `worker` becomes the subject, both in scope at the call site. A story that had to read the run row
  would have added a seam call and would have needed a pair.

A fourth check closes the one gap in that argument. `accountAttempts` being unrecorded does not by
itself prove its callers' traces are unchanged: `exhausted` selects the `blocked` branch of
`src/commands/node/release-node.ts:134` — `attempt-limit`, and a branch change moves seam calls. So
the check is over the **due** scenarios, not over the function: `scripts/epic-sequence-range.ts:21` —
`shippedEpics` is `["050", "050.1"]`, `test/sequence/conformance.test.ts:83` — `shipped` scopes
`liveDiagrams` to it, and `test/sequence/scenarios/` holds exactly four files —
`claim-success-task.ts`, `claim-success-initiative.ts`, `claim-refusal-objective-busy.ts` and
`expiry-pass-one-due.ts`. None drives `releaseNode` or `reportOutcome`, and none reads `exhausted`:
`claim-success-task.ts:105` — `attemptLimit` passes the limit into a claim, and
`src/services/execution/sqlite.ts:266` — `accountAttempts` reads `nextAttemptNo` from it and never
`exhausted`. **No due trace can move**, and a story of EPIC 054.2 or 054.4 that later makes a
release or report path due draws its own pair.

The two members Story 4 (`04-the-node-ambiguous-counter`) adds to `PlanStore` are drawn for the first
time by EPIC 054.1, which is the epic that calls them.

## Dispatch order

`1 → 6 → 2 → 3 → 4 → 5 → 7 → 9 → 10`

- **1 first.** It creates the four columns every later story writes or reads, and its `authoredEpics`
  entry is what makes this epic's stories visible to `scripts/verify-epic-sequence.ts`.
- **6 second, and this inverts the epic's story list.** `src/domain/termination.ts` holds
  `terminations`, which Story 2 puts inside `z.enum(...)`, Story 3 puts on `CloseAttemptInput` and
  Story 7 puts on `AttemptRecord`. A story that declared the enum inline and waited for Story 6 would
  ship the vocabulary twice. Story 6 also owns the
  `assertClauseAgrees(storage, "attempt", "termination", terminations)` case, which ties the DDL
  literal list to the domain array and cannot be written before either exists.
- **2 → 3 → 4 → 5** next, each reading the vocabulary and one of Story 1's columns. 3 before 5,
  because Story 5 makes `caller` and `subject` required on `OpenAttemptInput` and therefore updates
  every `openAttempt` call site Story 3's cases added.
- **7 after 3.** Four of the eight `AttemptRecord` construction sites are inside the execution service
  and are Story 3's, so Story 7 repairs the rest against a type that already carries `termination`.
- **9 after 6.** `src/services/supervisor/index.ts` names `InternalEvidence` and `Termination` in its
  own signatures.
- **10 last**, because appending `shippedEpics` requires every earlier entry of the prefix to be
  there, and because the document it writes states what the other eight stories shipped.

No story depends on a later one.

## Stories

- 1 — migration `16`, the four columns, the two named CHECKs and the `authoredEpics` entry →
  `01-migration-16.md` — draws nothing
- 2 — `attemptRow` takes three fields and one refine, `nodeRow` takes the counter →
  `02-the-attempt-row.md` — draws nothing
- 3 — the close writes the outcome and the termination in one statement →
  `03-the-close-writes-the-termination.md` — draws nothing
- 4 — the node counter, its `COALESCE` read and its `COALESCE` increment →
  `04-the-node-ambiguous-counter.md` — draws nothing
- 5 — the attempt open records the derived caller and subject →
  `05-the-open-records-caller-and-subject.md` — draws nothing
- 6 — the evidence union, the two classifiers and the conversion →
  `06-the-evidence-union-and-the-classifiers.md` — draws nothing
- 7 — accounting by class, the eight construction sites and `attemptsRemaining` →
  `07-accounting-by-class.md` — draws nothing
- 9 — the ambiguous budget and the supervisor interface → `09-the-budget-and-the-supervisor.md` —
  draws nothing
- 10 — the proposal, the two superseded paragraphs and `shippedEpics` →
  `10-the-proposal-records-classification.md` — draws nothing

**There is no story 8, and the gap is deliberate.** The epic's eighth entry, "The `attempt.ended`
event type", moves to EPIC 054.1 — see the decisions below. The remaining files keep the epic's own
numbering, so the epic's hermetic-coverage rows 20 to 23 still name stories 9 and 10 and need no
renumbering. `scripts/verify-epic-sequence.ts:867` accepts a cross-reference that carries either the
dispatch position or the file prefix, so `Story 9 (09-the-budget-and-the-supervisor)` resolves at
dispatch position 8.

No story is a groundwork story. `scripts/lane-check.sh test-engineer <path>` or
`scripts/lane-check.sh software-engineer <path>` allows every path this epic edits — including
`scripts/epic-sequence-range.ts`, which is the software-engineer lane — so no `Paths:` line is legal
and none is written. `eslint.config.js` needs no edit either:
`eslint.config.js:18` — `src/services/plan/sqlite.ts` is already in
`eslint.config.js:17` — `nodeEdgeWriteExemptions`, and `eslint.config.js:133` — `src/services/*`
classifies a new service capability by glob.

## Facts (needed for implementation)

- **`ALTER TABLE ADD COLUMN` accepts a named CHECK, including one that names another column.**
  Verified against `node:sqlite` on the real pre-migration `attempt` shape before Story 1 was
  written: both named constraints attach, all three refusals fire by constraint name, and the table's
  indexes survive. `grep -rn "ADD COLUMN" src/services/storage/` finds nothing today only because
  every shipped schema change dropped or tightened an existing column, which `ADD COLUMN` cannot do.
- **A rebuild of `attempt` would drop a composite-key index a foreign key needs.** EPIC 051.3 Story 1
  (`01-migration-14`) creates
  `.agents/plan/stories/051.3-the-checkpoint-and-the-land/01-migration-14.md:27` —
  `attempt_id_run_id` because
  `.agents/plan/stories/051.3-the-checkpoint-and-the-land/01-migration-14.md:74` — `REFERENCES
attempt(id, run_id)` declares a composite foreign key from `checkpoint` onto it. A rename-old,
  create-new, drop-old rebuild carries that index onto `attempt_old` and drops it, and every
  `checkpoint` insert then fails on a foreign-key mismatch.
  `src/services/storage/migration-0012-run-model.ts:14` — `DROP INDEX` shows the shipped rebuild
  paying that cost for `run_one_active`. Story 1 case 7 pins the survival, so a later conversion to a
  rebuild fails a case.
- **Migration version `15` is retired, and EPIC 054's Decisions now say so.** Version `13` is
  EPIC 051 Story 1 (`01-migration-13`), `14` is EPIC 051.3 Story 1 (`01-migration-14`), `17` is
  EPIC 055 and `18` is EPIC 057; nothing declares `15`.
  `src/services/storage/sqlite.ts:181` — `validateMigrations` admits the gap, and the epic keeps `16`
  rather than renumbering, because a renumber only moves the gap to `16`. An epic that later claims
  `15` is a defect: it would apply after `16` on an upgraded database and before `16` on a fresh one.
- **The `docs/proposal/database/*.md` SQL fences are meant to be current, and two are stale.**
  `docs/proposal/database/README.md:7` — `CREATE TABLE` says every table file holds its
  `CREATE TABLE`, so a stale fence is documentation debt and not a convention:
  `docs/proposal/database/run.md:10` — `parent_run_id` still describes the pre-migration-`12` `run`
  table and `docs/proposal/database/node.md:6` is three columns behind migration `11`. Repairing the
  `attempt` fence means moving
  `src/services/storage/migration-0007-external-execution.test.ts:1159` — `proposalStatements`, which
  pins that fence against migration `7`'s own text, to the live-schema form
  `src/services/storage/migration-0009-one-branch.test.ts:271` — `proposalStatements` uses for
  `repository`. That repair is not this epic's; Story 1 states the deferral, Story 10 edits the
  **prose** of `attempt.md` only, which `test/helpers/proposal.ts:15` — `sqlFence` leaves outside the
  pin, and the debt is recorded with its repair and its trigger at
  `.agents/plan/pending/proposal-database-fences.md`.
- **`accountAttempts`' shipped `exhausted` is not a failure count.**
  `src/domain/attempt-accounting.ts:70` — `counterRecord` reads "the attempt at the highest number is
  closed and that number reaches the limit", so today every closed outcome exhausts, `accepted`
  included — `src/domain/attempt-accounting.test.ts:167` — `three accepted attempts at the limit are exhausted` pins it. All forty-two cases of that file `deepEqual` the whole result object, so every
  one moves.
- **`rejections` has no production reader.** `grep -rn --include='*.ts' rejections src test` finds
  only `src/domain/attempt-accounting.test.ts` and an unrelated local at
  `src/queries/actor/resolve-actor.test.ts:308`. Story 7 keeps it.
- **`src/domain/attempt.ts:17` — `attemptRow` has no runtime parser.**
  `src/services/execution/sqlite.ts:80` — `toAttemptRecord` hand-maps raw columns, and the three
  importers of `attemptRow` are `src/domain/rows.ts:3`, `src/domain/attempt.test.ts:4` and
  `src/services/storage/migration-0007-external-execution.test.ts:4`.
- **`test/helpers/execution.ts:217` — `Mirrors the statements of`
  states an obligation with no shared code path.** Five sites of that file mirror the execution
  service by hand: `ATTEMPT_COLUMNS` at `:136`, `toAttemptRecord` at `:191`, the plain fake's
  `closeAttempt` literal at `:98`, and `openAttempt` and `closeAttempt` of the backed fake at `:403`
  and `:439`. Its `closeAttempt` already diverges from production — it writes `head_oid`
  unconditionally — and Stories 3 and 5 leave that divergence alone.
- **`src/commands/node/claim-node.ts:191` — `caller` is not the authenticated principal.** It binds
  `src/commands/node/claim-node.ts:82` — `ClaimCallerRecord`, the **claiming worker**. The principal
  is `src/commands/node/claim-node.ts:107` — `actorId`, set by
  `src/http/server/node/claim-node.ts:31` — `actorId: context.actor.id`. The two names collide and the
  values are different things.
- **`claimNode` opens external runs only.** `src/services/execution/sqlite.ts:273` — `'external'` is
  hardcoded in the attempt insert and
  `src/services/execution/sqlite.test.ts:742` — `an external attempt under an internal run is refused`
  pins the composite foreign key. The epic's gate row 9 asks for "an internal and an external run";
  that pair is unreachable, and Story 5 case 2 states the substitute.
- **`eventTypes` is bytewise sorted and every declared type must have a producer.**
  `src/domain/event-type.test.ts:7` — `eventTypes is sorted bytewise` and
  `src/http/contract/event-payload.test.ts:430` — `every declared type except the retired ones is produced`, which scans `src/commands` and `src/services` for the literal. This is why the
  `attempt.ended` registration cannot land in this epic.
- **The event payload catalogue count is pinned twice at `39`.**
  `src/http/contract/openapi-source.test.ts:363` and `scripts/publish-contract.source.test.ts:217`
  both assert it by value, and the `it` name at
  `src/http/contract/openapi-source.test.ts:348` spells "thirty-nine". Whichever epic registers
  `attempt.ended` moves all three.
- **`src/domain/layout.test.ts:108` hard-codes the twenty-two service directories.** A new capability
  directory fails that `deepEqual`, and `src/domain/layout.test.ts:152` hard-codes the four
  capabilities that must hold a `not-implemented.ts`. Story 9 moves both, and neither file is in the
  epic's Proof block.
- **`src/services/config/convict.test.ts:104` — `Settings key order` asserts the key order of the
  returned settings object by value.** Story 9 inserts `ambiguousBudget` after `attemptLimit` and
  moves that literal.
- **An integer config refusal is `config-invalid`, not `config-refused`.** Every convict format
  failure is rethrown at `src/services/config/convict.ts:400` — `config-invalid`, and
  `src/services/config/refusals.ts:29` — `assertStartable` holds no integer-range rule.
  `src/services/config/startup.test.ts` launches a real daemon and asserts one refusal; every
  integer-format case lives in `src/services/config/convict.test.ts`.
- **`src/services/config/convict.ts:363` — `idempotencyEnvIntegers` is a second registration every
  integer env var needs.** A var declared in the schema and absent from that list passes a
  non-numeric string through instead of failing the format.
- **`src/services/config/convict.ts:56` — `nonNegativeInteger` already exists and is already
  registered** at `src/services/config/convict.ts:356`. `ambiguousBudget` admits `0`, so it takes that
  format and not the `positiveInteger` that `attemptLimit` carries.
- **`test/helpers/schema.ts:17` — `pattern` reads `\btermination\s+IN\s*\(`.** It skips
  `attempt_termination_value` — `_` is a word character, so there is no boundary — and skips
  `termination IS NULL`, and matches the CHECK's `termination IN`. Naming the constraint therefore
  needs no change to the helper.
- **`test/helpers/rows.ts:123` — `nodeColumns` feature-detects new `node` columns with
  `PRAGMA table_info`.** `seedGraph` therefore keeps working across migration `16` with no edit, and a
  freshly seeded node carries a null `ambiguous_used`, which is the fixture Story 4 needs.
- **`test/helpers/lint.ts:7` — `lintCase` returns the rule ids a staged file triggers.** It is the
  mechanism for the epic's gate row 8 control, and
  `src/commands/startup/recover-expired-leases.test.ts` and `src/domain/layout.test.ts` are its
  shipped consumers.
- **`scripts/lane-check.sh` allows `scripts/epic-sequence-range.ts` to the software-engineer** and
  denies it to the `groundwork-engineer`, so it can never appear in a `Paths:` line.

## Decisions taken during authoring, and now recorded in the EPIC

- **`ALTER TABLE ADD COLUMN` replaces the rebuild in Story 1, and that removes two hazards rather
  than trading one for another.** The epic's Decisions say migration `16` is additive and states two
  CHECKs; a first reading took a rebuild to be forced, because SQLite adds no CHECK to an existing
  column and `src/services/storage/migration-0003-execution-and-journal.ts:63` — `REFERENCES
attempt(id)` makes `attempt` a referenced table. Both premises were wrong for this migration: a
  CHECK attaches to the **added** column and may name another column, so no rebuild is needed, no
  `PRAGMA legacy_alter_table` is needed, and `attempt_id_run_id` is never at risk. See
  `01-migration-16.md`.
- **The `attempt.ended` event type and its payload move to EPIC 054.1, and this epic holds no
  story 8.** `src/http/contract/event-payload.test.ts:430` — `every declared type except the retired ones is produced` scans `src/commands` and `src/services` for the type literal, and this epic ships
  no producer: `end-attempt.ts` is EPIC 054.1. Registering the type here would land a red
  `pnpm run verify` or would require putting a not-yet-produced type in
  `src/domain/event-type.ts:45` — `retiredEventTypes`, whose name would then be false for one epic.
  The epic's Decision at `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:103` —
  `attempt.ended` and its gate row 19 move with it, together with the two catalogue counts pinned at
  `39`. See the `## Stories` note above.

  **The move is applied in both epics, and it was larger than three source edits.** EPIC 054 drops
  its eighth story entry and its gate row 19, and states the reason in its Decisions. EPIC 054.1 takes
  the registration in Story 1 (`01-a-semantic-ending-and-an-accepted-one`) section 7, beside the
  producer that story writes; its "No schema change, and no new seam" non-goal now names the one
  exception, its Proof block gains `src/domain/event-type.test.ts`,
  `src/http/contract/event-payload.test.ts` and `src/http/contract/openapi-source.test.ts`, its gate
  gains rows 6c and 6d, and its index and its Story 1 `Depends on:` line no longer read an event
  contract from EPIC 054. **Nothing would have detected the orphan**:
  `scripts/verify-epic-sequence.ts:965` — `storyColumn` checks only that a row names exactly one
  story and never resolves that number to a story file, so a row naming story `8` would have passed
  the gate with no story 8 in the tree.

- **Gate row 9's internal-and-external pair is unreachable, and the epic now names the reachable
  pair.** A story may not silently replace an epic gate assertion, so the row was amended rather than
  substituted for: it reads "over two distinct actor-and-worker pairs" and carries the three citations
  that make the other pair impossible. See `05-the-open-records-caller-and-subject.md` case 2.
- **`attemptsRemaining` is derived from `semanticCount`, not from `counter`, and EPIC 054's
  Decisions and gate row 18a now own it.**
  `src/commands/outcome/report-outcome.ts:255` — `accounting.counter` is the highest attempt number,
  and after Story 7 the limit counts semantic terminations, so the two disagree: three infrastructure
  failures under a limit of three would answer `attemptsRemaining: 0` while the daemon kept granting
  attempts. This is a shipped response value changing. See `07-accounting-by-class.md` section 4.
- **`AttemptAccounting` keeps `counter`, `rejections` and `nextAttemptNo` and adds two counts.**
  `counter` and `nextAttemptNo` have production readers; `rejections` does not, and it stays because
  this change did not orphan it. See `07-accounting-by-class.md` section 1.
- **The two new CHECKs are named and the four shipped ones stay unnamed.** SQLite reports a named
  constraint in its message, which is what makes the epic's gate rows 2 and 3 — "refused by the named
  CHECK" — assertable by value rather than by table. See `01-migration-16.md` section 1.
- **`AttemptRecord` gains `termination` and gains neither `caller` nor `subject`, and
  `ATTEMPT_COLUMNS` gains only `termination`.** No reader in this family reads either back through the
  service, and `.agents/plan/epics/111-inspection-and-manual-controls.md:30` — `showAttempt` reads
  both from the row. Story 5's cases read the two columns with raw SQL. See
  `03-the-close-writes-the-termination.md` section 1.
- **The close writes `termination` unconditionally and keeps `headOid`'s two-branch form.** A
  termination cannot exist before the close — `attempt_termination_outcome` refuses one on an open row
  and the statement's `WHERE ... AND outcome IS NULL` guard matches only a never-closed row — so
  `input.termination ?? null` can never overwrite a stored class, and the branch count stays two
  rather than four. See `03-the-close-writes-the-termination.md` section 3.
- **The plan store gains two members and `StoredNode` gains no field.** A field on the read model
  would move `NODE_COLUMNS`, `NodeRow`, `toNode`, the `StoredNode` domain type and every fixture that
  builds one, for a value three of the four readers of `readNode` never look at. See
  `04-the-node-ambiguous-counter.md`.
- **`readNodeAmbiguousUsed` returns `number | null`.** `null` is "no node carries that id" and `0` is
  "the node carries a null or a zero counter"; collapsing the two would let an unknown node id
  classify as a fresh crash loop. See `04-the-node-ambiguous-counter.md` section 1.
- **The increment returns `void` and takes no `RETURNING` clause.** The caller of EPIC 054.1 reads the
  counter to classify before it increments, so `ambiguousUsedAfter` is that read plus one, and a
  second source of the same number would be a second seam call in that epic's diagram. See
  `04-the-node-ambiguous-counter.md` section 1.
- **`caller` is `z.string()` at the row and at the seam, and `subject` is `workerId` at the row
  only.** The epic's Decisions name three successive values for `caller` —
  actor id, grant id, supervisor id — and `src/domain/identity.ts:3` — `identityKinds` holds no
  `grant` kind. `src/services/execution/index.ts:14` — `worker` on `RunRecord` is already a plain
  `string`, so narrowing the seam would make one of the two lie. See `02-the-attempt-row.md`
  section 1.
- **The evidence union is plain TypeScript and carries no zod schema.** No value is ever parsed from
  the wire: `src/http/contract/outcome.ts:23` — `nodeReportRequest` is a `z.discriminatedUnion` of
  `z.strictObject` members that declares no `termination` key. A schema with no parse site is dead
  code. See `06-the-evidence-union-and-the-classifiers.md`.
- **Neither classifier has a `default` arm.** An unhandled kind is a `tsc` error on the return type,
  which `pnpm run build` catches; a throwing `default` would move that failure to run time. See
  `06-the-evidence-union-and-the-classifiers.md` section 2.
- **`SupervisorErrorCode` holds one code, and `WorkerHandle` carries no pid.**
  `../docs/workflow/worker.md:483` — `another machine` requires the interface to admit a remote worker
  without a signature change, and a pid is the field a remote implementation could not fill. See
  `09-the-budget-and-the-supervisor.md` section 3.
- **Story 10 supersedes two shipped paragraphs the epic does not name.**
  `docs/proposal/phase-1/state-machine.md:118` — `spends a try` and
  `docs/proposal/database/attempt.md:30` — `attempt_no = attempt_limit` both state that the limit
  counts closed attempts, and both are pinned as literals at
  `src/http/contract/proposal-amendment-outcome.test.ts:20` — `spendClause` and
  `src/http/contract/proposal-amendment-outcome.test.ts:120`. Leaving either in place ships a proposal
  that states the opposite of the code. See `10-the-proposal-records-classification.md` sections 2
  and 3.
- **The epic's citation of a section 13 is repaired.** Its nullable-column non-goal cited
  `../docs/workflow/worker.md` section 13; that document runs sections 1 to 11 and ends at
  `../docs/workflow/worker.md:721` — `## 11. Guarantees`. No section of it states a nullability rule,
  and the reason is the epic's own: migration `16` backfills nothing, so a `NOT NULL` column would
  need a value for every existing row. The non-goal now says that and cites nothing.
