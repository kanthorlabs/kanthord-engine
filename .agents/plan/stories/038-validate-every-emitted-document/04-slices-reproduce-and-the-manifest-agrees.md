# Story 4 — Two emissions of every slice produce identical bytes, and the manifest agrees with the file list

Epic: `.agents/plan/epics/038-validate-every-emitted-document.md`
Depends on: Story 1 — it adds the `openApiFeatures` import the first test uses.
Depends on: Story 3 — Edit 1's insertion anchor is the test Story 3 added.

**Test only.** This story edits two files, `src/http/contract/openapi.test.ts` and
`scripts/publish-contract.test.ts`, and changes no production file.
`scripts/lane-check.sh:72-83` puts the first in the test-engineer lane, and
`scripts/lane-check.sh:85-91` puts a `*.test.ts` under `scripts/` in the test-engineer lane and denies
it to the software-engineer.

**The failure-mode proofs of this story mutate the test file, never a production file.**
`scripts/lane-check.sh test-engineer src/http/contract/openapi.ts` denies the path with
`production source is not the test-engineer lane`, and
`scripts/lane-check.sh test-engineer scripts/publish-contract.ts` denies it with
`scripts are the software-engineer lane`. A scratch edit that is reverted before the commit is still
outside the lane while it exists, so every mutation below changes a value the test reads rather than
the code that produces it.

**There is no RED step against the product.** Both properties already hold. This was verified before
the story was written: all 19 slices render byte-identically across two calls, and `publishContract`
returns exactly the 19 `features/*.yaml` and 43 `examples/*.json` entries the manifest names.

The RED signal is the failure modes of the `## Verify` section.

## Change

Two edits, in two files. Either order.

### Edit 1 — per-slice byte reproducibility, in `src/http/contract/openapi.test.ts`

Add one test immediately after the test Story 3 added, and before
`"is never committed to the repository root"`. Add no import.

```ts
test("renders every feature slice to identical bytes twice", () => {
  const features = openApiFeatures();
  assert.equal(features.length, 19);
  for (const feature of features) {
    assert.equal(
      compare(
        renderOpenApiYaml(feature.operations),
        renderOpenApiYaml(feature.operations),
      ),
      0,
      `${feature.name}.yaml differs between two renders`,
    );
  }
});
```

Four points.

- **`compare` is the module-private function at `openapi.test.ts:24-26`.** It is exactly
  `Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))`, which is the comparison the EPIC
  prescribes. Reuse it. Do not write a second one, and do not use `assert.equal` on the two strings —
  the EPIC requires the byte comparison, and a string comparison would not report a difference in
  encoding.
- **`19` is asserted by value**, so a twentieth feature cannot slip past the loop.
- **The message names the slice.** With 19 slices, `0 !== 1` alone does not say which one drifted.
- **The master's own reproducibility stays where it is.** `openapi.test.ts:531`,
  `"renders canonical yaml"`, already asserts `yaml === renderOpenApiYaml()` for the master. Do not
  move it, do not fold the master into this loop, and do not change it to use `compare`.

### Edit 2 — the manifest agrees with the returned file list, in `scripts/publish-contract.test.ts`

Add one subtest inside the top-level `test("scripts/publish-contract", async (t) => {` block that opens
at line 65. Place it immediately after `"the manifest carries no timestamp"`, which ends at line 151,
and before `"each example file holds its keys in the fixed order"` at line 153.

```ts
await t.test("the manifest names exactly the files that were written", () => {
  const own = mkdtempSync(join(tmpdir(), "kanthord-contract-manifest-"));
  try {
    const written = publishContract({
      outputDirectory: own,
      commit: "0".repeat(40),
      tag: null,
    });
    const published = JSON.parse(
      readFileSync(join(own, "manifest.json"), "utf8"),
    ) as { features: string[]; operations: string[] };

    const writtenFeatures = written.filter((relative) =>
      relative.startsWith(`features${sep}`),
    );
    const writtenExamples = written.filter((relative) =>
      relative.startsWith(`examples${sep}`),
    );
    const manifestFeatures = published.features.map((name) =>
      join("features", `${name}.yaml`),
    );
    const manifestExamples = published.operations.map((id) =>
      join("examples", `${id}.json`),
    );

    assert.equal(writtenFeatures.length, 19);
    assert.equal(writtenExamples.length, 43);
    assert.deepEqual(
      manifestFeatures.filter((entry) => !writtenFeatures.includes(entry)),
      [],
    );
    assert.deepEqual(
      writtenFeatures.filter((entry) => !manifestFeatures.includes(entry)),
      [],
    );
    assert.deepEqual(
      manifestExamples.filter((entry) => !writtenExamples.includes(entry)),
      [],
    );
    assert.deepEqual(
      writtenExamples.filter((entry) => !manifestExamples.includes(entry)),
      [],
    );
    assert.deepEqual(
      sortedBytewise(manifestFeatures),
      sortedBytewise(writtenFeatures),
    );
    assert.deepEqual(
      sortedBytewise(manifestExamples),
      sortedBytewise(writtenExamples),
    );
    assert.deepEqual(published.features, sortedBytewise(published.features));
    assert.deepEqual(
      published.operations,
      sortedBytewise(published.operations),
    );
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
});
```

Add `sep` to the `node:path` import at line 14:

```ts
import { join, sep } from "node:path";
```

Add nothing else. `mkdtempSync`, `readFileSync`, `rmSync` (lines 5-12), `tmpdir` (line 13),
`publishContract` (line 18) and the module-level `sortedBytewise` (lines 47-49) are all in place.

Nine points that fix this subtest exactly.

- **It publishes into its own `mkdtemp` directory, not the shared `directory` of line 60.** Two
  subtests writing the same tree couple their order. This is the convention the subtest at lines
  284-310 already follows: an own `mkdtempSync`, a `try`, and `rmSync` in `finally`.
- **`publishContract` returns `readonly string[]`** — the relative paths it wrote, sorted bytewise at
  `scripts/publish-contract.ts:117` by
  `written.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))`. Capture that return value.
  The subtest at line 67 discards it; that is what this story fixes.
- **The returned list holds four kinds of entry:** `openapi.yaml`, the 19 `features/*.yaml`, the 43
  `examples/*.json`, and `manifest.json`. Filter to the two prefixed kinds. The two unprefixed entries
  are outside this gate.
- **Build the expected paths with `join`, and filter with `sep`.** `publish-contract.ts:72` and `:94`
  build their relative paths with `join("features", ...)` and `join("examples", ...)`. Constructing the
  expected strings the same way, and testing the prefix with `sep`, keeps the comparison exact on any
  platform. Do not hardcode `"features/"`.
- **The manifest's own lists are the source of the expected paths.** `publish-contract.ts:103-109`
  writes `features: features.map((f) => f.name)` and
  `operations: publishedEntries.map((e) => e.operationId)`. This subtest maps each name and each id to
  its file path and compares against what was written. The existing subtest at line 120 compares those
  same two lists against `featureNames` and `publishedOperationIds`, both derived from the registry.
  The two subtests assert different things — registry agreement there, file-list agreement here — and
  both are required. Do not merge them.
- **Set equality is asserted in both directions, explicitly, for both kinds.** Four difference arrays,
  each asserted empty. That is the EPIC's requirement literally.
- **Sort BOTH sides in the two `deepEqual` calls.** The four `includes` checks above compare sets, so
  they cannot see a duplicate: a manifest that names one operation twice still has every name present
  in both directions. Sorting both arrays and comparing them turns the check into a multiset equality,
  which catches an omission, an extra and a duplicate in one assertion. Verified: appending a duplicate
  id to `manifest.operations` fails this assertion and passes all four set checks.
- **Do not sort one side and compare it against the unsorted other side.** An earlier draft of this
  story asserted `deepEqual(sortedBytewise(writtenExamples), manifestExamples)` — a _path_-bytewise sort
  against a _name_-bytewise sort mapped to paths. Those two orders are equal for today's id set and are
  not equal in general. If an id `A` is a proper dot-prefix of an id `B`, the comparison falls between
  `".json"` and `"." + <next segment of B>`, so any id extending `A` with a segment beginning below `j`
  reverses the order: `node.claim.abort.json` sorts before `node.claim.json` by path, while
  `node.claim` sorts before `node.claim.abort` by name. Verified: the registry holds zero such prefix
  pairs today among the 43 example ids and the 19 feature names, so the flawed form passes — by
  accident of the current id set. Sorting both sides removes the dependency entirely.
- **Pin the manifest's own order separately, against its own source.** `assert.deepEqual(published.features,
sortedBytewise(published.features))` and the same for `operations` is what "the manifest lists are
  bytewise" actually means, and it says so without borrowing an order from the file-path sort.
  `features` comes from `openApiFeatures()`, which sorts bytewise at `openapi.ts:35`; `operations` comes
  from `registry.filter(...)`, and the registry is sorted bytewise by `operationId` at
  `registry.ts:37-39`. Both lists are therefore already in bytewise order. Verified: reversing
  `manifest.operations` fails this assertion while all four set checks and both multiset checks pass,
  which is why it is a separate assertion and not redundant.
- **`19` and `43` are literals, asserted by value.** `43` is the count of registry entries with
  `examples !== undefined`, and `scripts/publish-contract.test.ts:103` already asserts it against the
  directory listing.

## Constraints

- **Edit two files. Add one test to each.** No other change to either.
- **Do not modify the subtest at line 120**, `"the manifest carries publication metadata and the
operation list"`. It stays as it is, including its key-order assertion and its regex.
- **Do not modify the subtest at lines 284-310**, `"generation is byte-identical across two runs"`. The
  EPIC states it stays as it is. It compares two publish directories file by file; the new
  `openapi.test.ts` test compares two renders of each slice. Both are required.
- **Do not modify `openapi.test.ts:531`**, `"renders canonical yaml"`.
- **Do not reuse the shared `directory` of `publish-contract.test.ts:60` in the new subtest.** Its own
  directory, removed in `finally`.
- **Do not add a `describe`.** `publish-contract.test.ts` uses one top-level `test` with `t.test`
  subtests; `openapi.test.ts` uses flat top-level `test` calls. Follow each file's own shape.
- **Change no production source.** `publishContract`, its return value and its sort stay exactly as
  they are. If the assertion fails, the manifest or the writer is wrong, and that is a finding to
  report — not a reason to weaken the test.
- **Add no dependency.**

## Verify

```bash
node --test src/http/contract/openapi.test.ts scripts/publish-contract.test.ts
```

Every test in both files passes.

Isolation check — run each new test alone. This proves neither needs a sibling's side effect; it does
not exercise a different ordering:

```bash
node --test --test-name-pattern='renders every feature slice to identical bytes twice' src/http/contract/openapi.test.ts
node --test --test-name-pattern='the manifest names exactly the files that were written' scripts/publish-contract.test.ts
```

Both pass in isolation.

Prove the five failure modes. **Every mutation is a scratch edit inside the test file itself — never a
production file.** `scripts/lane-check.sh test-engineer src/http/contract/openapi.ts` and
`scripts/lane-check.sh test-engineer scripts/publish-contract.ts` both deny the path, so a mutation
that edits the renderer or the publisher puts the test-engineer outside the lane even when it is
reverted before the commit. Mutate the value the test reads, not the code that produces it. Revert each
edit before the next.

- Make the slice comparison fire. In the new `openapi.test.ts` test, temporarily change the second
  argument to `renderOpenApiYaml(feature.operations).replace("openapi", "openApi")`. The test fails and
  its message names the first slice. Verified: the mutated pair fires, the unmutated pair passes. This
  mutation touches only the new test, so no other test in the file changes behaviour — which is what an
  edit to `renderOpenApiYaml` could not promise, because it would also break
  `"renders canonical yaml"` at `openapi.test.ts:531` and make the run's failure ambiguous.
- Drop a feature from the manifest. In the new `publish-contract.test.ts` subtest, insert
  `published.features.pop();` immediately after the `JSON.parse` line. The subtest fails on the
  `writtenFeatures` difference direction — a file was written that the manifest omits. Verified.
- Add a feature the publisher did not write. Replace that line with
  `published.features.push("ghost");`. The subtest fails on the `manifestFeatures` difference
  direction. This is the opposite direction, and both must be observed. Verified.
- Duplicate an operation. Use `published.operations.push(published.operations[0]!);`. All four set
  checks pass and the `sortedBytewise` multiset comparison fails. Verified. This is the proof that
  sorting both sides is not redundant with the set checks.
- Break the manifest order. Use `published.operations.reverse();`. The four set checks and both
  multiset comparisons pass, and `assert.deepEqual(published.operations, sortedBytewise(published.operations))`
  fails. Verified. This is the proof that the order assertion is not redundant either.

Confirm no production file moved:

```bash
git diff --name-only -- src/http/contract/openapi.ts scripts/publish-contract.ts
```

names nothing.

The full EPIC Proof block:

```bash
node --test \
  src/http/contract/openapi.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/registry.test.ts \
  src/http/contract/coverage.test.ts \
  src/http/contract/parity.test.ts \
  src/http/contract/path.test.ts \
  src/http/contract/event-payload.test.ts \
  scripts/publish-contract.test.ts \
  scripts/release-gate.test.ts \
  scripts/release-facts.test.ts \
  && echo "PASS EPIC-038"
```

prints `PASS EPIC-038`.

The publish path, which the Proof omits because it writes outside the repository:

```bash
npm run contract:publish -- "$(mktemp -d)"
```

exits 0.

The master's bytes are unchanged by the whole epic. Run the epic-wide scope check once, after this
story lands — path-scoped, because other agents edit `.agents/plan/**` in this tree concurrently, and
based on a pinned commit rather than a placeholder:

```bash
git diff --name-only "$(git merge-base HEAD main)"..HEAD -- src scripts test docs
```

names only `src/http/contract/openapi.test.ts` and `scripts/publish-contract.test.ts`. No production
source changed across the four stories, so `renderOpenApiYaml()` returns the same string as before the
epic. This gate bullet is discharged by that diff, not by an assertion — it is the one gate bullet no
test covers.

Hermetic check: no network, no clock, no ambient git configuration. Each new temporary directory is
removed in `finally`.

```bash
grep -c 'mkdtempSync' src/http/contract/openapi.test.ts
```

reports `1`.

`npm run verify` exits 0.

Proof: this story delivers the `scripts/publish-contract.test.ts` clause and the `PASS EPIC-038` line
of the EPIC Proof block. It delivers the gate bullets **Two emissions produce identical bytes for every
emitted file** and **`manifest.json` names exactly the features and operations that were written. The
19 feature names map one to one onto the emitted `features/*.yaml` files, and the 43 operation ids map
one to one onto the emitted `examples/*.json` files. The equality is asserted in both directions.**
