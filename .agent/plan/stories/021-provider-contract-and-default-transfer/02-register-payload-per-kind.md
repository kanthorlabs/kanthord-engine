# Story 2 — `provider.register` declares its payload per kind

Epic: `.agent/plan/epics/021-provider-contract-and-default-transfer.md`
Depends on: Story 1.

## Change

- Edit the import at `src/http/contract/credential.ts:8-11`. Add `gitPayload` and `llmPayload` to the existing named import from `../../domain/provider-payload.ts`, keeping `providerKinds` and `providerProjection`. Keep the members in the alphabetical order the formatter produces: `gitPayload`, `llmPayload`, `providerKinds`, `providerProjection`.
- Replace `providerRegisterRequest` at `src/http/contract/credential.ts:35-39` with

```ts
export const providerRegisterRequest = z.discriminatedUnion("kind", [
  z.strictObject({
    name: z.string().min(1),
    kind: z.literal("llm"),
    payload: llmPayload,
  }),
  z.strictObject({
    name: z.string().min(1),
    kind: z.literal("git"),
    payload: gitPayload,
  }),
]);
```

The `llm` branch is index 0 and the `git` branch is index 1. That order is load bearing: the emitted `oneOf` branch order is asserted.

- Change `password` to `token` at `src/http/contract/credential.ts:73`, inside `providerRegisterExamples.request.payload`. Change no other key and no other example.
- Change `providerView`, `providerRegisterResponse`, `providerRenameRequest`, `providerRemoveResponse` and every other schema in the file in no way.
- Change the `provider.register` registry entry in no way: its method, its `path`, its `introducedIn` of `phase-1`, its `status` of `routed`, its `idempotency` of `memory`, its `replayable` and its `errors` all stay as they are.
- Regenerate `src/http/contract/field-decisions.fixture.ts` by running `node scripts/field-decisions-probe.mjs --write`. Never hand-edit that file.

## Constraints

- `src/http/server/credential/register-provider.ts` changes in no way. See Story 4.
- Import `llmPayload` and `gitPayload` only. Do not import `gitHttpBasicPayload` or `gitSshPayload`, and do not restate either git branch inside `credential.ts`.
- Follow the union style already in the tree at `src/http/contract/graph.ts:179-182`, which discriminates on `"kind"` over `z.strictObject` members.
- Add no `.refine`, no `.superRefine` and no transform. The OpenSSH cipher rules stay in `src/domain/provider-payload.ts:201-220` and reach the client through the command, not the contract.
- The regenerated fixture must show the row `"provider.register.request#/properties/payload required=true nullable=false enum=-"` at line 251 gone, the two rows for `name` and `kind` moved under union pointers, and every new `provider.register.request` row carrying a pointer prefix of `provider.register.request#/oneOf/0/properties/` or `provider.register.request#/oneOf/1/properties/`. The prefix is `oneOf`, not `anyOf`: `src/http/contract/field-decisions.fixture.ts:64-69` shows the existing union emitting `#/properties/node/oneOf/0/…`. The `kind` rows must read `enum=llm` and `enum=git`. A regenerated fixture holding any other `provider.register.request` pointer prefix is a wrong regeneration.

## Verify

- Add these tests to `src/http/contract/credential.test.ts`, inside the existing `describe("src/http/contract/credential.test")` suite:
  - `"the register request refuses a git payload naming password"` — `providerRegisterRequest.safeParse({ name: "github", kind: "git", payload: { transport: "http-basic", forge: "github", username: "atlas", password: "x" } }).success === false`, and the same object with `token: "x"` in place of `password: "x"` parses successfully.
  - `"the register request refuses an unrecognized llm payload key"` — `providerRegisterRequest.safeParse({ name: "bot", kind: "llm", payload: { provider: "openai", apiKey: "k", defaultModel: "gpt-5", baseUrl: null, apikey: "k" } })` fails; `result.error.issues[0].code === "unrecognized_keys"`; `result.error.issues[0].path` deep-equals `["payload"]`; and `result.error.issues[0].keys` deep-equals `["apikey"]`. **The EPIC's Hermetic coverage bullet 2 states the path is `["payload", "<the extra key>"]`, and that is wrong**: zod reports an `unrecognized_keys` issue against the object that holds the key, and names the key in `keys`. The measured value is authoritative; assert it, not the EPIC's text.
  - `"the register request refuses each half of the kind and payload cross product"` — an `llm` kind carrying `{ transport: "http-basic", forge: "github", username: "atlas", token: "x" }` fails, and a `git` kind carrying `{ provider: "openai", apiKey: "k", defaultModel: "gpt-5", baseUrl: null }` fails.
  - `"the emitted register request carries two branches and the nested transport branches"` — with `const emitted = z.toJSONSchema(providerRegisterRequest, { target: "openapi-3.0", io: "input" })`, assert `Object.keys(emitted)` deep-equals `["oneOf"]`; `emitted.oneOf.length === 2`; `emitted.oneOf[0].properties.kind` deep-equals `{ type: "string", enum: ["llm"] }`; `emitted.oneOf[1].properties.kind` deep-equals `{ type: "string", enum: ["git"] }`; `emitted.oneOf[1].properties.payload.oneOf.length === 2`; and the two nested `transport` schemas are `{ type: "string", enum: ["http-basic"] }` then `{ type: "string", enum: ["ssh"] }`, in that order.
  - **The EPIC's Hermetic coverage bullet 4 says `anyOf` and `{ const: "llm" }`, and both are wrong for the `openapi-3.0` target.** The measured emission is `oneOf`, and a literal renders as `{ type: "string", enum: [...] }`. `src/http/contract/field-decisions.fixture.ts:64-69` already proves it for the existing union: its pointers read `node.create.request#/properties/node/oneOf/0/…` and its literal row reads `enum=initiative`. Assert the measured shape.
  - `"every object node of the emitted register request forbids an unknown key"` — walk the emitted tree over `properties`, `items`, `additionalProperties`, `anyOf`, `oneOf`, `allOf` and `$defs`, collect every node whose `type` is `"object"`, assert the collection has exactly five members, and assert every member carries `additionalProperties === false`. The five are: the two outer branches, the llm payload, and the two git transport objects. The `payload` node of the git branch carries `oneOf` and no `type`, so it is not collected — that matches `objectNodes()` at `src/http/contract/coverage.test.ts:52-90`, which keys on `type === "object"`. This is the assertion that pins Story 1's `.strict()` to an emitted value.
- Add one test to `scripts/publish-contract.test.ts`, named `"the published provider feature carries the two register request branches"`. Publish into a `mkdtemp` directory, read `features/provider.yaml` and parse it. The operation's `requestBody` content schema is a `$ref`, not the branches: assert first that it equals `{ $ref: "#/components/schemas/provider.register.request" }`, then resolve that pointer into `components.schemas["provider.register.request"]` and assert the resolved component carries exactly two `oneOf` branches whose `kind` enums are `["llm"]` then `["git"]`, and that branch 1's `payload` carries exactly two nested `oneOf` branches whose `transport` enums are `["http-basic"]` then `["ssh"]`. Remove the temporary directory in the same test. Reuse the publish and temp-directory helpers the file already uses; add no new dependency.
- Run `node scripts/field-decisions-probe.mjs` with no `--write`; it exits 0, which proves the committed fixture equals the live walk.
- Run `node scripts/publish-contract.ts "$(mktemp -d)"`; it exits 0.
- Run `node --test --test-timeout=60000 src/http/contract/credential.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/http/contract/parity.test.ts scripts/publish-contract.test.ts`; it exits 0. `example.test.ts` already parses the `provider.register` request example against its request schema, so it is the guard that the `token` fix is real.
- Run `npm run verify`; it exits 0.
- Proof: `PASS EPIC-021` for `src/http/contract/credential.test.ts`, `coverage.test.ts`, `openapi.test.ts`, `parity.test.ts` and `scripts/publish-contract.test.ts`, plus Hermetic coverage "The payload contract" bullets 1 to 4.
