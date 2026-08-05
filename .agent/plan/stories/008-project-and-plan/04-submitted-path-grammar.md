# Story 04 — the submitted path grammar

Epic: `.agent/plan/epics/008-project-and-plan.md`

A submitted path is the only thing that carries containment and dependency before identities exist, so the grammar is closed and the derived parent comes from it.

## Change

### 1. `src/domain/plan-path.ts` (new — pure)

```ts
export type SubmittedPathErrorCode =
  | "path-not-under-plan"
  | "path-not-markdown"
  | "path-empty-segment"
  | "path-dot-segment"
  | "path-backslash"
  | "path-nul"
  | "path-absolute"
  | "path-not-scalar"
  | "path-kind-mismatch";

export class SubmittedPathError extends Error {
  readonly code: SubmittedPathErrorCode;
}

export type SubmittedPathShape = Readonly<{
  kind: NodeKind;
  initiativeDirectory: string;
  objectiveDirectory: string | null;
}>;

export function parseSubmittedPath(path: string): SubmittedPathShape;

export function comparePaths(left: string, right: string): number;

export function resolveRelativePath(
  fromDirectory: string,
  reference: string,
): string | null;
```

`parseSubmittedPath` checks in this fixed order, and the first failure throws:

0. The path holds an unpaired surrogate → `path-not-scalar`. The test is `/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/`. This check is first, and it is what makes `comparePaths` correct — see below.
1. `path.includes("\0")` → `path-nul`.
2. `path.includes("\\")` → `path-backslash`.
3. `path.startsWith("/")` → `path-absolute`.
4. `path.split("/")` holds an empty string → `path-empty-segment`.
5. A segment equal to `.` or `..` → `path-dot-segment`.
6. The first segment is not `plan` → `path-not-under-plan`.
7. The path does not end with `.md` → `path-not-markdown`.
8. The segment count and the last segment decide the kind:
   - three segments and the last is `initiative.md` → `initiative`, `initiativeDirectory = segments[1]`, `objectiveDirectory = null`.
   - four segments and the last is `objective.md` → `objective`, `objectiveDirectory = segments[2]`.
   - four segments and the last is neither `initiative.md` nor `objective.md` → `task`.
   - anything else → `path-kind-mismatch`.

The comparison is case-sensitive throughout. `docs/proposal/api/graph.md:52`.

`comparePaths` is the one ordering used for a document set, per `plan-format.md:50`, and it must equal `Buffer.compare` over the UTF-8 encodings. `domain/` may not import `node:*` (`eslint.config.js:204-219`), so it is written over code points:

```ts
export function comparePaths(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index]! !== b[index]!) return a[index]! < b[index]! ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
```

UTF-8 preserves code-point order, so this equals `Buffer.compare` for every **scalar-value** string. `Array.from` iterates code points, not UTF-16 code units, which is what makes a character above the BMP sort after `￿` rather than before it.

The scalar-value qualifier is load-bearing. For a string holding an **unpaired surrogate** the two disagree: `Buffer.from(value, "utf8")` encodes a lone surrogate as the three bytes of `U+FFFD`, while this comparator compares the surrogate code unit `0xD800`-`0xDFFF` directly, and `0xEF 0xBF 0xBD` orders differently from a `0xD800` code point. Check 0 of `parseSubmittedPath` therefore refuses such a path outright, so no value that reaches `comparePaths` can hit the disagreement. `comparePaths` itself performs no check: it is called on canonical paths too, which are ASCII by construction.

The test asserts agreement with `Buffer.compare` over a table that includes an above-the-BMP pair, and it may import `node:buffer` because `eslint.config.js:205` exempts `src/domain/**/*.test.ts`.

`resolveRelativePath(fromDirectory, reference)` resolves POSIX segments: split `reference` on `/`, drop every `.`, pop one segment per `..`, and append the rest to the segments of `fromDirectory`. A `..` that would pop past the first segment returns `null`. The result is joined with `/`. It performs no file system work and no existence check.

### 2. `src/domain/plan-path.ts` — the derived parent

```ts
export function derivedParentPath(path: string): string | null;
```

- An `initiative` returns `null`.
- An `objective` returns `plan/<initiativeDirectory>/initiative.md`.
- A `task` returns `plan/<initiativeDirectory>/<objectiveDirectory>/objective.md`.

The derived parent is a **path**, not an identity. Story 06 maps it to an identity. `plan-format.md:123` — a path that moves without changing the derived parent is cosmetic, and this function is what makes that comparable.

## Constraints

- `src/domain/plan-path.ts` imports `NodeKind` from `src/domain/state.ts` and nothing else. No `node:*`, no vendor package.
- Every check is case-sensitive. `Plan/x/initiative.md` is `path-not-under-plan`.
- The check order above is exact. A path with two faults reports the earlier one, and a test pins that.
- `comparePaths` is bytewise. No `localeCompare`, no `Intl`, no bare `<` on the raw strings.
- A duplicate path is not this module's concern. Story 05 collects it as a finding.

## Verify

`node --test src/domain/plan-path.test.ts`

- The three legal shapes parse: `plan/a--01/initiative.md`, `plan/a--01/b--02/objective.md`, `plan/a--01/b--02/01-c--03.md`, each with the exact `SubmittedPathShape`.
- `plan/a--01/b--02/initiative.md` is `path-kind-mismatch`. So is `plan/a--01/objective.md`, `plan/initiative.md`, `plan/a--01/b--02/c--03/objective.md` and `plan/a--01/b--02/c--03/04-d.md`.
- Each of the nine error codes is reached by one named case.
- **The order is pinned.** `plan/a//b\\c.md\0` prefixed with a lone `\uD800` reports `path-not-scalar`; removing the surrogate reports `path-nul`; removing the NUL reports `path-backslash`; removing the backslash reports `path-empty-segment`. Four cases over one degrading input.
- **The surrogate cases.** A high surrogate with no low one, a low surrogate with no high one, and a correctly paired emoji: the first two are `path-not-scalar` and the third parses.
- `docs/plan/a--01/initiative.md` is `path-not-under-plan`. `/plan/a--01/initiative.md` is `path-absolute`.
- `plan/a--01/initiative.MD` is `path-not-markdown`.
- `plan/a--01/../a--01/initiative.md` is `path-dot-segment`.
- `derivedParentPath` returns the three expected values, and `null` for an initiative.
- Two objectives under one initiative derive the same parent path. Moving a task between two objective directories changes the derived parent; renaming its own file does not.
- **`comparePaths` is bytewise.** A table of pairs including `"plan/é.md"` vs `"plan/z.md"`, `"plan/ü.md"` vs `"plan/v.md"`, and a pair differing only above the BMP (`"plan/\u{1F600}.md"` vs `"plan/�.md"`). For each pair assert `Math.sign(comparePaths(a,b)) === Math.sign(Buffer.compare(Buffer.from(a,"utf8"), Buffer.from(b,"utf8")))`.
- **The locale trap.** `"plan/é.md"` vs `"plan/z.md"` — assert `comparePaths` puts `z` first (its first differing byte is `0x7a`, below `0xc3`) and that `a.localeCompare(b, "en")` returns the opposite sign. The locale is named explicitly: a bare `localeCompare` reads the ambient default and would make the oracle non-hermetic. The assertion fails a locale-sensitive implementation that an all-ASCII table would pass.
- **An unpaired surrogate is out of scope for the comparator.** `comparePaths` is not called on such a value anywhere, because check 0 refuses it. The test states that as a comment on the table rather than asserting a behaviour the product cannot reach.
- `resolveRelativePath("plan/a--01/b--02", "01-c--03.md")` is `"plan/a--01/b--02/01-c--03.md"`.
- `resolveRelativePath("plan/a--01/b--02", "../c--04/objective.md")` is `"plan/a--01/c--04/objective.md"`.
- `resolveRelativePath("plan/a--01/b--02", "./x.md")` is `"plan/a--01/b--02/x.md"`.
- `resolveRelativePath("plan", "../x.md")` is `null`.
- `resolveRelativePath("plan/a--01", "plan/a--01/initiative.md")` is `"plan/a--01/plan/a--01/initiative.md"` — the function is purely relative and never guesses a root. Story 06 owns the second resolution base.

`npm run verify` exits 0.

Proof: contributes `src/domain/plan-path.test.ts`. It is inside the EPIC Proof glob, so it delivers `PASS EPIC-008`.
