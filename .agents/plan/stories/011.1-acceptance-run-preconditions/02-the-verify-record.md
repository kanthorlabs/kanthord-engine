# Story 02 — The verify record

Epic: `.agents/plan/epics/011.1-acceptance-run-preconditions.md`
Depends on: Story 01 (the valueless-flag branch in the option loop).

## Change

### 1. `scripts/e2e/lib/bundle.ts` — read the proposal revision

Add beside `readCommit` (`bundle.ts:312-318`), with the same shape:

```ts
export async function readProposalRevision(
  sink: CommandSink,
  git: string,
): Promise<string> {
  const record = await runCommand(sink, {
    argv: [git, "log", "-1", "--format=%H", "--", "docs/proposal"],
  });
  return record.stdout.trim();
}
```

The argv is exact. It is the definition the EPIC fixes for the proposal revision.

### 2. `scripts/e2e/lib/tag.ts` — the record paths

Add after `bundleDirectory` (`tag.ts:19-21`):

```ts
export function verifyRecordPath(tag: string): string {
  return join(runDirectory(tag), "verify.json");
}

export function acceptanceRecordPath(tag: string): string {
  return join(runDirectory(tag), "acceptance.json");
}
```

Both are added here so Story 03 and Story 04 read one definition.

### 3. New file `scripts/e2e/lib/record/verify.ts`

```ts
export const verifyRecordSchemaVersion = 1;

export const verifyCommand: readonly string[] = ["npm", "run", "verify"];

export type VerifyRecord = Readonly<{
  schemaVersion: number;
  tag: string;
  command: readonly string[];
  exitCode: number;
  commit: string;
  proposalRevision: string;
  startedAt: string;
  finishedAt: string;
}>;

export type RecordVerifyDependencies = Readonly<{
  run(argv: readonly string[]): Promise<number>;
  readCommit(): Promise<string>;
  readProposalRevision(): Promise<string>;
  now(): Date;
}>;

export function serializeVerifyRecord(record: VerifyRecord): string;

export async function recordVerify(
  dependencies: RecordVerifyDependencies,
  tag: string,
): Promise<VerifyRecord>;
```

`serializeVerifyRecord` emits the eight keys in exactly the declaration order above, through
`JSON.stringify(ordered, null, 2)`, wrapped in `redact(...)` with a trailing newline — the shape of
`serializeBundle` (`bundle.ts:234-259`).

`recordVerify` runs, in this order:

1. `const startedAt = dependencies.now().toISOString();`
2. `const commit = await dependencies.readCommit();`
3. `const proposalRevision = await dependencies.readProposalRevision();`
4. `const exitCode = await dependencies.run(verifyCommand);`
5. `const finishedAt = dependencies.now().toISOString();`
6. `await mkdir(runDirectory(tag), { recursive: true });`
7. `await writeFile(verifyRecordPath(tag), serializeVerifyRecord(record), "utf8");`
8. return the record.

An existing `verify.json` is overwritten. Only the acceptance record refuses a second write, because
only that one is a signature.

### 4. `scripts/e2e/lib/main.ts` — the option, the type and the branch

Option loop: add `--record-verify` to the same valueless-flag branch Story 01 created, setting
`recordVerifyRequested = true`.

Type, beside `MintTagInvocation`:

```ts
export type RecordVerifyInvocation = Readonly<{ recordVerifyTag: string }>;
```

Widen `Invocation` with it.

Refusal block, placed immediately after the `mintTagRequested` block of Story 01:

```ts
if (recordVerifyRequested) {
  if (positionals.length > 0) {
    throw new RunnerError(
      "invalid-argument",
      "--record-verify is mutually exclusive with a scenario id",
    );
  }
  if (reclaimTag !== undefined) {
    throw new RunnerError(
      "invalid-argument",
      "--record-verify is mutually exclusive with --reclaim",
    );
  }
  if (tag === undefined) {
    throw new RunnerError("invalid-argument", "--record-verify needs --tag");
  }

  return { recordVerifyTag: tag };
}
```

Add one more check inside the `mintTagRequested` block of Story 01, before its `return`:

```ts
if (recordVerifyRequested) {
  throw new RunnerError(
    "invalid-argument",
    "--mint-tag is mutually exclusive with --record-verify",
  );
}
```

Branch in `main`, after the `"mintTag" in invocation` branch:

```ts
if ("recordVerifyTag" in invocation) {
  const record = await recordVerify(
    dependencies?.verify ?? createDefaultVerifyDependencies(),
    invocation.recordVerifyTag,
  );
  return record.exitCode;
}
```

Widen `main`'s `dependencies` parameter (`main.ts:220`) to
`Readonly<{ execute?: PodmanExecutor; verify?: RecordVerifyDependencies }>`.

`createDefaultVerifyDependencies()` is a local function in `main.ts` beside
`createDefaultExecute` (`main.ts:188-197`):

- `run(argv)` — `runCommand(silentSink, { argv: [...argv], env: { PATH: process.env.PATH ?? "" } })`
  and returns `record.exitCode`.
- `readCommit()` — `readCommit(silentSink, "git")`.
- `readProposalRevision()` — `readProposalRevision(silentSink, "git")`.
- `now()` — `new Date()`.

where `silentSink` is `{ print: () => undefined, record: () => undefined }`, the shape already used
at `main.ts:189` and `main.ts:269`.

## Constraints

- `recordVerify` never throws on a non-zero verify status. It records it and returns it. `main`
  returns that status, so a failing regression suite fails the invocation.
- `recordVerify` writes exactly one file. It creates no scenario directory and claims no bundle.
- `verify.json` lives in the run directory, never inside a bundle directory.
- Keep the eight keys and their order fixed. Story 04 reads this file.

## Verify

New file `scripts/e2e/lib/record/verify.test.ts`:

1. `recordVerify` with `run: async () => 0`, `readCommit: async () => "c0ffee"`,
   `readProposalRevision: async () => "dec0de"`, `now` returning
   `new Date("2026-08-09T10:00:00.000Z")` then `new Date("2026-08-09T10:04:00.000Z")` on the second
   call — assert the returned record deep-equals:

   ```ts
   {
     schemaVersion: 1,
     tag: "t1",
     command: ["npm", "run", "verify"],
     exitCode: 0,
     commit: "c0ffee",
     proposalRevision: "dec0de",
     startedAt: "2026-08-09T10:00:00.000Z",
     finishedAt: "2026-08-09T10:04:00.000Z",
   }
   ```

2. The bytes on disk equal `serializeVerifyRecord(record)` exactly, and that string ends with `}\n`
   and its parsed key order is the eight names above. Assert with
   `assert.deepEqual(Object.keys(JSON.parse(text)), [...])`.
3. `run: async () => 1` — the returned `exitCode` is `1` and the file is still written.
4. `recordVerify` passes exactly `["npm", "run", "verify"]` to `run`.
5. Temp cwd, as `scripts/e2e/lib/tag.test.ts:32-40`: after the call, the run directory holds exactly
   `["verify.json"]`.

Added to `scripts/e2e/lib/main.test.ts`:

6. `main(["--record-verify", "--tag", "t1"], { verify })` with a stub returning exit `3` resolves `3`.
7. Refusals, each asserting the exact message:
   - `["--record-verify"]` → `--record-verify needs --tag`
   - `["--record-verify", "--tag", "t", "P1-E1"]` → `--record-verify is mutually exclusive with a scenario id`
   - `["--record-verify", "--reclaim", "t"]` → `--record-verify is mutually exclusive with --reclaim`
   - `["--mint-tag", "--record-verify", "--tag", "t"]` → `--mint-tag is mutually exclusive with --record-verify`
8. `parseArguments(["--record-verify", "--tag", "t1"], "x")` deep-equals `{ recordVerifyTag: "t1" }`.

Added to `scripts/e2e/lib/bundle.test.ts`:

9. `readProposalRevision` issues exactly `["git", "log", "-1", "--format=%H", "--", "docs/proposal"]`
   against a recording sink and returns the trimmed stdout. Mirror the existing `readCommit` case.

- `npm run verify` exits 0.
- Proof: delivers `node scripts/e2e/run.mjs --record-verify --tag "$TAG"` of the EPIC Proof block.
