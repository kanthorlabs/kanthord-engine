# Story 01 — The runner mints the tag

Epic: `.agents/plan/epics/011.1-acceptance-run-preconditions.md`

## Change

### 1. `scripts/e2e/lib/main.ts` — the option loop accepts a valueless flag

Today every `--` token consumes a value (`main.ts:67-98`). Insert a flag branch as the first
statement inside `if (token.startsWith("--"))`, before the unknown-option check at line 68:

```ts
if (token === "--mint-tag") {
  mintTagRequested = true;
  index += 1;
  continue;
}
```

Declare `let mintTagRequested = false;` beside the other locals at `main.ts:57-61`.

### 2. `scripts/e2e/lib/main.ts` — the invocation type

Add beside `ReclaimInvocation` at line 49:

```ts
export type MintTagInvocation = Readonly<{ mintTag: string }>;
```

and widen the union at line 51:

```ts
export type Invocation = RunInvocation | ReclaimInvocation | MintTagInvocation;
```

### 3. `scripts/e2e/lib/main.ts` — the refusal block

Insert immediately before the `if (reclaimTag !== undefined)` block at line 105, so `--mint-tag`
is decided first:

```ts
if (mintTagRequested) {
  if (positionals.length > 0) {
    throw new RunnerError(
      "invalid-argument",
      "--mint-tag is mutually exclusive with a scenario id",
    );
  }
  if (tag !== undefined) {
    throw new RunnerError(
      "invalid-argument",
      "--mint-tag is mutually exclusive with --tag",
    );
  }
  if (reclaimTag !== undefined) {
    throw new RunnerError(
      "invalid-argument",
      "--mint-tag is mutually exclusive with --reclaim",
    );
  }

  return { mintTag: mintedTag };
}
```

The three messages are exact and are asserted verbatim.

### 4. `scripts/e2e/lib/main.ts` — the branch in `main`

Insert immediately after `const invocation = parseArguments(...)` at line 223, before the
`"reclaimTag" in invocation` branch:

```ts
if ("mintTag" in invocation) {
  process.stdout.write(`${invocation.mintTag}\n`);
  return 0;
}
```

`mintedTag` already comes from `mintTag(new Date(), ulid)` at line 223, so two invocations of the
process print two tags. No directory is created, because the branch returns before
`claimBundleDirectory`.

## Constraints

- `--mint-tag` takes no value. `["--mint-tag", "P1-E1"]` must reach the "mutually exclusive with a
  scenario id" refusal, not consume `P1-E1` as a value.
- The branch in `main` writes exactly one line to stdout and nothing to stderr.
- Do not change `mintTag` in `scripts/e2e/lib/tag.ts`. It already produces the portable tag.
- Do not touch `scripts/e2e/run.mjs`. `scripts/e2e/lib/shim.test.ts:32-39` pins its four lines
  verbatim.

## Verify

`node --test scripts/e2e/lib/main.test.ts`. Add these cases to the existing file:

1. `parseArguments` — `assert.deepEqual(parseArguments(["--mint-tag"], "minted-tag"), { mintTag: "minted-tag" })`.
2. Refusal table — extend the existing `refusals` array (`main.test.ts:36-77`) or add four
   standalone cases, each asserting `RunnerError` with `code === "invalid-argument"` and the exact
   message:
   - `["--mint-tag", "P1-E1"]` → `--mint-tag is mutually exclusive with a scenario id`
   - `["P1-E1", "--mint-tag"]` → `--mint-tag is mutually exclusive with a scenario id`
   - `["--mint-tag", "--tag", "t"]` → `--mint-tag is mutually exclusive with --tag`
   - `["--mint-tag", "--reclaim", "t"]` → `--mint-tag is mutually exclusive with --reclaim`
3. `main(["--mint-tag"])` resolves `0`, and the captured stdout is exactly one string matching
   `/^\d{17}-[0-9a-z]{26}\n$/`. Capture with `t.mock.method(process.stdout, "write", ...)`, the
   pattern used for stderr at `main.test.ts:91-103`. Assert `process.stderr.write` was never called.
4. Two sequential `await main(["--mint-tag"])` calls print two different strings.
5. The printed tag is accepted by `parseArguments`: strip the trailing newline, then
   `assert.equal((parseArguments(["P1-E1", "--tag", printed], "x") as RunInvocation).tag, printed)`.
6. `main(["--mint-tag"])` creates nothing under `.data/`. Follow the temp-cwd shape of
   `scripts/e2e/lib/tag.test.ts:32-40`: `mkdtemp` + `process.chdir`, run, then
   `assert.deepEqual(await readdir("."), [])`, restore cwd and `rm` in `t.after`.

- `npm run verify` exits 0.
- Proof: delivers `TAG=$(node scripts/e2e/run.mjs --mint-tag)` — the first line of the EPIC Proof
  block, and the `TAG` every later line consumes.
