# Story 4 — The proposal records the choice values

Epic: `.agent/plan/epics/027-plan-choice-values.md`
Depends on: Story 2 and Story 3.

> **B1 is resolved: `path` is the canonical path of the submitted document.** The EPIC's D2 says so, and the paragraphs below are written to it.

Documentation only. No file under `src/` or `scripts/` changes.

## Change

### `docs/proposal/api/graph.md`

The `plan.validate` section is lines 28-40. Line 32 reads `The body is the body of \`plan.import\` without \`importId\` and without \`choices\`. The response holds:` and introduces a bullet list at lines 34-38. Line 38 today reads:

```
- one entry per node of the required choice set: the identity, the suggested choice, the differing field names, the current state for display, and the legality of each choice with its reason.
```

Replace that one line with this line, which adds the two new members to the same clause:

```
- one entry per node of the required choice set: the identity, the suggested choice, the differing field names, the current state for display, the canonical path of the submitted document, and the legality of each choice with its reason and the field values of that side.
```

Then add these four paragraphs immediately after line 40 (the "provisional in name only" paragraph), separated by one blank line each, and before the `## \`plan.import\`` heading at line 42:

```
Each choice branch carries `values`, the field values of the side that branch leaves in place. The six names are `body`, `depends_on`, `parent`, `repo`, `title` and `worker`, spelled exactly as they appear in the `fields` array, so a client indexes `values` by a member of `fields` with no mapping table.

**Presence decides which names appear, not `fields`.** A `both` entry carries exactly the names in `fields` on each branch, so two identical sides carry `{}` on both. A `document-only` entry carries all six names under `submitted` and `{}` under `database`. A `database-only` entry is the mirror: all six names under `database` and `{}` under `submitted`. A single-sided entry has an empty `fields` array by construction, so `{}` never means "no value" — it means "nothing to choose".

**An absent key and a present `null` differ.** An absent key means the name is not represented on that branch, either because it is not in `fields` or because that branch holds no node. A key present with `null` means the branch holds a node and that node has no parent, no repository or no worker. `depends_on` is the normalized list the comparison used, sorted and deduplicated, so a client cannot draw a conflict the daemon did not find.

**A `body` value is a pair of blob hashes, never prose.** It is `{ instructionBlob, acceptanceBlob }`, and `acceptanceBlob` is `null` when that side has no acceptance. The two sides resolve their text differently. The `database` hashes were written at import, so `blob.show` serves them. **A submitted hash is not in the blob store**, because `plan.validate` hashes and writes nothing, so `blob.show` cannot serve it; the submitted text is already in the same response, under `documents`. The entry's `path` member is the join key: it is the **canonical** path of the submitted document for a `both` or `document-only` entry, and `null` for a `database-only` entry, which has no document. It is the canonical path and not the authored one, because `documents` is the normalized set, so only the canonical path names a member of it.
```

Change no other line. Do not touch the route table row at line 15. Do not touch the `node.create`, `node.update` or `node.delete` headings, and do not touch the concurrency-classes paragraph at line 176 — `src/http/contract/proposal-amendment.test.ts` asserts both verbatim after whitespace squashing.

The fourth paragraph states the join key as the canonical path, which is B1's resolution. Do not write "the submitted document's path" — that phrasing is the defect B1 corrected.

### `docs/proposal/api/new-decisions.md`

The file is bullet lists only — no table. Add exactly one bullet to `## Decided here`, immediately after the existing `plan.validate` bullet at line 20 (`- **\`plan.validate\` exists, and it is also the suggestion route.** …`) and before the plan-document-shape bullet at line 21:

```
- **A choice branch carries the field values of its own side.** Each branch of a `plan.validate` choice entry carries `values`, so a human resolving a conflict sees what each branch holds instead of an identity alone. Presence decides which of the six names appear, not `fields`: a `both` entry narrows to the differing names, and a single-sided entry publishes all six on the side that holds a node and `{}` on the other. A `body` value is a pair of blob hashes and never prose, because a plan body is unbounded and `blob.show` is the declared reader of a blob. The stored hashes resolve through `blob.show`; a submitted hash resolves through `documents`, joined by the entry's new `path` member, which carries the canonical path because `documents` is the normalized set. `plan.validate` writes nothing and never stores the submitted blobs. A blob-addressed diff was refused, not deferred: it would make a read path write. See [graph.md](graph.md).
```

Add nothing to `## Rejected here` and nothing to `## Still open`. `## Still open` keeps the value `Nothing.`

### Formatting

`lint-staged` runs `prettier --write` over `*.md` from `.husky/pre-commit`. Run it so the committed bytes are stable:

```bash
npx prettier --write docs/proposal/api/graph.md docs/proposal/api/new-decisions.md
```

`.prettierrc.json` sets no `proseWrap`, so the default `preserve` applies and no paragraph reflows.

## Constraints

- The route matrix in `docs/proposal/api/graph.md` is unchanged. `src/http/contract/parity.test.ts` counts 70 comparable rows and 74 total rows, and it parses only lines starting with `|` that carry exactly five cells.
- Add no route, no operation id and no status change.
- Amend no other proposal file. `docs/proposal/api/event.md` belongs to EPIC 026.
- Say nothing about a diff format, a `diffBlob` or a client-side rendering rule. The epic ships none.
- Do not document `values` on `plan.import`. Its `choices` member is the request shape, `{ id, take }`, and it is unchanged.

## Verify

```bash
node --test src/http/contract/parity.test.ts \
  src/http/contract/proposal-amendment.test.ts
git status --porcelain
```

Assertions:

- `parity.test.ts` passes with 70 comparable and 74 total proposal rows, unchanged.
- `proposal-amendment.test.ts` passes. It reads `graph.md` whitespace-squashed and asserts the three node-route headings and the concurrency-classes paragraph verbatim; none of them is touched.
- `git status --porcelain` lists exactly two modified paths, `docs/proposal/api/graph.md` and `docs/proposal/api/new-decisions.md`, plus the untracked story directory. No path under `src/` or `scripts/` appears.
- `git diff docs/proposal/api/graph.md` shows one replaced line and four added paragraphs, and no other hunk.
- `git diff docs/proposal/api/new-decisions.md` shows exactly one added line.
- The replacement text survives `prettier --write` byte for byte. Verify with `grep -Fq` on each of these exact substrings, all four of which must be present in `graph.md`:

```
**Presence decides which names appear, not `fields`.**
```

```
**An absent key and a present `null` differ.**
```

```
**A `body` value is a pair of blob hashes, never prose.**
```

```
**A submitted hash is not in the blob store**
```

- `grep -c 'one entry per node of the required choice set' docs/proposal/api/graph.md` is `1`.
- `grep -c 'A choice branch carries the field values of its own side' docs/proposal/api/new-decisions.md` is `1`.
- `grep -c 'diffBlob' docs/proposal/api/graph.md` is `0`.

`npm run verify` exits 0.

Proof: none. This story delivers no line of the `PASS EPIC-027` block — neither `parity.test.ts` nor `proposal-amendment.test.ts` changes behaviour — and no Hermetic coverage bullet. Its evidence is the Verify assertions above. A printed `PASS EPIC-027` is true before this story runs and stays true after it, so it cannot show the proposal was amended.
