# EPIC 002 — Domain and state machine — stories

Epic: `.agent/plan/epics/002-domain-and-state-machine.md`
Prereq: EPIC 001 (sequence order). The daemon starts, holds its home lock, and `npm run verify` runs the type check, the tests and the lint.

Every entity, value and state rule of phase 1 exists as data in `src/domain/`, and every service capability exists as an interface in `src/services/`.

## Dispatch order

```
02 → 04 → 03 → 05 → 01 → 06 → 07 → 08 → 09 → 10 → 11
```

- `02` is first. `src/domain/identity.ts` is the only import every row schema and the id generator share.
- `04` precedes `03`, because `src/domain/node.ts`, `project.ts`, `run.ts` and `agent-invocation.ts` import `workerKind` and `agentKind`.
- `05` follows `03`, because it inserts the 19th entry into `src/domain/rows.ts` and edits `src/domain/rows.test.ts`.
- `01` follows `02` for `IdentityKind`, and it creates `src/domain/layout.test.ts`, which `11` extends. Its lint edit must land before `11` adds a service directory.
- `06`, `07`, `08`, `09` and `10` each import `src/domain/state.ts` from `03`. `07` and `10` assert against `src/domain/transition.ts`, so `06` runs before both. `08` and `09` are independent of the rest.
- `11` is last. It needs `IdentityKind`, `AgentKind` and `src/domain/layout.test.ts`.

## Stories

- 01 — `services/ids`, `services/clock`, the two mocks, and the `ulid` ban in `src/domain/` → `01-ids-and-clock-services.md`
- 02 — the prefixed-ULID grammar and parse → `02-identity.md`
- 03 — the value schemas and 18 row schemas → `03-schema-inventory.md`
- 04 — the closed worker-kind and agent-kind enums → `04-worker-and-agent-registries.md`
- 05 — the four-column `profile` row → `05-profile-row.md`
- 06 — 56 transition rows per level, and `canTransition` → `06-transition-matrix.md`
- 07 — `aggregate` at both parent levels, and the two level gates that consume it → `07-aggregation.md`
- 08 — `isReady`, and the clearance of each block reason → `08-readiness-and-block-reasons.md`
- 09 — the Kahn walk with the ULID tie-break → `09-task-order.md`
- 10 — rejection counting and the `attempt-limit` verdict → `10-attempt-accounting.md`
- 11 — the eight remaining service interfaces, and three that throw → `11-service-interfaces.md`

## Facts (needed for implementation)

State of the tree at the start of this epic:

- `src/domain/` holds one file, `src/domain/version.ts:1` — `export const KANTHORD_VERSION = "27.8.1";`.
- `src/services/` holds two capabilities, `config` and `home-lock`. Neither is touched by this epic.
- `test/helpers/` holds `daemon.ts`, `database.ts`, `home.ts` and `lint.ts`, each with a sibling `.test.ts`.
- No file under `src/commands/`, `src/queries/`, `src/http/` or `src/cli/` exists. This epic creates none.

Conventions to mirror:

- Interface file: `src/services/config/index.ts:1-46` — `Readonly<{ … }>` types, a `<X>ErrorCode` string union, a `<X>Error extends Error` with `this.name` and `readonly code`, then the interface. No imports.
- Implementation file: named after the technology, exporting one class `<Tech><Capability>` — `src/services/config/convict.ts:81`, `src/services/home-lock/sqlite.ts:20`.
- Dependency injection: one exported `Readonly` deps type consumed by the constructor — `src/services/home-lock/sqlite.ts:15-25`.
- Test file: `import { describe, it } from "node:test"`, `import assert from "node:assert/strict"`, node builtins, a blank line, then subject imports with the `.ts` extension. Exactly one top-level `describe`, named the repo-relative test path without the extension — `src/services/config/search-order.test.ts:7`. Table-driven cases use `for (const [label, input] of [...] as const)` — `src/services/home-lock/identity.test.ts:45-87`.
- `assert.equal`, `assert.deepEqual`, `assert.ok`. The `/strict` import makes `equal` strict.
- A domain test may import `node:fs`: `eslint.config.js:175` ignores `src/domain/**/*.test.ts` from the purity rule, and `src/domain/version.test.ts` already does it.

Toolchain facts:

- `tsconfig.json` sets `verbatimModuleSyntax` and `allowImportingTsExtensions`, so every intra-repo import carries `.ts` and every type-only import uses `import type`.
- `tsconfig.json` sets `noUncheckedIndexedAccess`, so an array or record index yields `T | undefined`. The transition `Map` lookup and the identity prefix lookup both need a narrowing.
- `zod@^4.4.3` is installed. `z.int()` is the v4 integer schema. `z.enum(arrayOfConstStrings)` exposes `.options`.
- `ulid@3.0.2` is installed and imported only at `src/main.ts:5`. It is absent from `vendorPackages` at `eslint.config.js:7-16`, so `src/domain/` may import it today. Story 01 closes that.
- `eslint.config.js:33-55` declares `{ type: "service", pattern: "src/services/*", capture: ["capability"] }`, so a new capability directory is classified with no config change.
- `eslint.config.js:67` sets `boundaries/no-unknown-files` to error. A `.ts` file under `src/` that matches no element pattern fails the lint — `src/main.test.ts` would be one, so no test sits at the `src/` root.
- `test/helpers/lint.ts` exports `lintCase({ filePath, code }): Promise<readonly string[]>`, which runs the real ESLint API over in-memory text at a synthetic repo path and returns the sorted deduped rule ids. Every lint assertion in this epic uses it.

Source facts the stories depend on:

- Column and `CHECK` inventory: `docs/proposal/database/<table>.md`, one file per table, each opening with a `CREATE TABLE … ) STRICT;` block.
- Identity prefixes: `docs/proposal/database/README.md:51-67`. Five differ from the table name — `repository → repo`, `plan_revision → revision`, `agent_invocation → invocation`, `check_result → check`, `git_operation → gitop`. `node` mints three, one per kind. `blob`, `migration` and `project_binding` mint none (`:69`).
- `_blob` columns hold a `blob.hash`, `_oid` columns hold a 40- or 64-character git object id, `_json` columns hold document text: `docs/proposal/database/README.md:43-44`.
- Timestamps are epoch-millisecond integers, and creation time comes from the ULID: `docs/proposal/database/README.md:38,42`.
- Edge direction: `from_node` depends on `to_node`, and a waived row is ignored by readiness — `docs/proposal/database/edge.md:8-9,16,18`.
- The task tie-break is a plain string comparison of the id, because both ends carry `task_`: `docs/proposal/database/node.md:40`, `docs/proposal/phase-1/plan-format.md:41`.
- No attempt counter on `node` — `docs/proposal/database/node.md:38`. The counter is `MAX(attempt_no)` of the active task run, and the block fires when `attempt_no = attempt_limit` **with an outcome of `rejected`** — `docs/proposal/database/attempt.md:24,40`. That is narrower than the EPIC bullet "a rejection increments", and Story 10 follows `attempt.md`.
- `eslint.config.js:69` and `:264` configure the rule id `boundaries/dependencies`. There is no `boundaries/element-types` rule in this configuration, so every lint assertion names `boundaries/dependencies`.
- A ULID is 128 bits in 26 Crockford characters, so the leading character is bounded to `0-7`.
- `workspace.state` and `run.outcome` and `git_operation.outcome` and `event.type` and `event.subject_kind` carry **no** `CHECK`. Their schemas stay `z.string()`.
- `mr@1` appears at `docs/proposal/phase-1/git-foundation.md:21,135` but is not a member of the closed worker-kind set of `docs/proposal/phase-1/domain.md:10`.
- `repository.publish_on_approval`, `candidate.acknowledged_partial`, `candidate.publish_requested` and `check_result.authoritative` are plain `INTEGER` with no `0`/`1` `CHECK`. Their schemas are `z.int()`. A narrower schema would reject a row SQLite accepts.

## Open items for the human

One rule this epic depends on lives only here, not in the proposal. `/work` can run without it, and it should land in `docs/proposal/` before EPIC 003 restates it in DDL.

- Initiative aggregation over a `partial` objective is not covered by `docs/proposal/phase-1/state-machine.md:31,39`. Decided: a `partial` child contributes one `done` and one `discarded`, so `{done, partial}`, `{partial}` and `{partial, discarded}` all aggregate to `partial`. Story 07 encodes it. `docs/proposal/phase-1/state-machine.md` needs the same sentence.

Resolved: `AGENTS.md:39` now reads "a service **interface** | `domain/`, any service interface", which matches `eslint.config.js:105-113`. Story 11's `Transaction` import is legal under the matrix, the prose and the lint.
