# EPIC 021 — Provider contract and default transfer

Status: **draft**. EPIC 101 is closed at `61fc5e7`, and this epic amends two of its decisions.

This epic sits in the external-drive block because it repairs two defects on routes that are already
live, not because it drives external execution. `013-external-drive-overview.md` states the scope
consequence. It shares no file with EPICs 014 to 020, so it takes no dependency on them beyond the
sequence position.

## Goal

The client generates a provider payload model from the published contract, and a human moves the llm default without removing a registration. `provider.register` declares its request as a discriminated union on `kind`, so `payload` carries a per-kind schema in `src/http/contract/credential.ts` instead of `z.unknown()`. `src/http/contract/example.test.ts` validates every published example instead of the phase-1 subset, so the three phase-2 provider routes stop shipping unchecked fixtures. `provider.setDefault` moves the default in one transaction: it clears every other `llm` holder, stamps the target, appends one event per row it touched, and **names every row it displaced in the response**, so a client confirms a transfer without a second request. The `default-already-set` refusal is deleted, because no path produces it afterwards. The `ids` field leaves the shared `invalidRequestDetails` and moves to a `plan.import`-specific schema, because `plan.import` still emits it and no other operation does.

## Non-goals

- **No ordered chain.** `docs/proposal/database/provider.md:67` describes a chain that orders by `set_default_at` and holds many entries. This epic keeps the MVP invariant of at most one `llm` holder and only makes the holder movable. It adds no `position` column and no reorder route.
- **No `git` default.** `docs/proposal/database/provider.md:94` keeps the `git` chain empty. `kind-not-chainable` is unchanged.
- **No project-scoped or agent-scoped default.** `binding.provider.project` and `agent_binding` stay `deferred` and `post-mvp`.
- **No payload edit route.** There is no `provider.updatePayload`, so a rotated credential is a remove and a register. `docs/proposal/phase-2/providers-and-credentials.md:21` names register, list, rename, set default and remove, and this epic adds none.
- **No repair of a multi-holder database.** See D1, case 2. A database holding two stamped `llm` rows is unreachable through the API and this epic does not converge it.
- **No transport-wide zod error formatter.** See D5.
- **No filter and no project scope on `node.list`.** See "The client requirement this epic does not close".
- **No new CLI command.** `src/cli/credential/register.ts` stays the only credential command, and EPIC 114 owns the onboarding sequence that calls `provider.setDefault`.

## Decisions

### D1 — `provider.setDefault` transfers the default, atomically

`docs/proposal/api/credential.md:55` says a second call "appends" the registration to the chain and that the MVP refuses it. EPIC 101 implemented that refusal as `default-already-set` in `src/commands/provider/set-default-provider.ts:83-90`. **That refusal is replaced by a transfer.**

The motivation is that **there is no escape through the API at all**, not that the escape is awkward: `provider.remove` refuses a holder with the `default-chain` blocker (`src/commands/provider/remove-provider.ts:68-70`), and no route clears `set_default_at`. A human who registers a second llm account therefore cannot ever point the daemon at it.

The command becomes, inside one `storage.transact`:

1. Select the target. An unknown id refuses `not-found`. `kind = 'git'` refuses `kind-not-chainable`.
2. **A target whose `set_default_at` is already non-null writes nothing, appends nothing, and returns the unchanged view with an empty `displaced` list, per D9.** Unchanged from EPIC 101. This is a strict idempotent no-op and it wins over invariant repair, because the client retries a `PUT` and must not have a retry mean "clear other rows". The consequence is stated and accepted: if a database somehow holds two stamped `llm` rows and the caller names one of them, **both stay stamped**. That state is unreachable through the API — `src/commands/provider/set-default-provider.ts:100` and `src/commands/provider/register-provider.ts:69` are the only two writers of `set_default_at` in the tree, and neither can produce it — so this epic refuses to add a repair path for a state only a direct `INSERT` creates.
3. Otherwise select every **other** row with `kind = 'llm' AND set_default_at IS NOT NULL`, ordered by `id` through `Buffer.compare`. Set `set_default_at = NULL` and `updated_at = <now>` on each, and append `provider.defaultUnset` for each, in that order.
4. Then stamp the target's `set_default_at` and `updated_at` with the same `<now>` and append `provider.defaultSet`.

Step 3 clears every other holder rather than the first one, so **a transfer can never leave two holders behind**. That is the whole of the invariant claim; it is not a repair of a pre-existing corruption.

`<now>` is one `clock.now()` value for the whole transaction, as EPIC 101 already requires of `register`. Idempotency stays `none`: a `PUT` that names the target is naturally idempotent, because the second call takes case 2.

**Two transfers cannot interleave.** `SqliteStorage.transact` calls `assertIdle()` and refuses a second transaction in the same process (`src/services/storage/sqlite.ts:35-44`), `runInTransaction` opens `BEGIN IMMEDIATE`, which takes the write lock before the first read (`src/services/storage/connection.ts:30-35`), and `services/home-lock` refuses a second daemon on one home. So the read of step 3 and the write of step 4 cannot straddle another transfer's commit. The gate asserts it rather than assuming it.

### D2 — a transfer appends one event per row, never one event for two subjects

`provider.defaultUnset` is a new event type, with `subjectKind` `provider`, `subjectId` the row that lost the default, `actorKind` `human`, `actorId` the input actor, and payload `{ name, kind, unsetAt }`. `provider.defaultSet` is unchanged.

A single `provider.defaultTransferred` event is refused. An event carries one subject, and `event.list?subject=<id>` is how a screen reads one registration's history, so a transfer that wrote nothing on the losing row would be invisible on the screen that shows it. `docs/proposal/phase-1/domain.md` requires an event per transition, and a clear is a transition.

Three pieces of grounding this decision needs, and all three are settled in the tree rather than open:

- **There is no event-type registry to extend.** `src/domain/event.ts:13` declares `type: z.string()`, and every type is a literal at its append site. Adding a type is adding a literal.
- **An event payload is not contractually typed.** `src/http/contract/event.ts` declares `payload: z.unknown()`, so the payload shape is this epic's decision and no schema changes.
- **Reading by `id` order is reading append order.** `src/services/ids/ulid.ts:1,7` builds one module-scope `monotonicFactory()`, which EPIC 101's first story introduced precisely so mint order equals sort order inside one millisecond. `SqliteEventLog.list` orders by `id`.

**No proposal file is amended for the event name.** `grep` over `docs/proposal/` finds no occurrence of `provider.defaultSet`, `provider.registered`, `provider.renamed` or `provider.removed`: the proposal names no provider event, and EPIC 101 already recorded that `docs/proposal/phase-1/domain.md` requires an event per transition and names none of them, so the epic decides the name. `provider.defaultUnset` is decided here and nowhere else.

### D3 — no partial unique index enforces the single holder

A `CREATE UNIQUE INDEX ... ON provider(kind) WHERE kind = 'llm' AND set_default_at IS NOT NULL` would enforce D1's invariant in the database. It is refused, and "a later epic would drop it" is not the reason on its own — a migration exists to change an invariant. The reason is that the invariant is already enforced by four facts, each of which is checkable in the tree:

- `src/commands/provider/set-default-provider.ts:100` and `src/commands/provider/register-provider.ts:69` are the only two statements in the tree that write `set_default_at`. No service, query or migration writes it.
- `register` stamps only when no `llm` row exists at all (EPIC 101), so it cannot create a second holder.
- `runInTransaction` opens `BEGIN IMMEDIATE` and `transact` refuses a nested transaction, so step 3's read and step 4's write are serialized against every other writer.
- `docs/proposal/database/provider.md:67` defines a chain that legitimately holds many entries once the ordered chain ships, so an index asserting one holder encodes an MVP-only rule in the schema rather than in the command that owns it.

The gate carries a concurrency proof, because the fourth bullet is a design claim and the first three are only true until someone adds a fifth writer.

### D4 — `provider.register` declares `payload` per kind

`providerRegisterRequest` at `src/http/contract/credential.ts:34-38` declares `payload: z.unknown()`. It becomes a `z.discriminatedUnion("kind", …)` of two strict objects — `{ name, kind: z.literal("llm"), payload: llmPayload }` and `{ name, kind: z.literal("git"), payload: gitPayload }` — importing both payload schemas from `src/domain/provider-payload.ts`. `http/contract/` may import `domain/`, and `credential.ts` already imports `providerKinds` and `providerProjection` from that module.

Three consequences the epic carries:

- **`llmPayload` gains `.strict()`, and that is an approved behaviour change.** `src/domain/provider-payload.ts:8` declares it as a bare `z.object`. The coverage guard at `src/http/contract/coverage.test.ts:91-131` asserts every object node in every registered schema carries `additionalProperties: false`, and a bare `z.object` emits no `additionalProperties` at all: `z.toJSONSchema(z.object({a:z.string()}),{target:"openapi-3.0",io:"input"})` returns `{"type":"object","properties":{...},"required":["a"]}`, while the `.strict()` form adds `"additionalProperties":false`. So the guard fails without the change. The behaviour change is that an llm payload carrying an extra key is **refused** instead of silently dropped by `serializePayload`. That is the intended tightening: a human who mistypes `api_key` should be told, not have the credential stored without it. `gitHttpBasicPayload` and `gitSshPayload` are already `.strict()`.
- **The emitted document is asserted, not assumed.** A typed zod schema does not by itself give the client a usable model: the emitted OpenAPI must carry the discriminated branches in a readable form. The gate therefore asserts the exact emitted `provider.register.request` schema, including the outer branch count, the `kind` literal per branch, and the nested `transport` branches of the git payload. `nodeCreateRequest` at `src/http/contract/graph.ts:178-186` proves a top-level discriminated union renders and publishes, but it has no nested union, so it is a precedent for the outer shape only.
- **`field-decisions.fixture.ts` is regenerated.** `src/http/contract/field-decisions.fixture.ts:251` holds one opaque row, `provider.register.request#/properties/payload required=true nullable=false enum=-`. After D4 the `payload` leaf is replaced by one row per payload field per branch, and the two request rows for `name` and `kind` move under the union pointers. Regenerate through `node scripts/field-decisions-probe.mjs` and never by hand. The story names the expected pointer prefixes, so a wrong regeneration is visible in review.

### D5 — the handler is unchanged, and `payload-invalid` narrows

The draft of this epic had the register handler inspect the first zod issue and raise `refusal: "payload-invalid"` when the issue path began with `payload`. **That is refused.** AGENTS.md says a handler parses, calls exactly one command, and formats, and that a handler branching on a domain rule is a defect. Choosing a domain refusal from a field name is exactly that branch. It was also not deterministic: "the first issue" delegates the public error string to zod's issue ordering, and the `detail` would read `payload.token.<message>` where `PayloadError` builds `token.<message>` (`src/domain/provider-payload.ts:96-103`), so the two shapes could not match.

The decision instead:

- `src/http/server/credential/register-provider.ts:16-21` is **unchanged**. A request-schema failure stays a detail-less `400 invalid-request`, exactly as every other handler answers one today.
- `registerProvider` still calls `parsePayload`, so `private-key-encrypted` and `private-key-malformed` still reach the client with `refusal` and `detail`. Those are the refusals only the command can make.
- `refusal: "payload-invalid"` therefore **narrows** to the cases the contract cannot express, and stops being the client's channel for "which field is wrong".

That loss is acceptable because D4 removes the need for it: once `payload` is typed in the published contract, the client validates the payload locally before it sends, so the field name is a client-side fact and the daemon's job is to refuse. This is the smallest change that fixes B2 without a handler branch.

A transport-wide `ZodError` formatter — one helper in `src/http/server/` that maps every handler's parse failure to a deterministic `{ refusal, detail }` — is the better long-term answer and is a **non-goal here**, because it changes the error surface of all 34 routed operations and belongs to an epic that owns the transport. The condition to open it: the client reports that local payload validation is insufficient for another operation's body.

`parsePayload` stays in the command by choice, not by necessity. A zod `.refine` could express the OpenSSH cipher rules; the reason to keep them in `src/domain/provider-payload.ts:104-124` is that they base64-decode the key and read a binary header, which is a domain rule about a credential rather than a shape the transport should publish.

### D6 — `example.test.ts` validates every published example

`src/http/contract/example.test.ts:8-13` filters `status === "routed" && introducedIn === "phase-1"` and asserts a count of 36 at line 17. `provider.rename`, `provider.remove` and `provider.setDefault` are `routed`, are published by `scripts/publish-contract.ts:76-96`, and **no test validates their examples against their schemas.** `coverage.test.ts` and the field-decisions fixture already iterate the whole registry, so this suite is the only per-phase gap.

Filtering by `status` instead of by phase is not enough, because `publish-contract.ts` publishes **any** entry that carries examples, whatever its status. The suite therefore splits into two independent assertions:

1. **Every registry entry that carries examples has each present slot parsed against its own schema**, regardless of `status` and `introducedIn`. A slot with no schema is skipped per slot, which is how `blob.show` is handled: it is exempt for its response slot only, not excluded from the suite.
2. **Every `routed` entry carries examples**, with one enumerated exception, `blob.show`, which answers bytes.

The bare count at line 17 is replaced by an **exact, sorted operation-id set** for each assertion. A count proves little and goes stale silently; a set names what changed. No stubbed entry carries examples today, so assertion 1 covers 39 entries on the current tree, and it keeps covering the right set when a stubbed route gains an example.

### D7 — the register example carries `token`

`providerRegisterExamples.request` at `src/http/contract/credential.ts:65-73` sends a git `http-basic` payload with `password`. `gitHttpBasicPayload` requires `token`, so the published fixture is refused by the daemon it documents. Change `password` to `token`. After D4 and D6 the example test refuses the wrong key, so the fix is enforced rather than remembered.

### D8 — `ids` narrows to `plan.import`

`src/http/contract/error-details.ts:79` declares `ids: z.array(z.string()).optional()` on `invalidRequestDetails`, which `baselineErrors` puts on all 62 operations. **The field leaves the shared schema and moves to a `plan.import`-specific one. It is not deleted.**

`src/http/server/credential/refusals.ts:27` is not its only producer. `src/http/server/plan/refusals.ts:33-36` emits `ids` for the `choice-duplicate`, `choice-missing` and `choice-extra` refusals of `importPlan`, and `src/commands/plan/import-plan.ts:566` builds the list. That producer is live, is unrelated to this epic, and survives it. Deleting the field outright would make the daemon emit plan-choice details that its own published contract refuses, which is worse than the over-modelling the deletion was meant to fix.

The narrowing is still right, because `ids` carries exactly one meaning — the offending choice ids of an import — while the baseline advertises it on every operation, and `refusal: z.string()` expresses no link between a refusal and the presence of `ids`. So:

- `invalidRequestDetails` becomes `{ refusal, detail? }`.
- A new `planImportInvalidRequestDetails` carries `{ refusal, detail?, ids? }`, and `plan.import` declares it after the `...baselineErrors` spread. `ids` stays optional there, because `documents-hash-mismatch` reaches the same code with `refusal` alone and a request-schema failure reaches it with no details at all.

`plan.import` is the whole of the override: `src/http/server/plan/refusals.ts` is imported by exactly one handler, `src/http/server/plan/import-plan.ts:6`. This is the first per-operation override of a baseline error code in the tree, and `src/http/contract/credential.ts` already adds `binding-in-use` by the same spread mechanism.

**No wire error changes.** The daemon sends the same error bodies it sent before; the published contract narrows to match them. D9 changes one success body, and it changes no error body. The grounding that makes the shape change cheap is that `/v1` is unreleased — `kanthord-apps/docs/api/conventions.md` records "`/v1` is unreleased, so a path spelling can still change" — and the field is optional, so no client that models it as optional fails to decode without it on the operations that drop it.

The client-side action is explicit, and it is a narrowing rather than a removal: `kanthord-apps/docs/api/errors.md` names `details.ids` beside `default-already-set` and must retire that refusal while **keeping** `details.ids` documented under the three `plan.import` choice refusals. Telling the client to drop `details.ids` outright would break its plan-import screen.

Two alternatives are refused because each changes a live response: renaming the wire field to `choiceIds`, and remapping the three choice refusals onto their own error code. Both are cleaner and both belong to an epic that owns the plan error surface.

### D9 — the transfer names what it displaced, in the same response

D1 moves the default. **The response says which rows lost it.** `providerSetDefaultResponse` at `src/http/contract/credential.ts:60` is `providerView` today, so a caller learns the new holder and nothing about the old one.

The reason is a client requirement and an epic dependency, and they are the same requirement:

- `kanthord-apps` renders a confirmation only if the daemon names the previous holder.
- The Open item below records that EPIC 114's onboarding must either show the previous holder or refuse to run on a non-empty registry. It cannot show what the response does not carry.

Reading the displaced rows from `provider.defaultUnset` through `event.list` is refused as the client's path. No filter selects the events of one call: `event.list` filters by `subject`, `type`, `actorKind` and `actor` (`src/services/event/index.ts:26-33`), so a client would fetch by `type` and correlate by timestamp, and two transfers in one millisecond are indistinguishable. The events stay the audit record. The response is the answer to the call.

**The member is flat, and `{ provider, displaced }` is refused.** The reason is not that nesting would disturb the other provider operations — it would not. `provider.register`, `provider.show` and `provider.rename` each declare `providerView` as their own response, so nesting it here changes this one operation and nothing else. The reason is that nesting rewrites **every** top-level member of the one body it does change: a caller that reads `id`, `name`, `kind`, `projection`, `setDefaultAt` and `updatedAt` would read all six from a new place, to learn one new fact. A flat member changes no existing member, so the migration is additive.

`src/http/server/credential/set-default-provider.test.ts:44-45` measures that difference rather than deciding it: it parses the body through `providerSetDefaultResponse` and then asserts `Object.keys(parsed).sort()`. Under the flat member that array gains one entry; under a nested body it is replaced. A test documents a contract and changes with it, so this is evidence of the size of the change, not a constraint on the choice.

```ts
export const displacedProvider = z.strictObject({
  id: z.string(),
  name: z.string(),
});

export const providerSetDefaultResponse = providerView.extend({
  displaced: z.array(displacedProvider),
});
```

Five properties of `displaced`, each of which the gate asserts:

- **It is required and never absent.** An optional member would make "nothing was displaced" and "a daemon that predates this epic" one wire value, which is the ambiguity the client asked us to remove.
- **It is empty when nothing moved.** That is case 1 of D1 on an empty registry, and case 2, the idempotent repeat.
- **The published example carries one entry, not an empty list.** `providerSetDefaultExamples.success` is the fixture a client copies, and an example whose `displaced` is `[]` never demonstrates the confirmation the member exists for. The example therefore names one displaced registration, which needs a second id literal: `src/http/contract/example-literal.ts` gains `EXAMPLE_ULID_B`, a second valid ULID distinct from `EXAMPLE_ULID`. No test enumerates that module's exports, so adding one constant moves nothing else.
- **Its order is bytewise by `id`,** which is the order D1 step 3 already clears in, so entry _n_ of `displaced` is the subject of append _n_ of `provider.defaultUnset`. One order serves the response and the log.
- **It carries `name` as well as `id`,** because a confirmation screen shows a name. D1 step 3 already selects `name`, so this costs no extra read.
- **It carries no `kind`.** Every displaced row is `llm` by the step-3 predicate, so a `kind` member would be a constant on the wire.

**`ProviderView` is unchanged, and the command gains its own return type — in the command.** `src/domain/provider-view.ts:3-10` is shared by `registerProvider`, `listProviders`, `showProvider`, `renameProvider` and `setDefaultProvider`, and `displaced` is meaningless on the first four, so the entity view does not grow.

The two new types go in `src/commands/provider/set-default-provider.ts`, beside `SetDefaultProviderInput`, and **not** in `domain/`:

```ts
export type DisplacedProvider = Readonly<{
  id: string;
  name: string;
}>;

export type ProviderDefaultTransfer = ProviderView &
  Readonly<{ displaced: readonly DisplacedProvider[] }>;
```

`domain/` would be legal — the file declares types only, so purity holds and every consumer's import is inside the matrix. It is still wrong. AGENTS.md's own command shape names the result type after the operation, `ImportPlanResult`, and the tree puts that type in the command: `src/commands/plan/import-plan.ts:65` declares it and `src/http/server/plan/import-plan.ts:5` imports it from `commands/`. A one-operation result is an application shape, and `domain/` holds entities. Extending a domain-owned `ProviderView` from a command is ordinary dependency direction, not a shape split across layers, which is the argument an earlier draft of this decision used and which does not survive the precedent.

`http/server/` may import `commands/`, and `src/http/server/credential/set-default-provider.ts:4` already imports `SetDefaultProviderInput` from there, so the handler's import list gains a name on a line it already has.
**D5 survives.** `src/http/server/credential/set-default-provider.ts:9` declares its dependency as `(input: SetDefaultProviderInput) => ProviderView` and its body is `return { status: 200, body: view }`. The dependency type becomes `=> ProviderDefaultTransfer` and **the body does not change**. The handler still parses, calls one command and formats, and it branches on no domain rule.

**The field-decisions fixture is regenerated twice in this epic, and that is deliberate.** D4's regeneration lands in the payload-union story, before this member exists. The transfer story regenerates it again and adds two rows, `provider.setDefault.response#/properties/displaced/items/properties/id` and `.../name`, beside the existing `provider.setDefault.response` rows at `src/http/contract/field-decisions.fixture.ts:407-418`. A story that left the fixture stale would leave `npm run verify` red, so each of the two stories regenerates it.

## The client requirement this epic does not close

`kanthord-apps/docs/api` records four findings. This epic closes three: the wrong register example, the unschemad payload, and the missing default transfer.

The fourth needs restating before it can be assigned, because "`node.list` accepts no filter" describes a symptom and two different epics own two different cures:

| The client's actual requirement                          | Owner                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| A project screen reads one project's nodes and no others | `.agents/plan/epics/022-project-scoped-graph-read.md`, the next epic |
| A screen filters nodes by kind, state or block reason    | EPIC 018, which owns the query mechanism                             |
| `node.list` itself becomes filterable                    | **Neither.** EPIC 022 explicitly changes no `node.list` behaviour    |

The client's requirement is the first row: the screens the handover scopes are per project. So EPIC 022 is the owner, and this epic neither duplicates it nor claims to unblock it. Duplicating a project-scoped read here would give one route two owners.

**This epic therefore closes three of four findings and declares a dependency, rather than claiming the client is unblocked.** EPIC 022 is the next epic of the block and it owns the fourth. The client builds its project screen after 022 lands.

## Stories

- **`llmPayload` becomes strict** — add `.strict()` to `src/domain/provider-payload.ts:8`. `parsePayload("llm", …)` then throws `PayloadError("payload-invalid", …)` with a `detail` naming the unrecognized key. Change no other payload schema; both `git` members are already strict.
- **`provider.register` declares its payload per kind** — replace `providerRegisterRequest` at `src/http/contract/credential.ts:34-38` with a `z.discriminatedUnion("kind", …)` of two strict objects, importing `llmPayload` and `gitPayload` from `src/domain/provider-payload.ts`. Keep `providerRegisterResponse`, the path, the method, the `introducedIn` and the `idempotency` unchanged. Change `password` to `token` in `providerRegisterExamples.request` at `src/http/contract/credential.ts:65-73`. Regenerate `src/http/contract/field-decisions.fixture.ts` through `node scripts/field-decisions-probe.mjs`; the row `provider.register.request#/properties/payload required=true nullable=false enum=-` at line 251 disappears, and every new request row carries a pointer under `provider.register.request#/anyOf/<0|1>/properties/`.
- **`example.test.ts` validates every published example** — rewrite the two scoping assertions of `src/http/contract/example.test.ts` per D6. Assertion 1 iterates `registry.filter((entry) => entry.examples !== undefined)` and parses each present slot against `entry.query`, `entry.request` and `entry.response`, skipping a slot whose schema is `undefined`. Assertion 2 asserts that the sorted operation ids of `registry.filter((entry) => entry.status === "routed" && entry.examples === undefined)` are deep-equal to `["blob.show"]`. Replace the count at line 17 and the title "covers the thirty-six phase-1 routed operations" with the sorted operation-id set each assertion covers. Keep the query-example assertion, which still names `event.list` alone.
- **The register handler is untouched** — `src/http/server/credential/register-provider.ts` changes in no way. This story exists to record the refusal of the handler branch, so a later agent does not add one: the epic's D5 is the decision, and a handler that reads a zod issue path to pick a refusal fails review.
- **`provider.setDefault` transfers** — rewrite the body of `setDefaultProvider` in `src/commands/provider/set-default-provider.ts` per D1. Delete `"default-already-set"` from `SetDefaultProviderRefusal` at line 24 and delete the `ids` member of `SetDefaultProviderError`. Select the other holders with `SELECT id, name, kind FROM provider WHERE kind = 'llm' AND set_default_at IS NOT NULL AND id <> ?` and sort by `id` through `Buffer.compare` in the command, not in SQL, so the order matches every other blocker list in the capability. Keep case 2 exactly as EPIC 101 wrote it. Keep the projection fallback: a `crypto.open`, `deserializePayload` or `projectPayload` throw returns `projection: null` without changing the state or the event result. The same story carries every file D9 touches, because a response member and the value behind it must land together: `src/commands/provider/set-default-provider.ts` gains `DisplacedProvider` and `ProviderDefaultTransfer` beside `SetDefaultProviderInput`, and `src/domain/provider-view.ts` is not edited; `setDefaultProvider` returns `ProviderDefaultTransfer`, with `displaced` built from the rows step 3 cleared, in the same bytewise `id` order, and `[]` in case 1 and case 2; `src/http/contract/credential.ts` gains `displacedProvider` and extends `providerSetDefaultResponse`; `src/http/contract/example-literal.ts` gains `EXAMPLE_ULID_B` and `providerSetDefaultExamples.success` at `src/http/contract/credential.ts:145-153` gains a one-entry `displaced`; `src/http/server/credential/set-default-provider.ts:9` changes its dependency type to `ProviderDefaultTransfer` and its body not at all; and `src/http/contract/field-decisions.fixture.ts` is regenerated a second time through `node scripts/field-decisions-probe.mjs`.
- **`provider.defaultUnset`** — append it per cleared row inside the same transaction, with `subjectKind` `provider`, `subjectId` the cleared row's id, `type` `provider.defaultUnset`, `actorKind` `human`, `actorId` the input actor, and payload `{ name, kind, unsetAt }`. `unsetAt` is the one `clock.now()` value of the transaction, so the unset and the set carry the same instant. No schema and no proposal file changes, per D2.
- **The refusal map shrinks** — delete the `default-already-set` branch of `src/http/server/credential/refusals.ts:23-28`, so a `SetDefaultProviderError` maps `not-found` to `not-found` and every other refusal to `invalid-request` with `refusal` alone. Touch `src/http/contract/error-details.ts` in no way here. The field-decisions fixture is regenerated once, in the payload-union story; the walk covers the query, request and response slots only, so no error-schema edit moves a row.
- **`ids` narrows to `plan.import`** — remove `ids` from `invalidRequestDetails` at `src/http/contract/error-details.ts:79`, add `planImportInvalidRequestDetails` carrying `{ refusal, detail?, ids? }`, and declare it on the `plan.import` entry at `src/http/contract/graph.ts:439-447`, after the `...baselineErrors` spread. Change `src/http/server/plan/refusals.ts` and `src/commands/plan/import-plan.ts` in no way; this story changes the published contract to match what the daemon already sends, per D8.
- **The proposal records the transfer** — the exact inventory is three edits and no more. Replace the second sentence of `docs/proposal/api/credential.md:55` so it states that the MVP holds one entry, that `setDefault` moves it by clearing the previous holder in the same transaction, and that the appending ordered chain is deferred. Add the same statement to the registry-operations paragraph at `docs/proposal/phase-2/providers-and-credentials.md:21`, and state in one sentence there that the response names every displaced registration by `id` and `name`, per D9. Amend `docs/proposal/database/provider.md:83`, which says a reorder is the first time rewriting `set_default_at` matters, because a transfer now rewrites two rows before any reorder ships. `src/http/contract/parity.test.ts` compares the registry against the status table of `docs/proposal/api/credential.md`, and no status changes here, so parity is unaffected.
- **Inherited provider regressions** — re-run the EPIC 101 proofs this epic edits and label them regressions: `src/commands/provider/*.test.ts`, `src/queries/provider/*.test.ts`, `src/http/server/credential/*.test.ts`. The register, rename and remove commands are untouched by D1, and the remove blocker list still reports `default-chain` for the single remaining holder.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/domain/provider-payload.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/coverage.test.ts \
  src/http/contract/openapi.test.ts \
  src/http/contract/credential.test.ts \
  src/http/contract/parity.test.ts \
  src/commands/provider/*.test.ts \
  src/queries/provider/*.test.ts \
  src/http/server/credential/*.test.ts \
  scripts/publish-contract.test.ts && echo "PASS EPIC-021"
```

The epic does not close on `npm run verify` alone. `npm run verify` proves the repository; it does not prove the artifact the client reads. The gate therefore also requires, into a temporary directory and never into the client repository from this epic:

```bash
node scripts/publish-contract.ts "$(mktemp -d)"
```

and an assertion that the emitted `features/provider.yaml` carries the two request branches and the two nested git transport branches. Retiring the three findings from `kanthord-apps/docs/api` is named in Open items and is the client repository's commit, not this epic's.

Hermetic coverage required beyond the Proof:

**The payload contract**

- `providerRegisterRequest.safeParse` refuses `{ name: "github", kind: "git", payload: { transport: "http-basic", forge: "github", username: "atlas", password: "x" } }` and accepts the same object with `token` in place of `password`. This is the assertion that fails on the pre-epic tree.
- `providerRegisterRequest.safeParse` refuses an `llm` payload carrying one extra key, and `result.error.issues[0].path` is deep-equal to `["payload", "<the extra key>"]`.
- `providerRegisterRequest.safeParse` refuses both halves of the cross product: an `llm` kind carrying a git payload, and a `git` kind carrying an llm payload.
- `z.toJSONSchema(providerRegisterRequest, { target: "openapi-3.0", io: "input" })` carries exactly two `anyOf` branches; branch 0's `kind` is `{ const: "llm" }` and branch 1's is `{ const: "git" }`; branch 1's `payload` carries exactly two nested branches whose `transport` consts are `"http-basic"` and `"ssh"`; and **every** object node in the emitted tree carries `additionalProperties: false`. The last clause is the assertion that pins the `.strict()` requirement to an emitted value rather than to prose.
- The published `features/provider.yaml` of a `publish-contract.ts` run into a temporary directory carries the same two-branch request shape.
- `POST /v1/provider` with a git `http-basic` payload naming `password` answers `400 invalid-request` through the real koa app, and its body carries **no** `details`, which is the D5 behaviour.
- `POST /v1/provider` with an encrypted OpenSSH private key still answers `400` with `details.refusal` equal to `private-key-encrypted` and a `details.detail` equal to the cipher name, so the command's refusals are unchanged by D4.

**The example guard**

- `registry.filter((entry) => entry.status === "routed" && entry.examples === undefined).map((entry) => entry.operationId)` is deep-equal to `["blob.show"]`.
- The sorted operation ids that assertion 1 of D6 covers are deep-equal to the exact 39-element list, written out in the test.
- `provider.rename`, `provider.remove` and `provider.setDefault` each have their success and error examples parsed against their own schemas, which is the coverage D6 adds. Removing the `introducedIn` clause on the pre-epic tree with the `password` example still in place must fail, and the test comment records that.

**The transfer**

- Register llm A, which EPIC 101 auto-stamps as the first `llm` row, then register llm B, which is not stamped, then snapshot both rows and the event count, then `setDefault(B)`. The exact delta is: A's `set_default_at` becomes `NULL`, B's becomes non-null, both `updated_at` values equal B's `set_default_at`, and exactly two events are appended, read by `id` as `["provider.defaultUnset", "provider.defaultSet"]` with `subjectId` A then B.
- The same call answers `displaced` deep-equal to `[{ id: "<A>", name: "<A's name>" }]`, and the response's own `id`, `setDefaultAt` and `updatedAt` are B's. This is the assertion the client's confirmation screen depends on.
- `providerSetDefaultResponse.parse(providerSetDefaultExamples.success)` succeeds and its `displaced` holds exactly one entry, deep-equal to `{ id: "provider_<EXAMPLE_ULID_B>", name: "<the displaced name>" }`. The published fixture demonstrates a transfer, per D9.
- `providerSetDefaultResponse.safeParse` refuses the pre-epic body — the same object without `displaced` — and refuses `displaced: [{ id: "x", name: "y", kind: "llm" }]`. The first pins D9's "required and never absent" and the second pins the `additionalProperties: false` of `displacedProvider`.
- The three-holder transfer answers `displaced` of length three, and its `id` sequence is deep-equal to the `subjectId` sequence of the three appended `provider.defaultUnset` events, read by event `id`. This asserts the one-order claim rather than asserting two orders separately.
- `setDefault` on the row that already holds the default answers `displaced` deep-equal to `[]`, and `setDefault` on the only `llm` row of a registry with one holder does the same. Case 2 and case 1 both report an empty list.
- `ProviderView` is unchanged: `provider.register`, `provider.show`, `provider.rename` and each member of `provider.list` carry no `displaced`, asserted through `providerView.safeParse` refusing a body that carries one.
- The two appended events carry the exact payloads `{ name: "<A>", kind: "llm", unsetAt: <now> }` and `{ name: "<B>", kind: "llm", setDefaultAt: <now> }`, the same `<now>` in both, and `actorKind` `human` with `actorId` equal to the input actor.
- Three `llm` rows stamped by direct insert, then one `setDefault` on a fourth unstamped row: three `provider.defaultUnset` events in `Buffer.compare` order of the cleared ids, then one `provider.defaultSet`, and exactly one holder afterwards.
- **Case 2 under duplicate holders**, which is the state D1 declines to repair: two `llm` rows stamped by direct insert, then `setDefault` on one of them answers `200`, changes no `set_default_at`, changes no `updated_at`, and appends no event. Both rows are still stamped. This asserts the decision, not a defect.
- `setDefault` on the row that already holds the default answers `200`, and `set_default_at`, `updated_at` and the event row count are all unchanged. This is EPIC 101's assertion, kept.
- `setDefault` on a `git` registration answers `400` with refusal `kind-not-chainable`, and `set_default_at` of that row is still `NULL`. This is EPIC 101's assertion, kept.
- The transfer is atomic: an event append forced to throw inside the transaction leaves both `set_default_at` values and both `updated_at` values as they were, and appends no event.
- `setDefault` returns `projection: null` for a target whose `payload_tag` is sixteen zero bytes, and the transfer still cleared the previous holder and appended both events.
- **Two transfers cannot interleave.** A `setDefaultProvider` call whose transaction body calls `storage.transact` again — the reentrancy a second concurrent transfer would need — throws the `assertIdle` refusal of `src/services/storage/sqlite.ts`, and after it throws exactly one holder remains and the event log is unchanged. This proves **one** of the three mechanisms D1 and D3 name: `assertIdle` refuses a second transaction on one `SqliteStorage` instance. It does **not** exercise a second top-level transfer, a second connection, `BEGIN IMMEDIATE` serialization between connections, or the home-lock exclusion between processes, because a competing writer does not enter through the first transaction's callback. The claim in this bullet is therefore narrowed to the first mechanism, matching Story 5, and the remaining two stay design claims grounded in `src/services/storage/connection.ts:35` and `services/home-lock` rather than in a test. Racing two timers is refused: no deterministic test can do it.
- No **credential** refusal path can emit `ids`: `Object.keys(error).sort()` of every `SetDefaultProviderError` this epic throws is deep-equal to `["name", "refusal"]`, `invalidRequestDetails.safeParse({ refusal: "x", ids: [] })` fails, and `grep` over `src/http/server/credential/` finds no `ids:` in a `httpError` details argument. The scan stops at the credential directory on purpose: over all of `src/http/server/` it is false by design, because the `plan.import` producer survives, per D8.
- `ids` still reaches the client from `plan.import`, and its emission is now covered by that operation's own schema: the `details` of a `choice-missing` refusal parses under `planImportInvalidRequestDetails` and fails under `invalidRequestDetails`. `plan.import` is the only operation overriding the baseline `invalid-request` details.
- `provider.remove` on the single remaining holder still answers `409 binding-in-use` with a `default-chain` blocker, so the transfer did not make a holder removable.

## Open items

- **EPIC 114 gains a silent overwrite, and its owner must decide.** Onboarding calls `provider.setDefault`. Before this epic a call against an existing default failed loudly with `default-already-set`; after it, the call silently moves a default the human may have set deliberately. That is a behaviour change, not the removal of a failure mode. EPIC 114 either shows the previous holder and confirms, or records that onboarding runs only on an empty registry. D9 gives it the value for the first branch — `displaced` names every row the call moved — so the decision is a decision and no longer a missing capability. This epic still does not decide it and must not close before 114 acknowledges it.
- The published artifact changes shape, so `npm run contract:publish -- ../kanthord-apps/docs/api/contract` runs from a clean tree after this epic lands, and the three closed findings are retired from `kanthord-apps/docs/api/blockers.md`, `operations.md` and `errors.md`. `details.ids` is **retired only beside `default-already-set`** and stays documented under the three `plan.import` choice refusals, per D8. That is a commit in the client repository, and it happens after the epic lands, not before: until then the daemon still refuses a second default.
- EPIC 022 delivers the project-scoped read, per "The client requirement this epic does not close". This epic is not blocked by it, and the client's project screen is.
