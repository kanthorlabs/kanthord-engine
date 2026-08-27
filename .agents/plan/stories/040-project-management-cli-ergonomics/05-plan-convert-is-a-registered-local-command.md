# Story 5 — `plan convert` is a registered local command

Epic: `.agents/plan/epics/040-project-management-cli-ergonomics.md`
Depends on: Story 4, which supplies `convertHarnessPlan`.

## Change

### New `src/cli/plan/convert.ts`

- Export `registerPlanConvert(input): void` with dependencies `{ program, cwd, fs, stdout, stderr, fail }`, using `PlanDirectoryDependencies` from `src/cli/plan/directory.ts`.
- Register one `plan convert` leaf through `planCommand`, guarded against duplicate registration like `registerPlanImport` at `src/cli/plan/import.ts:30-34`.
- Description: `convert an expanded EPIC into plan documents`.
- Options and descriptions:
  - `--from <epic-file>` — `expanded EPIC file`;
  - `--repo <name>` — `repository name for every objective`;
  - `--to <directory>` — `output directory`.
- Validate required options in that order. Each absence prints `kanthord: invalid-request: --<name> is required\n`, calls `fail` once and performs no file read or write.

### Source discovery and read order

- Resolve `--from` and `--to` against `input.cwd` with `node:path.resolve`.
- Derive `epicSlug` from the EPIC basename without `.md` and derive the expanded Story directory as `resolve(dirname(epicPath), "../stories", epicSlug)`.
- Read the EPIC first. Read the Story directory names second. Filter names matching `^[0-9]{2}-.*\.md$` and not ending `/`, sort with `comparePaths`, then read each file in that order. Ignore `index.md`, subdirectories and nonmatching files.
- Convert read failures into one local line `kanthord: invalid-request: cannot read <path>\n`, call `fail` once and write nothing.
- Call `convertHarnessPlan` exactly once with absolute source paths, read contents and `options.repo`. Catch its `Error`, print `kanthord: invalid-request: <message>\n`, call `fail` once and write nothing.

### Output safety and write

- Resolve the output root before reading it.
- After the pure conversion succeeds and before the first write, call `readPlanDirectory(input.fs, outputRoot)`. If it throws, print `kanthord: invalid-request: cannot read <outputRoot>/plan\n`, call `fail` once and write nothing. If it returns any document, print `kanthord: invalid-request: <outputRoot>/plan is not empty\n`, call `fail` once and write nothing.
- Pass the complete converted document array once to `writePlanDirectory`. Because the precondition proved the plan empty, assert the returned removed list is empty; a non-empty list throws `Error("plan convert removed an existing document")`.
- On success print exactly `kanthord: converted <storyCount> story into <documentCount> document under <outputRoot>/plan\n`, where `storyCount = (documentCount - 1) / 2`.
- The command takes no client, project id, token, confirmation or id generator and calls no operation.

### Registration and inventory

- Import and call `registerPlanConvert` immediately before `registerPlanImport` at `src/cli/program.ts:241`; pass `program`, `cwd`, `fs`, `stdout`, `stderr` and `fail` only.
- Add `{ path: ["plan", "convert"], operationIds: [] }` before `plan export` at `src/cli/inventory.ts:96` so `commandPaths()` remains bytewise sorted.
- Update both exact command lists in `src/cli/inventory.test.ts:32-69,72-111` with `plan convert` before `plan export`; update the local-command assertion at `:128` to include it.
- Add a `plan convert` row to `src/cli/reachability.test.ts` before `plan export`, with a two-Story fake source, empty output and `effect: "planWrite"`.

### Reachability recorder

- Extend `test/helpers/command-recorder.ts:17-27` with `planWriteFileCalls()` separate from config `writeFileCalls()`.
- Wrap the supplied/default `PlanDirectoryDependencies.writeFile` so every plan write is recorded and still delegated. Do not count `makeDirectory` as a document write.
- Extend the `Row.effect` union in `src/cli/reachability.test.ts:11-16` with `planWrite` and extend the local-effect assertion at `:605-622` so `plan convert` must record five document writes and zero HTTP requests. Keep config generate, db migrate and serve at one effect each.

## Constraints

- The command must work with no base URL, token or discovered config.
- A parse error or non-empty output writes no file and removes no file.
- Do not call `writePlanDirectory` once per document; one complete call preserves the all-in-memory validation boundary.
- Do not add an operation id or route.
- Do not modify `plan import` or `plan export` behavior.

## Verify

- Add `src/cli/plan/convert.test.ts` with an in-memory `PlanDirectoryDependencies` fake that records reads, directories, writes and removals.
- Assert success:
  - reads EPIC then Story names then Story files in bytewise order;
  - calls no client and needs no registered client options;
  - writes the five exact Story 4 documents in returned order;
  - removes nothing;
  - prints the exact `2 story into 5 document` line;
  - a relative `--from` and `--to` resolve against injected cwd.
- Table-drive each missing option and assert zero reads/writes.
- Assert source ENOENT, output inspection failure, pure-mapper validation failure and non-empty output each print their exact local refusal, call `fail` once, and record zero writes/removals.
- Assert duplicate registration leaves one `convert` leaf.
- Extend `src/cli/program.test.ts` to assert the `plan` group contains `convert`, `import`, `export` once each.
- Extend `src/cli/inventory.test.ts`, `src/cli/parity.test.ts`, `src/cli/reachability.test.ts` and `test/helpers/command-recorder.test.ts` with the exact inventory/effect behavior above.
- `node --test src/cli/plan/convert.test.ts src/cli/program.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts src/cli/reachability.test.ts test/helpers/command-recorder.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: the convert, program, inventory, parity, reachability and recorder test lines of the EPIC Proof. When all five stories are present, the Proof exits 0 and prints `PASS EPIC-040`.
