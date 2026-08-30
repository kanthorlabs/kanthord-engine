# Story 10 — The contract declares the three operations and the widened arm

Epic: `.agents/plan/epics/045-subscription-authentication-for-llm-providers.md`
Depends on: Story 1 (the segments), Story 2 (the payload union), **Story 8**
(`llmOauthRegisterPayload`, which this story imports), Story 9 (the catalogue member).

Every pinned count in `registry.test.ts` and `parity.test.ts` moves in this story. They are
listed with their line numbers below; a missed one fails `npm run verify`.

## Change

### `src/http/contract/credential.ts`

**Schemas.** Add after `providerVerifyResponse` (`src/http/contract/credential.ts:187-203`):

```ts
export const providerLoginStartRequest = z.strictObject({
  provider: z.string().min(1),
  answers: z.record(z.string(), z.string()).optional(),
});

export const providerLoginManualChallenge = z.strictObject({
  loginId: z.string(),
  method: z.literal("manual-code"),
  authUrl: z.string(),
  instructions: z.string(),
  expiresAt: z.number(),
});

export const providerLoginDeviceChallenge = z.strictObject({
  loginId: z.string(),
  method: z.literal("device-code"),
  userCode: z.string(),
  verificationUri: z.string(),
  expiresAt: z.number(),
  pollIntervalMs: z.number(),
});

export const providerLoginStartResponse = z.discriminatedUnion("method", [
  providerLoginManualChallenge,
  providerLoginDeviceChallenge,
]);

export const providerLoginCompleteRequest = z.strictObject({
  loginId: z.string(),
  code: z.string().min(1).optional(),
});

export const providerLoginCompleteResponse = z.strictObject({
  loginId: z.string(),
  models: z.array(z.string()),
});

export const providerLoginCancelRequest = z.strictObject({
  loginId: z.string(),
});
```

The challenge is discriminated on `method`, so a client branches on one field and neither
arm can carry the other's keys.

**Every `loginId` in a request schema is `identity("providerLogin")`, not `z.string()`.**
`http/contract/` may import `domain/`, and `src/domain/identity.ts` gains the kind in
Story 3, so `providerLoginCompleteRequest.loginId` and `providerLoginCancelRequest.loginId`
both use it. A `provider_`-prefixed id is then rejected at the edge with a schema error
rather than reaching storage and answering `not-found`. The two **response** `loginId`
fields stay `z.string()`, because a response is not validated against a caller's input.

**The widened register arm.** Replace `providerRegisterRequest` (`:41-52`). The union stays
discriminated on `kind`; the llm arm's `payload` becomes the request-level union:

```ts
export const llmRegisterPayload = z.union([
  llmApiKeyPayload,
  llmOauthRegisterPayload,
]);

export const providerRegisterRequest = z.discriminatedUnion("kind", [
  z.strictObject({
    name: z.string().min(1),
    kind: z.literal("llm"),
    payload: llmRegisterPayload,
  }),
  z.strictObject({
    name: z.string().min(1),
    kind: z.literal("git"),
    payload: gitPayload,
  }),
]);
```

`llmApiKeyPayload` and `llmOauthRegisterPayload` come from
`../../domain/provider-payload.ts`. `loginId` therefore travels inside `payload`, beside
`transport` and `defaultModel`, and `name` stays where it has always been. The EPIC writes
the arm as `{ transport: "oauth", loginId, name, defaultModel }`, which reads as one flat
object; nesting under `payload` is the reading that keeps `kind` dispatch and the existing
body shape intact — see suggestion **S3** in the index.

**The catalogue member.** Extend `catalogProvider` (`:254-260`):

```ts
export const catalogOauth = z.strictObject({ label: z.string() });

export const catalogProvider = z.strictObject({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string().nullable(),
  requiresBaseUrl: z.boolean(),
  oauth: catalogOauth.nullable(),
  models: z.array(catalogModel),
});
```

**Examples.** Add three `OperationExamples` consts beside the existing ones, each with a
`request`, a `success` and an `error` envelope, following
`providerVerifyExamples` (`:205-220`). `providerLoginCancelExamples` has a `request` and an
`error`, and its `success` is `undefined` — the operation has no response body.

Extend `providerCatalogExamples` (`:293-319`) so every provider literal carries the new
`oauth` member, and extend `providerRegisterExamples` with a second request example on the
oauth arm.

**Operations.** Add three entries to `credential` (`:352-468`). Their bytewise sort
position among the provider ids is after `provider.list` and before `provider.register`,
because `list` < `loginCancel` < `loginComplete` < `loginStart` < `register`. The registry
re-sorts on assembly (`src/http/contract/registry.ts:25-39`), so declaration order in this
array only has to be readable.

```ts
{
  operationId: "provider.loginStart",
  method: "POST",
  path: [resource("provider"), sub("login")],
  introducedIn: "phase-2",
  status: "routed",
  allowedActors: ["human"],
  idempotency: "memory",
  replayable: [200],
  request: providerLoginStartRequest,
  response: providerLoginStartResponse,
  errors: { ...baselineErrors },
  examples: providerLoginStartExamples,
},
{
  operationId: "provider.loginComplete",
  method: "POST",
  path: [resource("provider"), sub("login"), action("complete")],
  introducedIn: "phase-2",
  status: "routed",
  allowedActors: ["human"],
  idempotency: "memory",
  replayable: [200],
  request: providerLoginCompleteRequest,
  response: providerLoginCompleteResponse,
  errors: { ...baselineErrors },
  examples: providerLoginCompleteExamples,
},
{
  operationId: "provider.loginCancel",
  method: "POST",
  path: [resource("provider"), sub("login"), action("cancel")],
  introducedIn: "phase-2",
  status: "routed",
  allowedActors: ["human"],
  idempotency: "memory",
  replayable: [204],
  successStatus: 204,
  request: providerLoginCancelRequest,
  errors: { ...baselineErrors },
  examples: providerLoginCancelExamples,
},
```

Three constraints force these fields, and none is a preference:

- `registryFaults` requires **every** `POST` to declare a non-`none` policy
  (`src/http/contract/registry.test.ts:620-628`), and a `memory` policy requires a
  non-empty `replayable` (`src/http/contract/registry.ts:277-286`). All three are `POST`,
  so all three carry `memory` plus a `replayable` list.
- `provider.loginComplete` declares `memory` because the registry **requires** a policy on
  every POST, not because the policy does the replay work. Be precise about what it buys:
  `src/http/server/idempotency.ts:47-50` returns early when the request carries no
  `Idempotency-Key`, so the memory store joins a concurrent duplicate **only when the
  client sends the same key**. A replay without a key is served by the `completed` row, and
  two keyless concurrent completes are made safe by the
  `UPDATE … WHERE id = ? AND state = 'pending'` guard of Story 7 — not by this policy. Do
  not write "memory joins a concurrent duplicate" anywhere in the contract or the proposal
  without that qualification.
- `successStatus: 204` on the cancel is the first non-200 success in the contract, and it
  breaks **two** existing assertions, not one:
  `docs/proposal/api/README.md:159` (Story 12 amends it) and
  `src/http/contract/openapi.test.ts:227-234`, which asserts that every authored
  `successStatus` equals `200` with the message "overrides the default success status".
  That loop must be amended in this story to exempt `provider.loginCancel`, or the whole
  204 decision reverts to `200`. See blocker **B4** in the index — do not discover this at
  build time.

`errors` carries `baselineErrors` alone on all three. Every refusal maps onto
`invalid-request` or `not-found`, and `invalidRequestDetails`
(`src/http/contract/error-details.ts:110-114`) already admits any `refusal` string. No new
error code is added.

### `src/http/contract/credential.test.ts`

Add one shape test per operation, following the `provider.verify` form at
`src/http/contract/credential.test.ts:53-65`: method, `introducedIn`, `status`,
`allowedActors`, `idempotency`, `replayable`, the exact rendered path, and identity of the
request and response schema objects. The three paths render exactly `/v1/provider/login`,
`/v1/provider/login/complete` and `/v1/provider/login/cancel`.

Add to the example round-trip table at `:134-166` all three new operations, so each
example parses against its own strict schema and its error envelope.

Add:

1. `it("the start response admits exactly one arm per method")` — parse a manual example
   and a device example; assert a manual body carrying `userCode` is rejected and a device
   body carrying `authUrl` is rejected.
2. `it("the register request keeps two kind branches and admits two llm payloads")` —
   update the `z.toJSONSchema` assertions at `:372-445`. Assert exactly this, so no test
   design is left open:
   - the top-level `oneOf` still has **two** members, one per `kind`;
   - the llm member's `properties.payload` carries a **two**-member `anyOf`/`oneOf`,
     whichever `z.toJSONSchema` emits for `z.union` on this zod version — read the emitted
     document once and pin the key it actually uses, rather than asserting both;
   - the git member's `properties.payload` still carries its two `transport` branches;
   - every object node in the document carries `additionalProperties: false`, using the
     existing recursive walk at `:372-445` unchanged.
     The one open value is the union keyword `z.toJSONSchema` emits; pin it from the emitted
     output on first run and never assert an alternation.
3. `it("accepts an llm registration with no transport")` and
   `it("accepts an llm registration with transport api-key")` — both parse.
4. `it("accepts the oauth register arm")` — parses
   `{ name, kind: "llm", payload: { transport: "oauth", loginId: "login_01…", defaultModel: "gpt-5-codex" } }`.
5. `it("refuses an oauth register arm carrying an apiKey")`.
6. `it("refuses a login id that is not a login identity")` — `loginId: "provider_01…"`.
7. `it("the catalogue provider carries a nullable oauth member")` — parse both a null and a
   `{ label }` value; reject `{ label, method }`.

### `src/http/contract/registry.test.ts`

Update every pinned count. These are the exact sites:

- `:49-51` — `registry.length` is **73**.
- `:53-55` — the distinct id count is **73**.
- `:64` — the routed/stubbed split gains three routed entries.
- `:75` — the `introducedIn` counts gain three `phase-2` entries.
- `:113-135` — the with-request list gains `"provider.loginCancel"`,
  `"provider.loginComplete"` and `"provider.loginStart"`; the count in the test name and
  the assertion becomes **twenty**.
- `:137-182` — the with-response list gains `"provider.loginComplete"` and
  `"provider.loginStart"` and **not** `provider.loginCancel`; the count becomes **forty-six**.
- `:189-193` — unchanged: none of the three declares a `query` schema.
- `:630-668` — the POST-policy list gains all three ids; the count in the test name becomes
  **thirty-three**.
- `:681-686` — the memory-policy count becomes **thirty-two**.

Keep `it("reports no faults on the authored registry")` (`:185-187`) unedited; it must pass
as written.

### `src/http/contract/parity.test.ts`

`:16` — the comparable count becomes **73**. `:25` — the proposal row count becomes **77**.
Both follow from Story 12 adding three rows to `docs/proposal/api/credential.md`; this
story and Story 12 must land together or the parity test fails in both directions.

## Constraints

- The three operations carry `baselineErrors` and nothing else. No new error code.
- All three are `POST` with a `memory` policy and a non-empty `replayable`.
- The login id never appears as a path parameter. `isLegalPath` forbids it, and Story 1's
  test proves it.
- `providerRegisterRequest` stays discriminated on `kind` with two arms.
- Do not edit `registryFaults`. Every new entry must satisfy it as authored.

## Verify

```
node --test \
  src/http/contract/credential.test.ts \
  src/http/contract/registry.test.ts \
  src/http/contract/parity.test.ts \
  src/http/contract/openapi.test.ts
npm run verify
```

Asserts: the three operation shapes field by field with their exact rendered paths, every
example parsing against its strict schema and error envelope, both challenge arms rejecting
the other's keys, the register request accepting an absent, an explicit api-key and an
oauth payload while rejecting a mixed one, the nullable catalogue member, and all nine
pinned counts at their new values with `registryFaults` still empty.

Proof: delivers `src/http/contract/credential.test.ts` and
`src/http/contract/registry.test.ts` (PASS EPIC-045). `npm run verify` exits 0.
