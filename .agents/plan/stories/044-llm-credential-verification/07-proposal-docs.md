# Story 7 — Proposal documentation

Epic: `.agents/plan/epics/044-llm-credential-verification.md`
Depends on: Story 6

## Change

### `docs/proposal/api/credential.md`

Add a `## provider.verify` section. Include:

1. **Operation**: `POST /v1/provider/:id/verify`
2. **Why a prompt probe, not a models list**: a `GET /models` with a bearer header is
   OpenAI-shaped and fails for Anthropic and Google (different header and path). It also
   proves nothing about OAuth credentials. The prompt probe uses the actual request path
   the product takes for real runs.
3. **The fixed prompt and token cap**: the probe sends exactly `"What time is it?"` with
   `max_tokens: 16`. The reply text is not used or returned.
4. **Verdict shape**: verbatim the TypeScript type from the EPIC decisions section.
5. **Outcome table**: verbatim the six-row table from the EPIC decisions section.
6. **What is not persisted**: no verdict is written to the provider row. `ProviderView`
   is unchanged. A re-verification always runs the probe again (within the idempotency
   window it replays the cached response).
7. **Timeout**: 30 seconds. A timeout maps to `endpoint-unreachable`.
8. **Secret safety**: the api key never appears in the response body, detail, or refusal.

### `docs/proposal/phase-2/providers-and-credentials.md`

Add or amend a section on credential resolution. State:

- `pi-ai` owns `ProviderAuth` for every catalogued vendor. The engine passes a
  single-entry `CredentialStore` adapter to `builtinModels({ credentials })` and calls
  `completeSimple()`. Pi-ai drives the store internally; the engine writes no auth
  header and no vendor-specific auth scheme.
- The engine implements `CredentialStore` (from `@earendil-works/pi-ai`) as a
  single-entry, per-request adapter backed by the encrypted `provider` table. One
  adapter wraps exactly one registration; a probe of registration A can never read
  registration B's credential.
- `resolveProviderAuth` from `@earendil-works/pi-ai` is not in the package's public
  exports map. Pi-ai resolves credentials internally through `builtinModels`. EPIC 045
  may revisit if the function is promoted to a public export.
- Verification covers all credential types by construction (EPIC 045 adds OAuth; no
  change to the probe or the outcome table is required).
- **Credential snapshot semantics.** The probe is a network call and runs after the
  storage transaction that read the provider row has closed. Holding a database lock
  across a vendor round-trip is not acceptable. A credential rotated or revoked while
  the probe is in flight yields a verdict about the credential as it stood at request
  start; the verdict is not re-validated on return. A human who receives a stale
  `rejected` verdict should retry: a fresh verification will pick up the current
  credential.

### `docs/proposal/phase-1/runtime-capability-matrix.md`

Add `provider.verify` in registry order with the rendered path `/v1/provider/:id/verify`. Reconcile the routed-operation counts and runtime aggregates.

## Constraints

- All files are under `docs/proposal/` — the one path an epic may edit besides `.ts`
  / `.js` source.
- No new TypeScript file is created or edited in Story 7.

## Verify

```
npm run verify
```

Proof: Story 7 completes the EPIC. Running the full Proof block from the EPIC passes:

```bash
node --test \
  src/services/provider-auth/pi-ai.test.ts \
  src/services/provider-auth/verdict.test.ts \
  src/queries/provider/verify-provider.test.ts \
  src/http/contract/credential.test.ts \
  src/http/contract/registry.test.ts \
  src/http/server/credential/verify-provider.test.ts \
  src/http/server/credential/refusals.test.ts \
  src/main.test.ts \
  && echo "PASS EPIC-044"
```
