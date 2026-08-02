# Instructions and profiles

Reviewer: AI engineer. Phase 2. This file defines what an agent is told, where that text comes from, and what an agent is allowed to do.

## Workers and agents

Worker binding precedence is project, then graph, then node. The most specific binding wins. An objective binds one repository, so a node-level binding changes the worker kind only.

`tdd@1` is a worker strategy, not an agent. Worker kinds are `general@1`, `tdd@1` and `git@1`. `tdd@1` drives `te@1`, `swe@1` and `re@1`.

KanthorD redesigns the loop of `.claude/commands/*`. It keeps the TDD intent and the review gate. It does not keep the role sequence.

## Prompt compilation

Instruction is compiled into typed channels, not concatenated. Precedence is decided before rendering. A model does not reliably read "later text" as "higher priority", so the resolver never delegates precedence to prompt position. The channels are: daemon invariants, role contract, repository profile, project policy, task contract, ambient context, runtime evidence.

Prose appends, lists append, scalars override. A scope adds guidance on top of the scope above it, and nothing is ever deleted. Override applies only where append has no meaning: a single-valued field such as the verification command or a timeout. Two prose fragments that contradict each other are reported by a lint at import. The resolver never silently reconciles them.

`re@1` renders from a reduced prompt. It receives the acceptance criteria of the task, the diff and the verification output, plus the daemon invariants and its own role contract, which define its verdict format. It never receives implementation guidance. A reviewer that reads the same instruction as the implementer makes correlated mistakes, and the review stops being independent.

Budget is enforced per channel, and the failure is a refusal. The resolver refuses an attempt that exceeds the cap and names the channel. It never truncates, because truncated instruction produces work that looks valid and is not. Ambient context is the only channel the resolver may drop, and a drop writes an event.

## The repository profile

A repository profile is a skill document, stored in SQLite. The body is the skill: prose sectioned by role heading. The frontmatter is the executable contract, and it holds only what the daemon runs or routes on.

```markdown
---
schema: kanthord.profile/v1
template: { id: nodejs, version: 1.2.0, digest: sha256:... }
checks:
  unit: { run: [pnpm, test:unit], timeout: 10m }
  e2e: { run: [pnpm, test:e2e], timeout: 30m }
---

## swe@1

Use the repository result type. Never throw across a service boundary.

## te@1

Integration tests use the seeded fixture database.
```

The profile lives in the database, with export to markdown and import from markdown, like the work graph. The database is canonical, so a working tree never feeds the resolver, and an agent cannot rewrite the instruction that governs its own run. Nothing in the schema is specific to a programming language. A language appears only as a template id and as prose, so one shape serves a Flutter repository, a .NET repository and a documentation repository.

`checks` is a map from a check name to a command. The levels that consume them are defined in `gates-and-approval.md`: the objective runs `unit`, and an initiative may run `e2e` through a project-level binding. A repository that runs no end-to-end suite of its own declares no `e2e` command, and its initiatives record the check as not applicable.

Verification does not mean compilation. A documentation repository checks links and schemas, a research repository checks the required artifacts and the citation format, an operations repository validates configuration and plans a dry run. A command that cannot fail, such as `true`, is rejected.

The profile is pinned per objective. An objective records the profile hash when its workspace is created, so an edit during a run cannot change instruction in the middle of an objective.

## Templates

Templates carry the reusable knowledge, and onboarding instantiates one. KanthorD ships templates for `nodejs`, `python`, `go`, `dotnet`, `flutter`, `docs` and `research`. Onboarding detects candidates by inspecting the repository, proposes a template and the fields it can infer, and the human commits the result. Detection never applies by itself, because a `package.json` does not name the workspace root or the real verification script. The instantiated profile records the template id, version and digest, so a later template change is a diff the human reads.

## Capability

Capability is enforced in the agent implementation, never in profile data or prose. Each role receives a tool set defined in code: `re@1` gets read-only tools, `te@1` writes tests, `swe@1` writes code, `git@1` uses no model at all. A profile cannot widen a tool set, because it holds no field that names one. An instruction such as "do not access the network" is guidance to a model, not a control, and the daemon never depends on one.

## Ambient files

Ambient files are a separate, untrusted channel.

Host files `~/.claude/CLAUDE.md` and `~/.agent/AGENTS.md` load only when the human switches them on, and the default is off: a daemon home may not be the human's home, personal instructions bleed across projects, and such a file may hold secrets.

Repository ambient files are read once, from the objective's pinned commit, and frozen for the objective, so an agent edit takes effect only in a later objective. Only the repository root file is read, symlinks are refused, and ambient content can never set a structured field.

`pi-coding-agent` discovers `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md` and `CLAUDE.MD`, and walks ancestor directories. Every agent is therefore constructed with `noContextFiles: true`, and the adapter asserts the loader reports zero context files. It fails closed when the assertion breaks. The ancestor walk matters here: workspaces live under `.data/workspaces/`, inside this repository, so an unguarded agent would inherit KanthorD's own `AGENTS.md` and `CLAUDE.md`.

## Reproduction

Each attempt stores the rendered messages and every source blob by content address, with the adapter version, the tool definitions and the pinned registration and provider_model. A hash alone cannot rebuild a prompt after its source is gone.

## Profile verification

Profile verification is a manual command, and it does not block. `kanthord profile verify` runs three gates.

- **Gate A** validates the schema and the role headings, resolves the template digest, compiles the channels, and asserts by inspection that the verification command reached the right channel. It is deterministic and needs no model.
- **Gate B** runs the verification command at an exact commit and separates a wrong declaration from a repository baseline that is currently red. Where the template supports it, a negative control applies a known violation and asserts the command fails, which catches a command that exits zero and checks nothing.
- **Gate C** runs one hermetic canary through the real agent with a mechanically checkable goal, and asserts the diff, the tool trace, the file scope, the verification result and the `re@1` verdict. It is a smoke test of the loop.

No gate proves that prose guidance will be followed later, and the daemon never claims it does. A wrong profile therefore surfaces as tasks that fail verification and park in `blocked`, and the human edits the profile.

## Inspection

`kanthord instructions resolve --agent <role> --node <id>` prints the composed prompt with per-block provenance. Golden fixture prompts per role and per template catch a template change that alters a rendered prompt.
