---
epic: .agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md
opened: 2026-08-30
opener: test-engineer
base-ref: 84a92f93eb43a7eeb1694b6d34d9691ba9417f7d
---

# Implementation cycle — 049-dual-read-plan-parsing-and-the-conversion

Pulled from EPIC: `.agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `pnpm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/domain/plan-document.test.ts \
>   src/domain/plan-finding.test.ts \
>   src/domain/plan-validate.test.ts \
>   src/domain/plan-candidate.test.ts \
>   src/domain/plan-render.test.ts \
>   src/domain/plan-conversion.test.ts \
>   src/commands/plan/import-plan.test.ts \
>   src/queries/plan/export-plan.test.ts \
>   src/services/verify/node-spawn.test.ts \
>   src/services/verify/spawn-at-commit.test.ts \
>   src/cli/plan/convert.test.ts \
>   && echo "PASS EPIC-049"
> ```
>
> Hermetic coverage required beyond the Proof:
>
> - A document carrying `worker` and `deliverable` together raises exactly one `frontmatter-invalid`, with the issue path `deliverable`.
> - A document carrying neither raises exactly one `frontmatter-invalid`, with the issue path `deliverable`.
> - A document carrying `deliverable` and no `verify` raises exactly one `frontmatter-invalid`, with the issue path `verify`.
> - A new-shape document renders to exact bytes, asserted against a literal string, with the key order `id`, `kind`, `title`, `deliverable`, `repo`, `depends_on`, `verify`.
> - Each of the four `worker.md` section 2 examples renders to exact bytes, asserted against a literal, and reproduces that example's key order exactly. The literal is written in the shipped quoted form. The examples in `worker.md` are printed with unquoted YAML scalars, and `quoteScalar` at `src/domain/plan-render.ts:17` quotes every scalar, so the two forms differ by quoting alone. Quoting is not negotiable here: it is what the shipped plan format already emits, and relaxing it would break byte-identity for every stored document. The section 2 examples are therefore illustrations of the key order, not of the bytes.
> - An empty verify block renders as `  paths: []` and `  commands: []`, asserted byte-exact.
> - A command string holding `"`, `\` and a tab round-trips byte-identically through render and parse.
> - A legacy plan imports and exports byte-identically after this epic, proving dual read did not break the shipped shape.
> - A `test` node converts to a command that begins with `! `, and the remainder equals the template output exactly. The case uses a template whose command deterministically fails at `failing-ref`, so the inverted command exits zero and is kept.
> - An `implementation` node depending on that test takes the same command without the `! ` prefix, run at `passing-ref` of the same pair range, asserted by the written bytes.
> - `plan convert` refuses `commit-range-missing` and names the test source path when a node would take a command and no `--at` entry keys that test. The refusal is asserted by code.
> - `plan convert` refuses `already-converted` and names the path when any input document carries `deliverable`. The refusal is asserted by code, and the output directory stays empty.
> - A `--at` value naming a branch is resolved to a commit object id once, and moving the branch between the two passes of one run changes nothing. The case moves the branch mid-run against the hermetic fixture.
> - An `implementation` node with no `depends_on` naming a `test` node reaches `manual`, with the reason asserted by value.
> - A body holding two `**Input:**` lines reaches `manual`, with the reason asserted by value.
> - A `verify_json` value of `{"paths":["a/../b"],"commands":[]}` is inserted through real SQLite, passes migration 11's `json_valid` CHECK, and then produces exactly one `verify-invalid` finding from `validateCandidate`. The case proves the CHECK and the schema guard cover different things, so neither is redundant.
> - A stored node with a non-null `deliverable` and a null `verify_json` produces exactly one `verify-invalid` finding, asserted by code and by node id. The case is a cross-column invariant and not a grammar question.
> - `validateCandidate` returns findings for two bad rows in one candidate rather than aborting at the first, asserted by a finding count of two.
> - `manualReasons` deep-equals the six-element tuple. Every one of the six is produced by its own case, so no reason is unreachable.
> - The same document set submitted in two different input orders produces deep-equal `ConversionResult` values, including for an implementation node that precedes its `test` dependency.
> - A task whose `derivedParentPath` chain reaches an objective two levels up selects that objective's repository, while a `depends_on` edge to a node under a different objective changes nothing.
> - `NodeSpawnVerify` refuses with `VerifyError` code `process-unavailable` when process creation is unavailable, asserted by error code against a constructed-unavailable instance.
> - The source repository's index is byte-unchanged after a command validation run, asserted by comparing `git status --porcelain` before and after.
> - An objective with no task child converts to `deliverable: expansion`, proving the rule is unconditional.
> - `plan convert` refuses `worker-unmapped` and names the path when a document carries a `worker` value outside the two conversion rows. The case uses `general@1`, a member of `workerKinds` at `src/domain/worker.ts:3` that no row maps, so a parseable document can carry it. The output directory stays empty.
> - A task whose objective ancestor names a repository selects that repository's template. The case places the objective two levels above the task.
> - A generated command that exits non-zero at its intended commit is dropped, the node takes `commands: []`, and the reason is `command-failed`. The case runs against the hermetic loopback repository fixture, `seedRepositories(tools)` at `test/helpers/remote/seed.ts:124`.
> - `plan convert` with a template in scope and no `--repo` refuses `checkout-required` and names the repository. The refusal is asserted, so a silent empty command list cannot ship.
> - An output directory that is non-empty refuses `output-not-empty`, and one nested inside the input refuses `output-inside-input`.
> - `plan convert` run twice over the same legacy input, into two empty output directories, writes byte-identical documents and a byte-identical report, asserted by comparing the two output trees file by file, including `convert-report.json`. The template pins each command outcome, so the assertion tests the conversion and not an arbitrary command.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — frontmatter dual shape · Task 1 — Frontmatter accepts both shapes

**Cycle.** RED for Task `1` (`src/domain/plan-document.test.ts`).

**Test written.**

- file: `src/domain/plan-document.test.ts` (edited) — suite: `src/domain/plan-document.test` — methods: `planFrontmatter accepts the legacy shape (worker only)`, `planFrontmatter accepts the new shape (deliverable and verify)`, `both worker and deliverable together raise frontmatter-invalid on path deliverable`, `neither worker nor deliverable raises frontmatter-invalid on path deliverable`, `deliverable with no verify raises frontmatter-invalid on path verify`, `an assignment key raises unknown frontmatter key on path assignment`
- file: `src/domain/plan-identity.test.ts` (edited) — existing `ParsedDocument` fixture carries the new nullable fields.
- asserts: frontmatter accepts one complete shape, refuses mixed or absent shapes with the required issue paths, requires `verify` for the new shape, and refuses `assignment`.

**RED proof.**

- command: `pnpm test`
- exit: non-zero — failure: `✖ planFrontmatter accepts the new shape (deliverable and verify) (0.692291ms)`
- additional failures: `✖ both worker and deliverable together raise frontmatter-invalid on path deliverable (0.62175ms)`, `✖ neither worker nor deliverable raises frontmatter-invalid on path deliverable (0.134875ms)`, `✖ deliverable with no verify raises frontmatter-invalid on path verify (0.286209ms)`

**Open to Software Engineer.**

- `src/domain/plan-document.ts`: export `planFrontmatter` with the `deliverable` and `verify` fields, the dual-shape validation, and `ParsedDocument` fields `deliverable: Deliverable | null` and `verify: VerifyBlock | null`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — frontmatter dual shape · Task 1 — Frontmatter accepts both shapes

**Cycle.** GREEN for Task `1` (`src/domain/plan-document.test.ts`).
**Files changed.**

- None — the EPIC 047 prerequisite modules are absent.
  **Seam (GREEN).** Blocked because `plan-document.ts` cannot import the required `deliverable` and `verifyBlock` exports.
  **Refactor.** Deferred until the EPIC 047 prerequisite modules exist.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 1 requires `src/domain/deliverable.ts` and `src/domain/verify-block.ts`, and neither file exists.

OPEN: src/domain/deliverable.ts — implement the EPIC 047 deliverable schema and `Deliverable` type before Task 1.
OPEN: src/domain/verify-block.ts — implement the EPIC 047 verify block schema and `VerifyBlock` type before Task 1.
ATTEMPT-FAILED: 1 — EPIC 047 prerequisite modules are absent, so the required production edit cannot compile.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — frontmatter dual shape · Task 1 — Frontmatter accepts both shapes

**Cycle.** RED confirmation for Task `1` (`src/domain/plan-document.test.ts`).
**Test written.**

- file: `src/domain/plan-document.test.ts` (existing RED cases) — suite: `src/domain/plan-document.test` — methods: `planFrontmatter accepts the new shape (deliverable and verify)`, `both worker and deliverable together raise frontmatter-invalid on path deliverable`, `neither worker nor deliverable raises frontmatter-invalid on path deliverable`, `deliverable with no verify raises frontmatter-invalid on path verify`
- asserts: frontmatter accepts the new shape and refuses mixed or absent shapes with the required issue paths.
  **RED proof.**
- command: `pnpm test`
- exit: non-zero — failure: `✖ planFrontmatter accepts the new shape (deliverable and verify) (0.756375ms)`
- additional failures: `✖ both worker and deliverable together raise frontmatter-invalid on path deliverable (2.103875ms)`; `✖ neither worker nor deliverable raises frontmatter-invalid on path deliverable (0.254792ms)`; `✖ deliverable with no verify raises frontmatter-invalid on path verify (0.335041ms)`
  **Open to Software Engineer.**
- `src/domain/plan-document.ts`: exported `planFrontmatter` accepts the legacy and new frontmatter shapes with the required refusals, and `ParsedDocument` exposes `deliverable: Deliverable | null` and `verify: VerifyBlock | null`.

ATTEMPT-FAILED: 1 — still red after the software-engineer turn: the required EPIC 047 deliverable and verifyBlock seams remain absent.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — frontmatter dual shape · Task 1 — Frontmatter accepts both shapes

**Cycle.** GREEN for Task `1` (`src/domain/plan-document.test.ts`).
**Files changed.**

- None — the EPIC 047 prerequisite modules remain absent.
  **Seam (GREEN).** Blocked because `plan-document.ts` cannot import the required `deliverable` and `verifyBlock` exports.
  **Refactor.** Deferred until the EPIC 047 prerequisite modules exist.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 1 requires `src/domain/deliverable.ts` and `src/domain/verify-block.ts`, and neither file exists.

OPEN: src/domain/deliverable.ts — implement the EPIC 047 deliverable schema and `Deliverable` type before Task 1.
OPEN: src/domain/verify-block.ts — implement the EPIC 047 verify block schema and `VerifyBlock` type before Task 1.
ATTEMPT-FAILED: 1 — EPIC 047 prerequisite modules remain absent, so the required production edit cannot compile.

END: SOFTWARE-ENGINEER
