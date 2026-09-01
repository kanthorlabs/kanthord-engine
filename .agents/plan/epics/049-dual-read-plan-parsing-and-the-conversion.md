# EPIC 049 — Dual-read plan parsing

Status: **draft**. It follows EPIC 048 by sequence order.

## Goal

A plan document carries a deliverable and a verify block, and an existing document still parses:

- `planFrontmatter` accepts `deliverable` and `verify`, and it still accepts `worker`;
- a document that carries both `worker` and `deliverable` is refused;
- `plan import` stores the deliverable and the verify block, and `plan export` round-trips both byte-identically;
- a document that carries `deliverable` and no `verify` is refused.

## Non-goals

- **No conversion command.** This epic ships dual read and nothing that converts a tree. A human migrates `kanthord-apps` with an LLM, then imports the result. An earlier draft of this epic specified `plan convert`; the command, its stories and its proposal section are removed. `plan convert` in the shipped CLI stays the harness converter it already is.
- **No assignment in a document.** `assignment` is runtime state. `planFrontmatter` gains no `assignment` key, and a document carrying one is `frontmatter-invalid`.
- **No removal of `worker` from the schema.** EPIC 057 removes it. Dual read is the whole point of this epic, per `worker.md` section 13.

## Decisions

- **Dual read is a bounded window, and the two shapes are exclusive per document.** `planFrontmatter` in `src/domain/plan-document.ts:16` gains `deliverable` and `verify` as optional keys, and `planFrontmatterKeys` at line 7 gains both. A document carrying `worker` and `deliverable` together raises `frontmatter-invalid` with the issue path `deliverable`. One shape per document, and the window closes at EPIC 057.

- **`verify` is required in the new shape, and it may be empty.** A document that carries `deliverable` and no `verify` raises `frontmatter-invalid` with the issue path `verify`. An initiative and a parent objective carry `verify: {paths: [], commands: []}`, written out in full. An implicit default would make an unwritten block indistinguishable from an author's empty one.

- **`renderDocument` emits `deliverable` and `verify` in a fixed key order, and it drops `worker` when a deliverable is present.** `src/domain/plan-render.ts:41` emits `id`, `kind`, `title`, `deliverable`, `repo`, `depends_on`, `verify`, in that order. That is the order of the four examples in `worker.md` section 2, and a canonical order that disagrees with the design document would make every example in it wrong. `worker` is emitted only for a legacy document, in its current position at line 55. The order is fixed because the round trip must be byte-identical, per the `AGENTS.md` determinism rule.

- **`verify` renders as a nested block, and its scalars are quoted by `quoteScalar`.** The renderer emits `verify:`, then `  paths:` with one `    - <quoted>` line per entry, then `  commands:` likewise. An empty list renders as `  paths: []`. `src/domain/plan-render.ts:17` already holds `quoteScalar`, and a command string holding a quote, a backslash or a tab is therefore round-trip safe.

- **Two finding codes are added, and `worker-unknown` is untouched.** `pair-illegal` names a document whose `(kind, deliverable)` pair fails `nodePairLegality`. `verify-invalid` names a **stored node** whose `verify_json` fails `verifyBlock`. It is not a document-parse finding: `planFrontmatter` embeds `verifyBlock`, so a submitted document with a malformed verify block already raises `frontmatter-invalid` at parse and never reaches a `ParsedDocument`. `verify-invalid` is therefore the `plan-candidate.ts` guard over persisted state, and persisted state is a different boundary from a submitted document. Migration 11's `CHECK (verify_json IS NULL OR json_valid(verify_json))` proves the gap is real rather than theoretical: `{"paths":["a/../b"],"commands":[]}` is valid JSON and passes the CHECK while failing `verifyBlock`. A database written by an older grammar, by manual SQL, by external tooling or by a migration defect can hold such a row, and no lint rule reaches stored data. The guard also covers a cross-column invariant that is not a grammar question at all: a node with a non-null `deliverable` and a null `verify_json` is inconsistent persisted state. The query-side `500` of EPIC 047 is not a substitute, because `validateCandidate` collects findings across a whole candidate without aborting, and a throw ends the walk at the first bad row. Both are `structural` scope in `src/domain/plan-finding.ts:42`. `worker-unknown` keeps its meaning for a legacy document until EPIC 057.

- **A document that names neither field stays legal, and EPIC 057 closes that.** Exclusivity refuses a document carrying both fields. It does not refuse a document carrying neither, because `worker` is `required=true nullable=true` in the `node.create` request for all three kinds — `src/http/contract/field-decisions.fixture.ts:113`, `:120` and `:127` — so the daemon itself creates a node with no worker, and `renderDocument` then emits a document naming neither field. Refusing that shape would make the daemon unable to re-read its own export, and no default repairs it: an objective may legally take `expansion`, `test`, `implementation` or `review` per `src/domain/node-pair.ts:32-45`, and a task the same, so nothing but a human knows which. The rule belongs at EPIC 057, which removes `worker` and makes `deliverable` mandatory at the write path in the same change.

## Stories

1. **The frontmatter accepts both shapes.** Extend `planFrontmatterKeys` at `src/domain/plan-document.ts:7` and `planFrontmatter` at line 16 with `deliverable` and `verify`. Extend `ParsedDocument` at line 38 with `deliverable: Deliverable | null` and `verify: VerifyBlock | null`. Add cases to `src/domain/plan-document.test.ts`: the legacy shape parses; the new shape parses; a document naming neither field parses, for every kind; both keys together raise `frontmatter-invalid` on path `deliverable`; `deliverable` with no `verify` raises `frontmatter-invalid` on path `verify`; an `assignment` key raises `unknown frontmatter key`.

2. **Two finding codes.** Add `pair-illegal` and `verify-invalid` to `findingCodes` at `src/domain/plan-finding.ts:6` and to `findingScope` at line 42, both `structural`. Add a non-throwing decoder to `src/domain/verify-block.ts` — `decodeVerifyBlock(text): { ok: true; block: VerifyBlock } | { ok: false }` — and express `parseVerifyBlock` over it, so the candidate guard and the query reader share one parse and cannot drift. Update `src/domain/plan-finding.test.ts` for the extended tuple and the sort order over the new codes.

3. **Validation applies the pair and the verify block.** Add the pair check to `src/domain/plan-validate.ts` and both checks to `src/domain/plan-candidate.ts`. Add cases to their test files: a task naming `deliverable: expansion` raises exactly one `pair-illegal`; an initiative naming `deliverable: implementation` raises exactly one `pair-illegal`; a stored node whose `verify_json` holds `'{"paths":["a/../b"],"commands":[]}'` raises exactly one `verify-invalid` from `validateCandidate`; a legacy document raises neither. `plan-validate.ts` emits no `verify-invalid`, because `planFrontmatter` refuses a malformed verify block first.

4. **The renderer emits the new keys.** Extend `RenderInput` and `renderDocument` at `src/domain/plan-render.ts:6` and `:41` with the key order `id`, `kind`, `title`, `deliverable`, `repo`, `depends_on`, `verify`, and the nested `verify` block. Add a case per `worker.md` section 2 example asserting the exact rendered bytes against a literal in the shipped quoted form, reproducing that example's key order. Add cases to `src/domain/plan-render.test.ts` asserting the exact bytes of a new-shape document, the exact bytes of an empty verify block, and a command string holding a quote, a backslash and a tab surviving a round trip byte-identically.

5. **Import and export round-trip the new shape.** Extend `src/commands/plan/import-plan.ts` to persist `deliverable` and `verify_json`, and `src/queries/plan/export-plan.ts` to emit them. Add cases to both test files asserting a new-shape plan imports with no finding and exports byte-identical to the input, and asserting a legacy plan still imports and exports byte-identical.

6. **The proposal records dual read.** Amend `docs/proposal/phase-1/plan-format.md` with the two frontmatter shapes, the exclusivity rule, the fixed key order and the verify block grammar. State that dual read closes at EPIC 057 in `docs/proposal/phase-2/deliverables-and-pairs.md`.

## Verification Gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/plan-document.test.ts \
  src/domain/plan-finding.test.ts \
  src/domain/plan-validate.test.ts \
  src/domain/plan-candidate.test.ts \
  src/domain/plan-render.test.ts \
  src/commands/plan/import-plan.test.ts \
  src/queries/plan/export-plan.test.ts \
  && echo "PASS EPIC-049"
```

Hermetic coverage required beyond the Proof:

- A document carrying `worker` and `deliverable` together raises exactly one `frontmatter-invalid`, with the issue path `deliverable`.
- A document carrying neither `worker` nor `deliverable` parses, asserted for `initiative`, `objective` and `task`. The daemon creates such a node through `node.create`, and it must re-read its own export.
- A document carrying `deliverable` and no `verify` raises exactly one `frontmatter-invalid`, with the issue path `verify`.
- A new-shape document renders to exact bytes, asserted against a literal string, with the key order `id`, `kind`, `title`, `deliverable`, `repo`, `depends_on`, `verify`.
- Each of the four `worker.md` section 2 examples renders to exact bytes, asserted against a literal, and reproduces that example's key order exactly. The literal is written in the shipped quoted form. The examples in `worker.md` are printed with unquoted YAML scalars, and `quoteScalar` at `src/domain/plan-render.ts:17` quotes every scalar, so the two forms differ by quoting alone.
- A container created through `node.create` exports and re-imports at status `200`, proving the shipped write path still round-trips.
- An empty verify block renders as `  paths: []` and `  commands: []`, asserted byte-exact.
- A command string holding `"`, `\` and a tab round-trips byte-identically through render and parse.
- A plan whose tasks carry `worker` imports and exports byte-identically after this epic, proving dual read did not break the shipped task shape.
- A `verify_json` value of `{"paths":["a/../b"],"commands":[]}` is inserted through real SQLite, passes migration 11's `json_valid` CHECK, and then produces exactly one `verify-invalid` finding from `validateCandidate`. The case proves the CHECK and the schema guard cover different things, so neither is redundant.
- A stored node with a non-null `deliverable` and a null `verify_json` produces exactly one `verify-invalid` finding, asserted by code and by node id. The case is a cross-column invariant and not a grammar question.
- `validateCandidate` returns findings for two bad rows in one candidate rather than aborting at the first, asserted by a finding count of two.
