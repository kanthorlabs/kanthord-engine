# Story 7 — Instantiate and import, each in one storage transaction

Epic: `.agent/plan/epics/103-repository-profile-and-templates.md`
Depends on: Stories 1 through 6, and coupled Stories 8, 9 and 10.

## Change

### Shared refusal shape

- Add `src/commands/profile/profile-invalid.ts` exporting `ProfileInvalidError extends Error` with `readonly findings: readonly ProfileFinding[]` and `name = "ProfileInvalidError"`, and message `the profile document is invalid`.
- Both commands throw it, and Story 10 maps it to `422 profile-invalid` with `details.findings` equal to the sorted list.

### instantiate

- Add `src/commands/profile/instantiate-profile.ts`.
- Export `InstantiateProfileDependencies = Readonly<{ storage: Storage; profiles: ProfileStore; blobs: BlobStore; ids: IdGenerator; clock: Clock; events: EventLog }>`.
- Export `InstantiateProfileInput = Readonly<{ repositoryId: string; templateId: string; checks: Readonly<Record<string, ProfileCheck>> | null; actor: string }>`.
- Export `InstantiateProfileResult = Readonly<{ document: string; contentHash: string }>`.
- Export `InstantiateProfileRefusal = "repository-not-found" | "profile-exists"` and `InstantiateProfileError` carrying `refusal`, `message` and `readonly contentBlob: string | null`, following `RegisterProviderError` at `src/commands/provider/register-provider.ts:31-39`. Set `contentBlob` to the existing content hash for `profile-exists` and to `null` for `repository-not-found`; Story 10 puts it in the `illegal-transition` details.
- Refuse an unknown `templateId` before anything else by throwing `ProfileInvalidError` with the single finding `template-unknown`, locator equal to the supplied id, message `template <id> is unknown`.
- Merge the checks map: start from `nodejsTemplate.checks`, then for each name in the supplied `checks` replace the whole entry for that name. A supplied `e2e` adds the entry; a supplied `unit` replaces it entirely. A `null` `checks` keeps the template map unchanged.
- Validate the merged map through `validateChecks` of `src/domain/profile-check.ts`. Throw `ProfileInvalidError` with every finding when the list is not empty, so a confirmed field passes the same rules and the same vacuous-command lint as an imported one.
- Compute `digest = blobs.hash(canonicalTemplatePayload)`. Build the document as `templateProfileDocument(digest)` with its `checks` replaced by the merged map.
- Render it through `renderProfileBytes`, and compute `contentHash = blobs.hash(bytes)`.
- Open exactly one `storage.transact`. Mint the id and read the clock **inside** it, after both refusals, exactly as the EPIC states: "inside one `storage.transact` writes the blob through `BlobStore.put`, mints the id through `ids.mint("profile")`, writes the row with `updated_at` from `clock.now()`". A refused call therefore consumes no id and no clock reading, which keeps a fake generator's call count deterministic.
- Inside the transaction, in this order: refuse `repository-not-found` when `SELECT id FROM repository WHERE id = ?` returns `undefined`, with message `no repository <id>`; refuse `profile-exists` when `profiles.read(transaction, repositoryId)` is not `null`, with message `repository <id> already holds profile <contentBlob>`, naming the existing content hash; call `blobs.put(transaction, bytes)`; mint `id = ids.mint("profile")`; read `updatedAt = clock.now()`; call `profiles.upsert(transaction, { id, repositoryId, contentBlob: contentHash, updatedAt })`; call `events.append` with the `profile.instantiated` envelope of Story 8.
- Return `{ document, contentHash }` after the transaction commits.

### import

- Add `src/commands/profile/import-profile.ts`.
- Export `ImportProfileDependencies` as the instantiate dependencies plus `reader: DocumentReader`.
- Export `ImportProfileInput = Readonly<{ repositoryId: string; document: string; fromHash: string | null; actor: string }>`.
- Export `ImportProfileResult` equal to `InstantiateProfileResult`.
- Export `ImportProfileRefusal = "repository-not-found" | "stale-revision"` and `ImportProfileError` carrying `refusal`, `message`, `readonly expected: string | null` equal to the supplied `fromHash`, and `readonly current: string | null` equal to the stored `content_blob` or `null`. Story 10 puts both in the `stale-revision` details, whose schema is `staleRevisionDetails` at `src/http/contract/error-details.ts:9-12`.
- Call `reader.read(input.document)` inside a `try`. Catch `DocumentError` of `src/services/document/index.ts:11-19` and throw `ProfileInvalidError` with the single finding `document-unparsable`, locator `null`, message equal to the caught error's message.
- Call `parseProfile(frontmatter, body)` of `src/domain/profile-parse.ts` and collect its findings and its `template` triple.
- Compare the triple against what the daemon ships when `template` is not `null`, and append a finding for each mismatch. Set `locator` to `null` on all three, because `docs` and the EPIC define a locator as a check name or a role heading, and a template id is neither. Use these exact messages: `template-unknown` — `template <id> is unknown`; `template-version-unknown` — `template nodejs has no version <version>`; `template-digest-mismatch` — `the template digest does not match the shipped template`.
- An `id` other than `nodejs` gives `template-unknown`; a `version` other than `1.0.0` gives `template-version-unknown`; a `digest` other than `blobs.hash(canonicalTemplatePayload)` gives `template-digest-mismatch`. Skip the comparison entirely when `template` is `null`.
- Throw `ProfileInvalidError` with `sortProfileFindings` of the combined list when it is not empty.
- Re-render the accepted document through `renderProfileBytes`, and compute `contentHash = blobs.hash(bytes)`. The stored blob is therefore canonical, so Story 9 can copy bytes.
- Open exactly one `storage.transact`, and mint the id and read the clock inside it, after every refusal, as instantiate does.
- Inside the transaction, in this order: refuse `repository-not-found` when the repository row is absent; read `existing = profiles.read(transaction, repositoryId)`; refuse `stale-revision` when `existing === null && input.fromHash !== null`, when `existing !== null && input.fromHash === null`, or when `existing !== null && existing.contentBlob !== input.fromHash`, with message `the profile moved to <existing contentBlob or none>`; call `blobs.put(transaction, bytes)`; read `updatedAt = clock.now()`; call `profiles.upsert(transaction, { id: existing?.id ?? ids.mint("profile"), repositoryId, contentBlob: contentHash, updatedAt })`, so an id is minted only when no row exists yet; call `events.append` with the `profile.imported` envelope of Story 8, whose `fromBlob` is `existing?.contentBlob ?? null`.
- Return `{ document, contentHash }`, where `document` is the re-rendered text, not the submitted text.

## Constraints

- Do not open two transactions in either command. The row write and its event append commit together, so a thrown `EventLog.append` rolls the blob, the row and the event back as one.
- Do not write the old blob away. `blobs.put` at `src/services/blob/sqlite.ts:24-31` is `INSERT ... ON CONFLICT(hash) DO NOTHING`, so the previous document stays under its own hash and anything that cited it keeps its meaning.
- Do not read a working tree, a file or a network. The database is canonical.
- Do not import a query, another command or a vendor package. `commands/` imports `domain/` and service interfaces only.
- Do not branch on a domain rule outside `src/domain/`; the merge, the validation and the render all call into `domain/`.
- Do not call `clock.now()` more than once per command; the row timestamp and any payload field share the one value.

## Verify

- Add `src/commands/profile/instantiate-profile.test.ts` and `src/commands/profile/import-profile.test.ts`, both on real temporary SQLite through `createMigratedStorage` of `test/helpers/database.ts:31`, with `seedRegistry` of `test/helpers/rows.ts` and `after(() => dispose())`.
- Construct the command `clock` as `createMockClock({ start: 1700000000000 })` with no `step`, so every call returns `1700000000000`. The storage helper wires its own clock with `step: 1000` at `test/helpers/database.ts:36`, and the blob store consumes clock calls; a shared stepping clock would make the row timestamp depend on call count.
- Construct `ids` as `createMockIdGenerator` of `test/helpers/ids.ts` with a fixed ULID list long enough for every mint the test drives. `SqliteEventLog.append` mints an `event` id from the same generator, so one successful instantiate consumes two ids, and each further import consumes one or two. Supply at least four ULIDs for a multi-step test, and assert the exact minted profile id.
- `seedRegistry` of `test/helpers/rows.ts:21-30` inserts **three** `blob` rows. Never assert `SELECT COUNT(*) FROM blob` equals `0`. Assert instead `SELECT COUNT(*) FROM blob WHERE hash = ?` equals `0` for the hash of the document under test, and compare the total against a baseline read before the command.
- Assert an instantiated `nodejs` profile writes exactly one `profile` row whose `updated_at` equals `1700000000000`.
- Assert the returned `document` equals the exact expected text, compared with `Buffer.compare` equal to `0`, and that `contentHash` matches `/^sha256:[0-9a-f]{64}$/`.
- Assert the recorded template digest matches `/^sha256:[0-9a-f]{64}$/` and equals `blobs.hash(canonicalTemplatePayload)`.
- Assert `checks: { unit: { run: ["npm", "run", "test:ci"], timeout: "5m" } }` produces a document whose `unit` entry is `["npm", "run", "test:ci"]` and `5m`, and not the template `["npm", "test"]` and `10m`.
- Assert supplying only `e2e` keeps the template `unit` entry and adds the `e2e` entry.
- Assert `checks: { unit: { run: ["true"], timeout: "10m" } }` throws `ProfileInvalidError` whose `findings` is exactly one entry, `check-cannot-fail` with locator `unit`, and that `SELECT COUNT(*) FROM profile` is `0`, `SELECT COUNT(*) FROM event` is `0`, and the total `blob` count equals the pre-command baseline.
- Assert instantiate on a repository that already holds a profile throws `InstantiateProfileError` with refusal `profile-exists`, that the message holds the existing content hash, and that the stored `content_blob` is unchanged.
- Assert instantiate on an absent repository throws refusal `repository-not-found` and writes nothing.
- Assert atomicity: with an `EventLog` whose `append` throws, instantiate leaves zero `profile` rows, zero `event` rows, and a `blob` count equal to the pre-command baseline, with `SELECT COUNT(*) FROM blob WHERE hash = ?` equal to `0` for the document hash. Mirror the technique of `src/services/event/atomicity.test.ts:38-70`.
- Assert import of the exact bytes instantiate returned, with the matching `fromHash`, leaves `content_blob` equal to the same hash and returns identical bytes.
- Assert import of an edited document with the matching `fromHash` moves `content_blob`, keeps the original `profile.id`, and leaves the old blob readable under its own hash with its exact original bytes, compared with `Buffer.compare` equal to `0`.
- Assert atomicity: with an `EventLog` whose `append` throws, import leaves `content_blob` equal to the exact hash instantiate returned, leaves zero `blob` rows for the hash of the new document, leaves zero `event` rows of type `profile.imported`, and leaves the old blob holding the exact bytes of the instantiated document under that same unchanged hash.
- Assert import with a stale `fromHash` throws refusal `stale-revision` and leaves `content_blob` unchanged.
- Assert import with `fromHash` of `null` onto a repository that already holds a profile throws `stale-revision`.
- Assert the first import of a repository with `fromHash` of `null` succeeds and writes one row.
- Assert import of a document whose template id is `python` and whose unit command is `["true"]` throws `ProfileInvalidError` whose findings are exactly `check-cannot-fail` then `template-unknown`, in that order.
- Assert import of a document whose template version is `2.0.0` returns `template-version-unknown`, and one whose digest is `sha256:` plus sixty-four `b` characters returns `template-digest-mismatch`.
- Assert import of text with no frontmatter delimiter throws `ProfileInvalidError` with the single finding `document-unparsable`.
- Assert import of a `true` unit command **over an existing profile**, with the matching `fromHash`, returns exactly one finding, `check-cannot-fail` with locator `unit`, and leaves the `profile` row unchanged: the same `id`, the same `content_blob` and the same `updated_at` as before the call. This is the "the `profile` row is unchanged" half of Hermetic coverage line 59, which the instantiate tests cannot show.
- Assert import of a document whose role prose is non-ASCII round-trips byte for byte through a following export, compared with `Buffer.compare`.
- Run `node --test src/commands/profile/instantiate-profile.test.ts src/commands/profile/import-profile.test.ts`; both exit 0.
- After Story 10, run `npm run verify`; it exits 0.
- Proof: EPIC Proof line 47, plus Hermetic coverage lines 52, 53, 54, 56, 64, 69, 70, 71 and 77.
