# Story 8 — The two events

Epic: `.agent/plan/epics/103-repository-profile-and-templates.md`
Depends on: Story 7, and coupled Stories 9 and 10.

## Change

- Both envelopes are built inside the single `storage.transact` of `src/commands/profile/instantiate-profile.ts` and `src/commands/profile/import-profile.ts`, through `events.append(transaction, …)` of `src/services/event/index.ts:47`.
- Set `subjectKind` to `repository` and `subjectId` to the input repository id on both events. The profile row is one per repository, so the human reads the repository history.
- Set `actorKind` to `"human"` and `actorId` to the `actor` input on both events. `src/main.ts` stamps `settings.actor`, because `docs/proposal/api/new-decisions.md:31` states the actor comes from configuration and no request carries one.
- Set `type` to `profile.instantiated` in `instantiate-profile.ts`, with payload exactly `{ profileId, contentBlob, templateId, templateVersion, templateDigest }`, where `profileId` is the minted id, `contentBlob` is the computed content hash, `templateId` is `nodejs`, `templateVersion` is `1.0.0`, and `templateDigest` is the digest computed over `canonicalTemplatePayload`.
- Set `type` to `profile.imported` in `import-profile.ts`, with payload exactly `{ profileId, contentBlob, fromBlob }`, where `profileId` is the id the row now holds, `contentBlob` is the new content hash, and `fromBlob` is the previous `content_blob` or `null` for the first import of a repository.
- Append exactly one event per successful command. Neither command appends an event on a refusal.

## Constraints

- Do not put a timestamp in either payload. `AppendEventInput` at `src/services/event/index.ts:5-12` carries no timestamp, and `SqliteEventLog.append` derives `occurredAt` from the ULID, so a snapshot stays deterministic.
- Do not add a field to either payload. Every field is a value the command already holds.
- Do not append outside the command's transaction.
- Do not set `actorKind` to `"daemon"`; both operations are human-driven.

## Verify

- Assert in `src/commands/profile/instantiate-profile.test.ts` that after a successful instantiate, `events.list({ subject: repositoryId })` returns exactly one event.
- Assert that event has `subjectKind` `repository`, `subjectId` equal to the repository id, `type` `profile.instantiated`, `actorKind` `human`, and `actorId` equal to the exact actor string the test passed.
- Assert its payload deep-equals `{ profileId, contentBlob, templateId: "nodejs", templateVersion: "1.0.0", templateDigest }`, where `contentBlob` equals the content hash the command returned and `templateDigest` equals `blobs.hash(canonicalTemplatePayload)`.
- Assert the payload holds exactly those five keys, with `assert.deepEqual(Object.keys(payload).sort(), ["contentBlob", "profileId", "templateDigest", "templateId", "templateVersion"])`.
- Assert in `src/commands/profile/import-profile.test.ts` that the first import of a repository appends one `profile.imported` event whose payload `fromBlob` is `null`.
- Assert a second import appends a `profile.imported` event whose payload `fromBlob` equals the exact content hash the previous export returned, and whose `contentBlob` equals the new hash.
- Assert its payload holds exactly three keys, with `assert.deepEqual(Object.keys(payload).sort(), ["contentBlob", "fromBlob", "profileId"])`.
- Assert both events carry `actorKind` `human` and the configured actor.
- Assert a refused instantiate and a refused import each leave `SELECT COUNT(*) FROM event` unchanged.
- Run `node --test src/commands/profile/instantiate-profile.test.ts src/commands/profile/import-profile.test.ts`; both exit 0.
- Proof: EPIC Proof line 47, plus Hermetic coverage lines 78 and 79.
