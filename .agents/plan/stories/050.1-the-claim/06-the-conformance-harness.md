# Story 6 — The conformance harness

Epic: `.agents/plan/epics/050.1-the-claim.md`
Depends on: nothing in this epic. Stories 2 to 5 need it to run their scenarios.
Kind: story-foundation

This story builds the machine that compares a drawn diagram with a real trace. It draws no path.

## Change

**Create `test/helpers/sequence-conformance.ts`**, exporting two functions.

```ts
export function recordSeams<T extends object>(
  dependencies: T,
  aliases: Readonly<Record<string, string>>,
  sets?: Readonly<Record<string, readonly string[]>>,
): Readonly<{ dependencies: T; tokens: readonly string[] }>;

export function assertConformance(
  input: Readonly<{
    story: string;
    diagram: string;
    recorder: Readonly<{ tokens: readonly string[] }>;
    result: unknown;
  }>,
): void;
```

`recordSeams` returns the same dependency object behind a recording proxy plus the ordered token
list. The proxy observes exactly one thing: a call on an injected capability. A pure-domain call is
invisible at that seam, so it never becomes a token.

**The projection table lives in this file, once.** It is data, not a per-test literal:

| method                                                                    | projection                                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `plan.setNodeState`                                                       | `input.id`, `input.trigger`                                                            |
| `plan.setNodeAssignment`, `execution.openRun`                             | the node id                                                                            |
| `execution.runById`, `renewRun`, `endRun`, `openAttempt`, `attemptsOfRun` | the run id                                                                             |
| `execution.closeAttempt`                                                  | the attempt id                                                                         |
| `execution.activeRunsOfNodes`                                             | the name of the declared `sets` entry whose members equal the passed node ids          |
| `lease.read`, `acquire`, `renew`, `release`                               | `input.subjectId`                                                                      |
| `events.append`                                                           | `input.type`, `input.subjectId`, and `input.payload.reason` when the payload holds one |

A node id, run id or attempt id renders through the `aliases` map, so a token holds `T` and never a
ULID. A method with no projection admits one call per diagram.

`execution.activeRunsOfNodes` takes `(transaction, nodeIds)` and carries no name, because a set name
is plan topology and the execution capability owns runs. The scenario declares the sets it expects,
and the projection matches the passed ids against them. A label therefore proves the ids, not the
caller's wording. The projection refuses a set it cannot name and a set that matches two names.

**A projection refuses a field the input does not hold.** A missing field becomes an error naming the
method and the field, never the token `undefined`. A stringified miss turns a signature mismatch into
a label mismatch and hides the cause.

`assertConformance` parses the named diagram out of the named story file, derives the terminal from
`result`, and compares the drawn list with the recorded list by `deepStrictEqual`. A scenario passes
no expected terminal, so the story holds one copy of that expectation.

**The parser refuses**, each by value: an unknown diagram id; a participant outside the recorded
dependency keys; a message that is not `<n> <key>.<method>` or `<n> <key>.<method>:<label>`; a
non-dense ordinal sequence; two steps carrying one token; two terminals; no terminal and no note; a
`note over Command` that is not `tail pinned by EPIC <nnn> <diagram-id>`; the words `loop` or `opt`;
and a `<key>.call` message or a `:#<n>` discriminator in a diagram whose id does not start with
`baseline-`.

`.agents/plan/authoring.md` is the specification this file implements. Where the two disagree,
that document wins and this file is the defect.

## Constraints

- The harness imports no production module beyond types. It wraps whatever object a scenario passes.
- The projection table appears once. A scenario that needs a new projection edits this file.
- The comparison is `deepStrictEqual` over two arrays. It is never a subset check, a length check or a set comparison.
- The terminal is derived from the real result. Never accept one as an argument.

## Verify

```
node --test test/helpers/sequence-conformance.test.ts
```

Create `test/helpers/sequence-conformance.test.ts`. Assert every parser refusal by value, one case
each, for all ten refusals above. Then assert the comparison itself:

1. `"a recorded list with one extra step fails"`.
2. `"a recorded list with one missing step fails"`.
3. `"two adjacent steps swapped fail"`.
4. `"one differing label fails"`.

Without all four the comparison could be a subset check and still pass.

5. `"an exact list passes"` — the control case.
6. `"a pure-domain call produces no token"` — call a plain function inside the recorded block and assert the token list is unchanged.
7. `"a nested command bound to unrecorded dependencies is one token"`.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `test/helpers/sequence-conformance.test.ts` in `PASS EPIC-050.1`.
