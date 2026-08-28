# Story 3 — contract admits requiredAccess and declares access

Epic: `.agents/plan/epics/043-repository-inspect-reports-write-access.md`

## Change

### `src/http/contract/repository.ts`

**Extend `repositoryInspectRequest`** (lines 21–24) — add optional `requiredAccess`:

```ts
z.strictObject({
  remoteUrl: z.string().min(1),
  credentialId: z.string().min(1),
  requiredAccess: z.enum(["read", "write"]).optional(),
});
```

**Add `accessVerdictView`** after `hostKeyView` (after line 29):

```ts
const accessVerdictView = z.strictObject({
  allowed: z.boolean(),
  refusal: z.string().nullable(),
});
```

**Extend `repositoryInspectResponse`** (lines 31–39) — add `access` field:

```ts
z.strictObject({
  defaultBranch: z.string().nullable(),
  branches: z.array(z.string()),
  credential: z.strictObject({
    reachable: z.boolean(),
    refusal: z.string().nullable(),
  }),
  hostKey: hostKeyView.nullable(),
  access: z.strictObject({
    read: accessVerdictView,
    write: accessVerdictView.nullable(),
  }),
});
```

**Update `repositoryInspectExamples`** (lines 99–117) — add `requiredAccess` to the request example and `access` to the success example:

```ts
request: {
  remoteUrl: "https://example.test/atlas.git",
  credentialId: `provider_${U}`,
  requiredAccess: "read",
},
success: {
  defaultBranch: "main",
  branches: ["main"],
  credential: { reachable: true, refusal: null },
  hostKey: null,
  access: { read: { allowed: true, refusal: null }, write: null },
},
```

Keep the `error` example unchanged.

### New file `src/http/contract/repository.test.ts`

`src/http/contract/repository.test.ts` does not exist today — this story creates it from scratch.

Suite name: `"src/http/contract/repository.ts"`. Uses `node:test` and `node:assert/strict`.

Import only: the Zod schemas `repositoryInspectRequest` and `repositoryInspectResponse` from `"./repository.ts"`.

**Test cases**:

1. `"repositoryInspectRequest rejects extra fields"`:
   - Parse `{ remoteUrl: "https://x.test/r.git", credentialId: "provider_01", extra: true }`.
   - `assert.equal(result.success, false)`.

2. `"repositoryInspectRequest accepts absent requiredAccess"`:
   - Parse `{ remoteUrl: "https://x.test/r.git", credentialId: "provider_01" }`.
   - `assert.equal(result.success, true)`.
   - `assert.equal(result.data.requiredAccess, undefined)`.

3. `"repositoryInspectRequest accepts requiredAccess read"`:
   - Parse with `requiredAccess: "read"` — `assert.equal(result.success, true)`.

4. `"repositoryInspectRequest accepts requiredAccess write"`:
   - Parse with `requiredAccess: "write"` — `assert.equal(result.success, true)`.

5. `"repositoryInspectRequest rejects requiredAccess push"`:
   - Parse with `requiredAccess: "push"` — `assert.equal(result.success, false)`.

6. `"repositoryInspectRequest rejects requiredAccess Write (case sensitive)"`:
   - Parse with `requiredAccess: "Write"` — `assert.equal(result.success, false)`.

7. `"repositoryInspectRequest rejects requiredAccess empty string"`:
   - Parse with `requiredAccess: ""` — `assert.equal(result.success, false)`.

8. `"repositoryInspectResponse accepts access.write null"`:
   - Parse a full valid response with `access: { read: { allowed: true, refusal: null }, write: null }`.
   - `assert.equal(result.success, true)`.

9. `"repositoryInspectResponse accepts access.write non-null"`:
   - Parse with `access: { read: { allowed: true, refusal: null }, write: { allowed: false, refusal: "auth-failed" } }`.
   - `assert.equal(result.success, true)`.

10. `"repositoryInspectResponse rejects missing access"`:
    - Parse a response body without the `access` field — `assert.equal(result.success, false)`.

11. `"repositoryInspectResponse rejects extra fields in access.read"`:
    - Parse with `access: { read: { allowed: true, refusal: null, extra: 1 }, write: null }`.
    - `assert.equal(result.success, false)`.

## Constraints

- The `credential` member of `repositoryInspectResponse` is unchanged — `{ reachable: z.boolean(), refusal: z.string().nullable() }`. Do not remove or rename it.
- `accessVerdictView` is declared as a `const` inside the module (not exported) to avoid exposing a schema the handler does not need directly.
- The test file imports only from `"./repository.ts"` — no implementation, no vendor package.

## Verify

```
node --test src/http/contract/repository.test.ts
npm run verify
```

- All 11 test cases pass.
- `npm run verify` exits 0, which runs the registry/contract consistency tests including `src/http/contract/registry.test.ts`.

Proof: delivers `src/http/contract/repository.test.ts` and `src/http/contract/registry.test.ts` lines of `PASS EPIC-043`.
