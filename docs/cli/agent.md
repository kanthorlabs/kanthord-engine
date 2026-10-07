# Agent CLI specification

This specification for `kanthord agent` contains **15 command leaves: 14 implemented and 1 proposed**.

See the [CLI index](./README.md) for shared conventions.
Agent entries of a worker binding belong to [Project](./project.md).
[Worker](./worker.md) covers the worker catalog, which names the agent of each native worker.
[LLM](./llm.md) covers credential management of LLM platforms.

## Shared input and output contract

The request, output, failure and replay rules of the [Worker shared contract](./worker.md#shared-input-and-output-contract) apply.

| Common flag                                                                      | Applies to / Agent requirement                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`--endpoint`](./common-flags.md#--endpoint)                                     | Every command; inherited from the `agent` group.                                                 |
| [`--token`](./common-flags.md#--token)                                           | Every operation requires a nonblank resolved human token.                                        |
| [`--idempotency-key`](./common-flags.md#--idempotency-key)                       | Mutations only.                                                                                  |
| [`--limit`](./common-flags.md#--limit), [`--cursor`](./common-flags.md#--cursor) | Each list command.                                                                               |
| [`--file`](./common-flags.md#--file)                                             | Required for `enablement put`, `enablement provider add` and `prompt put`; schemas appear below. |
| [`--help`](./common-flags.md#--help)                                             | Every group and leaf.                                                                            |

`AgentName` and `WorkerName` follow the [Worker names and identities](./worker.md#names-and-identities).

## Command inventory

`P` means proposed; `I` means implemented syntax and operation. `[R]`, `[M]` and `[L]` use the [common synopsis definitions](./common-flags.md#synopsis-markers).
`human` authenticates a human JWT.

| Status | Command after `kanthord agent`                                                                                                                               | Route                                                                 | Operation ID                           | Access  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------- | ------- |
| P      | `list [L]`                                                                                                                                                   | `GET /api/agent`                                                      | `agent.list`                           | `human` |
| I      | `get <agent-name> [--view final] [--project <project-id> --binding <binding-id>]`                                                                            | `GET /api/agent/:agent_name`                                          | `agent.get`                            | `human` |
| I      | `enablement list [L] [R]`                                                                                                                                    | `GET /api/agent/enablement`                                           | `agent.enablement.list`                | `human` |
| I      | `enablement get <agent-name> [R]`                                                                                                                            | `GET /api/agent/enablement/:agent_name`                               | `agent.enablement.get`                 | `human` |
| I      | `enablement put <agent-name> --file <path> [M] [R]`                                                                                                          | `PUT /api/agent/enablement/:agent_name`                               | `agent.enablement.put`                 | `human` |
| I      | `enablement enable <agent-name> --expected-revision <revision> [M] [R]`                                                                                      | `POST /api/agent/enablement/:agent_name/enable`                       | `agent.enablement.enable`              | `human` |
| I      | `enablement disable <agent-name> --expected-revision <revision> [M] [R]`                                                                                     | `POST /api/agent/enablement/:agent_name/disable`                      | `agent.enablement.disable`             | `human` |
| I      | `enablement remove <agent-name> --expected-revision <revision> [M] [R]`                                                                                      | `DELETE /api/agent/enablement/:agent_name`                            | `agent.enablement.remove`              | `human` |
| I      | `enablement provider add <agent-name> --file <path> [M] [R]`                                                                                                 | `POST /api/agent/enablement/:agent_name/provider`                     | `agent.enablement.provider.add`        | `human` |
| I      | `enablement provider remove <agent-name> <provider-name> --expected-revision <revision> [M] [R]`                                                             | `DELETE /api/agent/enablement/:agent_name/provider/:provider_name`    | `agent.enablement.provider.remove`     | `human` |
| I      | `enablement provider model list <agent-name> <provider-name>`                                                                                                | `GET /api/agent/enablement/:agent_name/provider/:provider_name/model` | `agent.enablement.provider.model.list` | `human` |
| I      | `model list --provider <provider> --credential <credential>`                                                                                                 | `GET /api/agent/model`                                                | `agent.model.list`                     | `human` |
| I      | `prompt put --scope <scope> [--agent <agent-name>] [--expected-revision <revision>] --file <path> [M]`                                                       | `PUT /api/agent/prompt`                                               | `agent.prompt.put`                     | `human` |
| I      | `prompt get --scope <scope> [--agent <agent-name>]`                                                                                                          | `GET /api/agent/prompt`                                               | `agent.prompt.get`                     | `human` |
| I      | `prompt switch --scope <scope> [--agent <agent-name>] [--expected-revision <revision>] (--switch <source> (--on \| --off) \| --system-layer <override>) [M]` | `POST /api/agent/prompt/switch`                                       | `agent.prompt.switch`                  | `human` |

The static `/api/agent/enablement` path takes precedence over `/:agent_name`.

The two catalog reads follow [the agent catalog](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.impl.md#the-agent-catalog).
Each is `unary`, has `mutation: false` and a default timeout of 30 s.

## Catalog and enablement commands

### `list`

This command remains proposed. It uses `[L]`, no positional arguments and no filters.
Required token: human JWT. Query holds `limit` and optional `cursor`. Returns
`{ items, next_cursor }`, paged by `agent_name` in ascending alphabetical order.
It lists every catalog agent, also an agent without an enablement. Each item holds
`agent_name: AgentName`, `worker_names: WorkerName[]` and `enablement`, the
[agent enablement record](#agent-enablement-record) or `null` when no record exists.

### `get <agent-name>`

```text
kanthord agent get <agent-name> [--view final] [--project <project-id> --binding <binding-id>]
```

`agent-name` is required `AgentName`, with no default, and maps to
`params.agent_name`. The key names one catalog declaration, not a worker binding.
Required token: human JWT. Absent body. HTTP `200` returns
`agent_name` and the following declaration/configuration fields:

| Option                   | Query        | Meaning                                                                                                                                       |
| ------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--view final`           | `view`       | Optional. The only value is `final`. The `prompt` answer holds `final` only and no `layers`.                                                  |
| `--project <project-id>` | `project_id` | Optional, and only together with `--binding`. Selects the repository binding of the working layer.                                            |
| `--binding <binding-id>` | `binding_id` | Optional, and only together with `--project`. A binding that is no repository binding of the project answers `404 project.binding.not_found`. |

Without `--project` and `--binding`, the working layer is the workbench working layer of the agent.

| Result field           | Type and meaning                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configuration_schema` | JSON Schema draft 2020-12 object describing the effective configuration: every allowed field, its type, requiredness and enumeration. Its `description` states the whole-configuration constraint that the Agent component checks; JSON Schema validates no cross-field lookup. |
| `overridable_fields`   | Array of field paths allowed in a Project override; no wildcard permission to add fields. For `swe@1` and `re@1` it is `["agent_provider", "model_identifier", "reasoning_effort"]`.                                                                                            |
| `enablement`           | The [agent enablement record](#agent-enablement-record), or `null` when no record exists.                                                                                                                                                                                       |
| `prompt`               | Required object `{ layers, final }`. The [prompt answer](#the-prompt-answer) below defines both fields.                                                                                                                                                                         |
| `tools`                | Array of permitted tool declarations; each item has `name: string`, `source` (one of `builtin`, `kanthord-mcp`, `host`) and `input_schema: object`. Project-added tools are inspected through Project configuration instead.                                                    |

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
pi-ai 0.86.0 or the `models` metadata of the `openai-compatible` credential.
It also requires effort membership in that model's supported reasoning levels.
JSON Schema validates neither lookup. The Agent component enforces them at the
enablement write, at the worker binding write through `validateEntry`, and at
resolution. The instance healthcheck reports whether the effective configuration resolves.

This command inspects a catalog declaration and its global enablement, not the
effective configuration of a bare agent name. Inspect binding entries, effective
configuration and revisions through [Project](./project.md). Project asks the
Worker Service, which resolves that configuration through the Agent component. An absent or disabled enablement refuses
use, including a complete entry; no fallback selects another credential.

An external worker declares no agent and needs no enablement. An unknown agent
name returns `404 agent.catalog.not_found`. Catalog prompt changes require a
new worker version. An enablement default change creates a revision.
This command neither composes the prompt of an execution nor
reads a local `AGENTS.md`/`CLAUDE.md`. Each prompt source holds at most 32768 UTF-8 bytes under the [Worker implementation](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md).

### The prompt answer

`layers` holds the system layer, the agent layer and the working layer, in reading order.
Each item holds `{ layer, sources }`, and `layer` is `system`, `agent` or `working`.
Each source holds the following fields:

| Source field | Type and meaning                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`     | The source name, for example `host_file`, `base`, `custom`, `agent_file`, `shipped` or `agents_md`.                                                  |
| `origin`     | One of `binary`, `file` and `database`.                                                                                                              |
| `path`       | The home-relative path of a `file` source, else `null`.                                                                                              |
| `enabled`    | The boolean switch of the source.                                                                                                                    |
| `state`      | One of `present`, `absent`, `invalid`, `off` and `deferred`. `deferred` marks an agent file of a workspace, which only the worker application reads. |
| `digest`     | The digest of the text when `state` is `present`, else `null`.                                                                                       |
| `text`       | The text of the source when `state` is `present`, else `null`.                                                                                       |

`final` holds the system prompt that ends with the framing, then the message of every `present` source of the working layer, in reading order.
With `--view final`, `layers` is absent.

```sh
kanthord agent get swe@1 --view final
kanthord agent get swe@1 --project project_01ARZ3NDEKTSV4RRFFQ69G5FAV --binding binding_01ARZ3NDEKTSV4RRFFQ69G5FAV
```

## Prompt settings commands

The system layer holds the sources `host_file`, `base` and `custom`, and the layer switch `layer`.
The agent layer holds `agent_file`, `shipped` and `custom`.
The workbench working layer holds `agents_md`, `agents_local_md`, `claude_md`, `claude_local_md`, `shipped` and `custom`.
The settings of a scope are `{ scope, agent_name, switches, custom_text, system_layer, revision }`.
`system_layer` is the system layer override of an `agent` scope: `inherit`, `on` or `off`. It is `null` for another scope.
`inherit` takes the `layer` switch of the system scope. `on` and `off` decide the system layer of that agent only.

### `prompt get --scope <scope> [--agent <agent-name>]`

Uses `[R]`. `--scope` and `--agent` follow `prompt put`. The command answers the settings of the scope.
An absent row answers every switch on, an empty custom text, `revision` 0 and, for an `agent` scope, `system_layer` `inherit`.

```sh
kanthord agent prompt get --scope agent --agent swe@1
```

The working switches of a repository binding belong to [Project](./project.md#binding-resource-and-complete-set-edits).

### `prompt put --scope <scope> [--agent <agent-name>] [--expected-revision <revision>] --file <path>`

Uses `[M] [R]`. `--scope` is required and is `system`, `agent` or `workbench`.
`--agent` is required for `agent` and `workbench` and refused for `system`.
`--expected-revision` is the revision that the human read. Omit it only when the scope has no row.
`--file` names a UTF-8 text file with the new custom text. The command refuses `-` and any directory.
The custom text holds at most 32768 UTF-8 bytes.
The command replaces the custom text and answers the saved settings with the `idempotency_key`.

```sh
kanthord agent prompt put --scope system --file system.md
kanthord agent prompt put --scope agent --agent swe@1 --expected-revision 1 --file swe.md
```

### `prompt switch --scope <scope> [--agent <agent-name>] [--expected-revision <revision>] (--switch <source> (--on | --off) | --system-layer <override>)`

Uses `[M] [R]`. `--scope`, `--agent` and `--expected-revision` follow `prompt put`.
Exactly one of `--switch` and `--system-layer` is required.
`--switch` names one source of the scope, or `layer` for the system scope. Exactly one of `--on` and `--off` is required with it.
`--system-layer` is `inherit`, `on` or `off`, and only the `agent` scope takes it.
A switch that turns off every source of an `agent` scope answers `409 agent.prompt.agent_layer_empty`.
The command answers the saved settings with the `idempotency_key`.

```sh
kanthord agent prompt switch --scope system --switch host_file --off
kanthord agent prompt switch --scope workbench --agent swe@1 --expected-revision 2 --switch claude_md --on
kanthord agent prompt switch --scope system --expected-revision 3 --switch layer --off
kanthord agent prompt switch --scope agent --agent swe@1 --expected-revision 1 --system-layer on
```

## Agent enablement record

The [agent configuration rules](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.md#agent-configuration)
own these implemented records and command spellings.
An enablement is global to the server, belongs to no project and is keyed by
`agent_name: AgentName`. It holds:

| Field                   | Type and meaning                                                                                                                                                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_name`            | Exact catalog key; no separate enablement identity.                                                                                                                                                                                                                                                         |
| `state`                 | `enabled` or `disabled`. An absent record also denies use.                                                                                                                                                                                                                                                  |
| `agent_providers`       | Nonempty array of `{ name, provider, credential }`. Each name is nonblank and unique inside this enablement. `provider` is a platform in the [platform list](llm.md#platforms). `credential` is a credential name in custody; its platform must equal the provider. No model list or secret is stored here. |
| `default_configuration` | Required `{ agent_provider, model_identifier, reasoning_effort }`. The human supplies all three; no catalog default applies. The name selects an agent provider of this enablement.                                                                                                                         |
| `revision`              | Positive safe integer; every change creates a revision.                                                                                                                                                                                                                                                     |

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
`{ expected_revision, agent_providers, default_configuration }`. `agent_providers`
and `default_configuration` are required with no default. `expected_revision` is
the latest revision of the agent that the human read, and it is absent only when
the agent holds no row. It creates or replaces the complete configuration. Creation
sets `state: enabled`; replacement preserves the record's state. The explicit
`enable` and `disable` commands change that state. Omitted agent providers are
removals and must pass the dependency check. A retained name cannot change its
provider. A credential change is a revision. The answer is the saved record.

### `enablement enable <agent-name> --expected-revision <revision>`

The required `--expected-revision` names the latest revision of the agent that the human read.
Uses `[M] [R]`. Sets an existing record to `enabled` after configuration
validation. It creates no missing record and selects no default value for the
human. It returns the enabled record.

### `enablement disable <agent-name> --expected-revision <revision>`

The required `--expected-revision` names the latest revision of the agent that the human read.
Uses `[M] [R]`. Sets an existing record to `disabled` and returns it.
Disablement is the only stop switch; it is allowed with dependent bindings.
It refuses every later resolution, including a complete entry, so the instance
healthcheck fails and no claim follows. Bindings remain. It recalls no handover
in flight. An agent provider has no independent disablement.

### `enablement remove <agent-name> --expected-revision <revision>`

The required `--expected-revision` names the latest revision of the agent that the human read.
Uses `[M] [R]`. Removal fails while any worker binding of a worker that references
this agent exists. The refusal lists those bindings. The dependency check and
removal commit in one transaction. Success is
`{ agent_name, removed: true }`, not an enablement record.

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

## Agent provider healthcheck

Each agent provider has a report-only [resource healthcheck](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.impl.md#agent-provider-healthcheck).
The check calls the [LLM provider check](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/llm.impl.md#the-llm-provider) of its credential, groups calls by credential and attributes each result.
A credential whose platform has no LLM provider reports `unknown`.
This check belongs to neither the liveness answer nor the claim path and changes no instance healthcheck.
No check refreshes OAuth; an expired access token reports `unknown`.
The human [provider check](./llm.md#provider-check) belongs to the LLM component.

## Error codes

Every remote command can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP  | Code                                                      | Condition                                                                                   | Commands                                                                                                                                                                                                                         |
| ----- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| local | `cli.agent.list.token_required`                           | No option, environment variable or `cli.yaml` supplies a token.                             | agent list                                                                                                                                                                                                                       |
| local | `cli.agent.list.indeterminate`                            | The read result is indeterminate.                                                           | agent list                                                                                                                                                                                                                       |
| local | `cli.agent.get.token_required`                            | No option, environment variable or `cli.yaml` supplies a token.                             | agent get                                                                                                                                                                                                                        |
| local | `cli.agent.get.indeterminate`                             | The read result is indeterminate.                                                           | agent get                                                                                                                                                                                                                        |
| local | `cli.agent.get.invalid_view`                              | The `--view` value is not `final`.                                                          | agent get                                                                                                                                                                                                                        |
| local | `cli.agent.get.project_binding_pair_required`             | One of `--project` and `--binding` is present without the other.                            | agent get                                                                                                                                                                                                                        |
| local | `cli.agent.prompt.put.token_required`                     | No option, environment variable or `cli.yaml` supplies a token.                             | agent prompt put                                                                                                                                                                                                                 |
| local | `cli.agent.prompt.put.indeterminate`                      | The write result is indeterminate; retry with the same key.                                 | agent prompt put                                                                                                                                                                                                                 |
| local | `cli.agent.prompt.put.invalid_scope`                      | The `--scope` value is not `system`, `agent` or `workbench`.                                | agent prompt put                                                                                                                                                                                                                 |
| local | `cli.agent.prompt.put.agent_required`                     | The scope is `agent` or `workbench` and `--agent` is absent.                                | agent prompt put                                                                                                                                                                                                                 |
| local | `cli.agent.prompt.put.agent_refused`                      | The scope is `system` and `--agent` is present.                                             | agent prompt put                                                                                                                                                                                                                 |
| local | `cli.agent.prompt.put.invalid_revision`                   | The `--expected-revision` value is not a positive safe integer.                             | agent prompt put                                                                                                                                                                                                                 |
| local | `cli.agent.prompt.switch.token_required`                  | No option, environment variable or `cli.yaml` supplies a token.                             | agent prompt switch                                                                                                                                                                                                              |
| local | `cli.agent.prompt.switch.indeterminate`                   | The write result is indeterminate; retry with the same key.                                 | agent prompt switch                                                                                                                                                                                                              |
| local | `cli.agent.prompt.switch.invalid_scope`                   | The `--scope` value is not `system`, `agent` or `workbench`.                                | agent prompt switch                                                                                                                                                                                                              |
| local | `cli.agent.prompt.switch.agent_required`                  | The scope is `agent` or `workbench` and `--agent` is absent.                                | agent prompt switch                                                                                                                                                                                                              |
| local | `cli.agent.prompt.switch.agent_refused`                   | The scope is `system` and `--agent` is present.                                             | agent prompt switch                                                                                                                                                                                                              |
| local | `cli.agent.prompt.switch.invalid_revision`                | The `--expected-revision` value is not a positive safe integer.                             | agent prompt switch                                                                                                                                                                                                              |
| local | `cli.agent.prompt.switch.invalid_switch`                  | The `--switch` value is not a source of the scope.                                          | agent prompt switch                                                                                                                                                                                                              |
| local | `cli.agent.prompt.switch.state_required`                  | The command holds none or both of `--on` and `--off`.                                       | agent prompt switch                                                                                                                                                                                                              |
| local | `cli.agent.prompt.switch.target_required`                 | The command holds none or both of `--switch` and `--system-layer`.                          | agent prompt switch                                                                                                                                                                                                              |
| local | `cli.agent.prompt.switch.invalid_system_layer`            | The `--system-layer` value is not `inherit`, `on` or `off`, or the scope is not `agent`.    | agent prompt switch                                                                                                                                                                                                              |
| local | `cli.agent.prompt.get.token_required`                     | No option, environment variable or `cli.yaml` supplies a token.                             | agent prompt get                                                                                                                                                                                                                 |
| local | `cli.agent.prompt.get.indeterminate`                      | The read result is indeterminate.                                                           | agent prompt get                                                                                                                                                                                                                 |
| local | `cli.agent.prompt.get.invalid_scope`                      | The `--scope` value is not `system`, `agent` or `workbench`.                                | agent prompt get                                                                                                                                                                                                                 |
| local | `cli.agent.prompt.get.agent_required`                     | The scope is `agent` or `workbench` and `--agent` is absent.                                | agent prompt get                                                                                                                                                                                                                 |
| local | `cli.agent.prompt.get.agent_refused`                      | The scope is `system` and `--agent` is present.                                             | agent prompt get                                                                                                                                                                                                                 |
| local | `cli.agent.enablement.provider.model.list.token_required` | No option, environment variable or `cli.yaml` supplies a token.                             | agent enablement provider model list                                                                                                                                                                                             |
| local | `cli.agent.enablement.provider.model.list.indeterminate`  | The read result is indeterminate.                                                           | agent enablement provider model list                                                                                                                                                                                             |
| local | `cli.agent.model.list.token_required`                     | No option, environment variable or `cli.yaml` supplies a token.                             | agent model list                                                                                                                                                                                                                 |
| local | `cli.agent.model.list.indeterminate`                      | The read result is indeterminate.                                                           | agent model list                                                                                                                                                                                                                 |
| local | `cli.agent.model.list.invalid_provider`                   | The `--provider` value is not an agent provider kind.                                       | agent model list                                                                                                                                                                                                                 |
| local | `cli.agent.enablement.disable.invalid_revision`           | The `<expected-revision>` argument is not a positive safe integer.                          | agent enablement disable                                                                                                                                                                                                         |
| local | `cli.agent.enablement.enable.invalid_revision`            | The `<expected-revision>` argument is not a positive safe integer.                          | agent enablement enable                                                                                                                                                                                                          |
| local | `cli.agent.enablement.provider.remove.invalid_revision`   | The `<expected-revision>` argument is not a positive safe integer.                          | agent enablement provider remove                                                                                                                                                                                                 |
| local | `cli.agent.enablement.remove.invalid_revision`            | The `<expected-revision>` argument is not a positive safe integer.                          | agent enablement remove                                                                                                                                                                                                          |
| 400   | `agent.configuration.credential_unsuitable`               | The selected credential is not suitable for the provider.                                   | binding apply, agent enablement put, agent enablement provider add, agent model list, handover, worker.execution.setup.get (API only)                                                                                            |
| 400   | `agent.configuration.invalid`                             | A worker or entry configuration fails shape validation.                                     | binding apply, agent enablement put, handover, worker.execution.setup.get (API only)                                                                                                                                             |
| 400   | `agent.configuration.model_unknown`                       | The selected model is absent from the catalog.                                              | agent enablement put, binding apply, handover, worker.execution.setup.get (API only)                                                                                                                                             |
| 400   | `agent.configuration.override_not_allowed`                | An entry overrides a forbidden field.                                                       | binding apply, handover, worker.execution.setup.get (API only)                                                                                                                                                                   |
| 400   | `agent.configuration.reasoning_effort_unsupported`        | The selected model does not support this reasoning level.                                   | agent enablement put, binding apply, handover, worker.execution.setup.get (API only)                                                                                                                                             |
| 409   | `agent.enablement.in_use`                                 | Worker bindings still use the enablement.                                                   | agent enablement remove                                                                                                                                                                                                          |
| 409   | `agent.enablement.invalidates_bindings`                   | The change invalidates dependent bindings.                                                  | agent enablement put                                                                                                                                                                                                             |
| 404   | `agent.enablement.not_found`                              | The live enablement does not exist.                                                         | agent enablement get, agent enablement provider model list, agent enablement mutations                                                                                                                                           |
| 409   | `agent.enablement.provider.fixed`                         | An edit changes a retained provider.                                                        | agent enablement put                                                                                                                                                                                                             |
| 409   | `agent.enablement.provider.in_use`                        | Defaults or entries still use this provider.                                                | agent enablement put, agent enablement provider remove                                                                                                                                                                           |
| 409   | `agent.enablement.provider.name_conflict`                 | An agent provider already uses this name.                                                   | agent enablement put, agent enablement provider add                                                                                                                                                                              |
| 409   | `agent.enablement.provider.credential_conflict`           | An agent provider already uses this credential.                                             | agent enablement put, agent enablement provider add                                                                                                                                                                              |
| 404   | `agent.enablement.provider.not_found`                     | The agent provider does not exist.                                                          | agent enablement put, agent enablement provider remove, agent enablement provider model list, binding apply                                                                                                                      |
| 400   | `agent.enablement.provider.required`                      | The write leaves no agent provider.                                                         | agent enablement put, agent enablement provider remove                                                                                                                                                                           |
| 409   | `agent.enablement.revision_conflict`                      | The expected enablement revision is stale.                                                  | agent enablement mutations                                                                                                                                                                                                       |
| 400   | `agent.enablement.unavailable`                            | The agent lacks a live enabled configuration.                                               | binding apply, agent configuration reads, handover, worker.execution.setup.get (API only)                                                                                                                                        |
| 404   | `agent.catalog.not_found`                                 | The agent name is absent from the agent catalog.                                            | agent enablement get, agent enablement put, agent enablement enable, agent enablement disable, agent enablement remove, agent enablement provider model list, agent get, agent prompt get, agent prompt put, agent prompt switch |
| 409   | `agent.prompt.revision_conflict`                          | The expected revision is stale or absent; `details.current` holds the current row.          | agent prompt put, agent prompt switch                                                                                                                                                                                            |
| 400   | `agent.prompt.too_large`                                  | The custom text exceeds 32768 UTF-8 bytes.                                                  | agent prompt put                                                                                                                                                                                                                 |
| 409   | `agent.prompt.agent_layer_empty`                          | The switch turns off every source of an `agent` scope.                                      | agent prompt switch                                                                                                                                                                                                              |
| 404   | `project.binding.not_found`                               | The `--binding` value names no repository binding of the `--project` value.                 | agent get                                                                                                                                                                                                                        |
| 400   | `gateway.request.validation_failed`                       | The request violates the input schema, for example a switch that is no source of the scope. | agent get, agent prompt get, agent prompt put, agent prompt switch                                                                                                                                                               |

`error.details` names the agent and lists affected bindings or other dependents when applicable. No error holds secret material.

## Design provenance

Optional design provenance:
[Agent design](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.md),
[Agent vocabulary](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.vocabulary.md),
[Agent implementation rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.impl.md)
and [open handoff](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md).
