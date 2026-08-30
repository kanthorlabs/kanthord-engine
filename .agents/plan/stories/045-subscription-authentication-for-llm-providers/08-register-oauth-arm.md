# Story 8 — `provider.register` gains the oauth arm

Epic: `.agents/plan/epics/045-subscription-authentication-for-llm-providers.md`
Depends on: Story 2 (the stored oauth payload), Story 7 (a `completed` login row exists).

The request payload of the oauth arm is **not** the stored payload. The request carries a
`loginId`; the stored payload carries the credential the login row holds. Registration is
the step that converts one into the other.

## Change

### `src/domain/provider-payload.ts`

Add the request schema beside the stored ones. It is domain data, and `identity` is
already imported by sibling domain modules.

```ts
export const llmOauthRegisterPayload = z
  .object({
    transport: z.literal("oauth"),
    loginId: identity("providerLogin"),
    defaultModel: z.string().min(1),
  })
  .strict();
export type LlmOauthRegisterPayload = z.infer<typeof llmOauthRegisterPayload>;
```

Import `identity` from `./identity.ts`. Do not add this schema to `payloadSchemas` — it is
never stored, so `parsePayload` must not accept it.

### `src/commands/provider/register-provider.ts`

`registerProvider` (`src/commands/provider/register-provider.ts:74-145`) is synchronous and
stays synchronous. The oauth arm reads and deletes the login row inside the **same**
transaction that inserts the provider, which is what makes a consumed login atomic with
the registration it produced.

1. Widen the refusal union at `:33-37`:

   ```ts
   export type RegisterProviderRefusal =
     | "name-taken"
     | "provider-unknown"
     | "base-url-required"
     | "base-url-not-allowed"
     | "login-not-found"
     | "login-not-completed"
     | "default-model-unknown";
   ```

   `default-model-unknown` is not named in the EPIC — see suggestion **S2** in the index.
   It is required: `defaultModel` arrives from the caller and must be one of the ids the
   login answered, or the registration stores a model the account cannot use.

2. Replace the head of the function (`:78-82`) with an arm split. Detect the oauth arm
   before `parsePayload`, because the request payload does not satisfy the stored schema:

   ```ts
   const oauthRequest =
     input.kind === "llm"
       ? llmOauthRegisterPayload.safeParse(input.payload)
       : undefined;
   ```

   When `oauthRequest?.success === true`, take the oauth path below. Otherwise the existing
   path runs completely unchanged: `parsePayload`, `assertKnownLlmProvider`,
   `serializePayload`, `crypto.seal`, `ids.mint`, `clock.now`, the existing transaction.

3. The oauth path, in order:

   a. `const id = dependencies.ids.mint("provider")` and
   `const updatedAt = dependencies.clock.now()`, exactly as the api-key path does.

   b. Inside one `dependencies.storage.transact`:

   1. The existing name-uniqueness check (`:88-96`), unchanged.
   2. `SELECT provider, state, payload_ciphertext, payload_iv, payload_tag, key_version FROM provider_login WHERE id = ?`.
      `undefined` → `RegisterProviderError("login-not-found", …)`.
      `state !== 'completed'` → `RegisterProviderError("login-not-completed", …)`.
      There is deliberately **no** instance check: a `completed` row holds no live flow,
      so it is instance-independent.
   3. `dependencies.crypto.open(...)` and `JSON.parse` the plaintext into
      `{ credential, models }`.
   4. If `models` does not include `oauthRequest.data.defaultModel` →
      `RegisterProviderError("default-model-unknown", …)`.
   5. `if (!dependencies.catalog.has(loginRow.provider))` →
      `RegisterProviderError("provider-unknown", …)`. The catalogue gate stays exactly
      where it is today; `openai-compatible` remains the only self-configuration escape
      hatch and it carries no oauth flow, so it can never reach here.
   6. Build and seal the stored payload:

      ```ts
      const stored = parsePayload("llm", {
        transport: "oauth",
        provider: loginRow.provider,
        credential,
        defaultModel: oauthRequest.data.defaultModel,
      });
      const sealed = dependencies.crypto.seal(serializePayload("llm", stored));
      ```

      Sealing inside the transaction is required here, because the plaintext only exists
      after step 3.

   7. The existing first-llm default stamp (`:97-103`), unchanged.
   8. The existing `INSERT INTO provider (...)` (`:104-117`), unchanged but for the
      sealed payload built above.
   9. `DELETE FROM provider_login WHERE id = ?`. The login is consumed.
   10. The existing `provider.registered` append (`:118-125`) and the conditional
       `provider.defaultSet` append (`:126-135`), unchanged. No new event type.

   c. Return the `ProviderView` (`:137-144`) with
   `projection: projectPayload("llm", stored)`, which is
   `{ transport: "oauth", provider, defaultModel }`.

   A throw at any step rolls back the insert, the delete and both appends together.

### `src/commands/provider/register-provider.test.ts`

Keep every existing test. Add:

1. `it("registers from a completed login and consumes the row")` — seed a `completed`
   `provider_login` row; register; assert exactly one `provider` row, **zero**
   `provider_login` rows, and a `ProviderView` whose `projection` deep-equals
   `{ transport: "oauth", provider: "openai-codex", defaultModel: "gpt-5-codex" }`.
2. `it("stores the credential encrypted and nowhere in plaintext")` — assert the fixture
   token values do not appear in the raw `payload_ciphertext` bytes, mirroring the existing
   test at `:194`.
3. `it("refuses login-not-found for an unknown loginId and writes nothing")` — assert zero
   provider rows.
4. `it("refuses login-not-completed for a pending login and leaves the login row")` —
   assert the `provider_login` row is still present and `pending`.
5. `it("refuses default-model-unknown when the model is not in the stored list")` — assert
   zero provider rows and the login row untouched.
6. `it("rolls the delete back when the insert fails")` — force a `name-taken` refusal with
   a valid login; assert the `provider_login` row still exists and `state = 'completed'`.
7. `it("registers on a completed login whose stored instance is not the running one")` —
   assert success.
8. `it("replaying a consumed loginId refuses login-not-found and writes no second row")` —
   register twice with the same `loginId` and a second name; assert the second call refuses
   and exactly one provider row exists.
9. `it("stamps the first llm registration by the oauth arm as the default")` — assert
   `set_default_at` equals `updatedAt` and both `provider.registered` and
   `provider.defaultSet` were appended, in id order.
10. `it("appends no new event type")` — assert the event types written are exactly
    `["provider.registered", "provider.defaultSet"]`.

**Backward compatibility.** Extend the existing api-key tests rather than adding new ones
where possible:

11. `it("an absent transport and an explicit api-key transport produce deep-equal results")` —
    register twice under two names, and assert the two `ProviderView` values are deep-equal
    after substituting the differing `id`, `name` and `updatedAt`, and that the two stored
    `payload_ciphertext` values decrypt to byte-identical plaintext.
12. Update the existing assertion at
    `src/commands/provider/register-provider.test.ts:219` and its siblings so the expected
    `projection` carries `transport: "api-key"`. This is the one behavioural change to the
    api-key path, and it is the EPIC's own decision — see blocker **B3** in the index. The
    stored row stays byte-identical; assert that explicitly by comparing the decrypted
    plaintext against the existing `LLM_SERIALIZED`-shaped literal.

## Constraints

- `registerProvider` stays synchronous.
- The insert, the login delete and both event appends sit in one transaction.
- The oauth arm never calls `llmBaseUrlRefusal`; the stored oauth payload has no `baseUrl`.
- The catalogue gate stays at its current site and is applied to the vendor id the **login
  row** holds, never to a caller-supplied one.
- `provider.register` remains the only place a provider row is created.
- `llmOauthRegisterPayload` is never added to `payloadSchemas`.

## Verify

```
node --test src/commands/provider/register-provider.test.ts
npm run verify
```

Asserts: one provider row and zero login rows after an oauth registration, the exact oauth
projection, the four new refusals with their write-nothing guarantees, the rollback keeping
the login row consumable, the consumed-login replay, the default stamp and the exact event
list, and the api-key path producing byte-identical stored plaintext with and without an
explicit `transport`.

Proof: delivers `src/commands/provider/register-provider.test.ts` (PASS EPIC-045).
`npm run verify` exits 0.
