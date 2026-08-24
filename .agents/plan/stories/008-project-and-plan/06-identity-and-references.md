# Story 06 — identity minting and reference resolution

Epic: `.agents/plan/epics/008-project-and-plan.md`
Depends on: Story 04 (`resolveRelativePath`), Story 05 (`Finding`).

ULID first, then path. An unresolved or ambiguous reference fails (`docs/proposal/phase-1/plan-format.md:29`).

## Change

### 1. `src/domain/plan-identity.ts` (new — pure)

```ts
export type IdentityInput = Readonly<{
  documents: readonly ParsedDocument[];
  databaseIdentities: readonly string[];
}>;

export type ResolvedDocument = ParsedDocument &
  Readonly<{
    identity: string;
    minted: boolean;
    parentIdentity: string | null;
    dependencies: readonly string[];
  }>;

export type ResolveIdentitiesResult = Readonly<{
  resolved: readonly ResolvedDocument[];
  findings: readonly Finding[];
}>;

export function resolveIdentities(
  dependencies: Readonly<{ mint: (kind: NodeKind) => string }>,
  input: IdentityInput,
): ResolveIdentitiesResult;
```

`mint` is a plain function type, not the `IdGenerator` interface: `domain/` may import only `domain/`, and the caller passes `ids.mint.bind(ids)`. That is what lets both `plan.validate` and `plan.import` call one resolver.

**Minting.** A document whose `id` is absent gets `mint(kind)`, where `kind` is the document's own `kind` — `initiative`, `objective` or `task` are all `IdentityKind` members (`src/domain/identity.ts:3-21`) and their prefixes equal their kind names (`:25-43`). `minted` is `true` for those. A document whose `id` is present keeps it and `minted` is `false`.

The mint order is the documents sorted by `comparePaths` on the submitted path, ascending. That is the determinism rule: the same submission mints the same identity for the same document, whatever order the array arrived in.

**A refusal after this point keeps the identities it minted.** `plan.validate` mints on a read path by design, and `plan.import` mints here at its step 6, before the `documentsHash` comparison of step 7 that consumes those identities (Story 11:228). So an import refused with `plan-invalid`, `choices-changed` or `choices-invalid` has already spent one ULID per id-less document. A ULID space is unbounded, so this costs nothing in production. It matters in one place only: a test whose mock id generator is constructed with exactly the ULIDs a successful run consumes will throw `ids-exhausted` on a refusal path. Size the mock for the refusal, not for the success.

**Identity checks.** For a present `id`:

- `parseIdentity(id)` returning `null` is `identity-invalid`.
- `parseIdentity(id).kind !== document.kind` is `identity-kind-mismatch`. `docs/proposal/phase-1/plan-format.md:135` — one ULID payload under two kind prefixes is that refusal, and this is the check that produces it. The rule compares the **kind**, so `task_<u>` in a document whose path derives an objective, and `objective_<u>` carrying the same `<u>` as a `task_<u>` elsewhere in the submission, are both caught: the second case is detected by grouping the submission's identities by their ULID payload and reporting `identity-kind-mismatch` for any payload appearing under two prefixes.
- The same full identity on two documents is `identity-duplicate`, reported once per extra occurrence.

A document with an `identity-invalid` or `identity-kind-mismatch` finding is excluded from `resolved` and no identity is minted for it.

**Reference resolution**, per `depends_on` entry, in this order:

1. `parseIdentity(entry)` is non-null → the entry is an identity. It must name a document of the submission or a member of `databaseIdentities`; otherwise `reference-unresolved`.
2. Otherwise the entry is a path. Resolve it twice: against the declaring document's own directory, and against `"plan"`. Keep every result that names a submitted path.
   - No result is `reference-unresolved`.
   - Two results naming **different** submitted paths is `reference-ambiguous`. Two bases resolving to the same path is one result and is not ambiguous.
   - One result yields the identity of that document.

Two bases are accepted because `docs/proposal/database/edge.md:27` shows a bare sibling basename (`01-render-json.md`) and `plan-format.md:29` states only "a relative file path". Two plausible bases is exactly the condition `ambiguous` names, so both are resolved and the collision is reported rather than silently preferred.

`dependencies` on a `ResolvedDocument` holds the resolved identities, de-duplicated, bytewise ascending. A repeated `depends_on` entry is not a finding, because `edge` carries `UNIQUE (from_node, to_node)` and a repeat expresses the same edge.

`parentIdentity` is the identity of the submitted document at `derivedParentPath`, and `null` when no submitted document holds that path. The database stores no path, so a parent that is not in the submission cannot be found by path here. Story 11 fills that case from the stored `parent_id` of the existing node, and Story 05's containment pass reports `parent-missing` when neither side supplies one.

### 2. `src/domain/plan-validate.ts` — call it

Pass 4 of Story 05 calls `resolveIdentities` and appends its findings. `ValidationResult.documents` becomes `readonly ResolvedDocument[]` rather than `readonly ParsedDocument[]`. `plan-validate.ts` and `plan-identity.ts` are both under `domain/`, and `domain/` may import `domain/`.

## Constraints

- The mint order is the canonical-path-ascending order of the submitted paths. It is asserted with a mock id generator and a reversed input array.
- `mint` is called exactly once per document lacking an `id`, and never for a document carrying one. A test counts the calls.
- No identity is minted for a document that already produced an identity finding.
- Resolution order is identity, then path. A `depends_on` value that is a valid identity is never resolved as a path, even when a submitted path spells the same text.
- `parseIdentity` and `identityPrefixes` come from `src/domain/identity.ts`. This story adds no identity kind, so `identity.test.ts:18,22` (17 kinds) need no edit.

## Verify

`node --test src/domain/plan-identity.test.ts`

`mint` is `createMockIdGenerator({ ulids: [...] })`'s method (`test/helpers/ids.ts:8`) wrapped in a recorder that counts calls per kind.

- **Minting is by canonical path order.** Three documents submitted in reverse path order mint the mock's ULIDs in path-ascending order, asserted as an exact `(path, identity)` table. The same submission in forward order yields the identical table.
- A document carrying `id: "task_01ARZ3NDEKTSV4RRFFQ69G5FAV"` keeps it, `minted === false`, and the recorder counted zero mints.
- A submission mixing four authored ids and two absent ones consumes exactly two mock ULIDs.
- `ids-exhausted` from the mock propagates as a thrown `IdGeneratorError`, not as a finding. Running out of identities is a daemon fault.
- **`identity-invalid`.** `id: "task_nope"`, `id: "01ARZ3NDEKTSV4RRFFQ69G5FAV"` (no prefix) and `id: "widget_01ARZ3NDEKTSV4RRFFQ69G5FAV"` each yield one finding, and the document is absent from `resolved`.
- **`identity-kind-mismatch`, both shapes.** A document whose path derives a task carrying `objective_<u>`; and two documents, one `task_<u>` and one `objective_<u>` sharing one ULID payload `<u>`, which yields the finding for both.
- **`identity-duplicate`.** The same `task_<u>` on two documents yields exactly one finding; on three documents, two.
- **Resolution: identity first.** A `depends_on` entry that is a valid `task_<u>` naming a submitted document resolves to it. The same entry when `<u>` names nothing yields `reference-unresolved`. An entry naming a member of `databaseIdentities` resolves with no finding.
- **Resolution: sibling basename.** `depends_on: ["01-a--01ARZ3NDEKTSV4RRFFQ69G5FAV.md"]` from a task in the same objective directory resolves to that task's identity.
- **Resolution: root-relative path.** `depends_on: ["plan/i--01/o--02/01-a--03.md"]` from a task in a different objective resolves to it. (Story 05 then reports `dependency-cross-parent`; this story reports the resolution.)
- **`reference-ambiguous`.** Two submitted documents exist at `plan/i--01/o--02/plan/x--05.md` and `plan/x--05.md`; a `depends_on` of `plan/x--05.md` declared from `plan/i--01/o--02/objective.md` resolves to both, and yields exactly one `reference-ambiguous` naming both resolved paths in the message.
- A value resolving to the same path under both bases yields one dependency and no finding.
- `depends_on: ["../nope.md"]` from `plan/i--01/initiative.md` yields `reference-unresolved`, because `resolveRelativePath` returns `null` for the first base and the second base finds nothing.
- `dependencies` is de-duplicated and bytewise ascending: `depends_on` naming one task by identity and by path yields one entry.
- `parentIdentity` is the objective's identity for a task, the initiative's for an objective, and `null` for an initiative.
- **Determinism.** Every case runs twice with a fresh mock and the two results `deepEqual`.

`npm run verify` exits 0.

Proof: contributes `src/domain/plan-identity.test.ts`. It is inside the EPIC Proof glob, so it delivers `PASS EPIC-008`.
