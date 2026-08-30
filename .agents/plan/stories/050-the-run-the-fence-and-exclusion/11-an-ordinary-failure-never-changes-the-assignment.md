# Story 11 — An ordinary failure never changes the assignment

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Depends on: Story 8 (the claim writes `node.assignment`), Story 10 (release and report carry the authority check), Story 7 (`expireRuns`).

## Change

**No production change is expected.** Story 7 writes only the `run` table, and Story 10 states that release and report change no assignment. This story is the regression fence that pins the property.

If a test below fails, the fix is in the command that writes `node.assignment` outside a claim. Remove that write. EPIC 056 adds the only writer that changes an assignment, and it does so as one switch.

## Constraints

- Add no new production module.
- Do not add a "clear assignment" path anywhere.
- No case here exercises an operator handoff. EPIC 056 introduces it, and a handoff outside a switch is a state `worker.md` does not describe.

## Verify

```
node --test src/commands/node/claim-node.test.ts src/commands/node/release-node.test.ts src/commands/run/expire-runs.test.ts src/commands/outcome/report-outcome.test.ts
```

Add to `src/commands/run/expire-runs.test.ts`:

1. `"an expiry leaves node.assignment unchanged"` — seed a node with `assignment = 'general@1'` and an active run on it with `expires_at: NOW - 1`. Run the pass. Assert the run is `ended` with its fence raised by one, and assert `SELECT assignment FROM node WHERE id = ?` still returns `"general@1"`.

Add to `src/commands/node/release-node.test.ts`:

2. `"a release leaves node.assignment unchanged"` — claim a node so `assignment` is written, then release it. Assert the run is `ended` and `assignment` still equals the routed worker id.

Add to `src/commands/outcome/report-outcome.test.ts`:

3. `"a rejected report leaves node.assignment unchanged"` — claim, then report `rejected`. Assert `assignment` is unchanged.

4. `"a failed report leaves node.assignment unchanged"` — the same for `failed`.

Add to `src/commands/node/claim-node.test.ts`:

5. `"an unroutable claim on a different node leaves the first node's assignment unchanged"` — claim node A successfully so `A.assignment` is written; then claim node B with `available: false`, which refuses `unroutable`. Assert `A.assignment` is unchanged and `B.assignment` is still `null`.

6. `"an assignment-held refusal writes no assignment"` — seed `node.assignment = 'tdd@1'`, claim as `general@1`, assert the refusal, then assert `assignment` is still `"tdd@1"`.

7. `"a subtree-busy refusal writes no assignment"` — assert the target node's `assignment` is still `null` after the refusal.

8. `"the assignment survives a claim, an expiry and a second claim by the same worker"` — claim as `general@1`; let the run expire and run the pass; claim again as `general@1`. Assert `assignment === "general@1"` at all three points and assert the second claim opened a new run with `fence = 1`.

Each case asserts the assignment by value with `assert.equal`, reading the `node` row directly, never through a projection.

`pnpm run verify` exits 0.

Proof: PASS lines delivered — `src/commands/node/claim-node.test.ts`, `src/commands/node/release-node.test.ts` and `src/commands/outcome/report-outcome.test.ts` in `PASS EPIC-050`.
