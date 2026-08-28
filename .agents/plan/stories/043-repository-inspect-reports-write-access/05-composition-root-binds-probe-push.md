# Story 5 — composition root binds the new interface method

Epic: `.agents/plan/epics/043-repository-inspect-reports-write-access.md`
Depends on: Story 1

## Change

### `src/services/git/binary.ts`

The file that assembles the `Git` implementation is `src/services/git/binary.ts`, NOT `src/services/git/cli.ts`. The epic's guess of `cli.ts` is wrong.

`createBinaryGit` (lines 23–46) returns an object literal with one entry per `Git` interface method. After Story 1 adds `probePush` to the `Git` interface, TypeScript will report a compile error until this factory includes it.

**Add import** at the top of the file (with the other single-function imports, e.g. after the `canPush` import at line 9):

```ts
import { probePush } from "./push-probe.ts";
```

**Add entry** to the returned object, after `canPush: (input) => canPush(runner, paths, input)` (line 37):

```ts
    probePush: (input) => probePush(runner, paths, input),
```

`src/main.ts` needs no change. It already constructs `git = createBinaryGit(...)` and passes `git` to `inspectRepository`. The query calls `dependencies.git.probePush` through the interface.

### `src/main.test.ts`

The test file already has a fixture for `repository.inspect`:

```ts
"repository.inspect": {
  body: { remoteUrl: deadUrl, credentialId: missing("provider") },
  expect: "any-but-501",
},
```

Update the existing fixture body in place:

```ts
"repository.inspect": {
  body: { remoteUrl: deadUrl, credentialId: missing("provider"), requiredAccess: "write" },
  expect: "any-but-501",
},
```

A missing `credentialId` row causes a 404 before the url or probe is reached, so `requiredAccess: "write"` is accepted at the schema layer and never triggers a real probe. The `any-but-501` assertion still passes. This verifies that the `requiredAccess` field is not rejected at the handler or schema layer.

## Constraints

- `main.ts` is NOT edited — the binding flows through `createBinaryGit` and the interface; no change to the composition root code is needed.
- `binary.ts` already imports `canPush` from `"./preflight.ts"` at line 9. Add `probePush` from `"./push-probe.ts"` as a separate import line in the same import group.
- The import matrix (`eslint.config.js`) permits `binary.ts` to import from within the `services/git` capability — `push-probe.ts` is in the same capability, so this is legal.

## Verify

```
node --test src/main.test.ts
npm run verify
```

- The `main.test.ts` route coverage test (`"every routed operation answers and none resolves to the shared 501 handler"`) passes with `repository.inspect` in the fixtures.
- `npm run lint` exits 0 — no TypeScript compile error for the missing `probePush` on the `Git` implementation.
- `npm run verify` exits 0.

Proof: delivers `src/main.test.ts` line of `PASS EPIC-043`.
