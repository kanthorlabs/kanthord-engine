# migration

**Question it answers:** is this database at the schema version the binary expects?

```sql
CREATE TABLE migration (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL  -- when this migration ran; the key is a version, so no id carries it
) STRICT;
```

`db status` reads this table. It reports the applied versions, and it reports no change on a second run. The key is the version rather than a ULID, so `applied_at` is a real column.

## Example

```
version  name                       applied_at
1        0001-core-entities         1738396800000
2        0002-graph-and-plan        1738396800120
3        0003-execution-and-journal 1738396800260
4        0004-event-indexes         1738396800340
5        0005-actor                 1738396800420
```

A human runs `kanthord db migrate` on a new daemon home. Five rows appear, one per migration file. `kanthord db status` then prints these five versions, and a second `migrate` inserts nothing and reports no change. `npm run verify` calls `db status`, so an empty table on a fresh file is a failed build rather than a silent default.
