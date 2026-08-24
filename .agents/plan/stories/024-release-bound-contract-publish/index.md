# EPIC 024 — Release-bound contract publish — stories

Epic: `.agents/plan/epics/024-release-bound-contract-publish.md`
Prereq: EPIC 023 (sequence order).

`npm run contract:publish` refuses a dirty tree and an untagged commit, and the manifest names the
release tag instead of a `dirty` flag.

## Dispatch order

1. `01-release-gate-pure-function.md`
2. `02-facts-reader.md` + `03-manifest-record.md` + `04-cli-entry-point.md` — **one dispatch unit,
   one commit, one verification.** `publish-contract.ts` does not compile between Story 2's deletion
   of the `execFileSync` calls and Story 4's new call site, and `publish-contract.test.ts` does not
   pass between Story 3's type change and Story 4's edits. Neither Story 2 nor Story 3 carries a
   `npm run verify` obligation of its own.
3. `05-proposal-records-the-release-rule.md`

## Stories

- 1 — the pure verdict function and its full case table → `01-release-gate-pure-function.md`
- 2 — the three git reads behind one reader → `02-facts-reader.md`
- 3 — `tag` replaces `dirty` in `PublishInput` and the manifest → `03-manifest-record.md`
- 4 — the pure `cliDecision` function, the hoisted self-publish guard, the exit-2 refusals →
  `04-cli-entry-point.md`
- 5 — the proposal states the tag convention and the pin rule → `05-proposal-records-the-release-rule.md`

## Facts (needed for implementation)

- `scripts/` sits outside the boundary matrix of `eslint.config.js:89-119` and carries no
  `no-restricted-imports` rule. Two new files there need no lint exemption.
- `publishContract` never calls git. `scripts/publish-contract.ts:13-17` takes `commit` and `dirty`
  as inputs, and the library tests at `:184-231` pass a synthetic forty-zero commit. That seam is why
  this epic is small. Preserve it.
- The current version is `27.8.1` (`package.json:3`), and `src/domain/version.ts:1` holds
  `KANTHORD_VERSION` as a hardcoded literal. It stays a literal: `domain/` is pure, so a
  `package.json` read at import time is forbidden.
- `src/domain/version.test.ts:12-14` already asserts `KANTHORD_VERSION` equals `package.json`
  `version`, and it runs in `npm run verify`. The gate therefore compares the tag against
  `KANTHORD_VERSION` alone. Add no second parity assertion.
- `publish-contract.test.ts:46-49` is the `mkdtempSync` plus `after`-hook `rmSync` pattern every new
  temporary directory follows.
- Exit code `2` is the existing refusal code. `publish-contract.test.ts:234-268` already asserts it
  for the repository-root refusal, with the
  `(error: NodeJS.ErrnoException & { status?: number; stderr?: string }) => …` assertion shape that
  the new refusal tests reuse.
- The real repository working tree is dirty during ordinary development and during a `/work` run.
  No test in `npm run verify` may depend on it being clean. This is why Story 4 moves the publish
  path off the subprocess and covers the gate wiring with the pure `cliDecision`.
- A temporary git fixture with `cwd` pointed at it was rejected. It would let the CLI publish this
  repository's documents while recording the fixture's commit and tag, which is the provenance hole
  EPIC 024 exists to close.
- The EPIC's D6 cites the wrong file. `scripts/publish-contract.test.ts:88` validates the feature
  slices only. The master document is validated at `src/http/contract/openapi.test.ts:457-460`.
  D6's conclusion holds — `npm run verify` validates both — but no story may rely on
  `publish-contract.test.ts` for master validation.
- `publish-contract.test.ts:92` asserts 34 example files and `:71-88` asserts the per-feature
  operation sets and their schema validity. They prove the operation set and the example count did
  not move. They do **not** prove the emitted bytes are unchanged; a schema description or a YAML
  ordering change would still pass. The EPIC's "the emitted documents are unchanged" bullet is
  delivered to that strength and no further.
- The EPIC does not close on `npm run verify` alone. Its Open items require the `kanthord-apps`
  commit that retires E4 from `docs/api/blockers.md` and records the pin rule "an artifact whose
  `tag` is `null` is not pinnable". That commit is outside this repository and outside every story
  here. It is a closure condition on the epic, checked by the human at review.
