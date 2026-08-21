# Story 5 — The run frame

Epic: `.agent/plan/epics/025-external-drive-acceptance-run.md`
Depends on: Story 3.

This is the EPIC bullet at `025-external-drive-acceptance-run.md:129`. It establishes the one tag, the one directory and the one report every later story writes into. **It writes no code.**

## Change

Mint one tag and hold it for the whole run.

```sh
export TAG=$(node scripts/e2e/run.mjs --mint-tag)
```

- **The runner mints the tag.** `mintTag` at `scripts/e2e/lib/tag.ts:10-13` builds it from an ISO timestamp with `[-:.TZ]` stripped plus a ULID, lowercased. A shell timestamp is not portable, and a one-second timestamp collides between two parallel invocations.
- **The tag reaches every invocation as an explicit `--tag` argument.** An exported variable that a command does not receive produces a bundle under a minted tag the manifest cannot name, because `parseArguments` at `scripts/e2e/lib/main.ts:406-427` falls back to `tag ?? mintedTag`.

The frame these paths make, all derived from `runDirectory(tag)` at `scripts/e2e/lib/tag.ts:15-17`:

```text
.data/acceptance-<tag>/                 the run directory
.data/acceptance-<tag>/<scenario-id>/   one bundle directory per id
.data/acceptance-<tag>/verify.json      the verify record
.data/acceptance-<tag>/acceptance.json  the acceptance record
.data/acceptance-<tag>/manifest.json    the manifest, recorded once by Story 13
.data/acceptance-<tag>/manifest-input.json  the manifest input, seeded here
.agent/acceptance/<tag>/report.md       the report of Story 13
```

Record the commit under test once, and check it against every bundle later:

```sh
git rev-parse HEAD
git log -1 --format=%H -- docs/proposal
```

These are the two commands `readCommit` and `readProposalRevision` run at `scripts/e2e/lib/bundle.ts:317-335`.

Seed the manifest input file now, and export its path so every later story writes into one file:

```sh
export MANIFEST=".data/acceptance-$TAG/manifest-input.json"
```

`parseManifestShape` at `scripts/e2e/lib/record/manifest.ts:136-145` rejects an input file that lacks any of nine fields: `schemaVersion`, `tag`, `commit`, `proposalRevision`, `scenarios`, `checklist`, `report`, `findings` and `outcome`. Seed all nine. `recordManifest` overwrites `tag`, `commit` and `proposalRevision` at `manifest.ts:331-334`, so their seeded values carry no meaning. Seed `scenarios`, `checklist` and `findings` as empty arrays, `report` with empty strings and zero, and `outcome` as `failed`, so a run abandoned before Story 13 leaves no `passed` input behind.

**The file must survive the human gate.** Stories 7 to 12 write into it and Story 13 records it, so it lives in the run directory and never in a temporary directory.

Run the verify record inside the same tag, after the seven scenarios of Story 6:

```sh
node scripts/e2e/run.mjs --record-verify --tag "$TAG"
```

## Constraints

- **A bundle carries no proposal revision.** `Bundle` at `scripts/e2e/lib/bundle.ts:39-60` declares no such field, and `main.ts:629-631` stamps the commit alone. `readProposalRevision` serves the verify record, the acceptance record and the manifest. Do not look for one in a bundle.
- **A bundle holds `logs/` only when it has logs.** `writeBundle` at `scripts/e2e/lib/bundle.ts:272-282` creates the directory only for a non-empty `bundle.logs`. An absent `logs/` is not a finding.
- **Tag reuse is refused per scenario directory only.** `claimBundleDirectory` at `scripts/e2e/lib/tag.ts:31-53` refuses a second run of one id under one tag with `tag-reused`. The verify record is overwritten. The acceptance record is refused at `acceptance.ts:96-100`. Minting reserves no tag globally, so a re-run is a new tag by procedure.
- **No report writer exists, and none is built here.** The coding agent authors `.agent/acceptance/<tag>/report.md` by hand in Story 13. `verdict` at `scripts/e2e/lib/record/verdict.ts:59-204` never opens it. `--check-manifest` is the only mechanism that binds the report to the run.
- Every byte reaches disk through `redact`. `serializeBundle` at `scripts/e2e/lib/bundle.ts:259` and `serializeManifest` of Story 1 both apply it.
- Commit nothing. `.gitignore:146,148` ignores `.data/acceptance-*/` and `.agent/acceptance/`.

## Verify

- `node scripts/e2e/run.mjs --mint-tag` prints one tag and exits 0, and the tag matches `tagPattern` at `scripts/e2e/lib/main.ts:55`.
- After Story 6, `.data/acceptance-<tag>/` holds exactly seven scenario directories and `verify.json`.
- `git rev-parse HEAD` returns the same commit that every `bundle.json` under the tag names in its `commit` field.
- `git status --porcelain` names no path under `src/` and no path under `docs/proposal/`, asserted against the commit under test. This is the check `025-external-drive-acceptance-run.md:241` requires.
- Proof: the `TAG` and `--record-verify` lines of the run block at `025-external-drive-acceptance-run.md:201,209`.
