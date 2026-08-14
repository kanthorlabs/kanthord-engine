# Story 9 — The actor routes

Epic: `.agent/plan/epics/015-actor-identity.md`
Depends on: Story 1, Story 7 (`allowedActors` is required), Story 8.

## Change

- `src/http/contract/path.ts:3-17`: add `"actor"` to `resourceSegments`, in the position the existing order implies (the list is alphabetical: before `"agent"`). The segment is singular, which `registryFaults` enforces.
- `src/http/contract/path.ts:36-52`: add `"revoke"` and `"rotate"` to `actionSegments`, keeping the list alphabetical — `revoke` after `resolve`, `rotate` after `revoke`. Do not reuse `agent`: `docs/proposal/api/instruction.md` binds it to the agent-role concept, and one segment naming two concepts is a contract defect.
- Create `src/http/contract/actor.ts`, following the structure of `src/http/contract/credential.ts` (the module that holds the `provider.*` rows; there is no `provider.ts`). It exports the schemas and the `operations([...])` array named `actor`.
  - `export const actorRegisterRequest = z.strictObject({ name: z.string().regex(actorNamePattern) });` — the request carries `{ name }` and **no** `kind` field.
  - `export const actorRotateRequest` is **not declared**; the `actor.rotate` row carries no `request`, because the id in the path is the only input.
  - `export const actorView = z.strictObject({ id: identity("actor"), kind: z.enum(registeredActorKinds), name: z.string(), registeredBy: identity("actor").nullable(), createdAt: z.int(), revokedAt: z.int().nullable(), revokedBy: identity("actor").nullable() });` — it carries **no** `token` field and no digest field, which is the rule `providerView` already follows.
  - `export const actorTokenPattern = /^actor_[0-7][0-9A-HJKMNP-TV-Z]{25}\.[A-Za-z0-9_-]{43}$/;` — the **whole-token** pattern, declared once in this file as one literal regex. Its halves restate `ulidPattern` (`src/domain/identity.ts:45`) and `actorSecretPattern` (`src/domain/actor.ts`) rather than composing them, because `z.string().regex()` takes one complete pattern and assembling one from two `.source` fragments is less readable than the literal. `http/contract/` **may** import `domain/`, so this is a readability choice and not a boundary constraint — and the drift it risks is closed by the consistency assertion in Verify below, which is why the duplication is safe.
  - `export const actorRegisterResponse = actorView.extend({ token: z.string().regex(actorTokenPattern) });` — the view plus exactly one extra field.
  - `export const actorRotateResponse = actorRegisterResponse;`
  - `export const actorShowResponse = actorView;`
  - `export const actorListResponse = z.strictObject({ actors: z.array(actorView) });`
  - One `OperationExamples` constant per operation, reusing `EXAMPLE_AT` and `EXAMPLE_ULID` from `./example-literal.ts`.
- The five rows, each `introducedIn: "phase-1"`, `status: "routed"`, `allowedActors: ["human"]`, `errors: { ...baselineErrors }`:

  | operationId      | method | path segments                                                     |
  | ---------------- | ------ | ----------------------------------------------------------------- |
  | `actor.register` | POST   | `[resource("actor")]`                                             |
  | `actor.list`     | GET    | `[resource("actor")]`                                             |
  | `actor.show`     | GET    | `[resource("actor"), parameter("id", "actor")]`                   |
  | `actor.revoke`   | POST   | `[resource("actor"), parameter("id", "actor"), action("revoke")]` |
  | `actor.rotate`   | POST   | `[resource("actor"), parameter("id", "actor"), action("rotate")]` |

  The three `POST` rows each declare `idempotency: "memory"`, `replayable: [200]` and `successStatus: 200`. `actor.list` and `actor.show` declare no `idempotency`. All five declare `allowedActors: ["human"]`: a harness never manages an actor, and a harness never rotates its own token.

- `src/http/contract/registry.ts`: import `actor` from `./actor.ts` and add `...actor` to the spread at `:24-37`. The array is sorted bytewise by `operationId` afterwards, so the position in the spread does not matter.
- Create `docs/proposal/api/actor.md`, following the structure of `docs/proposal/api/credential.md`: a title, the route table holding the five rows with their lifecycle `routed` and phase `phase-1`, then one subsection per operation. `test/helpers/proposal.ts:57` reads every `.md` of that directory except `README.md` and `new-decisions.md`, so the new file enters parity with no helper change.
- `docs/proposal/api/README.md:27-39`: add the `actor.md` line to the domain table, in the position the existing order implies.

## Constraints

- Do not amend the `## The actor` section at `docs/proposal/api/README.md:144-148`. EPIC 014 owns that amendment (`015-actor-identity.md:15`).
- Every path segment comes from a closed set and the resource segment is singular. `registryFaults` in `src/http/contract/registry.ts` fails the build on a plural resource, a free-form segment or an ambiguous path.
- `actor.list` and `actor.show` return the view with no token field. A token appears in exactly two response schemas in the whole contract.
- Declare no query schema on any of the five. `actor.list` takes no filter and no cursor in this epic.
- Bind no handler here. Story 12 binds all five; a routed row with no handler answers `501`, which `src/http/server/app.ts:129-156` admits.

## Verify

- Update these pinned counts, each of which this story moves:
  - `src/http/contract/registry.test.ts:20` and `:25`: 54 → **59**. Update the `it(...)` titles that state the number.
  - `src/http/contract/registry.test.ts:34-42`: routed 27 → **32**; stubbed stays **27**.
  - `src/http/contract/parity.test.ts:16`: 54 → **59**. `:25`: 58 → **63**. The deferred proposal row count stays **4** and its pinned list at `:27-32` is unchanged.
  - `src/http/contract/coverage.test.ts:332`: `scoped.length` 23 → **28**, and its `it(...)` title. This pin counts phase-1 routed operations other than `blob.show` that carry a response schema; all five new rows are phase-1 routed with a response schema. **The EPIC does not name this pin.**
  - `src/http/contract/coverage.test.ts:359-361`: stubbed stays **27**; no edit.
  - `src/http/contract/field-decisions.fixture.ts`: add one row per field of every new authored schema, in the bytewise-sorted position each belongs to. `coverage.test.ts:286` compares the fixture with a freshly walked registry, so run the test once, read the diff and insert exactly the rows it reports.
- `src/http/contract/path.test.ts`: add `"actor"` to any pinned resource-segment list and `"revoke"`/`"rotate"` to any pinned action-segment list, and update the counts and titles those cases state.
- Create `src/http/contract/actor.test.ts`, suite name `src/http/contract/actor.test`, asserting:
  - The five rows exist with the exact method and rendered path of the table above, through `renderPath`.
  - All five declare `allowedActors` deep-equal to `["human"]`.
  - The three `POST` rows declare `idempotency: "memory"` and `replayable: [200]`; the two `GET` rows declare no `idempotency`.
  - `actorRegisterRequest` rejects a body carrying a `kind` key, rejects an uppercase name, a leading-hyphen name and a 64-character name, and accepts a 63-character name.
  - `actorRegisterResponse` accepts a body whose `token` is a well-formed whole token, and rejects one whose `token` is a bare 43-character secret with no `actor_` prefix.
  - **The drift guard for the duplicated pattern.** `actorTokenPattern` must accept exactly what the domain produces and the domain parser accepts. Assert it matches `renderActorToken({ actorId: bootstrapActorId, secret: S })` and `renderActorToken({ actorId: "actor_" + <a valid ULID>, secret: S })`, where `S` is a module-level 43-character base64url literal that includes both `-` and `_`. Assert that each accepted string also satisfies `parseActorToken` (non-null), and that a secret of 42 and of 44 characters is rejected by both `actorTokenPattern` and `parseActorToken`. This assertion fails if either domain pattern later changes, which is what makes the restatement safe. Import only `src/domain/actor.ts` and `src/domain/identity.ts` here — a contract test may not reach the `secret` implementation, so do not call `generate()`.
  - `actorView` rejects a body carrying a `token` key, and rejects one carrying a `tokenSha256` key.
- **No route returns a token except `actor.register` and `actor.rotate`.** Add a case to `src/http/contract/coverage.test.ts` that walks every authored `response` schema in the registry with `z.toJSONSchema(schema, { target: "openapi-3.0", io: "output" })`, collects every operation id whose walked schema holds a property named `token` at any depth, and asserts the sorted result deep-equals `["actor.register", "actor.rotate"]`. Reuse the recursive walker the `fieldRows` case at `:190-287` already defines.
- Run `node --test --test-timeout=60000 src/http/contract/*.test.ts`; each exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-015`, and Hermetic coverage lines 115 and 127.
