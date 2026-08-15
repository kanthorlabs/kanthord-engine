# actor

**Question it answers:** who may act, and is that principal still allowed to?

```sql
CREATE TABLE actor (
  id            TEXT PRIMARY KEY,                           -- prefixed id, public by construction
  kind          TEXT NOT NULL CHECK (kind IN ('human', 'harness')),  -- the kind the registration minted
  name          TEXT NOT NULL UNIQUE,                       -- registered name, one per identity
  token_sha256  BLOB,                                       -- 32-byte SHA-256 of the harness secret
  registered_by TEXT REFERENCES actor(id),                  -- the human who registered this row
  created_at    INTEGER NOT NULL,                           -- registration time, epoch millis
  revoked_at    INTEGER,                                    -- stamp of a revocation, epoch millis
  revoked_by    TEXT REFERENCES actor(id),                  -- who revoked, paired with revoked_at
  CHECK (token_sha256 IS NULL OR length(token_sha256) = 32),
  CHECK ((token_sha256 IS NULL) = (id = 'actor_00000000000000000000000000')),
  CHECK ((registered_by IS NULL) = (id = 'actor_00000000000000000000000000')),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
) STRICT;
```

One row is one principal. A `human` registers a `harness` through `POST /v1/actor`, and the response discloses that harness token once. The daemon resolves every bearer token to one row before a handler runs, and a revoked row stops authenticating.

The bootstrap row exists by construction. It carries the id `actor_` and twenty-six zero characters, the kind `human` and the name `bootstrap`, and it stores no hash: the configured token of `settings.token` lives in configuration, and the daemon never persists it. `ensure-bootstrap-actor` rewrites the name of that row from `settings.actor` at every startup, so a deployment that renames its operator keeps one identity.

## The checks

`token_sha256` is the only secret material in the table, and it is a digest, never the token. The length check is written with `IS NULL OR` rather than as a bare length test, because a bare `length(token_sha256) = 32` evaluates to `NULL` for the bootstrap row and SQLite treats a `NULL` check result as a pass, so the bare form would work by accident rather than by statement.

The bootstrap id appears in two checks, frozen as a SQL literal. An applied migration is a historical artifact and its bytes never change, so the migration does not read the domain constant. A future divergence between the two is a defect of the domain change, and the fix reverts the constant, never the migration.

`name` is `UNIQUE` and a revoked row stays listed. Recovery of a lost token is therefore `actor list` then `actor rotate`, and never revoke-then-register, because a renamed replacement would carry a second name for one identity.

## Example

```
id                actor_00000000000000000000000000
kind              human
name              bootstrap
token_sha256      null
registered_by     null
created_at        0
revoked_at        null
revoked_by        null
```

A fresh home holds exactly this row. `kanthord actor register --name runner-1 --token-file /run/secrets/runner-1.token` then inserts a second row: the id is minted by the daemon, `kind` is `harness`, `name` is `runner-1`, `token_sha256` is the SHA-256 of the returned secret, `registered_by` is the bootstrap id and `created_at` is the registration instant. `kanthord actor list` prints both rows, bootstrap first, because the list orders by id ascending and the zero id sorts first.
