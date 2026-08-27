# Story 6 — `manifest.json` names the modular form

Epic: `.agents/plan/epics/039-the-modular-source-ref-tree.md`
Depends on: Story 3 — the manifest must not name a form the publish does not write.

**Two lanes.** `scripts/publish-contract.ts` and `docs/proposal/api/README.md` are the
software-engineer lane (`scripts/lane-check.sh:87-94` and `:99-101`).
`scripts/publish-contract.test.ts` is the test-engineer lane (`scripts/lane-check.sh:88-89`).

## Change

### Edit the manifest object at `scripts/publish-contract.ts:103-109`

Add one field, `source`, after `tag` and before `features`:

```ts
const manifest = {
  version: KANTHORD_VERSION,
  commit: input.commit,
  tag: input.tag,
  source: "source/openapi.yaml",
  features: features.map((feature) => feature.name),
  operations: publishedEntries.map((entry) => entry.operationId),
};
```

The value is the literal string `"source/openapi.yaml"` — the path of the modular root relative to
the publication directory, with forward slashes. It is not built from `join`, because `join` emits a
backslash on Windows and the manifest is a wire value a consumer reads.

`JSON.stringify` preserves insertion order for a string key, so the emitted key order is
`version`, `commit`, `tag`, `source`, `features`, `operations`. Change nothing else in the file.

### Amend `docs/proposal/api/README.md`

One bullet, in the `### The release gate` list. It is today line 30 and it reads:

```
- `manifest.json` holds `version`, `commit`, `tag`, `features` and `operations`, in that order. It holds no `dirty` field.
```

Replace it with:

```
- `manifest.json` holds `version`, `commit`, `tag`, `source`, `features` and `operations`, in that order. It holds no `dirty` field. `source` is the relative path of the modular root, `source/openapi.yaml`, so a consumer discovers the second form without a guess.
```

Find the bullet by its opening text, not by its line number. EPIC 037 rewrites lines 13-21 of this
file and Story 1 of this epic inserts a block after line 21, so this bullet has moved by the time
this story runs.

Run `npx prettier --write docs/proposal/api/README.md` afterwards.

### Extend `scripts/publish-contract.test.ts`

Four edits. The first three are inside the subtest that reads the manifest; the fourth is a new
subtest.

1. **The key-order assertion at `:128-134`** — add `"source"` after `"tag"`:

   ```ts
   assert.deepEqual(Object.keys(manifest), [
     "version",
     "commit",
     "tag",
     "source",
     "features",
     "operations",
   ]);
   ```

2. **The raw-JSON order assertion at `:138-141`** — add `"source"` in position:

   ```ts
   assert.match(
     raw,
     /"version"[\s\S]*"commit"[\s\S]*"tag"[\s\S]*"source"[\s\S]*"features"[\s\S]*"operations"/,
   );
   ```

3. **Assert the value, and that it points at a file that exists.** Add, in the same subtest:

   ```ts
   assert.equal(manifest.source, "source/openapi.yaml");
   assert.equal(existsSync(join(directory, manifest.source)), true);
   ```

   The second assertion is what stops the manifest naming a form the publish stopped writing. Widen
   the local manifest type to carry `source: string` if the subtest declares one.

4. **Pin the manifest against the returned file list, in this story rather than by inspection.** EPIC
   038 Story 4 adds a two-way set equality between the manifest lists and the returned `features/`
   and `examples/` entries. Whether it filters `written` by prefix is not knowable from here, so do
   not write a conditional instruction. Add this subtest unconditionally, which states the required
   relation and fails if the EPIC 038 subtest drifted from it:

   ```ts
   const written = publishContract({
     outputDirectory: directory,
     commit: "0".repeat(40),
     tag: null,
   });
   const manifest = JSON.parse(
     readFileSync(join(directory, "manifest.json"), "utf8"),
   ) as { source: string; features: string[]; operations: string[] };

   assert.deepEqual(
     sortedBytewise(written.filter((name) => name.startsWith("features/"))),
     sortedBytewise(manifest.features.map((name) => `features/${name}.yaml`)),
   );
   assert.deepEqual(
     sortedBytewise(written.filter((name) => name.startsWith("examples/"))),
     sortedBytewise(manifest.operations.map((id) => `examples/${id}.json`)),
   );
   assert.equal(
     written.includes(`source/${manifest.source.slice("source/".length)}`),
     true,
   );
   ```

   The first two assertions are the set equality, written with the prefix filter that makes it true
   in the presence of `source/` entries. The third ties the manifest's `source` value to an entry the
   publish actually returned. If EPIC 038 already added an equivalent unfiltered subtest, it now
   fails, and repairing it — by adding the same prefix filter — is part of this story.

## Constraints

- **Add one field, in one position. Change nothing else in the manifest.** No `dirty` field, no
  reordering, no rename.
- **The value is a hardcoded forward-slash string.** Do not compute it with `join` or `relative`, and
  do not derive it from the map keys of `buildOpenApiSourceTree`. A separator that varies by platform
  is a wire-format defect.
- **Do not touch `scripts/publish-contract.ts:117`.** The sort of `written` is unrelated.
- **The manifest gains no list of the `source/` files.** One field naming the root is the decision;
  a consumer follows the references from there.
- **Anchor the README edit by the quoted bullet text.** The line number has moved.
- **Keep the assertion at `scripts/publish-contract.test.ts:75-80` as Story 3 left it.** It already
  names `"source"`; do not touch it here.

## Verify

```bash
node --test scripts/publish-contract.test.ts scripts/release-gate.test.ts scripts/release-facts.test.ts
```

`publish-contract.test.ts` passes, including the amended key-order assertion, the amended regex and
the two new value assertions. The two release tests pass unchanged — neither reads the manifest.

```bash
node --test scripts/publish-contract.source.test.ts
```

Passes unchanged — the manifest is not under `source/` and its bytes are not compared there.

Read the manifest by hand:

```bash
OUT=$(mktemp -d)
node scripts/publish-contract.ts --unreleased "$OUT" >/dev/null
cat "$OUT/manifest.json" | head -6
test -f "$OUT/$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]+"/manifest.json","utf8")).source)' "$OUT")" \
  && echo "manifest source resolves"
rm -rf "$OUT"
```

prints the first six lines with `"source": "source/openapi.yaml"` fourth, and
`manifest source resolves`.

Prove the two failure modes:

- Move `source` after `features` in the manifest object. Both the key-order assertion and the regex
  fail.
- Change the value to `"source/root.yaml"`. `assert.equal(manifest.source, "source/openapi.yaml")`
  fails, and the `existsSync` assertion fails too.

Scope check:

```bash
git diff --name-only HEAD -- scripts docs/proposal
```

names exactly `scripts/publish-contract.ts`, `scripts/publish-contract.test.ts` and
`docs/proposal/api/README.md`.

The gate's renderer clause:

```bash
git diff --quiet HEAD -- \
  src/domain \
  $(git ls-files 'src/http/contract/*.ts' | grep -v '\.test\.ts$' | grep -v 'openapi-source\.ts$') \
  && echo "master renderer inputs unchanged"
```

exits 0. This story edits no module `renderOpenApiYaml` reads, so the published master and every
slice keep the bytes they hold today.

The full EPIC Proof block prints `PASS EPIC-039`, and:

```bash
OUT=$(mktemp -d); node scripts/publish-contract.ts --unreleased "$OUT"; echo "exit $?"; rm -rf "$OUT"
```

prints `exit 0` and writes both forms.

`npm run verify` exits 0.

Proof: this story delivers the `scripts/publish-contract.test.ts` clause of the EPIC Proof block,
extended. It delivers the gate bullet **`manifest.json` names the modular form**, with the value
`"source/openapi.yaml"` and the key order `version`, `commit`, `tag`, `source`, `features`,
`operations`.
