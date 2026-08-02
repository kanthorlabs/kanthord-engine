# lease

**Question it answers:** is anyone working on this subject right now, and is that claim still valid?

```sql
CREATE TABLE lease (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('node', 'repository')),  -- what is held: an objective node, or a repository
  subject_id   TEXT NOT NULL,                                                 -- the held subject, prefixed
  owner        TEXT,                                                          -- daemon instance holding it; null means released
  fence        INTEGER NOT NULL,                                              -- acquisition generation, never reset; a stale holder cannot write
  acquired_at  INTEGER,                                                       -- start of the current holding
  renewed_at   INTEGER,                                                       -- last renewal, so a long holding stays visibly alive
  expires_at   INTEGER,                                                       -- after this, startup treats the holding as stale
  PRIMARY KEY (subject_kind, subject_id)
) STRICT;
```

The objective lease and the repository lock are one mechanism, so `status` reports both from one query, and startup finds every expired one in one scan.

`owner` is the daemon instance identity, so recovery relates a lease to the work attributed to that instance. A null `owner` means released.

`fence` increments on every acquisition and never resets. An acquisition writes the new fence, and every durable write of that holder carries the fence it acquired, so an expired holder cannot complete a database write after another holder took the subject. `renewed_at` records a renewal without losing the acquisition time.

The fence protects domain state, and it is not what protects the file system. One daemon holds an exclusive operating-system lock on the daemon home for the life of the process, so a second daemon cannot start against the same home. An expired lease therefore means a stalled task inside the one process that owns the home, and never a second writer of the bare repository. See [../phase-1/git-foundation.md](../phase-1/git-foundation.md).

The row survives a release, because the fence must keep increasing. The key holds no time, and the row is reused across acquisitions, so the three timestamps are real columns and none of them comes from an id. `subject_id` is polymorphic, so it carries no foreign key.

## Example

```
subject_kind  subject_id            owner              fence  expires_at
node          objective_01JQ8Z9L7M  daemon_01JQ8Z2H4G  7      1738396830000
repository    repo_01JQ8Z4A2B       daemon_01JQ8Z2H4G  3      1738396810000
```

The worker takes the first row before it clones, and holds it for the whole objective. The second row is the repository lock, taken for the seconds a fetch, a merge or a publish needs, then released by setting `owner` to null.

`fence` is the safety net. The daemon stalls for 40 seconds and the objective lease expires. A new instance acquires it with `fence = 8`. The old process wakes and tries to write with `fence = 7`, and the write is refused. Without the fence, a zombie process completes a merge nobody authorized.

At startup a `running` node whose lease expired returns to `ready` when the tree is clean at the recorded base, and moves to `blocked` with reason `dirty-recovery` otherwise.
