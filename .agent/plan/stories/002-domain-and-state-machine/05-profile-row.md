# Story 05 — The profile row, and only the row

Epic: `.agent/plan/epics/002-domain-and-state-machine.md`
Depends on: Story 03 (`src/domain/rows.ts`, `src/domain/column.ts`, `src/domain/blob.ts`).

## Change

### 1. `src/domain/profile.ts` (new)

```ts
import { z } from "zod";

import { blobHash } from "./blob.ts";
import { epochMillis } from "./column.ts";
import { identity } from "./identity.ts";

export const profileRow = z.object({
  id: identity("profile"),
  repositoryId: identity("repository"),
  contentBlob: blobHash,
  updatedAt: epochMillis,
});

export type ProfileRow = z.infer<typeof profileRow>;
```

Four keys. `docs/proposal/database/profile.md:5-11` declares four columns and no more.

### 2. `src/domain/rows.ts` — add the 19th entry

Insert `profile: profileRow,` between `plan_revision` and `project`, keeping the keys lexicographically sorted.

### 3. `src/domain/rows.test.ts` — raise the count

Change the `Object.keys(rows).length` assertion from `18` to `19`, and add `"profile"` to the literal sorted key array in the same position.

## Constraints

- Add no key for `template_id`, `checks`, the schema version, the template version, the template digest, or role prose. `docs/proposal/database/profile.md:16` states the reason: a copy in a column would be a second truth that drifts.
- Add no document parser, renderer or validator. `docs/proposal/phase-1/README.md:9` gives the profile document to phase 2.
- `contentBlob` is a `blob.hash` string, not a `profile` id and not a blob row.
- The `profile_` prefix already exists in `src/domain/identity.ts` from Story 02. Add no prefix here.
- Touch no other file. `workspace.profileBlob`, `candidate.profileBlob` and `checkResult.profileBlob` are already `blobHash` from Story 03.

## Verify

`node --test src/domain/profile.test.ts` — new file, suite `"src/domain/profile.test"`:

- `{ id: "profile_" + ULID_A, repositoryId: "repo_" + ULID_B, contentBlob: HASH, updatedAt: 0 }` parses, using the fixed literals of Story 03.
- `Object.keys(profileRow.shape)` deep-equals `["id", "repositoryId", "contentBlob", "updatedAt"]` — exact keys, exact order.
- Deleting each of the four keys in turn fails.
- `id: "repo_" + ULID_A` fails; `repositoryId: "profile_" + ULID_B` fails.
- `contentBlob: "0".repeat(64)` fails — the `sha256:` prefix is stored, not implied.
- Parsing a row that carries an extra `checks` key succeeds and the parsed result has no `checks` key, so the document fields cannot enter the row by accident.

`node --test src/domain/rows.test.ts` — the edited file:

- `Object.keys(rows).length` equals `19`.
- `rows.profile` is the identical reference to `profileRow`.
- The existing sorted-keys and proposal-parity assertions still pass with `profile` present.

`npm run verify` exits 0.

Proof: contributes `src/domain/profile.test.ts` and the edited `src/domain/rows.test.ts` to `node --test src/domain/**/*.test.ts`.
