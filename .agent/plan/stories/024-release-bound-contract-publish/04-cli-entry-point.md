# Story 4 — The CLI entry point

Epic: `.agent/plan/epics/024-release-bound-contract-publish.md`
Depends on: Story 1, Story 2, Story 3. Stories 2, 3 and 4 are one dispatch unit and land together.

> **BLOCKED — do not dispatch until the EPIC is amended.** This story contradicts EPIC 024 in three
> places, and the contradictions are planning defects in the EPIC, not in the story. See B1, B2 and
> B3 in the `/author` report. The amendments required are:
>
> 1. **D4, last paragraph.** Delete the instruction that the invocation at
>    `publish-contract.test.ts:55-62` gains `--unreleased` and that the real working tree must be
>    clean. No test in `npm run verify` may require a clean checkout.
> 2. **D5.** `readReleaseFacts` binds the three git reads to the source repository root resolved from
>    `import.meta.url`, not to the process working directory.
> 3. **Hermetic coverage, "The refusal reaches the process".** Replace with a pure decision function.
>    A subprocess cannot assert a gate refusal hermetically once the git reads bind to the source
>    tree.

## Change

### `scripts/publish-contract.ts` — hoist the self-publish check

- Export the path guard so the CLI can run it before the release gate:

```ts
export function refusesSelfPublish(outputDirectory: string): boolean;
```

Its body is the condition currently inline at `:34-37`. `publishContract` calls it at `:34` and
keeps throwing `PublishRefusal` with the same message. The behaviour and the message do not change.

### `scripts/release-gate.ts` — the pure CLI decision

Add to the file Story 1 creates:

```ts
export type CliDecision =
  | Readonly<{ kind: "usage" }>
  | Readonly<{ kind: "refuse"; reason: ReleaseRefusal }>
  | Readonly<{
      kind: "publish";
      outputDirectory: string;
      tag: string | null;
      notice: string | null;
    }>;

export function cliDecision(
  argv: readonly string[],
  facts: ReleaseFacts,
  version: string,
): CliDecision;
```

Decision order, fixed:

1. `unreleased` is `true` when `argv` contains the exact string `--unreleased`.
2. Any argument that starts with `--` and is not `--unreleased` returns `{ kind: "usage" }`.
3. The first argument that is not `--unreleased` is `outputDirectory`. A missing or empty value
   returns `{ kind: "usage" }`.
4. A second non-flag argument returns `{ kind: "usage" }`.
5. `releaseVerdict(facts, version, unreleased)`. A refusal returns
   `{ kind: "refuse", reason }`.
6. Otherwise return `{ kind: "publish", outputDirectory, tag: verdict.tag, notice }`, where `notice`
   is `"publishing an unreleased artifact"` when `verdict.tag === null` and `null` otherwise.

`cliDecision` calls no subprocess, reads no file and does not check the output path.

### `scripts/publish-contract.ts:117-143` — the entry block

Rewrite the `import.meta.filename === process.argv[1]` block to this order:

1. `const decision = cliDecision(process.argv.slice(2), … )` — but the facts are read lazily, so
   split it: parse first by calling `cliDecision` with the facts, and read the facts before the call.
   The read is cheap and unconditional. Order inside the block:
   - `const outputDirectory = process.argv.slice(2).find((value) => value !== "--unreleased")`
   - if `outputDirectory !== undefined` and `refusesSelfPublish(outputDirectory)`, write
     `` `refusing to publish into the repository: ${resolved}\n` `` to stderr and `process.exit(2)`.
     This runs **before** the facts read and before the gate, so the existing repository-root
     subprocess test passes on any working tree.
   - `const facts = readReleaseFacts(repositoryRoot)` where `repositoryRoot` is
     `fileURLToPath(new URL("../", import.meta.url))`.
   - `const decision = cliDecision(process.argv.slice(2), facts, KANTHORD_VERSION)`.
2. `usage` → write `usage: node scripts/publish-contract.ts [--unreleased] <output-directory>\n` to
   stderr, `process.exit(2)`. The usage check inside `cliDecision` also covers the empty argv case,
   so the guard at `:119-124` is deleted.
3. `refuse` → write exactly `` `${decision.reason}\n` `` to stderr, `process.exit(2)`.
4. `publish` → when `decision.notice !== null`, write `` `${decision.notice}\n` `` to stderr, then
   call `publishContract({ outputDirectory: decision.outputDirectory, commit: facts.commit, tag: decision.tag })`.
5. Keep the `PublishRefusal` catch at `:136-142` unchanged.

Remove the `execFileSync` import at `:2`.

### `scripts/release-facts.ts` — bind the reads to the source tree

Amend the Story 2 signature to `readReleaseFacts(repositoryRoot: string): ReleaseFacts`. All three
`execFileSync` calls pass `{ cwd: repositoryRoot, encoding: "utf8" }`. The published documents and
the recorded commit then come from the same tree, so the script cannot be run from an unrelated
tagged repository and publish this repository's documents under that repository's tag.

## Constraints

- The self-publish refusal runs before the facts read, so its message and exit code do not depend on
  the working tree.
- The gate runs before `publishContract`, so a refused run creates and writes nothing in the output
  directory.
- Every message goes to stderr. Nothing goes to stdout.
- `cliDecision` stays pure. It never touches `process`.

## Verify

### `scripts/release-gate.test.ts` — new subtests

Add, in the same file Story 1 creates, one test per case, each with `assert.deepEqual` on the whole
decision object. `facts` is a literal; `version` is `"27.8.1"`.

- `["/out"]`, clean, `tags: ["v27.8.1"]` →
  `{ kind: "publish", outputDirectory: "/out", tag: "v27.8.1", notice: null }`
- `["--unreleased", "/out"]`, clean, `tags: []` →
  `{ kind: "publish", outputDirectory: "/out", tag: null, notice: "publishing an unreleased artifact" }`
- `["/out", "--unreleased"]`, clean, `tags: []` → the same object. Flag position does not matter.
- `["/out"]`, dirty, `tags: ["v27.8.1"]` → `{ kind: "refuse", reason: "dirty-tree" }`
- `["--unreleased", "/out"]`, dirty, `tags: []` → `{ kind: "refuse", reason: "dirty-tree" }`
- `["/out"]`, clean, `tags: []` → `{ kind: "refuse", reason: "untagged-commit" }`
- `[]`, clean, `tags: ["v27.8.1"]` → `{ kind: "usage" }`
- `["--unreleased"]`, clean, `tags: []` → `{ kind: "usage" }`
- `[""]`, clean, `tags: ["v27.8.1"]` → `{ kind: "usage" }`
- `["--tag", "/out"]`, clean, `tags: ["v27.8.1"]` → `{ kind: "usage" }`
- `["/out", "/second"]`, clean, `tags: ["v27.8.1"]` → `{ kind: "usage" }`

These assertions deliver the EPIC's "the refusal reaches the process" requirement at the decision
layer. Exit code and stderr text are one `switch` over `CliDecision` with no branch of its own.

### `scripts/publish-contract.test.ts` — edits

- `:52-101` — replace the subprocess invocation at `:55-62` with a direct library call:
  `publishContract({ outputDirectory: directory, commit: "0".repeat(40), tag: null })`. The dirty
  check applies in both modes, so no subprocess invocation of the publish path can pass on a
  developer tree. `cliDecision` covers the argument and gate wiring, and `readReleaseFacts` is the
  one unit the EPIC already accepts as untested. Every
  assertion in the subtest at `:64-99` stays unedited and still passes. The subprocess path is no
  longer needed here, because `cliDecision` covers the argument and gate wiring and
  `readReleaseFacts` is the one untested unit the EPIC already accepts as untestable.
- `:109-128` — the Story 3 key-order edits, plus `assert.equal(manifest.tag, null)` and
  `assert.equal(String(manifest.commit), "0".repeat(40))` in place of the `/^[0-9a-f]{40,64}$/` match,
  which the synthetic commit satisfies anyway but is now exactly known.
- `:130-135` — the Story 3 `dirty` absence assertion.
- `:184-210`, `:212-232`, `:276-280` — the Story 3 edits.
- New subtest, "a released manifest and an unreleased manifest of the same commit differ": publish
  twice into two temporary directories with `commit = "0".repeat(40)`, once with `tag: "v27.8.1"` and
  once with `tag: null`. Assert the two `manifest.json` byte buffers differ, and that every other
  written file is byte-identical between the two directories. This delivers the EPIC's
  "a development artifact is self-identifying" bullet on the full file set, not on the manifest alone.
- `:234-269` "refuses to publish into the repository" — unedited. Both invocations keep
  `cwd: repositoryRoot`, keep the relative `"."` case, and now pass on a dirty tree because the
  self-publish refusal runs before the facts read.
- `:290-303` "refuses to run with no output directory" — unedited, and it now also passes on a dirty
  tree, because `cliDecision` returns `usage` before any verdict.
- New subtest, "refuses an unknown flag": invoke the script with `["--tag", directory]` and
  `cwd: repositoryRoot`. Assert `error.status === 2` and `assert.equal(String(error.stderr), "usage: node scripts/publish-contract.ts [--unreleased] <output-directory>\n")`.
  This is the one subprocess test of the argument path, and it passes on any working tree.
- `:92` (34 examples) and `:71-88` (per-feature operation sets and `SwaggerParser.validate`) stay
  unedited.
- `:305-308` "writes no document into the repository root" stays unedited.

### Commands

- `node --test scripts/release-gate.test.ts scripts/publish-contract.test.ts` exits 0 **on a dirty
  working tree**. Run it with an uncommitted file present and confirm.
- `npm run verify` exits 0 on a dirty working tree.
- Proof: `scripts/release-gate.test.ts` and `scripts/publish-contract.test.ts` in the EPIC Proof
  block.
