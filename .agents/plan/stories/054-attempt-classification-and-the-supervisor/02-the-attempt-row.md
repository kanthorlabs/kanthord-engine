# Story 2 — The attempt row

Epic: `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md`
Depends on: Story 6 (`06-the-evidence-union-and-the-classifiers`), for `terminations`; Story 1
(`01-migration-16`), for the two named CHECKs each refine mirrors.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.

Every path it edits is allowed to one engineer lane by `scripts/lane-check.sh`, so it declares no
`Executor:` and no `Paths:` line.

**Three fields join `attemptRow` and one joins `nodeRow`, not four in one place.** The epic's story
list writes "`attemptRow` with the four fields"; `node.ambiguous_used` is a `node` column, and
`src/domain/rows.ts:26` — `attempt` and `src/domain/rows.ts:35` — `node` map one schema per table.

**`attemptRow` has no runtime parser, and this story does not add one.**
`src/services/execution/sqlite.ts:80` — `toAttemptRecord` hand-maps raw columns and calls no zod
schema, and the three importers of `attemptRow` are `src/domain/rows.ts:3`,
`src/domain/attempt.test.ts:4` and `src/services/storage/migration-0007-external-execution.test.ts:4`.
The schema is the stated relational contract that
`src/services/storage/schema-parity.test.ts:90` — `Object.keys(rows)` keys the table set off. Adding a
parse call is a separate decision and is not taken here.

## Change

### 1 — `src/domain/attempt.ts` — three fields and one refine

**Add three fields to `src/domain/attempt.ts:17`** — `attemptRow`, after
`src/domain/attempt.ts:29` — `endedAt`, in the column order Story 1 (`01-migration-16`) writes:

```ts
    termination: z.enum(terminations).nullable(),
    caller: z.string().nullable(),
    subject: workerId.nullable(),
```

**Add one refine**, after `src/domain/attempt.ts:46` — the closing brace of the driver refine, with
the message copied verbatim from the CHECK expression, per the convention
`src/domain/attempt.ts:43` — `message` sets and
`src/domain/attempt.test.ts:146` — `message equals the DDL CHECK expression` asserts:

```ts
  .refine(
    (row) =>
      row.termination === null ||
      (row.outcome !== null && row.outcome !== "accepted"),
    {
      message:
        "termination IS NULL OR (outcome IS NOT NULL AND outcome <> 'accepted')",
    },
  );
```

**The value CHECK becomes the enum, and not a second refine.** The epic's story list writes "one
refine per CHECK". `attempt_termination_value` states a closed value set, which is what
`z.enum(terminations)` is; a refine over `z.string()` would restate it and would put the vocabulary in
two places. `attempt_termination_outcome` states a relation between two columns, which no field type
expresses, so it is the one refine.

**`caller` is `z.string().nullable()` and not `identity("actor")`.** The epic's Decisions name three
successive values for it: the actor id today, the grant id from EPIC 055, the supervisor id from
EPIC 110. `identity("actor")` would make the row schema refuse the grant id that epic writes, and
`src/domain/identity.ts:3` — `identityKinds` holds no `grant` kind yet. A widening later is a change
to this line; a narrowing now is a refusal with a shipped producer.

**`subject` is `workerId.nullable()`.** The epic's Decisions state `subject` is `run.worker`, and
`src/domain/run.ts:20` — `worker` already types that column as `workerId`. Copying the type is what
keeps a subject the row cannot hold from parsing. Import it from
`src/domain/worker-id.ts:5` — `workerId`, the same import `src/domain/node.ts:10` — `workerId` makes.

**Import `terminations` from `./termination.ts`.** `src/domain/attempt.ts:1` — `zod` already imports
`z`; the new import joins `src/domain/attempt.ts:5` — `runDrivers`.

### 2 — `src/domain/node.ts` — one field

**Add one field to `src/domain/node.ts:12`** — `nodeRow`, after
`src/domain/node.ts:30` — `verifyJson`:

```ts
    ambiguousUsed: z.int().min(0).nullable(),
```

**It carries `.min(0)` and no `.max()`.** The column is only ever written by the `COALESCE`
increment Story 4 (`04-the-node-ambiguous-counter`) adds, so a negative value is unreachable and
stating it is what makes a hand-written row that carries one fail the schema. No upper bound exists:
`ambiguousBudget` bounds the conversion, never the counter.

**Add no refine.** Story 1 (`01-migration-16`) adds no CHECK on `ambiguous_used`, and a refine with
no CHECK behind it makes the row schema stricter than the database, which is the direction that hides
a real row.

## Constraints

- The three `attempt` fields are declared in the column order of the migration, so the schema reads
  as the table does.
- The refine message is byte-identical to the CHECK expression inside
  `CONSTRAINT attempt_termination_outcome`. `src/domain/attempt.test.ts:146` — `message equals the DDL CHECK expression` is the shipped precedent for asserting that, and case 3 extends it.
- `attemptRow` stays a `z.object`, not a `z.strictObject`. Every row schema of
  `src/domain/rows.ts:23` — `rows` is a `z.object`, and tightening one here would diverge from
  twenty-one siblings for no stated reason.
- Do not touch `src/domain/attempt.ts:7` — `attemptOutcomes`. The epic's non-goals fix the five
  outcomes.

## Verify

```
node --test src/domain/attempt.test.ts src/domain/node.test.ts src/domain/rows.test.ts
```

Extend `src/domain/attempt.test.ts`, whose suite is at `src/domain/attempt.test.ts:9` — `describe` and
whose two fixtures are `src/domain/attempt.test.ts:10` — `validRow` and
`src/domain/attempt.test.ts:24` — `validExternalRow`. **Both fixtures take the three new keys as
`null`**, which the `rejects missing required keys` sweep at
`src/domain/attempt.test.ts:37` — `rejects missing required keys` then covers for free: it deletes
each key of `validRow` in turn, so the three new keys join that sweep with no new code. Extend
`src/domain/node.test.ts`'s valid fixture the same way with `ambiguousUsed: null`.

Add, each as a separate `it`:

1. `"a closed non-accepted attempt carries each of the three terminations"` — three sub-cases, each
   parsing `{ ...validRow, outcome: "failed", endedAt: AT, termination: t }` for `t` in
   `terminations`, asserting `success` is `true`. A fourth sub-case parses the same row with
   `termination: "flaky"` and asserts `success` is `false` with the issue path `["termination"]`.
   This is the epic's gate row 5.

2. `"an accepted attempt carrying a termination is refused"` — `safeParse` of
   `{ ...validRow, outcome: "accepted", endedAt: AT, termination: "semantic" }` returns
   `success: false`. The control is the same row with `termination: null`, which parses, and a second
   control is `{ ...validRow, outcome: "cancelled", endedAt: AT, termination: null }`, which parses —
   a cancelled attempt with no termination is admitted, which is what proves the refine is not a
   null-equivalence rule. This is the epic's gate row 5.

3. `"an open attempt carrying a termination is refused, and the message equals the DDL CHECK"` —
   `safeParse` of `{ ...validRow, outcome: null, termination: "ambiguous" }` returns
   `success: false`, and the first issue message equals
   `"termination IS NULL OR (outcome IS NOT NULL AND outcome <> 'accepted')"` by value. This is the
   pair to `src/services/storage/migration-0016-termination.test.ts` case 4, and it is what keeps the
   schema and the CHECK from drifting. This is the epic's gate row 5.

4. `"caller admits an id of any identity kind and subject admits only a worker id"` — four sub-cases.
   `{ ...validRow, caller: "actor_" + ULID_A }` parses; `{ ...validRow, caller: "grant_h_01m1" }`
   parses, which is the case that keeps EPIC 055's grant id from needing a schema change;
   `{ ...validRow, subject: "claude@1" }` parses; `{ ...validRow, subject: "claude" }` returns
   `success: false` with the issue path `["subject"]`, because
   `src/domain/worker-id.ts:3` — `WORKER_ID_PATTERN` requires the `@<version>` suffix.

5. `"nodeRow admits a null and a non-negative ambiguous counter and refuses a negative one"` — three
   sub-cases over the file's valid node fixture: `ambiguousUsed: null` parses, `ambiguousUsed: 0`
   parses, `ambiguousUsed: 2` parses, and `ambiguousUsed: -1` returns `success: false` with the issue
   path `["ambiguousUsed"]`. A fifth sub-case passes `ambiguousUsed: 1.5` and asserts
   `success: false`.

6. `"the rows map still holds twenty-two tables"` — assert `Object.keys(rows).length` by value in
   `src/domain/rows.test.ts`, unchanged. This is the control that this story adds columns and no
   table, and it is what keeps `src/services/storage/schema-parity.test.ts:90` —
   `Object.keys(rows)` green.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/attempt.test.ts` in `PASS EPIC-054`.
