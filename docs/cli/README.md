# Engine CLI specification

[Internal documentation home](../README.md)

This specification defines the target command surface of `kanthord` for engine
contributors. It translates the service design into commands, arguments,
parameters, operation mappings, and access rules. It is a planning contract,
not the public reference for the commands currently available.

## Command documents

Each service or shared component owns one group document. [Common flags](common-flags.md) defines shared
flag names, syntax, defaults, validation, and synopsis markers. Link directly
to its flag-name headings instead of repeating those definitions. Shared
non-flag conventions and commands outside these groups live in `other.md`.

| Command group                  | Owning document                                   | Scope                                                                                                   |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `project`                      | [Project Service](project.md)                     | Projects, permitted resources, bindings, policy, and worker binding entries.                            |
| `llm`                          | [LLM](llm.md)                                     | LLM credential records, metadata revisions and OAuth login sessions.                                    |
| `repository`                   | [Repository](repository.md)                       | Repository credential records and metadata revisions.                                                   |
| `storage`                      | [Storage](storage.md)                             | Storage credential records and metadata revisions.                                                      |
| `mission`                      | [Mission Service](mission.md)                     | Mission graph, criterion, evidence, assessments, outcomes, and human controls.                          |
| `scheduler`                    | [Scheduler Service](scheduler.md)                 | Work pull, executions, claims, deadlines, and scheduling inspection.                                    |
| `intake`                       | [Intake Service](intake.md)                       | Inbounds, inbound events, acquisition through a webhook or a poll, and outbound platform operations.    |
| `worker`                       | [Worker Service](worker.md)                       | Workers, agents, instance registration, and execution hosting.                                          |
| `tracking`                     | [Tracking Service](tracking.md)                   | Telemetry ingestion and trace inspection.                                                               |
| `gateway`                      | [Gateway Service](gateway.md)                     | Identity verification and local OpenAPI generation.                                                     |
| `config`, `serve`, `jwt`, help | [Other commands and shared conventions](other.md) | Configuration files, application startup, local token issuance, client options, and input/output rules. |

The Project inventory has 11 proposed leaves. The LLM inventory has 12 leaves: 11 implemented and 1 proposed.
The Repository and Storage inventories have 8 leaves each. The Worker inventory
has 19 leaves: 1 implemented and 18 proposed. These five groups contain 58 leaves in total.

Start with [common flags](common-flags.md) and
[shared conventions](other.md), then read the owning group page.
Each group page inventories its commands, links to the common flags it uses,
and defines command-specific arguments, requirements, and exceptions. An
optional argument has no implicit value unless its definition gives a default.

## Status and implementation

The pages distinguish three kinds of information:

- **Implemented:** behavior checked against the current engine source. This is
  a snapshot of the working tree on 2026-09-24, not a statement about a released
  package.
- **Planned or proposed:** target behavior grounded in the service design.
  Command spellings, request fields, routes, and defaults introduced by this
  specification are proposals until the owning operation contract adopts them.
- **Open or blocked:** an open decision lives in the root [HANDOFF](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md). A blocked row links its item.

Inspected 2026-09-24: the source currently supplies `config init|validate|show`, `serve` with the
`server` application, human and machine `jwt generate` issuance, `worker register`,
`gateway verify`, and `gateway openapi`. The `project`, `mission`, `scheduler`,
and `tracking` groups currently provide help only. The `intake` group is not registered in the dispatcher, even for help. `serve worker` is implemented; it checks the server version and waits for cancellation, but does not register, pull, or execute work. Registration also depends on server-side collaborators; a CLI
parser and an operation declaration alone do not establish a working journey.

New remote commands must be backed by an operation in their owning component's
`contract.ts`, exposed through Gateway and included in the generated OpenAPI
contract before implementation is considered complete. The proposed route
tables in these documents are not evidence that those endpoints exist today.
Current declarations are in the [Gateway contract](../../src/gateway/contract.ts)
and [Worker contract](../../src/worker/contract.ts); dispatch is in the
[CLI application](../../src/apps/cli/index.ts).

## Ownership rules

- Keep the three global command names, seven service groups and three shared
  component groups listed above, as the [command surface](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-command-surface) declares.
  Application names are operands of `serve`, not additional top-level commands.
- A remote command calls the operation of the service or shared component that
  owns its effect. Gateway authenticates and routes the request; it does not
  acquire that owner's authority.
- Cross-service workflows compose commands. They do not imply an atomic
  transaction across operations.
- Internal collaborations, background loops, and provider webhook deliveries
  are not automatically CLI commands. A service page identifies relevant
  boundaries and deferred features.
- Every command is non-interactive. Its help must describe required input,
  validation, and defaults without requiring a running server.
- Preserve the human/machine distinction. A flag carrying an identity is not
  authentication, and a client cannot grant itself authority by naming a
  project, runtime instance, execution, or claim.
- A later service or shared component command belongs in its owner's group
  file. A global command belongs in `other.md` and requires a deliberate change
  to the closed top-level command set when applicable.

## Maintaining the specification

Every error code that the engine answers stands on the `docs/cli/` page of its command group; every command page holds an error-code table with the HTTP status, code and condition of each code its commands answer.

When implementing a command, settle its open decisions, declare its operation
and access policy, implement its CLI adapter, and update its status here.
Verify that the help, arguments, request schema, cancellation, and retry rules
agree. Maintain shared flag definitions in `common-flags.md`; keep applicability,
access rules, and command-specific exceptions on the owning page. Publish
implemented user-facing behavior in the public CLI reference; these contributor
specifications remain internal.

The source design is the parent repository's
[brainstorm collection](https://github.com/kanthorlabs/kanthord/tree/main/docs/brainstorm),
especially its
[architecture implementation rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md)
and service pages. Those links provide provenance; the command contracts here
must remain understandable in a standalone engine checkout.
