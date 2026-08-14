# Story 1 — Actor vocabulary in `domain/`

Epic: `.agent/plan/epics/015-actor-identity.md`

## Change

- `src/domain/identity.ts`: append `"actor"` as the **last** member of `identityKinds` (after `"event"`, line 20), and add `actor: "actor"` as the **last** key of `identityPrefixes` (after `event`, line 42). Add no other kind and reorder no existing member. `prefixToKind` at `:65-71` derives itself from those two, so it needs no edit.
- Create `src/domain/actor.ts`. It imports `z` from `zod`, `identity` from `./identity.ts`, and `bytes` and `epochMillis` from `./column.ts`. It imports nothing else. It exports exactly these seven names:
  - `export const registeredActorKinds = ["human", "harness"] as const;` and `export type RegisteredActorKind = (typeof registeredActorKinds)[number];`
  - `export const bootstrapActorId = "actor_00000000000000000000000000";` — the literal `actor_` followed by exactly twenty-six `0` characters. It parses as `identity("actor")` because `ulidPattern` at `src/domain/identity.ts:45` is `/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/` and `0` satisfies both character classes.
  - `export const actorNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;`
  - `export const actorSecretPattern = /^[A-Za-z0-9_-]{43}$/;`
  - `export const actorRow = z.object({ ... })` and `export type ActorRow = z.infer<typeof actorRow>;`, with the fields `id: identity("actor")`, `kind: z.enum(registeredActorKinds)`, `name: z.string()`, `tokenSha256: bytes.refine((value) => value.length === 32, { message: "length(token_sha256) = 32" }).nullable()`, `registeredBy: identity("actor").nullable()`, `createdAt: epochMillis`, `revokedAt: epochMillis.nullable()`, `revokedBy: identity("actor").nullable()`. Follow the field style of `src/domain/provider.ts:6-20`.
  - `export function parseActorToken(value: string): Readonly<{ actorId: string; secret: string }> | null` — split on the **first** `.`; return `null` when there is no `.`, when the part before it does not parse as `identity("actor")` through `parseIdentity`, or when the part after it fails `actorSecretPattern`. Never throw.
  - `export function renderActorToken(input: Readonly<{ actorId: string; secret: string }>): string` — returns `` `${input.actorId}.${input.secret}` ``. It validates nothing; the caller supplies a minted secret.
- Create `src/domain/actor-view.ts`, mirroring `src/domain/provider-view.ts`. It exports `export type ActorView = Readonly<{ id: string; kind: RegisteredActorKind; name: string; registeredBy: string | null; createdAt: number; revokedAt: number | null; revokedBy: string | null }>`. It carries **no** token field and **no** digest field. Commands and queries return this type, because they cannot import `src/http/contract/`.
- `src/domain/event.ts`: rename `actorKinds` to `eventActorKinds` at `:6` and widen it to `["human", "daemon", "harness"] as const`. Rename the type at `:7` from `ActorKind` to `EventActorKind`. Update the one internal use at `:14`. No file outside `src/domain/event.ts` imports that type today, so the type rename has no other call site.
- `src/http/contract/event.ts`: update the import at `:3` and the two uses at `:15` and `:24` to `eventActorKinds`. These are the only three call sites of the value rename in the repository.
- `src/http/contract/field-decisions.fixture.ts`: change `enum=human,daemon` to `enum=human,daemon,harness` at `:8` and `:16`. Change no other row and reorder no row.
- `src/domain/rows.ts`: import `actorRow` from `./actor.ts` and add `actor: actorRow` as the **first** key of the `rows` object, before `agent_invocation`. The keys of `rows` are already in lexicographic order and `actor` sorts before `agent_invocation`, so `TableName` and `tableCounts` at `test/helpers/database.ts:52-68` stay consistent with the sorted read.

## Constraints

- `src/domain/actor.ts` and `src/domain/actor-view.ts` are pure. They import no `node:*` module, no `ulid`, no `yaml` and no vendor package — `eslint.config.js:230-247` fails the build otherwise. They contain none of the literals `Date.now(`, `new Date(` or `Math.random(`, which `src/domain/layout.test.ts:50-66` scans for in every non-test file directly under `src/domain/`.
- `domain/` mints nothing. `parseActorToken` and `renderActorToken` are a pure parser and a pure renderer; the secret arrives from the `secret` service of Story 2.
- Do not add a second export named `actorKinds`. The rename exists so that `eventActorKinds` (three members, the event vocabulary) and `registeredActorKinds` (two members, the registrable vocabulary) can never be confused at an import site.
- Do not widen the `kind` `CHECK` vocabulary here. Migration 0005 is Story 3.
- Do not touch `src/services/event/index.ts`. Story 11 owns the service-interface widening.

## Verify

- `src/domain/identity.test.ts`: change the three pinned counts from 17 to 18 at `:18`, `:22` and `:26`, and change the three `it(...)` titles at `:17`, `:21` and `:25` to read `18`. Add a test asserting `identityPrefixes.actor === "actor"`.
- Create `src/domain/actor.test.ts`, suite name `src/domain/actor.test`, asserting:
  - `registeredActorKinds` deep-equals `["human", "harness"]`.
  - `bootstrapActorId` equals `"actor_00000000000000000000000000"`, its length is 32, and `parseIdentity(bootstrapActorId)` returns a non-null value whose kind is `"actor"`.
  - `actorNamePattern` accepts `"a"`, `"harness-1"`, `"a"` repeated 63 times and `"0abc"`; it rejects `"A"`, `"-a"`, `"a_b"`, `""` and `"a"` repeated 64 times.
  - `actorSecretPattern` accepts a 43-character string of `A-Za-z0-9_-`; it rejects a 42-character and a 44-character string, and rejects one containing `+`, `/` or `=`.
  - `actorRow.safeParse` accepts a valid row; it rejects a `tokenSha256` of 31 bytes with the message `length(token_sha256) = 32`; it accepts a `tokenSha256` of `null`; it rejects an `id` of `"provider_" + <ulid>`.
  - `parseActorToken("actor_<ulid>.<43 chars>")` returns that id and that secret. It returns `null` for a value with no `.`, for `"provider_<ulid>.<43 chars>"`, for a secret of 42 characters, and for `"actor_<ulid>.a.b"` — and for that last value it must **not** return a secret of `"a.b"`, because the split takes the first `.` and `"a.b"` fails `actorSecretPattern`.
  - `parseActorToken` throws for no input, asserted with `assert.doesNotThrow` over the six rejection cases above.
  - `renderActorToken` round-trips with `parseActorToken` for a valid pair.
- `src/domain/event.test.ts`: assert `eventActorKinds` deep-equals `["human", "daemon", "harness"]` in that exact order, and assert `eventRow.safeParse` accepts `actorKind: "harness"`. Update every reference to the old name.
- `src/domain/rows.test.ts`: raise the pinned count from 19 to 20 at `:11` and its `it(...)` title at `:10`, and add `"actor"` as the first entry of the sorted name list at `:14`. Check the whole file for any further pinned `19`.
- Run `node --test --test-timeout=60000 src/domain/actor.test.ts src/domain/identity.test.ts src/domain/event.test.ts src/domain/rows.test.ts src/http/contract/coverage.test.ts src/http/contract/event.test.ts`; each exits 0. `coverage.test.ts` covers the field-decision parity at `:286`.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-015`, and Hermetic coverage line 151.
