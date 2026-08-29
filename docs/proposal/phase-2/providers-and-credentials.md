# Providers and credentials

Reviewer: platform and security. Phase 2. This file covers which model answers a request, and how the secret that reaches it is stored.

## Credentials are encrypted at rest

The human registers an account at runtime. The program encrypts the whole payload of that account with a master key and stores the ciphertext in SQLite.

The payload is encrypted whole, credential and connection fields together, so no field of any one kind becomes a column of the shared table. A factory keyed on `kind` holds the schema, the serializer and the public projection that a read returns. See [../database/provider.md](../database/provider.md).

The master key comes from configuration: an environment variable, with a config file path as the fallback. Algorithm is AES-256-GCM with a random 96-bit initialization vector per record. The record stores the initialization vector, the authentication tag and a key version. A key file must have mode 0600, and the daemon refuses to start otherwise.

Encryption at rest with a master key from configuration is the whole of the MVP scope. Key rotation is deferred.

A git credential is a registration of `kind = 'git'` in the same table, because the git service authenticates from a stored credential and inherits no ambient one. It is bound by `repository.credential_id` rather than by a default. See `../phase-1/git-foundation.md`.

## Pi-ai owns credential resolution

`pi-ai` owns `ProviderAuth` for every catalogued vendor. The engine passes a single-entry `CredentialStore` adapter to `builtinModels({ credentials })` and calls `completeSimple()`. Pi-ai drives the store internally. The engine writes no authentication header and no vendor-specific authentication scheme.

The engine implements `CredentialStore` from `@earendil-works/pi-ai` as a single-entry, per-request adapter backed by the encrypted `provider` table. One adapter wraps exactly one registration, so a probe of registration A can never read registration B's credential.

`resolveProviderAuth` from `@earendil-works/pi-ai` is not in the package's public exports map. Pi-ai resolves credentials internally through `builtinModels`. EPIC 045 may revisit this if the function becomes a public export.

Verification covers all credential types by construction. EPIC 045 adds OAuth, with no change to the probe or the outcome table.

The probe takes a credential snapshot at request start. It is a network call that runs after the storage transaction that read the provider row closes. The daemon does not hold a database lock across a vendor round-trip. A credential rotated or revoked while the probe is in flight produces a verdict about the credential as it stood at request start. The verdict is not re-validated on return. A human who receives a stale `rejected` verdict retries, and a fresh verification reads the current credential.

## A registration is a named account

The human registers an account at global scope. One registration holds a name, a kind, and one encrypted payload. `kind = 'llm'` is the account an attempt calls through `pi-ai`, and its payload holds the provider variant, the credential and the default model. `kind = 'git'` is the forge account the bare home fetches and pushes with, and its payload holds the forge, the username and the token. The same variant may be registered any number of times under different names, so three ChatGPT accounts are three registrations. The name is unique and is how a human refers to it. At least one registration is mandatory to finish onboarding, and onboarding stamps `set_default_at` on it.

Registry operations are register, list, rename, set default and remove. A removal is refused while anything still names the registration, and the daemon lists what blocks it: a non-null `set_default_at`, a project binding, a repository that names it as its credential, or an attempt that pinned it as its provider. Otherwise a removal would silently empty a chain and stop every node that resolves to it. Set default moves the default rather than refusing a second call: the same transaction clears `set_default_at` on the current holder and stamps the target, and the response names every displaced registration by `id` and `name`.

The MVP requires exactly one registration, and it is the global default. The multi-registration rules below are the design the entity model already supports, and they are built after the MVP.

There is no binding table. The global chain is the `set_default_at` column of the registration itself, because a scope table describing one global list carried a row whose scope was always the same literal. A narrower scope binds on the entity that owns it: a project through a `project_binding` row of `kind = 'provider'`, and an agent through `agent_binding` when agent-level binding is built. See [../database/provider.md](../database/provider.md).

## The task attempt is the unit of selection

The daemon resolves the binding once, at the start of a task attempt, and pins one registration and one provider_model for the whole attempt. A failure of that registration, of any kind, ends the attempt as a failure. The daemon never changes the registration or the provider_model in the middle of an attempt, because a switch replays the context and repeats the work already paid for, which costs more than a clean retry. The attempt row records the pinned registration and provider_model.

This rule holds in the MVP, with a list of one.

## Deferred: the ordered chain

Resolution is agent, then project, then global. Global always holds a list, because onboarding forces one registration with `set_default_at` stamped. A project with no provider binding inherits the global chain. An agent with no binding inherits the project chain. An agent must end with a non-empty chain, and the daemon refuses to run a node whose agent resolves to an empty one.

The global chain orders by `set_default_at`, and a project chain orders by the `created_at` of its binding rows. A reorder therefore rewrites those values, because no `position` column exists. An override of the registration default needs a column on the binding row, and neither binding table carries one yet; until then the `defaultModel` of the payload applies.

## Deferred: the chain advances across attempts

Attempt one uses the first registration in the resolved list. An attempt that fails on a provider error starts the next attempt on the next registration. The list wraps to the front after the last entry. The attempt limit still ends the task in `blocked`, so the chain never retries without bound. An attempt that fails on the verification command or on `re@1` keeps the same registration, because the provider worked.

## Deferred: key rotation

A CLI command that re-encrypts every record under a new key version.
