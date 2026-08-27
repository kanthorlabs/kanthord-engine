# Story 3 — No emitted document holds a `$ref` outside `#/`

Epic: `.agents/plan/epics/038-validate-every-emitted-document.md`
Depends on: Story 1 — it adds the `emitEveryDocument` helper this test calls.
Depends on: Story 2 — this story's insertion anchor is the last test Story 2 added.

**Test only.** This story edits one file, `src/http/contract/openapi.test.ts`, and changes no
production file. `scripts/lane-check.sh:72-83` puts it in the test-engineer lane.

**There is no RED step against the product.** All 20 emitted documents already carry internal
references only. This was verified before the story was written: the master emits 129 `$ref` values and
the 19 slices emit 129 between them, every one of them prefixed `#/components/schemas/`, and no slice
emits zero.

The RED signal is the failure mode of the `## Verify` section: inject an external `$ref` into one
emitted file and watch the test name it.

## Change

Edit `src/http/contract/openapi.test.ts`. Add one test immediately after the two tests Story 2 added,
and before `"is never committed to the repository root"`. Add `readFileSync` to nothing — it is already
imported at line 11. Add no import at all: `YAML` is at line 6, `readFileSync` at line 11, `basename`
is not needed.

```ts
test("emits no $ref outside the document", () => {
  const paths = emitEveryDocument();
  assert.equal(paths.length, 20);
  let total = 0;
  for (const path of paths) {
    const refs: string[] = [];
    collectRefs(YAML.parse(readFileSync(path, "utf8")), refs);
    assert.ok(refs.length > 0, `${path} carries no $ref at all`);
    for (const ref of refs) {
      assert.ok(
        ref.startsWith("#/components/schemas/"),
        `external or malformed $ref ${ref} in ${path}`,
      );
    }
    total += refs.length;
  }
  assert.ok(total > 0, "the walk collected no $ref at all");
});
```

Six points that fix this test exactly.

- **It calls `emitEveryDocument()` itself and does not read files another test wrote.**
  `renderOpenApiYaml` is deterministic, so the call overwrites the same 20 files with the same bytes.
  This is what makes the test order-independent. A test that reads a sibling test's side effect is a
  non-deterministic test and a planning defect.
- **It parses the emitted YAML, not the in-memory object.** The existing test at
  `openapi.test.ts:512`, `"refers to components only through internal refs"`, already walks
  `buildOpenApiDocument()`. The value this test adds is the round trip through
  `renderOpenApiYaml` → file → `YAML.parse`. Do not replace `YAML.parse(readFileSync(...))` with a call
  to `buildOpenApiDocument` — that duplicates line 512 and asserts nothing new.
- **It reuses `collectRefs`, the module-private function at `openapi.test.ts:603-620`.** Its signature
  is `collectRefs(value: unknown, refs: string[]): void`; it walks arrays and objects recursively and
  pushes every string value found under a `$ref` key. Do not write a second walker, and do not export
  it.
- **The non-zero assertion is per document, not only in aggregate.** `assert.ok(refs.length > 0, ...)`
  inside the loop is stronger than the EPIC's `total > 0`: it makes a slice that stopped referencing its
  components a failure, where an aggregate check would let 18 slices cover for it. This was verified
  possible — no slice emits zero refs today. The aggregate `total > 0` is kept as well, per the EPIC.
- **The prefix asserted is `#/components/schemas/`, not `#/`.** That is the prefix the existing test at
  line 518 asserts, and it is the only reference form the emitter produces. `#/` alone would admit
  `#/paths/...`, which the product does not emit and must not start emitting silently.

  **This is the second of two deliberate strengthenings of the EPIC text, and both are recorded here so
  a reviewer does not read either as drift.** The EPIC's story bullet says
  "asserts every value starts with `#/components/schemas/`", which this matches; its Decisions and its
  gate bullet both say the looser "outside `#/`". The story follows the bullet, which is the more
  specific instruction and the stronger assertion. The first strengthening is the per-document non-zero
  count in the bullet above. Neither changes what the product emits, and both were verified to hold.
  If Ulrich prefers the looser gate wording, the change is one string literal in this test.

- **The message names the path as well as the ref.** With 20 documents in the walk, a message naming
  only the ref does not say which document broke.

`assert.equal(paths.length, 20)` repeats Story 1's count assertion on purpose: this test's coverage
claim is "all 20 emitted documents", and without the count the loop could walk 19 and pass.

## Constraints

- **Edit one file, and add only this test.**
- **Do not modify the test at line 512**, `"refers to components only through internal refs"`. It walks
  the in-memory master and stays as it is. The two tests cover different objects.
- **Do not modify `collectRefs`.** Reuse it unchanged. It has no export and must keep none.
- **Do not modify `emitEveryDocument`.** Story 1 owns it. If it needs a change, that is a defect in
  Story 1, not an edit here.
- **Do not add a temporary directory.** The helper writes into `openApiDirectory`, which the `after`
  hook at lines 62-64 removes.
- **Do not filter the collected refs before asserting.** Every value `collectRefs` returns reaches the
  prefix assertion. A filter that drops a value that "does not look like a ref" is exactly the value
  this test exists to report.
- **Change no production source, and add no dependency.**

## Verify

```bash
node --test src/http/contract/openapi.test.ts
```

Every test passes.

Isolation check — run it alone. It proves the test needs no sibling's side effect, not that a
different ordering was exercised:

```bash
node --test --test-name-pattern='emits no \$ref outside the document' src/http/contract/openapi.test.ts
```

It passes in isolation.

Prove the three failure modes. Each is a scratch edit — revert it before the next.

- Inject an external reference. Temporarily change the slice write inside `emitEveryDocument` to
  `writeFileSync(path, renderOpenApiYaml(feature.operations).replace("#/components/schemas/Error", "./common.yaml#/Error"), "utf8")`.
  The test fails with `external or malformed $ref ./common.yaml#/Error in <path>`, and the path names a
  slice file. This is the mode EPIC 039 will legitimately introduce elsewhere, and this test is the gate
  that says it did not happen here.
- Inject a sibling-document reference that is internal-looking but not a component:
  replace `"#/components/schemas/Error"` with `"#/paths/~1v1~1health"`. The test still fails, because
  the asserted prefix is `#/components/schemas/`, not `#/`.
- Force an empty walk. Temporarily change the loop body to
  `collectRefs({}, refs);`. The test fails on `<path> carries no $ref at all`. This is the proof that
  an empty walk cannot pass, which is the EPIC's explicit requirement.

Confirm the walk actually covers 20 documents rather than short-circuiting: change the `20` to `19` and
observe the count assertion fail before any file is read.

Hermetic check: no network, no clock, no ambient git configuration, no new temporary directory.

```bash
grep -c 'mkdtempSync' src/http/contract/openapi.test.ts
```

reports `1`.

Scope check, scoped to the source tree because other agents may be editing `.agents/plan/**`
concurrently:

```bash
git status --porcelain -- src scripts test docs
```

names exactly one file, `src/http/contract/openapi.test.ts`.

`npm run verify` exits 0.

Proof: this story delivers the `src/http/contract/openapi.test.ts` clause of the EPIC Proof block. It
delivers the gate bullet **No emitted document holds a `$ref` outside `#/`. The walk covers all 20
emitted files, and it asserts a non-zero ref count so an empty walk cannot pass.** It is the mechanism
the EPIC promises for `AGENTS.md:105`, and the `AGENTS.md` row that names it is Ulrich's to apply — see
the EPIC's `## Open items` S1.
