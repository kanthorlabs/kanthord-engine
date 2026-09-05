# Story 3 — A declared command fails

Epic: `.agents/plan/epics/051.2-the-command-gate.md`
Depends on: Story 2 (`02-no-declared-command-runs`) for the module and this epic's `authoredEpics`
entry, and Story 1 (`01-one-declared-command-runs`) for the loop this story adds a predicate to.
It appends `"051.2"` to `shippedEpics`, which makes both diagrams of the epic due at once, so it runs
last of the three.
Kind: story-foundation

This story adds the outcome predicate, its refusal and the failure precedence, and it appends this
epic to `shippedEpics`.

**It draws nothing, and the epic's `## Sequence` states why.** An earlier draft of this epic named a
third diagram, `run-commands-refusal-command-failed`. It would have held the token set of
`run-commands-success-one` in the same order, differing only in its terminal, and
`.agents/plan/authoring.md` refuses that four ways: draw a path only when its seam set or its seam
order differs from a path already drawn; a branch that changes a value and not the call set is not a
diagram; a story that inserts a refusal draws the path that still succeeds, because that is the path
whose order changed; and a diagram does not prove a refusal code. On a passing check this story's
trace is byte-identical to Story 1's, so it changes no drawn path — which is the definition of
`story-foundation` — and the refusal, its two named values, its short-circuit, the removal on the
failing path and the precedence are all proven by the cases below.

## Change

### 1 — the refusal

**`src/commands/checkpoint/run-declared-commands.ts` — add the error class above the dependency
type.**

```ts
export type RunDeclaredCommandsRefusal = "command-failed";

export class RunDeclaredCommandsError extends Error {
  readonly refusal: RunDeclaredCommandsRefusal;
  readonly details: Readonly<{ commandIndex: number; command: string }>;

  constructor(
    refusal: RunDeclaredCommandsRefusal,
    message: string,
    details: Readonly<{ commandIndex: number; command: string }>,
  ) {
    super(message);
    this.name = "RunDeclaredCommandsError";
    this.refusal = refusal;
    this.details = details;
  }
}
```

The shape is `src/commands/node/claim-node.ts:126` — `refusal` with a typed `details` instead of a
`Readonly<Record<string, unknown>>`, because the epic requires both values to be asserted by value
and `test/helpers/sequence-conformance.ts:305` — `refusal` reads the field the class name does not
constrain. `commandIndex` and `command` are both carried because a worker that sees only
`command-failed` cannot tell which of its declared commands failed.

**Do not add the code to `src/http/contract/errors.ts`, to `src/cli/exit-code.ts` or to any
operation's `errors` record.** `commands.run` has no route in this epic. EPIC 051.4's contract story
adds all six refusal codes of the family at once; its stories are not authored, so no stem of it
resolves yet.

### 2 — the predicate and the precedence

Replace the loop body of Story 1 (`01-one-declared-command-runs`), taking the index from
`entries()`:

```ts
for (const [index, command] of input.commands.entries()) {
  const targetDir = await dependencies.git.checkout({
    gitDir: input.gitDir,
    oid: input.oid,
  });
  let output: CheckOutput | undefined;
  let checkFailure: unknown;
  try {
    output = await dependencies.verify.run({
      command: ["/bin/sh", "-c", command],
      cwd: targetDir,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      signal: null,
    });
  } catch (error) {
    checkFailure = error;
  }
  let removalFailure: unknown;
  try {
    await dependencies.git.removeWorktree({ gitDir: input.gitDir, targetDir });
  } catch (error) {
    removalFailure = error;
  }
  if (checkFailure !== undefined) throw checkFailure;
  if (output !== undefined && output.result !== "passed") {
    throw new RunDeclaredCommandsError(
      "command-failed",
      `declared command ${index} failed`,
      { commandIndex: index, command },
    );
  }
  if (removalFailure !== undefined) throw removalFailure;
}
```

Add `CheckOutput` to the type-only import from `src/services/verify/index.ts`.

**The `try`/`finally` of Story 1 is replaced, because a `finally` cannot express the precedence the
epic declares.** A `finally` propagates its own exception, discards the one it wrapped, and skips
every statement after the block, so a refusal placed either inside or after it is masked by a
`git.removeWorktree` that throws. The two calls therefore each get their own `try`, and the order of
the three checks at the end is the epic's precedence: a `verify.run` throw wins, because the check
produced no verdict; then `command-failed`, because the command's verdict is the fact the worker
asked for; then a removal failure, which surfaces only when the check passed. The removal is
attempted on every path, and it still runs at the ordinal Story 1's diagram draws. The `for` loop is
unchanged apart from `entries()`, so the refusal ends the pass with every later command unrun.

**Every non-passing outcome refuses `command-failed`, and the mapping is total.** `CheckOutcome` at
`.agents/plan/epics/107-verify-service.md:28` is
`"passed" | "failed" | "error" | "timed-out" | "cancelled"`, and `!== "passed"` covers all four
non-passing members plus every `errorReason` the same line declares — including the `error` with
`errorReason` **null** that `.agents/plan/epics/107-verify-service.md:31` produces for exit `126` and
`127`, which a reason-based split would leave undefined.

**The predicate reads `result`, never `exitCode`.**
`.agents/plan/epics/107-verify-service.md:31` states that `result` is explicit and never inferred
from `exit_code`, and maps an `exited` outcome with code `0` to `passed` and every other code to
`failed`, so `passed` holds for exactly the zero exit the epic's decision names, while `exitCode` is
null for every non-exit outcome.

**Do not translate a daemon fault into a throw, and do not add a second refusal code.** EPIC 107
returns every attempted check as a `CheckOutput`, and whether such a fault is retried or consumes the
worker's attempt belongs to EPIC 051.4 and to EPIC 054. The epic's `## Non-goals` names the owner.
The refusal message names the index and the command and never the outcome name, so no captured
output and no environment value reaches it.

### 3 — the sequence range names this epic as shipped

**`scripts/epic-sequence-range.ts` — append `"051.2"` to `shippedEpics`.** The list is at
`scripts/epic-sequence-range.ts:9` — `shippedEpics`. Append the one element and change no existing
element. `authoredEpics` already holds `"051.2"` from Story 2
(`02-no-declared-command-runs`).

**`shippedEpics` is a prefix of `authoredEpics`, so every epic of the range before this one must
already have appended itself.** `test/sequence/conformance.test.ts:264` — `slice` asserts the prefix.
EPIC 050.1 Story 7 (`07-the-conformance-runner`) states the rule: the last story of each epic of the
range appends that epic's own id. This epic follows EPIC 050.2 to EPIC 050.5, EPIC 050.6, EPIC 051
and EPIC 051.1 by sequence order, so each has landed its own entry before this story dispatches.
**Report a `shippedEpics` list that is not a contiguous prefix as a defect of the epic that skipped
its append**, and do not backfill another epic's entry from here.

**`test/sequence/conformance.test.ts` — extend the shipped half of the range assertion.** The array
literal at `test/sequence/conformance.test.ts:263` — `shippedEpics` gains `"051.2"` as its last
element, leaving every existing element unchanged.

### 4 — the runner awaits an asynchronous scenario

**`test/sequence/conformance.test.ts:279` — `scenario` calls the scenario and does not await it.**
Every scenario of the range so far is a synchronous command; the two scenarios of this epic are
asynchronous, so `scenario()` returns a `Promise` and destructuring `recorder` and `result` from it
yields `undefined`. Change the call to `await scenario()`, and change the cast at
`test/sequence/conformance.test.ts:275` — `scenarioModule` so its return type admits a `Promise`.
The enclosing `it` at `test/sequence/conformance.test.ts:267` — `async` is already asynchronous, and
`await` on a non-promise is a no-op, so every shipped scenario is unaffected.

**EPIC 051.1 Story 4 (`04-the-candidate-ref-is-deleted`) already carries this edit**, at
`.agents/plan/stories/051.1-the-candidate-and-the-git-primitives/04-the-candidate-ref-is-deleted.md:85`
— `scenario`, because `discard-candidate` is asynchronous too and that epic reaches the line first.
**Verify before editing, and apply nothing if the line already reads `await scenario()`** — case 8
below is then already green. Report a divergence rather than re-applying.

## Constraints

- Keep the two `try` blocks and the three ordered checks. A `finally` cannot express the precedence, and one `try` around both calls loses the distinction between a check that produced no verdict and a check that produced a failing one.
- Attempt the removal on every path, including the one that refuses. Gate row 13 is what asserts it.
- Throw, do not return a verdict. Every other refusing command under `src/commands/` throws a typed error, and `test/helpers/sequence-conformance.ts:305` — `refusal` reads the thrown field.
- Do not catch the error outside the loop. The pass ends at the first non-passing check.
- Read `output.result` and nothing else of the `CheckOutput`. No exit code, no output blob and no timing reaches the refusal.
- Add no second refusal code, and convert no returned outcome into a bare throw.
- Append to `shippedEpics` only. `authoredEpics` is Story 2's.
- Declare no `Diagrams:`, `Baselines:` or `Seams:` line, and add no scenario file. This story draws nothing.
- Change only the two lines of `test/sequence/conformance.test.ts` this story names, plus the shipped half of the range literal. The runner's discovery, its refusals and its fixture cases are EPIC 050.1 Story 7's (`07-the-conformance-runner`). Cases 8 and 9 therefore reach the comparison through `recordSeams` and `assertConformance`, the only two exports of `test/helpers/sequence-conformance.ts`, and never through a runner internal.

## Verify

```
node --test src/commands/checkpoint/run-declared-commands.test.ts test/sequence/conformance.test.ts
```

Extend `src/commands/checkpoint/run-declared-commands.test.ts` with the `CheckoutGit` and `Verify`
doubles Story 2 (`02-no-declared-command-runs`) declares in that file and the real-`Git` fixture
Story 1 (`01-one-declared-command-runs`) adds to it. A `Verify` double returns the `CheckOutcome`,
the `exitCode` and the `errorReason` each case names, so no case depends on a real subprocess except
cases 3 and 7.

Add, each as a separate `it`:

1. `"a failing check refuses command-failed and names the index and the command"` — three declared commands `["true", "npm test", "true"]`, with the double returning `result: "failed"` and `exitCode: 1` on its second call and `result: "passed"` otherwise. Assert the thrown error is a `RunDeclaredCommandsError`, assert `error.refusal` equals `"command-failed"`, and assert `error.details` deep-equals `{ commandIndex: 1, command: "npm test" }`. The index is `1` and not `2`, so the case pins zero-based indexing.

2. `"a failure at the second command of a list of three leaves the third unrun"` — the fixture of case 1. Assert the `Verify` double's `run` call count is `2`, and assert the recorded argv values deep-equal `[["/bin/sh", "-c", "true"], ["/bin/sh", "-c", "npm test"]]`. The count is the epic's assertion; the ordered argv is what proves it stopped at the second and not at the first.

3. `"a passing command is not refused"` — the control for case 1, with the real `Git` and the real `SupervisedVerify` over `["true"]`. Assert `runDeclaredCommands` resolves and throws nothing. Without it, case 1 passes for a unit that refuses every command.

4. `"every non-passing outcome of the check contract refuses command-failed"` — iterate a table over the whole non-passing space of `CheckOutcome` and its declared `errorReason` values, one `CheckOutput` per row, each over the single declared command `"sleep 1"`: `failed` with `exitCode: 1`; `timed-out` with `exitCode: null`; `cancelled` with `exitCode: null`; `error` with `errorReason: "not-started"`; `error` with `errorReason: "pid-file-failed"`; `error` with `errorReason: "orphaned"`; `error` with `errorReason: "output-exceeded"`; `error` with `errorReason: null` and `exitCode: 126`; and `error` with `errorReason: null` and `exitCode: 127`. Assert for every row that `error.refusal` equals `"command-failed"` and `error.details` deep-equals `{ commandIndex: 0, command: "sleep 1" }`. **Nine rows, because the mapping must be total**: the two `errorReason: null` rows are the exit codes `.agents/plan/epics/107-verify-service.md:31` produces for a program `/bin/sh` could not execute, and a reason-based split would leave them undefined.

5. `"command-failed outranks a failing removal, a failing removal surfaces when the check passed, and a check that threw outranks both"` — the epic's precedence, all three directions in one case, with a `CheckoutGit` double whose `removeWorktree` throws `new Error("remove failed")` throughout. With the `Verify` double returning `result: "failed"`: assert the thrown error is a `RunDeclaredCommandsError` with `refusal` of `"command-failed"`, **not** `"remove failed"`. With it returning `result: "passed"`: assert the thrown error **is** `"remove failed"`. With its `run` throwing `new Error("request-invalid")`: assert the thrown error is `"request-invalid"`. Assert in all three that the `removeWorktree` call count is `1`, so the removal was attempted every time. The second direction is the control: without it the first passes for a unit that swallows every removal error, and with it a unit that swallows none also fails.

6. `"every checkout directory is removed after the run on the failing path"` — the real `Git`, three declared commands, the `Verify` double failing on its second call. Assert `existsSync` is false for both returned paths, assert `readdirSync(paths.worktreeDirectory)` deep-equals `[]`, and assert `readdirSync(join(gitDir, "worktrees"))` deep-equals `[]` or that the directory is absent. The control: assert, inside the failing `verify.run` call, that its own directory exists and that `worktrees/` holds one entry, so the absence assertions are proven to detect a present directory.

7. `"a command beginning with an exclamation mark that exits zero is accepted, and a plain command that exits non-zero is refused"` — the real `Git` and the real `SupervisedVerify`, in one case: `["true", "! false"]` resolves, and `["! true"]` refuses `command-failed` with `details` deep-equal to `{ commandIndex: 0, command: "! true" }`. Both halves together prove one rule applied to both spellings, which is the epic's gate row 8b, and which Story 1 case 8 (`01-one-declared-command-runs`) cannot prove because that story applies no rule.

8. `"each of the two scenarios of this epic replays its diagram by equality"` — for `run-commands-success-one` and `run-commands-success-none`, `await import` the scenario module, `await` its default export, and call `assertConformance({ story, diagram, recorder, result })` with `assertConformance` imported from `test/helpers/sequence-conformance.ts`. Assert neither throws. Only `recordSeams` and `assertConformance` are exported from that helper — `liveDiagrams` and the runner's own cases are private to `test/sequence/conformance.test.ts` — so this case reaches the comparison through the exported API and names the two story paths itself. The `await` on the default export is what proves the edit of section 4 landed: without it in the runner, `test/sequence/conformance.test.ts` in this story's `node --test` list fails on the same two scenarios.

9. `"the comparison fails when a step is removed or reordered"` — call `assertConformance` against `run-commands-success-one` with a hand-built recorder from `recordSeams({ git, verify })` whose token array is set to `["git.checkout", "git.removeWorktree", "verify.run"]`, then to `["git.checkout", "verify.run"]`, then to the three tokens plus a repeated `"git.checkout"`. Assert each throws. Then call it against `run-commands-success-none` with a token array of `["git.checkout"]` and assert it throws, which is the zero-step diagram's own mutation control. This is the mutation control for case 8: without it, case 8 passes for a comparison that asserts nothing.

10. `"the sequence range names EPIC 051.2 as shipped and stays a prefix"` — assert `shippedEpics.at(-1)` equals `"051.2"`, and assert `authoredEpics.slice(0, shippedEpics.length)` deep-equals `shippedEpics`. Both halves, so an append that broke the prefix fails here.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/commands/checkpoint/run-declared-commands.test.ts` and
`test/sequence/conformance.test.ts` in `PASS EPIC-051.2`.
