# Story 2 — The authority seams

Epic: `.agents/plan/epics/050.2-the-run-renew-release-and-report.md`
Depends on: EPIC 050 Story 3 (`runRow`).
Kind: story-foundation

Two seam names the diagrams of Stories 3 to 6 draw do not exist yet. This story declares them and
implements them. It draws no path: declaring an interface moves no call.

## Change

**`src/services/execution/index.ts`** gains two methods:

```ts
runById(transaction: Transaction, runId: string): RunRecord | null;

renewRun(
  transaction: Transaction,
  input: Readonly<{ runId: string; expiresAt: number }>,
): RunRecord;
```

`assertRunAuthority` is pure, so the run row is read at the seam. **`runById` returns an ended run
rather than null**, because the authority function refuses it with `run-ended` and a null would
collapse that code into `run-not-found`. `activeRunOfNode` answers a different question — one node,
its active run — and cannot answer this one.

`renewRun` writes `UPDATE run SET expires_at = ? WHERE id = ?` and touches no other column. The
`min(now + runTtlMs, max_lifetime_at)` arithmetic belongs to the command, and the write belongs here,
because SQL lives in the execution implementation.

## Constraints

- `renewRun` never writes `fence`, `state`, `ended_at` or `outcome`. The fence rises when a run ends.
- Both methods take the caller's `transaction` as the first parameter. Neither opens one.
- `runById` filters on `id` alone. It applies no state and no expiry predicate.

## Verify

```
node --test src/services/execution/sqlite.test.ts
```

Add, each as a separate `it`:

1. `"runById returns an ended run rather than null"` — seed `state: 'ended'` and assert the record is returned.
2. `"runById returns null for an unknown id"`.
3. `"runById returns an expired run that is still active"` — the expiry pass is the caller's, not this read's filter.
4. `"renewRun writes expires_at and leaves fence unchanged"` — seed `fence: 3`, assert the new `expires_at` and `fence === 3`.
5. `"renewRun touches no other column"` — snapshot the row before and after and assert only `expires_at` differs.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/execution/sqlite.test.ts` in `PASS EPIC-050.2`.
