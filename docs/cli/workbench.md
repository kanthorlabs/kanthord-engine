# Workbench API specification

[CLI specification index](./README.md) · [Shared conventions](./other.md)

## Scope

The Workbench Service has **no CLI command**. A human drives a workbench session through the chat of the dashboard or through the API.
[Workbench Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/workbench-service.md) and its [implementation contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/workbench-service.impl.md) own the rules.
The Workbench opens sessions of `swe@1` and `re@1` only.
This page lists the operations and the error codes. It introduces no design rule.
The [operation contracts](../../src/workbench/contract.ts) and the generated OpenAPI publish the wire names, paths and output shapes.

## Operations

Every operation has `human` access, except `workbench.invite.join` (`public`) and the three `workbench.guest.*` operations (`guest`).

| Operation ID                      | Route                                                                 | Lifetime |
| --------------------------------- | --------------------------------------------------------------------- | -------- |
| `workbench.session.list`          | `GET /api/workbench/session`                                          | `unary`  |
| `workbench.session.create`        | `POST /api/workbench/session`                                         | `unary`  |
| `workbench.session.get`           | `GET /api/workbench/session/:session_id`                              | `unary`  |
| `workbench.session.configure`     | `PUT /api/workbench/session/:session_id/configuration`                | `unary`  |
| `workbench.session.message`       | `POST /api/workbench/session/:session_id/message`                     | `unary`  |
| `workbench.session.fork`          | `POST /api/workbench/session/:session_id/fork`                        | `unary`  |
| `workbench.session.approve`       | `POST /api/workbench/session/:session_id/approve`                     | `unary`  |
| `workbench.session.action.report` | `POST /api/workbench/session/:session_id/action/:tool_call_id/report` | `unary`  |
| `workbench.session.autoMode.set`  | `POST /api/workbench/session/:session_id/auto-mode`                   | `unary`  |
| `workbench.session.abort`         | `POST /api/workbench/session/:session_id/abort`                       | `unary`  |
| `workbench.session.queue.remove`  | `DELETE /api/workbench/session/:session_id/queue/:queued_message_id`  | `unary`  |
| `workbench.session.events`        | `GET /api/workbench/session/:session_id/events`                       | `wait`   |
| `workbench.invite.create`         | `POST /api/workbench/session/:session_id/invite`                      | `unary`  |
| `workbench.invite.list`           | `GET /api/workbench/session/:session_id/invite`                       | `unary`  |
| `workbench.invite.revoke`         | `DELETE /api/workbench/invite/:invite_id`                             | `unary`  |
| `workbench.invite.join`           | `POST /api/workbench/invite/join`                                     | `unary`  |
| `workbench.guest.get`             | `GET /api/workbench/guest/session`                                    | `unary`  |
| `workbench.guest.stream`          | `GET /api/workbench/guest/session/stream`                             | `stream` |
| `workbench.guest.message`         | `POST /api/workbench/guest/session/message`                           | `unary`  |

`workbench.session.autoMode.set` takes the body `{ enabled }` and answers `{ session_id, enabled }`. It is a human-only act of the owner. The run snapshot of `workbench.session.events` answers `auto_mode`.

The pending approval of the run snapshot carries `guard`. `guard` is `null` for an evidence card. Every other card carries `{ cause, reason, confidence }`. `cause` is one of `import`, `auto_mode_off`, `unavailable`, `oversize`, `no_verdict` and `classifier`. `reason` and `confidence` are `null` for every cause other than `classifier`.

## Conversations

A conversation is its host session. The agent of `workbench.session.create` is the host. `create` writes an opening pair to the host file with no model call: an internal user message that the answers hide, and the greeting of the host.

A message that starts with `@<display name>` runs the member with that display name. `@` followed by a space is no mention, and only a leading mention routes. The first mention of an agent that is not yet a member creates a participant session of that agent. An untagged message runs the member that answered last, and the greeting counts as the answer of the host.

The session answers of `workbench.session.get` and `workbench.session.events` are one merged transcript of the conversation.

- `members` lists `{ session_id, agent_name, display_name }` of every member, the host first, then the participants by creation time.
- Every entry carries `session_id` and `agent_name` of the member file that holds it.
- `after` of `workbench.session.events` holds one `<session_id>:<entry_id>` pair per member, separated by commas. A member with no pair starts from the first entry. A plain entry id names the host pair, and the participant entries start from the first entry. The answer holds no cursor field; the client builds `after` from the `session_id` and `id` of the entries it holds.
- `version` is one counter for the whole conversation.

The run snapshot reads the running member. `pending_approval` carries `session_id`, the member that made the call. `workbench.session.approve` takes that `session_id`.

`workbench.session.get`, `events`, `message`, `abort`, `queue.remove` and `autoMode.set` accept the host session id only. A participant session id answers `409 workbench.session.not_host` with details `{ session_id, host_session_id }`. `configure` accepts a participant session id and answers `409 workbench.session.run_active` while the conversation holds a run.

`workbench.session.list` answers one item per conversation. An item adds `display_name`, `host_session_id` and `participants`. A host item answers `host_session_id: null`, the items of its participants in `participants` and, as `modified`, the latest `modified` of its members. A participant item answers the id of its host in `host_session_id` and an empty `participants`. A participant is never a top-level item. The filter `agent_name` selects the host agent. A new conversation answers `first_message: ""` and `message_count: 1`. After the first human message, `name` holds that message.

`workbench.session.message` answers `{ session_id, agent_name, run_active, queued_message_id, cleared, kind }`. `session_id` is the host id. `agent_name` is the member that runs the message now, the member that a queued message names, or `null` for an untagged queued message. A queued message and an item of `cleared` carry `agent_name` and `display_name` of their mention, or `null` for both when untagged. A queued item resolves its member when it starts, and an untagged item runs the member that answered last at that moment. A queued item whose agent is refused at its start is dropped, and `error_message` of the snapshot holds the refusal. `kind` is `run` for a message that starts or queues a run. In a conversation with a live invite, an untagged message is a note: it appends a `note` record, starts no run, and answers `kind` `note` with `agent_name` `null`, `queued_message_id` `null` and `cleared` `[]`. After the last invite ends, an untagged message runs the member that answered last again.

## Error codes

Every operation can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP  | Code                                         | Condition                                                                                                                                                                                                                                              |
| ----- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 404   | `workbench.session.not_found`                | The session identity names no session, also at `invite.create` on an unknown session.                                                                                                                                                                  |
| 404   | `workbench.session.approval_not_found`       | The tool call of an approval waits for no approval, or the approval expired.                                                                                                                                                                           |
| 404   | `workbench.session.queued_message_not_found` | The queued message identity names no queued message of the session.                                                                                                                                                                                    |
| 404   | `workbench.session.action_not_found`         | No `action_offer` record of the session holds the `tool_call_id`.                                                                                                                                                                                      |
| 409   | `workbench.session.action_settled`           | A `done` result already exists for the `tool_call_id`.                                                                                                                                                                                                 |
| 409   | `workbench.session.agent_refused`            | A create names a catalog agent with no operation tool, such as `pe@1` or `guard@1`; details `{ agent_name }`.                                                                                                                                          |
| 409   | `workbench.session.not_host`                 | The session id names a participant; send the call to the host session, also at `invite.create` on a participant id. Details `{ session_id, host_session_id }`.                                                                                         |
| 404   | `workbench.invite.not_found`                 | An unknown or expired token at join, an unknown invite id at revoke.                                                                                                                                                                                   |
| 400   | `workbench.invite.name_invalid`              | A blank or 65-character join name or invitee name.                                                                                                                                                                                                     |
| 401   | `gateway.jwt.invite_ended`                   | A guest request or a stream open for a deleted or expired invite.                                                                                                                                                                                      |
| 409   | `workbench.evidence.name_mismatch`           | A typed approve of a danger card. The `approve` body field `node_name` is absent or differs from `node.content.name`. The card stays pending.                                                                                                          |
| 400   | `gateway.request.validation_failed`          | The `text` of a fork is empty, blank or longer than 4096 bytes.                                                                                                                                                                                        |
| 409   | `workbench.fork.summary_refused`             | The guard refused the summary of a fork, or the check failed; details `{ cause, reason }`. `cause` is one of `refused`, `timeout`, `no_verdict`, `oversize` and `unavailable`. `reason` is `null` except for cause `refused`. The fork writes no file. |
| 502   | `workbench.fork.summary_failed`              | The summarizer of a fork gave no usable summary; details `{ session_id }`. The fork writes no file.                                                                                                                                                    |
| 409   | `workbench.session.run_active`               | A configure arrives while a run is active.                                                                                                                                                                                                             |
| 409   | `workbench.session.queue_full`               | A message arrives while the queue holds 10 messages.                                                                                                                                                                                                   |
| 409   | `workbench.session.configuration_invalid`    | The stored entries of the session hold no readable configuration.                                                                                                                                                                                      |
| 409   | `workbench.session.setup_refused`            | The runtime refuses the setup of the session.                                                                                                                                                                                                          |
| 403   | `workbench.authorization.refused`            | The Workbench Service refuses the credential release of the session.                                                                                                                                                                                   |
| local | `workbench.lifecycle.stopped`                | A stopped service starts again.                                                                                                                                                                                                                        |
| 404   | `agent.catalog.not_found`                    | The agent name of a create or a list is absent from the agent catalog, or a message starts with a mention of an unknown name; details `{ mention }` for a mention.                                                                                     |
| 400   | `agent.enablement.unavailable`               | A message starts with a mention of an agent that is disabled or has no enablement.                                                                                                                                                                     |
| 409   | `agent.prompt.template_invalid`              | An override file or a prompt template of the agent directory is invalid at the session open; details `{ file, path, reason }`.                                                                                                                         |

`evidence_read` fails with one of these tool errors: `workbench.evidence.asset_mismatch`, `workbench.evidence.media_refused`, `workbench.evidence.not_granted` and `workbench.evidence.shared_conversation`. `workbench.evidence.shared_conversation` fails a call that the owner approved with a plain card after `invite.create`. The call reads nothing and grants nothing.
