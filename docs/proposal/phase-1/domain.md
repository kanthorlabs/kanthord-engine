# Domain and architecture

Reviewer: architect or tech lead. Read this first. It names the entities every other file uses.

## Domain model

- **Global**: credentials, git repositories, LLM provider registrations. Other entities inherit them.
- **Project**: binds repositories. An ordered provider list that replaces the global chain is post-MVP, and [../api/project.md](../api/project.md) holds its lifecycle.
- **Graph**: initiative, objective, task. Containment is three levels. Dependency edges connect siblings.
- **Worker**: executes one objective under a lease. Kinds are `general@1`, `tdd@1`, `git@1`.
- **Agent**: `general@1`, `swe@1`, `te@1`, `re@1`. Each holds a role contract and a tool set defined in code.
- **Profile**: one skill document per repository, instantiated from a template, stored in the database.
- **Template**: reusable role prose plus a proposed verification command, shipped with KanthorD.
- **Event**: every transition emits one.

An agent is a dedicated unit. A worker kind composes agents. The MVP ships the `general@1` worker, which composes the `general@1` agent and `re@1`. `tdd@1`, `te@1`, `swe@1` and `git@1` are defined here because the entity model must hold them, and they are built after the MVP.

## Three entries above persist nothing

The list names the domain model, and a reader must not read it as a table list. Three entries hold no row.

- **Worker** and **Agent** are closed sets of kinds, defined in code. A kind is vocabulary that a row cites: `project.worker`, `node.worker` and `run.worker` hold a worker kind, and `agent_invocation.agent` holds an agent kind. The set is a `CHECK` clause and a zod enum, never a table.
- **Template** is content shipped with KanthorD. It has no table, no row and no id in the database. **Profile** is the instantiation of a template for one repository, and `profile` is the table that holds the pointer.

The table list below is complete. A domain-model entry absent from it persists nothing, and a phase that names such an entry delivers code or content rather than a migration.

## State and events

State tables hold state. Events are an audit trail. Every transition writes a row and appends an immutable event. Events feed history and the status stream. Events do not reconstruct state.

## Storage

`node:sqlite`. Tables:

`repository`, `project`, `project_binding`, `provider`, `profile`, `blob`, `node`, `edge`, `plan_revision`, `workspace`, `lease`, `run`, `attempt`, `agent_invocation`, `candidate`, `check_result`, `git_operation`, `event`, plus the infrastructure table `migration`.

A credential is not a table. It is the encrypted secret of a `provider` row. A provider binding is not a table either. The global chain is the `set_default_at` column of `provider`, and a narrower scope binds on the entity that owns it: `project_binding` for a project, and `agent_binding` when agent-level binding is built.

[../database/README.md](../database/README.md) holds the columns, the constraints and the reason each table exists. One file per table.

Migrations run from the CLI. `npm run verify` calls `db status`, so that command is a phase 1 deliverable.

`db status` calls the daemon over HTTP, so `verify` is staged. Until the daemon listens, `verify` runs the type check, the tests and the lint and nothing else. It then gains a step that migrates a temporary home, starts the daemon on a loopback port with a token, calls `db status`, stops the daemon and removes the home. A verification script that calls a route with no daemon behind it is not a gate.

## Service layering

Services expose interfaces. Commands and queries hold the business logic. Dependencies inject through the interface.

```
src/
  services/     config, storage, crypto, git, graph, event, agent, verify, lease
  domain/       entities, state machine, zod schemas
  commands/     write paths
  queries/      read paths
  http/         koa routes
  cli/          commander programs
```

`eslint-plugin-boundaries` is already a dependency. It enforces the layering.

## Dependencies

Already present: `pi-agent-core`, `pi-ai`, `pi-coding-agent`, `graphology`, `koa`, `commander`, `pino`, `ulid`, `yaml`, `supertest`.

To add: `zod@4`, `convict@6`, `isomorphic-git@1`.
