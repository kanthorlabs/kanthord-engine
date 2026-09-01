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
- **an untagged commit** — the tag set of the commit names no tag matching `v<version>`. A commit
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
subprocess against the real repository, which is dirty and untagged during ordinary development. The
dirty check applies in both modes, so no subprocess invocation of the publish path passes on a
developer tree. That invocation becomes a direct `publishContract` call with `tag: null`. **No test in
`npm run verify` requires a clean checkout**, because a test that fails on every developer's machine
is worse than no gate.

### D5 — the git reads move behind an injected reader, so the gate is hermetic

`publishContract` never calls git today: `scripts/publish-contract.ts:13-17` takes `commit` and
`dirty` as inputs, and the library path of `publish-contract.test.ts:188-230` passes a synthetic
forty-zero commit. **That seam is the reason this epic is small, and it is preserved.**

The two `execFileSync` calls at `:127-133` and the new tag read move into
`scripts/release-facts.ts`, which exports one reader
`readReleaseFacts(repositoryRoot: string)` returning
`Readonly<{ commit: string; dirty: boolean; tags: readonly string[] }>`. The three git reads pass
`{ cwd: repositoryRoot, encoding: "utf8" }`, and the caller resolves `repositoryRoot` from
`import.meta.url`, never from `process.cwd()`. **The tag read names the commit the first read
returned, never `HEAD` a second time**, so the recorded commit and the recorded tag set are one pair
by construction rather than by timing. **The argument parse precedes the facts read**, so a usage
refusal spawns no subprocess and a tree with no `.git` still reports usage rather than a stack trace.
The documents come from the source tree, so the commit and the tag come from the same tree. A reader
bound to the process working directory lets a run from an unrelated tagged repository publish these
documents under that repository's tag. The decision itself is a pure function in
`scripts/release-gate.ts`:

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
which validates every emitted **feature slice** through `SwaggerParser.validate()` at `:71-88`. The
master document is validated at `src/http/contract/openapi.test.ts:457-460`. Both therefore run on
every verify run, and no story relies on `publish-contract.test.ts` for master validation. This epic
adds no second validation path and moves none.

## Stories

- **The release gate as a pure function** — `scripts/release-gate.ts` and
  `scripts/release-gate.test.ts`. Every verdict case against a fact object, no subprocess.
- **The facts reader** — `scripts/release-facts.ts`, holding the three `execFileSync` calls, moved
  from `publish-contract.ts:127-133` plus a tag read. `scripts/release-facts.test.ts` asserts the
  shape of one read and nothing more, because a value assertion would be a test of `execFileSync`.
- **The manifest record** — `scripts/publish-contract.ts:13-17` takes `tag: string | null` in place
  of `dirty: boolean`, and `:98-104` writes the five keys in the D3 order.
  `scripts/publish-contract.test.ts:115-128` asserts the new list and order.
- **The CLI entry point** — `scripts/release-gate.ts` gains the pure `parseArguments(argv)` and
  `cliDecision(argv, facts, version)`, `publish-contract.ts` exports the hoisted self-publish guard, and `:117-143` becomes one
  `switch` over the decision: refuse with exit `2` and the named reason, or call `publishContract`
  with the tag. The subprocess invocation at `:55-62` becomes a direct library call.
- **The proposal records the release rule** — `docs/proposal/api/README.md` gains a short section
  under the artifact text stating the tag convention, the two refusals and the `tag: null` rule for a
  development artifact. `docs/proposal/api/new-decisions.md:11` gains the same statement, because it
  is the line that already claims the artifact is published on a release and says nothing about how.

## Verification Gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/domain/version.test.ts \
  scripts/release-gate.test.ts \
  scripts/release-facts.test.ts \
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
- **The refusal is a pure decision.** `parseArguments(argv)` returns the whole argument result and
  `cliDecision(argv, facts, version)` returns the whole decision
  object, and every case is asserted against a fact object: each refusal reason, every usage case, and
  the released and the unreleased publish cases. Exit code and stderr text are one `switch` over the
  decision with no branch of its own. A subprocess cannot assert a gate refusal hermetically, because
  the git reads bind to the source tree. One subprocess test covers the argument path: an unknown flag
  exits `2` with the usage message, and it passes on any working tree.
- **The facts reader answers with the right shape.** `readReleaseFacts` returns a forty-character
  lowercase hexadecimal `commit`, a boolean `dirty` and a `tags` array of non-empty strings. The
  assertion is on the shape alone, so it passes on a dirty tree and on a clean one, and it still
  fails on a mistyped git argument. No assertion names a commit, a tag or a tree state.
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
