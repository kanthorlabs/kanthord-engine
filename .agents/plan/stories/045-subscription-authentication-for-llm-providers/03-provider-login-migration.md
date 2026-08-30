# Story 3 — A migration adds the pending-login table

Epic: `.agents/plan/epics/045-subscription-authentication-for-llm-providers.md`

A new table has four required sites in this repository, not one. `schema-parity.test.ts:65-80`
asserts the migrated table set equals `Object.keys(rows)`, and the migration test asserts the
DDL equals the proposal fence. All four are in this story.

## Change

### `src/services/storage/migration-0010-provider-login.ts` (new file)

The highest existing version is 9 (`src/services/storage/migration-0009-one-branch.ts:4`).
Follow that file's shape exactly.

```ts
import type { Migration } from "./migration.ts";

export const migration0010ProviderLogin: Migration = {
  version: 10,
  name: "0010-provider-login",
  statements: [
    `CREATE TABLE provider_login (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('manual-code', 'device-code')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  instance_id TEXT NOT NULL,
  payload_ciphertext BLOB,
  payload_iv BLOB,
  payload_tag BLOB,
  key_version INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (payload_iv IS NULL OR length(payload_iv) = 12),
  CHECK (payload_tag IS NULL OR length(payload_tag) = 16),
  CHECK (
    (state = 'pending'
      AND payload_ciphertext IS NULL AND payload_iv IS NULL
      AND payload_tag IS NULL AND key_version IS NULL)
    OR (state = 'completed'
      AND payload_ciphertext IS NOT NULL AND payload_iv IS NOT NULL
      AND payload_tag IS NOT NULL AND key_version IS NOT NULL)
  )
) STRICT`,
    "CREATE UNIQUE INDEX provider_login_one_pending ON provider_login (provider) WHERE state = 'pending'",
  ],
};
```

Four decisions the DDL fixes, so no implementer chooses them:

- The four payload columns are **nullable**, because a `pending` row has no credential.
  The `provider` table's columns are `NOT NULL` (`migration-0001-core-entities.ts:18-21`);
  this table cannot copy that.
- The last `CHECK` binds **all four** encrypted columns to the state, so a `pending` row can
  never carry any of them and a `completed` row can never lack any of them. Binding only
  `payload_ciphertext` would admit a completed row with a null iv or key version, which
  `crypto.open` cannot decrypt. It is the state machine as a constraint.
- `provider_login_one_pending` is a **partial unique index**. It enforces "only one pending
  login exists per vendor" in the schema, so the `login-in-progress` refusal of Story 7 is
  a check the database also holds. It follows the existing partial-unique precedent
  `run_one_active` (`migration-0003-execution-and-journal.ts:46`).
- `provider` is the vendor id (`"openai-codex"`), not a `provider_` identity, and carries
  **no foreign key**: a login exists before any provider row does.

Timestamps are integer epoch milliseconds, matching every other table.

### `src/services/storage/migrations.ts`

Add the import after line 10 and the entry after line 21:

```ts
import { migration0010ProviderLogin } from "./migration-0010-provider-login.ts";
```

```ts
  migration0009OneBranch,
  migration0010ProviderLogin,
];
```

### `src/domain/provider-login.ts` (new file)

Follow `src/domain/provider.ts:1-21` exactly. `domain/` imports `zod` only.

```ts
import { z } from "zod";

import { identity } from "./identity.ts";
import { bytes, epochMillis } from "./column.ts";

export const providerLoginMethods = ["manual-code", "device-code"] as const;
export type ProviderLoginMethod = (typeof providerLoginMethods)[number];

export const providerLoginStates = ["pending", "completed"] as const;
export type ProviderLoginState = (typeof providerLoginStates)[number];

export const providerLoginRow = z.object({
  id: identity("providerLogin"),
  provider: z.string(),
  method: z.enum(providerLoginMethods),
  state: z.enum(providerLoginStates),
  instanceId: z.string(),
  payloadCiphertext: bytes.nullable(),
  payloadIv: bytes
    .refine((value) => value.length === 12, {
      message: "length(payload_iv) = 12",
    })
    .nullable(),
  payloadTag: bytes
    .refine((value) => value.length === 16, {
      message: "length(payload_tag) = 16",
    })
    .nullable(),
  keyVersion: z.int().nullable(),
  createdAt: epochMillis,
  expiresAt: epochMillis,
});
export type ProviderLoginRow = z.infer<typeof providerLoginRow>;
```

### `src/domain/identity.ts`

The login id is a minted prefixed ULID, so it needs an identity kind. Add
`"providerLogin"` to `identityKinds` (`src/domain/identity.ts:3-21`) after `"provider"`,
and `providerLogin: "login"` to `identityPrefixes` (`:26-45`) in the same position. The id
therefore reads `login_01J…`.

`src/domain/identity.test.ts` pins the kind list — add `"providerLogin"` to every literal
list there, and add one round-trip assertion that `parseIdentity("login_" + ulid)` yields
kind `"providerLogin"`.

### `src/domain/rows.ts`

Add the import after line 17 and the entry after `provider` at line 39. The entry order is
asserted against `sqlite_master … ORDER BY name`, and `provider` < `provider_login` <
`repository` bytewise, so the position is fixed:

```ts
import { providerLoginRow } from "./provider-login.ts";
```

```ts
  provider: providerRow,
  provider_login: providerLoginRow,
  repository: repositoryRow,
```

### `docs/proposal/database/provider_login.md` (new file)

`proposalStatements("provider_login")` reads the **first** ```sql fence of this file,
strips `--` comments and compares statement by statement
(`test/helpers/proposal.ts:8-27`). The fence must therefore hold the `CREATE TABLE` and the
`CREATE INDEX` in the same order as the migration, and nothing else.

Write the file in the style of `docs/proposal/database/provider.md`: an H1 naming the
table, a bold **Question it answers:** line, the sql fence, then prose. The prose states:
a login row is a suspended vendor handshake, the three states (`pending`, `completed`, and
consumed-by-deletion), that the payload holds the OAuth credential and the model ids
encrypted with the same master key as `provider`, that the live flow is process-local so
`instance_id` records the daemon that holds it, and that the partial unique index is the
one-pending-login-per-vendor rule.

Add one row to the table index at `docs/proposal/database/README.md:16`, immediately after
the `provider` row, in the same column format:

```
| [`provider_login`](provider_login.md)     | which subscription sign-in is in flight, and what did the vendor issue?                     |
```

### `src/services/storage/migration-0010-provider-login.test.ts` (new file)

Model it on `src/services/storage/migration-0009-one-branch.test.ts`. Use
`createStorageAtVersion(9)` (`test/helpers/database.ts:50-66`) rather than hand-listing the
prior migrations — this migration seeds nothing between the two migrate calls, so the
helper applies.

`describe("src/services/storage/migration-0010-provider-login.test")` with these tests:

1. `it("migration0010ProviderLogin carries version 10, its name, and no rebuild")` —
   asserts `version === 10`, `name === "0010-provider-login"`, `rebuild === undefined`.
2. `it("migrations holds exactly ten migrations with migration0010ProviderLogin last")` —
   deep-equals the ordered array and the version list `[1,2,3,4,5,6,7,8,9,10]`. This
   replaces the "exactly nine" assertion at
   `src/services/storage/migration-0009-one-branch.test.ts:214-230`; edit that test to
   stop pinning the length, or leave it and let this test pin ten — pick the second: leave
   0009's test untouched except its `assert.deepEqual(migrations, [...])` call, which must
   gain the tenth entry, and its version list, which must gain `10`.
3. `it("a database at version 9 migrates to 10 and gains provider_login")` — asserts
   `appliedVersions` is `[1..10]`, `status().pending` is `[]`, and
   `PRAGMA table_info(provider_login)` names exactly
   `["id","provider","method","state","instance_id","payload_ciphertext","payload_iv","payload_tag","key_version","created_at","expires_at"]`.
4. `it("the migrated provider_login table and index equal the proposal fence")` — note the
   shape difference from the 0009 precedent: `proposalStatements("provider_login")` returns
   **two** statements (the table and the index), while `tableSql(storage, "provider_login")`
   returns only the table. Comparing `normalize(tableSql(...))` to `proposalStatements(...)`
   directly **cannot pass**. Build the actual list from both objects, in the same order as
   the fence:

   ```ts
   const actual = [
     ...normalize(tableSql(storage, "provider_login")),
     ...normalize(objectSql(storage, "provider_login_one_pending")),
   ];
   assert.deepEqual(actual, proposalStatements("provider_login"));
   ```

   `objectSql` is the same one-line `SELECT sql FROM sqlite_master WHERE name = ?` helper as
   `tableSql` (`migration-0009-one-branch.test.ts:191-196`); reuse it rather than adding a
   second helper if it already accepts any object name.

5. `it("refuses a second pending row for the same vendor")` — insert one `pending` row for
   `"openai-codex"`, then assert a second insert for the same vendor throws. Assert a
   `pending` row for a **different** vendor succeeds, and that a `completed` row for the
   same vendor as an existing `pending` one also succeeds (the index is partial).
6. `it("refuses a pending row carrying ciphertext")` and
   `it("refuses a completed row with no ciphertext")` — both assert the state/payload
   `CHECK` fires.
7. `it("refuses a method or state outside its closed set")` — asserts both `CHECK` clauses.
8. `it("re-applying the full chain to an already-migrated database is a no-op")` — mirrors
   `migration-0009-one-branch.test.ts:398-430`.

### `src/services/storage/schema-parity.test.ts`

Add two tests beside the existing `assertClauseAgrees` tests (`:33-63`), using the same
helper:

```ts
it("provider_login.method CHECK agrees with the domain providerLoginMethods", () => { … });
it("provider_login.state CHECK agrees with the domain providerLoginStates", () => { … });
```

The existing "table set equals Object.keys(rows)" test at `:65-80` then passes only
because `rows.ts` gained `provider_login` in sorted position. Do not edit that test.

## Constraints

- Migration `version` is `10` and `name` is `"0010-provider-login"`. Never renumber an
  applied migration.
- No `rebuild: true`. This migration only creates; it rewrites no existing table.
- No foreign key on `provider_login.provider`.
- `docs/proposal/database/provider_login.md` holds exactly two statements in its first sql
  fence, in migration order. A third statement or a reordering fails the parity test.
- Do not add an `updated_at`. The row is created once and deleted; nothing updates it in
  place except the `pending` → `completed` transition, which Story 7 performs with an
  explicit column list.

## Verify

```
node --test \
  src/services/storage/migration-0010-provider-login.test.ts \
  src/services/storage/migration-0009-one-branch.test.ts \
  src/services/storage/schema-parity.test.ts \
  src/domain/identity.test.ts
npm run verify
```

Asserts: version and name by value, the ten-migration chain in order, the exact eleven
column names, DDL byte-equality with the proposal fence after normalization, the partial
unique index refusing a second pending row for one vendor while admitting another vendor
and a completed row, both payload/state `CHECK`s, both closed-set `CHECK`s agreeing with
the domain arrays, and the table set still equal to `Object.keys(rows)`.

Proof: delivers the migration test named in the EPIC Proof block — see blocker **B1** in
the index about its file name. `npm run verify` exits 0.
