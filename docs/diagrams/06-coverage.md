# 06 — Coverage

Every foreign key column in the schema, and the diagram that owns it. A split loses a relation when no one counts. This file is the count.

The database holds **48** foreign key columns. **20** of them point at `blob`.

```sh
grep -c 'REFERENCES' docs/proposal/database/*.md
grep -c 'REFERENCES blob(hash)' docs/proposal/database/*.md
```

## Foreign key columns

| #   | Child table        | Column                  | Parent             | Null       | Owner                                |
| --- | ------------------ | ----------------------- | ------------------ | ---------- | ------------------------------------ |
| 1   | `repository`       | `credential_id`         | `provider.id`      | no         | [01](01-registration.md)             |
| 2   | `project_binding`  | `project_id`            | `project.id`       | no         | [01](01-registration.md)             |
| 3   | `profile`          | `repository_id`         | `repository.id`    | no, unique | [01](01-registration.md)             |
| 4   | `profile`          | `content_blob`          | `blob.hash`        | no         | [01](01-registration.md)             |
| 5   | `plan_revision`    | `project_id`            | `project.id`       | no         | [02](02-plan-graph.md)               |
| 6   | `plan_revision`    | `parent_id`             | `plan_revision.id` | yes        | [02](02-plan-graph.md)               |
| 7   | `plan_revision`    | `submitted_blob`        | `blob.hash`        | no         | [02](02-plan-graph.md)               |
| 8   | `plan_revision`    | `choices_blob`          | `blob.hash`        | no         | [02](02-plan-graph.md)               |
| 9   | `plan_revision`    | `accepted_blob`         | `blob.hash`        | no         | [02](02-plan-graph.md)               |
| 10  | `node`             | `project_id`            | `project.id`       | no         | [02](02-plan-graph.md)               |
| 11  | `node`             | `parent_id`             | `node.id`          | yes        | [02](02-plan-graph.md)               |
| 12  | `node`             | `repository_id`         | `repository.id`    | yes        | [02](02-plan-graph.md)               |
| 13  | `node`             | `revision`              | `plan_revision.id` | no         | [02](02-plan-graph.md)               |
| 14  | `node`             | `instruction_blob`      | `blob.hash`        | no         | [02](02-plan-graph.md)               |
| 15  | `node`             | `acceptance_blob`       | `blob.hash`        | yes        | [02](02-plan-graph.md)               |
| 16  | `edge`             | `from_node`             | `node.id`          | no         | [02](02-plan-graph.md)               |
| 17  | `edge`             | `to_node`               | `node.id`          | no         | [02](02-plan-graph.md)               |
| 18  | `workspace`        | `node_id`               | `node.id`          | no, unique | [03](03-execution.md)                |
| 19  | `workspace`        | `repository_id`         | `repository.id`    | no         | [03](03-execution.md)                |
| 20  | `workspace`        | `profile_blob`          | `blob.hash`        | no         | [03](03-execution.md)                |
| 21  | `workspace`        | `ambient_blob`          | `blob.hash`        | yes        | [03](03-execution.md)                |
| 22  | `run`              | `node_id`               | `node.id`          | no         | [03](03-execution.md)                |
| 23  | `run`              | `parent_run_id`         | `run.id`           | yes        | [03](03-execution.md)                |
| 24  | `run`              | `workspace_id`          | `workspace.id`     | no         | [03](03-execution.md)                |
| 25  | `attempt`          | `run_id`                | `run.id`           | no         | [03](03-execution.md)                |
| 26  | `attempt`          | `provider_id`           | `provider.id`      | no         | [03](03-execution.md)                |
| 27  | `agent_invocation` | `attempt_id`            | `attempt.id`       | no         | [03](03-execution.md)                |
| 28  | `agent_invocation` | `prompt_blob`           | `blob.hash`        | no         | [03](03-execution.md)                |
| 29  | `agent_invocation` | `tool_definitions_blob` | `blob.hash`        | no         | [03](03-execution.md)                |
| 30  | `agent_invocation` | `tool_trace_blob`       | `blob.hash`        | yes        | [03](03-execution.md)                |
| 31  | `agent_invocation` | `diff_blob`             | `blob.hash`        | yes        | [03](03-execution.md)                |
| 32  | `agent_invocation` | `reason_blob`           | `blob.hash`        | yes        | [03](03-execution.md)                |
| 33  | `agent_invocation` | `error_blob`            | `blob.hash`        | yes        | [03](03-execution.md)                |
| 34  | `candidate`        | `node_id`               | `node.id`          | no         | [04](04-verification-integration.md) |
| 35  | `candidate`        | `run_id`                | `run.id`           | no         | [04](04-verification-integration.md) |
| 36  | `candidate`        | `workspace_id`          | `workspace.id`     | no         | [04](04-verification-integration.md) |
| 37  | `candidate`        | `evidence_blob`         | `blob.hash`        | no         | [04](04-verification-integration.md) |
| 38  | `candidate`        | `profile_blob`          | `blob.hash`        | no         | [04](04-verification-integration.md) |
| 39  | `check_result`     | `node_id`               | `node.id`          | yes        | [04](04-verification-integration.md) |
| 40  | `check_result`     | `run_id`                | `run.id`           | yes        | [04](04-verification-integration.md) |
| 41  | `check_result`     | `manifest_blob`         | `blob.hash`        | yes        | [04](04-verification-integration.md) |
| 42  | `check_result`     | `output_blob`           | `blob.hash`        | yes        | [04](04-verification-integration.md) |
| 43  | `check_result`     | `profile_blob`          | `blob.hash`        | yes        | [04](04-verification-integration.md) |
| 44  | `git_operation`    | `repository_id`         | `repository.id`    | no         | [04](04-verification-integration.md) |
| 45  | `git_operation`    | `node_id`               | `node.id`          | yes        | [04](04-verification-integration.md) |
| 46  | `git_operation`    | `run_id`                | `run.id`           | yes        | [04](04-verification-integration.md) |
| 47  | `git_operation`    | `candidate_id`          | `candidate.id`     | yes        | [04](04-verification-integration.md) |
| 48  | `git_operation`    | `detail_blob`           | `blob.hash`        | yes        | [04](04-verification-integration.md) |

Every blob column also appears in the inventory of [05-cross-cutting](05-cross-cutting.md). That is a second view of the same 20 rows, and it is not a second authority.

## Relations with no foreign key

Each one needs application code and a test. The database enforces none of them.

| Relation                                                        | Discriminator              | Owner                                |
| --------------------------------------------------------------- | -------------------------- | ------------------------------------ |
| `project_binding.target_id` to `repository` or `provider`       | `kind`                     | [01](01-registration.md)             |
| `lease.subject_id` to a `node` or a `repository`                | `subject_kind`             | [03](03-execution.md)                |
| `check_result.subject_id` to a `candidate` or a `git_operation` | `subject_kind`             | [04](04-verification-integration.md) |
| `event.subject_id` to any entity                                | `subject_kind`, no `CHECK` | [05](05-cross-cutting.md)            |
| `run.lease_fence` to the node lease generation                  | none                       | [03](03-execution.md)                |
| `git_operation.lease_fence` to the repository lease generation  | none                       | [04](04-verification-integration.md) |
| `agent_invocation.sources_json` to blob hashes                  | none                       | [05](05-cross-cutting.md)            |

## Rules the schema cannot hold

These come from the "Invariants the schema does not enforce" section of [../proposal/database/README.md](../proposal/database/README.md). No diagram can draw them, and each needs a test.

- A dependency edge connects two siblings.
- The repository of an objective is bound to the project of that objective, through a `project_binding` row of `kind = 'git'`.
- A task run has an objective run as its parent, and an objective run has none. The `CHECK` clause holds the null shape, not the kind of the parent.
- A parent node state is computed from its children.
- A blob is not deleted while a row references it.

## Tables with no foreign key

`migration`, `lease`, `event` and `blob`. `blob` is the parent of 20 columns and the child of none. `migration` holds no relation in either direction.
