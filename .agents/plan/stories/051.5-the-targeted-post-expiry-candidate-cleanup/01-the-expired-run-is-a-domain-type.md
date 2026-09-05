# Story 1 — `ExpiredRun` is a domain type

Epic: `.agents/plan/epics/051.5-the-targeted-post-expiry-candidate-cleanup.md`
Depends on: Story 10 (`10-the-conformance-harness-admits-an-incremental-supersession`), which puts
`"051.5"` in `authoredEpics`; EPIC 051.1 Story 2 (`02-the-candidate-ref-is-missing`), which creates
`src/domain/candidate-ref.ts`.
Kind: story-foundation

## Change

**`src/domain/run.ts` — declare `ExpiredRun`.** Append after
`src/domain/run.ts:53` — `RunBaseRow`:

```ts
export type ExpiredRun = Readonly<{
  runId: string;
  nodeId: string;
  fence: number;
}>;
```

It is a plain `Readonly<>` and **not** a zod schema. Every other export of this file is a table row
or its inferred type, and `src/domain/run.ts:48` — `runBaseRow` already covers `run_base`.
`ExpiredRun` is the projection one command returns and one service method returns; nothing parses it
from outside the process, so it needs no parser. `src/domain/run.ts` imports `zod` and four sibling
domain modules today, and this addition imports nothing.

### `src/commands/run/expire-runs.ts` — delete the declaration and import the type

Delete `src/commands/run/expire-runs.ts:6` — `ExpiredRun` and its three following lines. Add
`import type { ExpiredRun } from "../../domain/run.ts";` beside the two existing type imports.

`src/commands/run/expire-runs.ts:12` — `ExecutionExpiry` **stays**, unchanged. It is the command's own
structural narrowing of the one method it calls, and it now names the domain type. `ExpireRunsInput`
at `src/commands/run/expire-runs.ts:4` — `ExpireRunsInput` also stays.

### `src/services/execution/index.ts` — delete `ExpireDueRun`

Delete `src/services/execution/index.ts:54` — `ExpireDueRun` and its four following lines. Widen
`src/services/execution/index.ts:2` — `RunDriver` to
`import type { ExpiredRun, RunDriver } from "../../domain/run.ts";`. Change
`src/services/execution/index.ts:100` — `ExpireDueRun` to `): readonly ExpiredRun[];`.

`src/services/execution/index.ts:52` — `ExpireDueRunsInput` **stays and does not move.** The epic
deletes one name, not two, and the input type is named by seven sites this story otherwise does not
touch.

### `src/services/execution/sqlite.ts` — repoint the implementation

Remove `type ExpireDueRun,` at `src/services/execution/sqlite.ts:12` — `ExpireDueRun` from the
`./index.ts` import block, leaving `type ExpireDueRunsInput,` at `:13` in place. Add
`import type { ExpiredRun } from "../../domain/run.ts";`. Change
`src/services/execution/sqlite.ts:143` — `ExpireDueRun` to `): readonly ExpiredRun[] {`.

The `./index.ts` import block is sorted by specifier, so removing one entry closes the gap and adds
no reordering.

### `src/commands/node/claim-node.ts` — tighten `Expiry.expireRuns`

Change `src/commands/node/claim-node.ts:79` — `unknown` to `): readonly ExpiredRun[];` and add
`import type { ExpiredRun } from "../../domain/run.ts";`. `src/commands/node/claim-node.ts:75` —
`Expiry` declared `readonly unknown[]` because `eslint.config.js:221` — `command` allows a command to
import `domain/` and a service interface and no other command, so the type was unnameable here. The
move makes it nameable.

`src/commands/node/claim-node.ts:147` — `expireRuns` still discards the return value. Story 6
(`06-the-branch-base-claim-reaps`) binds it.

### `src/domain/candidate-ref.ts` — add `candidateRunPrefix`

Add beside `CANDIDATE_REF_PREFIX`, which EPIC 051.1 Story 2 (`02-the-candidate-ref-is-missing`)
declares at
`.agents/plan/stories/051.1-the-candidate-and-the-git-primitives/02-the-candidate-ref-is-missing.md:46` —
`CANDIDATE_REF_PREFIX`:

```ts
export function candidateRunPrefix(runId: string): string {
  return `${CANDIDATE_REF_PREFIX}${runId}/`;
}
```

The trailing slash is part of the value. Without it the prefix `refs/kanthord/candidate/run_a` also
matches `refs/kanthord/candidate/run_ab/1`, and `git for-each-ref` takes the argument as a plain
prefix. It is pure and imports nothing, per `eslint.config.js:310` — `no-restricted-imports`.

### the three test-lane repoints

- `src/commands/run/expire-runs.test.ts:7` — `ExpiredRun` moves out of the `./expire-runs.ts` import
  into `import type { ExpiredRun } from "../../domain/run.ts";`.
  `src/commands/run/expire-runs.test.ts:28` — `RecordingExecution` keeps its shape.
- `test/sequence/scenarios/expiry-pass-one-due.ts:6` — `ExpiredRun` moves the same way, to
  `../../../src/domain/run.ts`. `test/sequence/scenarios/expiry-pass-one-due.ts:50` — `ExpiredRun` is
  unchanged.
- `test/helpers/execution.ts:10` — `ExpireDueRun` is removed from the `execution/index.ts` import
  block; `test/helpers/execution.ts:1` — `RunDriver` widens to
  `import type { ExpiredRun, RunDriver } from "../../src/domain/run.ts";`;
  `test/helpers/execution.ts:50` — `ExpireDueRun` and
  `test/helpers/execution.ts:292` — `ExpireDueRun` both become `): readonly ExpiredRun[] {`.
  `ExpireDueRunsInput` at `:11`, `:49` and `:291` stays.

`src/main.ts` names neither type: it binds `Expiry` structurally, so it needs no edit. `seedExpiredRun`
in `src/commands/run/expire-runs.test.ts` holds `ExpiredRun` as a substring and is **not** a consumer;
a substring rename would break nine call sites.

## Constraints

- Delete `ExpireDueRun`. Do not keep a re-export of it from `src/services/execution/index.ts`; a
  second name for one type is what this story removes.
- Do not move, rename or unify `ExpireDueRunsInput` or `ExpireRunsInput`. Three names for
  `Readonly<{ now: number }>` is a separate defect, and this epic does not own it.
- Do not add a zod schema for `ExpiredRun`, and do not register it in `src/domain/rows.ts`. It is no
  table row.
- Do not change the runtime behaviour of `expireDueRuns` or `expireRuns`. Every assertion of
  `src/commands/run/expire-runs.test.ts` compares literal objects and must still pass byte-for-byte.
- Do not widen `ExpireRunsDependencies`. It names no `Git` and gains none here.

## Verify

```
node --test src/domain/run.test.ts src/domain/candidate-ref.test.ts src/commands/run/expire-runs.test.ts
```

Extend `src/domain/run.test.ts`, suite `"src/domain/run.test"`, and
`src/domain/candidate-ref.test.ts`, suite `"src/domain/candidate-ref.test"`, which EPIC 051.1 Story 2
(`02-the-candidate-ref-is-missing`) creates. The source-scan idiom is
`src/domain/layout.test.ts:3` — `fs` with `matchAll`; the type-level idiom is
`src/http/contract/errors.test.ts:312` — `ts-expect-error`.

Add, each as a separate `it`:

1. `"ExpiredRun is declared in the domain and nowhere else"` — in `src/domain/run.test.ts`, read
   `src/domain/run.ts`, `src/commands/run/expire-runs.ts`, `src/services/execution/index.ts`,
   `src/services/execution/sqlite.ts` and `src/commands/node/claim-node.ts` with
   `fs.readFileSync`, and assert `/^export type ExpiredRun =/m` matches in `src/domain/run.ts` and in
   none of the other four, and that `/^export type ExpireDueRun =/m` matches in none of the five. The
   domain match is the control: without it both absences pass for a type nobody declares.

2. `"Expiry.expireRuns declares readonly ExpiredRun[]"` — in `src/domain/run.test.ts`, write

   ```ts
   const expiry: Expiry = {
     // @ts-expect-error expireRuns must return ExpiredRun, not unknown
     expireRuns: () => [] as readonly unknown[],
   };
   ```

   importing `Expiry` from `../commands/node/claim-node.ts`, and assert
   `expiry.expireRuns !== undefined`. The `@ts-expect-error` fails `pnpm run typecheck` if the return
   type is still `readonly unknown[]`, so the type is the oracle and the runtime assertion only keeps
   the binding used.

3. `"candidateRunPrefix renders the run namespace byte-exactly"` — in
   `src/domain/candidate-ref.test.ts`, assert `candidateRunPrefix("run_a")` equals
   `"refs/kanthord/candidate/run_a/"`.

4. `"candidateRunPrefix is a prefix of the attempt ref"` — assert
   `candidateRef({ runId: "run_a", attemptNo: 1 }).startsWith(candidateRunPrefix("run_a"))` is `true`,
   and that `candidateRef({ runId: "run_ab", attemptNo: 1 }).startsWith(candidateRunPrefix("run_a"))`
   is `false`. The second assertion is the control for the trailing slash; without it the first passes
   for a prefix with none.

5. `"the eight repoints type check and the expiry pass is unchanged"` — the build check. Run
   `pnpm run typecheck` and assert it exits 0, then run
   `node --test src/commands/run/expire-runs.test.ts` and assert every existing case passes with no
   edit to an assertion. This is the case that proves the move touched no behaviour; the epic's Gates
   run the same two commands over the whole tree.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/run.test.ts`, `src/domain/candidate-ref.test.ts` and
`src/commands/run/expire-runs.test.ts` in `PASS EPIC-051.5`.
