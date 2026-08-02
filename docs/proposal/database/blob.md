# blob

**Question it answers:** which exact immutable payload did another row cite — a prompt, a profile, a plan document, a diff, a tool trace, a check log, an evidence document or an error?

```sql
CREATE TABLE blob (
  hash       TEXT PRIMARY KEY,  -- sha256:<lowercase hex> of content; the address every other row cites
  size       INTEGER NOT NULL,  -- byte length, so a reader can refuse an oversized payload before loading it
  content    BLOB NOT NULL,     -- the payload itself, immutable once written
  created_at INTEGER NOT NULL   -- first insert; a content hash carries no time
) STRICT;
```

`hash` is the algorithm name, a colon and the lowercase hex sha256 of `content`: `sha256:9f2a…`. A blob is immutable, and nothing updates a row. The key is a content hash and carries no time, so `created_at` stays.

The algorithm prefix is stored, not implied. It costs seven characters, and it buys the same visibility the id prefixes buy elsewhere: a value in a log line, an HTTP payload or a `_blob` column says what it is without a lookup, and a second algorithm is a new value rather than a migration of every citing row. Every `_blob` column and every API field carries the value in this form, and nothing reformats it.

Every payload an audit must reproduce goes here: the rendered messages, the tool trace, the diff, the check output, the profile document, the plan document, the reviewer reasons, the approval evidence and the error detail. Rows in other tables hold the hash. One store gives deduplication and one retention rule. A `_json` column stays small and fixed in shape, so no other column grows without bound.

A blob is never deleted while any row references it. [../phase-2/instructions-and-profiles.md](../phase-2/instructions-and-profiles.md) requires the source of a prompt after the source is gone, so retention is a decision for a later phase, not a background job.

## Example

```
hash            size    content                                      inserted by
sha256:9f2a...  12,431  the kanthord-verify profile document         profile instantiate
sha256:2f66...  3,904   the plan document the human sent             plan import
sha256:8ab3...  4,102   the plan document the import returned        plan import
sha256:c81b...  41,002  rendered prompt, task 2 attempt 1            agent_invocation
sha256:c81b...  -       attempt 2 reuses it: same hash, stored once  -
sha256:44de...  83,918  unit check output against the candidate      check_result
```

Every large payload is written here first, and the row that needs it stores the hash. The fifth line is the deduplication case: two attempts that render the same prompt produce one row, because the address is the content.

The reason this table exists is not size. `phase-2/instructions-and-profiles.md` requires the exact prompt of an attempt six weeks later, and a hash cannot rebuild a prompt after its source is gone. A blob is immutable, so `agent_invocation.prompt_blob = sha256:c81b...` cannot change meaning under the row that cites it.
