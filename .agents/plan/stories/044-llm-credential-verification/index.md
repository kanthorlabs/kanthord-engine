# EPIC 044 — LLM credential verification — stories

Epic: `.agents/plan/epics/044-llm-credential-verification.md`
Prereq: EPIC 043 (sequence order).

`provider.verify` sends a fixed one-message prompt to the stored default model
and returns a closed verdict: reachability, authentication, completion, refusal.

## Dispatch order

1. `01-provider-auth-interface.md` — interface + CredentialStore adapter (no probe logic)
2. `03-outcome-mapper.md` — verdict.ts + verdict.test.ts (must exist before Story 2 compiles)
3. `02-probe-implementation.md` — probe method on `PiAiProviderAuth` + `pi-ai.test.ts`
4. `04-verify-provider-query.md` — `verify-provider.ts` + `verify-provider.test.ts`
5. `05-contract-operation.md` — extend `credential.ts` + extend `credential.test.ts` + `registry.test.ts`
6. `06-handler-and-wiring.md` — handler + extend `refusals.ts` + bind in `main.ts` + extend `main.test.ts`
7. `07-proposal-docs.md` — amend proposal docs

Story 3 (verdict.ts) comes BEFORE Story 2 (probe) because the probe imports `toVerdict`.
Stories 5, 6 are sequential. Story 6 depends on 5 (contract must declare the operation first).

## Stories

- 1 — service interface + CredentialStore adapter → `01-provider-auth-interface.md`
- 2 — probe method + pi-ai.test.ts → `02-probe-implementation.md`
- 3 — outcome mapper + verdict.test.ts → `03-outcome-mapper.md`
- 4 — verify-provider query + test → `04-verify-provider-query.md`
- 5 — contract operation declaration → `05-contract-operation.md`
- 6 — handler, refusals, main wiring → `06-handler-and-wiring.md`
- 7 — proposal documentation → `07-proposal-docs.md`

## Facts (needed for implementation)

- `@earendil-works/pi-ai` public exports map has NO `./auth` subpath. Auth types
  (`CredentialStore`, `ProviderAuth`, `ApiKeyAuth`, `ApiKeyCredential`, `AuthContext`,
  `AuthResult`, `ModelAuth`, `ModelsError`) are ALL re-exported from the root `"."` entry
  via `export * from "./auth/types.ts"` etc. Import them as:
  `import type { CredentialStore, ... } from "@earendil-works/pi-ai"`.
  `resolveProviderAuth` (from `dist/auth/resolve.ts`) is NOT re-exported from root.
  It is not accessible through any public export path. The probe calls
  `provider.auth.apiKey.resolve()` directly instead.
- `defaultProviderAuthContext()` is exported from `@earendil-works/pi-ai` (via
  `./auth/context.ts`). It provides a default `AuthContext` that reads `process.env`.
- `InMemoryCredentialStore` is exported from `@earendil-works/pi-ai`.
- `builtinProviders()` and `getBuiltinModels()` come from
  `@earendil-works/pi-ai/providers/all`. Each `Provider` carries `id`, `name`,
  `baseUrl`, and `auth: ProviderAuth`.
- `getBuiltinModels(providerId)` requires `providerId` to be typed as `BuiltinProvider`.
  Cast is safe once `builtinProviders()` confirms the entry exists.
- `streamSimple` signature: `(model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream`.
  `SimpleStreamOptions` extends `StreamOptions` extends `ProviderRequestOptions` which
  has `apiKey?: string`, `fetch?: FetchFunction`, `signal?: AbortSignal`, `maxTokens?: number`,
  and `onResponse?: (response: { status: number; headers: Record<string, string> }, model) => void`.
- `AssistantMessageEventStream.result()` returns `Promise<AssistantMessage>`. It rejects
  with `new Error(errorMessage)` when `stopReason === "error"` or `"aborted"`. The
  `onResponse` callback fires before stream body processing, so it captures the HTTP
  status before any rejection.
- `llmPayload` at `src/domain/provider-payload.ts:11-18`: `{ provider, apiKey, defaultModel, baseUrl }`.
- Decrypt-and-use pattern: `src/queries/provider/show-provider.ts:52-82` (`crypto.open` + `deserializePayload`).
- `Clock { now(): number }` at `src/services/clock/index.ts:1-3`.
- `Crypto { open(sealed: SealedPayload): string }` at `src/services/crypto/index.ts`.
- Contract operation pattern: `src/http/contract/credential.ts:379-413` (provider.rename / provider.setDefault).
  The `action("verify")` segment already exists in `src/http/contract/path.ts:61`.
- Handler pattern: `src/http/server/credential/show-provider.ts` + `show-provider.test.ts`.
- `createTestApp` helper: `test/helpers/app.ts`.
- `main.ts` wires all provider handlers at lines 382-410. Insert `"provider.verify"` after `"provider.show"` at ~line 411.
- `main.test.ts` operation fixture map at lines 62-96; insert `"provider.verify"` after `"provider.show"` at ~line 85.
- `@earendil-works/pi-ai` is NOT in `vendorPackages` in `eslint.config.js`.
  No ESLint config change is needed to import it in `src/services/provider-auth/pi-ai.ts`.
- Probe timeout constant: `30_000` ms. Implementation uses
  `AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])`.
- The fixed probe prompt is exactly the string `"What time is it?"`. Max tokens: `16`.
- Idempotency for `provider.verify`: `"memory"`, `replayable: [200]`.
- The `openai-compatible` sentinel provider has no `builtinProviders()` entry; the probe
  throws `ProviderAuthError` → query maps to `provider-not-verifiable`.
