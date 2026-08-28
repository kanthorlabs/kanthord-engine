# EPIC 045 — Subscription authentication for LLM providers

Status: **draft**. It follows EPIC 044 by sequence order and closes Gap 2 of the dashboard handoff.

## Goal

A human signs in to an LLM provider with a subscription account instead of an API key:

- the engine drives `pi-ai`'s OAuth flow for every vendor that ships one;
- a login returns the challenge that vendor's flow emits, and a second request completes it;
- the resulting credential is encrypted at rest, refreshed by the library, and never returned.

## The handoff's unresolved questions are answered by the library, not by this epic

The handoff marks Gap 2 `NEEDS-DESIGN` with six open questions. All six are answered in
`@earendil-works/pi-ai` 0.84.1, which is a current dependency. This section records the answers,
because the epic's decisions rest on them.

1. **Vendor authorization.** `pi-ai` implements the flow as the `openai-codex` provider, whose
   `OAuthAuth` carries `name: "OpenAI (ChatGPT Plus/Pro)"` and `isSubscription: true`. Six other
   providers ship one: `anthropic`, `github-copilot`, `kimi-coding`, `openrouter`, `radius` and
   `xai`. The engine registers no OAuth client and implements no vendor endpoint.
2. **Callback ownership.** `pi-ai` owns it. Three vendors race a local callback server against a
   `manual_code` prompt, and five expose a `device_code` flow that binds no port. The engine never
   requires the human's browser to reach the daemon, and it never reads a callback itself. It does
   accept the callback's outcome: on the manual arm the race is real, so a login can resolve with no
   pasted code. The decisions below carry that case.
3. **Transaction persistence.** The library constrains the answer. `login()` holds its verifier in a
   closure and exposes no resumable state, so a suspended flow cannot be serialized. The engine
   therefore persists the login as a row with a state, and only the suspended part is process-local.
4. **Token refresh.** The library owns it. `CredentialStore.modify` is the only write path, and
   `pi-ai` runs `OAuthAuth.refresh` inside it under a per-provider lock, so concurrent requests
   cannot double-refresh a rotated token. The dashboard has no refresh interface, exactly as it asked.
5. **Credential projection.** `OAuthCredential` is `{ type: "oauth", access, refresh, expires }`.
   The projection carries none of the three.
6. **Backward-compatible registration union.** Decided below.

## The login shape

`pi-ai` exposes no single flow shape. A vendor's `login()` asks for what it needs, and the engine
answers it. Three facts fix the shape.

- **The set of vendors is derived from the library, and no engine edit adds one.**
  `builtinProviders()` carries `auth.oauth` as a synchronous `lazyOAuth` wrapper that exposes `name`,
  `isSubscription` and `loginLabel` without loading the flow module. So the admitted set is every
  builtin provider whose `auth.oauth` is present, read at startup with no dynamic import and no
  vendor list. `radius` is included: `providers/all.js` registers it with a default gateway, so it
  needs no construction input.
- **The method is pinned by one preference rule over a known set of option spellings.** The engine
  prefers the device-code branch and falls back to the browser branch. The library spells the option
  id two ways — `device_code` for `openai-codex` and `device-code` for `radius` — so the recognized
  spellings are engine-held knowledge. A flow offering neither refuses, loudly. **The vendor set
  costs no engine edit; a third option spelling does.** That is deliberate: the epic prefers a loud
  refusal and a named edit over a silent fall-through to a branch that binds a local port.
- **The login is a persisted state machine, and only the suspended flow is process-local.** A
  credential must survive from the moment the vendor issues it to the moment `provider.register`
  consumes it, and those are two requests. So the row holds the credential once it exists.

## Non-goals

- **No engine-authored OAuth.** No PKCE code, no state generation, no token exchange and no refresh
  logic is written here. `pi-ai` holds all four. The engine supplies storage and transport.
- **No engine-authored redirect handler.** The engine writes no OAuth callback logic of its own. A
  callback server, where one runs, is `pi-ai`'s.
- **No token in any response.** No operation returns `access`, `refresh` or `expires`, and no
  projection carries them.
- **No refresh operation.** The dashboard never triggers a refresh.
- **No vendor allowlist.** The engine holds no list of admitted vendors.
- **No login configuration input.** `radius` carries a default gateway, and every other admitted flow
  is constructed from its id alone. A caller that wants a different gateway registers a different
  provider id, which is out of scope.
- **No cancel operation.** A pending login is superseded by nothing and cancelled by nothing. It
  expires. A human who abandons a login waits out the lifetime.
- **No change to verification.** EPIC 044's `provider.verify` resolves through `pi-ai` and is
  credential-type agnostic by construction. It covers an OAuth registration with no edit.
- **No new error code.** Every refusal maps onto the existing closed set of
  `src/http/contract/errors.ts` and carries its name in `details.refusal`.

## Decisions

- **Registration is three operations, matching the order a human works in.** The dashboard
  authenticates, lists the models the account can use, lets the human pick a default, and only then
  registers. So:

  1. `provider.loginStart` — `POST /v1/provider/login`, takes `{ provider, answers? }`, answers a
     discriminated challenge;
  2. `provider.loginComplete` — `POST /v1/provider/login/complete`, takes `{ loginId, code? }`,
     answers `{ loginId, models }`;
  3. `provider.loginCancel` — `POST /v1/provider/login/cancel`, takes `{ loginId }`, answers `204`;
  4. `provider.register` — gains an `oauth` arm taking `{ transport: "oauth", loginId, name,
defaultModel }`, and answers the existing `ProviderView`.

  `provider.register` stays the one place a provider row is created. A pending login is not a
  registration.

- **The paths are the segment tuples the grammar admits, and the ids carry one dot.**
  `provider.loginStart` is `[resource("provider"), subresource("login")]`. `provider.loginComplete`
  is `[resource("provider"), subresource("login"), action("complete")]`, and `provider.loginCancel`
  is the same tuple with `action("cancel")`, which `actionSegments` already carries. `isLegalPath`
  (`src/http/contract/registry.ts:319-365`) forbids a `parameter` after a `subresource`, so the login
  id travels in the body and never in the path. The two ids follow `provider.setDefault`, which is
  the existing spelling for a two-word action.

- **Two closed segment sets grow by one member each.** `login` joins `subresourceSegments` and
  `complete` joins `actionSegments` (`src/http/contract/path.ts:20-61`). Both are singular, so the
  plural check passes. `docs/proposal/api/README.md` holds the grammar and records both additions.

- **`provider.loginStart` takes one optional input, and it names no vendor.** `answers` maps a prompt
  message to its value. `github-copilot` asks a `text` prompt for the enterprise domain before it
  starts its device flow, and a blank value means `github.com`. A missing entry refuses
  `login-input-required` and carries the exact prompt message in `details.detail`, so the dashboard
  asks the human and retries `start`. The key is the message, because the library exposes no stable
  prompt identity, and the same test that pins the option ids pins the message strings.

- **The adapter answers the flow, and never guesses.** The adapter drives `AuthInteraction`:

  - a `select` prompt is answered with the device-code option id when the option set carries a
    recognized spelling, and with the browser option id otherwise. An option set carrying neither
    refuses `login-method-unavailable` and lists the exact ids it saw in `details.detail`. There is no
    default branch and no fall-through.
  - a `text` or `secret` prompt is answered from `answers`.
  - `notify` is synchronous and returns `void`, so it suspends nothing. The adapter captures the
    `auth_url` or the `device_code` payload from `notify` and records which arm the login is on. The
    manual arm then suspends on the `manual_code` prompt, which is the only awaitable point the
    library offers. The device arm suspends on the `login()` promise itself, because `pi-ai` polls the
    vendor with no further prompt.

- **The challenge is a two-arm discriminated response, fixed per login at `start`.**

  - `{ loginId, method: "manual-code", authUrl, instructions, expiresAt }`
  - `{ loginId, method: "device-code", userCode, verificationUri, expiresAt, pollIntervalMs }`

- **The device arm reports the vendor's poll interval, and the dashboard's cadence never reaches the
  vendor.** `pi-ai` polls the vendor inside the daemon on the vendor's own schedule, and
  `provider.loginComplete` only reads the state of that in-process flow. So a dashboard that polls
  faster than the interval costs one local request and no outbound call, and the engine applies no
  rate limit of its own. The interval is guidance, not a gate: `pollIntervalMs` carries the
  `intervalSeconds` of the `device_code` event in milliseconds, and it falls back to five seconds when
  the vendor omits it.

- **`provider.catalog` reports the capability, and reports only what is static.** Each catalogue
  provider gains one member, `oauth`, which is `null` for a vendor with no flow and otherwise
  `{ label }`. `label` is `loginLabel ?? name`, because `loginLabel` is optional on `OAuthAuth` and
  only `openrouter`, `kimi-coding` and `xai` set it. The method and any needed prompt answer are
  **not** reported: both are discovered only while `login()` runs, and nothing on `OAuthAuth` exposes
  either. `start` reports the method, and `login-input-required` names a missing answer. Nothing else
  on `CatalogProvider` changes.

- **The login row is a three-state machine.** A migration adds `provider_login`: a ULID id, the
  vendor id, the method, the state, the holding daemon instance, an encrypted payload, `created_at`
  and `expires_at`.

  - `pending` — `start` created it. The payload is null. The live flow is process-local.
  - `completed` — `complete` succeeded. The payload holds the `OAuthCredential` and the exact model
    ids, encrypted through the same `crypto` service the provider payload uses. Nothing is
    process-local any more.
  - consumed — `provider.register` deletes the row in the transaction that creates the provider.

  `complete` transitions `pending` to `completed` and persists. It does not delete. That is what lets
  the credential survive from the vendor to the registration, which are two requests.

- **`provider.loginComplete` matches its arm, and the device arm is polled.** On the manual arm the
  adapter supplies `code` to the suspended `manual_code` prompt. On the device arm `code` is
  forbidden, and a supplied one refuses `code-not-accepted`. While the library still polls, the
  operation refuses `login-pending` and the dashboard retries. The request never blocks on the
  vendor.

- **A manual-code login can already be complete when `complete` arrives.** `pi-ai` races the
  `manual_code` prompt against its own callback server, on a fixed port for `anthropic` and an
  ephemeral one for `openrouter`. When the human's browser reaches that port, the callback wins and
  `login()` resolves with no pasted code. So an absent `code` on the manual arm is **not** an error
  when the flow already resolved: the operation transitions to `completed` and answers the models. An
  absent `code` on a flow that is still suspended refuses `code-required`.

- **`provider.loginComplete` replays a completed login, so a lost response is recoverable.** The
  `completed` row holds the credential and the exact model ids, so a second `complete` for the same
  `loginId` answers the same `{ loginId, models }` rather than refusing. It makes no vendor call and it
  changes no row. A `code` supplied to a `completed` row is ignored, because the credential already
  exists. The row is the idempotency record, so the replay needs no `Idempotency-Key` and no stored
  response, and the operation declares `idempotency: "memory"` only to join a concurrent duplicate.
  Without this a dropped `200` strands the human: the engine holds a credential, the human holds no
  model list, `provider.register` needs a `defaultModel` from that list, and a second `start` refuses
  `login-in-progress` until the login expires.

- **A consumed login is a `404`.** `provider.register` deletes the row, so a `loginId` replayed after
  a successful registration answers `not-found`, as does one that never existed. The replay above is
  bounded by the row's life.

- **A human cancels a pending login, and the cancel states what it tears down.**
  `provider.loginCancel` takes a `loginId`, aborts the live flow through its `AbortSignal`, lets
  `pi-ai` close its callback server or stop its poll, and deletes the row in the same transaction. It
  answers `204` and it is the only way to release a vendor before `expiresAt`. It is deliberately
  explicit rather than a `start` that supersedes: an abandoned flow may still hold a live callback
  that resolves later, so a silent supersede would race two flows for one vendor and could complete
  the one the human abandoned. A cancel of a `completed` row deletes it and discards the credential,
  because the human declined the registration. A `loginId` that names no row answers `not-found`.

- **An expiry is a transition, and the transition happens once.** The first request that observes an
  expired row refuses `login-expired`, aborts the live flow through its `AbortSignal`, closes
  whatever the library opened, and deletes the row in the same transaction. A replay of that
  `loginId` then answers `not-found`. A client can therefore tell an expiry from a replay by the
  first answer it receives.

- **The device expiry is timed from the event, not from the row.** A vendor's device code starts its
  own lifetime when the vendor issues it, which is after every preceding prompt. So `expires_at` is
  the clock at receipt of the `device_code` event plus the `expiresInSeconds` that event reports.
  `expiresInSeconds` is optional on `AuthEvent`, and an absent value falls back to ten minutes. The
  manual arm is `created_at` plus ten minutes.

- **Only one pending login exists per vendor.** A second `start` refuses `login-in-progress`. The
  refusal is deliberate rather than a supersede: `anthropic` binds a fixed port for the life of its
  flow, and cancelling a live flow to start another races the abort against the callback.

- **A restart loses the live flow, and the row says so.** The daemon holds an exclusive home lock
  (`src/services/home-lock/sqlite.ts`) and refuses a home on a network filesystem, so two instances
  cannot share one database and a `complete` can never reach a different live instance. The real loss
  is a restart: the row survives and the closure does not. The row stores the `instanceId` of
  `HomeIdentity`, and a `complete` on a `pending` row whose instance is not the running one refuses
  `login-lost` and deletes the row. A `completed` row has no live flow, so it is instance-independent
  and `provider.register` never refuses for this reason.

- **`transport` becomes explicit on both arms, and absence still means api-key.** The existing
  `llm` registration arm gains `transport: "api-key"` as an optional field. Absent is `"api-key"`, so
  every current call site keeps working unchanged. The new arm requires `transport: "oauth"`. The
  discriminator is therefore present-and-explicit going forward and unambiguous today, which is the
  first of the two options the handoff offered.

- **The stored payload gains an oauth variant, and the projection reports the transport.**
  `llmPayload` (`src/domain/provider-payload.ts:11-18`) becomes a union: the existing api-key variant,
  and an oauth variant holding the `pi-ai` `OAuthCredential` plus `provider` and `defaultModel`. The
  projection is `{ transport, provider, defaultModel, baseUrl }` for api-key and
  `{ transport: "oauth", provider, defaultModel }` for oauth. No token field exists on either.

- **The models list prefers what the login returned.** `complete` stores the `availableModelIds` the
  login result carries, and the catalogue model ids of the authenticated vendor otherwise.
  `github-copilot` and `kimi-coding` return the first. No outbound call is made to list them, so the
  step costs nothing and cannot fail for a reason unrelated to the login.

- **Refresh is the library's, invoked through the store.** The engine's `CredentialStore` adapter of
  EPIC 044 gains the write path: when `pi-ai` calls `modify` with a refreshed credential, the adapter
  re-encrypts and updates that one provider row inside one storage transaction, and appends
  `provider.credentialRefreshed`. A refresh that fails leaves the stored credential unchanged.

- **An irrecoverable credential is visible without a token.** The handoff asks how the dashboard
  learns a credential is expired and irrecoverable. It calls `provider.verify`, which answers
  `authentication: "rejected"` when the refresh fails. No new field and no new operation.

- **Nothing is logged.** The login request, the code, the callback state, the credential and every
  response body of the three operations stay out of every log, consistent with the existing
  `provider.register` prohibition.

## Stories

1. **The path grammar admits the two login segments.** Add `login` to `subresourceSegments` and
   `complete` to `actionSegments` in `src/http/contract/path.ts`, and amend
   `docs/proposal/api/README.md` with both. Extend the path and registry tests.
2. **The payload admits an oauth variant.** Extend `src/domain/provider-payload.ts` with the oauth
   `llm` variant, its projection and its parse and project branches, keeping the api-key variant
   byte-identical. Extend its test.
3. **A migration adds the pending-login table.** Add the numbered migration under
   `src/services/storage/` with its test, following the existing migration convention. The table
   carries the vendor, the method, the state, the holding instance, the encrypted payload and the two
   timestamps.
4. **The auth service enumerates the oauth flows and pins a method.** Extend
   `services/provider-auth` with the derived admitted set, read from `builtinProviders()` through the
   `lazyOAuth` wrapper with no dynamic import, and with the preference rule over the recognized option
   spellings. Add its test, which asserts the derived set and the exact option id strings of every
   admitted vendor against the installed library, so a rename in `pi-ai` fails the suite.
5. **The auth service drives a suspended login.** Extend `services/provider-auth` with `startLogin`
   and `completeLogin` over the `AuthInteraction` adapter: the `notify` capture, the `manual_code`
   suspension, the device poll, the `answers` map and the abort path. Add its test with an injected
   `pi-ai` double, including the case where the callback resolves the login before `complete` runs.
6. **The store adapter writes a refreshed credential.** Extend the EPIC 044 `CredentialStore`
   adapter's `modify` path to re-encrypt and persist, inside one transaction, and append its event.
   Add the event type and payload. Extend its test.
7. **Three commands drive the login.** Add `src/commands/provider/start-provider-login.ts`,
   `src/commands/provider/complete-provider-login.ts` and
   `src/commands/provider/cancel-provider-login.ts` with their tests, covering the state transitions,
   the completed replay, the two expiry rules, the shared abort-and-delete path that expiry and cancel
   both use, `login-in-progress`, `login-lost` and the per-arm code rules.
8. **`provider.register` gains the oauth arm.** Extend the command and its test to consume a
   `completed` login, re-encrypt the credential into the provider row and delete the login row in the
   same transaction.
9. **`provider.catalog` reports the oauth capability.** Extend `services/model-catalog`, the
   `CatalogProvider` type and `src/queries/provider/read-catalog.ts` with the `oauth` member and the
   `loginLabel ?? name` fallback. Extend their tests.
10. **The contract declares the three operations and the widened arm.** Extend
    `src/http/contract/credential.ts` with `provider.loginStart`, `provider.loginComplete`,
    `provider.loginCancel`, the two-arm challenge with `pollIntervalMs`, the `oauth` catalogue member,
    the `transport` field on both arms and the oauth projection, plus examples. Extend the contract and
    registry tests.
11. **The handlers route the three operations.** Add the three handlers and their tests, extend
    `src/http/server/credential/refusals.ts` with the new refusals over the existing error codes, and
    bind the commands in `src/main.ts`.
12. **The proposal records the flow.** Amend `docs/proposal/api/credential.md` and
    `docs/proposal/phase-2/providers-and-credentials.md` with the three-step flow, the derived vendor
    set, the preference rule, the two challenge arms, the three login states, the completed replay,
    the two expiry rules, the cancel and what it tears down, the poll interval and that the
    dashboard's cadence reaches no vendor, the transport discriminator, the projection, and the
    statement that `pi-ai` owns the OAuth protocol and the refresh.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/http/contract/path.test.ts \
  src/domain/provider-payload.test.ts \
  src/services/storage/migration-provider-login.test.ts \
  src/services/provider-auth/pi-ai.test.ts \
  src/commands/provider/start-provider-login.test.ts \
  src/commands/provider/complete-provider-login.test.ts \
  src/commands/provider/cancel-provider-login.test.ts \
  src/commands/provider/register-provider.test.ts \
  src/queries/provider/read-catalog.test.ts \
  src/http/contract/credential.test.ts \
  src/http/contract/registry.test.ts \
  src/http/server/credential/start-provider-login.test.ts \
  src/http/server/credential/complete-provider-login.test.ts \
  src/http/server/credential/cancel-provider-login.test.ts \
  src/main.test.ts \
  && echo "PASS EPIC-045"
```

Hermetic coverage required beyond the Proof:

- No test reaches a real vendor. Every case injects a `pi-ai` `OAuthAuth` double, and the assertions
  name the exact vendor id, the exact returned challenge and the exact code passed to the double.
- Both path tuples are asserted legal by `isLegalPath`, and a tuple with a `parameter` after the
  `login` subresource is asserted illegal. The two new segments are asserted singular.
- The admitted set is asserted against the installed library, not against a literal list. The test
  reads `auth.oauth` from `builtinProviders()`, asserts the derived set equals the providers that
  carry it, and asserts that reading it triggers no dynamic import.
- Every admitted vendor's pinned method is asserted by value, and both device-code spellings and the
  browser option id are asserted as exact strings against the installed library.
- A `select` whose options carry no recognized spelling refuses `login-method-unavailable`, and the
  double records no further prompt.
- A flow that asks a `text` prompt with no matching `answers` entry refuses `login-input-required`,
  and `details.detail` holds the exact prompt message. The message strings of every admitted vendor
  are asserted against the installed library.
- `provider.catalog` carries a non-null `oauth` member for exactly the derived set, and `null` for
  every other provider. `openai-compatible` is asserted to carry `null`. The `label` of a vendor with
  no `loginLabel` is asserted to equal its `name`, and the `label` of one with a `loginLabel` is
  asserted to equal that.
- An api-key registration with no `transport` field produces a stored row and a `ProviderView`
  deep-equal to the one it produces before this epic. The backward-compatibility case is asserted by
  deep-equal, not by "still works".
- `transport: "api-key"` and an absent `transport` produce deep-equal results.
- A completed login stores the exact `availableModelIds` of the login result when it carries them,
  and the exact catalogue model ids otherwise. Both are asserted by value, with zero outbound calls.
- A `code` on the device arm refuses `code-not-accepted`. An absent `code` on a still-suspended
  manual arm refuses `code-required`. An absent `code` on a manual arm whose double already resolved
  through the callback succeeds and answers the models.
- A `complete` on the device arm while the double still polls refuses `login-pending`, and the row
  stays `pending`. The following `complete` after the double resolves succeeds and the row is
  `completed`.
- A successful `complete` leaves exactly one row, in state `completed`, holding a payload. A
  successful `register` leaves zero rows. Each is asserted by a row count.
- A second `complete` on a `completed` row answers a result deep-equal to the first, makes zero
  outbound calls and leaves every column byte-identical. A third call answers the same again. A `code`
  supplied on that replay changes nothing.
- The device challenge carries `pollIntervalMs` equal to the event's `intervalSeconds` times one
  thousand, asserted by value, and five thousand when the event omits it.
- `provider.loginCancel` on a `pending` row aborts the double through its `AbortSignal`, answers `204`
  and leaves zero rows. On a `completed` row it leaves zero rows and no provider row is written. On an
  unknown `loginId` it answers `not-found`. A `start` for the same vendor immediately after a cancel
  succeeds, which is the case `login-in-progress` otherwise refuses.
- Replaying a `loginId` after a successful register answers `not-found`, and no second provider row
  exists.
- A second `start` for a vendor with a `pending` row refuses `login-in-progress`, and no second row
  exists.
- A `complete` on a `pending` row whose stored instance is not the running one refuses `login-lost`
  and leaves zero rows. A `register` on a `completed` row whose stored instance is not the running one
  succeeds.
- The first `complete` after the manual arm's ten minutes refuses `login-expired`, aborts the double
  through its `AbortSignal`, and leaves zero rows. The next call with the same `loginId` answers
  `not-found`. Both boundaries are asserted with a mock clock at an exact millisecond.
- The device arm's `expires_at` is asserted to equal the clock at the `device_code` event plus the
  event's `expiresInSeconds`, not `created_at` plus it. A fixture whose first prompt consumes two
  minutes proves the difference. An event with no `expiresInSeconds` falls back to ten minutes,
  asserted by value.
- A vendor with no `auth.oauth` answers `provider-not-oauth-capable` from `provider.loginStart`, with
  zero outbound calls.
- A refresh driven through the store re-encrypts the row, appends exactly one
  `provider.credentialRefreshed` event, and leaves every other column unchanged. A failing refresh
  leaves the ciphertext byte-identical and appends no event.
- No response body, projection, event payload or error `detail` of any operation in this epic
  contains `access`, `refresh`, `expires` or the PKCE verifier. The assertion searches each
  serialized response for the fixture token values.
- The stored `provider_login` payload of a `completed` row is ciphertext: the fixture token values do
  not appear in the raw column bytes.
