# Story 15 — the plan CLI and the import handshake

Epic: `.agent/plan/epics/008-project-and-plan.md`
Depends on: Stories 08, 11, 12, 14.

`kanthord plan import` is the protocol of `docs/proposal/api/graph.md`, not one call: validate first, pre-select every suggestion, carry `validatedRevision` and `documentsHash` into the import, and submit one choice per node of the identity union.

## Change

### 1. `src/cli/plan/index.ts` (new)

The idempotent group factory, as `src/cli/project/index.ts`.

### 2. `src/cli/plan/directory.ts` (new)

```ts
export type PlanDirectoryDependencies = Readonly<{
  readDirectory: (path: string) => readonly string[];
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  makeDirectory: (path: string) => void;
  removeFile: (path: string) => void;
}>;

export function readPlanDirectory(
  dependencies: PlanDirectoryDependencies,
  root: string,
): readonly Readonly<{ path: string; content: string }>[];

export function writePlanDirectory(
  dependencies: PlanDirectoryDependencies,
  input: Readonly<{
    root: string;
    documents: readonly Readonly<{ path: string; content: string }>[];
  }>,
): readonly string[];
```

The file system is injected, not imported: `src/cli/**` may import `node:fs` (`eslint.config.js:271-296` does not restrict it), and `src/main.ts:337` already injects `readFile` into the credential command. Injection is what makes this testable with no temporary directory.

`readPlanDirectory` walks `<root>/plan` recursively, keeps every path ending in `.md`, and returns entries whose `path` is POSIX and relative to `root` — so it begins with `plan/`. The returned array is sorted with `comparePaths`, which makes the request body deterministic even though its order carries no meaning.

`writePlanDirectory` writes every response document, creating each parent directory first, and then **removes every `plan/**/*.md` under `root` that the response does not name**. It returns the removed paths. The response uses canonical paths, so a human's own file names would otherwise survive as orphans (`docs/proposal/api/graph.md:56`). It removes only `.md` files under `plan/` and removes no directory, so a `.gitignore` or a note beside the plan survives.

### 3. `src/cli/plan/export.ts` (new)

`kanthord plan export --project <id> [--directory <path>]`.

- `client.call("plan.export", undefined, { id })`, `planExportResponse.parse`.
- `writePlanDirectory` into `--directory`, default `process.cwd()` injected as `cwd`.
- Output:

  ```
  kanthord: revision <revision or <none>>
  kanthord: wrote <n> document
  kanthord: removed <n> document
  ```

- A project with no revision writes `revision <none>` and `wrote 0 document`, and exits zero.

### 4. `src/cli/plan/import.ts` (new)

`kanthord plan import --project <id> [--directory <path>] [--yes]`.

The handshake, in this exact order:

1. `readPlanDirectory`. An empty set writes `kanthord: invalid-request: no plan document under <root>/plan\n` and calls `fail()`, with **no** call to the daemon.
2. `client.call("plan.revisions", undefined, { id })`, `planRevisionsResponse.parse`. `fromRevision` is the first entry's `id`, or `null` for an empty list. The list is descending, so the head is the newest (Story 12).
3. `client.call("plan.validate", { fromRevision, documents }, { id })`, `planValidateResponse.parse`.
4. A non-empty `findings` writes one line per finding to stderr and calls `fail()`, with **no** call to `plan.import`:

   ```
   kanthord: plan-invalid: <code> <path or -> <message>
   ```

   Findings are printed in the response order, which the daemon already sorted.

5. Every node of `choices` is pre-selected at its `suggested` value. That is one choice per node of the identity union, and the union is exactly what `plan.validate` returned (`docs/proposal/api/graph.md:54`).
6. Without `--yes` and with a TTY, print the choice table and ask once for confirmation through the injected `ConfirmDependencies` of `src/cli/confirm.ts:1-44`. With `--yes`, or with no TTY, take every suggestion — a non-interactive run takes every suggestion. Refusing at the prompt writes `kanthord: cancelled\n`, calls `fail()`, and sends no import.
7. `client.call("plan.import", { fromRevision, importId, documents: result.documents, choices, validatedRevision: result.revision, documentsHash: result.documentsHash }, { id })`.
   - `documents` is the **normalized** documents `plan.validate` returned, not the ones read from disk. The `documentsHash` binds to those bytes, and sending the authored bytes instead would fail the hash check of Story 11 step 7.
   - `importId` is minted by the client with `ulid()` and prefixed `imp_`. It is a client value with no server format (`src/domain/plan-revision.ts:10`), and `src/cli/**` may import `ulid`: `eslint.config.js:271-296` does not restrict it and `src/main.ts:7` already does.
8. `planImportResponse.parse`, then `writePlanDirectory`, then:

   ```
   kanthord: revision <revision>
   kanthord: wrote <n> document
   kanthord: removed <n> document
   kanthord: absent <ids joined with , or <none>>
   ```

9. A non-ok import result writes `kanthord: ${code}: ${message}\n` and calls `fail()`. `choices-stale` and `choices-changed` each additionally write the reason:

   ```
   kanthord: choices-stale: the plan moved since validation; export and retry
   kanthord: choices-changed: <the ids from details, joined with ,>
   ```

   Both exit non-zero through `fail()`, and neither writes a file.

### 5. `src/main.ts` — register two commands

`registerPlanExport` and `registerPlanImport`, taking `{ program, client, confirm, cwd: process.cwd(), fs: { … }, stdout: writeOut, stderr: writeErr, fail }`. The five file system members are `readdirSync`, `readFileSync`, `writeFileSync`, `mkdirSync` and `rmSync` from `node:fs`, imported at the top of `main.ts` beside `readFileSync` at `:3`.

## Constraints

- `plan.validate` is called before `plan.import`, always. An import that skips it cannot carry `validatedRevision`.
- The documents sent to `plan.import` are the ones `plan.validate` returned.
- A finding stops the run before the import.
- A non-interactive run takes every suggestion and asks nothing.
- `writePlanDirectory` removes only `.md` files under `plan/`.
- The file system is injected. No test writes to a real directory.
- `src/cli/**` imports no command, no query and no service.

## Verify

```
node --test src/cli/plan/directory.test.ts src/cli/plan/export.test.ts \
  src/cli/plan/import.test.ts
```

The client in `export.test.ts` and `import.test.ts` is a **recording server**: a `DaemonClient` whose `call` pushes `(operationId, body, parameters)` onto an array and returns the next scripted `CallResult` from a per-test queue, throwing when the queue is empty. The file system is an in-memory map.

### `directory.test.ts`

- A three-file tree returns three entries with POSIX paths beginning `plan/`, sorted with `comparePaths`.
- A file outside `plan/` is not returned. A `.txt` inside `plan/` is not returned.
- An absent `plan/` directory returns `[]`.
- `writePlanDirectory` writes every document and creates each parent directory before its file, asserted on the recorded call order.
- **Orphan removal.** A tree holding `plan/a--01/initiative.md` and a human-named `plan/my-notes.md`, written with a response naming only the first: the second is removed, and the removed list names it.
- A `.gitignore` and a `plan/README.txt` are **not** removed.
- No directory is removed.
- A response document at a new nested path creates both directories.
- Writing the same document set twice removes nothing on the second run.

### `export.test.ts`

- A successful export records exactly one call, `("plan.export", undefined, { id })`, writes every document, and prints the three lines.
- A `revision: null` response prints `revision <none>` and `wrote 0 document`.
- A `404` prints the `not-found` line and calls `fail()`, and the file system map is unchanged.
- No `--project` prints the `invalid-request` line and records zero calls.

### `import.test.ts`

- **`plan.validate` is called before `plan.import`.** A successful run records exactly three calls, and their `operationId` sequence deep-equals `["plan.revisions","plan.validate","plan.import"]`. This is the EPIC's request-order coverage line, and it is asserted on the recorded sequence because an import that skips validation cannot carry `validatedRevision`.
- The `plan.import` body's `validatedRevision` equals the `revision` the scripted `plan.validate` returned, and its `documentsHash` equals that response's `documentsHash`.
- The `plan.import` body's `documents` deep-equal the `plan.validate` response's `documents`, and **not** the files read from disk. The scripted validate response returns documents at canonical paths that differ from the authored paths, so the two are distinguishable.
- `fromRevision` equals the head of the scripted `plan.revisions` list; with an empty list it is `null`.
- **Every suggestion is pre-selected.** A scripted choice set of five entries with mixed suggestions yields a `choices` array of five entries whose `take` values equal those suggestions, bytewise ascending by id.
- **A finding stops the run.** A validate response with two findings records exactly two calls, prints two `plan-invalid` lines, calls `fail()`, and leaves the file system map unchanged.
- **A non-interactive run asks nothing.** With `confirm.isTty === false` and no `--yes`, the run completes and the injected `prompt` was never called.
- With a TTY and no `--yes`, the prompt is called exactly once; answering `n` records two calls, prints `cancelled`, and calls `fail()`.
- With `--yes` and a TTY, the prompt is not called.
- **`choices-stale` exits non-zero and names the reason.** A scripted `409 choices-stale` prints the two lines, calls `fail()`, and leaves the file system unchanged.
- **`choices-changed` names the ids from `details`.**
- A `409 idempotency-mismatch` and a `409 stale-revision` each print their code and call `fail()`.
- **The response replaces the directory.** A successful import writes the response documents and removes the authored file the response does not name, asserted on the in-memory map.
- `absent` is printed as the joined ids, and as `<none>` for an empty array.
- An empty `plan/` directory records zero calls.
- `importId` is a fresh `imp_`-prefixed value on each run, and two runs produce two different values.
- Determinism: two runs against the same scripted queue and the same file system map produce the same recorded bodies apart from `importId`, asserted by deleting that key before the comparison.

`npm run verify` exits 0.

Proof: contributes `src/cli/plan/**/*.test.ts`. It is inside the EPIC Proof glob, so it delivers `PASS EPIC-008`.
