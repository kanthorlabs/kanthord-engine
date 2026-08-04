# provider

**Question it answers:** which external accounts are registered, and what does each one need to connect?

```sql
CREATE TABLE provider (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  kind               TEXT NOT NULL CHECK (kind IN ('llm', 'git')),  -- dispatch key for the payload schema
  set_default_at     INTEGER,           -- non-null puts this registration in the chain of its kind, ordered by this value
  payload_ciphertext BLOB NOT NULL,     -- the whole kind payload, AES-256-GCM: credential and connection fields together
  payload_iv         BLOB NOT NULL,     -- 96-bit initialization vector, fresh per record
  payload_tag        BLOB NOT NULL,     -- 128-bit authentication tag; a tampered record fails to decrypt
  key_version        INTEGER NOT NULL,  -- master key generation that encrypted this payload
  updated_at         INTEGER NOT NULL,  -- last rename, re-encryption or payload edit
  CHECK (length(payload_iv) = 12),
  CHECK (length(payload_tag) = 16)
) STRICT;
```

A registration is one external account. The MVP registers two kinds, `llm` and `git`, and the table is not an LLM table. See [../phase-2/providers-and-credentials.md](../phase-2/providers-and-credentials.md).

## The schema holds no field of any one kind

`kind` is the dispatch key. A factory maps it to one serializer, one deserializer and one zod schema, and the payload is whatever that schema says. The table therefore carries no column that belongs to a single kind, and adding a kind adds a schema in code, a value to the `CHECK` clause, and no column.

`default_model` was such a column, and it was a leak: a Slack or a Jira registration has no model, so the column would be null for every row of those kinds and `NOT NULL` for one. It now lives inside the payload of the `llm` kind.

The read path is one sequence:

1. Read the row, and decrypt `payload_ciphertext` with the key of `key_version`.
2. Dispatch on `kind` to get the deserializer.
3. Parse the plaintext with that kind's schema. A parse failure is a configuration error, and it names the registration.

An `llm` payload holds the provider variant and its fields, because ten LLM providers do not share one shape:

```
{ "provider": "anthropic", "apiKey": "sk-ant-...", "defaultModel": "claude-opus-5", "baseUrl": null }
```

A `git` payload holds what one transport needs, and the two transports share no field:

```
{ "transport": "http-basic", "forge": "github", "username": "kanthord-bot", "token": "ghp_..." }
{ "transport": "ssh",   "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n..." }
```

`forge` selects the Basic convention a token needs: GitHub accepts the token as the password, GitLab requires the username `oauth2`, and Bitbucket requires `x-token-auth`. The git service maps `forge` to that convention and answers the credential helper with it.

The ssh payload carries a key and nothing else. It has no forge, because an ssh url names a host rather than a forge convention, and no passphrase, because the daemon refuses an encrypted key: `ssh` runs under `BatchMode=yes` and never asks for one, and a stored passphrase would be a second envelope over a secret this table already encrypts. See [../phase-1/git-foundation.md](../phase-1/git-foundation.md).

The discriminant is `http-basic` rather than `https`, because one credential serves HTTPS and the loopback HTTP exception alike, and a value named after the secure scheme would read as forbidding the exception the url policy allows.

`kind` stays at the family level. `llm` is a discriminated union on its own `provider` field, and `git` is a discriminated union on its own `transport` field, so the second level of dispatch is a zod concern rather than a column value. Selection then reads `WHERE kind = 'git'` with no pattern match, and `repository.credential_id` binds one row whichever transport it carries. A fine-grained `kind` is the alternative, and it moves those unions into the enum and forces a migration for every transport this product ever speaks.

## What a read returns

The payload is encrypted whole, so no query reads a connection field without decrypting. Two rules keep that safe and still useful:

- Each kind declares a **public projection** in the same factory. For `llm` it is the provider variant, the default model and the base URL. For `git` it is the forge and the username. `provider list` and `provider show` return that projection, and never the credential fields.
- No query selects `*`. A read names its columns, so a ciphertext never reaches a log or an HTTP response by accident.

`kind` and `name` stay in plaintext columns. A registration whose payload cannot be decrypted is therefore still nameable, and `provider list` can report it as broken rather than disappearing.

## The chain is per kind

`set_default_at` replaces a `provider_binding` table. A non-null value puts the registration in the chain **of its kind**, and that chain orders by the value, so the registration set first is tried first. Each kind has its own chain, and resolution for a model call reads `WHERE kind = 'llm' AND set_default_at IS NOT NULL ORDER BY set_default_at`. The `git` chain stays empty, for the reason below.

The MVP has exactly one `llm` row with a non-null value, which is the registration onboarding forces.

Resolution is agent, then project, then global. The two narrower scopes are bindings on the entity that owns them, not scopes inside one table:

| Scope   | Where the binding lives                                  |
| ------- | -------------------------------------------------------- |
| agent   | `agent_binding`, built when agent-level binding is built |
| project | `project_binding` with `kind = 'provider'`               |
| global  | this column                                              |

A scope table that carried `('global', 'global')` in a `scope`/`scope_id` pair to describe a single default was the redundancy. Global scope has one chain per kind, and a column expresses one chain.

Two costs are accepted with this shape:

- **Reordering the chain rewrites timestamps.** An explicit `position` column would let a human swap two entries. Ordering by `set_default_at` cannot, so a reorder sets the values again. The chain is deferred past the MVP, so the first real reorder is also the first time this matters.
- **A per-binding model override has no column yet.** Until `project_binding` and `agent_binding` carry one, the `defaultModel` of the payload applies. See [../after-the-mvp.md](../after-the-mvp.md).

A `provider remove` is refused while anything still names the registration, and the refusal lists what blocks it: a non-null `set_default_at`, or a `project_binding` row.

## Why a git credential is stored

An unattended daemon has no login session, so it has no ssh agent and no ambient credential helper. It could inherit an operator's, and it deliberately does not: [git-foundation.md](../phase-1/git-foundation.md) suppresses the global config, the system config and the inherited helper chain on every invocation, because a daemon whose authentication depends on whoever started it is not reproducible. The credential therefore has to be data the daemon holds, and this table is where a credential lives.

That reverses the earlier decision, which assumed a git CLI with an agent. The reversal is recorded in that file. Note that the daemon does now run the `git` binary, and the conclusion is unchanged: the binary can reach an agent, and the daemon forbids it.

A `git` registration is bound by `repository.credential_id`, not by `set_default_at`. One daemon serves repositories on different forges under different accounts, and a default would pick the wrong one silently. `set_default_at` therefore stays null on every `git` row, and the chain of that kind is empty.

Two consequences follow from holding a forge token:

- **The token is long-lived and it can push to `main`.** Rotation is deferred with the rest of key rotation, so the mitigation is scope: a token for the repositories KanthorD publishes to, and nothing else.
- **No objective-side process may read it.** An objective clone has no configured remote and never authenticates, so only the bare home operations decrypt this payload. The deferred `pr@1` breaks that property, which is why it is named as a capability boundary rather than a feature.

## Example

```
id                  provider_01JQ8Z3K7M
name                work-anthropic
kind                llm
set_default_at      1738396801000
payload_ciphertext  <112 bytes>
payload_iv          <12 bytes>
payload_tag         <16 bytes>
key_version         1
```

`kanthord provider register --kind llm --name work-anthropic --provider anthropic --model claude-opus-5` inserts this row. A `git` registration is the same command with `--kind git --forge github --username kanthord-bot`, and `repository register --credential <name>` binds it. The human pastes the API key once. The command validates the whole payload against the `llm` schema, serializes it, encrypts it with the master key, and the plaintext never reaches disk.

The decrypted payload is the JSON above: the provider variant, the key, the default model and an optional base URL. `provider list` prints `work-anthropic`, `llm`, `anthropic` and `claude-opus-5` from the public projection, and never the key.

`set_default_at` is stamped because this is the first `llm` registration, and onboarding does not finish without one. Every attempt therefore resolves to `work-anthropic` and `claude-opus-5`, and the `attempt` row records both, so a later payload edit cannot rewrite what a past attempt used.

A second Anthropic account is a second row with the same `kind` and a null `set_default_at`: registered, and unused until the human switches to it.
