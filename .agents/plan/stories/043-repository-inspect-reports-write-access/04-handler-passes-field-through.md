# Story 4 — handler passes the new field through

Epic: `.agents/plan/epics/043-repository-inspect-reports-write-access.md`
Depends on: Story 2, Story 3

## Change

### `src/http/server/repository/inspect-repository.ts`

The handler (lines 17–53) already calls `repositoryInspectRequest.safeParse(context.body)` and extracts `{ remoteUrl, credentialId }`. Two edits:

**Edit 1** — destructure `requiredAccess` from the parsed body and pass it to the query:

```ts
const { remoteUrl, credentialId, requiredAccess } = parsed.data;
// ...
const result = await dependencies.inspectRepository({
  remoteUrl,
  credentialId,
  requiredAccess,
});
```

**Edit 2** — include `access` in the JSON response body:

```ts
return {
  kind: "json",
  status: 200,
  body: {
    defaultBranch: result.defaultBranch,
    branches: result.branches,
    credential: result.credential,
    hostKey:
      result.hostKey === null
        ? null
        : {
            algorithm: result.hostKey.algorithm,
            fingerprint: result.hostKey.fingerprint,
          },
    access: result.access,
  },
};
```

`result.access` is already `{ read: AccessVerdict; write: AccessVerdict | null }` — no mapping needed; `AccessVerdict` matches `accessVerdictView` field for field.

The handler branches on no verdict. It does not inspect `result.access.write`.

### `src/http/server/repository/inspect-repository.test.ts`

The file already has 9 test cases. Add after case 9:

10. `"body with requiredAccess write is forwarded to the query"`:
    - The fake `inspectRepository` captures its input and returns a fixed result.
    - POST body: `{ remoteUrl: "https://x.test/r.git", credentialId: "provider_01", requiredAccess: "write" }`.
    - Assert `fakeInput.requiredAccess === "write"`.
    - Assert the response status is 200.

11. `"response includes access field with write null when query returns write null"`:
    - Fake returns `{ ..., access: { read: { allowed: true, refusal: null }, write: null } }`.
    - Parse response with `repositoryInspectResponse.safeParse(body)` — `assert.equal(result.success, true)`.
    - `assert.deepEqual(body.access, { read: { allowed: true, refusal: null }, write: null })`.

12. `"response includes access.write verdict when query returns write non-null"`:
    - Fake returns `{ ..., access: { read: { allowed: true, refusal: null }, write: { allowed: false, refusal: "auth-failed" } } }`.
    - `assert.deepEqual(body.access.write, { allowed: false, refusal: "auth-failed" })`.
    - Response status is 200 (not 422).

13. `"requiredAccess push is rejected 400 before the query is called"`:
    - POST body: `{ remoteUrl: "https://x.test/r.git", credentialId: "provider_01", requiredAccess: "push" }`.
    - Fake `inspectRepository` throws `new Error("should not be called")`.
    - Assert response status 400 and `body.error.code === "invalid-request"`.

14. `"requiredAccess Write (mixed case) is rejected 400"`:
    - POST body: `{ remoteUrl: "https://x.test/r.git", credentialId: "provider_01", requiredAccess: "Write" }`.
    - Fake `inspectRepository` throws `new Error("should not be called")`.
    - Assert response status 400 and `body.error.code === "invalid-request"`.

15. `"requiredAccess empty string is rejected 400"`:
    - POST body: `{ remoteUrl: "https://x.test/r.git", credentialId: "provider_01", requiredAccess: "" }`.
    - Fake `inspectRepository` throws `new Error("should not be called")`.
    - Assert response status 400 and `body.error.code === "invalid-request"`.

## Constraints

- The handler parses, calls exactly one query, and formats. It does not branch on `result.access.write`.
- `result.access` is passed through to the response body as-is (no field remapping needed because `AccessVerdict` already matches `accessVerdictView`).
- `toHttpError` in `refusals.ts` is unchanged — `probePush` failures surface as `access.write.refusal`, not as thrown errors from the handler perspective.

## Verify

```
node --test src/http/server/repository/inspect-repository.test.ts
npm run verify
```

- All 15 test cases pass.
- `npm run verify` exits 0.

Proof: delivers `src/http/server/repository/inspect-repository.test.ts` line of `PASS EPIC-043`.
