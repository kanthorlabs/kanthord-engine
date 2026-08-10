# Story 6 — provider.remove blocker list

Epic: `.agent/plan/epics/101-credential-registry-completion.md`
Depends on: EPIC 100 and coupled Stories 4, 5, 7 and 8.

## Change

- Add `src/commands/provider/remove-provider.ts` with `removeProvider({ storage, events }, { id, actor }): Readonly<{ id: string }>`.
- Export `ProviderRemovalBlocker` as the exact union of default-chain, project-binding with projectId, repository with repositoryId and attempt with attemptId.
- Export `RemoveProviderError`; refusals are `not-found | binding-in-use`. Only binding-in-use owns enumerable `blockers`; not-found owns only `name` and `refusal`.
- Use exact messages `no provider <id>` and `provider <id> is still in use`.
- Select `id, name, kind, set_default_at` inside one transaction and refuse an absent row as not-found.
- Build blockers in category order: default-chain; provider project bindings; repositories; attempts.
- Sort project ids, repository ids and attempt ids in JavaScript with `Buffer.compare(Buffer.from(a), Buffer.from(b))` before mapping them to blockers.
- If blockers exist, throw one binding-in-use error with the full array and perform no delete or event append.
- Otherwise delete by id and append `provider.removed` in the same transaction; set subjectKind `provider`, subjectId equal to input id, actorKind `human`, actorId equal to input actor and payload `{ name, kind }`.
- Return `{ id }` after that transaction commits.
- Add `src/http/server/credential/remove-provider.ts`; read path id, inject actor, call once, return 200 and map errors through `toHttpError`.
- In `src/http/contract/error-details.ts:19-35`, add strict attempt blocker `{ kind: z.literal("attempt"), attemptId: z.string().min(1) }`.
- Add the attempt blocker after repository in `docs/proposal/api/credential.md:40-46`.
- Add repository and attempt blockers after project binding in `docs/proposal/database/provider.md:86` and `docs/proposal/phase-2/providers-and-credentials.md:21`.

## Constraints

- Ignore `project_binding.kind = 'git'` rows even when target_id equals the provider id.
- Report every blocker; do not rely on the foreign-key exception as behavior.
- Keep this story coupled to Stories 4, 5, 7 and 8.

## Verify

- Add `src/commands/provider/remove-provider.test.ts` with real SQLite fixtures for unknown id, all four categories, two project bindings, two repositories, two attempts, ignored git binding, success and event rollback.
- For all four categories, assert exact blocker order and assert the provider row remains.
- Use ids whose lexical order differs from insertion order; assert each repeated category follows `Buffer.compare` order.
- For the two-repository fixture, insert the larger repository id first and assert both repository blockers return in ascending `Buffer.compare` order.
- Assert unblocked success deletes one provider, returns only id and appends one `provider.removed` event with every envelope field and exact name-kind payload.
- Force append failure and assert the provider remains.
- Update `src/http/contract/error-details.test.ts:84-113` to parse all four kinds and reject an attempt blocker without attemptId.
- Add `src/http/server/credential/remove-provider.test.ts` with real Koa tests for 200 `{ id }`, 404 and 409 with the exact blocker array.
- Run `node --test src/commands/provider/remove-provider.test.ts src/http/contract/error-details.test.ts` during the coupled batch.
- After Story 8, run `node --test src/commands/provider/remove-provider.test.ts src/http/server/credential/remove-provider.test.ts`; it exits 0.
- After Story 8, run `npm run verify`; it exits 0.
- Proof: EPIC Proof lines 38, 40 and 45, plus Hermetic coverage lines 61-65.
