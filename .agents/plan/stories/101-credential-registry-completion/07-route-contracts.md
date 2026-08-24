# Story 7 — Route provider management

Epic: `.agents/plan/epics/101-credential-registry-completion.md`
Depends on: coupled Stories 4 through 6 and 8.

## Change

- In `src/http/contract/credential.ts:13-32`, add strict `providerRenameRequest` with non-empty name, aliases `providerRenameResponse` and `providerSetDefaultResponse` to `providerView`, and strict `providerRemoveResponse` with id only.
- Add `providerRenameExamples` with request `{ name: "github-release" }`, the existing git success view renamed to `github-release`, and invalid-request `name-taken` with message `a provider named github-release is already registered`.
- Add `providerRemoveExamples` with success id `provider_${U}` and binding-in-use error message `provider provider_${U} is still in use`.
- Set its blockers exactly to default-chain, project-binding with `project_${U}`, repository with `repository_${U}` and attempt with `attempt_${U}`, in that order.
- Add `providerSetDefaultExamples` with an LLM success named `openai`, projection `{ provider: "openai", defaultModel: "gpt-4o", baseUrl: null }`, and both timestamps `A`.
- Give the setDefault example an invalid-request `kind-not-chainable` error with message `provider provider_${U} of kind git cannot join the default chain` and no detail or ids.
- Set `provider.rename`, `provider.remove` and `provider.setDefault` at `src/http/contract/credential.ts:111-133` to routed without changing method, path, phase, idempotency or replayability.
- Give rename its request, response, baseline errors and examples. Give setDefault its response, baseline errors and examples.
- Give remove its response, baseline errors plus `"binding-in-use": bindingInUseDetails`, and examples; import `bindingInUseDetails` from `error-details.ts`.
- In `docs/proposal/api/credential.md:20-22`, change only the three lifecycle cells from stubbed to routed.
- Update contract inventories and generated-field fixtures for one new request and three new responses.

## Constraints

- Keep every other phase-2 operation stubbed.
- Keep all request and response schemas strict.
- Preserve `provider.rename` memory idempotency and replayable status 200.
- Keep this story coupled to Stories 4 through 6 and 8.

## Verify

- Update `src/http/contract/parity.test.ts` through the proposal table and assert no parity mismatch.
- Update `src/http/contract/registry.test.ts:34-43,83-122` and `src/http/contract/system.test.ts:317-362` to expect 27 routed, 27 stubbed, eight requests and 26 responses; include the three operation ids in bytewise lists.
- Update `src/http/contract/coverage.test.ts:359-388` and `src/http/server/dispatch.test.ts:428-460` to expect 27 stubs.
- Update `src/http/server/app.test.ts:363-369` to expect 25 unimplemented ids when only health and db are bound.
- Update `src/http/contract/openapi.test.ts:205-265` to expect 60 components and insert `provider.rename.{error,request,response}`, `provider.remove.{error,response}` and `provider.setDefault.{error,response}` in bytewise order.
- Update `src/http/contract/field-decisions.fixture.ts:125-164`: add the rename request name row; copy register response rows 141-152 with rename and setDefault prefixes; add remove response id.
- Add direct schema tests in `src/http/contract/credential.test.ts` for valid examples, empty rename name, extra request keys, extra success keys and exact remove keys.
- During the coupled batch, run `node --test src/http/contract/*.test.ts`; contract tests exit 0 after their pinned counts change.
- After Story 8, run `npm run verify`; it exits 0.
- Proof: EPIC Proof lines 40 and 45, plus Hermetic coverage lines 66-68.
