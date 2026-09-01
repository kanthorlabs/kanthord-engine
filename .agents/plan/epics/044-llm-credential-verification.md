# EPIC 044 — LLM credential verification

Status: **draft**. It follows EPIC 043 by sequence order and closes Gap 3 of the dashboard handoff.

## Goal

A human checks whether a registered `llm` provider answers with the model they picked, so a revoked,
rotated or over-quota credential is visible before a run fails:

- the engine resolves a stored credential through `pi-ai`, never through its own auth code;
- `provider.verify` sends one small prompt to the provider's default model and reports the outcome;
- the verdict separates reachability, authentication and model availability.

## Non-goals

- **No engine-owned vendor auth.** `pi-ai` holds `ProviderAuth` for every catalogued vendor, with
  `apiKey.resolve()` producing the correct `ModelAuth` and each `dist/api/<api>` module building the
  correct request. The engine writes no header, no auth scheme and no vendor branch. Where the engine
  lacks something the library has, that is a missing integration and it is fixed by integrating.
- **No `/models` probe as the verdict.** A `GET <baseUrl>/models` with a bearer header is
  OpenAI-shaped. It is wrong for `anthropic` and `google`, which use a different header and path, so
  it would report a good key as rejected. It also proves nothing about an OAuth credential.
- **No model selection in the engine.** The dashboard authenticates, lists models, and the human
  picks the default. Verification probes the model already stored on the registration.
- **No new outbound stack.** The request goes through `pi-ai`'s api module for the model's `api`
  kind. The engine adds no HTTP client and no vendor SDK.
- **No OAuth in this epic.** Verification is credential-type agnostic by construction, because it
  resolves through `pi-ai`. EPIC 045 adds the OAuth credential type, and verification covers it with
  no further change. This epic ships the api-key path and the store that EPIC 045 extends.
- **No background sweep, no persisted verdict, no `provider.health`.** Every verification is
  initiated by a human, and no result is written to the provider row. `ProviderView` is unchanged.
- **No change to `provider.inspect` or `provider.catalog`.** Both keep their current shape.

## Decisions

- **The engine implements `pi-ai`'s `CredentialStore`, and that is the integration.**
  `CredentialStore` (`@earendil-works/pi-ai` `dist/auth/types.d.ts`) is the app-owned store the
  library drives: `read`, `list`, `modify` and `delete`, with `modify` as the only write path so the
  library can run an OAuth refresh under a per-provider lock. A new capability
  `services/provider-auth` owns it. The engine's encrypted `provider` table is the backing store.

- **The store adapter is single-entry and per request.** `CredentialStore` is keyed by
  `Provider.id`, one credential per provider, and the engine permits several `llm` registrations of
  the same vendor. The two models do not agree. The adapter therefore wraps exactly one provider row
  for the duration of one operation: `read` answers that row's credential, `list` answers that one
  entry, and `modify` writes back to that row's id. A verification of registration A can never read
  or rotate registration B.

- **Verification is one prompt to the stored default model.** The probe is the request the product
  actually makes, so it proves what a run needs: that the credential authenticates, that the vendor
  answers, and that the chosen model exists and responds. A models-list probe proves none of that for
  OAuth and lies for two vendors. The prompt is the exact string `What time is it?`, the same on
  every call, and the request caps output at 16 tokens. The trade-off is accepted deliberately: the
  probe spends a few tokens, and the handoff's preference for a free probe cannot be met by anything
  that works for both credential types.

- **The reply text is not contract.** A model's answer is nondeterministic and often wrong, because
  the model has no clock. The verdict never asserts, parses or returns the reply content. It reports
  only that a completion arrived. The prompt is chosen to be short and harmless, not to be answered
  correctly.

- **The verdict shape is the handoff's, with `defaultModelAvailable` replaced by what the probe can
  actually determine.**

  ```ts
  {
    checkedAt: number;                                    // epoch ms, server clock
    model: string;                                        // the model id that was probed
    reachability: "reachable" | "unreachable";
    authentication: "accepted" | "rejected" | "unknown";
    completed: boolean;                                   // a completion arrived
    refusal: string | null;
    detail?: string;                                      // human string, never contract
  }
  ```

  `defaultModelAvailable` is dropped: a completion against the stored model proves availability
  directly, and an unknown model surfaces as the `model-unavailable` refusal below.

- **The outcome mapping is closed, and each row states what it proves.**

  | Outcome                         | reachability  | authentication | completed | refusal                |
  | ------------------------------- | ------------- | -------------- | --------- | ---------------------- |
  | a completion arrives            | `reachable`   | `accepted`     | `true`    | `null`                 |
  | transport failure, no response  | `unreachable` | `unknown`      | `false`   | `endpoint-unreachable` |
  | `401` or `403`                  | `reachable`   | `rejected`     | `false`   | `credential-rejected`  |
  | `404` or an unknown-model error | `reachable`   | `accepted`     | `false`   | `model-unavailable`    |
  | `429`                           | `reachable`   | `accepted`     | `false`   | `quota-exceeded`       |
  | any other non-`2xx`             | `reachable`   | `unknown`      | `false`   | `endpoint-rejected`    |

  A `429` reports `accepted`, because a vendor rate-limits a request it authenticated. A `404`
  reports `accepted` for the same reason.

- **`checkedAt` comes from the clock service, called once.** `domain/` mints no time, and the query
  takes `clock` as a dependency.

- **The credential is a snapshot taken at request start.** The probe is a network call, so it runs
  after the storage transaction that read the row has closed. Holding a database lock across vendor
  I/O is not acceptable. A credential rotated during a probe therefore yields a verdict about the
  credential as it stood when the request began, and the verdict is not re-validated on return. The
  proposal states this, because a human reading a stale `rejected` needs to know a retry is the
  answer.

- **The probe's dependency on `pi-ai` error formatting is pinned by a test.** `stream.result()`
  resolves rather than rejects on a provider error, and the HTTP status arrives as a decimal
  `STATUS:` prefix, for example `401:`, in `result.errorMessage`. That is `pi-ai` 0.84.1 internal
  formatting, not a documented contract. A test asserts the prefix format directly, so a library
  upgrade that changes it fails loudly at build time instead of silently misreporting every verdict
  as `endpoint-rejected`.

- **The probe is bounded.** The production adapter always creates a `30_000` ms timeout signal and
  composes it with the caller signal. A timeout is `endpoint-unreachable`, and a verification cannot
  hang a request thread indefinitely. The timeout-signal factory is injectable for hermetic tests.

- **Nothing secret leaves.** The response, the refusal and `detail` never carry the key, a token, a
  fragment of either, or a vendor response body. `detail` is limited to a status code and the fixed
  message of its refusal. The request and the response are not logged.

- **The operation is `memory`-idempotent, like its siblings.** `provider.register`,
  `provider.rename` and `provider.inspect` already declare it
  (`src/http/contract/credential.ts:333`), so a retried request makes no second outbound call and
  spends no second token.

- **The idempotent identity is the client's `Idempotency-Key`, and nothing else.** The middleware
  reads that header and returns early when it is absent (`src/http/server/idempotency.ts:41-50`), so a
  request with no key always makes a fresh outbound check. A verification is therefore deduplicated
  only when the client asks for it. Four consequences follow, and the proposal states all four
  because the dashboard cannot read them off the contract:

  - a transport retry sends the same key and receives the stored answer;
  - a deliberate re-verification, after a human rotates the credential, sends no key or a new one, and
    always reaches the vendor;
  - a credential rotation invalidates no stored answer, because the record is keyed by the header and
    holds no reference to the provider row;
  - the record lives for `http.idempotency.ttl` and no longer, and it is in memory, so a restart
    discards it.

  So the retry the verdict's `detail` invites is a fresh check by construction, and the engine adds no
  rotation-aware invalidation to make that true.

- **A provider the engine cannot probe is refused, not guessed.** `kind = "git"`, an unknown id, and
  an `llm` registration whose vendor `pi-ai` does not catalogue each answer without any outbound
  call. An undecryptable payload answers `503 service-unavailable`, because a verification has no
  verdict to degrade to.

## Stories

1. **A capability owns `pi-ai` credential resolution.** Add `src/services/provider-auth/index.ts`
   declaring the interface the engine needs, and one implementation over `pi-ai`. It exposes the
   single-entry `CredentialStore` adapter and auth resolution for one provider row. This is the only
   place `@earendil-works/pi-ai` auth is imported.

2. **The service probes a model with one prompt.** Extend `services/provider-auth` with the probe:
   resolve auth for the row, select the `pi-ai` api module for the model's `api` kind, send the fixed
   prompt under the token cap and the abort signal, and return a closed outcome union. Add its test
   with an injected transport.

3. **The outcome mapping is a named, tested function.** Add the mapper from the probe outcome to the
   verdict of the table above, with a test asserting every row by exact value.

4. **The query verifies a stored credential.** Add `src/queries/provider/verify-provider.ts` and its
   test. It selects the row, refuses an unknown id with `not-found`, refuses a non-`llm` or
   uncatalogued provider with `provider-not-verifiable`, opens the payload through `crypto.open`,
   calls the probe once and maps the outcome. It takes `{ storage, crypto, providerAuth, clock }`.

5. **The contract declares the operation.** Add `provider.verify` to
   `src/http/contract/credential.ts` as `POST`, path
   `[resource("provider"), parameter("provider"), action("verify")]`, `status: "routed"`,
   `introducedIn: "phase-1"`, `allowedActors: ["human"]`, `idempotency: "memory"`, with the response
   schema, its refusals and its examples. Extend the contract and registry tests.

6. **The handler routes the operation.** Add `src/http/server/credential/verify-provider.ts` and its
   test, extend `src/http/server/credential/refusals.ts`, and bind the query in `src/main.ts`.

7. **The proposal records the operation.** Amend `docs/proposal/api/credential.md` with a
   `provider.verify` section: the prompt probe and why it is a completion rather than a models list,
   the verdict shape, the outcome mapping, the token cap and timeout, the statement that no verdict is
   persisted, and the four idempotency consequences above — what identifies an invocation, how a client
   forces a fresh check, that a rotation invalidates nothing, and the retention window. Amend `docs/proposal/phase-2/providers-and-credentials.md` to record that
   `pi-ai` owns credential resolution and the engine owns only the store.

## Verification Gate

Gates: `npm run verify`

Proof:

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

Hermetic coverage required beyond the Proof:

- No test reaches a real vendor. Every case injects a transport double, and the assertion names the
  exact model id, the exact prompt string and the exact token cap the probe sent.
- Every row of the outcome table is asserted by deep-equal on the whole response body, not field by
  field. Six rows, six assertions.
- The probe sends the exact string `What time is it?` and no other content, asserted by value.
- A completion whose text is empty, whitespace, or a wrong answer all produce
  `completed: true` and an identical response body. The reply text appears nowhere in the response.
- `checkedAt` equals the exact value a mock clock returns, and the clock records exactly one call.
- The probe records exactly one outbound call per verification. A second request carrying the same
  `Idempotency-Key` records none and answers a body deep-equal to the first. A second request carrying
  **no** key records a second call, and a second request carrying a **different** key records a second
  call. The three cases are asserted separately, because they are the contract the dashboard's retry
  button depends on.
- A verification that answers `rejected`, followed by a credential rotation, followed by a keyless
  verification, answers the rotated credential's verdict and not the stored one.
- The production adapter creates a timeout signal with exactly `30_000` ms, composes it with the caller
  signal, and maps its abort to `endpoint-unreachable`. The hermetic test injects the timeout-signal
  factory, aborts its returned signal during pending transport, and asserts that the timeout signal and
  composed transport signal fired while the non-aborted caller signal stayed active.
- `kind = "git"`, an unknown vendor id and an unknown provider id each answer without any outbound
  call, asserted by a transport double that records zero calls.
- A provider whose stored payload fails to decrypt answers `503 service-unavailable`, with zero
  outbound calls and an unchanged provider row.
- The single-entry store adapter answers `list` with exactly one entry. A `read` for another provider
  id resolves `undefined`, and a `modify` for another provider id resolves `undefined` without invoking
  its callback. Two per-request adapters for registrations of the same vendor return only their
  respective registration's credential.
- No response body, refusal or `detail` contains the api key. The assertion searches the serialized
  response for the fixture key on every one of the six outcomes.
- The provider row, the event table and every other table are byte-identical before and after a
  verification of each outcome. Verification writes nothing.
- One test pins the `pi-ai` error-message contract: it asserts the exact `STATUS:` prefix shape the
  status parser depends on, and it fails if the installed library stops producing it.
