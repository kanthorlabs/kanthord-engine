# Story 1 — `llmPayload` becomes strict

Epic: `.agent/plan/epics/021-provider-contract-and-default-transfer.md`

## Change

- Edit `src/domain/provider-payload.ts:9-14`. Wrap the existing `z.object({ provider, apiKey, defaultModel, baseUrl })` in `.strict()`, so the declaration reads `z.object({ … }).strict()`. Change no field, no order and no validator inside the object.
- Change no other schema in the file. `gitHttpBasicPayload:17-24` and `gitSshPayload:26-31` already carry `.strict()`.
- Change `payloadSchemaFor`, `parsePayload`, `serializePayload`, `deserializePayload` and `projectPayload` in no way.

## Constraints

- Add no `.strict()` and no `.strictObject()` anywhere else in the tree.
- Edit no test in this story other than the one named in Verify.
- Do not change the `PayloadError` class, its refusal union or its `detail` construction. The unrecognized-key `detail` comes from the existing `parsePayload` failure path, not from a new branch.

## Verify

- Add one test to `src/domain/provider-payload.test.ts`, inside the existing `describe("the llm payload")` suite at line 134, named `"refuses an unrecognized key"`. It asserts that `parsePayload("llm", { provider: "openai", apiKey: "k", defaultModel: "gpt-5", baseUrl: null, apikey: "k" })` throws a `PayloadError` whose `refusal` is `"payload-invalid"` and whose `detail` is exactly `'.Unrecognized key: "apikey"'`. That exact string is measured, not guessed: zod reports an unrecognized key with an empty `path` and the message `Unrecognized key: "apikey"`, and `parsePayload` at `src/domain/provider-payload.ts:100-105` builds the detail as `` `${firstIssue.path.join(".")}.${firstIssue.message}` ``, so the leading dot is real. Do not change that construction to remove the dot; that is a transport-wide format decision outside this epic.
- Add one test to the same suite named `"llmPayload rejects an unrecognized key through safeParse"`, asserting `llmPayload.safeParse({ provider: "openai", apiKey: "k", defaultModel: "gpt-5", baseUrl: null, extra: 1 }).success === false`.
- Keep every existing test in `src/domain/provider-payload.test.ts` passing unchanged. The suites `"canonical serialization, exact bytes"` and `"the public projection"` are the regression guard: `.strict()` must not change any serialized byte or any projection.
- Run `node --test --test-timeout=60000 src/domain/provider-payload.test.ts`; it exits 0.
- Run `node --test --test-timeout=60000 src/commands/provider/*.test.ts`; it exits 0, which proves `registerProvider` still accepts every payload the phase-1 tests send.
- Run `npm run verify`; it exits 0.
- Proof: `PASS EPIC-021` for `src/domain/provider-payload.test.ts`.
