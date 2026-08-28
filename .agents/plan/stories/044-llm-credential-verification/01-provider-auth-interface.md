# Story 1 — Provider-auth service interface and CredentialStore adapter

Epic: `.agents/plan/epics/044-llm-credential-verification.md`

## Change

### `src/services/provider-auth/index.ts` (new file)

Export the following in this order. No implementation, no re-export of any class:

```ts
export type VerifyRefusal =
  | "endpoint-unreachable"
  | "credential-rejected"
  | "model-unavailable"
  | "quota-exceeded"
  | "endpoint-rejected";

export type ProbeOutcome = Readonly<{
  model: string;
  reachability: "reachable" | "unreachable";
  authentication: "accepted" | "rejected" | "unknown";
  completed: boolean;
  refusal: VerifyRefusal | null;
  detail?: string;
}>;

export type ProviderAuthRow = Readonly<{
  vendorId: string;
  apiKey: string;
  defaultModel: string;
  baseUrl: string | null;
}>;

export type ProviderAuthRefusal = "vendor-not-catalogued";

export class ProviderAuthError extends Error {
  readonly refusal: ProviderAuthRefusal;
  constructor(refusal: ProviderAuthRefusal, message: string) {
    super(message);
    this.refusal = refusal;
  }
}

export interface ProviderAuth {
  probe(row: ProviderAuthRow, signal: AbortSignal): Promise<ProbeOutcome>;
}
```

### `src/services/provider-auth/pi-ai.ts` (new file)

Add only the private `createStore(row: ProviderAuthRow): CredentialStore` factory
function. This is the single-entry `CredentialStore` adapter the EPIC calls for.

Import from `@earendil-works/pi-ai`:

```ts
import type {
  CredentialStore,
  Credential,
  CredentialInfo,
  ApiKeyCredential,
} from "@earendil-works/pi-ai";
import { ProviderAuthError, type ProviderAuthRow } from "./index.ts";
```

The factory returns an object literal implementing `CredentialStore`:

```ts
function createStore(row: ProviderAuthRow): CredentialStore {
  return {
    async read(providerId) {
      if (providerId !== row.vendorId) return undefined;
      return { type: "api_key", key: row.apiKey } satisfies ApiKeyCredential;
    },

    async list() {
      return [
        { providerId: row.vendorId, type: "api_key" },
      ] satisfies readonly CredentialInfo[];
    },

    async modify(providerId, fn) {
      if (providerId !== row.vendorId) return undefined;
      const current: Credential | undefined = {
        type: "api_key",
        key: row.apiKey,
      };
      return fn(current);
      // EPIC 044: api-key only; no write-back to the encrypted row.
      // EPIC 045 extends this to persist the refreshed credential via
      // the storage + crypto services injected at construction.
    },

    async delete(providerId) {
      if (providerId !== row.vendorId) return;
      // no-op: api-key deletion is handled at the provider layer.
    },
  };
}
```

Do NOT export `createStore`. Do NOT define `PiAiProviderAuth` (Story 2 adds it).

## Constraints

- `src/services/provider-auth/index.ts` contains no implementation and no import of
  `pi-ai.ts`.
- `CredentialStore`, `Credential`, `CredentialInfo`, `ApiKeyCredential` are imported
  with `import type { ... } from "@earendil-works/pi-ai"` (root export, accessible).
- `read()` returns `undefined` for any `providerId !== row.vendorId` (per
  `CredentialStore` contract; not throwing).
- `modify()` applies `fn` and returns the callback's result (per contract). No
  persistent write in EPIC 044.
- `delete()` is a silent no-op for the bound vendor; `undefined` for any other.
- No `resolveProviderAuth` import anywhere — it is not in the public exports map.

## Verify

```
npm run lint -- --quiet
```

Story 1 has no standalone test. Story 2's test covers `createStore` indirectly
through `builtinModels({ credentials: createStore(row) })`.

Proof: prerequisite for Story 2; delivers no standalone Proof line.
