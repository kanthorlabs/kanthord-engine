# Workbench API specification

[CLI specification index](./README.md) · [Shared conventions](./other.md)

## Scope

The Workbench Service has **no CLI command**. A human drives a workbench session through the chat of the dashboard or through the API.
[Workbench Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/workbench-service.md) and its [implementation contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/workbench-service.impl.md) own the rules.
This page lists the operations and the error codes. It introduces no design rule.
The [operation contracts](../../src/workbench/contract.ts) and the generated OpenAPI publish the wire names, paths and output shapes.

## Operations

Every operation has `human` access.

| Operation ID                  | Route                                                  | Lifetime |
| ----------------------------- | ------------------------------------------------------ | -------- |
| `workbench.session.list`      | `GET /api/workbench/session`                           | `unary`  |
| `workbench.session.create`    | `POST /api/workbench/session`                          | `unary`  |
| `workbench.session.get`       | `GET /api/workbench/session/:session_id`               | `unary`  |
| `workbench.session.configure` | `PUT /api/workbench/session/:session_id/configuration` | `unary`  |
| `workbench.session.message`   | `POST /api/workbench/session/:session_id/message`      | `unary`  |
| `workbench.session.approve`   | `POST /api/workbench/session/:session_id/approve`      | `unary`  |
| `workbench.session.abort`     | `POST /api/workbench/session/:session_id/abort`        | `unary`  |
| `workbench.session.events`    | `GET /api/workbench/session/:session_id/events`        | `wait`   |

## Error codes

Every operation can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP  | Code                                      | Condition                                                              |
| ----- | ----------------------------------------- | ---------------------------------------------------------------------- |
| 404   | `workbench.session.not_found`             | The session identity names no session.                                 |
| 404   | `workbench.session.approval_not_found`    | The tool call of an approval waits for no approval.                    |
| 409   | `workbench.session.run_active`            | A message or a configure arrives while a run is active.                |
| 409   | `workbench.session.configuration_invalid` | The stored entries of the session hold no readable configuration.      |
| 409   | `workbench.session.setup_refused`         | The runtime refuses the setup of the session.                          |
| 403   | `workbench.authorization.refused`         | The Workbench Service refuses the credential release of the session.   |
| local | `workbench.lifecycle.stopped`             | A stopped service starts again.                                        |
| 404   | `agent.catalog.not_found`                 | The agent name of a create or a list is absent from the agent catalog. |
