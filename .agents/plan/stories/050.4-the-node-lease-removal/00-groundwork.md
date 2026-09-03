# Story 0 — groundwork

Epic: `.agents/plan/epics/050.4-the-node-lease-removal.md`
Depends on: nothing of this epic — it runs first.
Kind: story-foundation
Executor: groundwork-engineer
Paths: package.json

`package.json` is the only path this epic edits that `scripts/lane-check.sh` denies to both engineers.
It carries one edit, and the edit is one value.

## Change

**`package.json` — move `version` from `27.8.1` to `29.0.0`.** The field is at `package.json:3` —
`"version"`. Write the exact string `"29.0.0"`. Change no other key: no dependency, no `scripts`
entry, no `bin` entry, no `files` entry.

The major bump is the ruling EPIC 050.4 records. Three response fields and three required request
fields leave four worker operations and `lease-held` is retired. `docs/proposal/api/README.md:103` —
`remove or rename a response field` forbids the first kind outright, and the second kind is outside
the closed list because `docs/proposal/api/README.md:108` — `closed` permits only what the first list
names and no item of it removes a request field. The 2026-09-03 ruling that permitted **adding** a
required request field does not reach either: it added one item to the first list and moved nothing
out of the second. So the change is legal only behind a recorded human ruling plus a capability
retirement. EPIC 050.4 Story 8
(`08-lease-held-is-retired`) writes the ruling, retires `worker-model` and declares `worker-run`.

**The matching half is not in this story, and it cannot be.** `src/domain/version.ts:1` —
`KANTHORD_VERSION` holds the same string, and `src/domain/version.test.ts:13` — `assert.equal`
asserts the two are equal. `src/domain/version.ts` is the software-engineer lane and `package.json`
is this role's, so no single turn writes both. EPIC 050.4 Story 8 (`08-lease-held-is-retired`) writes
the constant, and it owns assertion 8 of the epic's gate, which proves the pair.

**The interval is stated, and it is bounded.** From this story until Story 8 lands the constant,
`src/domain/version.test.ts` fails on that one assertion. No numbered case of Stories 1 to 7 runs
that file — each names its own `node --test` list, and `src/domain/version.test.ts` appears in Story
8's list alone. The whole-epic `pnpm run verify` therefore sees a matched pair, and no case of this
epic sees a mismatched one.

## Constraints

- Change `version` and nothing else in the file. The `numstat` case below is what proves it.
- Do not touch `src/domain/version.ts`. It is outside this role's ceiling, and Story 8 owns it.
- Do not run a test runner, and do not run `pnpm run verify`. This story's oracle is the build, and
  `pnpm run verify` is red on the interval this story opens.
- Keep the file's existing key order and its two-space indentation.

## Verify

```
pnpm run typecheck
```

Add, each as a separate case:

1. `"package.json version is 29.0.0"` — `pnpm run typecheck` exits 0, and
   `node -p "require('./package.json').version"` prints exactly `29.0.0`.

2. `"the version bump changed one line and nothing else"` — `pnpm run lint` exits 0, and
   `git diff --numstat -- package.json` prints exactly `1	1	package.json`. A locked file is where
   scope creep does the most damage, so the diff size is an assertion and not an observation.

`pnpm run verify` is red on `src/domain/version.test.ts` until EPIC 050.4 Story 8
(`08-lease-held-is-retired`) moves `src/domain/version.ts` to the same string. That is the only
assertion it fails, and no case of this story runs it.

Proof: no PASS line of its own. `src/domain/version.test.ts` in `PASS EPIC-050.4` is owned by
EPIC 050.4 Story 8 (`08-lease-held-is-retired`), which lands the matching half.
