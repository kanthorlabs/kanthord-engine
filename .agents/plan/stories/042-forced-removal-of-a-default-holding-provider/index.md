# EPIC 042 — Forced removal of a default-holding provider — stories

Epic: `.agents/plan/epics/042-forced-removal-of-a-default-holding-provider.md`
Prereq: EPIC 041 (sequence order).

`provider.remove` accepts `force=true` as an optional query parameter that suppresses the `default-chain` blocker only, letting a human remove the last `llm` registration and return an account to zero.

## Dispatch order

Stories 1 and 3 form a COUPLED PAIR and must complete together before `npm run verify` is run on either. Story 2 is independent and may run in parallel with Story 1. Story 3 may start only after both Story 1 and Story 2 are complete. Story 4 is independent and may run in parallel with any of 1–3. Order: (1 + 2) → 3 → `npm run verify`; then Story 4 independently.

## Stories

- 1 — Command admits `force: boolean` and guards the `default-chain` push → `01-command-force-flag.md`
- 2 — Contract declares `providerRemoveRequest` query schema and adds `query` to the registry entry → `02-contract-query-param.md`
- 3 — Handler parses the `force` query param and passes a boolean to the command → `03-handler-force-param.md`
- 4 — Proposal records which blocker `force` overrides and why the other three are not overridable → `04-proposal-amend.md`

## Facts (needed across stories)

- `RemoveProviderInput` at `src/commands/provider/remove-provider.ts:10-13`: currently `{ id: string; actor: string }`. Story 1 adds `force: boolean`.
- `default-chain` push at `src/commands/provider/remove-provider.ts:68-70`: `if (target.set_default_at !== null) { blockers.push({ kind: "default-chain" }); }`. Story 1 guards with `&& !input.force`.
- Fixed blocker-collection order: `default-chain` (68-70), `project-binding` (71-79), `repository` (80-88), `attempt` (89-95). Only the first changes; the other three are unchanged.
- `removeDependencies` helper at `src/commands/provider/remove-provider.test.ts:65-70`. All existing calls that pass `{ id, actor }` to `removeProvider` need `force: false` added.
- New tests in Story 1 use `countRows(storage, "provider")` and `readEvents(storage)` — helper functions already defined in the test file. There is no `storage.find` API.
- `registerGitProvider` helper at `src/commands/provider/remove-provider.test.ts:72-83`: registers name `"github-bot"`, kind `"git"`, actor `"ulrich"`. A git provider never auto-stamps. Registration appends 1 event: `provider.registered`.
- `register-provider.ts:85`: calls `clock.now()` exactly once per registration. A first `llm` registration appends 2 events (`provider.registered` + `provider.defaultSet`).
- For Cases A-D: use git provider + manual SQL stamp (`tx.run("UPDATE provider SET set_default_at = ? WHERE id = ?", [1700000000000, providerId])`), identical to the existing line 357 test pattern.
- `OperationExamples` at `src/http/contract/operation.ts:26-31`: has `query?: unknown` (separate from `request?: unknown`). Pattern: `providerCatalogExamples.query = { provider: "openai" }` at `src/http/contract/credential.ts:255`.
- `provider.remove` registry entry at `src/http/contract/credential.ts:390-403`: no `query:` field today. Story 2 adds `query: providerRemoveRequest`.
- `providerRemoveExamples` at `src/http/contract/credential.ts:146-162`: has no `query` key today. Story 2 adds `query: { force: "false" }`.
- `singleValued` at `src/http/server/single.ts`: imported as `import { singleValued } from "../single.ts"` in server handlers. Throws `httpError("invalid-request")` when a key appears more than once.
- Handler at `src/http/server/credential/remove-provider.ts:10-28`: does not read `context.query` today. Story 3 adds the parse block.
- `main.test.ts:95-98`: tests `provider.remove` with a non-existent id; expects 404. No `force` query sent; passes unchanged after this epic because `force` defaults to `false` on the not-found path.
- `docs/proposal/api/credential.md:42-49`: four-bullet blocker list (42-46), blank line, then prose "The third and the fourth are not optional." at line 49+. Story 4 inserts a paragraph before line 49.
- `src/cli/parity.test.ts:245`: `"provider.remove"` stays in `uncovered`; unchanged by this epic.
- EPIC 101 Proof runs `src/commands/provider/remove-provider.test.ts`; the "blocked by all four causes" test at line 357 must keep passing unchanged.
- **Settled rule — `force=` empty is `400 invalid-request`:** The EPIC Decisions section (updated) reads: "Every other string is `400 invalid-request`, and an empty value is one of them: a destructive override is stated, never inferred from a client that built `?force=` by concatenation. The schema therefore carries no `preprocess` and no `transform`." The schema is `z.enum(["true", "false"]).optional()` — no coercion. `force=false` and `force` absent are equivalent; `force=`, `force=1`, `force=yes` and `force=TRUE` each answer `400 invalid-request`. This is decided; do not re-open it.
