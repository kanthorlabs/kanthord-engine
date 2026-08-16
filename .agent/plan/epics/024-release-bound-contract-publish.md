# EPIC 024 — Release-bound contract publish

Status: **draft**.

Source: `kanthord-apps/docs/api/blockers.md`, item E4. The artifact is delivered; the release ownership
is not. `scripts/publish-contract.ts:127-133` reads the commit and the working-tree state, and
`:98-104` records `dirty` in the manifest **and publishes anyway**. The client copies that output into
its own repository, so it pins a local generation result rather than a release.

## Goal

`npm run contract:publish` refuses a working tree that is dirty, and refuses a commit that carries no
release tag. The manifest names the tag it was cut from, so the client pins an artifact instead of a
snapshot of somebody's afternoon. A development publish stays possible and it is unmistakable in the
artifact it produces.

## Non-goals

- **No release automation.** No workflow, no bot, no publish-on-tag. `.claude/commands/e2e.md:78`
  states that this product has no release workflow, and this epic does not open one. The gate runs
  where the human runs it.
- **No package publication.** `package.json:4` is `"private": true` and stays private. This epic
  publishes a contract artifact, not an npm package.
- **No signing and no checksum manifest.** Provenance is a separate concern with its own key
  management. Recorded under Open items.
- **No change to the emitted documents.** `openapi.yaml`, `features/*.yaml` and `examples/*.json` keep
  their content and their byte order. Only `manifest.json` changes shape.
- **No new operation and no route.** This epic is the block's second named exception to "an epic
  closes on a route", per `013-external-drive-overview.md`. It closes on a command.
- **No git tag creation.** The epic reads a tag. A human writes one.

## Decisions

### D1 — a release is a commit that carries the tag `v<version>`, and three strings must agree

No tag convention exists anywhere in the repository today. This epic sets one, and it is the smallest
that can be checked:

- the git tag is `v` followed by the version, so `v27.8.1`;
- `package.json:3` `version` equals that version;
- `KANTHORD_VERSION` at `src/domain/version.ts:1` equals that version.

**Two of the three are already fenced, and this epic adds no assertion for them.**
`src/domain/version.test.ts:12-14` asserts `KANTHORD_VERSION` equals the `version` field of
`package.json`, and it runs in `npm run verify` whether or not anybody publishes. So the gate compares
the tag against **one** version string and inherits the rest.

`KANTHORD_VERSION` stays a hardcoded literal at `src/domain/version.ts:1` rather than a read of
`package.json`. `domain/` is pure under `AGENTS.md`, a `package.json` read at import time is file
system access, and the existing test already removes the reason to reach for one.

### D2 — the gate refuses two states, and it names which one it refused

`npm run contract:publish -- <directory>` refuses, with exit code `2` and a message on stderr:

- **a dirty tree** — `git status --porcelain` is non-empty. The message names the refusal and prints
  nothing else; a human runs `git status` to see the paths.
- **an untagged commit** — `git tag --points-at HEAD` names no tag matching `v<version>`. A commit
  that carries other tags and not this one is untagged for this purpose.

Exit code `2` is the code the script already uses for a refusal
(`scripts/publish-contract.ts:117-143`, and `publish-contract.test.ts:234-268` asserts it for the
repository-root refusal). This epic adds two refusals to an existing class rather than a new class.

### D3 — the manifest carries `tag` and loses `dirty`

`dirty` exists to describe an artifact the tool should not have produced. After D2 it can only ever
be `false` on a release, so it stops carrying information. The manifest record becomes, in this
order:

```
version, commit, tag, features, operations
```

`tag` is the release tag on a release publish, and `null` on a development publish. **The client's
rule becomes one line: pin an artifact whose `tag` is not `null`.** That is checkable in the client
repository without reading the engine.

`scripts/publish-contract.test.ts:115-128` asserts the key list and its order, and it changes with
the record. The same file asserts at `:130-135` that the manifest holds no `generatedAt`, no
`timestamp` and no `date`; that assertion stays, because a determinism guarantee does not weaken here.

### D4 — a development publish stays possible, and it is explicit

A hard refusal with no escape is a refusal a developer routes around by editing the script. So
`--unreleased` is an explicit opt-in:

- it skips the tag check and **not** the dirty check — a dirty tree is refused in both modes, because
  a dirty tree produces an artifact no commit can reproduce;
- it writes `tag: null`;
- it writes one line to stderr naming the artifact as unreleased.

Two modes, one difference. `--unreleased` is what the existing CLI test and the client's own
day-to-day generation use, and a release is the default rather than the flag.

**This changes an existing test.** `scripts/publish-contract.test.ts:55-62` invokes the script as a
subprocess against the real repository, which is dirty and untagged during ordinary development. That
invocation gains `--unreleased`, and the working tree it runs against must be clean for it to pass —
which is already the rule `025-external-drive-acceptance-run.md:241` places on an acceptance run. The
story states it, because a test that fails on every developer's machine is worse than no gate.

### D5 — the git reads move behind an injected reader, so the gate is hermetic

`publishContract` never calls git today: `scripts/publish-contract.ts:13-17` takes `commit` and
`dirty` as inputs, and the library path of `publish-contract.test.ts:188-230` passes a synthetic
forty-zero commit. **That seam is the reason this epic is small, and it is preserved.**

The two `execFileSync` calls at `:127-133` and the new tag read move into
`scripts/release-facts.ts`, which exports one reader returning
`Readonly<{ commit: string; dirty: boolean; tags: readonly string[] }>`. The decision itself is a
pure function in `scripts/release-gate.ts`:

```ts
export function releaseVerdict(
  facts: ReleaseFacts,
  version: string,
  unreleased: boolean,
):
  | { readonly ok: true; readonly tag: string | null }
  | { readonly ok: false; readonly reason: ReleaseRefusal };
```

`ReleaseRefusal` is `"dirty-tree" | "untagged-commit"`. Every case is asserted against a fact object,
so no test spawns git. `scripts/` sits outside the boundary matrix of `eslint.config.js:89-119` and
carries no `no-restricted-imports` rule, so this file placement needs no lint exemption.

### D6 — the OpenAPI validation stays where it is

`npm run verify` runs `npm test`, and `node --test` discovers `scripts/publish-contract.test.ts`,
which validates every emitted document through `SwaggerParser.validate()` at `:71-88`. The master and
the feature slices are therefore already emitted into a temporary directory and validated on every
verify run. This epic adds no second validation path and moves none.

## Stories

- **The release gate as a pure function** — `scripts/release-gate.ts` and
  `scripts/release-gate.test.ts`. Every verdict case against a fact object, no subprocess.
- **The facts reader** — `scripts/release-facts.ts`, holding the three `execFileSync` calls, moved
  from `publish-contract.ts:127-133` plus `git tag --points-at HEAD`. It is exercised through the CLI
  test and not unit tested, because a unit test of it would be a test of `execFileSync`.
- **The manifest record** — `scripts/publish-contract.ts:13-17` takes `tag: string | null` in place
  of `dirty: boolean`, and `:98-104` writes the five keys in the D3 order.
  `scripts/publish-contract.test.ts:115-128` asserts the new list and order.
- **The CLI entry point** — `:117-143` parses `--unreleased`, calls the reader, calls the gate,
  refuses with exit `2` and the named reason, or calls `publishContract` with the tag. The existing
  subprocess test at `:55-62` gains `--unreleased`.
- **The proposal records the release rule** — `docs/proposal/api/README.md` gains a short section
  under the artifact text stating the tag convention, the two refusals and the `tag: null` rule for a
  development artifact. `docs/proposal/api/new-decisions.md:11` gains the same statement, because it
  is the line that already claims the artifact is published on a release and says nothing about how.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/domain/version.test.ts \
  scripts/release-gate.test.ts \
  scripts/publish-contract.test.ts \
  && echo "PASS EPIC-024"
```

Hermetic coverage required beyond the Proof:

- **Every gate verdict, against a fact object.** Clean tree with a matching tag returns
  `{ ok: true, tag: "v27.8.1" }`. Clean tree with no tag returns `untagged-commit`. Clean tree with a
  tag that does not match the version returns `untagged-commit`. Dirty tree with a matching tag
  returns `dirty-tree`. Dirty tree with `unreleased: true` still returns `dirty-tree`, which is D4's
  asymmetry asserted. Clean tree, no tag, `unreleased: true` returns `{ ok: true, tag: null }`.
- **The dirty refusal wins over the tag refusal.** A dirty and untagged tree returns `dirty-tree`, so
  the message a human reads names the state they can fix first. Asserted by name, not by truthiness.
- **A commit carrying several tags.** Facts with `tags: ["nightly", "v27.8.1"]` pass, and facts with
  `tags: ["v27.8.0", "nightly"]` against version `27.8.1` refuse. The tag set is searched, never
  indexed at zero.
- **The refusal reaches the process.** The CLI subprocess test asserts exit code `2` and a stderr
  message naming `dirty-tree`, driven by pointing the script at a temporary directory from a tree the
  test makes dirty by writing one file into it. The file is removed in an `after` hook, following the
  `mkdtempSync` plus `rmSync` pattern of `publish-contract.test.ts:46-49`.
- **The manifest key order.** The five keys are `["version","commit","tag","features","operations"]`,
  asserted on the parsed object's `Object.keys` and on the raw JSON text, so a serializer that emits
  the right values in the wrong order fails.
- **`dirty` is gone.** The raw manifest text contains no `dirty`, asserted the way `:130-135` already
  asserts the absence of `generatedAt`.
- **Determinism survives.** Two publishes with the same `commit` and the same `tag` produce
  byte-identical output, which is the assertion `publish-contract.test.ts:184-209` already makes with
  `dirty` and which now runs with `tag`.
- **A development artifact is self-identifying.** A publish with `--unreleased` writes `tag: null`,
  and its manifest differs in bytes from a release publish of the same commit. This is the shape of
  the assertion at `:212-231`, retargeted from `dirty` to `tag`.
- **The gate compares the tag against `KANTHORD_VERSION`.** Asserted by name, so the existing parity
  test at `src/domain/version.test.ts:12-14` carries the `package.json` half and a version bump in one
  file alone still fails `npm run verify`. This epic adds no second parity assertion.
- **The emitted documents are unchanged.** The example count assertion at `publish-contract.test.ts:92`
  and the per-feature operation set assertions at `:71-88` pass unedited, proving the epic changed the
  manifest and nothing else.

## Open items

- **Provenance.** A signature or a checksum file would let the client verify the artifact came from
  this repository. It needs a key and a place to keep it, so it is its own decision.
- **Who cuts the tag.** The epic reads a tag and never writes one. The human release step — bump
  `package.json`, bump `src/domain/version.ts`, commit, tag, publish — is written down in the
  proposal by this epic and automated by nobody.
- **The client repository commit.** `kanthord-apps` retires E4 from `docs/api/blockers.md` and records
  the pin rule: an artifact whose `tag` is `null` is not pinnable. This epic does not close before
  that lands.
- **A stale artifact is still possible.** A tagged release publishes a correct artifact for that tag
  and says nothing about a later one. Detecting that the client's pinned artifact is behind the daemon
  it talks to is EPIC 023's `capabilities`, not this epic's manifest.
