# Story 03 — The acceptance record

Epic: `.agents/plan/epics/011.1-acceptance-run-preconditions.md`
Depends on: Story 02 (`acceptanceRecordPath`, `readProposalRevision`, the flag-branch shape).

## Change

### 1. New file `scripts/e2e/lib/record/acceptance.ts`

```ts
export const acceptanceRecordSchemaVersion = 1;

export const driveValues = ["confirmed", "not-confirmed"] as const;
export const judgmentValues = ["accepted", "rejected"] as const;

export type Drive = (typeof driveValues)[number];
export type Judgment = (typeof judgmentValues)[number];

export type AcceptanceRecord = Readonly<{
  schemaVersion: number;
  tag: string;
  by: string;
  drive: Drive;
  judgment: Judgment;
  note: string;
  commit: string;
  proposalRevision: string;
  recordedAt: string;
}>;

export type RecordAcceptanceInput = Readonly<{
  tag: string;
  by: string;
  drive: Drive;
  judgment: Judgment;
  noteFile: string | null;
}>;

export type RecordAcceptanceDependencies = Readonly<{
  readCommit(): Promise<string>;
  readProposalRevision(): Promise<string>;
  now(): Date;
}>;

export function serializeAcceptanceRecord(record: AcceptanceRecord): string;

export async function recordAcceptance(
  dependencies: RecordAcceptanceDependencies,
  input: RecordAcceptanceInput,
): Promise<AcceptanceRecord>;
```

`serializeAcceptanceRecord` emits the nine keys in exactly the declaration order above, through
`JSON.stringify(ordered, null, 2)` wrapped in `redact(...)` with a trailing newline — the shape of
`serializeVerifyRecord`.

`recordAcceptance` runs, in this order:

1. **The tag holds a bundle.** For each id of `["P1-E1", "P1-E2", "P1-E3", "P1-E4"]`, test whether
   `join(bundleDirectory(tag, id), "bundle.json")` exists. If none exists:

   ```ts
   throw new RunnerError("unavailable", `tag ${tag} holds no bundle`);
   ```

2. **The record is not overwritten.** If `acceptanceRecordPath(tag)` exists:

   ```ts
   throw new RunnerError(
     "tag-reused",
     `tag ${tag} already holds an acceptance record`,
   );
   ```

3. `const note = input.noteFile === null ? "" : await readFile(input.noteFile, "utf8");` — stored
   verbatim, not trimmed.
4. `commit`, `proposalRevision` and `recordedAt = dependencies.now().toISOString()`.
5. `await mkdir(runDirectory(tag), { recursive: true })` then write `acceptanceRecordPath(tag)`.
6. Return the record.

Use `node:fs/promises` `access` inside a `try/catch` for the two existence tests, or `existsSync`
from `node:fs`. Either is acceptable; be consistent within the file.

### 2. `scripts/e2e/lib/main.ts` — the options, the type and the branch

Option loop:

- `--record-acceptance` joins the valueless-flag branch, setting `recordAcceptanceRequested = true`.
- `--by`, `--drive`, `--judgment`, `--note-file` join the value-taking option list at
  `main.ts:68-73` and assign to four new locals initialised to `undefined`.

Type, beside `RecordVerifyInvocation`:

```ts
export type RecordAcceptanceInvocation = Readonly<{
  recordAcceptance: RecordAcceptanceInput;
}>;
```

Widen `Invocation` with it.

Refusal block, placed immediately after the `recordVerifyRequested` block of Story 02, in this exact
order:

```ts
if (recordAcceptanceRequested) {
  if (positionals.length > 0) {
    throw new RunnerError(
      "invalid-argument",
      "--record-acceptance is mutually exclusive with a scenario id",
    );
  }
  if (reclaimTag !== undefined) {
    throw new RunnerError(
      "invalid-argument",
      "--record-acceptance is mutually exclusive with --reclaim",
    );
  }
  if (tag === undefined) {
    throw new RunnerError(
      "invalid-argument",
      "--record-acceptance needs --tag",
    );
  }
  if (by === undefined) {
    throw new RunnerError("invalid-argument", "--record-acceptance needs --by");
  }
  if (drive === undefined) {
    throw new RunnerError(
      "invalid-argument",
      "--record-acceptance needs --drive",
    );
  }
  if (judgment === undefined) {
    throw new RunnerError(
      "invalid-argument",
      "--record-acceptance needs --judgment",
    );
  }
  if (!(driveValues as readonly string[]).includes(drive)) {
    throw new RunnerError(
      "invalid-argument",
      "--drive must be confirmed or not-confirmed",
    );
  }
  if (!(judgmentValues as readonly string[]).includes(judgment)) {
    throw new RunnerError(
      "invalid-argument",
      "--judgment must be accepted or rejected",
    );
  }
  if (drive === "not-confirmed" && noteFile === undefined) {
    throw new RunnerError(
      "invalid-argument",
      "--note-file is required for --drive not-confirmed",
    );
  }
  if (judgment === "rejected" && noteFile === undefined) {
    throw new RunnerError(
      "invalid-argument",
      "--note-file is required for --judgment rejected",
    );
  }

  return {
    recordAcceptance: {
      tag,
      by,
      drive: drive as Drive,
      judgment: judgment as Judgment,
      noteFile: noteFile ?? null,
    },
  };
}
```

Add to the `mintTagRequested` block of Story 01 and the `recordVerifyRequested` block of Story 02,
before each `return`:

```ts
if (recordAcceptanceRequested) {
  throw new RunnerError(
    "invalid-argument",
    "--mint-tag is mutually exclusive with --record-acceptance",
  );
}
```

and the same shape with `--record-verify is mutually exclusive with --record-acceptance`.

Add, after the `recordAcceptanceRequested` block and before the `reclaimTag` block, one guard for
each of the four new options used without `--record-acceptance`, in this order:

```ts
for (const [name, value] of [
  ["--by", by],
  ["--drive", drive],
  ["--judgment", judgment],
  ["--note-file", noteFile],
] as const) {
  if (value !== undefined) {
    throw new RunnerError(
      "invalid-argument",
      `${name} applies to --record-acceptance only`,
    );
  }
}
```

Branch in `main`, after the `"recordVerifyTag" in invocation` branch:

```ts
if ("recordAcceptance" in invocation) {
  await recordAcceptance(
    dependencies?.acceptance ?? createDefaultRecordDependencies(),
    invocation.recordAcceptance,
  );
  return 0;
}
```

Widen `main`'s `dependencies` parameter with `acceptance?: RecordAcceptanceDependencies`.
`createDefaultRecordDependencies()` is a local function in `main.ts` returning the same
`readCommit` / `readProposalRevision` / `now` trio Story 02 defined; extract it once and have
`createDefaultVerifyDependencies` spread it.

## Constraints

- The two runtime refusals carry the codes that map to the EPIC's exit statuses: an absent bundle is
  `unavailable` (exit 3), a second write is `tag-reused` (exit 2).
- The note is stored verbatim. Do not trim, wrap or re-encode it.
- The record never touches a bundle directory.
- `--note-file` stays optional for `--drive confirmed --judgment accepted`; the stored `note` is then
  the empty string.

## Verify

New file `scripts/e2e/lib/record/acceptance.test.ts`, each case in its own temp cwd
(`scripts/e2e/lib/tag.test.ts:32-40` shape):

1. With one bundle present at `.data/acceptance-t1/P1-E1/bundle.json`, `recordAcceptance` writes
   `.data/acceptance-t1/acceptance.json` and the returned record deep-equals:

   ```ts
   {
     schemaVersion: 1,
     tag: "t1",
     by: "Ulrich",
     drive: "confirmed",
     judgment: "accepted",
     note: "",
     commit: "c0ffee",
     proposalRevision: "dec0de",
     recordedAt: "2026-08-09T10:00:00.000Z",
   }
   ```

2. The bytes on disk equal `serializeAcceptanceRecord(record)`, and the parsed key order is the nine
   names above.
3. A `--note-file` whose content is `"three faults\n"` stores `note: "three faults\n"` exactly.
4. No bundle under the tag → rejects with `RunnerError`, `code === "unavailable"`, message
   `tag t1 holds no bundle`. Cover both an absent run directory and a run directory holding an empty
   `P1-E1/` with no `bundle.json`.
5. A second call for the same tag rejects with `code === "tag-reused"`, message
   `tag t1 already holds an acceptance record`, and the file on disk is byte-identical to the first
   write.

Added to `scripts/e2e/lib/main.test.ts`, each asserting the exact message:

6. `["--record-acceptance", "--tag", "t"]` → `--record-acceptance needs --by`
7. `["--record-acceptance", "--by", "U", "--drive", "confirmed", "--judgment", "accepted"]` →
   `--record-acceptance needs --tag`
8. `[..., "--drive", "maybe", ...]` → `--drive must be confirmed or not-confirmed`
9. `[..., "--judgment", "meh", ...]` → `--judgment must be accepted or rejected`
10. `[..., "--drive", "not-confirmed", "--judgment", "accepted"]` with no `--note-file` →
    `--note-file is required for --drive not-confirmed`
11. `[..., "--drive", "confirmed", "--judgment", "rejected"]` with no `--note-file` →
    `--note-file is required for --judgment rejected`
12. `["P1-E1", "--by", "U"]` → `--by applies to --record-acceptance only`
13. A complete valid argv deep-equals the `RecordAcceptanceInvocation` above with
    `noteFile: null`.
14. `main` with a stub `acceptance` dependency resolves `0` on the happy path, `3` on the
    no-bundle rejection and `2` on the second write.

- `npm run verify` exits 0.
- Proof: this story delivers no line of the EPIC Proof block. The Proof asserts the verdict exits
  `1` **because** no acceptance record exists, so this story must not create one implicitly. It is
  covered by the `Coverage required beyond the Proof` bullet on `--record-acceptance`.
