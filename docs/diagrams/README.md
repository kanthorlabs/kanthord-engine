# Database diagrams

Six diagrams of the 19 tables in [../proposal/database/](../proposal/database/). Read the table files for column meaning. Read these for relation shape.

The database holds 48 foreign key columns. 20 of them point at `blob`. One diagram of all 19 tables therefore renders as a star around `blob`, and the domain relations disappear. The split below gives each relation one owner.

| Diagram                                                       | Subject                                       |
| ------------------------------------------------------------- | --------------------------------------------- |
| [00-overview](00-overview.md)                                 | every table, table-to-table dependency only   |
| [01-registration](01-registration.md)                         | what a human registers before work exists     |
| [02-plan-graph](02-plan-graph.md)                             | the work tree and the import that wrote it    |
| [03-execution](03-execution.md)                               | one objective, its clone, its runs and tries  |
| [04-verification-integration](04-verification-integration.md) | freeze, judge, write refs                     |
| [05-cross-cutting](05-cross-cutting.md)                       | `blob` storage and the `event` journal        |
| [06-coverage](06-coverage.md)                                 | every foreign key column, mapped to its owner |

## Conventions

**Ownership.** One diagram owns each table and draws its key columns. Another diagram that needs the same table draws it as a reference node, with its id column only, and names the owner. A reference node is never authoritative. [06-coverage](06-coverage.md) maps every foreign key column to the diagram that owns it.

**Line meaning.** A solid line is a foreign key the database enforces. A dashed line is an application invariant from the "Invariants the schema does not enforce" section of [../proposal/database/README.md](../proposal/database/README.md). A dashed line has no `REFERENCES` clause behind it, and it needs a test.

**Cardinality.** Each endpoint comes from the schema, not from a fixed pattern.

| Schema                 | Notation    | Reading                                          |
| ---------------------- | ----------- | ------------------------------------------------ |
| `NOT NULL` foreign key | `\|\|--o{`  | one parent; a parent holds zero or more children |
| nullable foreign key   | `\|o--o{`   | zero or one parent; a parent holds zero or more  |
| `NOT NULL UNIQUE`      | `\|\|--o\|` | one parent; a parent holds zero or one child     |

`profile.repository_id` and `workspace.node_id` are `NOT NULL UNIQUE`. A repository therefore holds zero or one profile. The schema does not require a profile to exist.

**Scope.** These diagrams show relations. They do not show state transitions. `node.state` holds 8 values, and `candidate.state`, `run.state`, `repository.state` and `git_operation.state` hold their own sets. A `CHECK` clause appears here only when it decides a relation, such as the `node` clause that binds kind to parent. Read [../proposal/phase-1/state-machine.md](../proposal/phase-1/state-machine.md) for transitions.

**No build step.** Mermaid renders in the GitHub view of the repository.
