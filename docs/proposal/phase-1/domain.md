# Domain and architecture

Reviewer: architect or tech lead. Read this first. It names the entities every other file uses.

## Domain model

- **Global**: credentials, git repositories, LLM provider registrations. Other entities inherit them.
- **Project**: binds repositories, and optionally an ordered provider list that replaces the global one.
- **Graph**: initiative, objective, task. Containment is three levels. Dependency edges connect siblings.
- **Worker**: executes one objective under a lease. Kinds are `general@1`, `tdd@1`, `git@1`.
- **Agent**: `general@1`, `swe@1`, `te@1`, `re@1`. Each holds a role contract and a tool set defined in code.
- **Profile**: one skill document per repository, instantiated from a template, stored in the database.
- **Template**: reusable role prose plus a proposed verification command, shipped with KanthorD.
- **Event**: every transition emits one.

An agent is a dedicated unit. A worker kind composes agents. The MVP ships the `general@1` worker, which composes the `general@1` agent and `re@1`. `tdd@1`, `te@1`, `swe@1` and `git@1` are defined here because the entity model must hold them, and they are built after the MVP.

## State and events

State tables hold state. Events are an audit trail. Every transition writes a row and appends an immutable event. Events feed history and the status stream. Events do not reconstruct state.

## Storage

`node:sqlite`. Tables:

`credential`, `repository`, `project`, `provider`, `provider_binding`, `profile`, `blob`, `node`, `edge`, `graph_revision`, `workspace`, `lease`, `run`, `attempt`, `candidate`, `check_result`, `operation`, `event`.

Migrations run from the CLI. `npm run verify` already calls `db status`, so that command is a phase 1 deliverable.

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

To add: `zod@4`, `convict@6`, `simple-git@3.36.0`.
