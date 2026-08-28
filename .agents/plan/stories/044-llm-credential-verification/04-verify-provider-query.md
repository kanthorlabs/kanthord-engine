# Story 4 — verify-provider query

Epic: `.agents/plan/epics/044-llm-credential-verification.md`
Depends on: Story 3

## Change

### `src/queries/provider/verify-provider.ts` (new file)

```ts
import type { Clock } from "../../services/clock/index.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import type { Storage } from "../../services/storage/index.ts";
import type {
  ProviderAuth,
  ProbeOutcome,
} from "../../services/provider-auth/index.ts";
import { ProviderAuthError } from "../../services/provider-auth/index.ts";
import { llmPayload } from "../../domain/provider-payload.ts";
```

Export types and function:

```ts
export type VerifyProviderDependencies = Readonly<{
  storage: Storage;
  crypto: Crypto;
  providerAuth: ProviderAuth;
  clock: Clock;
}>;

export type VerifyProviderInput = Readonly<{
  id: string;
  signal: AbortSignal;
}>;

export type VerifyRefusal =
  "not-found" | "provider-not-verifiable" | "service-unavailable";

export class VerifyProviderError extends Error {
  readonly refusal: VerifyRefusal;
  constructor(refusal: VerifyRefusal, message: string) {
    super(message);
    this.refusal = refusal;
  }
}

export type VerifyProviderResult = Readonly<{
  checkedAt: number;
  model: string;
  reachability: "reachable" | "unreachable";
  authentication: "accepted" | "rejected" | "unknown";
  completed: boolean;
  refusal: string | null;
  detail?: string;
}>;
```

Export the query function:

```ts
export async function verifyProvider(
  dependencies: VerifyProviderDependencies,
  input: VerifyProviderInput,
): Promise<VerifyProviderResult>;
```

The explicit column list for the SELECT (matching the pattern in `show-provider.ts:49-50`):

```ts
const columns = [
  "id",
  "kind",
  "payload_ciphertext",
  "payload_iv",
  "payload_tag",
  "key_version",
] as const;
```

The `verifyProvider` body:

1. Call `dependencies.clock.now()` once. Store as `checkedAt`.
2. Execute inside `dependencies.storage.transact((tx) => ...)`:
   - SELECT the row with `id = input.id` using the explicit column list.
   - If no row: throw `new VerifyProviderError("not-found", \`no provider ${input.id}\`)`.
3. The row shape is:
   ```ts
   type ProviderRow = {
     id: string;
     kind: string;
     payload_ciphertext: Uint8Array;
     payload_iv: Uint8Array;
     payload_tag: Uint8Array;
     key_version: number;
   };
   ```
4. If `row.kind !== "llm"`: throw
   `new VerifyProviderError("provider-not-verifiable", \`provider ${input.id} is kind ${row.kind}\`)`.
5. Decrypt: wrap `dependencies.crypto.open(...)` in `try/catch`. On any error, throw
   `new VerifyProviderError("service-unavailable", \`cannot decrypt provider ${input.id}\`)`.
The `open()`call uses the column values as`SealedPayload`:
   ```ts
   const text = dependencies.crypto.open({
     ciphertext: row.payload_ciphertext,
     iv: row.payload_iv,
     tag: row.payload_tag,
     keyVersion: row.key_version,
   });
   ```
6. Parse the decrypted text: `const payload = llmPayload.parse(JSON.parse(text))`.
   On any error, throw
   `new VerifyProviderError("service-unavailable", \`cannot parse provider ${input.id} payload\`)`.
7. Build the `ProviderAuthRow`:
   ```ts
   const authRow = {
     vendorId: payload.provider,
     apiKey: payload.apiKey,
     defaultModel: payload.defaultModel,
     baseUrl: payload.baseUrl,
   };
   ```
8. Call `await dependencies.providerAuth.probe(authRow, input.signal)`.
   Catch `ProviderAuthError`: if `err.refusal === "vendor-not-catalogued"`, throw
   `new VerifyProviderError("provider-not-verifiable", err.message)`.
9. Return:
   ```ts
   return {
     checkedAt,
     model: outcome.model,
     reachability: outcome.reachability,
     authentication: outcome.authentication,
     completed: outcome.completed,
     refusal: outcome.refusal,
     ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
   };
   ```

Note: steps 2-6 happen inside the `transact()` call. `providerAuth.probe()` is called
OUTSIDE the transaction (it is async and outbound).

### `src/queries/provider/verify-provider.test.ts` (new file)

Imports:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorage } from "../../services/storage/sqlite.ts";
import { AesGcmCrypto } from "../../services/crypto/aes-gcm.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import { registerProvider } from "../../commands/provider/register-provider.ts";
import { verifyProvider, VerifyProviderError } from "./verify-provider.ts";
import type {
  ProbeOutcome,
  ProviderAuth,
  ProviderAuthRow,
} from "../../services/provider-auth/index.ts";
import { ProviderAuthError } from "../../services/provider-auth/index.ts";
```

Test helpers:

```ts
function createMockClock(value = 1_700_000_000_000) {
  return { now: () => value };
}

function createMockIdGenerator() {
  let n = 0;
  return {
    mint: () => `01HZY8QF3M4N5P6R7S8T9V0W${String(n++).padStart(2, "0")}`,
  };
}

function createFakeProviderAuth(
  outcome: ProbeOutcome | Error,
): ProviderAuth & { calls: ProviderAuthRow[] } {
  const calls: ProviderAuthRow[] = [];
  return {
    calls,
    async probe(row, _signal) {
      calls.push(row);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

const MASTER_KEY = "0".repeat(64);
const FIXED_AT = 1_700_000_000_000;
const FIXED_SIGNAL = AbortSignal.timeout(10_000);
```

`before()` / `after()` use a temporary directory and `SqliteStorage`.

Helper `registerLlmProvider(storage, crypto, events, ids, clock, name, vendor, model)`:
calls `registerProvider({ storage, crypto, ids, clock, events, catalog: fakeModelCatalog() }, { name, kind: "llm", payload: { provider: vendor, apiKey: "sk-test-key", defaultModel: model, baseUrl: null }, actor: "test" })` and returns the registered id.

A `fakeModelCatalog()` returns an object with `has: () => true, providers: () => [], inspect: async () => []`.

Test cases:

1. **Returns the full VerifyProviderResult on success**: register an `llm` provider
   (vendor `"openai"`, model `"gpt-4o"`). Fake `providerAuth` returns
   `{ model: "gpt-4o", reachability: "reachable", authentication: "accepted", completed: true, refusal: null }`.
   Call `verifyProvider(deps, { id, signal: FIXED_SIGNAL })`.
   Assert `assert.deepEqual(result, { checkedAt: FIXED_AT, model: "gpt-4o", reachability: "reachable", authentication: "accepted", completed: true, refusal: null })`.
   Assert `"detail"` key is absent.
   Assert `fakeProviderAuth.calls.length === 1` and
   `fakeProviderAuth.calls[0].vendorId === "openai"` and
   `fakeProviderAuth.calls[0].defaultModel === "gpt-4o"`.

2. **Includes detail when present**: fake `providerAuth` returns outcome with
   `{ ..., refusal: "credential-rejected", detail: "HTTP 401" }`. Assert `result.detail === "HTTP 401"`.

3. **Unknown id → not-found**: call with an id that was never registered.
   Assert `throws VerifyProviderError` with `err.refusal === "not-found"`.
   Assert `fakeProviderAuth.calls.length === 0`.

4. **Git provider → provider-not-verifiable**: register a git provider. Assert
   `throws VerifyProviderError` with `err.refusal === "provider-not-verifiable"`.
   Assert `fakeProviderAuth.calls.length === 0`.

5. **Decrypt failure → service-unavailable**: corrupt the `payload_tag` column in the
   DB directly (`tx.run("UPDATE provider SET payload_tag = X'deadbeef' WHERE id = ?", [id])`).
   Assert `throws VerifyProviderError` with `err.refusal === "service-unavailable"`.
   Assert `fakeProviderAuth.calls.length === 0`.

6. **ProviderAuthError → provider-not-verifiable**: fake `providerAuth.probe()` throws
   `new ProviderAuthError("vendor-not-catalogued", "test")`. Assert
   `throws VerifyProviderError` with `err.refusal === "provider-not-verifiable"`.

7. **clock is called exactly once**: use a clock mock that records calls. Assert
   `clock.calls === 1` even when the probe throws.

8. **No secret in result**: for each of the six fake outcomes, serialize the full
   `VerifyProviderResult` to JSON and assert it does NOT contain `"sk-test-key"`.

9. **No DB write**: record the full DB state (all rows in `provider`, `event`) before
   calling `verifyProvider`. Assert byte-identical after the call for all six probe
   outcome variants (success and each error refusal). Use a counting storage wrapper
   that records any `tx.run()` calls with write SQL; assert zero writes.

## Constraints

- `verifyProvider` imports no vendor package. It imports only `domain/`, service
  interfaces, and error classes from `src/services/provider-auth/index.ts`.
- `providerAuth.probe()` is called outside the storage transaction.
- `clock.now()` is called exactly once per `verifyProvider` call, before the probe.
- The `signal` parameter flows into `providerAuth.probe()` unchanged.
- No assertion touches the content of `outcome.refusal`'s string value inside a
  response body — only the mapped `VerifyProviderError.refusal` is checked.

## Verify

```
node --test src/queries/provider/verify-provider.test.ts
npm run lint -- --quiet
```

Proof: delivers `src/queries/provider/verify-provider.test.ts` (PASS EPIC-044).
