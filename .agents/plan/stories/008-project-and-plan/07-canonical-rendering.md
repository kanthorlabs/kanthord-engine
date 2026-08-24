# Story 07 — canonical rendering

Epic: `.agents/plan/epics/008-project-and-plan.md`
Depends on: Story 03 (the body split), Story 04 (`comparePaths`).

One plan revision has exactly one byte representation. Every rule below is from `docs/proposal/phase-1/plan-format.md:39-50`.

## Change

### 1. `src/domain/plan-slug.ts` (new — pure)

```ts
export function slug(title: string): string;
```

Lowercase the title, keep `a-z` and `0-9`, replace each run of any other character with one `-`, trim one leading and one trailing `-`, truncate to 48 characters, and return `"node"` when the result is empty. Truncation happens **after** trimming, and a truncation that leaves a trailing `-` trims it again — otherwise a 49-character title would produce a path segment ending in `-`.

Lowercasing is `toLowerCase()`. A non-ASCII letter is not in `a-z`, so it becomes part of a `-` run: `"Café ☕ time"` is `"caf-time"`.

### 2. `src/domain/plan-canonical-path.ts` (new — pure)

```ts
export type CanonicalNode = Readonly<{
  identity: string;
  kind: NodeKind;
  title: string;
  parentIdentity: string | null;
  dependencies: readonly string[];
}>;

export function canonicalPaths(
  nodes: readonly CanonicalNode[],
): ReadonlyMap<string, string>;
```

Per node, the segment is `` `${slug(title)}--${ulidOf(identity)}` `` where `ulidOf` is the ULID part of `parseIdentity(identity)` **lowercased**. The full 26 characters, always, so adding a sibling never renames an existing file (`plan-format.md:39`).

- initiative → `plan/<segment>/initiative.md`
- objective → `plan/<initiative segment>/<segment>/objective.md`
- task → `plan/<initiative segment>/<objective segment>/<NN>-<segment>.md`

`NN` is the task's 1-based position in `taskOrder({ tasks, edges })` from `src/domain/task-order.ts:28`, run over the tasks of that one objective, zero-padded to `Math.max(2, String(siblingCount).length)`.

The edges passed to `taskOrder` are the dependency edges whose both endpoints are tasks of that objective, each with `waived: false`. A waiver never renames a file, so the walk ignores `waived_at` entirely — `taskOrder` filters on the flag at `:68`, and passing `false` keeps every edge in the ordering.

`taskOrder` already implements the required walk: it seeds with the sorted in-degree-zero set and re-inserts a freed task at its sorted position (`:81-100`), which is "the Kahn walk that takes the lexicographically smallest identity whenever several tasks are available" (`plan-format.md:41`). All tasks share the `task_` prefix, so a plain string comparison is correct (`docs/proposal/database/node.md:40`).

A `TaskOrderError` propagates. A cycle inside an objective is a validation finding of Story 05 and can never reach a render.

### 3. `src/domain/plan-render.ts` (new — pure)

```ts
export type RenderInput = Readonly<{
  identity: string;
  kind: NodeKind;
  title: string;
  dependencies: readonly string[];
  worker: string | null;
  repo: string | null;
  instruction: string;
  acceptance: string | null;
}>;

export function renderDocument(input: RenderInput): string;

export function quoteScalar(value: string): string;
```

The output is, in this exact order:

```
---
id: <quoted identity>
kind: <quoted kind>
title: <quoted title>
depends_on:
  - <quoted identity>
  - <quoted identity>
worker: <quoted worker>
repo: <quoted repo>
---
<instruction><acceptance>
```

- The key order is `id`, `kind`, `title`, `depends_on`, `worker`, `repo`. An absent field is omitted, never rendered as `null`. An **empty** `dependencies` array omits the whole `depends_on` key, because an empty block sequence has no canonical spelling and an absent field is the rule for a field with nothing to say.
- `depends_on` is a block sequence, two spaces then `- `, one entry per line, sorted with `comparePaths` over the identities. Identities are ASCII, so the sort is the lexicographic sort `plan-format.md:47` requires.
- The body is `instruction + (acceptance ?? "")`. Story 03's split guarantees that concatenation reproduces the normalized body byte for byte, so the renderer holds no knowledge of the acceptance heading.
- The document ends with exactly one LF, which `normalizeBody` already guarantees for the body. `renderDocument` asserts it by construction: if the concatenated body does not end with `\n`, one is appended.
- LF only. No CR is ever emitted.

`quoteScalar` is the one escaping rule: wrap in `"`, and inside it replace `\` with `\\`, `"` with `\"`, LF with `\n`, CR with `\r`, TAB with `\t`, and every other code point below `0x20` plus `0x7f` with `\xHH` in lowercase hex. Every other code point is emitted literally as UTF-8. No anchor, no alias, no flow collection, no single quote, no block scalar.

### 4. `src/domain/plan-render.ts` — the document set

```ts
export type RenderedDocument = Readonly<{ path: string; content: string }>;

export function renderDocumentSet(
  nodes: readonly CanonicalNode[],
  bodies: ReadonlyMap<
    string,
    Readonly<{
      instruction: string;
      acceptance: string | null;
      worker: string | null;
      repo: string | null;
    }>
  >,
): readonly RenderedDocument[];
```

One entry per node, ordered by `comparePaths` on the canonical path. A node absent from `bodies` throws — a caller that lost a blob is a defect, not a rendering choice.

## Constraints

- `src/domain/plan-slug.ts`, `plan-canonical-path.ts` and `plan-render.ts` import only from `src/domain/`. No `node:*`, no vendor package, no `yaml`. The renderer is hand-written because a stringifier's output is not a byte contract.
- Every emitted scalar goes through `quoteScalar`. No template literal writes a raw frontmatter value.
- Document order is `comparePaths`, never `sort()` and never `localeCompare`.
- The ordinal walk passes `waived: false` for every edge.
- The ULID part of a path segment is lowercase; the identity inside the frontmatter keeps its authored uppercase form, because `src/domain/identity.ts:45` fixes the ULID alphabet as uppercase and the row stores that.

## Verify

`node --test src/domain/plan-slug.test.ts src/domain/plan-canonical-path.test.ts src/domain/plan-render.test.ts`

### `plan-slug.test.ts`

- `"Harden the verify CLI"` → `"harden-the-verify-cli"`.
- `"  --Hello,   World!!  "` → `"hello-world"`.
- `"Café ☕ time"` → `"caf-time"`.
- `"日本語"` → `"node"`.
- `""` → `"node"`, `"---"` → `"node"`, `"!!!"` → `"node"`.
- A 60-character all-`a` title truncates to 48 `a`s.
- A title whose 48th and 49th characters straddle a `-` run truncates and re-trims, so the result never ends in `-`. Asserted with an exact expected string.
- `"A1 b2"` → `"a1-b2"` — digits survive.
- Idempotence: `slug(slug(x)) === slug(x)` over the whole table.

### `plan-canonical-path.test.ts`

- One initiative, two objectives, five tasks: the returned map deep-equals an exact `(identity, path)` table with literal ULIDs.
- The ULID in a path segment is lowercase, and the same ULID inside `id:` is uppercase. One assertion on one node covers both.
- **The ordinal is the Kahn walk.** Three tasks with `03 → 01` and `02` free (`from` depends on `to`): assert the exact ordinals, and assert they differ from the identity-ascending order by naming both.
- **Width.** Nine sibling tasks give `01`..`09`; ten give `01`..`10`; one hundred give `001`..`100`; one gives `01`. Four cases on `Math.max(2, digits)`.
- **A waiver never renames.** The same objective rendered with an edge marked waived in the source data returns paths identical to the unwaived render. Asserted by calling with the edge present in both cases, because the function passes `waived: false` regardless.
- **Adding a sibling renames nothing.** Render four tasks, then five with one inserted whose identity sorts first, and assert that the four original paths that keep their ordinal keep their whole path — specifically that the ULID part of every existing segment is unchanged.
- Two nodes with the same title under one parent produce two different paths, because the ULID is always present.
- A title that slugs to `"node"` produces `node--<ulid>`, and two such siblings do not collide.
- Determinism: two calls on one input `deepEqual`, and a call with the nodes array reversed returns the same map.

### `plan-render.test.ts`

Every assertion is an exact string compared with `assert.equal`, written as a template literal in the test.

- A full task renders exactly:

  ```
  ---
  id: "task_01ARZ3NDEKTSV4RRFFQ69G5FAV"
  kind: "task"
  title: "Render JSON"
  depends_on:
    - "task_01ARZ3NDEKTSV4RRFFQ69G5FAW"
  worker: "tdd@1"
  ---
  Do the thing.
  ## Acceptance criteria
  - it works
  ```

- An objective renders `repo` after `worker`; an initiative renders neither.
- An empty `dependencies` omits the `depends_on` key entirely.
- Two dependencies render as two block entries, sorted ascending, asserted with the input in descending order.
- `acceptance: null` renders the instruction alone.
- A body already ending in one LF is unchanged; a body ending in none gains one; a body ending in three keeps the one `normalizeBody` left. (The last case is constructed by passing an unnormalized body directly, to prove the renderer's own guard.)
- **`quoteScalar`, one case per rule.** `a"b` → `"a\"b"`; `a\b` → `"a\\b"`; a LF → `"\n"`; a CR → `"\r"`; a TAB → `"\t"`; `�` → `"\x00"`; `` → `"\x1f"`; `` → `"\x7f"`; `"héllo ☕"` emitted literally; `"'quoted'"` keeps its single quotes literally inside the double quotes.
- A title containing `---` renders inside one quoted scalar and does not break the frontmatter, asserted by splitting the output on `\n---\n` and finding exactly two delimiter lines.
- No output contains `\r`. Asserted over every case in a loop.
- Every output ends with exactly one `\n`. Asserted over every case in a loop.
- **The document set order is `comparePaths`.** A six-document set returns one exact path array. A canonical path is always ASCII, because `slug` keeps only `a-z` and `0-9` and a ULID is uppercase ASCII — so the non-ASCII half of the EPIC's bytewise-ordering coverage line cannot be reached through a canonical path. It is reached on the **submitted** path, which a human authors and which carries any byte: `src/domain/plan-path.test.ts` asserts `comparePaths` against `Buffer.compare` over a non-ASCII table and against the opposite `localeCompare` sign (Story 04), and Story 11 asserts the same ordering on the `submitted_blob` byte sequence. See index item S2.
- **The renderer never sorts by anything else.** Read the three module sources and assert none contains `localeCompare`, `Intl` or a bare `.sort()`.

- A node absent from `bodies` throws.

`npm run verify` exits 0.

Proof: contributes `src/domain/plan-slug.test.ts`, `plan-canonical-path.test.ts` and `plan-render.test.ts`. It is inside the EPIC Proof glob, so it delivers `PASS EPIC-008`.
