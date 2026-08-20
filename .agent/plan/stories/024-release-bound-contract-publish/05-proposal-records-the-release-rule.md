# Story 5 — The proposal records the release rule

Epic: `.agent/plan/epics/024-release-bound-contract-publish.md`
Depends on: Story 4 (the text states the shipped behaviour).

> **`docs/proposal/**` is a locked planning file. The human lane applies this story; the
> software-engineer lane cannot.**

## Change

**`docs/proposal/api/README.md`.** Line 21 ends with "A release publishes the generated documents as
a named artifact beside the daemon and the CLI, and a client generator consumes them. Neither the
validator nor a client generator ever starts the daemon." Add a new section immediately after that
paragraph, before the next heading, titled `### The release gate`. It states, in ASD-STE100 prose:

- A release is a commit that carries the git tag `v<version>`. The `version` field of `package.json`
  and `KANTHORD_VERSION` in `src/domain/version.ts` hold the same version.
- `npm run contract:publish -- <output-directory>` refuses a dirty working tree. It exits `2` and
  writes `dirty-tree` to stderr.
- The command refuses a commit that carries no tag `v<version>`. It exits `2` and writes
  `untagged-commit` to stderr. A commit that carries other tags is untagged for this purpose.
- The dirty refusal comes first. A dirty and untagged tree reports `dirty-tree`.
- `manifest.json` holds `version`, `commit`, `tag`, `features` and `operations`, in that order. It
  holds no `dirty` field.
- `--unreleased` skips the tag check and writes `tag: null`. It does not skip the dirty check.
- A client pins an artifact whose `tag` is not `null`. An artifact whose `tag` is `null` is not
  pinnable.
- The release step is manual. A human bumps `package.json`, bumps `src/domain/version.ts`, commits,
  writes the tag, then publishes. No workflow does this.

**`docs/proposal/api/new-decisions.md`.** Line 11 is the bullet
`**\`openapi.yaml\` is generated, self-contained and not committed.**`, and it ends with "A release
publishes it as an artifact." Extend that sentence into: "A release publishes it as an artifact, and
`npm run contract:publish`refuses a dirty tree and an untagged commit;`manifest.json`names the tag,
and`--unreleased`writes`tag: null` for an artifact a client must not pin. See
[README.md](README.md)."

## Constraints

- Add no other text to either file. Do not renumber, reorder or reflow an unrelated line.
- The README section states the decision only. No alternative, no rationale, no history.
- Write no tag creation command and no release script.

## Verify

- `node --test test/helpers/proposal.test.ts` exits 0. `docs/proposal/` is fixture input for the
  proposal helper, so a heading addition must not break its parse.
- `npm run verify` exits 0, which includes the registry-equals-proposal parity test. This story adds
  no operation, so parity is unchanged.
- Read back both files and confirm every refusal name in the text is spelled exactly `dirty-tree` and
  `untagged-commit`, matching the `ReleaseRefusal` union of `scripts/release-gate.ts`.
- Proof: none directly. The Proof block covers code; this story closes the epic's documentation
  obligation.
