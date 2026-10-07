# Agent CLI specification

This specification for `kanthord agent` contains **11 command leaves: 10 implemented and 1 proposed**.

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

| Status | Command after `kanthord agent`                                                                   | Route                                                               | Operation ID                           | Access  |
| ------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------- | ------- |
| P      | `list [L]`                                                                                       | `GET /api/agent`                                                    | `agent.list`                           | `human` |
| I      | `get <agent-name>`                                                                               | `GET /api/agent/:agentName`                                         | `agent.get`                            | `human` |
| I      | `enablement list [L] [R]`                                                                        | `GET /api/agent/enablement`                                         | `agent.enablement.list`                | `human` |
| I      | `enablement get <agent-name> [R]`                                                                | `GET /api/agent/enablement/:agentName`                              | `agent.enablement.get`                 | `human` |
| I      | `enablement put <agent-name> --file <path> [M] [R]`                                              | `PUT /api/agent/enablement/:agentName`                              | `agent.enablement.put`                 | `human` |
| I      | `enablement enable <agent-name> --expected-revision <revision> [M] [R]`                          | `POST /api/agent/enablement/:agentName/enable`                      | `agent.enablement.enable`              | `human` |
| I      | `enablement disable <agent-name> --expected-revision <revision> [M] [R]`                         | `POST /api/agent/enablement/:agentName/disable`                     | `agent.enablement.disable`             | `human` |
| I      | `enablement remove <agent-name> --expected-revision <revision> [M] [R]`                          | `DELETE /api/agent/enablement/:agentName`                           | `agent.enablement.remove`              | `human` |
| I      | `enablement provider add <agent-name> --file <path> [M] [R]`                                     | `POST /api/agent/enablement/:agentName/provider`                    | `agent.enablement.provider.add`        | `human` |
| I      | `enablement provider remove <agent-name> <provider-name> --expected-revision <revision> [M] [R]` | `DELETE /api/agent/enablement/:agentName/provider/:providerName`    | `agent.enablement.provider.remove`     | `human` |
| I      | `enablement provider model list <agent-name> <provider-name>`                                    | `GET /api/agent/enablement/:agentName/provider/:providerName/model` | `agent.enablement.provider.model.list` | `human` |

The static `/api/agent/enablement` path takes precedence over `/:agentName`.

The two catalog reads follow [the agent catalog](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.impl.md#the-agent-catalog).
Each is `unary`, has `mutation: false` and a default timeout of 30 s.

## Catalog and enablement commands

### `list`

This command remains proposed. It uses `[L]`, no positional arguments and no filters.
Required token: human JWT. Query holds `limit` and optional `cursor`. Returns
`{ items, nextCursor }`, paged by `agentName` in ascending alphabetical order.
It lists every catalog agent, also an agent without an enablement. Each item holds
`agentName: AgentName`, `workerNames: WorkerName[]` and `enablement`, the
[agent enablement record](#agent-enablement-record) or `null` when no record exists.

### `get <agent-name>`

```text
kanthord agent get <agent-name>
```

`agent-name` is required `AgentName`, with no default, and maps to
`params.agentName`. The key names one catalog declaration, not a worker binding.
Required token: human JWT. Empty query, absent body. HTTP `200` returns
`agentName` and the following declaration/configuration fields:

| Result field          | Type and meaning                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configurationSchema` | JSON Schema draft 2020-12 object describing the effective configuration: every allowed field, its type, requiredness and enumeration. Its `description` states the whole-configuration constraint that the Agent component checks; JSON Schema validates no cross-field lookup. |
| `overridableFields`   | Array of field paths allowed in a Project override; no wildcard permission to add fields. For `swe@1` and `re@1` it is `["agentProvider", "modelIdentifier", "reasoningEffort"]`.                                                                                               |
| `enablement`          | The [agent enablement record](#agent-enablement-record), or `null` when no record exists.                                                                                                                                                                                       |
| `basePrompt`          | Optional string; the exact worker-declared shared prompt, omitted if absent.                                                                                                                                                                                                    |
| `agentPrompt`         | Required string; exact worker-declared role prompt.                                                                                                                                                                                                                             |
| `tools`               | Array of permitted tool declarations; each item has `name: string`, `source` (one of `builtin`, `kanthord-mcp`, `host`) and `inputSchema: object`. Project-added tools are inspected through Project configuration instead.                                                     |

The [configuration schema](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#configuration-schema)
is emitted by `z.toJSONSchema` of `zod` at 4.4.3 from the effective-configuration
schema. Its root is an object with `additionalProperties: false` and five required properties:

| Property          | Schema                                                                    |
| ----------------- | ------------------------------------------------------------------------- |
| `agentProvider`   | `string`; name of an agent provider in the enablement                     |
| `provider`        | `string`, enum of every platform of the [platform list](llm.md#platforms) |
| `credential`      | `string`; a credential name                                               |
| `modelIdentifier` | `string`                                                                  |
| `reasoningEffort` | enum `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`            |

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
reads a local `AGENTS.md`/`CLAUDE.md`. The [Worker configuration](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#configuration) declares `worker.globalPrompt`.
Each global prompt source and project prompt source holds at most 32768 UTF-8 bytes under the [Worker implementation](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md).

## Agent enablement record

The [agent configuration rules](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.md#agent-configuration)
own these implemented records and command spellings.
An enablement is global to the server, belongs to no project and is keyed by
`agentName: AgentName`. It holds:

| Field                  | Type and meaning                                                                                                                                                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentName`            | Exact catalog key; no separate enablement identity.                                                                                                                                                                                                                                                         |
| `state`                | `enabled` or `disabled`. An absent record also denies use.                                                                                                                                                                                                                                                  |
| `agentProviders`       | Nonempty array of `{ name, provider, credential }`. Each name is nonblank and unique inside this enablement. `provider` is a platform in the [platform list](llm.md#platforms). `credential` is a credential name in custody; its platform must equal the provider. No model list or secret is stored here. |
| `defaultConfiguration` | Required `{ agentProvider, modelIdentifier, reasoningEffort }`. The human supplies all three; no catalog default applies. The name selects an agent provider of this enablement.                                                                                                                            |
| `revision`             | Positive safe integer; every change creates a revision.                                                                                                                                                                                                                                                     |

`modelIdentifier` is a nonblank string. The reasoning-effort enum is the one in
`configurationSchema`. All request objects are closed. An agent provider's
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
`<agent-name>` maps to `params.agentName`; `<provider-name>` maps to
`params.providerName`. Mutations use the shared replay key and print it.
Reads and writes are unary. Unless stated otherwise, query is empty and success
answers HTTP `200` with the enablement record. Reads have no body. Enable,
disable, remove and provider remove send `{ expectedRevision }` from
`--expected-revision`; put and provider add use their documented file bodies.

### `enablement list`

Uses `[L] [R]`, no positional arguments and no filters. Query holds `limit` and
optional `cursor`. Returns `{ items, nextCursor }`, paged by agent name in
ascending alphabetical order. It lists records, not catalog agents without an enablement.

### `enablement get <agent-name>`

Uses `[R]`. Returns one enablement. An absent record answers
`404 agent.enablement.not_found`; `agent get` instead returns a null
`enablement` for a catalog agent without a record.

### `enablement put <agent-name> --file <path>`

Uses `[M] [R]`. The required file supplies exactly
`{ expectedRevision, agentProviders, defaultConfiguration }`. `agentProviders`
and `defaultConfiguration` are required with no default. `expectedRevision` is
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
`{ agentName, removed: true }`, not an enablement record.

### `enablement provider add <agent-name> --file <path>`

Uses `[M] [R]`. The required file supplies exactly `{ expectedRevision, name, provider, credential }`,
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
`{ items }`. Each item holds `modelIdentifier: string` and
`reasoningEfforts: string[]`. A built-in platform lists its pi-ai models with the
supported thinking levels of each model. An `openai-compatible` provider lists the
approved models of its credential with their `reasoningLevels`. Every listed pair
passes the configuration validation. An absent catalog agent, enablement or
provider answers a `404` code of the error table.

## Agent provider healthcheck

Each agent provider has a report-only [resource healthcheck](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.impl.md#agent-provider-healthcheck).
The check calls the [LLM provider check](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/llm.impl.md#the-llm-provider) of its credential, groups calls by credential and attributes each result.
A credential whose platform has no LLM provider reports `unknown`.
This check belongs to neither the liveness answer nor the claim path and changes no instance healthcheck.
No check refreshes OAuth; an expired access token reports `unknown`.
The human [provider check](./llm.md#provider-check) belongs to the LLM component.

## Error codes

Every remote command can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP  | Code                                                      | Condition                                                          | Commands                                                                                                                                                                |
| ----- | --------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| local | `cli.agent.list.token_required`                           | No option, environment variable or `cli.yaml` supplies a token.    | agent list                                                                                                                                                              |
| local | `cli.agent.list.indeterminate`                            | The read result is indeterminate.                                  | agent list                                                                                                                                                              |
| local | `cli.agent.get.token_required`                            | No option, environment variable or `cli.yaml` supplies a token.    | agent get                                                                                                                                                               |
| local | `cli.agent.get.indeterminate`                             | The read result is indeterminate.                                  | agent get                                                                                                                                                               |
| local | `cli.agent.enablement.provider.model.list.token_required` | No option, environment variable or `cli.yaml` supplies a token.    | agent enablement provider model list                                                                                                                                    |
| local | `cli.agent.enablement.provider.model.list.indeterminate`  | The read result is indeterminate.                                  | agent enablement provider model list                                                                                                                                    |
| local | `cli.agent.enablement.disable.invalid_revision`           | The `<expected-revision>` argument is not a positive safe integer. | agent enablement disable                                                                                                                                                |
| local | `cli.agent.enablement.enable.invalid_revision`            | The `<expected-revision>` argument is not a positive safe integer. | agent enablement enable                                                                                                                                                 |
| local | `cli.agent.enablement.provider.remove.invalid_revision`   | The `<expected-revision>` argument is not a positive safe integer. | agent enablement provider remove                                                                                                                                        |
| local | `cli.agent.enablement.remove.invalid_revision`            | The `<expected-revision>` argument is not a positive safe integer. | agent enablement remove                                                                                                                                                 |
| 400   | `agent.configuration.credential_unsuitable`               | The selected credential is not suitable for the provider.          | binding apply, agent enablement put, agent enablement provider add, handover, worker.execution.setup.get (API only)                                                     |
| 400   | `agent.configuration.invalid`                             | A worker or entry configuration fails shape validation.            | binding apply, agent enablement put, handover, worker.execution.setup.get (API only)                                                                                    |
| 400   | `agent.configuration.model_unknown`                       | The selected model is absent from the catalog.                     | agent enablement put, binding apply, handover, worker.execution.setup.get (API only)                                                                                    |
| 400   | `agent.configuration.override_not_allowed`                | An entry overrides a forbidden field.                              | binding apply, handover, worker.execution.setup.get (API only)                                                                                                          |
| 400   | `agent.configuration.reasoning_effort_unsupported`        | The selected model does not support this reasoning level.          | agent enablement put, binding apply, handover, worker.execution.setup.get (API only)                                                                                    |
| 409   | `agent.enablement.in_use`                                 | Worker bindings still use the enablement.                          | agent enablement remove                                                                                                                                                 |
| 409   | `agent.enablement.invalidates_bindings`                   | The change invalidates dependent bindings.                         | agent enablement put                                                                                                                                                    |
| 404   | `agent.enablement.not_found`                              | The live enablement does not exist.                                | agent enablement get, agent enablement provider model list, agent enablement mutations                                                                                  |
| 409   | `agent.enablement.provider.fixed`                         | An edit changes a retained provider.                               | agent enablement put                                                                                                                                                    |
| 409   | `agent.enablement.provider.in_use`                        | Defaults or entries still use this provider.                       | agent enablement put, agent enablement provider remove                                                                                                                  |
| 409   | `agent.enablement.provider.name_conflict`                 | An agent provider already uses this name.                          | agent enablement put, agent enablement provider add                                                                                                                     |
| 409   | `agent.enablement.provider.credential_conflict`           | An agent provider already uses this credential.                    | agent enablement put, agent enablement provider add                                                                                                                     |
| 404   | `agent.enablement.provider.not_found`                     | The agent provider does not exist.                                 | agent enablement put, agent enablement provider remove, agent enablement provider model list, binding apply                                                             |
| 400   | `agent.enablement.provider.required`                      | The write leaves no agent provider.                                | agent enablement put, agent enablement provider remove                                                                                                                  |
| 409   | `agent.enablement.revision_conflict`                      | The expected enablement revision is stale.                         | agent enablement mutations                                                                                                                                              |
| 400   | `agent.enablement.unavailable`                            | The agent lacks a live enabled configuration.                      | binding apply, agent configuration reads, handover, worker.execution.setup.get (API only)                                                                               |
| 404   | `agent.catalog.not_found`                                 | The agent name is absent from the agent catalog.                   | agent enablement get, agent enablement put, agent enablement enable, agent enablement disable, agent enablement remove, agent enablement provider model list, agent get |

`error.details` names the agent and lists affected bindings or other dependents when applicable. No error holds secret material.

## Design provenance

Optional design provenance:
[Agent design](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.md),
[Agent vocabulary](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.vocabulary.md),
[Agent implementation rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/agent.impl.md)
and [open handoff](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md).
