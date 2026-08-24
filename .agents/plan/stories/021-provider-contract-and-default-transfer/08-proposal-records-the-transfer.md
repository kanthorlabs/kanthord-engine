# Story 8 — the proposal records the transfer

Epic: `.agents/plan/epics/021-provider-contract-and-default-transfer.md`
Depends on: Story 7.

The inventory is three edits and no more. Anchor each edit on the quoted text, not on the line number: the EPIC cites `providers-and-credentials.md:21` and `database/provider.md:83`, and the anchor text sits at line 20 and line 84 of the current files.

## Change

- `docs/proposal/api/credential.md`, in the `## provider.setDefault` section. Keep the first sentence of the paragraph, `The chain orders by set_default_at, so calling this route again on a second registration appends it.`, and qualify it in the replacement below as the deferred behaviour, so the paragraph does not read as if the MVP appends. Replace the second sentence, `The MVP refuses that second call until the ordered chain ships, and the refusal names the registration that already holds the default.` The replacement states three facts, in this order: the MVP chain holds one entry; `provider.setDefault` moves that entry by clearing the previous holder in the same transaction; the appending ordered chain is deferred.
- `docs/proposal/phase-2/providers-and-credentials.md`, in the paragraph opening `Registry operations are register, list, rename, set default and remove.` Add the same three-fact statement to that paragraph. Change no other sentence of it, and change the following paragraph, `The MVP requires exactly one registration, and it is the global default.`, in no way. That sentence is left standing under protest: a transfer needs at least two registrations, and one chain holder is not one registration, so the file stays internally inconsistent after this story. Correcting it is a fourth edit, and the EPIC fixes the inventory at three. See the report's open items; do not widen the inventory on your own authority.
- `docs/proposal/database/provider.md`, in the bullet opening `**Reordering the chain rewrites timestamps.**` Amend its closing sentence, `The chain is deferred past the MVP, so the first real reorder is also the first time this matters.`, because a transfer now rewrites `set_default_at` on two rows before any reorder ships. The amended sentence states that `provider.setDefault` already rewrites `set_default_at` on the previous holder and on the target, and that a reorder is a later and separate case.

## Constraints

- Three edits and no more. Amend no other proposal file and no other paragraph.
- Change no row of the route matrix table at `docs/proposal/api/credential.md:15-22`. No `operationId`, no method, no path, no `introducedIn` and no `status` changes, so `src/http/contract/parity.test.ts` is unaffected. An edit that touches a table row is out of scope.
- Change no SQL block in `docs/proposal/database/provider.md`. `test/helpers/proposal.ts` reads those blocks for the schema-parity test.
- Do not describe the `provider.defaultUnset` event in any proposal file. The proposal names no provider event, and D2 decides the name in the EPIC alone.
- Do not add a `position` column, a reorder route or a project-scoped or agent-scoped default to any proposal file.
- Follow ASD-STE100: imperative, simple tenses, one instruction per sentence.

## Verify

- Run `node --test --test-timeout=60000 src/http/contract/parity.test.ts`; it exits 0, and its two count assertions still read 66 proposal rows with 62 routed or stubbed.
- Run `git diff --stat docs/proposal/`; exactly three files appear, and no diff hunk touches a table row or a fenced SQL block.
- Run `grep -rn "refuses that second call" docs/proposal/`; it returns nothing.
- Run `npm run verify`; it exits 0.
- Proof: `PASS EPIC-021` for `src/http/contract/parity.test.ts`.
