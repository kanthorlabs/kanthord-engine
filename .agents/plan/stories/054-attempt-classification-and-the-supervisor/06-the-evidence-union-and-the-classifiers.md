# Story 6 — The evidence union, the classifiers and the conversion

Epic: `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md`
Depends on: Story 1 (`01-migration-16`), for the `"054"` entry in `authoredEpics` and for the
`attempt_termination_value` CHECK this story asserts against `terminations`.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.

Every path it edits is allowed to one engineer lane by `scripts/lane-check.sh`, so it declares no
`Executor:` and no `Paths:` line.

**It dispatches second, and that inverts the epic's story list.** `terminations` is the vocabulary
Story 2 (`02-the-attempt-row`) puts in `attemptRow`, Story 3
(`03-the-close-writes-the-termination`) puts in `CloseAttemptInput` and Story 7
(`07-accounting-by-class`) puts in `AttemptRecord`. A story that declared the enum inline and waited
for this one would ship the vocabulary twice, and the second copy would be the one a reviewer had to
notice. EPIC 053.1 Story 9 (`09-the-contract-the-cli-and-the-proposal`) inverts its own epic's list
for the same class of reason.

**The union is plain TypeScript, not zod.** The epic's Decisions settle that the trust boundary is
the transport schema: `src/http/contract/outcome.ts:23` — `nodeReportRequest` is a
`z.discriminatedUnion` of `z.strictObject` members and declares no `termination` key, so no evidence
value is ever parsed from a request body. The daemon constructs every value from its own facts, and a
zod schema would add a parse with no producer. `terminations` is the one exported array, because
Story 2 needs it inside `z.enum(...)`.

## Change

### 1 — `src/domain/termination.ts` — the vocabulary and the union

**Create `src/domain/termination.ts`.** Its only import is nothing: it names no zod schema and no
other domain module.

```ts
export const terminations = [
  "semantic",
  "infrastructure",
  "ambiguous",
] as const;
export type Termination = (typeof terminations)[number];

export type TerminationEvidence =
  | Readonly<{ kind: "daemon-rejected"; refusal: string }>
  | Readonly<{ kind: "worker-reported-failure" }>
  | Readonly<{ kind: "operator-handoff" }>
  | Readonly<{
      kind: "provider-quota";
      providerId: string;
      responseHash: string;
    }>
  | Readonly<{ kind: "contended" }>
  | Readonly<{ kind: "human-cancellation" }>
  | Readonly<{ kind: "worker-released" }>
  | Readonly<{ kind: "ancestor-ended"; ancestorRunId: string }>
  | Readonly<{ kind: "run-expired" }>
  | Readonly<{ kind: "process-exit" }>;

export type TerminationEvidenceKind = TerminationEvidence["kind"];

export const internalEvidenceKinds = [
  "daemon-rejected",
  "worker-reported-failure",
  "operator-handoff",
  "provider-quota",
  "contended",
  "worker-released",
  "ancestor-ended",
  "run-expired",
  "process-exit",
] as const;

export const externalEvidenceKinds = [
  "daemon-rejected",
  "worker-reported-failure",
  "operator-handoff",
  "contended",
  "human-cancellation",
  "worker-released",
  "ancestor-ended",
  "run-expired",
] as const;

export type InternalEvidence = Extract<
  TerminationEvidence,
  { kind: (typeof internalEvidenceKinds)[number] }
>;
export type ExternalEvidence = Extract<
  TerminationEvidence,
  { kind: (typeof externalEvidenceKinds)[number] }
>;
```

**`terminations` is ordered `semantic`, `infrastructure`, `ambiguous`**, matching the literal order of
the `attempt_termination_value` CHECK Story 1 (`01-migration-16`) writes.
`test/helpers/schema.ts:26` — `assertClauseAgrees` compares the extracted literal list to the domain
array with `deepEqual`, so the order is load-bearing and not cosmetic.

**Two kinds carry a payload and eight do not.** `provider-quota` carries `providerId` and
`responseHash`, the value the epic's Decisions require of a provider-signed response; `ancestor-ended`
carries `ancestorRunId`. A boolean in place of either would be a flag any caller could set.

**`internalEvidenceKinds` and `externalEvidenceKinds` are exported arrays, not derived types alone.**
The totality cases iterate them at run time, so an eleventh kind added to `TerminationEvidence` and
not to a list fails a case rather than compiling silently. `Extract` is what keeps the two subsets
from drifting from the union.

### 2 — `src/domain/termination.ts` — the two classifiers

**Add `classifyInternal` and `classifyExternal` to `src/domain/termination.ts`.** Each is a total
`switch` over its own kind set, with no `default` arm, so `tsc` refuses an unhandled kind:

```ts
export function classifyInternal(evidence: InternalEvidence): Termination {
  switch (evidence.kind) {
    case "daemon-rejected":
    case "worker-reported-failure":
      return "semantic";
    case "operator-handoff":
    case "provider-quota":
    case "contended":
    case "worker-released":
    case "ancestor-ended":
      return "infrastructure";
    case "run-expired":
    case "process-exit":
      return "ambiguous";
  }
}

export function classifyExternal(evidence: ExternalEvidence): Termination {
  switch (evidence.kind) {
    case "daemon-rejected":
    case "worker-reported-failure":
      return "semantic";
    case "operator-handoff":
    case "contended":
    case "human-cancellation":
    case "worker-released":
    case "ancestor-ended":
      return "infrastructure";
    case "run-expired":
      return "ambiguous";
  }
}
```

**Two functions, not one with a driver parameter.** `docs/workflow/worker.md:465` — `supervisor`
states an internal worker has a supervisor that classifies from observed termination, and
`docs/workflow/worker.md:467` — `no supervisor` states the daemon classifies for an external
worker. One function taking a driver would let `process-exit` reach an external run, which has no
supervisor to observe it, and `provider-quota` reach an external run, whose provider response the
daemon's own transport never received.

**`run-expired` is in both lists, and that is not a hole in the split.** `src/services/execution/sqlite.ts:146` — `WHERE state = 'active' AND expires_at <= ?` carries no driver predicate, so the
daemon's own clock ends a run of either driver and both classifiers must accept the kind. **It is not
`process-exit`'s external twin**: `process-exit` names a termination the supervisor observed, and an
expiry is the case where the daemon observed nothing at all. The two are different facts that share
one class.

**No `default` arm, and no `never` assertion.** An unhandled kind is a `tsc` error on the return type
of the function, which `pnpm run build` catches. A `default` that threw would move that failure to run
time and would make case 2's iteration the only detector.

### 3 — `src/domain/termination.ts` — the conversion

**Add `convertOnExhaustion` to `src/domain/termination.ts`:**

```ts
export function convertOnExhaustion(
  input: Readonly<{
    termination: Termination;
    ambiguousUsed: number;
    ambiguousBudget: number;
  }>,
): Termination {
  if (input.termination !== "ambiguous") return input.termination;
  return input.ambiguousUsed >= input.ambiguousBudget
    ? "semantic"
    : "ambiguous";
}
```

**The boundary is `>=` and the converted class is `semantic`.** With `ambiguousBudget = 0` the first
ambiguous termination converts, which is the value the epic's Decisions state and case 6 asserts.

**It converts to `semantic` and never to `infrastructure`.** An exhausted crash-loop budget is what
must stop the loop, and `infrastructure` consumes no attempt, so converting there would leave the
loop unbounded.

**It takes the budget as an argument and reads no configuration.** `src/domain/` is pure, and Story 9
(`09-the-budget-and-the-supervisor`) is what puts `ambiguousBudget` in `Settings`.

**It validates neither number.** `ambiguousBudget` is refused at startup by Story 9, and
`ambiguousUsed` comes from a column Story 4 (`04-the-node-ambiguous-counter`) only ever increments.
A second guard here would be a refusal with no reachable input.

### 4 — `src/services/storage/schema-parity.test.ts` — the CHECK agrees with the array

**Add one case to `src/services/storage/schema-parity.test.ts`**, beside
`src/services/storage/schema-parity.test.ts:53` — `nodeKinds`, using
`test/helpers/schema.ts:26` — `assertClauseAgrees`. This is the story that owns it: the assertion ties
the DDL literal list to `terminations`, and `terminations` does not exist until this story.
`src/services/storage/migration-0016-termination.test.ts` asserts the CHECK by refusal; this asserts
it by vocabulary, and neither replaces the other.

`test/helpers/schema.ts:17` — `pattern` reads `\btermination\s+IN\s*\(`, which skips both
`attempt_termination_value` — no word boundary after `_` — and `termination IS NULL`, and matches the
`termination IN` of the CHECK. The named constraint therefore needs no change to the helper.

## Constraints

- `src/domain/termination.ts` imports nothing. `eslint.config.js:311` — `domain/ is pure` admits
  `zod` and nothing else, and this module needs not even that.
- Neither classifier throws. A kind outside its own subset is a compile error, not a refusal.
- `convertOnExhaustion` never returns `infrastructure`, and never converts a non-`ambiguous` input.
- The two subsets overlap on seven kinds, and that is the design. `worker-released` is `both` because
  `src/http/contract/capability.ts:10` — `node.release` puts the release in the worker capability set,
  so an external harness reaches it under actor authentication today.
- Add no `terminationEvidence` zod schema. A schema with no parse site is dead code, and the strict
  transport object is what refuses a supplied evidence value.

## Verify

```
node --test src/domain/termination.test.ts src/services/storage/schema-parity.test.ts
```

Add `src/domain/termination.test.ts`, in the style of
`src/domain/attempt.test.ts:9` — `describe`, whose suite name is the module path. The type-level case
follows the shipped convention at `src/services/plan/sqlite.test.ts:92` — `@ts-expect-error`: a
module-scope declaration carrying the comment, plus an `it` that reads one property off it so the
declaration is exercised and `tsc` fails when the error disappears.

Add, each as a separate `it`:

1. `"every evidence kind classifies to its stated class"` — a declared table of ten
   `[kind, driver, class]` triples written as a literal in the test, iterated, each asserting
   `classifyInternal` or `classifyExternal` returns the stated class **by value**. The ten rows are
   `daemon-rejected`/both/`semantic`, `worker-reported-failure`/both/`semantic`,
   `operator-handoff`/both/`infrastructure`, `provider-quota`/internal/`infrastructure`,
   `contended`/both/`infrastructure`, `human-cancellation`/external/`infrastructure`,
   `worker-released`/both/`infrastructure`, `ancestor-ended`/both/`infrastructure`,
   `run-expired`/both/`ambiguous`, `process-exit`/internal/`ambiguous`. A `both` row is asserted
   through both classifiers, so with seven `both` rows and three single-driver rows the case makes
   seventeen assertions. This is the epic's gate row 11.

2. `"each classifier is total over its own kind list"` — iterate `internalEvidenceKinds` and assert
   `classifyInternal` returns a member of `terminations` for each, then the same for
   `externalEvidenceKinds` and `classifyExternal`. Assert `internalEvidenceKinds.length` is `9` and
   `externalEvidenceKinds.length` is `8` by value, assert the **intersection** of the two sets has
   size `7` by value, and assert the union has size `10` by value. An eleventh kind added to
   `TerminationEvidence` and not to a list fails the union assertion; added to a list and not to a
   `switch` it fails `tsc`. **The intersection assertion is not redundant**: a kind moved from one
   list to the other leaves both lengths and the union unchanged, and only the overlap count detects
   it. This is the epic's gate row 11.

3. `"a worker claim of quota exhaustion and a provider-signed quota response classify differently"` —
   in one case, `classifyInternal({ kind: "worker-reported-failure" })` is `"semantic"` and
   `classifyInternal({ kind: "provider-quota", providerId: PROVIDER, responseHash: HASH })` is
   `"infrastructure"`. One case, so the distinction cannot be lost by deleting a case. This is the
   epic's gate row 12.

4. `"a voluntary release and a cascade close each classify infrastructure"` — in one case,
   `classifyExternal({ kind: "worker-released" })` and
   `classifyInternal({ kind: "ancestor-ended", ancestorRunId: RUN })` are both `"infrastructure"`.
   The control is `classifyExternal({ kind: "run-expired" })`, which is `"ambiguous"`: an ancestor
   expiry does not propagate its own class to the descendant it closes. This is the epic's gate
   row 12.

5. `"an external evidence kind is not assignable to classifyInternal"` — the module-scope
   declaration is
   `// @ts-expect-error human-cancellation is not an InternalEvidence kind` followed by
   `const humanToInternal = classifyInternal({ kind: "human-cancellation" });`. A second and third
   pair state the reverse for `provider-quota` and `process-exit` against `classifyExternal`.
   The `it` asserts each of the three bindings is a member of `terminations`, so the declarations are
   exercised and `pnpm run build` fails when a widened signature makes the expected error vanish.
   **`run-expired` carries no such pair**, because it is a `both` kind and both classifiers accept it;
   the three single-driver kinds are the whole set this case can state. This is the epic's gate row 13.

6. `"convertOnExhaustion converts at and above the budget and not below"` — six sub-cases, each
   asserting the returned value by name: `{ ambiguous, used: 1, budget: 2 }` is `"ambiguous"`,
   `{ ambiguous, used: 2, budget: 2 }` is `"semantic"`, `{ ambiguous, used: 3, budget: 2 }` is
   `"semantic"`, `{ ambiguous, used: 0, budget: 0 }` is `"semantic"`,
   `{ semantic, used: 5, budget: 2 }` is `"semantic"` and
   `{ infrastructure, used: 5, budget: 2 }` is `"infrastructure"`. The last two are the control that
   the function converts only an ambiguous input. This is the epic's gate row 14.

7. `"the attempt termination CHECK holds exactly the three terminations in order"` — add the case to
   `src/services/storage/schema-parity.test.ts`, calling
   `assertClauseAgrees(storage, "attempt", "termination", terminations)` over a fully migrated
   database built by the file's own `buildMigrated` at
   `src/services/storage/schema-parity.test.ts:25`. The control is a fourth value added to
   `terminations` in a local copy, which `assertClauseAgrees`' length assertion must reject.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/termination.test.ts` in `PASS EPIC-054`.
