# Story 1 — The release gate as a pure function

Epic: `.agent/plan/epics/024-release-bound-contract-publish.md`

## Change

- Create `scripts/release-gate.ts`. It imports nothing outside `node:` builtins. It calls no
  subprocess and reads no file.
- Export the fact type and the refusal type:

```ts
export type ReleaseFacts = Readonly<{
  commit: string;
  dirty: boolean;
  tags: readonly string[];
}>;

export type ReleaseRefusal = "dirty-tree" | "untagged-commit";

export type ReleaseVerdict =
  | Readonly<{ ok: true; tag: string | null }>
  | Readonly<{ ok: false; reason: ReleaseRefusal }>;
```

- Export `releaseVerdict(facts: ReleaseFacts, version: string, unreleased: boolean): ReleaseVerdict`.
- Story 4 adds `CliDecision` and `cliDecision` to this same file. Do not create a third file.
- The decision order is fixed and it is checked in this order:
  1. `facts.dirty === true` returns `{ ok: false, reason: "dirty-tree" }`. This check runs first in
     both modes, so a dirty and untagged tree returns `dirty-tree`.
  2. `unreleased === true` returns `{ ok: true, tag: null }`.
  3. `facts.tags` is searched for the exact string `` `v${version}` ``. The tag set is searched with
     `includes`, never indexed at zero, and no other tag matches.
  4. A match returns `{ ok: true, tag: `v${version}` }`. No match returns
     `{ ok: false, reason: "untagged-commit" }`.
- `facts.commit` is carried for the caller and it takes part in no decision.

## Constraints

- No default export. No class. No mutable module state.
- The function throws nothing. Every input produces a verdict.
- Do not read `KANTHORD_VERSION` inside this file. The version arrives as the `version` parameter.

## Verify

- Create `scripts/release-gate.test.ts` on `node:test` with `node:assert/strict`. Suite name
  `scripts/release-gate`. It imports only `./release-gate.ts` and `node:` builtins. Every case builds
  a fact object literal; no case spawns a process.
- Assert each of these, one test each, with `assert.deepEqual` on the whole verdict object:
  - clean tree, `tags: ["v27.8.1"]`, version `"27.8.1"`, `unreleased: false` →
    `{ ok: true, tag: "v27.8.1" }`
  - clean tree, `tags: []`, version `"27.8.1"`, `unreleased: false` →
    `{ ok: false, reason: "untagged-commit" }`
  - clean tree, `tags: ["v27.8.0"]`, version `"27.8.1"`, `unreleased: false` →
    `{ ok: false, reason: "untagged-commit" }`
  - dirty tree, `tags: ["v27.8.1"]`, version `"27.8.1"`, `unreleased: false` →
    `{ ok: false, reason: "dirty-tree" }`
  - dirty tree, `tags: ["v27.8.1"]`, version `"27.8.1"`, `unreleased: true` →
    `{ ok: false, reason: "dirty-tree" }`
  - dirty tree, `tags: []`, version `"27.8.1"`, `unreleased: false` →
    `{ ok: false, reason: "dirty-tree" }`, asserted by the `reason` string and not by truthiness
  - clean tree, `tags: []`, version `"27.8.1"`, `unreleased: true` → `{ ok: true, tag: null }`
  - clean tree, `tags: ["nightly", "v27.8.1"]`, version `"27.8.1"`, `unreleased: false` →
    `{ ok: true, tag: "v27.8.1" }`
  - clean tree, `tags: ["v27.8.0", "nightly"]`, version `"27.8.1"`, `unreleased: false` →
    `{ ok: false, reason: "untagged-commit" }`
- The literal version strings above are fixture values passed as the `version` parameter. Do not
  import `KANTHORD_VERSION` into this test.
- `node --test scripts/release-gate.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `scripts/release-gate.test.ts` in the EPIC Proof block.
