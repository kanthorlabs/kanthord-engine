# Story 3 — The pi-ai models collection denies an ambient credential

Epic: `.agents/plan/epics/102-provider-transport.md`
Depends on: Story 1.

## Change

- Create `src/services/model/pi-ai-models.ts`, exporting `createPiAiModels(): MutableModels`.
- Import `builtinModels` from `@earendil-works/pi-ai/providers/all`, and `InMemoryCredentialStore` plus the type `MutableModels` from `@earendil-works/pi-ai`.
- The body returns exactly one call:

  ```ts
  return builtinModels({
    credentials: new InMemoryCredentialStore(),
    authContext: {
      env: async () => undefined,
      fileExists: async () => false,
    },
  });
  ```

- This file is the only place in `src/` that names a built-in provider catalogue.

## Constraints

- Both `authContext` members are async and both are required (`AuthContext` at `node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts:61-65`).
- Pass a fresh `InMemoryCredentialStore` per call. The store starts empty, so `resolveProviderAuth` reaches its ambient fallback and asks the provider's `apiKey.resolve` with `credential: undefined`, which reads only `ctx.env`.
- Do not read `process.env` in this file, and do not call `defaultProviderAuthContext`.
- Register no provider of your own here. The mock provider belongs to the test helper of Story 9.

## Verify

- Add `src/services/model/pi-ai-models.test.ts`, suite name `src/services/model/pi-ai-models.test`, importing `getBuiltinModel` from `@earendil-works/pi-ai/providers/all`, asserting:
  - With `process.env.ANTHROPIC_API_KEY` set to `"ambient-key"` and restored in `t.after`, `await createPiAiModels().getAuth(getBuiltinModel("anthropic", "claude-haiku-4-5"))` is `undefined`.
  - With `process.env.OPENAI_API_KEY` set to `"ambient-key"` and restored in `t.after`, `await createPiAiModels().getAuth(getBuiltinModel("openai", "gpt-4.1"))` is `undefined`.
  - `createPiAiModels().getProviders().length > 0`.
- Each `t.after` restores the previous value, including the `delete process.env.X` case when the variable was absent.
- Run `node --test --test-timeout=60000 src/services/model/pi-ai-models.test.ts`; it exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-102`, and Hermetic coverage lines 74 and 75.
