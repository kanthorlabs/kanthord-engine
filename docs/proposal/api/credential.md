# Credential and provider

Reviewer: platform and security. Conventions are [README.md](README.md). The decisions are `../phase-2/providers-and-credentials.md`.

## A credential has no route of its own

A registration holds a credential, and `../database/provider.md` stores it as the encrypted columns of the registration itself. A registration is the only thing that creates one, so the secret is a write-only field of the registration and nothing else reads it back. A route that returns a credential would exist only to leak it.

Rotation is deferred, so no route updates a stored key. See `../after-the-mvp.md`.

A git credential is a registration too, of `kind = 'git'`, because the git service speaks HTTPS Basic authentication and inherits nothing from the host. `repository.register` names it, and that route proves it with a `git-receive-pack` advertisement rather than a fetch, because a fetch on a public repository succeeds with any token at all. See `../database/provider.md`.

## Routes

| operationId           | Method and path                | introducedIn | status | Source                                                        |
| --------------------- | ------------------------------ | ------------ | ------ | ------------------------------------------------------------- |
| `provider.catalog`    | `GET /v1/provider/llm`         | phase-2      | routed | the llm provider and model catalog of `@earendil-works/pi-ai` |
| `provider.inspect`    | `POST /v1/provider/inspect`    | phase-2      | routed | the live model list of an OpenAI compatible endpoint          |
| `provider.register`   | `POST /v1/provider`            | phase-1      | routed | P1-E1, the git credential of `repository.register`            |
| `provider.list`       | `GET /v1/provider`             | phase-1      | routed | P1-E1, the CLI resolves `--credential <name>`                 |
| `provider.show`       | `GET /v1/provider/:id`         | phase-1      | routed | providers-and-credentials.md                                  |
| `provider.verify`     | `POST /v1/provider/:id/verify` | phase-1      | routed | providers-and-credentials.md                                  |
| `provider.rename`     | `POST /v1/provider/:id/rename` | phase-2      | routed | providers-and-credentials.md, "rename"                        |
| `provider.remove`     | `DELETE /v1/provider/:id`      | phase-2      | routed | providers-and-credentials.md, "remove"                        |
| `provider.setDefault` | `PUT /v1/provider/:id/default` | phase-2      | routed | providers-and-credentials.md, "set default"                   |

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
