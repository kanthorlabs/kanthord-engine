# Story 11 — The rehearsal

Epic: `.agent/plan/epics/025-external-drive-acceptance-run.md`
Depends on: Stories 7, 8, 9 and 10.

This is the EPIC bullet at `025-external-drive-acceptance-run.md:141`. A coding agent runs the seven scenarios and the verify record under one tag, prepares the manifest scenario rows, and reports the scenario axis green. **The rehearsal never closes the block.**

## Change

After the seven invocations of Story 6, in this order:

```sh
node scripts/e2e/run.mjs --record-verify --tag "$TAG"
node scripts/e2e/run.mjs --verdict "$TAG" --scenarios-only
```

Then write the manifest `scenarios` array — seven rows in invocation order, each `{ id, bundlePath, sha256, outcome }` — into the manifest input file at `$MANIFEST`, and stop there. **Do not invoke `--record-manifest`.** Story 13 makes the one manifest write, because `recordManifest` at `scripts/e2e/lib/record/manifest.ts:287-292` refuses a second write for one tag with `tag-reused`, and the `checklist`, `report`, `findings` and `outcome` fields are not known until Stories 12 and 13 supply them.

Compute each `sha256` over the bundle file bytes as bare lowercase hex, the form `digestOf` of Story 1 returns.

The rehearsal is **repeatable and unattended**, because no scenario pauses for a human. It exists so the human gate of Story 12 meets a run that already works, and so the human drives the same CLI and the same API the rehearsal drove.

## Constraints

- `--scenarios-only` says nothing about the acceptance axis. `verdict` returns at `scripts/e2e/lib/record/verdict.ts:153-155` before every `axis: "acceptance"` check. **Do not read a zero exit status here as a closed block.**
- The scenario axis needs one bundle per declared id, all `passed`, a verify record with exit status zero, and one commit across every record. `verdict` checks all four at `verdict.ts:65-133`.
- The seven-bundle rule depends on EPIC 020 adding the three ids to `verdict.ts:20-25`. Until then `--verdict` checks four. Story 3 proves the widening landed.
- Do not sign the acceptance record here. Story 12 owns it.
- Do not fill the `checklist` rows here. Story 12 supplies the answers.
- **Do not record the manifest here.** Story 13 owns the single write. A scenarios-only manifest recorded now is immutable, so Story 12 could never add the checklist and Story 13 could never add the report.

## Verify

- `node scripts/e2e/run.mjs --record-verify --tag "$TAG"` exits 0 and writes `.data/acceptance-<tag>/verify.json` with `exitCode: 0`.
- `node scripts/e2e/run.mjs --verdict "$TAG" --scenarios-only` exits 0. Record the command and its exit status for the report.
- `node scripts/e2e/run.mjs --verdict "$TAG"` **without** `--scenarios-only` exits non-zero at this point, with one `acceptance` axis failure reading that the tag has no acceptance record. This is the assertion `025-external-drive-acceptance-run.md:239` requires: the rehearsal passes `--scenarios-only` and the full verdict still fails until the gate is signed.
- The manifest input file at `$MANIFEST` holds seven `scenarios` rows in the declared order, each with a `passed` outcome and a 64-character lowercase hex `sha256`.
- `.data/acceptance-<tag>/manifest.json` does **not** exist yet.
- Every bundle and the verify record name one commit under test.
- Proof: lines `209` and `210` of the run block at `025-external-drive-acceptance-run.md:200-218`.
