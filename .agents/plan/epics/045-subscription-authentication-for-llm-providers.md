# EPIC 045 — Subscription authentication for LLM providers

Status: **blocked**. It follows EPIC 044 by sequence order and closes Gap 2 of the dashboard handoff.
One decision is open — see "The open question" below. Do not author stories from this file until it
is settled.

## Goal

A human signs in to an LLM provider with a subscription account instead of an API key:

- the engine drives `pi-ai`'s OAuth flow for every vendor that ships one;
- a login returns an authorization URL, and a pasted code completes it;
- the resulting credential is encrypted at rest, refreshed by the library, and never returned.

## The handoff's unresolved questions are answered by the library, not by this epic

The handoff marks Gap 2 `NEEDS-DESIGN` with six open questions. Five are already answered in
`@earendil-works/pi-ai` 0.84.1, which is a current dependency. This section records the answers,
because the epic's decisions rest on them.

1. **Vendor authorization.** `pi-ai` implements the flow as the `openai-codex` provider, whose
   `OAuthAuth` carries `name: "OpenAI (ChatGPT Plus/Pro)"` and `isSubscription: true`. Six other
   providers ship one: `anthropic`, `github-copilot`, `kimi-coding`, `openrouter`, `radius` and
   `xai`. The engine registers no OAuth client and implements no vendor endpoint.
2. **Callback ownership.** `pi-ai` owns it, and it owns it in a shape built for a CLI.
   `dist/auth/oauth/openai-codex.d.ts` states the module "uses Node.js crypto and http for the OAuth
   callback" and "is only intended for CLI use". So `login()` binds a local HTTP callback server on
   the host that runs it. `pi-ai` also races that server against a `manual_code` prompt — its
   `AuthPrompt` documentation describes "a `manual_code` prompt raced against a callback server,
   aborted when the callback wins" — so a headless completion is possible in principle. Which of the
   two the engine uses is the open question below.
3. **Transaction persistence.** The library does not answer this, and it constrains the answer: the
   interaction is in-process and holds its verifier in a closure, while the dashboard's flow spans two
   HTTP requests. The engine therefore cannot serialize a login. See the open question.
4. **Token refresh.** The library owns it. `CredentialStore.modify` is the only write path, and
   `pi-ai` runs `OAuthAuth.refresh` inside it under a per-provider lock, so concurrent requests
   cannot double-refresh a rotated token. The dashboard has no refresh interface, exactly as it asked.
5. **Credential projection.** `OAuthCredential` is `{ type: "oauth", access, refresh, expires }`.
   The projection carries none of the three.
6. **Backward-compatible registration union.** Decided below.

## The open question

`pi-ai`'s OAuth login is CLI-shaped: it binds a local callback server on the daemon host and keeps
its PKCE verifier in a closure. A dashboard on a different machine cannot be redirected to the
daemon's loopback, and a login cannot be resumed by a second daemon instance. Two shapes follow, and
the choice changes the operations, the table and the deployment story. It is Ulrich's, and this epic
does not pick it.

- **Same-host login.** The daemon runs `login()`, binds the callback port, and
  `provider.login.start` returns the vendor URL. It works when the human's browser reaches the daemon
  host, which is the single-machine case. A login is instance-affine, and the pending row carries the
  holding instance.
- **Manual-code login.** The engine's `AuthInteraction` never resolves the callback and answers the
  `manual_code` prompt instead, so the human pastes the code into the dashboard. It works across
  machines. It depends on every admitted vendor's flow actually offering the manual-code race, which
  is documented for the prompt type but not confirmed per vendor.

## Non-goals

- **No engine-authored OAuth.** No PKCE code, no state generation, no token exchange and no refresh
  logic is written here. `pi-ai` holds all four. The engine supplies storage and transport.
- **No engine-authored redirect handler.** Whichever shape wins, the engine writes no OAuth callback
  logic of its own. A callback server, if one runs, is `pi-ai`'s.
- **No token in any response.** No operation returns `access`, `refresh` or `expires`, and no
  projection carries them.
- **No refresh operation.** The dashboard never triggers a refresh.
- **No new vendor.** The epic admits exactly the providers whose `pi-ai` entry has an `oauth` member.
  A vendor without one keeps the api-key arm only.
- **No change to verification.** EPIC 044's `provider.verify` resolves through `pi-ai` and is
  credential-type agnostic by construction. It covers an OAuth registration with no edit.
- **No device-code flow.** `pi-ai` ships one at `dist/auth/oauth/device-code.js`, and a later epic
  may add it. This epic ships one shape only, and which one is the open question.

## Decisions

- **Registration is three operations, matching the order a human works in.** The dashboard
  authenticates, lists the models the account can use, lets the human pick a default, and only then
  registers. So:

  1. `provider.login.start` — takes a vendor id, answers `{ loginId, authUrl, instructions }`;
  2. `provider.login.complete` — takes `{ loginId, code }`, answers `{ loginId, models }`;
  3. `provider.register` — gains an `oauth` arm taking `{ transport: "oauth", loginId, name,
defaultModel }`, and answers the existing `ProviderView`.

  `provider.register` stays the one place a provider row is created. A pending login is not a
  registration.

- **A pending login is a row with an expiry, and the row does not hold the PKCE verifier.**
  `pi-ai`'s `login()` keeps its verifier inside its own closure and exposes no resumable state, so the
  engine cannot serialize the flow. Extracting it would mean re-implementing the OAuth flow with
  `generatePKCE()`, which this epic refuses. A migration adds `provider_login`: a ULID id, the vendor
  id, the daemon instance that holds the live flow, `created_at` and `expires_at`. The live flow stays
  in the process that started it, and the row is what routes, expires and audits it. That makes a
  login instance-affine, which the open question below is about.

- **A pending login is single-use and short-lived.** `provider.login.complete` deletes the row in the
  same transaction that succeeds. `provider.register` deletes it when it consumes the credential. An
  expired row is refused with `login-expired` and deleted. The lifetime is ten minutes.

- **The engine adapts `AuthInteraction` to two requests, and the adapter holds a live promise.** `pi-ai`'s `login()` expects a live
  interaction. The adapter answers a `notify({ type: "auth_url" })` by capturing the URL and
  suspending, and answers the `prompt({ type: "manual_code" })` with the code the second request
  supplies. The suspension point is the boundary between the two operations. The suspended promise
  lives in the process, not in the row.

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

- **The models list comes from the catalogue, not the network.** `provider.login.complete` answers
  the catalogue models of the authenticated vendor. `openai-codex` carries seven. No outbound call is
  made to list them, so the step costs nothing and cannot fail for a reason unrelated to the login.

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

1. **The payload admits an oauth variant.** Extend `src/domain/provider-payload.ts` with the oauth
   `llm` variant, its projection and its parse and project branches, keeping the api-key variant
   byte-identical. Extend its test.
2. **A migration adds the pending-login table.** Add the numbered migration under
   `src/services/storage/` with its test, following the existing migration convention.
3. **The auth service drives a suspended login.** Extend `services/provider-auth` with `startLogin`
   and `completeLogin` over `pi-ai`'s `OAuthAuth` and the two-request `AuthInteraction` adapter. Add
   its test with an injected `pi-ai` double.
4. **The store adapter writes a refreshed credential.** Extend the EPIC 044 `CredentialStore`
   adapter's `modify` path to re-encrypt and persist, inside one transaction, and append its event.
   Add the event type and payload. Extend its test.
5. **Two commands drive the login.** Add `src/commands/provider/start-provider-login.ts` and
   `src/commands/provider/complete-provider-login.ts` with their tests, including expiry and
   single-use refusals.
6. **`provider.register` gains the oauth arm.** Extend the command and its test to consume a
   completed login, encrypt the credential and delete the pending row in the same transaction.
7. **The contract declares the two operations and the widened arm.** Extend
   `src/http/contract/credential.ts` with `provider.login.start`, `provider.login.complete`, the
   `transport` field on both arms and the oauth projection, plus examples. Extend the contract and
   registry tests.
8. **The handlers route the two operations.** Add the two handlers and their tests, extend
   `src/http/server/credential/refusals.ts`, and bind the commands in `src/main.ts`.
9. **The proposal records the flow.** Amend `docs/proposal/api/credential.md` and
   `docs/proposal/phase-2/providers-and-credentials.md` with the three-step flow, the pending-login
   lifetime, the transport discriminator, the projection, and the statement that `pi-ai` owns the
   OAuth protocol and the refresh.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/domain/provider-payload.test.ts \
  src/services/storage/migration-provider-login.test.ts \
  src/services/provider-auth/pi-ai.test.ts \
  src/commands/provider/start-provider-login.test.ts \
  src/commands/provider/complete-provider-login.test.ts \
  src/commands/provider/register-provider.test.ts \
  src/http/contract/credential.test.ts \
  src/http/contract/registry.test.ts \
  src/http/server/credential/start-provider-login.test.ts \
  src/http/server/credential/complete-provider-login.test.ts \
  src/main.test.ts \
  && echo "PASS EPIC-045"
```

Hermetic coverage required beyond the Proof:

- No test reaches a real vendor. Every case injects a `pi-ai` `OAuthAuth` double, and the assertions
  name the exact vendor id, the exact returned `authUrl` and the exact code passed to the double.
- An api-key registration with no `transport` field produces a stored row and a `ProviderView`
  deep-equal to the one it produces before this epic. The backward-compatibility case is asserted by
  deep-equal, not by "still works".
- `transport: "api-key"` and an absent `transport` produce deep-equal results.
- A completed login answers the exact catalogue model list of the vendor, asserted by value, and
  records zero outbound calls.
- A `provider_login` row is deleted by a successful complete, by a successful register, and by an
  expired complete. Each is asserted by a row count of zero.
- Replaying a `loginId` after a successful register answers `not-found`, and no second provider row
  exists.
- A complete after the ten-minute lifetime answers `login-expired`, asserted with a mock clock at an
  exact millisecond on each side of the boundary.
- A vendor with no `pi-ai` `oauth` member answers `provider-not-oauth-capable` from
  `provider.login.start`, with zero outbound calls.
- A refresh driven through the store re-encrypts the row, appends exactly one
  `provider.credentialRefreshed` event, and leaves every other column unchanged. A failing refresh
  leaves the ciphertext byte-identical and appends no event.
- No response body, projection, event payload or error `detail` of any operation in this epic
  contains `access`, `refresh`, `expires` or the PKCE verifier. The assertion searches each
  serialized response for the fixture token values.
- The stored `provider_login` payload is ciphertext: the fixture verifier string does not appear in
  the raw column bytes.
