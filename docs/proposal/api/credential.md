# Credential and provider

Reviewer: platform and security. Conventions are [README.md](README.md). The decisions are `../phase-2/providers-and-credentials.md`.

## A credential has no route of its own

A registration holds a credential, and `../database/provider.md` stores it as the encrypted columns of the registration itself. A registration is the only thing that creates one, so the secret is a write-only field of the registration and nothing else reads it back. A route that returns a credential would exist only to leak it.

Rotation is deferred, so no route updates a stored key. See `../after-the-mvp.md`.

A git credential is a registration too, of `kind = 'git'`, because the git service speaks HTTPS Basic authentication and inherits nothing from the host. `repository.register` names it, and that route proves it with a `git-receive-pack` advertisement rather than a fetch, because a fetch on a public repository succeeds with any token at all. See `../database/provider.md`.

## Routes

| operationId           | Method and path                 | introducedIn | status  | Source                                             |
| --------------------- | ------------------------------- | ------------ | ------- | -------------------------------------------------- |
| `provider.register`   | `POST /v1/providers`            | phase-1      | routed  | P1-E1, the git credential of `repository.register` |
| `provider.list`       | `GET /v1/providers`             | phase-1      | routed  | P1-E1, the CLI resolves `--credential <name>`      |
| `provider.show`       | `GET /v1/providers/:id`         | phase-1      | routed  | providers-and-credentials.md                       |
| `provider.rename`     | `POST /v1/providers/:id/rename` | phase-2      | stubbed | providers-and-credentials.md, "rename"             |
| `provider.remove`     | `DELETE /v1/providers/:id`      | phase-2      | stubbed | providers-and-credentials.md, "remove"             |
| `provider.setDefault` | `PUT /v1/providers/:id/default` | phase-2      | stubbed | providers-and-credentials.md, "set default"        |

## Three routes ship in phase 1, and the rest in phase 2

`repository.register` carries a mandatory `credentialId` that names a `provider` row of `kind = 'git'`, and the phase-1 exit criterion registers a real remote. A phase in which every provider route answers `501` therefore has no public path to the credential its own journey needs. `provider.register`, `provider.list` and `provider.show` ship in phase 1 for that reason, and they need only the crypto service that phase 1 already delivers.

`provider.rename`, `provider.remove` and `provider.setDefault` stay in phase 2. A rename and a removal are management of a registry that phase 1 only writes once, and `setDefault` serves the llm chain, which phase 1 has no use for.

## `provider.register`

The body holds a name, a kind, and the payload that kind's schema declares. For `kind = 'llm'` that is the provider variant, the credential and the default model. The name is unique, because a human refers to a registration by name.

The response returns the public projection of the payload, which the same factory defines per kind, and never a credential field. For `llm` the projection is the provider variant, the default model and the base URL.

The crypto service encrypts the secret before it reaches SQLite. The daemon refuses to start with no master key, so this route never runs without one.

## `provider.remove`

A removal is refused while anything names the registration. The refusal is `409 binding-in-use`, and `details` lists what blocks it:

- a non-null `set_default_at`, which puts the registration in the global chain of its kind,
- a `project_binding` row of `kind = 'provider'`,
- a `repository.credential_id` that names it, listed by repository.

The third is not optional. `repository.credential_id` is `NOT NULL REFERENCES provider(id)`, so removing a `git` registration that a repository still uses would break every fetch and every publish of that repository. A silent removal would empty a chain and stop every node that resolves to it.

## `provider.setDefault`

The route stamps `set_default_at` on one registration, which puts it in the global chain. There is no binding table and no global binding route, because a global chain of one is a column on the registration. Onboarding calls this route for the first registration, because onboarding does not finish without a default.

**The route is invalid for `kind = 'git'` and returns `400`.** A git registration is bound by `repository.credential_id`, one repository at a time. One daemon serves repositories on different forges under different accounts, so a default would pick the wrong one silently, and `../database/provider.md` keeps the git chain empty by design.

The chain orders by `set_default_at`, so calling this route again on a second registration appends it. The MVP refuses that second call until the ordered chain ships, and the refusal names the registration that already holds the default.

A project-scope binding is `project.md`, and an agent-scope binding is `instruction.md`. Both are `post-mvp`.
