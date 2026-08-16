# Story 2 — The manifest checker and the runner option pair

Epic: `.agent/plan/epics/025-external-drive-acceptance-run.md`
Depends on: Story 1.

This is the second half of the EPIC bullet at `025-external-drive-acceptance-run.md:125`. It lands `recordManifest`, `checkManifest` and the two runner options. **This is the code deliverable `npm run verify` gates**, per `025-external-drive-acceptance-run.md:28`.

**`--record-manifest` refuses a second write for one tag.** See "The settled write rule" below.

## Change

### `scripts/e2e/lib/record/manifest.ts`

```ts
export type ManifestFailure = Readonly<{
  code: RunnerErrorCode;
  reason: string;
}>;

export type RecordManifestInput = Readonly<{
  tag: string;
  manifestFile: string;
}>;

export type RecordManifestDependencies = Readonly<{
  readCommit(): Promise<string>;
  readProposalRevision(): Promise<string>;
}>;

export async function recordManifest(
  dependencies: RecordManifestDependencies,
  input: RecordManifestInput,
): Promise<Manifest>;

export async function checkManifest(
  tag: string,
): Promise<readonly ManifestFailure[]>;
```

#### Structural validation, before any check

`JSON.parse` returns `unknown`. **`checkManifest` must never throw**, so it validates shape before it reads a field. Add one internal total function:

```ts
function parseManifestShape(value: unknown): Manifest | null;
```

It returns `null` unless **every** one of these holds, checked in this order and short-circuiting on the first failure: the value is a non-null object and not an array; `schemaVersion` is a number; `tag`, `commit` and `proposalRevision` are strings; `scenarios` is an array whose every element is a non-null non-array object with a string `id`, `bundlePath`, `sha256` and `outcome`; `checklist` is an array whose every element is a non-null non-array object with a number `row`, a string `subject`, a string `answer` and a string `note`; `report` is a non-null non-array object with a string `path`, a string `sha256` and a number `bytes`; `findings` is an array whose every element is a non-null non-array object with a string `id`, `action`, `name` and `description`, and a `fixEpic` that is a string or `null`; `outcome` is a string. **An out-of-range enum value is not a shape fault** — `answer`, `action` and `outcome` are validated as strings here and by value in the checks below, so a bad value yields a named failure rather than a shape rejection.

Apply the same discipline to a bundle: one internal `parseBundleShape(value: unknown): { tag: string; scenarioId: string; commit: string; outcome: string } | null`, total over `unknown`.

#### `recordManifest`

**A second write for one tag is refused.** Before anything else, check `manifestRecordPath(input.tag)` through the `exists` helper of `scripts/e2e/lib/record/acceptance.ts:70-77`, and raise `RunnerError("tag-reused", "tag <tag> already holds a manifest")` when it is present. This is the pre-check shape of `acceptance.ts:96-101`, not an open flag, so the existing file is never touched and the runner exits `2`.

Read `input.manifestFile`; an ENOENT raises `RunnerError("invalid-argument", "--manifest <path> does not exist")` with `<path>` substituted, mirroring `scripts/e2e/lib/record/acceptance.ts:108-113`. Invalid JSON raises `RunnerError("invalid-argument", "--manifest <path> is not valid JSON")`. A shape the `parseManifestShape` predicate rejects raises `RunnerError("invalid-argument", "--manifest <path> is not a manifest")`. Validate the source **before** calling either dependency, so a bad input file spends no `git` call.

It then stamps `schemaVersion: manifestSchemaVersion`, `tag: input.tag`, `commit` and `proposalRevision` from its dependencies, over whatever the source file carries. It keeps `scenarios`, `checklist`, `report`, `findings` and `outcome` verbatim. It then `mkdir(runDirectory(tag), { recursive: true })` and writes `serializeManifest(record)` to `manifestRecordPath(tag)`.

#### `checkManifest`

Read `manifestRecordPath(tag)`. Use the `readRecordJson` shape of `verdict.ts:45-57`, then `parseManifestShape`. Three terminal cases, each returning a **single-element** list immediately:

| Condition                        | Code               | Reason                                             |
| -------------------------------- | ------------------ | -------------------------------------------------- |
| the file is absent or unreadable | `unavailable`      | `tag <tag> has no manifest`                        |
| the text is not valid JSON       | `assertion-failed` | `manifest.json at <path> is not valid JSON: <msg>` |
| the value is not a manifest      | `assertion-failed` | `manifest.json at <path> is not a manifest`        |

Then run the seven check classes **in this order**, appending to one list. Every position index in a reason is **zero-based**.

**Class 1 — identity.** Append `assertion-failed` when `manifest.tag !== tag`, reason `the manifest names tag <manifest.tag>; the run tag is <tag>`. Append `assertion-failed` when `manifest.schemaVersion !== manifestSchemaVersion`, reason `the manifest names schema version <n>; this runner writes <m>`. Append `assertion-failed` when `manifest.outcome` is not a member of `manifestOutcomes`, reason `the manifest outcome <value> is not passed or failed`. Continue to class 2 in every case.

**Class 2 — scenario order.** Compare `manifest.scenarios.map((s) => s.id)` with `declaredScenarioOrder` by index, from zero. On the **first** index that differs append one `assertion-failed` and **stop this class**:

- both present: `scenario position <i> is <actual>; the declared order names <expected>`;
- the manifest is short at `<i>`: `scenario position <i> is absent; the declared order names <expected>`;
- the manifest is long at `<i>`: `scenario position <i> is <actual>; the declared order ends at position <n>`.

Continue to class 3 whether or not this class failed.

**Class 3 — bundle identity, digest and outcome.** For each entry of `manifest.scenarios` **in array order**, run these steps and take the first failure of the entry as terminal **for that entry only**, then continue with the next entry:

1. read `entry.bundlePath`; absent or unreadable gives `unavailable`, reason `the bundle at <path> is absent`; **skip the rest of this entry**;
2. `digestOf(bytes) !== entry.sha256` gives `assertion-failed`, reason `the bundle at <path> digests to <actual>; the manifest records <expected>`; **skip the rest of this entry**, because a mismatched file makes every later field of it untrustworthy;
3. the bytes do not parse as JSON, or `parseBundleShape` rejects them, gives `assertion-failed`, reason `the bundle at <path> is not a bundle`; **skip the rest of this entry**;
4. `bundle.tag !== tag` gives `assertion-failed`, reason `the bundle at <path> names tag <bundle.tag>; the run tag is <tag>`; **continue this entry**;
5. `bundle.scenarioId !== entry.id` gives `assertion-failed`, reason `the bundle at <path> names scenario <bundle.scenarioId>; the manifest names <entry.id>`; **continue this entry**;
6. `bundle.outcome !== entry.outcome` gives `assertion-failed`, reason `the bundle at <path> reports <bundle.outcome>; the manifest records <entry.outcome>`; **continue this entry**;
7. `bundle.commit !== manifest.commit` gives `assertion-failed`, reason `the bundle at <path> is on commit <bundle.commit>; the manifest names <manifest.commit>`.

Steps 4 to 7 each append at most one failure and all four run, so one bundle can raise four failures in that order.

**This class is why the story exists.** `RawBundle` at `verdict.ts:27` reads `commit` and `outcome` only, so a bundle copied from another tag or another scenario passes the verdict at the expected path. `Bundle` at `scripts/e2e/lib/bundle.ts:39-60` carries `tag` and `scenarioId`, and `serializeBundle` at `:234-259` emits both, so the checker reads them and no runner change is needed elsewhere. Step 6 closes the second half of the same hole: without it a bundle may report `failed` while its manifest row claims `passed`, and class 7 below would never see it.

**Class 4 — checklist.** Append `assertion-failed` when `manifest.checklist.length !== 6`, reason `the checklist holds <n> rows; six are required`, then **continue** into the per-row loop over whatever rows exist. For each row in array order, at most two failures: `row.answer` outside `checklistAnswers` gives `assertion-failed`, reason `checklist row <row.row> answers <value>; confirmed or rejected is required`; and a row answering `rejected` whose `note.trim()` is empty gives `assertion-failed`, reason `checklist row <row.row> is rejected and carries no note`. A row failing the first check does not run the second.

**Class 5 — report.** Read `manifest.report.path`. Absent or unreadable gives `unavailable`, reason `the report at <path> is absent`, and **skips the rest of this class**. Otherwise append, in this order and **independently**, at most three failures: `bytes.length === 0` gives `assertion-failed`, reason `the report at <path> is empty`; `bytes.length !== manifest.report.bytes` gives `assertion-failed`, reason `the report at <path> is <actual> bytes; the manifest records <expected>`; `digestOf(bytes) !== manifest.report.sha256` gives `assertion-failed`, reason `the report at <path> digests to <actual>; the manifest records <expected>`. A zero-byte report therefore raises three failures, and that is intended: each names a different broken fact.

**Class 6 — findings.** For each finding in array order, `finding.id.startsWith("B")` and a `fixEpic` that is `null` or trims to empty gives `assertion-failed`, reason `finding <id> is a blocker and names no fix epic`. One failure per finding.

**Class 7 — outcome consistency.** Only when `manifest.outcome === "passed"`. Append one `assertion-failed` for **every** scenario entry whose `outcome !== "passed"`, in array order, reason `the manifest outcome is passed; scenario <id> reports <outcome>`. Then append one for **every** checklist row answering `rejected`, in row order, reason `the manifest outcome is passed; checklist row <n> is rejected`. Report every mismatch, never the first alone, so one run names every reason it cannot pass.

### `scripts/e2e/lib/main.ts`

Accumulators, boolean flag, allowlist and value dispatch:

- `:96-104` — add `let recordManifestRequested = false;`, `let manifestFile: string | undefined;`, `let checkManifestTag: string | undefined;`.
- `:123-127` — add a boolean block for `--record-manifest`, in the shape of `--record-acceptance`.
- `:135-145` — add `token !== "--manifest"` and `token !== "--check-manifest"` to the value-flag allowlist.
- `:174-190` — add `else if (token === "--manifest") { manifestFile = value; }` and an `else if (token === "--check-manifest")` branch that applies `tagPattern` exactly as the `--verdict` branch at `:177-184` does. **A repeated option is last-wins**, which is the behaviour every existing value flag already has; add no first-wins special case and no duplicate refusal.

#### The existing guard blocks must reject the new flags

**This is not optional and it is the sharpest failure mode of this edit.** `parseArguments` is a sequence of guard blocks that each `return`. The `--verdict` block at `:359-380` returns before any block added after it, so a `--check-manifest` guard placed at the end is **unreachable** for `--verdict t1 --check-manifest t1`, and the second option is silently ignored. Every earlier block must therefore reject the new flags itself.

Add these rejections to the **existing** blocks, each raising `invalid-argument`:

| Existing block, at line       | Add a rejection for                                           |
| ----------------------------- | ------------------------------------------------------------- |
| `--mint-tag`, `:193`          | `recordManifestRequested`, `manifestFile`, `checkManifestTag` |
| `--record-verify`, `:234`     | `recordManifestRequested`, `checkManifestTag`                 |
| `--record-acceptance`, `:266` | `recordManifestRequested`, `checkManifestTag`                 |
| `--verdict`, `:359`           | `recordManifestRequested`, `checkManifestTag`                 |
| `--reclaim`, `:389`           | `recordManifestRequested`, `checkManifestTag`                 |

Each message follows the house form, for example `--verdict is mutually exclusive with --check-manifest`.

New blocks:

- The `--record-manifest` guard goes **after** the `--record-acceptance` block at `:343` and **before** the orphan sweep at `:345`. It rejects a positional scenario id, `--reclaim`, `--record-verify`, `--record-acceptance`, `--verdict` and `--check-manifest`; it needs `--tag`; it needs `--manifest`. It returns `{ recordManifest: { tag, manifestFile } }`.
- Add `["--manifest", manifestFile]` to the orphan sweep at `:345-357`, message `--manifest applies to --record-manifest only`.
- The `--check-manifest` guard goes after the `--verdict` block at `:380`. It rejects a positional scenario id, `--tag` and `--reclaim`. It returns `{ checkManifestTag }`.
- `:57-85` — add `RecordManifestInvocation = Readonly<{ recordManifest: RecordManifestInput }>` and `CheckManifestInvocation = Readonly<{ checkManifestTag: string }>` to the `Invocation` union.

In `main`, add two branches beside `:561-584`. The `recordManifest` branch calls `recordManifest(createDefaultRecordDependencies(), invocation.recordManifest)` and returns `0`. The `checkManifest` branch mirrors the verdict branch at `:569-584` line for line: one stderr line per failure as `` `e2e: manifest: ${failure.reason}\n` ``, `0` on an empty list, otherwise `exitCodeFor(failures[0].code)`.

**No member is added to `RunnerErrorCode`.** `exitCodeFor` at `main.ts:460-470` is an exhaustive switch with no `default`, and this story leaves it untouched.

## The settled write rule

**`--record-manifest` refuses a second write for one tag.** Ulrich decided this on 2026-08-14, and no story revisits it.

The EPIC fixes the refusal for the acceptance record at `025-external-drive-acceptance-run.md:129` and `acceptance.ts:96-100`, and it says nothing about the manifest. The manifest takes the same rule for three reasons: it follows the only precedent in `scripts/e2e/lib/record/`; it makes the ledger as immutable as the signature it sits beside; and a refusal is the recoverable error, while a silent overwrite destroys the evidence of the run it describes.

The cost is accepted: **a corrected checklist row costs a new tag**, and a new tag repeats every story of this epic, six container image builds and the real-forge run included, per `025-external-drive-acceptance-run.md:171`. Write the checklist rows once, after the human gate of Story 12 answers all six.

There is **no `--force`**. `025-external-drive-acceptance-run.md:241` authorises one runner option pair, and a third option is a scope change this epic does not take.

## Constraints

- Edit no file under `src/` and no file under `docs/proposal/`.
- **Edit `scripts/e2e/lib/main.test.ts` not at all.** `025-external-drive-acceptance-run.md:241` permits three files plus the `main.ts` option pair, and `main.test.ts` is a fifth file. Every parser test of this story lives in `scripts/e2e/lib/record/manifest.test.ts`, which imports `parseArguments`, `main` and `exitCodeFor` from `../main.ts` and `RunnerError` from `../errors.ts`.
- Do not change `scripts/e2e/lib/record/verdict.ts`. The seven-id verdict set is EPIC 020's story at `020-wiring-and-scenarios.md:77`.
- Do not change `exitCodeFor` and do not add an exit status.
- `checkManifest` opens no bundle `logs/` directory. `writeBundle` at `scripts/e2e/lib/bundle.ts:272-282` writes `logs/` only for a non-empty `bundle.logs`, so an absent `logs/` is not a finding.
- `checkManifest` writes nothing and modifies no file.

## Verify

Extend `scripts/e2e/lib/record/manifest.test.ts`. Sandbox every filesystem case with the `withTempCwd` helper of `scripts/e2e/lib/record/acceptance.test.ts:34-44`, copied into this file, because `runDirectory` returns a relative path from `scripts/e2e/lib/tag.ts:8,15-17`.

Add one fixture builder `writeRun(tag)` that writes seven bundle files through `serializeBundle`, one non-empty report, and a manifest whose rows match — **every digest and byte count recomputed from the bytes it just wrote**, so the complete run has an empty failure list. Add `mutate(run, change)` which applies one change **and recomputes every derived field that the change does not deliberately break**. A fixture that breaks two facts at once cannot assert one failure, so each case below states which fields are recomputed.

- `node --test scripts/e2e/lib/record/manifest.test.ts` exits 0.
- Checker cases. Each asserts the failure list **length**, each `code`, and the exact `reason` string, built from the same template the story fixes above:
  - a complete run returns an empty list.
  - `manifest.tag` set to another tag fails with one identity failure.
  - `schemaVersion` set to `2` fails with one identity failure.
  - `manifest.outcome` set to `unknown` fails with one identity failure.
  - swapping the `P1B-E1` and `P1-E4` **rows wholesale** (id, path, digest and outcome together, so no bundle fact breaks) fails with exactly one order failure naming position `2`.
  - six rows fail on position `6` absent; eight rows fail on position `7` with the declared order ending at `7`.
  - a bundle file deleted fails once with `unavailable`, and the following entries still report.
  - a bundle digest recorded wrong, with the file untouched, fails once with `assertion-failed`.
  - a bundle file rewritten as `{}` **and its manifest digest recomputed** fails once with `is not a bundle`.
  - a bundle written under a second tag, copied to the expected path **and its manifest digest recomputed**, fails once on `tag`.
  - the `P1-E2` bundle copied to the `P1B-E1` path with the digest recomputed fails once on `scenarioId`.
  - a bundle whose `outcome` is `failed` while its manifest row says `passed`, digest recomputed, fails on the outcome step; with `manifest.outcome` also `passed` it fails **twice**, once in class 3 and once in class 7. Assert both, in that order.
  - a bundle on another commit, digest recomputed, fails once on `commit`.
  - five rows fail once; seven rows fail once. Each is asserted by itself.
  - a row answering `maybe` fails once and names the row number.
  - a `rejected` row with an empty note fails once; with a whitespace-only note fails once.
  - the report deleted fails once with `unavailable`.
  - the report truncated to zero bytes, **with the manifest untouched**, fails three times: empty, byte count, digest — asserted in that order.
  - the report digest recorded wrong, with the file untouched, fails once.
  - a finding `B1` with `fixEpic: null` fails once; with a non-empty `fixEpic` passes; `S1` with `fixEpic: null` passes.
  - `outcome: "passed"` with two failing bundle rows and one `rejected` checklist row yields three class-7 failures, in scenario array order then row order.
  - an absent manifest returns exactly one `unavailable`.
  - a manifest that is not valid JSON returns exactly one `assertion-failed`.
  - a manifest that is `null`, an array, or an object missing `scenarios`, each returns exactly one `is not a manifest` failure. **`checkManifest` throws in none of the three**, asserted by calling it directly rather than through `assert.rejects`.
  - `checkManifest` modifies no file: take a `walkDigests` snapshot of the run directory before and after, in the shape of `verdict.test.ts:121-148`, and assert deep equality.
- `recordManifest` cases:
  - a valid source file writes `manifestRecordPath(tag)` whose content equals `serializeManifest` of the stamped record, byte for byte.
  - the recorded `tag`, `commit`, `proposalRevision` and `schemaVersion` come from the input and the dependencies, **not** from the source file: give the source file wrong values for all four and assert the stamped ones win.
  - an absent `--manifest` file raises `invalid-argument` with the exact message.
  - a source file of invalid JSON raises `invalid-argument`; a source file of `[]` raises `invalid-argument` with `is not a manifest`.
  - neither dependency is called when the source file is absent or malformed, asserted with a counting stub.
  - **a second `recordManifest` for one tag raises `tag-reused`**, and the file on disk stays byte-identical. Assert the code, the exact message, and a byte comparison of the file before and after the refused call. This mirrors `scripts/e2e/lib/record/acceptance.test.ts:206`.
  - the refusal happens **before** the source file is read: call the second `recordManifest` with a `--manifest` path that does not exist, and assert the error is `tag-reused` and not `invalid-argument`.
  - `main(["--record-manifest","--tag",tag,"--manifest",file])` on a tag that already holds a manifest returns `2`, per `exitCodeFor("tag-reused")` at `main.ts:460-470`.
- Parser cases, in the same file, flat `test(...)`:
  - `parseArguments(["--record-manifest","--tag","t1","--manifest","m.json"], "m")` deep-equals `{ recordManifest: { tag: "t1", manifestFile: "m.json" } }`.
  - `parseArguments(["--check-manifest","t1"], "m")` deep-equals `{ checkManifestTag: "t1" }`.
  - `--record-manifest` without `--tag` raises `invalid-argument`; without `--manifest` raises `invalid-argument`.
  - `--manifest` without `--record-manifest` raises `invalid-argument` with `--manifest applies to --record-manifest only`.
  - `--check-manifest` with a value failing `tagPattern` raises `invalid-argument`.
  - **the pairwise matrix, asserted in both argument orders.** For each of `--verdict`, `--record-verify`, `--record-acceptance`, `--mint-tag` and `--reclaim`, assert that combining it with `--check-manifest` raises `invalid-argument`, and assert the same for `--record-manifest`, with the new flag written **first** and **second**. Both orders are required: an early-returning guard block passes one order and silently ignores the other, which is the defect this matrix exists to catch.
  - `--check-manifest` with `--tag` raises `invalid-argument`; `--check-manifest` with a positional scenario id raises `invalid-argument`.
  - a repeated `--manifest` takes the last value.
- The `main` branch, asserted through `main` and not through `exitCodeFor` alone:
  - `main(["--check-manifest", tag])` over a complete run returns `0` and writes nothing to stderr.
  - over a run with one `assertion-failed` failure it returns `1`, and stderr holds exactly one line beginning `e2e: manifest: `.
  - over an absent manifest it returns `3`.
  - with two failures whose first is `unavailable` and second `assertion-failed`, it returns `3`, proving the branch takes `failures[0]` and not the worst code. Assert the returned number against `exitCodeFor(failures[0].code)` so the mapping is read from `main.ts:460-470` and restated nowhere. This is the assertion `025-external-drive-acceptance-run.md:231` requires.
  - `main(["--record-manifest","--tag",tag,"--manifest",file])` returns `0` and the file exists.
- `npm run verify` exits 0. This is the gate for the coupled pair of Stories 1 and 2.
- Proof: `PASS EPIC-025-UNIT`, jointly with Story 1.
