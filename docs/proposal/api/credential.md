# Credential and provider

Reviewer: platform and security. Conventions are [README.md](README.md). The decisions are `../phase-2/providers-and-credentials.md`.

## A credential has no route of its own

A registration holds a credential, and `../database/provider.md` stores it as the encrypted columns of the registration itself. A registration is the only thing that creates one, so the secret is a write-only field of the registration and nothing else reads it back. A route that returns a credential would exist only to leak it.

Rotation is deferred, so no route updates a stored key. See `../after-the-mvp.md`.

A git credential is a registration too, of `kind = 'git'`, because the git service speaks HTTPS Basic authentication and inherits nothing from the host. `repository.register` names it, and that route proves it with a `git-receive-pack` advertisement rather than a fetch, because a fetch on a public repository succeeds with any token at all. See `../database/provider.md`.

## Routes

| operationId              | Method and path                    | introducedIn | status | Source                                                        |
| ------------------------ | ---------------------------------- | ------------ | ------ | ------------------------------------------------------------- |
| `provider.catalog`       | `GET /v1/provider/llm`             | phase-2      | routed | the llm provider and model catalog of `@earendil-works/pi-ai` |
| `provider.inspect`       | `POST /v1/provider/inspect`        | phase-2      | routed | the live model list of an OpenAI compatible endpoint          |
| `provider.list`          | `GET /v1/provider`                 | phase-1      | routed | P1-E1, the CLI resolves `--credential <name>`                 |
| `provider.loginCancel`   | `POST /v1/provider/login/cancel`   | phase-2      | routed | providers-and-credentials.md, subscription sign-in            |
| `provider.loginComplete` | `POST /v1/provider/login/complete` | phase-2      | routed | providers-and-credentials.md, subscription sign-in            |
| `provider.loginStart`    | `POST /v1/provider/login`          | phase-2      | routed | providers-and-credentials.md, subscription sign-in            |
| `provider.register`      | `POST /v1/provider`                | phase-1      | routed | P1-E1, the git credential of `repository.register`            |
| `provider.show`          | `GET /v1/provider/:id`             | phase-1      | routed | providers-and-credentials.md                                  |
| `provider.verify`        | `POST /v1/provider/:id/verify`     | phase-1      | routed | providers-and-credentials.md                                  |
| `provider.rename`        | `POST /v1/provider/:id/rename`     | phase-2      | routed | providers-and-credentials.md, "rename"                        |
| `provider.remove`        | `DELETE /v1/provider/:id`          | phase-2      | routed | providers-and-credentials.md, "remove"                        |
| `provider.setDefault`    | `PUT /v1/provider/:id/default`     | phase-2      | routed | providers-and-credentials.md, "set default"                   |

## Four routes ship in phase 1, and the rest in phase 2

`repository.register` carries a mandatory `credentialId` that names a `provider` row of `kind = 'git'`, and the phase-1 exit criterion registers a real remote. A phase in which every provider route answers `501` therefore has no public path to the credential its own journey needs. `provider.register`, `provider.list` and `provider.show` ship in phase 1 for that reason, and they need only the crypto service that phase 1 already delivers. `provider.verify` also ships in phase 1, because it checks the stored llm credential before a run.

`provider.rename`, `provider.remove` and `provider.setDefault` stay in phase 2. A rename and a removal are management of a registry that phase 1 only writes once, and `setDefault` serves the llm chain, which phase 1 has no use for.

## `provider.register`

The body holds a name, a kind, and the payload that kind's schema declares. For `kind = 'llm'` that is the provider variant, the credential and the default model. The name is unique, because a human refers to a registration by name.

The response returns the public projection of the payload, which the same factory defines per kind, and never a credential field. For `llm` the projection is the provider variant, the default model and the base URL.

The crypto service encrypts the secret before it reaches SQLite. The daemon refuses to start with no master key, so this route never runs without one.

## `provider.remove`

A removal is refused while anything names the registration. The refusal is `409 binding-in-use`, and `details` lists what blocks it:

- a non-null `set_default_at`, which puts the registration in the global chain of its kind,
- a `project_binding` row of `kind = 'provider'`,
- a `repository.credential_id` that names it, listed by repository,
- an `attempt.provider_id` that names it, listed by attempt.

`provider.remove` accepts `force=true` as an optional query parameter. A forced removal suppresses the first blocker only: when `set_default_at` is non-null and `force=true`, the `default-chain` entry is omitted from the blockers list. The second (`project-binding`), third (`repository`), and fourth (`attempt`) blockers remain mandatory regardless of `force`; `repository.credential_id` and `attempt.provider_id` are `NOT NULL REFERENCES provider(id)`, so overriding either would leave a registered repository pointing at a deleted credential or destroy the audit history the product exists to keep. A forced removal that is blocked by the second, third, or fourth blocker answers `409 binding-in-use` with those remaining blockers in the fixed order. A forced removal of a stamped holder that succeeds leaves that kind's default chain without a head; a human calls `provider.setDefault` to stamp a successor. `force=false` and an absent `force` parameter are equivalent; an unstamped provider's forced removal has no effect on the chain.

The third and the fourth are not optional. `repository.credential_id` is `NOT NULL REFERENCES provider(id)`, so removing a `git` registration that a repository still uses would break every fetch and every publish of that repository. `attempt.provider_id` is `NOT NULL REFERENCES provider(id)` too, so removing a registration an attempt pinned would orphan the attempt's selection. A silent removal would empty a chain and stop every node that resolves to it.

## `provider.setDefault`

The route stamps `set_default_at` on one registration, which puts it in the global chain. There is no binding table and no global binding route, because a global chain of one is a column on the registration. Onboarding calls this route for the first registration, because onboarding does not finish without a default.

**The route is invalid for `kind = 'git'` and returns `400`.** A git registration is bound by `repository.credential_id`, one repository at a time. One daemon serves repositories on different forges under different accounts, so a default would pick the wrong one silently, and `../database/provider.md` keeps the git chain empty by design.

The chain holds one `llm` registration. Calling this route on a second registration moves the default: the same transaction clears `set_default_at` on the current holder, appends `provider.defaultUnset` on it, then stamps the target and appends `provider.defaultSet`. Calling it on the current holder changes nothing and appends no event.

A project-scope binding is `project.md`, and an agent-scope binding is `instruction.md`. Both are `post-mvp`.

## `provider.verify`

`POST /v1/provider/:id/verify` sends one prompt to the registered provider's stored default model.

The probe uses the prompt path of a real run rather than a model list. A `GET /models` request with a bearer header is OpenAI-shaped, so it fails for Anthropic and Google, which use different headers and paths. It also proves nothing about an OAuth credential. The prompt probe uses the actual request path that a run takes.

The probe sends exactly `"What time is it?"` with `max_tokens: 16`. The reply text is not used or returned. A completion proves that the stored model answered, regardless of its text.

The response has this shape:

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

The outcome mapping is:

| Outcome                         | reachability  | authentication | completed | refusal                |
| ------------------------------- | ------------- | -------------- | --------- | ---------------------- |
| a completion arrives            | `reachable`   | `accepted`     | `true`    | `null`                 |
| transport failure, no response  | `unreachable` | `unknown`      | `false`   | `endpoint-unreachable` |
| `401` or `403`                  | `reachable`   | `rejected`     | `false`   | `credential-rejected`  |
| `404` or an unknown-model error | `reachable`   | `accepted`     | `false`   | `model-unavailable`    |
| `429`                           | `reachable`   | `accepted`     | `false`   | `quota-exceeded`       |
| any other non-`2xx`             | `reachable`   | `unknown`      | `false`   | `endpoint-rejected`    |

The probe timeout is 30 seconds. A timeout maps to `endpoint-unreachable`.

No verdict is persisted. The provider row is unchanged, and `ProviderView` is unchanged. A re-verification runs the probe again unless the request replays a cached response within the idempotency window.

The invocation identity is the client's `Idempotency-Key`, and nothing else. A transport retry sends the same key and receives the stored answer. A deliberate re-verification after credential rotation sends no key or a new key, and reaches the vendor. A request without a key always runs a fresh check.

Credential rotation invalidates no stored answer. The in-memory record uses the idempotency key and has no reference to the provider row. The record lives for `http.idempotency.ttl` and no longer. A restart discards it.

The api key never appears in the response body, `detail`, or refusal.

## Subscription sign-in

Registration has three steps: authenticate, list the models the account can use, then register the chosen default model. `provider.loginStart` begins authentication, `provider.loginComplete` completes it and returns the model list, and `provider.register` stores the selected model (`src/commands/provider/start-provider-login.ts:81-191`, `src/commands/provider/complete-provider-login.ts:92-249`, `src/commands/provider/register-provider.ts:178-292`).

`@earendil-works/pi-ai` owns the OAuth protocol and refresh. The engine writes no PKCE code, state, token exchange, refresh logic or redirect handler. It supplies storage and transport (`@earendil-works/pi-ai`, `src/services/provider-auth/pi-ai.ts:232-476`, `src/services/provider-auth/credential-writer.ts:42-87`).

The engine derives the admitted set from builtin providers whose `auth.oauth` is present and whose id is in the model catalogue. It holds no vendor list, so a new catalogued OAuth vendor in `pi-ai` needs no engine edit (`src/services/provider-auth/pi-ai.ts:93-229`, `src/services/model-catalog/pi-ai.ts:31-62`).

Where a flow offers a method choice, the engine selects the device-code branch and falls back to the browser branch. It recognizes `device-code` and `device_code`; a flow that offers neither refuses `login-method-unavailable` and names the ids it saw. A third spelling requires a named engine edit, not a silent fall-through (`src/services/provider-auth/pi-ai.ts:168-181`, `src/services/provider-auth/index.ts:59-60`).

`provider.loginStart` accepts an `answers` map keyed by prompt message. A missing text or secret answer refuses `login-input-required` and carries the prompt message in `details.detail` (`src/http/contract/credential.ts:217-220`, `src/services/provider-auth/pi-ai.ts:272-298`).

The start response has one of these two arms:

```ts
type ProviderLoginStartResponse =
  | {
      loginId: string;
      method: "manual-code";
      authUrl: string;
      instructions: string;
      expiresAt: number;
    }
  | {
      loginId: string;
      method: "device-code";
      userCode: string;
      verificationUri: string;
      expiresAt: number;
      pollIntervalMs: number;
    };
```

The complete response is:

```ts
{
  loginId: string;
  models: string[];
}
```

The method is fixed when the login starts. A device login rejects a supplied `code`. A suspended manual login requires a code, unless its callback already resolved the flow (`src/commands/provider/complete-provider-login.ts:119-181`, `src/services/provider-auth/pi-ai.ts:371-409`).

`pollIntervalMs` carries the vendor interval in milliseconds, or 5,000 when the vendor omits it. `pi-ai` polls the vendor inside the daemon, and `provider.loginComplete` only reads the state of that in-process flow. Faster dashboard polling costs one local request and no outbound call; the engine applies no rate limit (`src/services/provider-auth/pi-ai.ts:299-377`, `src/http/contract/credential.ts:230-252`).

A login is `pending`, `completed` or consumed. A pending row holds the process-local flow. A completed row holds the encrypted credential and exact model ids. `provider.register` consumes the login by deleting its row in the provider transaction (`src/domain/provider-login.ts:1-58`, `src/commands/provider/register-provider.ts:196-263`, `docs/proposal/database/provider_login.md:32-36`).

A second `provider.loginComplete` for a completed login returns the same `{ loginId, models }`, makes no vendor call and changes no row. The completed row is the idempotency record, so the replay needs no `Idempotency-Key` (`src/commands/provider/complete-provider-login.ts:109-139`).

The manual arm expires at `created_at` plus ten minutes. The device arm expires at the clock time of its `device_code` event plus that event's lifetime, or ten minutes when the event carries none (`src/commands/provider/start-provider-login.ts:126-160`, `src/services/provider-auth/pi-ai.ts:299-377`).

Expiry is a one-time transition. The first request that observes an expired row deletes it, aborts the live flow and refuses `login-expired`; a replay answers `not-found`. The rule also applies to completed rows, so an unregistered credential does not outlive its deadline (`src/commands/provider/complete-provider-login.ts:96-145`).

`provider.loginCancel` takes a `loginId`, aborts the live flow through its `AbortSignal`, lets `pi-ai` close its callback server or stop its poll, and deletes the row in one transaction. It is the only way to release a vendor before `expiresAt`. Cancelling a completed row deletes its credential (`src/commands/provider/cancel-provider-login.ts:26-50`, `src/services/provider-auth/pi-ai.ts:378-476`).

Only one pending login exists per vendor. A second start refuses `login-in-progress` (`src/services/storage/migration-0010-provider-login.ts:7-30`, `src/commands/provider/start-provider-login.ts:95-123`).

A restart loses a live flow. The row records the daemon instance, so completion of a pending row from another instance refuses `login-lost` and deletes the row. A completed row has no live flow and is instance-independent (`src/commands/provider/complete-provider-login.ts:105-145`, `src/domain/provider-login.ts:30-58`).

The `llm` registration arm carries `transport`; absence means `api-key`, and the OAuth arm requires `transport: "oauth"`. The API-key projection is `{ transport, provider, defaultModel, baseUrl }`; the OAuth projection is `{ transport: "oauth", provider, defaultModel }`. Neither projection has a token, and no operation returns `access`, `refresh` or `expires` (`src/domain/provider-payload.ts:11-133`, `src/http/contract/credential.ts:43-68`).

The catalogue reports only static OAuth capability. Each provider carries `oauth: null` without a flow or `{ label }` with one, where `label` is `loginLabel ?? name`. It does not report the method or a prompt answer because `login()` discovers both (`src/services/model-catalog/pi-ai.ts:31-62`, `src/http/contract/credential.ts:345-362`).

The token, code, callback state and every response body of these three operations stay out of every log (`src/http/server/credential/start-provider-login.ts:19-36`, `src/http/server/credential/complete-provider-login.ts:19-36`, `src/http/server/credential/cancel-provider-login.ts:14-28`).
