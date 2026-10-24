# Agent CLI specification

This specification for `kanthord agent` contains **14 command leaves: 13 implemented and 1 proposed**.

See the [CLI index](./README.md) for shared conventions.
Agent entries of a worker binding belong to [Project](./project.md).
[Worker](./worker.md) covers the worker catalog, which names the agent of each native worker.
[LLM](./llm.md) covers credential management of LLM platforms.

## Shared input and output contract

The request, output, failure and replay rules of the [Worker shared contract](./worker.md#shared-input-and-output-contract) apply.

| Common flag                                                                      | Applies to / Agent requirement                                                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`--endpoint`](./common-flags.md#--endpoint)                                     | Every command; inherited from the `agent` group.                                   |
| [`--token`](./common-flags.md#--token)                                           | Every operation requires a nonblank resolved human token.                          |
| [`--idempotency-key`](./common-flags.md#--idempotency-key)                       | Mutations only.                                                                    |
| [`--limit`](./common-flags.md#--limit), [`--cursor`](./common-flags.md#--cursor) | Each list command.                                                                 |
| [`--file`](./common-flags.md#--file)                                             | Required for `enablement put` and `enablement provider add`; schemas appear below. |
| [`--help`](./common-flags.md#--help)                                             | Every group and leaf.                                                              |

`AgentName` and `WorkerName` follow the [Worker names and identities](./worker.md#names-and-identities).

## Command inventory

`P` means proposed; `I` means implemented syntax and operation. `[R]`, `[M]` and `[L]` use the [common synopsis definitions](./common-flags.md#synopsis-markers).
`human` authenticates a human JWT.

| Status | Command after `kanthord agent`                                                                   | Route                                                                 | Operation ID                           | Access  |
| ------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------- | ------- |
| P      | `list [L]`                                                                                       | `GET /api/agent`                                                      | `agent.list`                           | `human` |
| I      | `get <agent-name> [--view final] [--project <project-id> --binding-id <binding-id>]`             | `GET /api/agent/:agent_name`                                          | `agent.get`                            | `human` |
| I      | `enablement list [L] [R]`                                                                        | `GET /api/agent/enablement`                                           | `agent.enablement.list`                | `human` |
| I      | `enablement get <agent-name> [R]`                                                                | `GET /api/agent/enablement/:agent_name`                               | `agent.enablement.get`                 | `human` |
| I      | `enablement put <agent-name> --file <path> [M] [R]`                                              | `PUT /api/agent/enablement/:agent_name`                               | `agent.enablement.put`                 | `human` |
| I      | `enablement enable <agent-name> --expected-revision <revision> [M] [R]`                          | `POST /api/agent/enablement/:agent_name/enable`                       | `agent.enablement.enable`              | `human` |
| I      | `enablement disable <agent-name> --expected-revision <revision> [M] [R]`                         | `POST /api/agent/enablement/:agent_name/disable`                      | `agent.enablement.disable`             | `human` |
| I      | `enablement remove <agent-name> --expected-revision <revision> [M] [R]`                          | `DELETE /api/agent/enablement/:agent_name`                            | `agent.enablement.remove`              | `human` |
| I      | `enablement provider add <agent-name> --file <path> [M] [R]`                                     | `POST /api/agent/enablement/:agent_name/provider`                     | `agent.enablement.provider.add`        | `human` |
| I      | `enablement provider remove <agent-name> <provider-name> --expected-revision <revision> [M] [R]` | `DELETE /api/agent/enablement/:agent_name/provider/:provider_name`    | `agent.enablement.provider.remove`     | `human` |
| I      | `enablement provider model list <agent-name> <provider-name>`                                    | `GET /api/agent/enablement/:agent_name/provider/:provider_name/model` | `agent.enablement.provider.model.list` | `human` |
| I      | `model list --provider <provider> --credential <credential>`                                     | `GET /api/agent/model`                                                | `agent.model.list`                     | `human` |
| I      | `cooldown list`                                                                                  | `GET /api/agent/cooldown`                                             | `agent.cooldown.list`                  | `human` |
| I      | `cooldown clear <credential> [--holder <name>] [M]`                                              | `DELETE /api/agent/cooldown/:credential`                              | `agent.cooldown.clear`                 | `human` |

The static `/api/agent/enablement` path takes precedence over `/:agent_name`.

The two catalog reads follow [the agent catalog](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.impl.md#the-agent-catalog).
Each is `unary`, has `mutation: false` and a default timeout of 30 s.

## Catalog and enablement commands

The catalog holds `swe@1`, `re@1` and `env@1`.
`env@1` has no worker. Its enablement takes a credential with the holder `server`.
The Onboarding component of the Project Service runs `env@1`.

### `list`

This command remains proposed. It uses `[L]`, no positional arguments and no filters.
Required token: human JWT. Query holds `limit` and optional `cursor`. Returns
`{ items, next_cursor }`, paged by `agent_name` in ascending alphabetical order.
It lists every catalog agent, also an agent without an enablement. Each item holds
`agent_name: AgentName`, `worker_names: WorkerName[]` and `enablement`, the
[agent enablement record](#agent-enablement-record) or `null` when no record exists.

### `get <agent-name>`

```text
kanthord agent get <agent-name> [--view final] [--project <project-id> --binding-id <binding-id>]
```

`agent-name` is required `AgentName`, with no default, and maps to
`params.agent_name`. The key names one catalog declaration, not a worker binding.
Required token: human JWT. Absent body. HTTP `200` returns
`agent_name` and the following declaration/configuration fields:

| Option                      | Query        | Meaning                                                                                                                                       |
| --------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--view final`              | `view`       | Optional. The only value is `final`. The `prompt` answer holds `final` only and no `parts`.                                                   |
| `--project <project-id>`    | `project_id` | Optional, and only together with `--binding-id`. Selects the repository binding whose binding prompt of the agent joins `final`.              |
| `--binding-id <binding-id>` | `binding_id` | Optional, and only together with `--project`. A binding that is no repository binding of the project answers `404 project.binding.not_found`. |

With `--project` and `--binding-id`, `final` is the worker system prompt with the binding prompt of the agent before the framing.
Without `--project` and `--binding-id`, a workbench agent answers the Workbench system prompt, and `env@1` answers the worker system prompt.

| Result field           | Type and meaning                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configuration_schema` | JSON Schema draft 2020-12 object describing the effective configuration: every allowed field, its type, requiredness and enumeration. Its `description` states the whole-configuration constraint that the Agent component checks; JSON Schema validates no cross-field lookup.                                                                                                                                               |
| `overridable_fields`   | Array of field paths allowed in a Project override; no wildcard permission to add fields. For `swe@1` and `re@1` it is `["agent_provider", "model_identifier", "reasoning_effort"]`. For `env@1` it is `[]`.                                                                                                                                                                                                                  |
| `enablement`           | The [agent enablement record](#agent-enablement-record), or `null` when no record exists.                                                                                                                                                                                                                                                                                                                                     |
| `prompt`               | Required object `{ parts, final }`. The [prompt answer](#the-prompt-answer) below defines both fields.                                                                                                                                                                                                                                                                                                                        |
| `tools`                | Array of permitted tool declarations; each item has `name: string`, `source` (one of `builtin`, `kanthord-mcp`, `host`) and `input_schema: object`. Project-added tools are inspected through Project configuration instead.                                                                                                                                                                                                  |
| `chain`                | Array of the fallback chain of the enablement: the default configuration, then each `fallback_configurations` entry. Each item holds `position`, `level`, `agent_provider`, `provider`, `credential`, `model_identifier`, `reasoning_effort` and `cooldown`. `cooldown` is `null` or `{ strikes, available_at }` of the hold of the `server` copy of the credential. `[]` when the enablement is absent, disabled or invalid. |
| `active_position`      | The `position` of the first chain entry whose `cooldown` is `null` or ended. `null` when every chain entry has a live cooldown or `chain` is `[]`.                                                                                                                                                                                                                                                                            |
| `cooling`              | `{ code: "agent.configuration.chain_cooling", available_at }` when every chain entry has a live cooldown, with the earliest `available_at` of the chain. Otherwise `null`.                                                                                                                                                                                                                                                    |

The [configuration schema](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#configuration-schema)
is emitted by `z.toJSONSchema` of `zod` at 4.4.3 from the effective-configuration
schema. Its root is an object with `additionalProperties: false` and five required properties:

| Property           | Schema                                                                    |
| ------------------ | ------------------------------------------------------------------------- |
| `agent_provider`   | `string`; name of an agent provider in the enablement                     |
| `provider`         | `string`, enum of every platform of the [platform list](llm.md#platforms) |
| `credential`       | `string`; a credential name                                               |
| `model_identifier` | `string`                                                                  |
| `reasoning_effort` | enum `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`            |

No property carries a `default`; the schema holds no `options`.
Its `description` requires model membership in `getBuiltinModels(provider)` of
pi-ai 1.1.0 or the `models` metadata of the `openai-compatible` credential.
It also requires effort membership in that model's supported reasoning levels.
JSON Schema validates neither lookup. The Agent component enforces them at the
enablement write, at the worker binding write through `validateEntry`, and at
resolution. The registration healthcheck reports whether the effective configuration resolves.

This command inspects a catalog declaration and its global enablement, not the
effective configuration of a bare agent name. Inspect binding entries, effective
configuration and revisions through [Project](./project.md). Project asks the
Worker Service, which resolves that configuration through the Agent component. An absent or disabled enablement refuses
use, including a complete entry; no fallback selects another credential.

An external worker declares no agent and needs no enablement. An unknown agent
name returns `404 agent.catalog.not_found`. Catalog prompt changes require a
new worker version. An enablement default change creates a revision.
This command composes the prompt from the same sources as an execution, but starts no execution.
KanthorD reads no `AGENTS.md`, `CLAUDE.md` or `*.local.md` file of a repository or of a home directory.
`claude-code@1` loads its own `CLAUDE.md` files. That load is behavior of the Claude Code harness, not KanthorD support.

### The prompt answer

`parts` holds the parts of the system prompt in reading order:

1. `standard`: the file `base.md`, for every agent.
2. `role`: the file `<agent-name>.md`, for example `swe@1.md`.
3. `workbench`: the file `workbench.md`, only in the Workbench system prompt.
4. `binding`: one part for each repository binding with a nonblank binding prompt of the agent.

Each part holds the following fields:

| Part field | Type and meaning                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `part`     | One of `standard`, `role`, `workbench` and `binding`.                                                                      |
| `name`     | The file name of a file part, for example `base.md`. The repository name of a `binding` part.                              |
| `origin`   | `binary` for a shipped text, `file` for an override file and `database` for a binding prompt.                              |
| `path`     | The override path that the server looked up, also for `binary`. `null` for `binding`, and when `agent_directory` is empty. |
| `digest`   | The SHA-256 hex digest of `text`.                                                                                          |
| `text`     | The text of the part.                                                                                                      |

A file of the same name in `agent.prompt.agent_directory` replaces the shipped text. The default directory is `<data>/agents` on the server host.
An empty `agent_directory` selects the shipped texts only.
A `binding` part renders as `Instructions of repository <name>:` and the text.
`final` holds every part, then the framing of the [prompt templates](#prompt-templates).
The precedence is framing, then binding, then workbench, then role, then standard. A later text governs an earlier one.
With `--view final`, `parts` is absent.

An override file that is not a regular UTF-8 file, exceeds 32768 bytes or holds a control character answers `409 agent.prompt.template_invalid`.
The details are `{ file, path, reason }`. `file` names the file, for example `swe@1.md`.
The same refusal applies to the execution setup, the Workbench session open and the `env@1` run. No reader falls back to the shipped text.
For `env@1`, the refusal ends the session, and the server logs `project.onboarding.session_failed`. No client receives a 409 there.

### Prompt templates

A file `prompts/<template>.md` in `agent_directory` replaces a shipped template, for example `prompts/framing-worker.md`.
An invalid template answers `409 agent.prompt.template_invalid` with the details `{ template, file, path, reason }`. `file` is `prompts/<template>.md`, for example `prompts/framing-worker.md`.

```sh
kanthord agent get swe@1 --view final
kanthord agent get swe@1 --project project_01ARZ3NDEKTSV4RRFFQ69G5FAV --binding-id binding_01ARZ3NDEKTSV4RRFFQ69G5FAV
```

The binding prompts of a repository binding belong to [Project](./project.md#repository-configuration--proposed-fields).

## Agent enablement record

The [agent configuration rules](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.md#agent-configuration)
own these implemented records and command spellings.
An enablement is global to the server, belongs to no project and is keyed by
`agent_name: AgentName`. It holds:

| Field                     | Type and meaning                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent_name`              | Exact catalog key; no separate enablement identity.                                                                                                                                                                                                                                                                            |
| `state`                   | `enabled` or `disabled`. An absent record also denies use.                                                                                                                                                                                                                                                                     |
| `agent_providers`         | Nonempty array of `{ name, provider, credential }`. Each name is nonblank and unique inside this enablement. `provider` is a platform in the [platform list](llm.md#platforms). `credential` is a credential name in custody; its platform must equal the provider. No model list or secret is stored here.                    |
| `default_configuration`   | Required `{ agent_provider, model_identifier, reasoning_effort }`. The human supplies all three; no catalog default applies. The name selects an agent provider of this enablement.                                                                                                                                            |
| `fallback_configurations` | Required array of at most 7 complete `{ agent_provider, model_identifier, reasoning_effort }` entries. It is the tail of the [fallback chain](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.md#fallback-chain). `[]` means no fallback. Each entry passes the validation of `default_configuration`. |
| `revision`                | Positive safe integer; every change creates a revision.                                                                                                                                                                                                                                                                        |

`model_identifier` is a nonblank string. The reasoning-effort enum is the one in
`configuration_schema`. All request objects are closed. An agent provider's
`provider` is fixed; another provider needs another agent provider. A change of
its `credential` through `put` creates a revision.

The Agent component validates the allowlist before merge and the whole effective
configuration after it, under [configuration validation](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.impl.md#agent-configuration-validation).
It checks the provider catalog or credential metadata and the established
reasoning levels. An empty metadata model list permits no model selection.
It reads metadata through custody, never a secret, and makes no write-time
remote call. An entry holds no `options`.

A configuration change checks every dependent worker binding, including those
without an explicit entry. `entriesOfAgent(tx, agentName)` and
`validateEntry(tx, workerName, entry)` keep that check and the write in one
transaction under the [collaboration contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-operation-and-its-two-entry-adapters).
A change that invalidates a dependent binding fails and lists those bindings.
A tuning entry follows unchanged default fields at its next resolution.

All commands below use `human` access. Required names have no default.
`<agent-name>` maps to `params.agent_name`; `<provider-name>` maps to
`params.provider_name`. Mutations use the shared replay key and print it.
Reads and writes are unary. Unless stated otherwise, query is empty and success
answers HTTP `200` with the enablement record. Reads have no body. Enable,
disable, remove and provider remove send `{ expected_revision }` from
`--expected-revision`; put and provider add use their documented file bodies.

### `enablement list`

Uses `[L] [R]`, no positional arguments and no filters. Query holds `limit` and
optional `cursor`. Returns `{ items, next_cursor }`, paged by agent name in
ascending alphabetical order. It lists records, not catalog agents without an enablement.

### `enablement get <agent-name>`

Uses `[R]`. Returns one enablement. An absent record answers
`404 agent.enablement.not_found`; `agent get` instead returns a null
`enablement` for a catalog agent without a record.

### `enablement put <agent-name> --file <path>`

Uses `[M] [R]`. The required file supplies exactly
`{ expected_revision, agent_providers, default_configuration, fallback_configurations }`.
`agent_providers`, `default_configuration` and `fallback_configurations` are
required with no default. A duplicate `(agent_provider, model_identifier)` inside
`fallback_configurations`, or an entry with the provider and model of
`default_configuration`, answers `400 agent.configuration.fallback_duplicate`. `expected_revision` is
the latest revision of the agent that the human read, and it is absent only when
the agent holds no row. It creates or replaces the complete configuration. Creation
sets `state: enabled`; replacement preserves the record's state. The explicit
`enable` and `disable` commands change that state. Omitted agent providers are
removals and must pass the dependency check. A retained name cannot change its
provider. A credential change is a revision. The answer is the saved record.
The credential of every agent provider in the file must exist in custody with
the platform of its provider; otherwise `put` answers `400`
`agent.configuration.credential_unsuitable`.

### `enablement enable <agent-name> --expected-revision <revision>`

The required `--expected-revision` names the latest revision of the agent that the human read.
Uses `[M] [R]`. Sets an existing record to `enabled` after configuration
validation. It creates no missing record and selects no default value for the
human. It returns the enabled record.

### `enablement disable <agent-name> --expected-revision <revision>`

The required `--expected-revision` names the latest revision of the agent that the human read.
Uses `[M] [R]`. Sets an existing record to `disabled` and returns it.
Disablement is the only stop switch; it is allowed with dependent bindings.
It refuses every later resolution, including a complete entry, so the registration
healthcheck fails and no claim follows. Bindings remain. It recalls no handover
in flight. An agent provider has no independent disablement.

### `enablement remove <agent-name> --expected-revision <revision>`

The required `--expected-revision` names the latest revision of the agent that the human read.
Uses `[M] [R]`. Removal fails while any worker binding of a worker that references
this agent exists. The refusal lists those bindings. The dependency check and
removal commit in one transaction. Success is
`{ agent_name, removed: true }`, not an enablement record. The CLI prints it
with `idempotency_key`.

### `enablement provider add <agent-name> --file <path>`

Uses `[M] [R]`. The required file supplies exactly `{ expected_revision, name, provider, credential }`,
with all fields required. It adds a named agent provider to an existing record
and returns the revised enablement. A duplicate name fails. Use `put` to revise
a credential reference or default configuration.

### `enablement provider remove <agent-name> <provider-name> --expected-revision <revision>`

The required `--expected-revision` names the latest revision of the agent that the human read.
Uses `[M] [R]`. Removes one named agent provider and returns the revised record.
Removal fails while a default configuration or binding entry names it, and the
refusal lists those dependents. The check and removal are atomic. An enablement
must still hold at least one agent provider.

### `enablement provider model list <agent-name> <provider-name>`

Uses `[R]`, no query and no body. Required token: human JWT. The
[model list](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.impl.md#model-list)
is `unary` with `mutation: false`. It reads the agent provider named
`<provider-name>` of the latest enablement record of the agent. HTTP `200` returns
`{ items }`. Each item holds `model_identifier: string` and
`reasoning_efforts: string[]`. A built-in platform lists its pi-ai models with the
supported thinking levels of each model. An `openai-compatible` provider lists the
approved models of its credential with their `reasoning_levels`. Every listed pair
passes the configuration validation. An absent catalog agent, enablement or
provider answers a `404` code of the error table.

### `model list --provider <provider> --credential <credential>`

Uses no positional argument and no body. Required token: human JWT. The
[credential model list](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.impl.md#model-list)
is `unary` with `mutation: false`. The query holds `provider`, an agent provider
kind, and `credential`, a credential name. It needs no enablement. The dashboard
fills the model picker of a new enablement from it. HTTP `200` returns `{ items }`
with the item shape and the sources of `enablement provider model list`. A
credential that does not suit the provider kind answers `400`
`agent.configuration.credential_unsuitable`.

## Cooldown commands

A cooldown belongs to one copy of a credential: the credential name and its holder, `server` or a worker instance. A claim cools and releases the copy of its claimant holder: the instance of the registration at the `worker` placement, else `server`. It cools every model of that copy in
the [fallback chain](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.md#fallback-chain).
A success on any model of the credential releases it. Both commands are `unary` and use
`human` access. The server logs `agent.fallback.cooldown_started` when it writes a
cooldown, and `agent.fallback.cooldown_cleared` when a success or a `cooldown clear`
removes one.

### `cooldown list`

Uses no positional argument, no query and no body. HTTP `200` returns `{ items }`.
Each item holds `credential`, `holder`, `strikes` and `available_at`. The list holds the
copies with `strikes` above 0, live and expired, ordered by credential name and holder.
An entry of the chain is selectable again at `available_at`.

### `cooldown clear <credential> [--holder <name>] [M]`

`<credential>` maps to `params.credential`, and `--holder` maps to the query `holder`, which defaults to `server`. The command sends no body and the
shared replay key. HTTP `204` clears the cooldown and the strikes of the copy, and
the CLI prints `{ idempotency_key }`. The next claim of that holder can select the chain entries
of the credential again. A copy with no cooldown answers
`404 agent.cooldown.not_found` with `details: { credential, holder }`.

## Agent provider healthcheck

Each agent provider has a report-only [resource healthcheck](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.impl.md#agent-provider-healthcheck).
The check calls the [LLM provider check](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/llm.impl.md#the-llm-provider) of its credential, groups calls by credential and attributes each result.
A credential whose platform has no LLM provider reports `unknown`.
This check belongs to neither the liveness answer nor the claim path and changes no registration healthcheck.
No check refreshes OAuth. An expired `openai-codex` or `anthropic-subscription` access token reports `unhealthy`.
The human [provider check](./llm.md#provider-check) belongs to the LLM component.

## Error codes

Every remote command can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP  | Code                                                      | Condition                                                                                                                                                                                                                                                       | Commands                                                                                                                                          |
| ----- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| local | `cli.agent.list.token_required`                           | No option, environment variable or `cli.yaml` supplies a token.                                                                                                                                                                                                 | agent list                                                                                                                                        |
| local | `cli.agent.list.indeterminate`                            | The read result is indeterminate.                                                                                                                                                                                                                               | agent list                                                                                                                                        |
| local | `cli.agent.get.token_required`                            | No option, environment variable or `cli.yaml` supplies a token.                                                                                                                                                                                                 | agent get                                                                                                                                         |
| local | `cli.agent.get.indeterminate`                             | The read result is indeterminate.                                                                                                                                                                                                                               | agent get                                                                                                                                         |
| local | `cli.agent.get.invalid_view`                              | The `--view` value is not `final`.                                                                                                                                                                                                                              | agent get                                                                                                                                         |
| local | `cli.agent.get.project_binding_pair_required`             | One of `--project` and `--binding-id` is present without the other.                                                                                                                                                                                             | agent get                                                                                                                                         |
| local | `cli.agent.cooldown.list.token_required`                  | No option, environment variable or `cli.yaml` supplies a token.                                                                                                                                                                                                 | agent cooldown list                                                                                                                               |
| local | `cli.agent.cooldown.list.indeterminate`                   | The read result is indeterminate.                                                                                                                                                                                                                               | agent cooldown list                                                                                                                               |
| local | `cli.agent.cooldown.clear.token_required`                 | No option, environment variable or `cli.yaml` supplies a token.                                                                                                                                                                                                 | agent cooldown clear                                                                                                                              |
| local | `cli.agent.cooldown.clear.indeterminate`                  | The write result is indeterminate; retry with the same key.                                                                                                                                                                                                     | agent cooldown clear                                                                                                                              |
| 404   | `agent.cooldown.not_found`                                | The copy holds no cooldown; details `{ credential, holder }`.                                                                                                                                                                                                   | agent cooldown clear                                                                                                                              |
| local | `cli.agent.enablement.provider.model.list.token_required` | No option, environment variable or `cli.yaml` supplies a token.                                                                                                                                                                                                 | agent enablement provider model list                                                                                                              |
| local | `cli.agent.enablement.provider.model.list.indeterminate`  | The read result is indeterminate.                                                                                                                                                                                                                               | agent enablement provider model list                                                                                                              |
| local | `cli.agent.model.list.token_required`                     | No option, environment variable or `cli.yaml` supplies a token.                                                                                                                                                                                                 | agent model list                                                                                                                                  |
| local | `cli.agent.model.list.indeterminate`                      | The read result is indeterminate.                                                                                                                                                                                                                               | agent model list                                                                                                                                  |
| local | `cli.agent.model.list.invalid_provider`                   | The `--provider` value is not an agent provider kind.                                                                                                                                                                                                           | agent model list                                                                                                                                  |
| local | `cli.agent.enablement.disable.invalid_revision`           | The `--expected-revision` value is not a positive safe integer.                                                                                                                                                                                                 | agent enablement disable                                                                                                                          |
| local | `cli.agent.enablement.enable.invalid_revision`            | The `--expected-revision` value is not a positive safe integer.                                                                                                                                                                                                 | agent enablement enable                                                                                                                           |
| local | `cli.agent.enablement.provider.remove.invalid_revision`   | The `--expected-revision` value is not a positive safe integer.                                                                                                                                                                                                 | agent enablement provider remove                                                                                                                  |
| local | `cli.agent.enablement.remove.invalid_revision`            | The `--expected-revision` value is not a positive safe integer.                                                                                                                                                                                                 | agent enablement remove                                                                                                                           |
| 400   | `agent.configuration.credential_unsuitable`               | The selected credential is not suitable for the provider.                                                                                                                                                                                                       | binding apply, agent enablement put, agent enablement provider add, agent model list, handover, worker.execution.setup.get (API only)             |
| 400   | `agent.configuration.credential_holder_mismatch`          | A holder of the binding holds no live copy of the credential sealed to its current key. Details: `{ agent, agent_provider, credential, holder }`. An enablement write reports the code in `details.bindings[].code` of `agent.enablement.invalidates_bindings`. | binding apply, agent enablement put                                                                                                               |
| 400   | `agent.configuration.fallback_duplicate`                  | A fallback entry repeats the provider and model of another entry or of the head of its level.                                                                                                                                                                   | agent enablement put, binding apply                                                                                                               |
| 400   | `agent.configuration.invalid`                             | A worker or entry configuration fails shape validation.                                                                                                                                                                                                         | binding apply, agent enablement put, handover, worker.execution.setup.get (API only)                                                              |
| 400   | `agent.configuration.model_unknown`                       | The selected model is absent from the catalog.                                                                                                                                                                                                                  | agent enablement put, binding apply, handover, worker.execution.setup.get (API only)                                                              |
| 400   | `agent.configuration.override_not_allowed`                | An entry overrides a forbidden field.                                                                                                                                                                                                                           | binding apply, handover, worker.execution.setup.get (API only)                                                                                    |
| 400   | `agent.configuration.reasoning_effort_unsupported`        | The selected model does not support this reasoning level.                                                                                                                                                                                                       | agent enablement put, binding apply, handover, worker.execution.setup.get (API only)                                                              |
| 409   | `agent.enablement.in_use`                                 | Worker bindings still use the enablement.                                                                                                                                                                                                                       | agent enablement remove                                                                                                                           |
| 409   | `agent.enablement.invalidates_bindings`                   | The change invalidates dependent bindings.                                                                                                                                                                                                                      | agent enablement put                                                                                                                              |
| 404   | `agent.enablement.not_found`                              | The live enablement does not exist.                                                                                                                                                                                                                             | agent enablement get, agent enablement provider model list, agent enablement mutations                                                            |
| 409   | `agent.enablement.provider.fixed`                         | An edit changes a retained provider.                                                                                                                                                                                                                            | agent enablement put                                                                                                                              |
| 409   | `agent.enablement.provider.in_use`                        | Defaults, fallback entries or binding entries still use this provider.                                                                                                                                                                                          | agent enablement put, agent enablement provider remove                                                                                            |
| 409   | `agent.enablement.provider.name_conflict`                 | An agent provider already uses this name.                                                                                                                                                                                                                       | agent enablement put, agent enablement provider add                                                                                               |
| 409   | `agent.enablement.provider.credential_conflict`           | An agent provider already uses this credential.                                                                                                                                                                                                                 | agent enablement put, agent enablement provider add                                                                                               |
| 404   | `agent.enablement.provider.not_found`                     | The agent provider does not exist.                                                                                                                                                                                                                              | agent enablement put, agent enablement provider remove, agent enablement provider model list, binding apply                                       |
| 400   | `agent.enablement.provider.required`                      | The write leaves no agent provider.                                                                                                                                                                                                                             | agent enablement provider remove                                                                                                                  |
| 409   | `agent.enablement.revision_conflict`                      | The expected enablement revision is stale.                                                                                                                                                                                                                      | agent enablement mutations                                                                                                                        |
| 400   | `agent.enablement.unavailable`                            | The agent lacks a live enabled configuration.                                                                                                                                                                                                                   | binding apply, agent configuration reads, handover, worker.execution.setup.get (API only)                                                         |
| 404   | `agent.catalog.not_found`                                 | The agent name is absent from the agent catalog.                                                                                                                                                                                                                | agent enablement put, agent enablement enable, agent enablement disable, agent enablement remove, agent enablement provider model list, agent get |
| 404   | `project.binding.not_found`                               | The `--binding-id` value names no repository binding of the `--project` value.                                                                                                                                                                                  | agent get                                                                                                                                         |
| 409   | `agent.prompt.template_invalid`                           | An override file or a prompt template is invalid; details `{ file, path, reason }`, and `template` for a template.                                                                                                                                              | agent get                                                                                                                                         |
| 400   | `gateway.request.validation_failed`                       | The request violates the input schema, for example a `view` value other than `final`.                                                                                                                                                                           | agent get                                                                                                                                         |

`error.details` names the agent and lists affected bindings or other dependents when applicable. No error holds secret material.

## Design provenance

Optional design provenance:
[Agent design](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.md),
[Agent vocabulary](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.vocabulary.md),
[Agent implementation rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.impl.md)
and [open handoff](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md).
