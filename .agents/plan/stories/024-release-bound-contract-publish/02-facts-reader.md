# Story 2 — The facts reader

Epic: `.agents/plan/epics/024-release-bound-contract-publish.md`
Depends on: Story 1 (`ReleaseFacts` is declared there).

## Change

- Create `scripts/release-facts.ts`. It imports `execFileSync` from `node:child_process` and the
  `ReleaseFacts` type from `./release-gate.ts`.
- Export one function:

```ts
export function readReleaseFacts(repositoryRoot: string): ReleaseFacts;
```

- The body holds three `execFileSync("git", …, { cwd: repositoryRoot, encoding: "utf8" })` calls, in
  this order:
  1. `["rev-parse", "HEAD"]` → `.trim()` → `commit`
  2. `["status", "--porcelain"]` → `.trim().length > 0` → `dirty`
  3. `["tag", "--points-at", commit]` → `.trim()`, split on `/\r?\n/`, drop empty strings →
     `tags`. The third read names the commit the first read returned, never `HEAD` a second time, so
     the recorded commit and the recorded tag set cannot come from two different states of `HEAD`.
- An empty third output produces `tags: []`, not `[""]`.
- Return the object frozen in shape as `{ commit, dirty, tags }`.
- Delete the two `execFileSync` calls at `scripts/publish-contract.ts:127-133`. Story 4 replaces the
  call site.
- Remove the now-orphan `execFileSync` import at `scripts/publish-contract.ts:2` once Story 4 lands.

## Constraints

- `scripts/release-facts.test.ts` asserts the shape of one read against the source tree, and nothing
  more. Story 4 moves the publish path off the subprocess, so no other test reaches the reader. The
  three subtests are `commit` matches `/^[0-9a-f]{40}$/`, `dirty` is a boolean, and `tags` is an
  array of non-empty strings. A shape assertion passes on a dirty tree and on a tagged one, so it
  needs no clean checkout, and it still fails on a mistyped git argument.
- The `cwd` is mandatory and Story 4's caller passes the source repository root resolved from
  `import.meta.url`. The reader must not inherit the process working directory: the documents come
  from the source tree, so the commit and the tag must come from the same tree. A reader bound to
  `process.cwd()` lets a run from an unrelated tagged repository publish these documents under that
  repository's tag.
- Do not re-export `ReleaseFacts` from this file.

## Verify

This story does not verify alone. It deletes the call site at `publish-contract.ts:127-133` and
Story 4 adds the replacement, so the tree does not compile between them. Stories 2, 3 and 4 are one
dispatch unit with one verification at the end of Story 4.

- `npm run lint` exits 0 after Story 4 lands. `scripts/` carries no boundary rule, so no exemption is
  added to `eslint.config.js`.
- `npm run verify` exits 0 after Story 4 lands.
- Proof: `node --test scripts/release-facts.test.ts`. This story is also a precondition of the
  `scripts/publish-contract.test.ts` line of the EPIC Proof block.
