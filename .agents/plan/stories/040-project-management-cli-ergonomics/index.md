# EPIC 040 — Project-management CLI ergonomics — stories

Epic: `.agents/plan/epics/040-project-management-cli-ergonomics.md`
Prereq: EPIC 039 (sequence order).

The CLI validates and explains project-management inputs, renders structural refusal details, inherits discovered daemon connection settings, and converts one expanded EPIC into deterministic plan-format documents.

## Dispatch order

1. `01-task-outcome-and-state-help-are-closed-and-local.md`
2. `02-node-write-and-repository-name-refusals-carry-details.md`
3. `03-client-commands-inherit-discovered-http-configuration.md`
4. `04-expanded-epic-conversion-is-a-deterministic-pure-mapping.md`
5. `05-plan-convert-is-a-registered-local-command.md`

Stories 1, 2 and 3 are independent CLI corrections and land in the numbered order. Story 4 defines the pure converter. Story 5 depends on Story 4 and registers its file-system command. Stories 1–4 each pair test-engineer and software-engineer edits; Story 5 also updates the shared reachability recorder.

## Stories

- 1 — task outcome validation and closed state help → `01-task-outcome-and-state-help-are-closed-and-local.md`
- 2 — plan findings and known repository names in refusals → `02-node-write-and-repository-name-refusals-carry-details.md`
- 3 — flags/environment/config connection fallback → `03-client-commands-inherit-discovered-http-configuration.md`
- 4 — expanded EPIC to plan documents, pure and byte-deterministic → `04-expanded-epic-conversion-is-a-deterministic-pure-mapping.md`
- 5 — registered operation-free `plan convert` command → `05-plan-convert-is-a-registered-local-command.md`

## Facts (needed for implementation)

- `src/http/contract/outcome.ts:23-53` holds all six route branches; `src/cli/node/report.ts:31-71` is task-only and must admit only the first four.
- `src/domain/state.ts:7-16` is the ordered eight-state vocabulary. `work` is not a member.
- `src/http/contract/error-details.ts:84-86` exports `planInvalidDetails`; `src/cli/client.ts:26-33` retains daemon error details.
- `src/cli/node/create.ts:171-176`, `update.ts:202-207` and `delete.ts:67-72` currently discard those details.
- `src/cli/project/repository.ts:49-67` already has the complete `repository.list` response before it reports an unknown name.
- `src/cli/options.ts:48-105` currently resolves flags and client environment only. `src/main.ts:794-816` is the composition site that may name `ConvictConfig`.
- `src/cli/program.ts:55-74` is the `ProgramDependencies` contract. Its construction sites are `src/main.ts`, `src/cli/program.test.ts`, `src/cli/parity.test.ts` and `test/helpers/command-recorder.ts`.
- `src/cli/plan/directory.ts:42-84` already reads and writes `plan/**/*.md` in deterministic path order.
- `src/domain/plan-document.ts:13-31` permits absent identities. The converter must not mint one.
- `src/domain/plan-path.ts:79-99` derives kind from segment count and filename; directory segments do not need ULIDs in authored input.
- `src/cli/inventory.ts:96-102` is the insertion site for `plan convert`. `src/cli/reachability.test.ts` requires one argv row and a recorded effect for every operation-free leaf.
- Tests use `node:test` and `node:assert/strict`. File-system tests use their own `mkdtemp` or an in-memory `PlanDirectoryDependencies` fake and remove no shared path.
