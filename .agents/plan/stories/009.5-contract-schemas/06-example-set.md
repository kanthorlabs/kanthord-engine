# Story 06 — one request, success and error example per operation

Epic: `.agents/plan/epics/009.5-contract-schemas.md`
Depends on: Story 05 (an error example must satisfy **its own operation's** envelope).

## Change

### 1. `Operation` gains an `examples` slot

`src/http/contract/operation.ts` — add above the `Operation` type at `:19`:

```ts
export type OperationExamples = Readonly<{
  query?: unknown;
  request?: unknown;
  success: unknown;
  error: unknown;
}>;
```

In `Operation` (`:19-28`), add `examples?: OperationExamples;` as the last member, after `response?: ZodType;`.

### 2. New file `src/http/contract/example-literal.ts` — the shared literals

Every example draws from these, so the same value never appears in two spellings.

```ts
export const EXAMPLE_AT = 1738368000000;
export const EXAMPLE_ULID = "01JQ8Z7G3HZZZZZZZZZZZZZZZZ";
export const EXAMPLE_HASH = `sha256:${"a".repeat(64)}`;
export const EXAMPLE_FINGERPRINT = `SHA256:${"A".repeat(43)}`;
export const EXAMPLE_LANDING_OID = "a".repeat(40);
export const EXAMPLE_TRACKING_OID = "b".repeat(40);
export const EXAMPLE_UPSTREAM_OID = "c".repeat(40);
```

`EXAMPLE_ULID` satisfies `ulidPattern` (`src/domain/identity.ts:45`), verified. The id prefixes come from
`identityPrefixes` (`src/domain/identity.ts:25-43`) — note `repository` is **`repo`** and `planRevision` is
**`revision`**.

### 3. The 22 example sets, verbatim

Author each set in the module that holds its schemas, immediately above the `operations([...])` call, typed
`OperationExamples`, and bind it on the entry with `examples: <name>,` as the last property. These are the
values — the implementing agent transcribes them and chooses nothing.

Read `A` as `EXAMPLE_AT`, `U` as `EXAMPLE_ULID`, `H` as `EXAMPLE_HASH`, `F` as `EXAMPLE_FINGERPRINT`, and
`OID_L` / `OID_T` / `OID_U` as the three oid constants.

#### `src/http/contract/system.ts`

```ts
export const systemHealthExamples: OperationExamples = {
  success: {
    status: "ok",
    dependencies: [{ name: "storage", status: "ok" }],
  },
  error: {
    error: {
      code: "service-unavailable",
      message: "the daemon is shutting down",
    },
  },
};

export const systemDbExamples: OperationExamples = {
  success: {
    migrations: [
      { version: 1, name: "core-entities", applied: true, appliedAt: A },
    ],
  },
  error: {
    error: {
      code: "service-unavailable",
      message: "the daemon is shutting down",
    },
  },
};

export const systemStatusExamples: OperationExamples = {
  success: {
    version: KANTHORD_VERSION,
    bind: "127.0.0.1:7777",
    startedAt: "2025-02-01T00:00:00.000Z",
    status: "ok",
    dependencies: [{ name: "storage", status: "ok" }],
    nodes: [{ kind: "task", state: "ready", blockReason: null, count: 1 }],
    repositories: [
      {
        id: `repo_${U}`,
        name: "atlas",
        divergedLandingOid: OID_L,
        divergedUpstreamOid: OID_U,
      },
    ],
    leases: [
      {
        subjectKind: "node",
        subjectId: `task_${U}`,
        owner: null,
        fence: 1,
        expiresAt: A,
      },
    ],
  },
  error: {
    error: {
      code: "service-unavailable",
      message: "the daemon is shutting down",
    },
  },
};
```

`system.ts` imports `KANTHORD_VERSION` from `../../domain/version.ts` for this. A restated `"27.8.1"` would
drift from the daemon version on the next release, and `openapi.test.ts:65` already pins `info.version` to the
same constant.

#### `src/http/contract/credential.ts`

```ts
export const providerRegisterExamples: OperationExamples = {
  request: {
    name: "github",
    kind: "git",
    payload: {
      transport: "http-basic",
      forge: "github",
      username: "atlas",
      password: "x",
    },
  },
  success: {
    id: `provider_${U}`,
    name: "github",
    kind: "git",
    projection: { transport: "http-basic", forge: "github", username: "atlas" },
    setDefaultAt: null,
    updatedAt: A,
  },
  error: {
    error: {
      code: "invalid-request",
      message: "a provider named github is already registered",
      details: { refusal: "name-taken" },
    },
  },
};

export const providerListExamples: OperationExamples = {
  success: { providers: [providerRegisterExamples.success] },
  error: {
    error: {
      code: "service-unavailable",
      message: "the daemon is shutting down",
    },
  },
};

export const providerShowExamples: OperationExamples = {
  success: providerRegisterExamples.success,
  error: { error: { code: "not-found", message: `no provider provider_${U}` } },
};
```

Reusing `providerRegisterExamples.success` as the list element and the show body is deliberate: one authored
view, three operations, so the three cannot disagree.

#### `src/http/contract/repository.ts`

```ts
export const repositoryInspectExamples: OperationExamples = {
  request: {
    remoteUrl: "https://example.test/atlas.git",
    credentialId: `provider_${U}`,
  },
  success: {
    defaultBranch: "main",
    branches: ["main"],
    credential: { reachable: true, refusal: null },
    hostKey: null,
  },
  error: {
    error: {
      code: "credential-rejected",
      message: "the forge refused the credential",
      details: { failure: "auth-failed" },
    },
  },
};

export const repositoryView_example = {
  id: `repo_${U}`,
  name: "atlas",
  remoteUrl: "https://example.test/atlas.git",
  credential: { id: `provider_${U}`, name: "github" },
  upstreamBranch: "main",
  landingBranch: "kanthord/landing",
  landingRef: "refs/heads/kanthord/landing",
  trackingRef: "refs/kanthord/upstream/main",
  publishRef: "refs/heads/main",
  publishOnApproval: true,
  state: "ready",
  landingOid: OID_L,
  trackingOid: OID_T,
  fetchedUpstreamOid: OID_U,
  divergedLandingOid: null,
  divergedUpstreamOid: null,
  updatedAt: A,
};

export const repositoryRegisterExamples: OperationExamples = {
  request: {
    name: "atlas",
    remoteUrl: "https://example.test/atlas.git",
    credentialId: `provider_${U}`,
    upstreamBranch: "main",
    landingBranch: "kanthord/landing",
    publishRef: "refs/heads/main",
    publishOnApproval: true,
    hostFingerprint: null,
  },
  success: repositoryView_example,
  error: {
    error: {
      code: "host-key-mismatch",
      message: `the host presented no key matching ${F}`,
      details: { presented: [F], confirmed: F },
    },
  },
};

export const repositoryListExamples: OperationExamples = {
  success: { repositories: [repositoryView_example] },
  error: {
    error: {
      code: "service-unavailable",
      message: "the daemon is shutting down",
    },
  },
};

export const repositoryShowExamples: OperationExamples = {
  success: repositoryView_example,
  error: { error: { code: "not-found", message: `no repository repo_${U}` } },
};
```

`hostFingerprint: null` is correct for an `https` url — `docs/proposal/api/repository.md:44` refuses a
fingerprint on an `http-basic` url.

#### `src/http/contract/project.ts`

```ts
export const projectView_example = {
  id: `project_${U}`,
  name: "atlas",
  repositories: [`repo_${U}`],
  updatedAt: A,
};

export const projectCreateExamples: OperationExamples = {
  request: { name: "atlas" },
  success: { ...projectView_example, repositories: [] },
  error: {
    error: {
      code: "invalid-request",
      message: "a project named atlas already exists",
      details: { refusal: "name-taken" },
    },
  },
};

export const projectListExamples: OperationExamples = {
  success: { projects: [projectView_example] },
  error: {
    error: {
      code: "service-unavailable",
      message: "the daemon is shutting down",
    },
  },
};

export const projectShowExamples: OperationExamples = {
  success: projectView_example,
  error: { error: { code: "not-found", message: `no project project_${U}` } },
};

export const projectRepositoriesExamples: OperationExamples = {
  request: { repositories: [`repo_${U}`] },
  success: projectView_example,
  error: {
    error: {
      code: "invalid-request",
      message: "the same repository appears twice",
      details: { refusal: "duplicate-repository" },
    },
  },
};
```

`project.create` returns an empty `repositories`, because a new project binds none — that is why it spreads the
shared view and overrides the one field.

#### `src/http/contract/graph.ts`

```ts
const planDocument_example = {
  path: "initiative/atlas.md",
  content: "# atlas\n",
};

export const planValidateExamples: OperationExamples = {
  request: { fromRevision: null, documents: [planDocument_example] },
  success: {
    findings: [],
    documents: [planDocument_example],
    documentsHash: H,
    revision: null,
    choices: [],
  },
  error: {
    error: {
      code: "plan-invalid",
      message: "the submission is not a valid plan",
      details: {
        findings: [
          {
            code: "acceptance-heading-duplicated",
            path: "initiative/atlas.md",
            id: null,
            message: "the acceptance heading appears twice",
          },
        ],
      },
    },
  },
};

export const planImportExamples: OperationExamples = {
  request: {
    fromRevision: null,
    importId: "import-0001",
    documents: [planDocument_example],
    choices: [],
    validatedRevision: null,
    documentsHash: H,
  },
  success: {
    revision: `revision_${U}`,
    documents: [planDocument_example],
    absent: [],
  },
  error: {
    error: {
      code: "stale-revision",
      message: `the import names null, the newest revision is revision_${U}`,
      details: { expected: null, current: `revision_${U}` },
    },
  },
};

export const planExportExamples: OperationExamples = {
  success: { revision: `revision_${U}`, documents: [planDocument_example] },
  error: { error: { code: "not-found", message: `no project project_${U}` } },
};

export const planRevisionsExamples: OperationExamples = {
  success: {
    revisions: [
      {
        id: `revision_${U}`,
        parentId: null,
        importId: "import-0001",
        submittedBlob: H,
        choicesBlob: H,
        acceptedBlob: H,
      },
    ],
  },
  error: { error: { code: "not-found", message: `no project project_${U}` } },
};

const nodeListItem_example = {
  id: `task_${U}`,
  projectId: `project_${U}`,
  kind: "task",
  title: "add the health route",
  state: "ready",
  blockReason: null,
  discardReason: null,
  parentId: `objective_${U}`,
  dependencies: [],
};

export const nodeListExamples: OperationExamples = {
  success: { nodes: [nodeListItem_example] },
  error: { error: { code: "not-found", message: `no project project_${U}` } },
};

export const nodeShowExamples: OperationExamples = {
  success: {
    ...nodeListItem_example,
    instructionBlob: H,
    acceptanceBlob: null,
    worker: null,
    repositoryId: `repo_${U}`,
    revision: `revision_${U}`,
    updatedAt: A,
  },
  error: { error: { code: "not-found", message: `no node task_${U}` } },
};

export const edgeListExamples: OperationExamples = {
  success: {
    edges: [
      {
        id: `edge_${U}`,
        fromNode: `task_${U}`,
        toNode: `objective_${U}`,
        waivedAt: null,
      },
    ],
  },
  error: { error: { code: "not-found", message: `no project project_${U}` } },
};
```

`plan.validate` returns an empty `findings` and `choices` on the success example — a first validation of a clean
plan has neither, and the non-empty shapes are exercised by the `plan-invalid` error example and by
`planChoiceEntry`'s own unit test.

#### `src/http/contract/event.ts`

```ts
export const eventListExamples: OperationExamples = {
  query: {
    after: null,
    limit: 100,
    subjectKind: null,
    subject: null,
    type: null,
    actorKind: null,
    actor: null,
  },
  success: {
    events: [
      {
        id: `event_${U}`,
        type: "node.state.changed",
        subjectKind: "node",
        subjectId: `task_${U}`,
        actorKind: "daemon",
        actorId: "kanthord",
        payload: { from: "pending", to: "ready" },
        createdAt: A,
      },
    ],
  },
  error: {
    error: { code: "invalid-request", message: "limit must not exceed 500" },
  },
};
```

The `query` example spells every field explicitly, including the defaults, so a client reads the full parameter
set from one fixture.

### 4. New file `src/http/contract/example.test.ts`

`describe` title: `"src/http/contract/example.test"`. Import `registry` from `./registry.ts` and
`buildErrorEnvelope` from `./errors.ts`.

Define the scope once:

```ts
const scoped = registry.filter(
  (entry) =>
    entry.status === "routed" &&
    entry.introducedIn === "phase-1" &&
    entry.operationId !== "blob.show",
);
```

Tests:

- `"covers the twenty-two phase-1 routed operations"` — `assert.equal(scoped.length, 22)`, and every entry has
  `examples !== undefined`.
- `"every success example satisfies its response schema"` — walk `scoped`; assert `entry.response !==
undefined`; `entry.response.parse(entry.examples.success)` does not throw. Name the `operationId` in the
  message.
- `"every request example satisfies its request schema"` — walk `scoped`; when `entry.request !== undefined`
  assert `entry.examples.request !== undefined` and parses; when `entry.request === undefined` assert
  `entry.examples.request === undefined`.
- `"every query example satisfies its query schema"` — the same pairing for `entry.query`. Assert `event.list`
  is the only entry with a `query` example.
- `"every error example satisfies its own operation's envelope"` — walk `scoped`;
  `buildErrorEnvelope(entry.errors).parse(entry.examples.error)` does not throw. Parsing against the **baseline**
  envelope is not enough: `plan.import`'s `stale-revision` example is rejected by the baseline, and that is the
  point of Story 05.
- `"an error example naming an undeclared code fails"` — the negative control that proves the per-operation
  keying works: assert `buildErrorEnvelope(findOperation("project.list").errors).parse({error:{code:"plan-invalid",
message:"m",details:{findings:[]}}})` throws, while the same object parses against
  `buildErrorEnvelope(findOperation("plan.import").errors)`.
- `"a broken example fails its schema"` — the negative control, inline and not committed as an example:
  assert `registry` `project.create`'s `response` throws on `{ id: "x", name: "y", repositories: [],
updatedAt: "not-a-number" }`, and assert `buildErrorEnvelope(baselineErrors)` throws on
  `{ error: { code: "invalid-request", message: 7 } }` for every operation's envelope.
- `"no stubbed operation carries an example"` — every entry with `status === "stubbed"` has
  `examples === undefined`.
- `"blob.show carries no example"` — `findOperation("blob.show")?.examples === undefined`.
- `"every example is a plain JSON value"` — for each entry,
  `assert.deepEqual(JSON.parse(JSON.stringify(entry.examples)), entry.examples)`, so no `undefined` value, no
  `Date` and no `Map` reaches the published set.

### 5. Update the pinned example count nowhere else

`src/http/contract/registry.test.ts` pins `request` and `response` lists only. `examples` needs no entry there.
Story 07 adds the registry-walking coverage assertion.

## Constraints

- Change no schema in this story. An example that does not parse is an example defect, not a schema defect.
- Author no example for a `stubbed` operation and none for `blob.show`.
- Every example value is a literal drawn from `example-literal.ts`. Determinism forbids a generated value, and
  `AGENTS.md` names a timestamp in a snapshot a defect. No `Date.now()`, no `ulid()`, no `randomUUID()`.
- Transcribe the 22 sets of step 3 exactly. Do not substitute a different name, id, branch or message: the
  published example set is client-visible contract data, and choosing a value here is a design decision this
  story has already made.
- Each `error` example already names a code the operation's own `refusals.ts` emits, or `not-found` for a read,
  or `service-unavailable` for an infallible read. Do not change the chosen code.
- `system.status`'s `version` imports `KANTHORD_VERSION`; it is the one example field that is not a literal,
  because a literal would drift from the daemon version.

## Verify

- `node --test src/http/contract/example.test.ts` — every test above passes. Then break one committed example,
  for example change `project.create`'s `success.updatedAt` to `"soon"`, and confirm the suite fails naming
  `project.create`. Restore it. Then delete one `examples:` binding and confirm the coverage test fails naming
  the operation. Restore it.
- `node --test src/http/contract/coverage.test.ts` — passes unchanged.
- `node --test src/http/contract/openapi.test.ts` — `:205` the 30-component list and `:261` the byte-identical
  render pass. `examples` registers no component and reaches no path object, so the generated document is
  unchanged by this story.
- `npm test` — the whole suite passes.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-009.5`.
