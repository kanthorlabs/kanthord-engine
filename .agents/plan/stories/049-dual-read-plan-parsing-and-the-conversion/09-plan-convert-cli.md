# Story 9 — `plan convert` CLI

Epic: `.agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md`
Depends on: Story 4 (`renderDocument` accepts `deliverable` and `verify`), Story 8 (`spawnAtCommit` at `src/services/verify/spawn-at-commit.ts`), Stories 6 and 7 (`convertDocumentSet`, `ConversionResult`, `ConvertedNode`, `parseTemplateFile`)

## Change

**Step A — Rename the existing harness convert command**

`src/cli/plan/convert.ts` already exists and registers a `plan convert` Commander subcommand for harness-plan conversion (epics → plan docs). Rename to avoid the conflict:

1. Rename the file: `src/cli/plan/convert.ts` → `src/cli/plan/convert-harness.ts`. Inside that file: change the Commander registration from `.command("convert")` to `.command("convert-harness")`; rename the exported type `PlanConvertCliInput` to `PlanConvertHarnessCliInput`; rename the exported function `registerPlanConvert` to `registerPlanConvertHarness`. These renames prevent any import-site collision at `src/cli/program.ts`.
2. Rename `src/cli/plan/convert.test.ts` → `src/cli/plan/convert-harness.test.ts`. Update the suite name string if it contains `"convert"` but not `"convert-harness"`. Add one `it` block: `"plan group registers both convert and convert-harness subcommands"` — build a minimal program, call `registerPlanConvertHarness(...)` and `registerPlanConvert(...)` on it, then assert the `plan` subcommand has a child named `"convert-harness"` and a child named `"convert"`, and that the two children are distinct objects.
3. In `src/cli/program.ts`, update the import of `registerPlanConvert` and `PlanConvertCliInput` from `"./plan/convert.ts"` to import `registerPlanConvertHarness` and `PlanConvertHarnessCliInput` from `"./plan/convert-harness.ts"`. Update the call at line 256 accordingly: rename `registerPlanConvert(...)` to `registerPlanConvertHarness(...)`.

Step A is a blocking prerequisite of Step B. Complete the rename and confirm the suite `"src/cli/plan/convert-harness.test"` passes before creating the new file. The duplicate-registration guard at `src/cli/plan/convert.ts:28-31` returns silently when a `"convert"` subcommand already exists, so a collision would NOT fail tests — it would ship a CLI missing one of the two commands with no error. The rename is therefore ordered before the new command so that exactly one `"convert"` and one `"convert-harness"` subcommand are registered.

**Step B — Create `src/cli/plan/convert.ts`** (new file)

Declare a CLI-local callable type. The CLI imports no service interface and no `node:child_process`; `main.ts` binds the callable over `spawnAtCommit`, exactly as it injects the `db migrate` handler (see `src/main.ts:780-885`). The `commitRef` field carries a resolved commit object id, not a symbolic ref — the CLI resolves every ref to an object id once before the first command runs and passes the object id into the runner.

```ts
export type ConvertRunner = (
  params: Readonly<{
    command: string;
    repoPath: string;
    commitRef: string;
  }>,
) => Promise<{ kept: boolean }>;
```

Export one function:

```ts
export type PlanConvertCliInput = Readonly<{
  program: Command;
  cwd: string;
  runner: ConvertRunner;
  fs: PlanDirectoryDependencies;
  readFrontmatter: FrontmatterReader;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fail: () => void;
}>;

export function registerPlanConvert(input: PlanConvertCliInput): void;
```

Import `PlanDirectoryDependencies` from `"./directory.ts"`. Import `FrontmatterReader` from `"../../domain/plan-validate.ts"` (type import; `cli/` may import `domain/`). `src/cli/program.ts` already declares `fs: PlanDirectoryDependencies` at line 71 of `ProgramDependencies` and passes `cwd` and `fs` into `registerPlanConvert` at lines 256-263, exactly as it does for the harness converter. Bind `readFrontmatter` in `src/cli/program.ts` the same way `src/commands/plan/import-plan.ts:212` does: `(text) => dependencies.reader.read(text)` over the document service.

Registration adds a Commander subcommand `"convert"` with:

- First positional arg: `<plan-dir>` — the input plan directory.
- Required option: `--output <dir>` — the output directory. Declare with Commander's `.requiredOption()` so the CLI refuses and exits with a usage error when absent.
- Optional option: `--template <file>` — JSON template file path.
- Repeatable option: `--repo <name>=<path>` — one per repository checkout. Format: split on the first `=` only; a path containing `=` is not split further.
- Repeatable option: `--at <test-source-path>=<failing-ref>..<passing-ref>` — one per test/implementation pair. Parse by splitting on the first `=`, then splitting the right-hand side on `..`. A value with no `=` is a parse error: call `input.stderr("at-malformed: " + raw)` and `input.fail()`. A value whose right-hand side contains no `..` is a parse error naming it. A duplicate key (same `test-source-path` appearing twice) is a parse error naming the path. A key that names a path not present as a test node in the conversion result is a refusal: call `input.stderr("commit-range-unknown: " + key)` and `input.fail()`. Return. A typo in an `--at` key must not silently produce a plausible tree with a command validated at the wrong commit.
- Flag: `--commands-none` — skip command validation; all nodes with a template get `command-failed`.

**Implementation inside the action handler:**

1. **Read and parse the input directory.** Call `readPlanDirectory(input.fs, planDir)` (import from `"./directory.ts"`). This walks the `${planDir}/plan` subtree recursively and returns paths sorted by `comparePaths` — a raw directory listing is filesystem-ordered and would break the idempotence assertion. `readPlanDirectory` collects only `.md` files, so no name-based exclusion is required. For each entry, parse frontmatter using `input.readFrontmatter(entry.content)`. Apply two checks in order: (a) If any parsed document carries `deliverable !== null`: call `input.stderr("already-converted: " + entry.path)` and `input.fail()`. Return immediately; the output directory stays empty. (b) If any parsed document carries a `worker` value that is not `null` and is neither `"claude.te@1"` nor `"claude.swe@1"`, and the document's `kind` is neither `"initiative"` nor `"objective"`: call `input.stderr("worker-unmapped: " + entry.path)` and `input.fail()`. Return immediately; the output directory stays empty. Build a `ConversionInput[]` from the remaining documents.

2. **Validate the output directory.** If `outputDir` exists and is non-empty (any entry listed by `input.fs.readDirectory(outputDir)`): call `input.stderr("output-not-empty")` and `input.fail()`. Return. `readDirectory` is on `PlanDirectoryDependencies`; do not call `readdirSync` directly.

3. **Check that the output directory is not inside the input directory.** Resolve both paths with `path.resolve`. If `outputDir` starts with `planDir + path.sep` or equals `planDir`: call `input.stderr("output-inside-input")` and `input.fail()`. Return.

4. **Parse the template file.** If `--template` was given: read and call `parseTemplateFile(text)`. On `TemplateParseError`: call `input.stderr(err.detail)` and `input.fail()`. Return.

5. **Resolve `--at` refs to commit object ids.** For each `--at` entry, resolve `failing-ref` and `passing-ref` to immutable commit object ids by running `git rev-parse <ref>` in the corresponding repository (keyed by the same `resolvedRepository` the conversion will use). Both resolutions happen once, before any command runs. Store the resolved ids in a `Map<string, { failingId: string; passingId: string }>` keyed by `test-source-path`. If a ref cannot be resolved, call `input.stderr("ref-unresolvable: " + ref)` and `input.fail()`. Return.

6. **Check `--repo` requirement.** Call `convertDocumentSet(documents, templates)` to get `ConversionResult`. For any `ConvertedNode` whose `manualReasons` is empty and `resolvedRepository` is non-null and `verify.paths.length > 0`: if no `--repo` was given and `--commands-none` is not set: call `input.stderr("checkout-required: " + <repo names required>)` and `input.fail()`. Return. The repository names required are the `resolvedRepository` values of those nodes.

7. **Check `--at` requirement.** For any `ConvertedNode` whose `deliverable === "test"` and `pendingCommand !== null` and `--commands-none` is not set: if no `--at` entry keys `node.sourcePath`, call `input.stderr("commit-range-missing: " + node.sourcePath)` and `input.fail()`. Return. Name every missing test source path in the error message.

8. **Run command validation — two passes, test nodes first, then implementation nodes.** If `--commands-none` is set: mark every node that has `pendingCommand !== null` with reason `"command-failed"` and leave `commands: []`.

Otherwise:

Pass 1 — process nodes whose `deliverable === "test"` in the `ConversionResult`. For each: read `node.pendingCommand` — this is `C` (the raw template output, already computed by `convertDocumentSet`; the CLI never calls `applyTemplate`). If `node.pendingCommand === null`: skip (the node already has a manual reason). Look up the resolved pair from step 5 using `node.sourcePath` as the key. The test node's run command is `"! " + node.pendingCommand`. Look up `repoPath` from `--repo` keyed by `node.resolvedRepository`. Pass the resolved `failingId` as `commitRef`. Call `await input.runner({ command: "! " + node.pendingCommand, repoPath, commitRef: failingId })`. If `result.kept`: store `validatedTestCommands.set(node.sourcePath, node.pendingCommand)` (raw `C`) and set `commands: ["! " + node.pendingCommand]` for this node. Otherwise: set `commands: []` and add reason `"command-failed"`.

Pass 2 — process nodes whose `deliverable === "implementation"` in the `ConversionResult`. For each: the `pendingCommand` field already carries `C` (the raw command without `"! "`) from `convertDocumentSet`. Find the test node from `node.dependsOn` whose path maps to a `"test"`-deliverable node in the result. Look up the resolved pair using that test node's `sourcePath`. Look up `repoPath` from `--repo` keyed by `node.resolvedRepository`. If that test node has an entry in `validatedTestCommands`: call `await input.runner({ command: node.pendingCommand, repoPath, commitRef: passingId })`. If `result.kept`: set `commands: [node.pendingCommand]`. Otherwise: set `commands: []` and add reason `"command-failed"`. If the test node had no validated command (it was `command-failed`): set `commands: []` and add reason `"command-failed"` without calling `input.runner`.

The two-pass order is required: an implementation node cannot copy the test node's validated command before that command is known.

9. **Write output files.** Collect the rendered documents as `{ path: string; content: string }[]` for every `ConvertedNode`. Content is the result of `renderDocument(...)`. Call `writePlanDirectory(input.fs, { root: outputDir, documents })` (import from `"./directory.ts"`). It creates parent directories automatically — do not call `makeDirectory` or any `mkdirSync` directly. Write `convert-report.json` to `outputDir/convert-report.json` by calling `input.fs.writeFile(path.join(outputDir, "convert-report.json"), renderConvertReport(result))`.

10. **Register in `src/cli/program.ts`.** After Step A's import rename, add an import of `registerPlanConvert` from `"./plan/convert.ts"` alongside the existing plan-CLI imports. Add a call `registerPlanConvert({ program, cwd: dependencies.cwd, fs: dependencies.fs, readFrontmatter: (text) => dependencies.reader.read(text), runner, stdout: dependencies.stdout, stderr: dependencies.stderr, fail: dependencies.fail })` directly after the `registerPlanConvertHarness(...)` call at line 256. `src/cli/plan/index.ts` exports only `planCommand(program: Command): Command` and has no registration function to call into — do not edit it.

**`main.ts` binding** — add a `runner: ConvertRunner` binding in the `buildProgram` call site at `src/main.ts:880-885`. The binding constructs `new NodeSpawnVerify()` (imported from `src/services/verify/node-spawn.ts`) and calls `spawnAtCommit` (imported from `src/services/verify/spawn-at-commit.ts`):

```ts
const runner: ConvertRunner = (params) =>
  spawnAtCommit(new NodeSpawnVerify(), {
    ...params,
    gitPath: resolvedGitBinary, // resolved from configuration or environment
  });
```

Pass `runner` into `buildProgram` alongside the other injected callables. `main.ts` is the only file that names `NodeSpawnVerify` or `spawnAtCommit` by implementation name.

## Constraints

- `plan convert` never reads from or writes to the database. It calls no command and no query.
- `src/cli/plan/convert.ts` imports `domain/`, `http/contract/`, and `cli/` only. It does NOT import `src/commands/`, `src/queries/`, `src/services/`, or `node:child_process`. `AGENTS.md` `cli/` import rule is enforced by `eslint.config.js:374-400`.
- The `ConvertRunner` callable type is defined in `src/cli/plan/convert.ts` and carries plain data only. The `commitRef` field is always a resolved commit object id — the CLI resolves every ref before passing it in. The CLI never calls `applyTemplate`, never walks ancestry, and never re-reads a template; all those decisions are already in `ConvertedNode` from `convertDocumentSet`.
- The output directory and all parent directories are created by `writePlanDirectory`. Do not call `makeDirectory` or any platform-level `mkdirSync` directly from the action handler.
- `--at` values parse by splitting on the first `=`, then splitting the right-hand side on `..`. Malformed values (no `=`, or right-hand side with no `..`) are parse errors that call `input.stderr` and `input.fail`. A duplicate `test-source-path` key is a parse error. A key naming a path that is not a test node in the conversion result is a refusal: `commit-range-unknown`, naming the key. A silently ignored `--at` entry would allow a typo to produce a plausible tree with a command validated at the wrong commit.
- Both refs in every `--at` entry resolve to immutable commit object ids once, before the first command runs. A branch that moves mid-run has no effect on any extraction.
- `commit-range-missing` is refused and names the test source path when a `test` node would take a command and no `--at` entry keys that node's `sourcePath`. The refusal is suppressed by `--commands-none`.
- `already-converted` is refused and names the path when any input document carries `deliverable !== null`. The output directory stays empty on that refusal.
- `--repo <name>=<path>` values are parsed on first `=` only; a path containing `=` is not split further.
- Step A (rename) changes the Commander subcommand name from `"convert"` to `"convert-harness"`. Verify against the git tag history that the old name has never shipped in a tagged release before implementing.

## Verify

```
node --test src/cli/plan/convert.test.ts
```

Create `src/cli/plan/convert.test.ts` with suite name `"src/cli/plan/convert.test"`. All tests use a hermetic `mktemp` fixture tree (created and removed per test using `before`/`after`).

The fixture tree contains three documents: one initiative, one objective (repo `"kanthord-apps"`), one task (worker `"claude.te@1"`, body with `**Input:** src/foo.ts`). Each document has a `derivedParentPath` matching the directory structure. The template file contains `{"kanthord-apps": "node --test {path}"}`.

**Git fixture** — for tests that run commands: use the EPIC 005 hermetic fixture. Call `resolveTools(process.env, ["git"])` (from `test/helpers/remote/tools.ts:102`) to get `Tools<"git">`. Call `seedRepositories(tools)` (from `test/helpers/remote/seed.ts:124`) to get `SeedRoot`. Use `seed.repositories["fixture.git"].path` as `repoPath` and `seed.repositories["fixture.git"].head` as the HEAD commit SHA. The test uses this SHA directly as `failingId` (it is already a commit object id); a second SHA is derived for `passingId` (use a parent commit or the same SHA when the test does not distinguish, per the concrete test case below).

The `runner` injected into `PlanConvertCliInput` in tests wraps `spawnAtCommit(new NodeSpawnVerify(), { ...params, gitPath: tools.paths.git })`.

Add the following `it` blocks:

1. `"converts the fixture tree and writes the expected bytes per document"` — run with `--commands-none`. Assert the output directory contains exactly three files. Assert the full content of each written document equals the expected rendered string with `assert.equal` — not substring assertions. The initiative document must equal the exact bytes that `renderDocument` would produce for `deliverable: "expansion"`, `verify: { paths: [], commands: [] }`, key order `id`, `kind`, `title`, `deliverable`, `verify`. The objective document must equal the exact bytes for `deliverable: "expansion"`. The task document must equal the exact bytes for `deliverable: "test"`, `verify: { paths: ["src/foo.ts"], commands: [] }` (commands empty because `--commands-none`).

2. `"writes canonical convert-report.json"` — run with `--commands-none`. Read `output/convert-report.json` content. Assert the content equals the exact expected JSON bytes with `assert.equal`, using a literal that pins the full canonical JSON output (keys sorted bytewise, nodes sorted by `comparePaths`, two-space indentation, one trailing `\n`). Do not assert `JSON.parse` plus partial field checks — assert the full string.

3. `"checkout-required is emitted when a template applies and no --repo is given"` — run with `--template <file>` but no `--repo`. Assert `stderr` received a string starting with `"checkout-required"` and `fail` was called.

4. `"--commands-none converts deliverables and paths only and marks template nodes as command-failed"` — run with `--commands-none`. Assert the task node's `manualReasons` in the report contains `"command-failed"`. Assert `verify.commands` is empty.

5. `"output-not-empty refuses a non-empty output directory"` — create a file in the output dir before running. Assert `stderr` received `"output-not-empty"` and `fail` was called.

6. `"output-inside-input refuses an output directory inside the input directory"` — pass `outputDir = planDir + "/out"`. Assert `stderr` received `"output-inside-input"` and `fail` was called.

7. `"already-converted refuses when any input document carries deliverable"` — add a fourth document to the fixture that already has `deliverable: "expansion"` and `verify: { paths: [], commands: [] }` in its frontmatter. Run convert. Assert `stderr` received a string starting with `"already-converted"` naming the path. Assert `fail` was called. Assert the output directory stays empty.

8. `"worker-unmapped refuses when any input document carries an unmapped worker"` — add a fourth document to the fixture with `worker: "general@1"` (a member of `workerKinds` at `src/domain/worker.ts:3` that no conversion row maps, so a parseable document can carry it) and `kind: "task"`. Run convert. Assert `stderr` received a string starting with `"worker-unmapped"` naming the path. Assert `fail` was called. Assert the output directory stays empty.

9. `"commit-range-missing is refused and names the test source path"` — run with `--template <file>` and `--repo kanthord-apps=<repoPath>` but no `--at`. Assert `stderr` received a string starting with `"commit-range-missing"` containing the test node's source path. Assert `fail` was called.

10. `"two runs over the same legacy input produce byte-identical documents and a byte-identical report"` — run convert twice over the same legacy input tree into two separate empty output directories (`outputDir1` and `outputDir2`). Use `--commands-none` so command outcomes are deterministic. Compare the two output trees file by file including `convert-report.json`. Assert byte equality per file using `assert.equal`. Rename this test to reflect it is two runs over the same input, not a run over a prior output.

11. `"a test node's validated command begins with ! and the remainder equals the template output"` — use the git fixture above (EPIC 005 hermetic fixture). The template is `{"kanthord-apps": "false {path}"}`. The task node (worker `claude.te@1`, body `**Input:** src/foo.ts`) produces `C = "false src/foo.ts"`. The test node's generated command is `"! false src/foo.ts"`. Pass `--at <task-source-path>=<headSha>..<headSha>` (the fixture SHA serves as both `failing-ref` and `passing-ref` because `! false src/foo.ts` exits zero at any commit and the test asserts only the test node's command). At the fixture commit, `sh -c "! false src/foo.ts"` exits 0 (`false` exits 1; `!` inverts it to 0). Assert `runner` returns `{ kept: true }` for that invocation. Read the written output document and assert its `commands:` block contains `    - "! false src/foo.ts"`. This is the hermetic coverage line: a `test` node converts to a command that begins with `! `, and the remainder equals the template output exactly.

12. `"commit-range-unknown is refused when an --at key names a path that is not a test node"` — run with `--template <file>`, `--repo kanthord-apps=<repoPath>`, and `--at nonexistent/path.md=<sha>..<sha>` (a path that is not in the fixture tree). Assert `stderr` received a string starting with `"commit-range-unknown"` naming `"nonexistent/path.md"`. Assert `fail` was called.

13. `"a --at branch ref resolves to a commit object id once and a mid-run branch move changes nothing"` — use the git fixture. Wrap `input.runner` so it moves the branch to a different commit after the first call returns. Pass `--at <task-source-path>=<branchName>..<branchName>`. Assert the output document's `commands:` block contains the command derived from the original HEAD SHA, not the SHA the branch moved to. This proves refs are resolved to object ids before any command runs.

`pnpm run verify` exits 0.

Proof: PASS lines delivered — `src/cli/plan/convert.test.ts` in `PASS EPIC-049`. Hermetic coverage: written bytes per document; canonical report bytes; `checkout-required`; `--commands-none`; `output-not-empty`; `output-inside-input`; `already-converted` with empty output directory; `worker-unmapped` with empty output directory using `general@1`; `commit-range-missing` naming the test source path; `commit-range-unknown` refusing an `--at` key that names no test node; idempotent two runs over same legacy input; `! ` prefix on a test node's validated command; branch ref resolved to object id before first command.
