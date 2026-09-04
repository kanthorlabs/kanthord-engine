# Story 5 — The closure is asserted

Epic: `.agents/plan/epics/054.4-the-run-lifecycle-pays-its-attempt.md`
Depends on: Stories 1 to 4, for the four paths whose closes this story counts; EPIC 054.1 Story 1 (`01-a-semantic-ending-and-an-accepted-one`), for the one command that is left; EPIC 054.2 Story 7 (`07-the-accepted-land-closes-through-the-command`) and EPIC 054.3 Stories 4 and 5, for the three accepted arms this story's control reads; EPIC 051.1 Story 4 (`04-the-candidate-ref-is-deleted`), for `candidate.discard` and `git.deleteRef`.
Kind: story-foundation

This story writes no production code and draws nothing. It adds the two closure cases and the discard-absence cases, and every one of them is an assertion over code Stories 1 to 4 and the earlier epics of the family already wrote.

## Change

**Edit `src/services/execution/sqlite.test.ts` — add the caller closure and the one-event closure of `execution.closeAttempt`.** This file is where the closure belongs: `src/services/execution/sqlite.ts:294` — `UPDATE attempt SET outcome` is the one writer of `attempt.outcome`, so the set to close is every caller of the method that runs it, and the file already reads its own source at `src/services/execution/sqlite.test.ts:760` — `readFileSync`.

### 1 — the caller iteration

Walk `src/` and collect every production file whose text holds a call on `execution.closeAttempt`, then assert the set equals exactly `["src/commands/attempt/end-attempt.ts"]`.

`src/koa-absence.test.ts:8` — `collectRepoRelativePaths` is the shipped tree walk to copy, and `src/koa-absence.test.ts:34` — `collectOffenders` is the shipped per-line scan. Copy the shape rather than a helper: that file's walk is private to it and this story adds no shared helper.

**Three exclusions, and each is stated rather than discovered.** Exclude `*.test.ts`, because a test may call the seam directly to build a fixture and `src/commands/node/claim-node.test.ts:2094` — `closeAttempt` already does. Exclude `src/services/execution/`, because the interface declaration at `src/services/execution/index.ts:111` — `closeAttempt` and the implementation at `src/services/execution/sqlite.ts:287` — `closeAttempt` are the method itself and not callers of it. Exclude nothing else — in particular do not exclude `src/main.ts`, because a close wired at the composition root is exactly the escape this case exists to catch.

**Match the identifier, not the dotted call.** Match `/\bcloseAttempt\b/`. A regex anchored on `.closeAttempt(` sees only the dotted form and misses a destructured call — `const { closeAttempt } = dependencies.execution;` followed by `closeAttempt(transaction, …)` — and misses a bracket call, `execution["closeAttempt"](…)`. Both reach the one writer, so both are callers this case must catch. **The identifier match over-matches on purpose**: a comment or a type-only reference in a production file fails the case, and the repair is to delete the mention, which is cheaper than a caller the assertion cannot see.

**A caller a later epic adds fails this case rather than shipping with no class and no event.** EPIC 056's switch and EPIC 110's cancellation each reach `end-attempt` and never the seam, so neither changes this count of one; the epic's amendments state that, and this case is what makes the statement falsifiable.

### 2 — the one-event closure

Assert that `endAttempt` appends exactly one `attempt.ended` for every outcome it can close, and that an accepted close carries a null termination.

**The reduction is what makes this tractable, and it is stated.** Case 1 proves `end-attempt` is the only caller of `execution.closeAttempt`, and `src/services/execution/sqlite.ts:294` — `UPDATE attempt SET outcome` is the only writer of the column. "Every close appends exactly one `attempt.ended`" is therefore a property of `endAttempt` alone, and case 2 asserts it over the union of outcomes rather than over a list of call sites a reader has to keep complete. The six paths of this epic each assert their own event count in their own story — Story 1 case 5, Story 2 cases 1 and 4, Story 3 cases 1 and 2, Story 4 case 1 — and the three accepted arms are proven by EPIC 054.2 Story 7 (`07-the-accepted-land-closes-through-the-command`) and EPIC 054.3 Stories 4 and 5, whose test files the epic's Proof does not name.

### 3 — the discard absence, one case per path

**Edit `src/commands/run/expire-runs.test.ts`**, **edit `src/commands/node/release-node.test.ts`** and **edit `src/commands/startup/recover-expired-runs.test.ts`** — add the discard-absence case of each path. Assert that no path of this epic reaches `candidate.discard` or `git.deleteRef`, and that the candidate ref of a run each path ended is still present afterwards. All three files are in the epic's Proof.

`candidate.sweep` removes those refs at startup, which EPIC 051.1 Story 5 (`05-the-candidate-namespace-has-a-reaper`) proves. This story asserts the absence, never the eventual removal.

## Constraints

- Write no production code. Every case of this story is an assertion over code Stories 1 to 4 and the earlier epics wrote.
- Add no shared test helper. Copy the tree-walk shape of `src/koa-absence.test.ts:8` — `collectRepoRelativePaths` into the one file that needs it.
- Case 1's expected set is a literal array of one path, asserted by `assert.deepEqual`. A count assertion would pass on the wrong single caller.
- Do not exclude `src/main.ts` from case 1's walk.
- Assert `candidate.discard` and `git.deleteRef` by **call count on a double**, not by a source scan. A source scan cannot see a callable the composition root injected.
- Add no case that asserts a startup cascade close. Story 4 states why the internal pass reaches none, and Story 3 case 2 owns the sweep's cascade.

## Verify

```
node --test src/services/execution/sqlite.test.ts src/commands/run/expire-runs.test.ts src/commands/node/release-node.test.ts src/commands/startup/recover-expired-runs.test.ts
```

Extend `src/services/execution/sqlite.test.ts`, suite at `src/services/execution/sqlite.test.ts:152` — `describe`, whose fixture is `test/helpers/database.ts:32` — `createMigratedStorage` and whose id generator is `test/helpers/ids.ts` — `createMockIdGenerator`. Cases 3 to 8 extend the three command suites named in the command above, whose fixtures are `src/commands/run/expire-runs.test.ts:48` — `seedExpiredRun`, `src/commands/node/release-node.test.ts:80` — `createFixture`, and the suite EPIC 050.5 Story 1 adds under `src/commands/startup/recover-expired-runs.test.ts`.

Add, each as a separate `it`:

1. `"the production callers of execution.closeAttempt are exactly src/commands/attempt/end-attempt.ts"` — walk `src/` recursively, drop every path ending `.test.ts` and every path under `src/services/execution/`, read each remaining file, collect the relative path of every file whose text matches `/\.closeAttempt\s*\(/`, sort bytewise through `src/http/server/bytewise.ts` — `compareBytewise`, and `assert.deepEqual` the result to `["src/commands/attempt/end-attempt.ts"]`. Gate row 11.

2. `"a source scan that misses a caller fails this assertion"` — the control for case 1. Run the same collector over a temporary directory holding one file whose text is `dependencies.execution.closeAttempt(transaction, {});` and assert the collector returns that file. `.agents/plan/authoring.md:317` — `a control case proving the assertion detects a nearby forbidden case` requires it, because case 1's only oracle is the absence of a second path.

3. `"endAttempt appends exactly one attempt.ended for every non-accepted outcome"` — one case, four sub-assertions. For each of `"rejected"`, `"failed"`, `"timed-out"` and `"cancelled"`, seed a run with one open attempt, call the real `endAttempt` with the non-accepted member, and assert exactly one `attempt.ended` event exists for that attempt id, its `subjectKind` is `"attempt"`, its `subjectId` is the attempt id, and the attempt row's `termination` is non-null. Gate row 12, non-accepted half.

4. `"an accepted close appends exactly one attempt.ended and carries a null termination"` — seed a run with one open attempt, call the real `endAttempt` with the accepted member and a `headOid`, and assert exactly one `attempt.ended` event exists, its payload holds `headOid` and holds neither `termination` nor `evidence`, and the attempt row's `outcome` is `"accepted"` and its `termination` is **null**. **This is the control that the event and the class are separate facts**: case 3 writes a class with the event, and this case writes the event with no class. Gate row 12, accepted half and control.

5. `"a settlement over an attempt endAttempt already closed appends nothing"` — call the real `endAttempt` twice over the same attempt id. Assert exactly one `attempt.ended` event exists after the second call, and that `databaseBytes(fixture.storage)` after the second call deep-equals the capture taken after the first. Case 3 is the control that one call does append.

6. `"the expiry pass reaches no candidate discard and no git ref deletion"` — in `src/commands/run/expire-runs.test.ts`, seed one past-due run with a candidate row and its ref present, pass a `candidate` double and a `git` double, run the pass, and assert both doubles recorded exactly `0` calls and the ref is still present. Gate row 13, path 1.

7. `"neither release arm reaches a candidate discard or a git ref deletion"` — in `src/commands/node/release-node.test.ts`, two sub-assertions in one case. Release a task whose own run holds a candidate ref, and release an objective with two active child runs each holding one, and assert after each that `candidate.discard` and `git.deleteRef` recorded `0` calls and every ref is still present. Gate row 13, paths 2 and 3.

8. `"neither recovery path reaches a candidate discard or a git ref deletion"` — in `src/commands/startup/recover-expired-runs.test.ts`, two sub-assertions in one case. Run the external sweep over an expired external objective run with two child runs, and run the pass over an internal candidate, each with candidate refs present, and assert after each that `candidate.discard` and `git.deleteRef` recorded `0` calls and every ref is still present. Gate row 13, paths 4, 5 and 6.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/execution/sqlite.test.ts`, `src/commands/run/expire-runs.test.ts`, `src/commands/node/release-node.test.ts` and `src/commands/startup/recover-expired-runs.test.ts` in `PASS EPIC-054.4`.
