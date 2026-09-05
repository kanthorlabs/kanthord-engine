# Story 0 — groundwork

Epic: `.agents/plan/epics/050.5-the-lease-table-removal.md`
Depends on: nothing of this epic — it runs first.
Kind: story-foundation
Executor: groundwork-engineer
Paths: eslint.config.js package.json

`eslint.config.js` and `package.json` are the only two paths this epic edits that
`scripts/lane-check.sh` denies to both engineers. Each carries one edit, and each edit is one line.

## Change

### 1 — `eslint.config.js`, the node-and-edge write exemption

**Add `"src/commands/startup/recover-expired-runs.test.ts"` to `nodeEdgeWriteExemptions`, directly
after the shipped entry it will replace, and keep that entry.** The list is at
`eslint.config.js:17` — `nodeEdgeWriteExemptions`, and the shipped entry is at `eslint.config.js:21` —
`recover-expired-leases.test.ts`. The two names sort in that order, so the insert goes below it and
the list moves from eighteen entries to nineteen.

**The renamed test needs the exemption because the shipped one has it.** EPIC 050.5 Story 1
(`01-the-external-sweep-scans-runs`) moves `src/commands/startup/recover-expired-leases.ts` and its
test to `recover-expired-runs.ts`, and that test seeds `node` rows with raw SQL — six statements the
`nodeEdgeWriteSelectors` of `eslint.config.js:9` — `nodeEdgeWritePattern` match. A renamed file that
is on neither list fails `pnpm run lint` on every one of them.

**The shipped entry stays, and the reason is the order this role runs in.** This turn is before the
first dispatch of the loop, so `src/commands/startup/recover-expired-leases.test.ts` still exists
when the edit lands. Replacing its entry rather than adding beside it un-exempts a file that is still
in the tree and still holds the six writes, and `pnpm run lint` fails on this turn. The nineteen-entry
list is the one state that is green both before Story 1's rename and after it: `eslint.config.js:478`
— `files` applies a block to the files its patterns match, and a pattern that matches none applies to
nothing.

**The stale entry therefore outlives Story 1, and no case of this epic removes it.** Only this role
may write the file, only this turn dispatches the role from this story, and the turn is spent before
Story 1 renames anything. The index records it as an open item for the human.

Change no other key of the file: no `boundaries` element, no `no-restricted-imports` glob, no
selector, no other exemption list.

### 2 — `package.json`, the version field

**Move `version` from `27.8.1` to `30.0.0`.** The field is at `package.json:3` — `"version"`. Write
the exact string `"30.0.0"`. Change no other key: no dependency, no `scripts` entry, no `bin` entry,
no `files` entry.

The major bump is the ruling EPIC 050.5 records. `leases[]` leaves the `system.status` response, and
`docs/proposal/api/README.md:103` — `remove or rename a response field` puts that outside the closed
list, so the change is legal only behind a recorded human ruling. EPIC 050.5 Story 8
(`08-the-proposal-records-the-removal`) writes the ruling and the compatibility-record row.

**The matching half is not in this story, and it cannot be.** `src/domain/version.ts:1` —
`KANTHORD_VERSION` holds the same string, and `src/domain/version.test.ts:13` — `assert.equal`
asserts the two are equal. `src/domain/version.ts` is the software-engineer lane and `package.json`
is this role's, so no single turn writes both. EPIC 050.5 Story 8
(`08-the-proposal-records-the-removal`) writes the constant, and it owns assertion 26 of the epic's
gate, which proves the pair.

**The interval is stated, and it is bounded.** From this story until Story 8 lands the constant,
`src/domain/version.test.ts` fails on that one assertion. No numbered case of Stories 1 to 7 runs
that file — each names its own `node --test` list, and `src/domain/version.test.ts` appears in Story
8's list alone. The whole-epic `pnpm run verify` therefore sees a matched pair, and no case of this
epic sees a mismatched one. `KANTHORD_VERSION` has eleven other readers under `src/`, and every one
of them reads the constant alone, so none of their suites sees the interval.

## Constraints

- Add one line to `eslint.config.js` and change one line in `package.json`. The two `numstat` cases
  below are what prove it.
- Keep `"src/commands/startup/recover-expired-leases.test.ts"` in the exemption list. Deleting it on
  this turn fails `pnpm run lint` on the file it exempts.
- Do not touch `src/domain/version.ts`. It is outside this role's ceiling, and Story 8 owns it.
- Do not touch `src/commands/startup/recover-expired-leases.ts` or its test. The rename is Story 1's,
  and `src/**` is outside this role's ceiling.
- Do not run a test runner, and do not run `pnpm run verify`. This story's oracle is the build, and
  `pnpm run verify` is red on the interval this story opens.
- Keep each file's existing key order and its two-space indentation.

## Verify

```
pnpm run lint
```

Add, each as a separate case:

1. `"the write exemption names the renamed recovery test"` — `pnpm run lint` exits 0, and
   `grep -c 'src/commands/startup/recover-expired-runs.test.ts' eslint.config.js` prints exactly `1`.

2. `"the shipped leases entry survives beside it"` — `grep -c
'src/commands/startup/recover-expired-leases.test.ts' eslint.config.js` prints exactly `1`, and
   `git diff --numstat -- eslint.config.js` prints exactly `1	0	eslint.config.js`. The superset is
   what keeps the build green across Story 1's rename, so it is an assertion and not an observation.

3. `"package.json version is 30.0.0"` — `pnpm run typecheck` exits 0, and
   `node -p "require('./package.json').version"` prints exactly `30.0.0`.

4. `"the version bump changed one line and nothing else"` — `pnpm run lint` exits 0, and
   `git diff --numstat -- package.json` prints exactly `1	1	package.json`. A locked file is where
   scope creep does the most damage, so the diff size is an assertion and not an observation.

`pnpm run verify` is red on two assertions after this turn, and each is closed by a named story.
`src/domain/version.test.ts` fails until EPIC 050.5 Story 8
(`08-the-proposal-records-the-removal`) moves `src/domain/version.ts` to the same string.
`src/domain/layout.test.ts:439` — `assert.equal` fails until EPIC 050.5 Story 6
(`06-the-lease-service-is-deleted`) takes `quoted.length` from `18` to `19`, because
`src/domain/layout.test.ts:428` — `eighteen` counts the very list this turn extends. **Neither half
could land here**: `src/domain/version.ts` is the software-engineer's and
`src/domain/layout.test.ts` is the test-engineer's, and this role writes neither. No case of this
story runs either file, and no case of any story between this turn and its closing story does.

Proof: no PASS line of its own. `src/domain/version.test.ts` in `PASS EPIC-050.5` is owned by
EPIC 050.5 Story 8 (`08-the-proposal-records-the-removal`), which lands the matching half.
