# Story 05 — validation

Epic: `.agents/plan/epics/008-project-and-plan.md`
Depends on: Story 02 (`cycles`), Story 02.5 (`ValidationContext`'s reader), Story 03 (the reader and the body split), Story 04 (the path grammar).

Every finding is collected. Validation never stops at the first, because a human who edits a plan by hand wants one round trip (`docs/proposal/phase-1/plan-format.md:23`).

## Change

### 1. `src/domain/plan-document.ts` (new — pure)

The frontmatter schema, in the canonical key order of `plan-format.md:45`:

```ts
export const planFrontmatter = z.object({
  id: z.string().optional(),
  kind: nodeKind,
  title: z.string().min(1),
  depends_on: z.array(z.string().min(1)).optional(),
  worker: workerKind.optional(),
  repo: z.string().min(1).optional(),
});
```

`nodeKind` comes from `src/domain/state.ts:5` and `workerKind` from `src/domain/worker.ts`. An unknown frontmatter key is a finding rather than a silently dropped field, and the finding names the key.

The schema is `.passthrough().superRefine(...)`, not `.strict()`. Two zod 4 behaviours force this. `.strict()` reports an unknown key as one `unrecognized_keys` issue whose `path` is `[]`, and the assertion below requires the path to be the key itself. The default `strip` mode removes the unknown key before `superRefine` runs, so the check would find nothing. `.passthrough()` keeps the key, and `superRefine` adds one issue per unknown key at `path: [key]`.

```ts
export type ParsedDocument = Readonly<{
  path: string;
  kind: NodeKind;
  id: string | null;
  title: string;
  dependsOn: readonly string[];
  worker: string | null;
  repo: string | null;
  derivedParentPath: string | null;
  instruction: string;
  acceptance: string | null;
}>;
```

### 2. `src/domain/plan-finding.ts` (new — pure)

```ts
export const findingCodes = [
  "acceptance-heading-duplicated",
  "acceptance-heading-not-at-line-start",
  "acceptance-missing",
  "acceptance-unexpected",
  "dependency-cross-parent",
  "dependency-cycle",
  "dependency-self",
  "document-unparsable",
  "frontmatter-invalid",
  "identity-duplicate",
  "identity-invalid",
  "identity-kind-mismatch",
  "initiative-without-objective",
  "objective-without-task",
  "parent-missing",
  "path-duplicate",
  "path-invalid",
  "reference-ambiguous",
  "reference-unresolved",
  "repo-missing",
  "repo-on-task",
  "repository-unbound",
  "repository-unknown",
  "worker-unknown",
] as const;

export type FindingCode = (typeof findingCodes)[number];

export type Finding = Readonly<{
  code: FindingCode;
  path: string | null;
  id: string | null;
  message: string;
}>;

export function sortFindings(findings: readonly Finding[]): readonly Finding[];
```

Twenty-four codes, bytewise sorted in the array, and the array is pinned by a test. `sortFindings` orders by `comparePaths(path)` with `null` first, then by `code`, then by `id` with `null` first. That is the response order, so two runs over one input produce one byte sequence.

`path-invalid` carries the `SubmittedPathErrorCode` of Story 04 in its `message`; `document-unparsable` carries the `DocumentErrorCode` of Story 03. The eight path codes and the three document codes are not duplicated in `findingCodes`, because a client routes on `error.code` and reads the message (`docs/proposal/api/README.md:161`).

### 3. `src/domain/plan-validate.ts` (new — pure)

The collector lives in `domain/`, and the two capabilities it needs arrive as plain function parameters rather than as service interfaces. `domain/` may import only `domain/`, and the caller adapts `DocumentReader.read` and `Graph.cycles` to these two types. That is what lets one collector serve both `plan.validate` (a query) and `plan.import` (a command), which may not import each other.

```ts
export type FrontmatterReader = (
  text: string,
) => Readonly<{ frontmatter: unknown; body: string }>;

export type CycleFinder = (
  input: Readonly<{
    nodes: readonly Readonly<{ id: string; parentId: string | null }>[];
    edges: readonly Readonly<{ from: string; to: string }>[];
  }>,
) => readonly (readonly string[])[];

export type ValidationResult = Readonly<{
  documents: readonly ParsedDocument[];
  findings: readonly Finding[];
}>;

export function validateDocuments(
  dependencies: Readonly<{
    readFrontmatter: FrontmatterReader;
    findCycles: CycleFinder;
    mint: (kind: NodeKind) => string;
  }>,
  input: Readonly<{
    submitted: readonly Readonly<{ path: string; content: string }>[];
    context: ValidationContext;
    databaseIdentities: readonly string[];
  }>,
): ValidationResult;
```

`ValidationContext` is imported from `src/domain/plan-graph.ts`, which Story 02.5 owns. Declaring it here would make Story 02.5 depend on this story while this story depends on Story 02.5.

A `DocumentError` thrown by `readFrontmatter` is caught here, so the adapter passes the service method through untouched and the collector owns the finding.

The pass order is fixed, and **every** pass runs even when an earlier one produced findings. A document that failed its own parse is excluded from the later passes and from `documents`.

1. **Path pass.** `parseSubmittedPath` per submitted entry. A throw is `path-invalid`. A path appearing twice is `path-duplicate`, reported once per extra occurrence, and every occurrence of that path is excluded from the later passes.
2. **Document pass.** `reader.read(content)`; a `DocumentError` is `document-unparsable`. `planFrontmatter.safeParse` on the result; a failure is one `frontmatter-invalid` per zod issue, the message being the issue path joined with `.` and its message. `normalizeBody` then `splitBody`; a `BodySplitError` becomes the matching finding code.
3. **Kind pass.** `frontmatter.kind` must equal the kind the path derives. A mismatch is `frontmatter-invalid` naming `kind`. An objective or initiative with a non-null `acceptance` is `acceptance-unexpected`; a task with a `null` acceptance is `acceptance-missing`. A task with a `repo` is `repo-on-task`; an objective with no `repo` is `repo-missing`. `docs/proposal/database/node.md:34`.
4. **Identity pass.** Story 06 owns it. This pass calls `resolveIdentities` and appends the findings it returns: `identity-invalid`, `identity-kind-mismatch`, `identity-duplicate`, `reference-unresolved`, `reference-ambiguous`.
5. **Containment pass.** `derivedParentPath` must name a document in the submitted set or, for a re-import, a node in the database. Absent from both is `parent-missing`. The database side arrives as `databasePaths`, a `ReadonlyMap<string, string>` of canonical path to identity that `validateDocuments` and `resolveIdentities` both take; the caller builds it with `canonicalPaths` over the stored nodes. A parent resolved through it sets `parentIdentity` and carries no parent edge into the cycle pass, because the parent is not a node of the submitted graph. An initiative with no objective child is `initiative-without-objective`; an objective with no task child is `objective-without-task`. `docs/proposal/phase-1/state-machine.md:47`.
6. **Reference pass.** A `depends_on` entry resolving to the declaring document itself is `dependency-self`. Two resolved endpoints whose derived parents differ is `dependency-cross-parent`, per `docs/proposal/database/edge.md:16`.
7. **Worker and repository pass.** `worker` outside `context.workerKinds` is `worker-unknown`. `repo` outside `context.knownRepositories` is `repository-unknown`. `repo` inside `knownRepositories` but outside `boundRepositories` is `repository-unbound`, which is the refusal `docs/proposal/api/project.md:26` requires. A `repo` value is matched as a repository **id**, not a name.
8. **Cycle pass.** `findCycles({ nodes, edges })` over the resolved identities; each reported component is one `dependency-cycle` finding whose `message` names the component's ids joined with `" -> "` in the returned order, and whose `id` is the component's first id.

### 4. The context reader is `PlanStore.readValidationContext`

Story 02.5 owns both the reader and the `ValidationContext` type.

## Constraints

- Every pass runs. A test asserts three findings from one document, and a second asserts findings from two passes on two documents.
- Findings are returned through `sortFindings` and never in discovery order.
- No pass throws. Every fault is a finding. The one exception is a `GraphError` other than a cycle, which is a defect in this module rather than in the document.
- `src/domain/plan-validate.ts` imports only `domain/`. `eslint.config.js:204-219` denies it every `node:*`, `ulid` and vendor package, and `zod` stays its one runtime dependency.
- A `repo` value is a repository id. Story 15's CLI resolves a name to an id before it submits.
- Validation writes nothing and holds no SQL.

## Verify

```
node --test src/domain/plan-finding.test.ts src/domain/plan-document.test.ts \
  src/domain/plan-validate.test.ts
```

`readFrontmatter` and `findCycles` come from `createPlanReader()` and `createPlanGraph()` in `test/helpers/plan.ts` (Stories 02.5, 02, 03). Real implementations, reached through a helper: a fake reader would re-implement YAML and a fake cycle finder would re-implement Tarjan, and `AGENTS.md`'s test rule forbids this test from importing either implementation directly. `mint` is `createMockIdGenerator({ ulids: [...] }).mint`.

### `plan-finding.test.ts`

- `findingCodes.length === 24`, the array `deepEqual`s the literal list, and it is bytewise sorted with no duplicate.
- `sortFindings` on a shuffled table returns one exact array. The table holds two findings sharing a path and differing in code, two sharing path and code and differing in id, and one with a `null` path.
- `sortFindings` is stable across two calls and does not mutate its input.

### `plan-document.test.ts`

- `planFrontmatter` accepts the minimal task frontmatter and the full objective frontmatter.
- An unknown key `status: "done"` fails, and the issue path is `status`. This is the assertion that keeps a status field out of a plan document (`plan-format.md:33`).
- `kind: "epic"` fails. `title: ""` fails. `depends_on: []` parses. `depends_on: [""]` fails. `worker: "nope@9"` fails.

### `plan-validate.test.ts`

Every case names its documents inline as template literals so the bytes are visible in the test.

- **A valid two-objective plan produces no finding.** One initiative, two objectives, three tasks, with `depends_on` by path. `findings` deep-equals `[]`, and `documents.length === 6`.
- **One document with three faults returns three findings.** A task carrying `repo`, no `## Acceptance criteria` section, and an unknown `worker`. `findings.map((f) => f.code)` deep-equals `["acceptance-missing","repo-on-task","worker-unknown"]` — the sorted order, not the discovery order. This is the EPIC's "one document with three faults returns three findings" coverage line.
- Two documents each with one fault return two findings, ordered by path.
- Each of the twenty-four codes is produced by one named case. `path-invalid` and `document-unparsable` each carry the underlying code in the message, asserted with `includes`.
- A duplicate path returns exactly one `path-duplicate`, and neither occurrence appears in `documents`.
- **A cycle is reported and does not throw.** Two tasks depending on each other yield one `dependency-cycle` whose message names both ids in the component's returned order.
- A three-node cycle yields one finding, not three.
- **An objective naming a repository that is not bound to its project is refused.** `context.knownRepositories` holds `repo_a` and `repo_b`, `boundRepositories` holds `repo_a` only, and an objective with `repo: "repo_b"` yields exactly one `repository-unbound`. An objective with `repo: "repo_missing"` yields `repository-unknown`. This is the EPIC's project-binding coverage line, and Story 11 asserts the same refusal through the route.
- An objective with no task yields `objective-without-task`; an initiative with no objective yields `initiative-without-objective`. A plan holding both faults yields both.
- A task whose objective directory holds no `objective.md` yields `parent-missing`.
- A task depending on a task under a different objective yields `dependency-cross-parent`.
- A task depending on itself yields `dependency-self` and no `dependency-cycle`.
- **Determinism.** Every case is run twice and the two `ValidationResult` values `deepEqual`. One case is run with its `submitted` array reversed and yields the identical result, because array order carries no meaning (`docs/proposal/api/graph.md:52`).

The `ValidationContext` reader is covered by `src/services/plan/sqlite.test.ts` (Story 02.5).

`npm run verify` exits 0.

Proof: contributes `src/domain/plan-finding.test.ts`, `plan-document.test.ts` and `plan-validate.test.ts`. It is inside the EPIC Proof glob, so it delivers `PASS EPIC-008`.
