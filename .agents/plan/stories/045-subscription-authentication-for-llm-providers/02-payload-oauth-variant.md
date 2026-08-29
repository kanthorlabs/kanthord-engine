# Story 2 — The payload admits an oauth variant

Epic: `.agents/plan/epics/045-subscription-authentication-for-llm-providers.md`

## Change

### `src/domain/provider-payload.ts`

`domain/` may import only `zod`. Do not import any `pi-ai` type. The credential schema
below mirrors `OAuthCredential` of `@earendil-works/pi-ai@0.84.1`
(`dist/auth/types.d.ts:20-30`) by hand.

1. Replace the `llmPayload` block at `src/domain/provider-payload.ts:11-19` with the
   credential schema, the two arms and their union. Keep the api-key arm's four fields,
   their order and their validators exactly as they are today:

   ```ts
   export const oauthCredential = z
     .object({
       type: z.literal("oauth"),
       access: z.string().min(1),
       refresh: z.string(),
       expires: z.number().int(),
     })
     .catchall(z.unknown());
   export type OauthCredential = z.infer<typeof oauthCredential>;

   export const llmApiKeyPayload = z
     .object({
       transport: z.literal("api-key").optional(),
       provider: z.string().min(1),
       apiKey: z.string().min(1),
       defaultModel: z.string().min(1),
       baseUrl: z.string().min(1).nullable(),
     })
     .strict();
   export type LlmApiKeyPayload = z.infer<typeof llmApiKeyPayload>;

   export const llmOauthPayload = z
     .object({
       transport: z.literal("oauth"),
       provider: z.string().min(1),
       credential: oauthCredential,
       defaultModel: z.string().min(1),
     })
     .strict();
   export type LlmOauthPayload = z.infer<typeof llmOauthPayload>;

   export const llmPayload = z.union([llmApiKeyPayload, llmOauthPayload]);
   export type LlmPayload = z.infer<typeof llmPayload>;
   ```

   `.catchall(z.unknown())` is required, not stylistic: `OAuthCredential` carries an open
   index signature, and the `github-copilot` flow stores `availableModelIds` and
   `enterpriseUrl` on the credential
   (`dist/auth/oauth/github-copilot.js:301-304`, read back by
   `dist/providers/github-copilot.js:18-27`). A strict schema would silently drop them and
   break Copilot model filtering and enterprise refresh.

   `refresh` takes no `min(1)`: a flow that exchanges the code for a long-lived key may
   store an empty refresh token. `access` keeps `min(1)`.

2. Replace `llmProjection` at `src/domain/provider-payload.ts:45-49` with two arms, and
   widen the union at `:57`:

   ```ts
   export const llmApiKeyProjection = z.strictObject({
     transport: z.literal("api-key"),
     provider: z.string(),
     defaultModel: z.string(),
     baseUrl: z.string().nullable(),
   });

   export const llmOauthProjection = z.strictObject({
     transport: z.literal("oauth"),
     provider: z.string(),
     defaultModel: z.string(),
   });

   export const providerProjection = z.union([
     llmApiKeyProjection,
     llmOauthProjection,
     gitProjection,
   ]);
   ```

   Delete the `llmProjection` export and update every importer named in "Constraints".

3. `llmBaseUrlRefusal` (`:62-70`) is unchanged, and it applies to the api-key arm only.
   Its callers gate on the arm (Story 8).

4. `serializePayload` (`:149-175`), the `kind === "llm"` branch at `:153-161`: dispatch on
   the arm and **never emit a `transport` key on the api-key arm**.

   ```ts
   if (kind === "llm") {
     const value = payload as LlmPayload;
     if (value.transport === "oauth") {
       return JSON.stringify({
         transport: "oauth",
         provider: value.provider,
         credential: value.credential,
         defaultModel: value.defaultModel,
       });
     }
     return JSON.stringify({
       provider: value.provider,
       apiKey: value.apiKey,
       defaultModel: value.defaultModel,
       baseUrl: value.baseUrl,
     });
   }
   ```

   Dropping `transport` on the api-key arm is what makes an explicit
   `transport: "api-key"` and an absent one serialize to the same bytes, and keeps every
   stored api-key payload byte-identical to the ones written before this epic.

   The `credential` object is serialized whole, so its extra keys survive the round trip.
   `JSON.stringify` emits an object's own keys in insertion order, and `zod`'s
   `.catchall` preserves that order from the parsed input, so a round trip is
   byte-stable for a given credential.

5. `projectPayload` (`:194-215`), the `kind === "llm"` branch at `:198-204`:

   ```ts
   if (kind === "llm") {
     const value = payload as LlmPayload;
     if (value.transport === "oauth") {
       return {
         transport: "oauth",
         provider: value.provider,
         defaultModel: value.defaultModel,
       };
     }
     return {
       transport: "api-key",
       provider: value.provider,
       defaultModel: value.defaultModel,
       baseUrl: value.baseUrl,
     };
   }
   ```

   No token, no `credential` and no `apiKey` reaches either projection.

6. `payloadSchemaFor` (`:96-102`) and `parsePayload` (`:104-147`) need no structural edit:
   `payloadSchemas.llm` now holds the union. Keep the `parsePayload(kind: "llm", …)`
   overload returning `LlmPayload`.

### `src/domain/provider-payload.test.ts`

Keep every existing test passing unchanged, and add the following. The existing
byte-exactness tests at `:337-416` are the backward-compatibility guard — in particular
`:338` asserts `LLM_SERIALIZED` (`src/domain/provider-payload.test.ts:28-29`), which must
still hold with no edit to the constant.

Add a `describe("the llm oauth variant")` block after the existing llm block (which ends
at `src/domain/provider-payload.test.ts:202`) with these tests:

1. `it("parses an oauth payload")` — parses
   `{ transport: "oauth", provider: "openai-codex", credential: { type: "oauth", access: "at-1", refresh: "rt-1", expires: 1_700_000_000_000 }, defaultModel: "gpt-5-codex" }`
   and asserts every field by value.
2. `it("keeps an unknown credential key through parse and serialization")` — the same
   input with `availableModelIds: ["gpt-5-codex", "gpt-5"]` added inside `credential`;
   assert the parsed credential carries it, and assert
   `serializePayload("llm", parsed)` equals exactly
   `'{"transport":"oauth","provider":"openai-codex","credential":{"type":"oauth","access":"at-1","refresh":"rt-1","expires":1700000000000,"availableModelIds":["gpt-5-codex","gpt-5"]},"defaultModel":"gpt-5-codex"}'`.
3. `it("refuses an oauth payload carrying an apiKey")` — asserts `PayloadError` with
   refusal `"payload-invalid"`.
4. `it("refuses an oauth payload with no credential")` — same refusal.
5. `it("refuses a transport outside the two llm arms")` — `transport: "device"`.
6. `it("round trips the oauth payload byte-identically")` — mirrors the existing
   round-trip test at `:379`.
7. `it("an explicit api-key transport serializes to the same bytes as an absent one")` —
   asserts `serializePayload("llm", parsePayload("llm", { ...llmInput, transport: "api-key" }))`
   equals `LLM_SERIALIZED`, the same constant the existing test uses.
8. `it("an explicit api-key transport parses to the same payload as an absent one")` —
   `assert.deepEqual` of the two `parsePayload` results after serialization round trip.

Add to the projection block (`:417-496`):

9. `it("projects the oauth payload with no credential")` — asserts the projection
   deep-equals `{ transport: "oauth", provider: "openai-codex", defaultModel: "gpt-5-codex" }`.
10. `it("projects the api-key payload with an explicit transport")` — asserts the
    projection deep-equals
    `{ transport: "api-key", provider: "anthropic", defaultModel: "claude-opus-5", baseUrl: null }`.
    Update the existing test at `:418` to this expectation — it is the one existing
    assertion this story changes.
11. Extend the "no credential field survives in any projection" test at `:449` so its
    fixture list includes the oauth payload, and assert the serialized projection contains
    neither `"at-1"` nor `"rt-1"` nor `"access"` nor `"refresh"`.
12. Extend `it("every projection satisfies the public response schema")` at `:481` with
    both new projections against `providerProjection`.

## Constraints

- The api-key serialization emits exactly the four existing keys, in the existing order,
  with no `transport`. `LLM_SERIALIZED` at
  `src/domain/provider-payload.test.ts:28-29` is not edited.
- `oauthCredential` uses `.catchall(z.unknown())`. Never `strictObject`.
- `domain/` imports `zod` only. No `@earendil-works/pi-ai` import in this file.
- Deleting `llmProjection` changes three importers. Update them in this story to the new
  names, with no behaviour change:
  - `src/http/contract/credential.ts` — imports `providerProjection` only, so it needs no
    edit; confirm by grep.
  - any test importing `llmProjection` (`src/domain/provider-payload.test.ts:11-25`).
    Run `grep -rn "llmProjection" src test` and fix every hit.
- Do not touch the git payload, the private-key rules or `privateKeyCipher`.
- **This story must leave the tree type-checking on its own.** Turning `LlmPayload` into a
  union breaks every site that reads `apiKey` or `baseUrl` off it without narrowing. Two
  production sites do exactly that today and must be narrowed **in this story**, not in
  Stories 6 and 8:
  - `src/commands/provider/register-provider.ts:49-72` (`assertKnownLlmProvider` reads
    `payload.apiKey` and `payload.baseUrl`) — guard it with
    `if (payload.transport === "oauth") return;` at the top, so the api-key rules apply to
    the api-key arm only. Story 8 then builds on a compiling file.
  - `src/queries/provider/verify-provider.ts` — the `llmPayload` import at `:1` and every
    `apiKey` read. Narrow to the api-key arm and, for the oauth arm, throw the existing
    `VerifyProviderError("provider-not-verifiable", …)` as a **temporary** terminal state.
    Story 6 replaces that throw with the real oauth path. Mark the line with no comment;
    the story sequence is the record.

  Run `npm run typecheck` before `npm test` for this story specifically — the union change
  surfaces there first.

## Verify

```
node --test src/domain/provider-payload.test.ts
npm run verify
```

`provider-payload.test.ts` asserts: the oauth arm parses and refuses as listed, an unknown
credential key survives parse and serialization by exact bytes, an explicit
`transport: "api-key"` serializes to the byte-identical `LLM_SERIALIZED`, both projections
carry `transport` and no credential field, and every existing byte-exactness and
round-trip test still passes unedited.

Proof: delivers `src/domain/provider-payload.test.ts` (PASS EPIC-045).
`npm run verify` exits 0.

## Planning note for the reviewer

The EPIC states both "the projection is `{ transport, provider, defaultModel, baseUrl }`
for api-key" and "an api-key registration … produces a `ProviderView` deep-equal to the one
it produces before this epic". Adding `transport` to the projection makes those two
statements contradict each other. This story implements the first, and Story 8 narrows the
deep-equal assertion to the stored row bytes and to every `ProviderView` field other than
`projection.transport`. See blocker **B3** in the index.
