# Story 2 — Provider view domain type

Epic: `.agents/plan/epics/101-credential-registry-completion.md`
Depends on: EPIC 100.

## Change

- Add `src/domain/provider-view.ts` with only the exported `ProviderView` type.
- Import `ProviderKind` and `ProviderProjection` from `src/domain/provider-payload.ts` as types.
- Define exact fields `id`, `name`, `kind`, `projection`, `setDefaultAt` and `updatedAt`; set `projection` to `ProviderProjection | null`.
- Remove the local `ProviderView` and unused `ProviderProjection` import from `src/commands/provider/register-provider.ts:6-36`; import `ProviderView` from domain.
- Change the `ProviderView` imports in `src/http/server/credential/register-provider.ts:4-7`, `src/http/server/credential/register-provider.test.ts:7-10` and `src/commands/provider/register-provider.test.ts:24-28` to domain.

## Constraints

- Keep `src/domain/provider-view.ts` type-only and pure.
- Do not change the private query result types in `src/queries/provider/list-provider.ts` or `src/queries/provider/show-provider.ts`.
- Do not add runtime validation; `src/http/contract/credential.ts:19-26` remains the transport schema.

## Verify

- Add `src/domain/provider-view.test.ts` with a `ProviderView` fixture whose projection is null and exact keys sort to `["id", "kind", "name", "projection", "setDefaultAt", "updatedAt"]` through `Buffer.compare`.
- Run `node --test src/domain/provider-view.test.ts src/commands/provider/register-provider.test.ts src/http/server/credential/register-provider.test.ts`; it exits 0 before the coupled route batch starts.
- Run `npm run verify`; it exits 0.
- Proof: EPIC Proof lines 38, 40 and 45, plus the strict provider-view shape of Hermetic coverage line 67.
