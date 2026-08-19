# EPIC 027 — Plan choice values

Status: **draft**. It sits after EPIC 026 in the sequence. It shares no schema, command or service
with EPICs 014 to 026. Its only overlap is with `026-event-tail-read.md`: both regenerate
`src/http/contract/field-decisions.fixture.ts` and both add one `docs/proposal/api/new-decisions.md`
row. Both are mechanical.

Source: the `kanthord-apps` contract asks, item P2, answered at `e2ff3cf`. The answer was decided
before this epic existed, so this file is its first record in the repository. The client holds the same
decision and builds against it.

**This epic was split out of a draft that also carried the event tail.** That draft justified the bundle
by one contract publish. The bundle is dropped: the two halves share no schema, no command and no
service, and their only overlap is that both regenerate
`src/http/contract/field-decisions.fixture.ts` and both add a row to
`docs/proposal/api/new-decisions.md`. `026-event-tail-read.md` owns the event half. The cost of the
split is one extra release-bound publish under `024-release-bound-contract-publish.md`, and it is
accepted: a plan conflict screen and an audit screen are two client features, and neither waits on the
other.

## Goal

A human resolving a plan conflict sees what each branch holds. `plan.validate` gives every choice
branch a `values` member carrying the field values of that side, so a `database-only` entry taken as
`submitted` names the node it deletes instead of naming only its id.

## Non-goals

- **No client-side diff, and no diff rendering.** The daemon publishes two value sets per conflict. Which of the two a screen highlights is the client's decision, and this epic ships no unified-diff string and no patch format.
- **No prose in a choice.** A `body` value is a pair of blob hashes, per D2. `blob.show` already serves the stored text and `022-project-scoped-graph-read.md:15` keeps prose off a topology read for the same reason.
- **No blob-addressed diff.** The client offered that as its second acceptable shape. It is refused by D1's last paragraph and it is not deferred.
- **No change to `choiceVerdict`.** `src/domain/plan-choice.ts:36` stays a pure function of `ChoiceFacts` and returns `ChoiceVerdict` unchanged, so `src/commands/plan/import-plan.ts:320`, its second caller, is untouched. See D4.
- **No change to `plan.import`.** The submitted-choice request stays `{ id, take }` (`src/http/contract/field-decisions.fixture.ts:287-288`). A client that reads `values` sends back the same choice it sent before.
- **No write on `plan.validate`.** It stays a read path. See D2's refusal of storing the submitted blobs.
- **Nothing about `event.list`.** `026-event-tail-read.md` owns `before`, `order` and the tail read. This epic touches `src/http/contract/cursor.ts` in no way.

## Decisions

### D1 — a choice branch carries the field values of its own side

`planChoiceEntry` at `src/http/contract/graph.ts:62-77` gives each branch `{ legal, reason }`. A human
therefore chooses between two outcomes the daemon does not describe. Each branch gains one member:

```ts
export const planChoiceBody = z.strictObject({
  instructionBlob: blobHash,
  acceptanceBlob: blobHash.nullable(),
});

export const planChoiceValues = z.strictObject({
  body: planChoiceBody.optional(),
  depends_on: z.array(z.string()).optional(),
  parent: z.string().nullable().optional(),
  repo: z.string().nullable().optional(),
  title: z.string().optional(),
  worker: z.string().nullable().optional(),
});

export const planChoiceBranch = z.strictObject({
  legal: z.boolean(),
  reason: z.string().nullable(),
  values: planChoiceValues,
});

export const planChoiceEntry = z.strictObject({
  id: z.string(),
  kind: z.enum(nodeKinds),
  presence: z.enum(presences),
  state: z.enum(nodeStates).nullable(),
  suggested: z.enum(choices),
  fields: z.array(z.enum(differingFields)),
  submitted: planChoiceBranch,
  database: planChoiceBranch,
});
```

**The keys of `values` are the members of `fields`, spelled identically.** `differingFields` at
`src/domain/node-write-legality.ts:14-21` is `body`, `depends_on`, `parent`, `repo`, `title`, `worker`,
and the wire already publishes those names in the `fields` array. `depends_on` keeps its underscore
in a camelCase contract for exactly that reason: one vocabulary for the two members, so a client
indexes `values` by an entry of `fields` with no mapping table.

**Presence, not `fields`, decides which names appear, and this is the decision the shape turns on.**
An earlier draft said a member appears when its name is in `fields`. That is wrong, and it is wrong in
precisely the case the client raised. `src/queries/plan/validate-plan.ts:186-212` initializes
`fields` to `[]` and assigns it **only** inside `if (presence === "both")`. So a `database-only` entry
carries an empty `fields` array by construction, and a rule keyed off `fields` would have answered
`{}` for the entry whose only complaint was that it shows nothing. The rule is therefore:

| `presence`      | `submitted.values`            | `database.values`             |
| --------------- | ----------------------------- | ----------------------------- |
| `both`          | exactly the names in `fields` | exactly the names in `fields` |
| `document-only` | all six names                 | `{}`                          |
| `database-only` | `{}`                          | all six names                 |

Read as one sentence: **each branch describes the node that branch leaves in place, and it narrows to
the differing fields only when both sides hold a node.** A `both` entry whose `fields` is empty — the
"equivalent" verdict of `src/domain/plan-choice.ts:57-63` — carries `{}` on both branches, because
nothing differs and there is nothing to show.

**An absent key and a present `null` mean different things, and a client codes against both.** `parent`,
`repo` and `worker` are `z.string().nullable().optional()`, so three states exist per name and each is
distinct:

- the key is **absent** — the name is not represented on this branch, either because it is not in
  `fields` or because this branch holds no node;
- the key is present and **`null`** — this branch holds a node and that node has no parent, no
  repository or no worker;
- the key is present with a value — this branch holds that value.

`acceptanceBlob` inside `body` is the same three states collapsed to two, because `body` is either
absent or a complete pair. `{}` therefore never means "no worker"; it means "nothing to choose".

The response grows only where a conflict exists, which is what the client asked for, and it grows by
six small values on the single-sided entries, which is the case the client cannot render today.

**The blob-addressed alternative is refused, not deferred, and the margin is narrower than a first
reading suggests.** A `diffBlob` per choice would make `plan.validate` write on a read path — it writes
nothing today — and would cost one round trip per entry the human opens. Shape 1 avoids the write
outright, and it avoids the round trip for five of the six names, which are scalars or a short id list
and are inline. It does **not** avoid a round trip for `body`: the database side of a body conflict is a
hash and the text comes from `blob.show`, per D2. So the honest claim is that shape 1 writes nothing,
serves the whole of a structural conflict in one response, and narrows the fetch to the one field whose
value is unbounded — not that it removes the indirection.

### D2 — a `body` value is a pair of blob hashes, never prose

`src/domain/plan-diff.ts:15-20` pushes `body` when **either** the instruction hash or the acceptance
hash differs. So `body` is one field name over two blobs, and its value must name both or a client
cannot tell which of the two changed:

```ts
{ instructionBlob: "sha256:…", acceptanceBlob: "sha256:…" | null }
```

The hashes are already computed at the point the entry is built. `validate-plan.ts:189-196` hashes the
submitted instruction and acceptance into `blobHashes`, and `StoredNode` at
`src/domain/plan-graph.ts:9-10` carries `instructionBlob` and `acceptanceBlob`. **So both sides of the
`body` value cost no extra read and no extra hash.**

The text stays out for two reasons and neither is size alone. `blob.show` is the declared reader of a
blob and it is `routed`, so a second text channel would give one byte string two routes. And a plan
document body is unbounded, while every other value in `planChoiceValues` is a scalar or a short id
list, so inlining prose would make one response's size depend on a document rather than on a conflict
count.

**The two sides resolve their text differently, and "fetch it through `blob.show`" is true of only one
of them.** `plan.validate` is a read path. `src/queries/plan/validate-plan.ts:189-196` calls
`dependencies.blobs.hash(...)`, and `BlobStore.put` at `src/services/blob/index.ts:23` is the only
writer and takes a `Transaction` the query never opens. **So a submitted instruction or acceptance blob
is hashed and never stored, and `blob.show` cannot serve it.** A stored node's blobs were written at
import, so `blob.show` serves those.

This epic therefore decides the retrieval rule rather than leaving it to the client to discover:

- **`database.values.body`** — the two hashes resolve through `blob.show`. This is the stored text, and
  it is the text the client could not reach at all before this epic.
- **`submitted.values.body`** — the text is already in the same response. `planValidateResponse.documents`
  is `z.array(planDocument)` (`src/http/contract/graph.ts:86`) and `planDocument` is `{ path, content }`
  (`:38-41`), the raw document with its instruction and acceptance inside. The hashes are the integrity
  check on that content, not a fetch key, and the epic states that in the contract.

**A join key is therefore required, and `planChoiceEntry` gains it.** The entry's `id` is the identity;
`planDocument.path` is the path; and no member of the response maps one to the other today, so a client
holding a choice cannot find the document that carries its text. The entry gains one member:

```ts
path: z.string().nullable(),
```

It is the submitted document's path for a `both` or `document-only` entry, and `null` for a
`database-only` entry, which has no document. `ResolvedDocument` extends `ParsedDocument`
(`src/domain/plan-identity.ts:13`), which declares `path` (`src/domain/plan-document.ts:39`), and
`validate-plan.ts` holds `document` in scope where it pushes the entry, so the member costs no read.

Two alternatives are refused. Inlining the prose is refused above, on size. Making `plan.validate`
write the submitted blobs so `blob.show` could serve them is refused because it turns a `GET`-shaped
read path into a writer, and `plan.import` is the operation that persists a submission.

### D3 — a `depends_on` value is the normalized list the comparison used

`src/domain/plan-diff.ts:21-28` compares `normalized(stored.dependencies)` with
`normalized(submitted.dependencies)`, and `normalized` at `:41-50` sorts by `comparePaths` and drops
adjacent duplicates. **The published value is the normalized list, not the raw one.**

The reason is that the client must not be able to draw a conflict the daemon did not find. A raw list
differing only in order or in a repeat produces no `depends_on` entry in `fields`, so publishing the
raw list would show a human two visibly different lists for a field the daemon calls equal. Publishing
the compared value makes the rendering and the verdict the same fact.

`comparePaths` at `src/domain/plan-path.ts:106-113` compares by code point, not by byte. That is the
existing order of `fields` and of the dependency lists, and this epic does not change it; it names it
so a story does not substitute `Buffer.compare` and produce a different order for a non-ASCII
identity.

### D4 — the projection is a domain function beside the comparison, and `choiceVerdict` does not move

The values are a pure mapping from a `StoredNode` and a `ResolvedDocument` to a value record, so they
belong in `domain/`. They go in `src/domain/plan-diff.ts`, which already owns the comparison those
same two arguments feed, rather than in `src/domain/plan-choice.ts`:

```ts
export function storedValues(
  stored: StoredNode,
  fields: readonly DifferingField[] | null,
): ChoiceValues;

export function submittedValues(
  submitted: ResolvedDocument,
  blobs: Readonly<{ instruction: string; acceptance: string | null }>,
  fields: readonly DifferingField[] | null,
): ChoiceValues;
```

`fields` of `null` means "the side is the only side", and it returns all six names. A non-null `fields`
returns exactly those names. That is D1's table expressed as one parameter.

**Neither function can produce the empty branch, and the query composes it.** `storedValues` requires a
`StoredNode` and `submittedValues` requires a `ResolvedDocument`, and a single-sided entry has exactly
one of the two. So the `{}` of D1's table comes from the absence of the argument, not from a third
mode inside either function. The composition is exactly this, and a story that writes anything else is
wrong:

```ts
const selected = presence === "both" ? fields : null;
const submittedBranchValues =
  document === undefined
    ? {}
    : submittedValues(document, blobHashes.get(identity)!, selected);
const databaseBranchValues =
  node === undefined ? {} : storedValues(node, selected);
```

`document` and `node` are the two locals `src/queries/plan/validate-plan.ts:176-177` already binds, and
`blobHashes.get(identity)` is set for every `document !== undefined` case at `:189-197`, so the
non-null assertion is safe by construction and the story says so. Neither function takes `presence`,
so the presence rule lives in the one expression above and nowhere else.

**`choiceVerdict` is unchanged, and that is a deliberate boundary.** `src/domain/plan-choice.ts:36`
takes `ChoiceFacts` — `presence`, `state`, `fields`, `containmentMovable` — and it decides legality. It
has no node and no document, and giving it either would hand a legality decision the whole of both
values. `src/commands/plan/import-plan.ts:320` is its second caller and it needs no value at all. So
`validate-plan.ts` composes: it calls `choiceVerdict` exactly as it does today, then spreads
`verdict.submitted` and `verdict.database` and adds `values` to each.

`validate-plan.ts:213-229` already holds `node` and `document` in scope where it pushes the entry, so
the composition adds no read and no second pass.

**Key order in `values` is the `differingFields` order.** `body`, `depends_on`, `parent`, `repo`,
`title`, `worker` — which is `comparePaths` order over those six names, and the order `fields` already
arrives in from `src/domain/plan-diff.ts:38`. `storedValues` and `submittedValues` insert in that order
regardless of the order of their `fields` argument, so two calls that differ only in argument order
produce identical bytes. AGENTS.md requires it and the gate asserts it.

## Stories

Run them in this order. Each passes the full gate on its own except the second and third, which are
coupled: the contract declares a required `values` member and the query is what produces it, so the
tree is red between them. Run no gate between those two.

- **`plan.validate` publishes the choice values** — add `ChoiceValues`, `storedValues` and `submittedValues` to `src/domain/plan-diff.ts` per D2, D3 and D4, with the `fields`-of-`null` parameter that D4 specifies. Insert keys in `differingFields` order and never in argument order.
- **The contract declares the branch** — add `planChoiceBody`, `planChoiceValues` and `planChoiceBranch` to `src/http/contract/graph.ts` per D1, replace the two inline branch objects of `planChoiceEntry` at lines 68-76 with `planChoiceBranch`, and add `path: z.string().nullable()` to `planChoiceEntry` per D2. Import `blobHash` from `src/domain/blob.ts`, which line 23 already imports. **Populate the example.** `planValidateExamples.success.choices` at `src/http/contract/graph.ts:236` is `[]`, and `planImportExamples.request.choices` at `:262` is `[]`, so the published document carries no example of a choice entry at all and would carry no example of `values`. Add exactly one entry to `planValidateExamples.success.choices`: a `both` entry with `fields: ["title"]`, `suggested: "submitted"`, both branches `legal: true` with `reason: null`, and a one-key `values` per branch holding two different titles. That is the entry the client renders, and D6 of `021-provider-contract-and-default-transfer.md` makes the example suite parse it against this schema, so a wrong example fails the gate. Leave `planImportExamples` unchanged; its `choices` member is the request shape, which this epic does not touch. Regenerate `src/http/contract/field-decisions.fixture.ts` with `node scripts/field-decisions-probe.mjs --write`; the `submitted` and `database` rows at lines 320-321 and 328-329 gain a `values` sibling and the `planChoiceValues` leaves appear under each.
- **The query composes the values** — in `src/queries/plan/validate-plan.ts:213-229`, keep the `choiceVerdict` call exactly as it is and build each branch as `{ ...verdict.submitted, values: … }` and `{ ...verdict.database, values: … }`, using the exact composition D4 prescribes, including the `document === undefined` and `node === undefined` guards that produce `{}`. Set `path` to `document?.path ?? null`. Add no read, no second loop and no `presence` branch beyond the one `selected` expression. `src/commands/plan/import-plan.ts` changes in no way.
- **The proposal records the choice values** — `docs/proposal/api/graph.md` gains the `values` member in its `plan.validate` section: the six names, the `body` pair, the normalized `depends_on`, D1's presence table in one sentence per row, the three states of an absent key versus a `null` value, the `path` member, and D2's retrieval rule — the database side through `blob.show`, the submitted side through `documents` joined by `path`, and the statement that a submitted hash is not in the blob store. `docs/proposal/api/new-decisions.md` gains one row, because no proposal file names this member today. `src/http/contract/parity.test.ts` reads the route status table and no status changes, so parity is unaffected.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/domain/plan-diff.test.ts \
  src/domain/plan-choice.test.ts \
  src/queries/plan/validate-plan.test.ts \
  src/commands/plan/import-plan.test.ts \
  src/http/server/plan/validate-plan.test.ts \
  src/http/contract/graph.test.ts \
  src/http/contract/coverage.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/openapi.test.ts \
  src/http/contract/parity.test.ts && echo "PASS EPIC-027"
```

Hermetic coverage required beyond the Proof:

- A `both` entry whose `fields` is `["title"]`: `submitted.values` deep-equals `{ title: "<the document title>" }` and `database.values` deep-equals `{ title: "<the stored title>" }`. Exactly one key on each side. This is the entry the client named.
- A `database-only` entry: `database.values` holds all six names with the stored node's values, and `submitted.values` deep-equals `{}`. Its `fields` is `[]`, and the test asserts that too, because an empty `fields` beside a populated `values` is the fact D1 turns on.
- A `document-only` entry: the mirror of the above, `submitted.values` complete and `database.values` `{}`.
- A `both` entry whose `fields` is `[]` — two identical sides: both `values` deep-equal `{}`.
- A `both` entry differing only in acceptance text: `fields` is `["body"]`, and each `values.body` deep-equals `{ instructionBlob: <the same hash on both sides>, acceptanceBlob: <a different hash per side> }`. Asserts that `body` names both blobs, per D2.
- A `both` entry whose stored acceptance is absent and whose document supplies one: `database.values.body.acceptanceBlob` is `null` and the submitted one is a hash.
- A `both` entry whose dependency lists differ only in order, with a repeat on one side: `fields` does **not** contain `depends_on` and neither `values` carries it. Then the same case with a genuinely different member: both `values.depends_on` are the **normalized** lists — sorted by `comparePaths`, duplicates dropped — asserted as exact arrays. This is D3, and the first half is what makes it a rule rather than a preference.
- A `depends_on` case with a non-ASCII identity, asserting `comparePaths` order and not `Buffer.compare` order. The two differ, and the test names which one it asserts.
- `Object.keys(values)` of an entry whose `fields` is all six names deep-equals `["body", "depends_on", "parent", "repo", "title", "worker"]`, and the same call with the `fields` argument reversed returns the identical array. Two calls produce identical `JSON.stringify` bytes. This is the D4 determinism claim.
- **A submitted hash is not in the blob store, asserted rather than assumed.** After a `plan.validate` call over a document set that differs from the stored graph, `BlobStore.get(<the submitted instructionBlob>)` returns `null`, and `BlobStore.get(<the database instructionBlob>)` returns a record. This is the fact D2's retrieval rule turns on, and a later epic that made `plan.validate` write blobs would fail this assertion and have to amend the decision.
- `path` equals the submitted document's path for a `both` entry and for a `document-only` entry, and is `null` for a `database-only` entry. For every entry whose `path` is non-null, exactly one member of the response's `documents` array carries that path, asserted by lookup. This is the join the client performs.
- `planChoiceEntry.safeParse` refuses the pre-epic entry — a branch of `{ legal, reason }` with no `values` — and refuses `values: { title: 1 }` and `values: { unknown: "x" }`. The first pins that `values` is required, the last pins `additionalProperties: false`.
- `choiceVerdict` is byte-identical before and after: its `ChoiceFacts` input, its `ChoiceVerdict` output and every existing case of `src/domain/plan-choice.test.ts` are unchanged, and `src/commands/plan/import-plan.test.ts` passes with no edit. This is the D4 boundary, asserted as an absence of change.
- `planValidateResponse.parse(planValidateExamples.success)` succeeds, and the parsed choice entry's `submitted.values` and `database.values` each hold exactly one `title` key with different values. The published example is the one a client copies, so it is asserted and not only present.
- `plan.validate` through the real koa app returns a body that `planValidateResponse` parses, for a project holding one `both` conflict, one `document-only` entry and one `database-only` entry in one call.
- The `plan.validate` call performs the same number of `PlanStore` reads as it does on the pre-epic tree, counted through a counting fake. This asserts D4's "no extra read".
- A publish into a temporary directory carries `values` under both branches and the `path` member in `features/plan.yaml`:

```bash
node scripts/publish-contract.ts "$(mktemp -d)"
```

## Open items

- **Two corrections are owed to the client, and each falsifies something the reply at `e2ff3cf` asserted.** They go out before the client builds the choice screen, and neither is a change of decision.
  1. A `body` value is a pair of blob hashes, not a plain string pair. D2.
  2. `values` is driven by `presence`, not by `fields`. D1's table supersedes the rule the client holds, and it gives the client strictly more than it asked for on the single-sided entries. Send the table itself, not a summary of it.
- **Two additions the client needs and the reply did not carry, which are new facts rather than corrections.** The three states of an absent key versus a `null` value, per D1; and D2's retrieval rule with the `path` member, including the statement that a submitted blob hash resolves through `documents` and **not** through `blob.show`. The second is the one that decides how the choice screen fetches text.
- The published artifact changes shape, so `npm run contract:publish -- ../kanthord-apps/docs/api/contract` runs from a clean tree after this epic lands. Under `024-release-bound-contract-publish.md` that publish also requires the release tag. `026-event-tail-read.md` needs its own publish; the split accepts two.
- **A choice value set is not a diff, and no epic owns one.** If the client later reports that two value sets are insufficient — a long dependency list is the likely case — the answer is a rendering decision in the client, or a new epic that owns a diff format for the whole product. It is not a second member on this branch.
