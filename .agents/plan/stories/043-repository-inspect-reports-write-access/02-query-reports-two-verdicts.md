# Story 2 — query reports two verdicts

Epic: `.agents/plan/epics/043-repository-inspect-reports-write-access.md`
Depends on: Story 1

## Change

### `src/queries/repository/inspect-repository.ts`

**Add `AccessVerdict`** after `CredentialVerdict` (after line 30):

```ts
export type AccessVerdict = Readonly<{
  allowed: boolean;
  refusal: GitFailure | null;
}>;
```

**Extend `InspectRepositoryInput`** (lines 23–26) — add `requiredAccess`:

```ts
export type InspectRepositoryInput = Readonly<{
  remoteUrl: string;
  credentialId: string;
  requiredAccess?: "read" | "write";
}>;
```

**Extend `InspectRepositoryResult`** (lines 32–37) — add `access`:

```ts
export type InspectRepositoryResult = Readonly<{
  defaultBranch: string | null;
  branches: readonly string[];
  credential: CredentialVerdict;
  hostKey: HostKey | null;
  access: Readonly<{
    read: AccessVerdict;
    write: AccessVerdict | null;
  }>;
}>;
```

**Extend `inspectRepository` function body** (lines 129–175):

The function already calls `dependencies.git.remoteUrlVerdict`, `resolveGitCredential`, `dependencies.git.scanHostKeys`, and `dependencies.git.remoteInfo`. The new logic runs after all existing steps.

After the `remoteInfo` success branch (where `defaultBranch` and `branches` are available), build `access.read` and optionally call `probePush`. `probePush` can throw `GitError` when `fetchTracking` inside it fails (e.g., a credential that reads via `ls-remote` but whose fetch authentication also fails). Catch that throw and convert to a verdict, except for `url-refused` which stays a throw:

```ts
const read: AccessVerdict = { allowed: true, refusal: null };
let write: AccessVerdict | null = null;
if (input.requiredAccess === "write") {
  try {
    const probe = await dependencies.git.probePush({
      remoteUrl: input.remoteUrl,
      branch: info.defaultBranch,
      credential,
    });
    write = probe.allowed
      ? { allowed: true, refusal: null }
      : { allowed: false, refusal: probe.failure };
  } catch (error) {
    if (error instanceof GitError && error.failure !== "url-refused") {
      write = { allowed: false, refusal: error.failure };
    } else {
      throw error;
    }
  }
}
return {
  defaultBranch: info.defaultBranch,
  branches: info.branches,
  credential: { reachable: true, refusal: null },
  hostKey,
  access: { read, write },
};
```

In the `remoteInfo` failure branch (caught `GitError` where `failure !== "url-refused"`):

```ts
const refusal = error.failure;
const read: AccessVerdict = { allowed: false, refusal };
const write: AccessVerdict | null =
  input.requiredAccess === "write" ? { allowed: false, refusal } : null;
return {
  defaultBranch: null,
  branches: [],
  credential: { reachable: false, refusal },
  hostKey,
  access: { read, write },
};
```

`ProbePushInput` is already available through the `Git` interface — no new import needed. The type `ProbePushInput` is imported from `"../../services/git/index.ts"` alongside `Git` only if needed for explicit annotation; the call site can be inferred.

### `src/queries/repository/inspect-repository.test.ts`

Add the following test cases to the existing suite (the file already has 14 cases; append after the last one):

15. `"omitting requiredAccess returns access.write null"`:
    - Set up `gitMock.remoteInfo` to return `{ defaultBranch: "main", branches: ["main"] }`.
    - Call `inspectRepository(deps, { remoteUrl: httpsUrl, credentialId })` — no `requiredAccess`.
    - `assert.equal(result.access.write, null)`.
    - `assert.deepEqual(result.access.read, { allowed: true, refusal: null })`.

16. `"requiredAccess read behaves identically to omitting it"`:
    - Same setup; call with `requiredAccess: "read"`.
    - `assert.equal(result.access.write, null)`.
    - `assert.deepEqual(result.access.read, { allowed: true, refusal: null })`.
    - Assert response is deep-equal to the response from case 15 on every field.

17. `"requiredAccess write with writer credential returns both verdicts allowed"`:
    - Override `gitMock.probePush` to return `{ allowed: true }`.
    - Record the call input to assert it was called once with `{ remoteUrl: httpsUrl, branch: "main", credential: <resolved> }`.
    - `assert.deepEqual(result.access.read, { allowed: true, refusal: null })`.
    - `assert.deepEqual(result.access.write, { allowed: true, refusal: null })`.
    - `assert.deepEqual(result.credential, { reachable: true, refusal: null })`.

18. `"requiredAccess write with push-refused credential returns write false"`:
    - `gitMock.remoteInfo` returns `{ defaultBranch: "main", branches: ["main"] }`.
    - `gitMock.probePush` returns `{ allowed: false, failure: "auth-failed", detail: "" }`.
    - `assert.deepEqual(result.access.read, { allowed: true, refusal: null })`.
    - `assert.deepEqual(result.access.write, { allowed: false, refusal: "auth-failed" })`.
    - `assert.equal(result.credential.reachable, true)` — status is 200, never 422.

19. `"read failure short-circuits probe; write carries same refusal"`:
    - `gitMock.remoteInfo` throws `new GitError("auth-failed", "...", "")`.
    - `gitMock.probePush` throws `new Error("should not be called")`.
    - Call with `requiredAccess: "write"`.
    - `assert.equal(result.credential.reachable, false)`.
    - `assert.deepEqual(result.access.read, { allowed: false, refusal: "auth-failed" })`.
    - `assert.deepEqual(result.access.write, { allowed: false, refusal: "auth-failed" })`.
    - Assert `gitMock.probePush` was never called (zero invocations).

20. `"empty-remote branch returns write false with empty-remote refusal"`:
    - `gitMock.remoteInfo` returns `{ defaultBranch: null, branches: [] }`.
    - `gitMock.probePush` returns `{ allowed: false, failure: "empty-remote", detail: "" }`.
    - Call with `requiredAccess: "write"`.
    - `assert.deepEqual(result.access.write, { allowed: false, refusal: "empty-remote" })`.
    - Assert `gitMock.probePush` was called with `branch: null`.

21. `"read failure without requiredAccess write leaves access.write null"`:
    - `gitMock.remoteInfo` throws `new GitError("transport-failed", "...", "")`.
    - Call without `requiredAccess` (or with `"read"`).
    - `assert.equal(result.access.write, null)`.
    - `assert.deepEqual(result.access.read, { allowed: false, refusal: "transport-failed" })`.

22. `"probePush throws GitError (fetch fails) and query converts to write verdict"`:
    - `gitMock.remoteInfo` returns `{ defaultBranch: "main", branches: ["main"] }`.
    - `gitMock.probePush` throws `new GitError("auth-failed", "probe fetch failed", "detail")`.
    - Call with `requiredAccess: "write"`.
    - Response is a full `InspectRepositoryResult` (no throw from the query).
    - `assert.deepEqual(result.access.write, { allowed: false, refusal: "auth-failed" })`.
    - `assert.deepEqual(result.access.read, { allowed: true, refusal: null })`.

23. `"no token or private key in serialized result when requiredAccess write"`:
    - `gitMock.probePush` returns `{ allowed: true }`.
    - Serialize result with `JSON.stringify(result)`.
    - Assert the serialized string does not contain the fixture's token or private key value (use the same assertion pattern as the existing case 14).

The existing `gitMock` (lines 108–208) must be extended to include a `probePush` field. Default behavior: throw `new Error("unexpected probePush call")`. Override per test as shown above.

## Constraints

- The query imports `Git` from `../../services/git/index.ts` — `probePush` is on that interface and needs no new import.
- `src/queries/` may not import a service implementation — only the interface. `probePush` is on the `Git` interface; the implementation is in `push-probe.ts`.
- No branch on the verdict inside the handler — the verdict logic stays entirely in this query.

## Verify

```
node --test src/queries/repository/inspect-repository.test.ts
npm run verify
```

- All 23 test cases pass.
- `npm run verify` exits 0.

Proof: delivers `src/queries/repository/inspect-repository.test.ts` line of `PASS EPIC-043`.
