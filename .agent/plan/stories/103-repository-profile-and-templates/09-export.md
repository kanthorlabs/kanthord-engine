# Story 9 — Export

Epic: `.agent/plan/epics/103-repository-profile-and-templates.md`
Depends on: Story 6, and coupled Stories 7, 8 and 10.

## Change

- Add `src/queries/profile/export-profile.ts`, following the shape of `src/queries/plan/export-plan.ts:41-46`.
- Export `ExportProfileDependencies = Readonly<{ storage: Storage; profiles: ProfileStore; blobs: BlobStore }>`.
- Export `ExportProfileInput = Readonly<{ repositoryId: string }>` and `ExportProfileResult = Readonly<{ document: string; contentHash: string }>`.
- Export `ExportProfileRefusal = "not-found"` and `ExportProfileError` carrying `refusal` and `message`, following `ExportPlanError` at `src/queries/plan/export-plan.ts:21-28`.
- Run the whole read inside one `storage.transact`.
- Read the row through `profiles.read(transaction, repositoryId)`. Throw the refusal below when it is `null`.

  ```ts
  throw new ExportProfileError(
    "not-found",
    `no profile for repository ${repositoryId}`,
  );
  ```

- Read the blob through `blobs.get(row.contentBlob, transaction)`. Throw a plain `Error` with message `blob ${row.contentBlob} is missing from the store` when it is `null`, matching `src/queries/plan/export-plan.ts:76-79`.
- Decode the blob content with one module-level `const decoder = new TextDecoder()` and return `{ document: decoder.decode(record.content), contentHash: row.contentBlob }`.
- Render nothing. The stored blob is already canonical, so export is a byte copy and the round trip cannot drift.
- Add no error code for the refusal. `not-found` already sits at status `404` in `errorStatuses` of `src/http/contract/errors.ts:12`.

## Constraints

- Do not import `src/domain/profile-render.ts`; export never re-renders.
- Do not import a command or another query.
- Do not distinguish an absent repository from an absent profile; both answer `not-found`.
- Do not open a second transaction for the blob read; pass the caller's transaction to `blobs.get`.

## Verify

- Add `src/queries/profile/export-profile.test.ts` on real temporary SQLite through `createMigratedStorage` of `test/helpers/database.ts:31`, with `after(() => dispose())`.
- Assert `exportProfile` on a repository with no profile throws `ExportProfileError` with refusal `not-found`.
- Assert `exportProfile` on an unknown repository id throws the same refusal.
- Assert export after instantiate returns bytes identical to the document instantiate returned, compared with `Buffer.compare` equal to `0`, and a `contentHash` equal to the stored `content_blob`.
- Assert export, then import of those same bytes with the matching `fromHash`, then export again returns identical bytes with `Buffer.compare` equal to `0`, and that `content_blob` is unchanged across the three calls.
- Assert a profile whose role prose is non-ASCII exports byte for byte, compared with `Buffer.compare`.
- Assert a profile declaring `unit` and `e2e` exports `e2e` before `unit`, found by `indexOf` on the exported text.
- Assert a profile whose `unit` run is `["npm", "run", "test:unit"]` exports those three elements in that order, and not sorted.
- Assert export performs no write: `SELECT COUNT(*) FROM event` and `content_blob` are unchanged after the call.
- Run `node --test src/queries/profile/export-profile.test.ts`; it exits 0.
- Proof: EPIC Proof line 47, plus Hermetic coverage lines 53, 56, 57, 58, 69 and 74.
