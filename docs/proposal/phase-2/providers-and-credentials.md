# Providers and credentials

Reviewer: platform and security. Phase 2. This file covers which model answers a request, and how the secret that reaches it is stored.

## Credentials are encrypted at rest

The human registers an account at runtime. The program encrypts the whole payload of that account with a master key and stores the ciphertext in SQLite.

The payload is encrypted whole, credential and connection fields together, so no field of any one kind becomes a column of the shared table. A factory keyed on `kind` holds the schema, the serializer and the public projection that a read returns. See [../database/provider.md](../database/provider.md).

The master key comes from configuration: an environment variable, with a config file path as the fallback. Algorithm is AES-256-GCM with a random 96-bit initialization vector per record. The record stores the initialization vector, the authentication tag and a key version. A key file must have mode 0600, and the daemon refuses to start otherwise.

Encryption at rest with a master key from configuration is the whole of the MVP scope. Key rotation is deferred.

A git credential is a registration of `kind = 'git'` in the same table, because the git service authenticates from a stored credential and inherits no ambient one. It is bound by `repository.credential_id` rather than by a default. See `../phase-1/git-foundation.md`.

A pending subscription login is a second encrypted record in `provider_login`. It holds the credential and the model ids the vendor issued, sealed with the same master key as `provider`. It lives from vendor issuance until `provider.register` consumes it, and registration, cancellation or expiry deletes it (`src/services/storage/migration-0010-provider-login.ts:7-30`, `src/commands/provider/register-provider.ts:196-263`, `src/commands/provider/cancel-provider-login.ts:26-50`, `src/commands/provider/complete-provider-login.ts:96-145`).

## Pi-ai owns credential resolution

`pi-ai` owns `ProviderAuth` for every catalogued vendor. The engine passes a single-entry `CredentialStore` adapter to `builtinModels({ credentials })` and calls `completeSimple()`. Pi-ai drives the store internally. The engine writes no authentication header and no vendor-specific authentication scheme.

The engine implements `CredentialStore` from `@earendil-works/pi-ai` as a single-entry, per-request adapter backed by the encrypted `provider` table. One adapter wraps exactly one registration, so a probe of registration A can never read registration B's credential.

`resolveProviderAuth` from `@earendil-works/pi-ai` is not in the package's public exports map. Pi-ai resolves credentials internally through `builtinModels`.

Verification keeps the existing probe and outcome table. The credential store serves either an api-key or an oauth credential, and the probe admits a vendor that carries only an oauth flow. When `pi-ai` refreshes a credential, the adapter writes it through `CredentialStore.modify`, re-encrypts the provider row inside one storage transaction and appends `provider.credentialRefreshed`. A failed refresh leaves the stored credential unchanged (`src/services/provider-auth/pi-ai.ts:50-88`, `src/services/provider-auth/credential-writer.ts:42-87`, `src/queries/provider/verify-provider.ts:103-122`).

The `modify` contract of `@earendil-works/pi-ai` requires mutual exclusion per provider id and gives its callback the current credential. The engine adapter is built per probe over an already-decrypted row, so it holds no shared lock and the callback sees a snapshot. Two concurrent verifies of one oauth registration can therefore both refresh: under refresh-token rotation the second usually fails and reports a spurious `rejected`, and when both succeed the later whole-payload write wins. No row is corrupted because the write is one transaction. This is a limitation of the adapter lifetime, not a consequence of the snapshot rule below. That rule governs the probe read, because the lock cannot span a vendor round-trip (`@earendil-works/pi-ai`, `src/services/provider-auth/pi-ai.ts:50-88`, `src/services/provider-auth/credential-writer.ts:46-87`).

The probe takes a credential snapshot at request start. It is a network call that runs after the storage transaction that read the provider row closes. The daemon does not hold a database lock across a vendor round-trip. A credential rotated or revoked while the probe is in flight produces a verdict about the credential as it stood at request start. The verdict is not re-validated on return. A human who receives a stale `rejected` verdict retries, and a fresh verification reads the current credential.

## How the dashboard learns a credential is irrecoverable

The dashboard calls `provider.verify`, which answers `authentication: "rejected"` when the refresh fails. No new field or operation is needed (`src/queries/provider/verify-provider.ts:132-160`, `src/http/contract/credential.ts:199-215`).

## Two deployment decisions this design rests on

The daemon runs on one host with no load-balanced pool. The dashboard team confirmed this deployment. The home lock takes an exclusive SQLite transaction and refuses a network filesystem, so two instances cannot share one database. A pending login can therefore stay process-local without sticky routing or a resumable flow (`src/services/home-lock/sqlite.ts:36-80`).

`openai-compatible` is the only self-configuration escape hatch. The dashboard team confirmed that it needs no other one, so registration keeps its catalogue gate. Subscription OAuth cannot reach a self-configured endpoint because `openai-compatible` carries no `pi-ai` OAuth member (`src/commands/provider/register-provider.ts:55-80`, `src/commands/provider/register-provider.ts:227-231`, `src/services/model-catalog/pi-ai.ts:49-62`).

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
